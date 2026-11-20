// ─── ACTIVE STORE — the ONE answer to "which shop am I working in?" ──────────
// Junid, 20 Nov 2026: every staff user may pick, check and order for ALL FOUR
// shops (Marathon PE, Trophy, Pine, Concrete). Leaving your own shop is a
// serious act: a full-screen confirmation, a banner on every screen while you
// are away, an audit line for every switch, and an automatic return home at
// the start of each SA day and on every fresh login.
//
// HOME SHOP = /users/{uid}/destShop (the existing single-shop assignment; it is
// never written here). An account without one (Junid, warehouse, admin) has no
// home: its active shop starts empty — "no pin", the full view it always had —
// and a switch needs no confirmation because there is nothing to leave.
//
// Every screen reads the SAME singleton (useActiveStore / getActiveStore), so a
// switch on Display Checks is a switch on the order screen, the order feed and
// everything keyed off it.
//
// Persisted per device in localStorage as { uid, shop, saDate, signIn }. A
// stored choice is honoured only for the SAME account, the SAME SA day and the
// SAME sign-in (Firebase user.metadata.lastSignInTime) — anything else starts
// at home, so no switch ever carries over a night or into someone else's login.
//
// Every switch (by hand or automatic) goes to the audit log through `log`
// (the logStoreSwitch callable; App binds it). No database read happens here.
import { useSyncExternalStore } from "react";
import { saDateString, serverNowMs } from "./serverTime";

export const ACTIVE_STORE_KEY = "mc.activeStore.v1";
const PENDING_LOG_KEY = "mc.activeStore.pendingLog.v1";
const MAX_PENDING_LOG = 20;

export const SWITCH_REASON = Object.freeze({
  SWITCH: "switch",           // confirmed switch to another shop
  BACK_HOME: "back-home",     // "Back to <home>" or tapping the home chip
  DAILY_RESET: "daily-reset", // a new SA day began while away
  FRESH_LOGIN: "fresh-login", // a new sign-in found an away choice on this device
  SIGN_OUT: "sign-out",       // signed out while away: the choice ends with the session
  REHOMED: "rehomed",
  SIGN_OUT_FAILED: "sign-out-failed", // the sign-out line above it did not happen: still away         // Junid changed this person's home shop: they go to it
});

const blank = () => ({ uid: null, name: null, homeShop: null, activeShop: null, pending: null, saDate: null, signIn: null, deviceId: null });
let state = blank();
let deps = { storage: null, log: null, today: () => saDateString(), now: () => serverNowMs() };
const listeners = new Set();

function emit() {
  state = { ...state };
  for (const fn of listeners) { try { fn(); } catch { /* a broken subscriber never blocks a switch */ } }
}

