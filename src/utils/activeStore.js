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

// ── Audit: fire-and-forget, queued on failure, flushed on the next switch/bind.
// Bounded: at most MAX_PENDING_LOG queued entries per device, oldest dropped.
function queueLog(entry) {
  const q = readJson(PENDING_LOG_KEY);
  const list = Array.isArray(q) ? q : [];
  list.push(entry);
  writeJson(PENDING_LOG_KEY, list.slice(-MAX_PENDING_LOG));
}
// A refusal that will never succeed on retry is dropped, not re-queued.
const PERMANENT = /invalid-argument|unauthenticated|permission-denied/;
const isPermanent = (err) => PERMANENT.test(String(err?.code || err?.message || ""));

// Each queued line names the account it belongs to. The server takes the uid
// from the caller's token, so a line is only ever sent by THAT account's
// session; lines of another account on this shared device wait for it.
export async function flushPendingLog() {
  if (!deps.log || !state.uid) return;
  const q = readJson(PENDING_LOG_KEY);
  if (!Array.isArray(q) || q.length === 0) return;
  const mine = q.filter((e) => e && e.uid === state.uid);
  const others = q.filter((e) => e && e.uid !== state.uid);
  writeJson(PENDING_LOG_KEY, others.length ? others : null);
  for (const { uid, ...entry } of mine) {
    try { await deps.log(entry); } catch (err) { if (!isPermanent(err)) queueLog({ uid, ...entry }); }
  }
}
function audit(from, to, reason) {
  const uid = state.uid;
  const entry = {
    from: from || null, to: to || null, home: state.homeShop || null, reason,
    deviceId: state.deviceId || null, clientAtMs: deps.now(),
  };
  if (!deps.log || !uid) { if (uid) queueLog({ uid, ...entry }); return Promise.resolve(); }
  return Promise.resolve().then(() => deps.log(entry))
    .catch((err) => { if (!isPermanent(err)) queueLog({ uid, ...entry }); });
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
      state.homeShop = homeShop || null;
      state.activeShop = state.homeShop;
      state.pending = null;
      state.saDate = today;
      persist();
    }
    emit();
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

// Sign-out on a shared tablet: forget this account's choice entirely. Away at
// that moment → the return home is audited FIRST (while still signed in); the
// promise lets the caller wait for it (bounded) before signing out.
export function resetActiveStore() {
  const away = isAwayFromHome(state);
  const done = away ? audit(state.activeShop, state.homeShop, SWITCH_REASON.SIGN_OUT) : Promise.resolve();
  writeJson(ACTIVE_STORE_KEY, null);
  state = blank();
  emit();
  return done;
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
}
