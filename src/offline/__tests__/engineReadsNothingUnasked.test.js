// ─── THE REAL ENGINE, AND A COUNTED ZERO ─────────────────────────────────────
//
// Every other test on this branch stops either at the sync engine or at a fake
// runtime, and a spec review found that the most expensive behaviour on the
// branch lived in exactly the gap between them:
//
//   `startOfflineMirror` registered an auth listener, firebase fired it with
//   the current user the moment it was registered, and it called schedule(0).
//   That is the pass loop — whose step 4 re-downloads any leg without a setup
//   marker, one per pass, which on a fresh device is EVERY leg. So a device
//   downloaded the whole shop, unasked, through a door the Download button
//   knew nothing about, and stamped itself complete at the end of it without
//   the forced census that makes a first copy safe to serve.
//
// Nothing could see it, because nothing ran this function. Now something does:
// the database is a test IndexedDB and the adapter is a fake that COUNTS ITS
// READS, so "nothing is downloaded before somebody taps Download" is a number
// and not a belief.
import { describe, test, expect, beforeEach, vi } from "vitest";
import { freshMirrorDb } from "./helpers";
import { createFakeRtdb } from "./fakeAdapter";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

// The auth listener is the thing under test, so it is modelled exactly as
// firebase behaves: the callback fires with the current user AT REGISTRATION.
let authUser = { uid: "u1", isAnonymous: false };
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (auth, cb) => { cb(authUser); return () => {}; },
}));
vi.mock("../../firebase", () => ({ database: {}, auth: {}, storage: {} }));
vi.mock("../../update/updateChecker", () => ({
  setForcedUpdateMode: () => {}, setUpdateBusy: () => {},
}));

import { startOfflineMirror, CONSENT_META } from "../bootstrap";
import { setMirrorSwitchValue, _resetMirrorSwitchForTests } from "../killSwitch";
import { _resetServingForTests, isLegServing } from "../serving";
import { _resetMirrorSignalForTests } from "../mirrorSignal";
import { COUNTS_ROOT } from "../changeFeed";
import { SETUP_DONE_META } from "../sync";

const T0 = 1_790_000_000_000;

function world(extra = {}) {
  return createFakeRtdb({
    locations: { hub1: { id: "hub1" } },
    users: { u1: { name: "Zee" } },
    products: { p1: { id: "p1", name: "Nike Air", price: 1200 } },
    stock: { hub1: { p1: { 9: { qty: 3 } } } },
    orders: { "001": { id: "001" } },
    customers: { c1: { name: "Ndu" } },
    refill_requests: { r1: { status: "open" } },
    ...extra,
  });
}

// A controllable clock: the engine schedules its own passes, and a test that
// waited sixty real seconds for one would not be a test anybody runs.
function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  const setTimeoutFn = (fn, ms) => { seq += 1; pending.set(seq, { fn, ms }); return seq; };
  const clearTimeoutFn = (id) => { pending.delete(id); };
  async function runDue(n = 1) {
    for (let i = 0; i < n; i += 1) {
      const next = [...pending.entries()].sort((a, b) => a[1].ms - b[1].ms)[0];
      if (!next) return i;
      pending.delete(next[0]);
      await next[1].fn();
      // let whatever the tick scheduled settle
      await new Promise((r) => setImmediate(r));
    }
    return n;
  }
  return { setTimeoutFn, clearTimeoutFn, runDue, count: () => pending.size };
}

async function startOn(w, db, opts = {}) {
  const timers = fakeTimers();
  const rt = await startOfflineMirror({
    auth: { currentUser: authUser },
    storage: null,
    buildVersion: "test",
    now: () => T0,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    openDb: async () => db,
    makeAdapter: () => w.adapter,
    ...opts,
  });
  return { rt, timers };
}

const reads = (w) =>
  w.calls.readPath.length + w.calls.readKeyPage.length + w.calls.readChildPage.length;

beforeEach(() => {
  store.clear();
  authUser = { uid: "u1", isAnonymous: false };
  _resetMirrorSwitchForTests();
  _resetServingForTests();
  _resetMirrorSignalForTests();
  setMirrorSwitchValue(true);
});