function store() {
  if (deps.storage) return deps.storage;
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}
function readJson(key) {
  try { const raw = store()?.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeJson(key, v) {
  try { if (v == null) store()?.removeItem(key); else store()?.setItem(key, JSON.stringify(v)); } catch { /* private mode: in-memory only */ }
}

function persist() {
  if (!state.uid) return;
  writeJson(ACTIVE_STORE_KEY, { uid: state.uid, shop: state.activeShop, saDate: state.saDate, signIn: state.signIn });
}

// ── Audit: every line is QUEUED FIRST (in storage, with its account's uid and
// a stable id), then sent; it leaves the queue only once the server has
// accepted it. A reload mid-send loses nothing, and the id makes a resend
// idempotent server-side (store_switch_log/{saDate}/{id}).
// Bounded: at most MAX_PENDING_LOG queued lines per device, oldest dropped.
const readQueue = () => { const q = readJson(PENDING_LOG_KEY); return Array.isArray(q) ? q.filter((e) => e && e.id) : []; };
const writeQueue = (list) => writeJson(PENDING_LOG_KEY, list.length ? list.slice(-MAX_PENDING_LOG) : null);
function queueLog(entry) { writeQueue([...readQueue().filter((e) => e.id !== entry.id), entry]); }
function unqueue(id) { writeQueue(readQueue().filter((e) => e.id !== id)); }
// A refusal that will never succeed on retry is dropped, not re-queued.
// (Not `unauthenticated`: a line sent as the session ended is retried by
// that account's next session.)
const PERMANENT = /invalid-argument|permission-denied|resource-exhausted/;
const isPermanent = (err) => PERMANENT.test(String(err?.code || err?.message || ""));
let idSeq = 0;
const newId = (ms) => `${ms}_${Math.random().toString(36).slice(2, 8)}${(idSeq++ % 36).toString(36)}`;

// One send per line at a time: audit() and a flush can both reach a line.
const inFlight = new Map();   // id → Promise<boolean>
function send(e) {
  if (inFlight.has(e.id)) return inFlight.get(e.id);
  const { uid, ...entry } = e;
  const p = (async () => {
    try { await deps.log(entry); unqueue(e.id); return true; }
    catch (err) { if (isPermanent(err)) unqueue(e.id); return false; }
  })().finally(() => inFlight.delete(e.id));
  inFlight.set(e.id, p);
  return p;
}

// Each queued line names the account it belongs to. The server takes the uid
// from the caller's token, so a line is only ever sent by THAT account's
// session; lines of another account on this shared device wait for it.
// Single flight PER ACCOUNT: a pass still running for a previous account is
// waited for, then this account gets its own pass.
let flushing = null;   // { uid, promise }
export function flushPendingLog() {
  if (!deps.log || !state.uid) return Promise.resolve();
  const uid = state.uid;
  if (flushing && flushing.uid === uid) return flushing.promise;
  const before = flushing ? flushing.promise.catch(() => {}) : Promise.resolve();
  const promise = before.then(async () => {
    for (const e of readQueue().filter((x) => x.uid === uid)) {
      if (state.uid !== uid) break;              // signed out mid-flush: stop
      if (!readQueue().some((x) => x.id === e.id)) continue;   // delivered meanwhile
      await send(e);
    }
  }).finally(() => { if (flushing && flushing.promise === promise) flushing = null; });
  flushing = { uid, promise };
  return promise;
}
let lastAuditId = null;
function audit(from, to, reason) {
  const uid = state.uid;
  if (!uid) return Promise.resolve();
  const at = deps.now();
  const e = {
    uid, id: newId(at), from: from || null, to: to || null, home: state.homeShop || null, reason,
    deviceId: state.deviceId || null, clientAtMs: at,
  };
  queueLog(e);
  lastAuditId = e.id;
  if (!deps.log) return Promise.resolve();
  // Delivered → the line is clearly reachable: send anything older still queued.
  return Promise.resolve().then(() => send(e)).then((ok) => { if (ok) flushPendingLog().catch(() => {}); });
}

function commit(to, reason) {
  const from = state.activeShop;
  state.pending = null;
  if (from === to) { emit(); return; }
  state.activeShop = to || null;
  state.saDate = deps.today();
  persist();
  emit();
  audit(from, to, reason);
}

// ── Binding (AuthGate calls this whenever the account or its record changes) ──
export function bindActiveStore({ uid, homeShop = null, name = null, signIn = null, deviceId = null } = {}) {
  if (!uid) { resetActiveStore(); return; }
  const today = deps.today();
  const sameAccount = state.uid === uid && state.signIn === signIn;
  if (sameAccount) {
    // Same session: only the record changed (name, or Junid re-homed them).
    const homeMoved = state.homeShop !== (homeShop || null);
    state.name = name; state.deviceId = deviceId;
    if (homeMoved) {
      const from = state.activeShop;
      state.homeShop = homeShop || null;
      state.activeShop = state.homeShop;
      state.pending = null;
      state.saDate = today;
      persist();
      if (from !== state.activeShop) audit(from, state.activeShop, SWITCH_REASON.REHOMED);
    }
    emit();
    flushPendingLog().catch(() => {});
    return;
  }
  const saved = readJson(ACTIVE_STORE_KEY);
  state = { ...blank(), uid, name, homeShop: homeShop || null, deviceId, signIn, saDate: today, activeShop: homeShop || null };
  if (saved && saved.uid === uid && saved.saDate === today && saved.signIn === signIn) {
    state.activeShop = saved.shop || null;              // same login, same day: keep the choice
  } else if (saved && saved.uid === uid && saved.shop && saved.shop !== (homeShop || null)) {
    // An away choice from a previous day or a previous login: it ends here.
    audit(saved.shop, homeShop || null, saved.saDate !== today ? SWITCH_REASON.DAILY_RESET : SWITCH_REASON.FRESH_LOGIN);
  }
  persist();
  emit();
  flushPendingLog().catch(() => {});
}

// Signing out while away: audit the return home FIRST, while the session can
// still call the server. The state itself is cleared by resetActiveStore once
// sign-out has actually happened (AuthGate sees no user) — so a failed
// sign-out leaves this account fully working.
let signOutAudited = false;
let signOutLineId = null;
export function auditSignOut() {
  if (!isAwayFromHome(state)) return Promise.resolve();
  signOutAudited = true;
  const p = audit(state.activeShop, state.homeShop, SWITCH_REASON.SIGN_OUT);
  signOutLineId = lastAuditId;
  return p;
}
// Sign-out failed: the person is still away. A sign-out line not yet sent is
// withdrawn; one already delivered is corrected by a line saying so.
export function signOutFailed() {
  const id = signOutLineId;
  signOutAudited = false; signOutLineId = null;
  if (!id || !isAwayFromHome(state)) return;
  if (readQueue().some((e) => e.id === id)) { unqueue(id); return; }
  audit(state.homeShop, state.activeShop, SWITCH_REASON.SIGN_OUT_FAILED);
}

// Signed out (or the session vanished): forget this account's choice. An
// away choice not already audited by auditSignOut is queued under its uid —
// sent by that account's next session (the server would refuse it now).
export function resetActiveStore() {
  if (isAwayFromHome(state) && !signOutAudited) {
    const at = deps.now();
    queueLog({ uid: state.uid, id: newId(at), from: state.activeShop, to: state.homeShop, home: state.homeShop,
               reason: SWITCH_REASON.SIGN_OUT, deviceId: state.deviceId || null, clientAtMs: at });
  }
  signOutAudited = false;
  writeJson(ACTIVE_STORE_KEY, null);
  state = blank();
  emit();
}

// Called on a timer: at SA midnight an away choice goes back home by itself.
// A day change must be seen on TWO consecutive checks: the server clock offset
// can land a moment after boot and shift the device's idea of the day; a real
// midnight is still there a minute later, a correction is not.
let rolloverSeen = null;
export function checkDayRollover() {
  if (!state.uid) return false;
  const today = deps.today();
  if (state.saDate === today) { rolloverSeen = null; return false; }
  if (rolloverSeen !== today) { rolloverSeen = today; return false; }
  rolloverSeen = null;
  const away = state.activeShop !== state.homeShop;
  if (away) { commit(state.homeShop, SWITCH_REASON.DAILY_RESET); return true; }
  state.saDate = today; persist(); emit();
  return false;
}

// ── Switching ────────────────────────────────────────────────────────────────
// Tap a shop chip anywhere. Same shop → nothing. Your home shop → straight back,
// no question. Any other shop while you have a home → the confirmation modal
// (state.pending). No home → switch at once (there is nothing to leave).
export function requestSwitch(shop) {
  if (!state.uid || !shop) return;
  if (shop === state.activeShop) { if (state.pending) { state.pending = null; emit(); } return; }
  if (state.homeShop && shop === state.homeShop) { commit(shop, SWITCH_REASON.BACK_HOME); return; }
  if (state.homeShop) { state.pending = shop; emit(); return; }
  commit(shop, SWITCH_REASON.SWITCH);
}
export function confirmSwitch() {
  if (!state.pending) return;
  commit(state.pending, SWITCH_REASON.SWITCH);
}
export function cancelSwitch() {
  if (!state.pending) return;
  state.pending = null;
  emit();
}
export function backToHome() {
  if (!state.homeShop || state.activeShop === state.homeShop) return;
  commit(state.homeShop, SWITCH_REASON.BACK_HOME);
}

// ── Reading ──────────────────────────────────────────────────────────────────
export function getActiveStore() { return state; }
export function isAwayFromHome(s = state) { return !!s.homeShop && !!s.activeShop && s.activeShop !== s.homeShop; }

// The stamp every store-scoped write carries: which shop the action counts for,
// whose shop the person belongs to, and whether they were working away.
export function activeStoreStamp(s = state) {
  return { actingStore: s.activeShop || null, actingHomeStore: s.homeShop || null, actingAway: isAwayFromHome(s) };
}

export function subscribeActiveStore(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Another tab of this app on the same device switched (or went home): follow
// it, so every tab stamps its writes with the same shop.
export function adoptStoredChoice() {
  if (!state.uid) return;
  const saved = readJson(ACTIVE_STORE_KEY);
  if (!saved || saved.uid !== state.uid || saved.signIn !== state.signIn) return;
  const shop = saved.shop || null;
  if (shop === state.activeShop && saved.saDate === state.saDate) return;
  state.activeShop = shop; state.saDate = saved.saDate; state.pending = null;
  emit();
}
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  try { window.addEventListener("storage", (e) => { if (!e || e.key === ACTIVE_STORE_KEY) adoptStoredChoice(); }); } catch { /* no storage events */ }
}

export function useActiveStore() {
  return useSyncExternalStore(subscribeActiveStore, getActiveStore, getActiveStore);
}

// ── Wiring ───────────────────────────────────────────────────────────────────
export function setActiveStoreLogger(fn) { deps.log = fn || null; if (fn) flushPendingLog().catch(() => {}); }
export function __setActiveStoreDepsForTests(next = {}) { deps = { ...deps, ...next }; }
export function __resetActiveStoreForTests() {
  state = blank();
  deps = { storage: null, log: null, today: () => saDateString(), now: () => serverNowMs() };
  listeners.clear();
  rolloverSeen = null;
  signOutAudited = false;
  signOutLineId = null;
  flushing = null;
  inFlight.clear();
}
