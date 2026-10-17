// ─── CARD SLIP: THE TILL REGISTRY, READY BEFORE THE TAP ──────────────────────
// Junid, 17 Oct 2026: the Card Slip screen "did load but it was too slow". The
// screen's only read is /config/cardTerminals (≈2 KB), but it was opened at the
// tap, behind everything the home screen streams on the same connection
// (products, the order feed, stock) — seconds on a shop phone. So:
//
//   • ONE shared subscription, opened from the home screen for an account that
//     has a Card Slip scope (usePrefetchSlipTerminals), and kept open: the
//     screen finds the answer already there, and a second visit is instant.
//   • THE LAST ANSWER IS KEPT ON THE DEVICE (localStorage), so even a cold
//     start draws the form at once; the live read replaces it the moment it
//     lands. The copy only DRAWS the form: Submit waits for the live answer
//     (isSlipTerminalsLive), so a slip is only ever sent against the registry
//     as it is now — and cardBatchCapture re-checks the till scope regardless.
//   • A refused or dropped read is retried while anyone is listening.
import { useEffect } from "react";
import { ref as dbRef, onValue } from "firebase/database";
import { database } from "../../firebase";

export const SLIP_TERMINALS_KEY = "cardSlip.terminals.v1";
const PATH = "config/cardTerminals";

export function readCachedTerminals() {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(SLIP_TERMINALS_KEY) ?? "null");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
function writeCachedTerminals(v) {
  try {
    globalThis.localStorage?.setItem(SLIP_TERMINALS_KEY, JSON.stringify(v || {}));
  } catch {
    /* private mode / full storage: the live read still works */
  }
}

let latest;              // undefined = not heard yet this session
let off = null;          // the live subscription, once opened
const listeners = new Set();

/** The freshest copy this session has, else the device's last one, else null. */
export function peekSlipTerminals() {
  return latest !== undefined ? latest : readCachedTerminals();
}

export const SLIP_RETRY_MS = 5000;
let retry = null;

/** True once THIS session has heard the live registry (not just the device copy). */
export function isSlipTerminalsLive() {
  return latest !== undefined;
}

function open() {
  if (off) return;
  off = onValue(
    dbRef(database, PATH),
    (snap) => {
      latest = snap.val() || {};
      writeCachedTerminals(latest);
      for (const l of listeners) l(latest);
    },
    () => {
      // Refused or dropped: answer "nothing" only if nothing — live or cached —
      // was ever known, and try again while anyone is still listening.
      off = null;
      if (latest === undefined && readCachedTerminals() === null) for (const l of listeners) l({});
      clearTimeout(retry);
      retry = setTimeout(() => { retry = null; if (listeners.size) open(); }, SLIP_RETRY_MS);
    },
  );
}

/** Listen for the registry; opens the one shared subscription on first use. */
export function subscribeSlipTerminals(cb) {
  listeners.add(cb);
  if (latest !== undefined) cb(latest);
  open();
  return () => listeners.delete(cb);
}

// ─── "WHICH TILLS ARE MINE", OVER HTTP (Junid, 17 Oct 2026) ─────────────────
// Measured on a phone-like line, the registry LISTEN above still waited ~47 s:
// it shares the one RTDB socket with the app's ~6 MB first load. The callable
// (cardBatchCapture action "slipTills") is its own HTTPS request, so nothing
// queues in front of it, and it answers only this person's tills — so it is
// kept per person on the device. Whichever answers first draws the screen.
const TILLS_KEY = (uid) => `cardSlip.tills.v1.${uid}`;
const server = new Map(); // uid → { tills, live }
const serverListeners = new Map(); // uid → Set
const inFlight = new Map(); // uid → Promise
let slipTillsFn = null;
let generation = 0; // bumped by _resetSlipTerminals: an older ask's answer is dropped

function cachedTills(uid) {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(TILLS_KEY(uid)) ?? "null");
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** { tills, live } for this person: live = the server answered this session. */
export function peekServerTills(uid) {
  if (!uid) return null;
  if (server.has(uid)) return server.get(uid);
  const c = cachedTills(uid);
  return c ? { tills: c, live: false } : null;
}

// force: ask again even though this session already has the answer — after a
// slip is sent, so "today's slip is in" is the server's word, not the phone's.
export function fetchServerTills(uid, { force = false } = {}) {
  if (!uid) return Promise.resolve(null);
  if (!force && server.get(uid)?.live) return Promise.resolve(server.get(uid));
  // A forced ask never rides on one that started before the send.
  if (!force && inFlight.has(uid)) return inFlight.get(uid);
  const gen = generation;
  const p = (async () => {
    try {
      if (!slipTillsFn) {
        const [{ httpsCallable }, { functions }] = await Promise.all([import("firebase/functions"), import("../../firebase")]);
        slipTillsFn = httpsCallable(functions, "cardBatchCapture", { timeout: 30000 });
      }
      const { data } = await slipTillsFn({ action: "slipTills" });
      if (data?.ok !== true || !Array.isArray(data.tills) || gen !== generation) return null;
      const v = { tills: data.tills, dayYmd: typeof data.dayYmd === "string" ? data.dayYmd : null, live: true };
      server.set(uid, v);
      try { globalThis.localStorage?.setItem(TILLS_KEY(uid), JSON.stringify(data.tills)); } catch { /* fine */ }
      for (const l of serverListeners.get(uid) || []) l(v);
      return v;
    } catch {
      return null; // the registry listen still answers, just later
    } finally {
      if (inFlight.get(uid) === p) inFlight.delete(uid);
    }
  })();
  inFlight.set(uid, p);
  return p;
}

export function subscribeServerTills(uid, cb) {
  if (!uid) return () => {};
  if (!serverListeners.has(uid)) serverListeners.set(uid, new Set());
  serverListeners.get(uid).add(cb);
  if (server.has(uid)) cb(server.get(uid));
  fetchServerTills(uid);
  return () => serverListeners.get(uid)?.delete(cb);
}

/** Home screen: start both reads early for an account with a Card Slip scope. */
export function usePrefetchSlipTerminals(enabled, uid) {
  useEffect(() => (enabled ? subscribeSlipTerminals(() => {}) : undefined), [enabled]);
  useEffect(() => { if (enabled && uid) fetchServerTills(uid); }, [enabled, uid]);
}

/** Tests only. */
export function _resetSlipTerminals() {
  if (typeof off === "function") off();
  off = null;
  clearTimeout(retry);
  retry = null;
  latest = undefined;
  listeners.clear();
  server.clear();
  serverListeners.clear();
  inFlight.clear();
  slipTillsFn = null;
  generation++;
}