describe("a device nobody has tapped Download on", () => {
  test("reads NOTHING from the database, however long it is left running", async () => {
    const db = await freshMirrorDb();
    const w = world();
    const { rt, timers } = await startOn(w, db);

    // The auth listener has already fired with a signed-in user by now — that
    // is the whole point — and there is nothing else to trigger.
    await timers.runDue(5);

    expect(reads(w)).toBe(0);
    expect(await db.count("products")).toBe(0);
    expect(await db.getMeta(SETUP_DONE_META)).toBeUndefined();
    expect(isLegServing("products")).toBe(false);
    rt.stop();
  });

  test("and start() refuses, so nothing can turn the pass loop on behind the gate", async () => {
    const db = await freshMirrorDb();
    const w = world();
    const { rt, timers } = await startOn(w, db);
    rt.start();
    await timers.runDue(5);
    expect(reads(w)).toBe(0);
    rt.stop();
  });

  test("resume() says the question has not been asked, rather than answering it", async () => {
    const db = await freshMirrorDb();
    const w = world();
    const { rt } = await startOn(w, db);
    expect(await rt.resume()).toBe("needs-consent");
    expect(reads(w)).toBe(0);
    rt.stop();
  });
});

describe("a device that HAS tapped Download", () => {
  test("downloads, censuses itself, and only then serves", async () => {
    const db = await freshMirrorDb();
    const w = world({ [COUNTS_ROOT]: { products: { rows: 1, at: T0 } } });
    const { rt } = await startOn(w, db);

    await rt.consentAndDownload();
    // The download is a background loop; let it settle.
    for (let i = 0; i < 40 && !(await rt.setupState()).done; i += 1) {
      await new Promise((r) => setImmediate(r));
    }

    expect((await rt.setupState()).done).toBe(true);
    expect(await db.count("products")).toBe(1);
    // The census was asked, FORCED, before the serving hint was written.
    expect(w.calls.readPath).toContain(COUNTS_ROOT);
    expect(isLegServing("products")).toBe(true);
    rt.stop();
  });

  test("the consent survives a restart — it is asked once per device, not once per session", async () => {
    const db = await freshMirrorDb();
    const w = world();
    const { rt } = await startOn(w, db);
    await rt.consentAndDownload();
    rt.stop();
    expect(await db.getMeta(CONSENT_META)).toBeTruthy();

    const w2 = world();
    const { rt: rt2 } = await startOn(w2, db);
    expect(await rt2.resume()).not.toBe("needs-consent");
    rt2.stop();
  });
});

describe("a device with nobody signed in", () => {
  test("reads nothing, even with the consent already recorded", async () => {
    // A read registered before sign-in is refused and does not retry, so a
    // start that ran at first paint left the change-log signal dead for the
    // whole session and told staff a database rule had not been pasted.
    const db = await freshMirrorDb();
    await db.setMeta(CONSENT_META, { at: T0 });
    authUser = null;
    const w = world();
    const { rt, timers } = await startOn(w, db, { auth: { currentUser: null } });
    rt.start();
    await timers.runDue(5);
    expect(reads(w)).toBe(0);
    rt.stop();
  });
});

describe("the fleet switch, against the real engine", () => {
  test("a device with the switch off reads nothing, consent or no consent", async () => {
    const db = await freshMirrorDb();
    await db.setMeta(CONSENT_META, { at: T0 });
    setMirrorSwitchValue(false);
    const w = world();
    expect(await startOfflineMirror({
      auth: { currentUser: authUser }, openDb: async () => db, makeAdapter: () => w.adapter,
    })).toBe(null);
    expect(reads(w)).toBe(0);
  });

  test("a kill during the download stands the download down instead of finishing it", async () => {
    const db = await freshMirrorDb();
    await db.setMeta(CONSENT_META, { at: T0 });
    const w = world();
    const { rt } = await startOn(w, db);

    // Kill it after the very first leg's read.
    const realReadPath = w.adapter.readPath;
    let killed = false;
    w.adapter.readPath = async (...args) => {
      if (!killed) { killed = true; setMirrorSwitchValue(false); }
      return realReadPath.call(w.adapter, ...args);
    };

    await rt.downloadInBackground();

    expect((await rt.setupState()).done).toBe(false);
    expect(await db.getMeta(SETUP_DONE_META)).toBeUndefined();
    // Nothing is served from a copy that was abandoned half-made.
    expect(isLegServing("products")).toBe(false);
    expect(rt.state.downloading).toBe(false);
    rt.stop();
  });
});
