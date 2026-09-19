// ─── OFFLINE MIRROR — a person must never see their own action undone ────────
//
// THE PROBLEM THIS SOLVES. With screens reading from the local copy, the path
// from "I pressed Send" to "the screen shows it" is: write lands in RTDB →
// Cloud Function trigger fires → change record appended → this device's feed
// reads it → local row updated. That is a second or two on a good line, and a
// second or two is exactly long enough for someone to press a button, see the
// old number, and press it again.
//
// The POS mirror found this the same way: a local read that does not include
// the device's own queued writes shows stale numbers right after the user's
// own action.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
//
// It is NOT an offline write queue. Writes in this app are unchanged: orders
// and the five warehouse actions — fulfil, transfer, receive, count, display
// confirm — go straight to RTDB exactly as they do today, with the same
// transactions, the same validation and the same failure behaviour. Changing
// how this app writes is out of scope and would be a much larger, much riskier
// thing than what it reads.
//
// What this holds is a short-lived record of paths this device has JUST
// written successfully, so a local read can answer with them until the change
// feed brings the same fact back round. It is an echo, not a queue: every
// value in it is already in RTDB.
//
// ── WHY IT EXPIRES ──────────────────────────────────────────────────────────
//
// An overlay that outlived its confirmation would be worse than none: it would
// pin a value on screen after someone else had changed it, and nothing would
// say so. So an entry lives for PENDING_TTL_MS and is dropped the moment the
// mirror's own copy of that path matches it — whichever comes first. If the
// change feed is broken, the overlay fades and the screen goes back to showing
// what the mirror holds, which is at least a fact about the database rather
// than a memory of a button press.
//
// ── WHERE IT IS FED FROM ────────────────────────────────────────────────────
//
// `notePendingUpdate(updates)` takes the FLAT multi-path map that RTDB's
// update() already takes, so a call site adds one line after its write and
// nothing else. It is wired at the chokepoints the person's own numbers flow
// through — applyMovement.js, which every fulfil, transfer, receive, count and
// adjust goes through — rather than at all fifty-odd write sites, because the
// change feed covers the rest within a second or two and an echo is only worth
// having where someone is watching.
//
// With the mirror flag off, every function here returns immediately and
// records nothing.

import { offlineMirrorEnabled } from "./mirrorFlag";

// COMFORTABLY LONGER THAN THE FEED TAKES. It used to equal the pass interval
// exactly, so an echo could expire in the same breath as the confirmation it
// was waiting for and the number would visibly flip back to the old one.
// (Fable-vs-spec review, PR #618.) The live change signal makes the real
// round trip a second or two; this is the budget for the case where the
// signal is lost and the 60-second cadence is doing the work.
export const PENDING_TTL_MS = 3 * 60 * 1000;

// In memory, not IndexedDB. An echo that survived a reload would be answering
// for a write whose confirmation it can no longer recognise — and a reload is
// itself slow enough that the feed has almost certainly caught up. Keeping it
// in the tab also means it can never be a stale record on disk that a later
// build has to reason about.
const pending = new Map();   // path -> { value, at }

export function notePendingUpdate(updates, { now = Date.now, enabled } = {}) {
  const on = enabled ?? offlineMirrorEnabled();
  if (!on || !updates || typeof updates !== "object") return 0;
  const at = now();
  let n = 0;
  for (const [path, value] of Object.entries(updates)) {
    if (typeof path !== "string" || path === "") continue;
    pending.set(normalise(path), { value, at });
    n += 1;
  }
  return n;
}

export function notePendingWrite(path, value, opts = {}) {
  return notePendingUpdate({ [path]: value }, opts);
}

const normalise = (p) => String(p).replace(/^\/+|\/+$/g, "");

function sweep(now) {
  for (const [path, entry] of pending) {
    if (now - entry.at > PENDING_TTL_MS) pending.delete(path);
  }
}

/**
 * Apply every pending write that falls at or under `path` to `value`.
 *
 * `value` is what the mirror holds for `path`; the result is what the screen
 * should see. A pending write AT the path replaces it outright; a pending
 * write BELOW it is set into a copy, creating the intermediate objects it
 * needs — which is what makes `stock/hub1/p1/9/qty` visible through a read of
 * `stock/hub1`.
 *
 * Returns the value unchanged, and the SAME REFERENCE, when nothing is
 * pending — so a screen with no recent write of its own pays nothing and
 * re-renders no more than it does today.
 */
export function applyPending(path, value, { now = Date.now } = {}) {
  if (pending.size === 0) return value;
  const at = now();
  sweep(at);
  if (pending.size === 0) return value;

  const base = normalise(path);
  const prefix = base === "" ? "" : `${base}/`;
  let out = value;
  let copied = false;

  for (const [p, entry] of pending) {
    if (p === base) {
      // A write AT this exact path. It replaces everything, and anything
      // pending BELOW it is applied on top by the loop's later iterations —
      // Map preserves insertion order, and a deeper write recorded in the same
      // update() call comes after the shallower one it refines.
      out = entry.value;
      copied = true;
      continue;
    }
    if (prefix !== "" && !p.startsWith(prefix)) continue;
    if (prefix === "" && p === "") continue;
    const rest = prefix === "" ? p : p.slice(prefix.length);
    if (!copied) { out = clone(out); copied = true; }
    out = setIn(out, rest.split("/"), entry.value);
  }
  return out;
}

// Structured clone of what RTDB can hold. Arrays stay arrays: RTDB coerces
// dense integer keys to arrays, and turning one into an object here would
// change what a caller iterating it sees.
function clone(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(clone);
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = clone(x);
  return out;
}

function setIn(root, segments, value) {
  const base = (root === null || typeof root !== "object") ? {} : root;
  let node = base;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const k = segments[i];
    if (node[k] === null || node[k] === undefined || typeof node[k] !== "object") node[k] = {};
    node = node[k];
  }
  const last = segments[segments.length - 1];
  // An RTDB update() with a null value DELETES the path, so the echo must
  // delete it too — otherwise the one action whose result is "it is gone"
  // would be the one action the overlay could not show.
  if (value === null) delete node[last];
  else node[last] = value;
  return base;
}

/**
 * Drop entries the mirror has caught up with.
 *
 * Called after the change feed applies a page. BY PREFIX, because the two
 * sides work at different depths: an echo is recorded at the path that was
 * written (`stock/hub1/p1/9/qty`) while the feed re-reads the whole ROW
 * (`stock/hub1/p1`). Matching only exact strings would leave every echo
 * standing until it expired, which is the slow version of the bug this whole
 * module exists to avoid.
 *
 * A confirmed row drops every echo AT or UNDER it, and nothing beside it: the
 * "/" is part of the prefix, so confirming `stock/hub1/p1` does not touch
 * `stock/hub1/p10`.
 */
export function confirmPending(paths) {
  let dropped = 0;
  for (const raw of paths ?? []) {
    const base = normalise(raw);
    const prefix = `${base}/`;
    for (const p of [...pending.keys()]) {
      if (p === base || p.startsWith(prefix)) {
        pending.delete(p);
        dropped += 1;
      }
    }
  }
  return dropped;
}

export function pendingCount({ now = Date.now } = {}) {
  sweep(now());
  return pending.size;
}

export function _clearPendingForTests() { pending.clear(); }
