// ─── EFT ENFORCEMENT — Trophy + Marathon PE must match every EFT sale ────────
// Pinned: the default set (trophy + pe, never pine or concrete) and that the
// /eft_enforcement node overrides it exactly; a regular sale at an enforced
// store with an EFT leg naming no pool payment is a BREACH, at a non-enforced
// store it is not; the callable answers any active POS identity and lets ONLY
// the owner change the set; the 5-minute scan writes the breach record from a
// bounded indexed page.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_ENFORCED_STORES, enforcedStoresOf, isEftEnforcedAt, enforcementUpdateOf, enforcementStatusOf,
  enforcementBreachOf, breachScanNext, BREACH_SCAN_WINDOW_MS, BREACH_SCAN_PAGE,
} = require("../lib/eft-enforce.cjs");

const K = "a".repeat(40);
const sale = (over = {}) => ({ type: "sale", storeId: "trophy", tillId: "till-1", cashierName: "Ahmed", receiptNumber: "S-1", createdAt: 5000, total: 50000,
  payments: { p1: { method: "eft", amount: 50000 } }, ...over });

test("DEFAULT: Trophy and Marathon PE are enforced; Pine and Concrete are not", () => {
  assert.deepEqual([...DEFAULT_ENFORCED_STORES].sort(), ["pe", "trophy"]);
  for (const node of [null, undefined, {}, { updatedAt: 1 }, { stores: "trophy" }]) {
    assert.deepEqual(enforcedStoresOf(node), ["pe", "trophy"], JSON.stringify(node));
  }
  assert.equal(isEftEnforcedAt("trophy", null), true);
  assert.equal(isEftEnforcedAt("pe", null), true);
  assert.equal(isEftEnforcedAt("pine", null), false);
  assert.equal(isEftEnforcedAt("concrete", null), false);
  assert.equal(isEftEnforcedAt("../users", null), false);
});

test("the config node is honoured exactly — a store is added or removed without a deploy", () => {
  const node = { stores: { trophy: true, pe: true, pine: true, concrete: false } };
  assert.deepEqual(enforcedStoresOf(node), ["pe", "pine", "trophy"]);
  assert.equal(isEftEnforcedAt("pine", node), true);
  assert.deepEqual(enforcedStoresOf({ stores: {} }), [], "the owner switching it off everywhere is honoured");
  assert.deepEqual(enforcedStoresOf({ stores: { trophy: "yes", "bad id": true, pe: true } }), ["pe"], "only true, only real ids");
});

test("the owner's update is validated, never coerced", () => {
  const ok = enforcementUpdateOf({ stores: { trophy: true, pine: false } }, { at: 9, by: "owner@x" });
  assert.deepEqual(ok, { ok: true, value: { stores: { trophy: true, pine: false }, updatedAt: 9, updatedBy: "owner@x" } });
  assert.equal(enforcementUpdateOf({ stores: { trophy: "true" } }, { at: 9 }).code, "bad-flag");
  assert.equal(enforcementUpdateOf({ stores: { "Trophy Store": true } }, { at: 9 }).code, "bad-store-id");
  assert.equal(enforcementUpdateOf({ stores: ["trophy"] }, { at: 9 }).code, "bad-stores");
  assert.equal(enforcementUpdateOf({}, { at: 9 }).code, "bad-stores");
});

test("the status the till reads says enforced/not for its store and where the set came from", () => {
  assert.deepEqual(enforcementStatusOf(null, "trophy"), { enforcedStores: ["pe", "trophy"], enforced: true, source: "default", updatedAt: null });
  assert.deepEqual(enforcementStatusOf(null, "pine"), { enforcedStores: ["pe", "trophy"], enforced: false, source: "default", updatedAt: null });
  assert.deepEqual(enforcementStatusOf({ stores: { pine: true }, updatedAt: 7 }, "trophy"), { enforcedStores: ["pine"], enforced: false, source: "config", updatedAt: 7 });
  assert.equal(enforcementStatusOf(null, null).enforced, null);
});

test("BREACH: an EFT sale at Trophy or Marathon with no pool payment is flagged", () => {
  const enforced = enforcedStoresOf(null);
  const b = enforcementBreachOf("S1", sale(), enforced);
  assert.ok(b);
  assert.equal(b.storeId, "trophy");
  assert.equal(b.eftCents, 50000);
  assert.deepEqual(b.legs, [{ paymentId: "p1", amount: 50000 }]);
  assert.equal(b.receiptNumber, "S-1");
  assert.ok(enforcementBreachOf("S2", sale({ storeId: "pe", payments: { a: { method: "cash", amount: 100 }, b: { method: "eft", amount: 900, eftReference: "JUNID" } } }), enforced), "a reference typed by hand is not a pool payment");
});

