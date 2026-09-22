// ─── OFFLINE MIRROR — the drop-in for a live read ────────────────────────────
//
// `useMirroredPath(path, enabled)` answers with the same three-state shape
// useStock.js's `usePathState` already returns — { value, settled, error } —
// and the same `value` a live onValue would have handed over. A caller cannot
// tell which it got, which is the point: the constraint on this work is that
// every screen displays exactly what it displays today.
//
// ── IT FALLS BACK, ALWAYS ───────────────────────────────────────────────────
//
// The mirror answers only when all three of these hold: the flag is on, this
// device has finished its setup download, and the leg covering `path` is
// USABLE (health.js — a health record backed by rows actually in the store,
// never `count() > 0`). Otherwise the caller gets a live subscription, exactly
// as before. There is no state of this app in which a screen has no data
// source; the mirror is an alternative source, never a gate.
//
// ── WHY useSyncExternalStore ────────────────────────────────────────────────
//
// A screen reading from IndexedDB has no onValue to wake it. mirrorSignal.js
// bumps a version per leg when the change feed applies a page, and this
// subscribes to the versions of the legs it reads — only those, because a
// global counter would re-read /insights_log's 112,968 rows every time an
// order changed.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { offlineMirrorEnabled } from "./killSwitch";
import { getMirrorDbHandle } from "./mirrorDbHandle";
import { legFor, readMirroredPath, MISS } from "./localReads";
import { legVerdict } from "./health";
import { subscribeMirror, versionKey } from "./mirrorSignal";
import { isLegServing, subscribeServing, servingKeyFor } from "./serving";

// `verdict` is what a CALLER acts on, and it has three values because the
// decision it drives — "may I skip the live subscription?" — has three
// answers. Conflating "not yet" with "no" costs a whole-node download on every
// first render; conflating it with "yes" leaves a screen blank while a device
// that cannot serve locally waits for an answer that will never come.
//
//   "pending"   the local copy is expected to answer, but has not yet.
//   "mirror"    it has. `value` is what the server would have returned.
//   "fallback"  it cannot. Open the live read.
const PENDING = Object.freeze({ value: null, settled: false, error: false, verdict: "pending" });
const FALLBACK = Object.freeze({ value: null, settled: false, error: false, verdict: "fallback" });

/**
 * Can the local copy answer for this path right now? "yes", "no" or "unknown".
 *
 * Deliberately asked fresh on every read rather than cached: a leg goes
 * unusable the moment the census marks it drifted or a swap refuses, and a
 * cached "yes" over that is a screen serving a copy the mirror has already
 * disowned.
 *
 * "unknown" — the question could not be put (health.js legVerdict). It is NOT
 * "no": a phone whose IndexedDB handle died in its pocket still holds every
 * row, and treating that as "no" opened a whole-node live read on every
 * mounted screen, every wake (cost watch, 22 Sep 2026).
 */
export async function mirrorVerdict(path) {
  if (!offlineMirrorEnabled()) return "no";
  const match = legFor(path);
  if (!match) return "no";
  try {
    const db = await getMirrorDbHandle();
    return await legVerdict(db, match.leg.name);
  } catch {
    return "unknown";
  }
}

/** The yes/no form, for callers that only need to know "may I read it now". */
export async function mirrorCanAnswer(path) {
  return (await mirrorVerdict(path)) === "yes";
}

// ── HOW LONG "I COULD NOT ASK" IS GIVEN ─────────────────────────────────────
//
// A check or a local read that fails is asked again after each of these
// delays. While it is being asked, a screen that already had a local answer
// for this path KEEPS it — the same thing a live onValue does between
// snapshots. When they are used up, the path falls back to its live read, so
// a device whose database has genuinely gone never sits on a copy it cannot
// check: ~4.5 seconds, then live.
export const UNKNOWN_RETRY_MS = Object.freeze([250, 1000, 3000]);

