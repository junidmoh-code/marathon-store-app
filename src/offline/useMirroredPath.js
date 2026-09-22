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
import { isLegUsable } from "./health";
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
 * Can the local copy answer for this path right now?
 *
 * Deliberately asked fresh on every read rather than cached: a leg goes
 * unusable the moment the census marks it drifted or a swap refuses, and a
 * cached "yes" over that is a screen serving a copy the mirror has already
 * disowned.
 */
export async function mirrorCanAnswer(path) {
  if (!offlineMirrorEnabled()) return false;
  const match = legFor(path);
  if (!match) return false;
  try {
    const db = await getMirrorDbHandle();
    return await isLegUsable(db, match.leg.name);
  } catch {
    return false;
  }
}

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

  // The state carries the PATH it answers for. A render for a new path must
  // never be handed the previous path's rows, and it would be for one render
  // (before the effect below runs) if this were a bare answer.
  const [state, setState] = useState(() => ({ path, answer: expectMirror ? PENDING : FALLBACK }));
  const liveRef = useRef(0);

  useEffect(() => {
    if (!enabled || !path || !legName) { setState({ path, answer: FALLBACK }); return undefined; }
    if (!expectMirror) { setState({ path, answer: FALLBACK }); return undefined; }
    let cancelled = false;
    const token = (liveRef.current += 1);
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
    setState((prev) => (prev.path === path && prev.answer.verdict === "mirror" ? prev : { path, answer: PENDING }));
    (async () => {
      if (!(await mirrorCanAnswer(path))) {
        // Not a failure and not an empty node. The hint was stale or the leg
        // has gone unusable since; the caller opens its live read.
        if (!cancelled && token === liveRef.current) setState({ path, answer: FALLBACK });
        return;
      }
      try {
        const db = await getMirrorDbHandle();
        const value = await readMirroredPath(db, path);
        if (cancelled || token !== liveRef.current) return;
        if (value === MISS) { setState({ path, answer: FALLBACK }); return; }
        setState({ path, answer: { value, settled: true, error: false, verdict: "mirror" } });
      } catch (err) {
        if (cancelled || token !== liveRef.current) return;
        // A local read that FAILED is not an empty node, and must not be shown
        // as one. Falling back is the honest answer.
        console.warn(`offline mirror: local read of /${path} failed:`, err);
        setState({ path, answer: FALLBACK });
      }
    })();
    return () => { cancelled = true; };
  }, [path, enabled, legName, version, expectMirror, servingHint]);

  if (state.path === path) return state.answer;
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