test("NOT a breach: a matched payment, a non-enforced store, card/cash/split/layby/refund", () => {
  const enforced = enforcedStoresOf(null);
  assert.equal(enforcementBreachOf("S", sale({ payments: { p1: { method: "eft", amount: 50000, eftPoolKey: K } } }), enforced), null, "matched");
  assert.equal(enforcementBreachOf("S", sale({ storeId: "pine" }), enforced), null, "Pine keeps the old way");
  assert.equal(enforcementBreachOf("S", sale({ storeId: "concrete" }), enforced), null, "Concrete keeps the old way");
  assert.equal(enforcementBreachOf("S", sale({ payments: { p1: { method: "card", amount: 50000, cardAuthCode: "1234" } } }), enforced), null, "card");
  assert.equal(enforcementBreachOf("S", sale({ payments: { p1: { method: "cash", amount: 20000 }, p2: { method: "eft", amount: 30000, eftPoolKey: K } } }), enforced), null, "split with a matched EFT leg");
  assert.equal(enforcementBreachOf("S", sale({ type: "layby" }), enforced), null, "layby deposits keep plain EFT");
  assert.equal(enforcementBreachOf("S", sale({ type: "refund" }), enforced), null, "refund");
  assert.equal(enforcementBreachOf("S", sale({ payments: { p1: { method: "eft", amount: 50000, eftPoolKey: "not-a-key" } } }), enforced)?.legs.length, 1, "a malformed key is no key");
  assert.equal(enforcementBreachOf("S", null, enforced), null);
});

test("the scan window slides two hours, and drains from the last seen sale when a page was full", () => {
  const now = 10_000_000_000;
  const first = breachScanNext({ state: null, now, maxSeen: null, full: false });
  assert.equal(first.sinceMs, now - BREACH_SCAN_WINDOW_MS);
  const full = breachScanNext({ state: { sinceMs: now - BREACH_SCAN_WINDOW_MS }, now, maxSeen: now - 1000, full: true });
  assert.equal(full.sinceMs, now - 1000, "continues FROM the last seen sale — a shared millisecond is never skipped");
  assert.equal(full.drained, false);
  const slid = breachScanNext({ state: { sinceMs: now - 10 * BREACH_SCAN_WINDOW_MS }, now, maxSeen: now - 5000, full: false });
  assert.equal(slid.sinceMs, now - BREACH_SCAN_WINDOW_MS, "a drained run slides the window up to now − 2h");
  assert.ok(BREACH_SCAN_PAGE <= 500, "one bounded page, never the node");
});