export function useMirroredPath(path, enabled = true) {
  const legName = useMemo(() => (path ? legFor(path)?.leg?.name ?? null : null), [path]);
  const legs = useMemo(() => (legName ? [legName] : []), [legName]);

  // Re-read when the feed moves THIS leg, and not when it moves any other.
  const version = useSyncExternalStore(
    subscribeMirror,
    () => versionKey(legs),
    () => versionKey(legs),
  );

  // The SYNCHRONOUS hint — see serving.js. This is what makes the first render
  // able to decide without paying for a whole-node subscription it is about to
  // close again.
  const servingHint = useSyncExternalStore(
    subscribeServing,
    () => servingKeyFor(legs),
    () => servingKeyFor(legs),
  );
  const expectMirror = !!legName && enabled && isLegServing(legName);

  // The state carries the PATH it answers for AND the decision it was made
  // under (`mirror`: was this device expected to serve it locally). A render
  // for a new path must never be handed the previous path's rows — and a
  // render whose decision has changed must never be handed an answer made
  // under the old one. Without the second tag, the render in which `enabled`
  // first became true (auth restored) returned the FALLBACK computed while it
  // was false, and every caller opened its whole-node live read for that one
  // render before the effect below could correct it.
  const [state, setState] = useState(() => ({
    path, mirror: expectMirror, answer: expectMirror ? PENDING : FALLBACK,
  }));
  // Consecutive "could not ask" answers for this path, and the retry they
  // schedule. A number in state so a retry is an ordinary re-run of the
  // effect below, through the one tested path.
  const [unknownTries, setUnknownTries] = useState(0);
  const liveRef = useRef(0);

  useEffect(() => {
    if (!enabled || !path || !legName || !expectMirror) {
      setState({ path, mirror: false, answer: FALLBACK });
      setUnknownTries(0);
      return undefined;
    }
    let cancelled = false;
    let retryTimer = null;
    const token = (liveRef.current += 1);
    const current = () => !cancelled && token === liveRef.current;
    // ── A RE-READ KEEPS THE ANSWER IT IS REPLACING ──────────────────────────
    //
    // This effect re-runs on every version bump — every change-feed pass that
    // applied anything, several a minute on a trading day. It used to reset to
    // PENDING here, and PENDING's value is null, so for the length of the
    // IndexedDB rebuild every screen reading this path was told the node was
    // EMPTY. On the refill screens that was the whole list of requests
    // vanishing and coming back every few seconds, with staff unable to fulfil
    // a line that kept disappearing under them (21 Sep 2026). The rows had
    // not changed at all; the order that moved was somebody else's.
    //
    // A local copy that has answered for THIS path keeps showing that answer
    // until the new one lands, exactly as a live onValue keeps its last
    // snapshot until the next. Only a first read — or a new path — is pending.
    setState((prev) => (
      prev.path === path && prev.mirror && prev.answer.verdict === "mirror"
        ? prev
        : { path, mirror: true, answer: PENDING }
    ));
    // Could not ask. Keep what is on screen (the setState above already did)
    // and ask again; when the retries are spent, go live.
    const couldNotAsk = (err) => {
      if (!current()) return;
      if (unknownTries < UNKNOWN_RETRY_MS.length) {
        retryTimer = setTimeout(() => { if (current()) setUnknownTries((n) => n + 1); }, UNKNOWN_RETRY_MS[unknownTries]);
        return;
      }
      if (err) console.warn(`offline mirror: local read of /${path} failed:`, err);
      setState({ path, mirror: true, answer: FALLBACK });
    };
    (async () => {
      const verdict = await mirrorVerdict(path);
      if (!current()) return;
      if (verdict === "unknown") { couldNotAsk(null); return; }
      if (verdict !== "yes") {
        // Not a failure and not an empty node — a FACT: the hint was stale or
        // the leg has gone unusable since. The caller opens its live read now.
        setState({ path, mirror: true, answer: FALLBACK });
        return;
      }
      try {
        const db = await getMirrorDbHandle();
        const value = await readMirroredPath(db, path);
        if (!current()) return;
        if (value === MISS) { setState({ path, mirror: true, answer: FALLBACK }); return; }
        setUnknownTries(0);
        setState({ path, mirror: true, answer: { value, settled: true, error: false, verdict: "mirror" } });
      } catch (err) {
        // A local read that FAILED is not an empty node, and must not be shown
        // as one. Asked again first; falling back is the honest answer after.
        couldNotAsk(err);
      }
    })();
    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
  }, [path, enabled, legName, version, expectMirror, servingHint, unknownTries]);

  if (state.path === path && state.mirror === expectMirror) return state.answer;
  return expectMirror ? PENDING : FALLBACK;
}

/**
 * "Is this leg serving, and has it moved?" — WITHOUT reading it.
 *
 * The two windowed readers (App.jsx's useInsightsLogRecentDays and
 * useClothingSoldMovements) called useMirroredPath on the WHOLE node just to
 * get a change token, which rebuilt all 112,968 /insights_log rows or all
 * 90,922 /stock_movements rows in memory — on mount and on every pass that
 * moved the leg — and then threw the value away and did a second, ranged read.
 * On a tablet that is a heap risk, not merely slow, and it is the exact cost
 * the ranged local read was added to avoid. (Fable-vs-spec review, PR #618.)
 *
 * This is what those two actually need: the synchronous serving hint and a
 * version that changes when the feed moves the leg. It reads nothing.
 */
export function useMirrorLeg(legName, enabled = true) {
  const legs = useMemo(() => (legName ? [legName] : []), [legName]);

  const version = useSyncExternalStore(
    subscribeMirror,
    () => versionKey(legs),
    () => versionKey(legs),
  );
  const servingHint = useSyncExternalStore(
    subscribeServing,
    () => servingKeyFor(legs),
    () => servingKeyFor(legs),
  );
  void servingHint;

  const serving = !!legName && enabled && isLegServing(legName);
  return { serving, version };
}
