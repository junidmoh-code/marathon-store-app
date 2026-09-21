// ─── OFFLINE MIRROR — "is this device serving from the local copy?", NOW ─────
//
// WHY THIS HAS TO BE SYNCHRONOUS, AND WHY IT IS IN localStorage.
//
// A hook decides on its FIRST RENDER whether to open a live onValue. Opening
// one costs the whole node — 4.7 MB for /products — and closing it a moment
// later does not refund that. So "is the mirror serving this leg" cannot be an
// answer that arrives asynchronously: by the time it arrives, the money is
// spent. It has to be knowable in the same tick as the first render, before
// IndexedDB has been opened and before bootstrap has run.
//
// localStorage is the only synchronous per-device store a browser offers, and
// what is kept here is a HINT, not data: the list of leg names this device was
// serving from the mirror the last time it checked. Every hook that acts on it
// falls back to a live read the moment the local read cannot actually answer,
// so a stale or wrong hint costs one extra check and never a blank screen.
//
// It is deliberately NOT the source of truth. The truth is health.js, read
// from IndexedDB, and it is what every actual read is gated on.

import { offlineMirrorEnabled, subscribeMirrorSwitch } from "./killSwitch";
import { auth } from "../firebase";

export const SERVING_KEY = "marathon-store.offlineMirror.serving";

let cache = null;     // parsed hint, per tab, invalidated on write
let cacheUid = null;  // the account the hint was written FOR
const listeners = new Set();

// ── THE HINT BELONGS TO ONE ACCOUNT ─────────────────────────────────────────
// A tablet is shared. The hint is the list of legs served to the account that
// was signed in when it was written, and it is honoured ONLY while that same
// account is signed in — read synchronously from firebase auth on EVERY call.
// Before auth has restored its user, currentUser is null, so the hint is
// refused and the screen reads live (a cost, never a leak). A different
// account, or nobody, gets live reads until bootstrap has checked
// that account's read rights and written a hint for it. (Sonnet review, PR
// #629: the previous session's hint was otherwise served in the gap before
// the mirror's own auth listener attached, and after a sign-out.)
const currentUid = () => {
  try { return auth?.currentUser?.uid ?? null; } catch { return null; }
};

function read() {
  if (cache) return cache;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SERVING_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : null;
    cache = Array.isArray(parsed?.legs) ? new Set(parsed.legs) : new Set();
    cacheUid = typeof parsed?.uid === "string" ? parsed.uid : null;
  } catch {
    cache = new Set();
    cacheUid = null;
  }
  return cache;
}

/** Synchronous, and safe to call in a render. */
export function isLegServing(legName) {
  if (!legName || !offlineMirrorEnabled()) return false;
  const legs = read();
  if (cacheUid !== currentUid()) return false;
  return legs.has(legName);
}

export function servingKeyFor(legNames) {
  // A stable string, so useSyncExternalStore can compare by value rather than
  // allocating a new Set on every call and re-rendering for ever.
  return legNames.map((l) => (isLegServing(l) ? "1" : "0")).join("");
}

export function setServingLegs(legNames) {
  const next = [...new Set(legNames ?? [])].sort();
  const uid = currentUid();
  const before = [...read()].sort().join(",");
  if (before === next.join(",") && cacheUid === uid) return false;
  cache = new Set(next);
  cacheUid = uid;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(SERVING_KEY, JSON.stringify({ legs: next, uid, at: Date.now() }));
    }
  } catch { /* private mode: the hint is per-tab only, which still works */ }
  for (const l of listeners) l();
  return true;
}

// The signed-in account changed. isLegServing already answers for the new
// account; this tells every subscribed screen to ask again.
export function notifyServingChanged() {
  for (const l of listeners) l();
}

export function clearServing() { return setServingLegs([]); }

// ── A KILL-SWITCH FLIP IS A SERVING CHANGE ──────────────────────────────────
//
// `isLegServing` consults the kill switch, so the moment the switch goes false
// every leg stops serving — but React does not know that unless something
// tells it. Every mirror-reading hook is already subscribed HERE, through
// useSyncExternalStore, so subscribing to the switch alongside the local
// listener is what turns "the value changed" into "every screen re-rendered
// and opened its live read", with no reload. Without this line the switch
// would only take effect on the next render that happened for some other
// reason, which on a tablet left open on one screen could be hours.
export function subscribeServing(listener) {
  listeners.add(listener);
  const offSwitch = subscribeMirrorSwitch(listener);
  return () => { listeners.delete(listener); offSwitch(); };
}

export function _resetServingForTests() {
  cache = null;
  cacheUid = null;
  listeners.clear();
  try { localStorage?.removeItem(SERVING_KEY); } catch { /* ignore */ }
}