// ─── THE CALLABLE AND THE SCAN, through a stubbed Admin SDK ──────────────────
class HttpsError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } }
const db = { reads: {}, sets: {}, queries: [] };
const fakeAdmin = {
  apps: [1], initializeApp() {},
  database: Object.assign(() => ({
    ref: (path) => {
      const q = { cs: [] };
      const chain = {
        orderByChild: (k) => { q.cs.push(["orderByChild", k]); return chain; },
        orderByKey: () => { q.cs.push(["orderByKey"]); return chain; },
        startAt: (v) => { q.cs.push(["startAt", v]); return chain; },
        startAfter: (v) => { q.cs.push(["startAfter", v]); return chain; },
        limitToFirst: (n) => { q.cs.push(["limitToFirst", n]); return chain; },
        limitToLast: (n) => { q.cs.push(["limitToLast", n]); return chain; },
        once: async () => {
          db.queries.push({ path, cs: q.cs });
          const v = db.reads[path] ?? null;
          return { val: () => v, forEach: (fn) => { for (const key of Object.keys(v ?? {})) fn({ key }); } };
        },
        set: async (v) => { db.sets[path] = v; },
        remove: async () => { delete db.sets[path]; },
        update: async () => {},
        transaction: async (fn) => {
          const out = fn(db.reads[path] ?? null);
          if (out !== undefined) { (db.tx ??= {})[path] = out; db.txWrites = (db.txWrites ?? 0) + 1; }
          return { committed: out !== undefined };
        },
      };
      return chain;
    },
  }), { ServerValue: { TIMESTAMP: { ".sv": "timestamp" } } }),
};
function stub(name, exportsObj) {
  const p = require.resolve(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}
stub("firebase-functions/v2/https", { onCall: (_o, h) => h, HttpsError });
stub("firebase-functions/v2/scheduler", { onSchedule: (_o, h) => h });
stub("firebase-admin", fakeAdmin);
const { eftEnforcementStatus, eftRemainderScan } = require("../eftPool/eftPool.js");

const OWNER = { auth: { uid: "owner-uid", token: { email: "gunidmoh@gmail.com", email_verified: true } } };
const CASHIER = { auth: { uid: "cashier-uid", token: { email: "ahmed@marathon.internal" } } };
const MANAGER = { auth: { uid: "manager-uid", token: { email: "ibrahim@marathon.internal" } } };
db.reads["users/cashier-uid/posAccess/isActive"] = true;
db.reads["users/manager-uid/posAccess/isActive"] = true;
db.reads["users/manager-uid/posAccess"] = { isActive: true, role: "manager", eftReview: true, individual: true, displayName: "ibrahim" };

async function rejects(promise, code) {
  try { await promise; } catch (e) { assert.equal(e.code, code, e.message); return e; }
  assert.fail(`expected a ${code} refusal`);
}

test("the till reads enforcement for its store — the default when nothing is configured", async () => {
  delete db.reads["eft_enforcement"];
  assert.deepEqual(await eftEnforcementStatus({ ...CASHIER, data: { storeId: "trophy" } }), { ok: true, enforcedStores: ["pe", "trophy"], enforced: true, source: "default", updatedAt: null });
  assert.equal((await eftEnforcementStatus({ ...CASHIER, data: { storeId: "pine" } })).enforced, false);
  await rejects(eftEnforcementStatus({ auth: { uid: "stranger", token: {} }, data: { storeId: "trophy" } }), "permission-denied");
});

test("ONLY the owner changes the set — a manager with EFT review is refused and nothing is written", async () => {
  db.sets = {};
  for (const who of [CASHIER, MANAGER]) {
    const e = await rejects(eftEnforcementStatus({ ...who, data: { action: "set", stores: { trophy: false } } }), "permission-denied");
    assert.match(e.message, /Only Junid/);
  }
  assert.equal(db.sets["eft_enforcement"], undefined);
  // MERGE semantics: switching Pine on from no node starts from the default,
  // so Trophy and Marathon PE stay enforced.
  delete db.reads["eft_enforcement"];
  const out = await eftEnforcementStatus({ ...OWNER, data: { action: "set", stores: { pine: true } } });
  assert.deepEqual(out.enforcedStores, ["pe", "pine", "trophy"]);
  assert.deepEqual(db.sets["eft_enforcement"].stores, { trophy: true, pe: true, pine: true });
  assert.equal(db.sets["eft_enforcement"].updatedBy, "gunidmoh@gmail.com");
  // …and switching one OFF later keeps the rest.
  db.reads["eft_enforcement"] = db.sets["eft_enforcement"];
  const off = await eftEnforcementStatus({ ...OWNER, data: { action: "set", stores: { pine: false } } });
  assert.deepEqual(off.enforcedStores, ["pe", "trophy"]);
  // The breach list is Junid's alone, one bounded page by key order.
  db.queries = [];
  await rejects(eftEnforcementStatus({ ...MANAGER, data: { action: "listBreaches" } }), "permission-denied");
  const list = await eftEnforcementStatus({ ...OWNER, data: { action: "listBreaches" } });
  assert.deepEqual(list.breaches, []);
  assert.deepEqual(db.queries.find((q) => q.path === "eft_enforcement_breaches").cs.map((c) => c[0]), ["orderByKey", "limitToLast"]);
  const bad = await rejects(eftEnforcementStatus({ ...OWNER, data: { action: "set", stores: { trophy: "off" } } }), "invalid-argument");
  assert.equal(bad.details.code, "bad-flag");
});

test("the scan flags a plain-EFT sale at Trophy, leaves Pine's alone, reads one bounded page", async () => {
  db.sets = {}; db.queries = [];
  delete db.reads["eft_enforcement"];
  db.reads["_migrations/eftFingerprintBackfill"] = { done: true };
  db.reads["pos/sales"] = {
    "S-trophy": sale({ createdAt: 8000 }),
    "S-pine": sale({ storeId: "pine", createdAt: 8100 }),
    "S-matched": sale({ storeId: "pe", createdAt: 8200, payments: { p: { method: "eft", amount: 50000, eftPoolKey: K } } }),
  };
  await eftRemainderScan();
  const salesQuery = db.queries.find((q) => q.path === "pos/sales");
  assert.ok(salesQuery, "the sales walk ran");
  assert.deepEqual(salesQuery.cs.map((c) => c[0]), ["orderByChild", "startAt", "limitToFirst"], "indexed, windowed, paged — never the node");
  assert.equal(salesQuery.cs[0][1], "createdAt");
  assert.equal(salesQuery.cs[2][1], BREACH_SCAN_PAGE);
  assert.ok(db.tx["eft_enforcement_breaches/S-trophy"], "the Trophy sale is a breach");
  assert.equal(db.tx["eft_enforcement_breaches/S-trophy"].eftCents, 50000);
  assert.equal(db.tx["eft_enforcement_breaches/S-pine"], undefined, "Pine keeps the old way");
  assert.equal(db.tx["eft_enforcement_breaches/S-matched"], undefined, "a matched payment is fine");
  assert.ok(Number.isInteger(db.sets["eft_enforcement_scan"].sinceMs), "the cursor is kept");
  // The window slides, so the sale is read again — the record is CREATE-ONLY:
  // the first sighting stands and no second record (or alert) is written.
  const first = db.tx["eft_enforcement_breaches/S-trophy"];
  db.reads["eft_enforcement_breaches/S-trophy"] = first;
  db.txWrites = 0;
  await eftRemainderScan();
  assert.equal(db.txWrites, 0, "a re-read breach is not rewritten");
});
