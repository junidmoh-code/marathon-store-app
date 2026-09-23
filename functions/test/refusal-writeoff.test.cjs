// ─── WRITE-OFF AFTER FOUR REFUSED DAYS ────────────────────────────────────────
// Run: cd functions && node --test test/refusal-writeoff.test.cjs
//
// Owner rule (2026-09-23): a location that refused one product/size on four
// different calendar days (Africa/Johannesburg), with no fulfilment of that size
// in between, does not have it — erase the pre-refusal paper count for that ONE
// cell automatically and let the flow restart (functions/lib/refusal-writeoff.cjs).
//
// Driven through the real planner, the real server-side writer
// (applyMovementAdmin) on the fake RTDB that deletes empties like the real one,
// and the real computeRefillPlan for "what happens next". The owner's case is
// the spine: Nike Tech Fleece Tracksuit Brown 2, Hub 2 / M, refused on 12, 14,
// 16 and 17 Sep with 3 on paper, while Central already sends 2 M to Hub 2 "for
// Marathon PE" under #641.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { planRefusalWriteoffs, applyRefusalWriteoffs, sastDay } = require("../lib/refusal-writeoff.cjs");
const { computeRefillPlan, sanitizeUpdate } = require("../lib/refill-engine.cjs");

const NOW = Date.parse("2026-09-23T12:45:00.000Z");
const WINDOW_START = NOW - 45 * 864e5;
const PID = "p1780382141061";
const OTHER = "p_other";

const CONFIG = {
  enabled: true,
  mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
  routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  ruleBasedTargets: true, maxUnitsPerIntent: 20, maxIntentsPerRun: 75,
  recheckCooldownMinutes: 1440, rejectStreakLimit: 4, staleIntentHours: 168,
};
const PRODUCTS = {
  [PID]: { name: "Nike Tech Fleece Tracksuit Brown 2", productType: "clothing", sizes: ["M", "L", "XL", "XXL"] },
  [OTHER]: { name: "Other", productType: "clothing", sizes: ["M"] },
};
const TARGETS = {
  hub2: { [PID]: { L: { target: 3, minQty: 2 }, M: { target: 3, minQty: 2 }, XL: { target: 2, minQty: 1 }, XXL: { target: 2, minQty: 1 } } },
  "marathon-pe": { [PID]: { L: { target: 2, minQty: 1 }, M: { target: 2, minQty: 1 }, XL: { target: 1, minQty: 1 }, XXL: { target: 1, minQty: 1 } } },
};
const cell = (qty, extra = {}) => ({ qty, v: 4, mv: "seed", lastType: "transfer_out", updatedAt: "2026-09-09T13:18:11.169Z", ...extra });
const STOCK = () => ({
  "marathon-pe": { [PID]: { L: cell(2), M: cell(0), XL: cell(1), XXL: cell(1) } },
  hub2: { [PID]: { L: cell(3), M: cell(3), XL: cell(2), XXL: cell(2) }, [OTHER]: { M: cell(4) } },
  central: { [PID]: { L: cell(56), M: cell(38), XL: cell(16), XXL: cell(17) } },
  trophy: {}, hub1: {},
});
// The four live refusals, resolved at these exact instants (UTC).
const REFUSED_AT = ["2026-09-12T11:30:40.428Z", "2026-09-14T08:45:31.184Z", "2026-09-16T10:15:04.806Z", "2026-09-17T14:15:22.516Z"];
const refusal = (at, extra = {}) => ({
  productId: PID, size: "M", qty: 2, requestingLocation: "marathon-pe", status: "cancelled",
  createdAt: new Date(Date.parse(at) - 3 * 3600e3).toISOString(), resolvedAt: at,
  createdFrom: { engine: true, source: "hub2" }, ...extra,
});
const RR = () => ({
  "-P15Ik7-dD5dDa-9Bfsh": { ...refusal("2026-09-09T13:30:05.515Z"), status: "fulfilled" },   // before the run
  "-P1JjNWAVHbqAgZsMicE": refusal(REFUSED_AT[0]),
  "-P1P_Uph_VRRq1rRY0um": refusal(REFUSED_AT[1]),
  "-P1ZI0x46_q8_ATlcwiA": refusal("2026-09-16T08:45:22.135Z", { cancelReason: "order_lost" }),   // engine withdrawal — says nothing
  "-P1dRdW8q1m4MUiAReYo": refusal(REFUSED_AT[2]),
  "-P1irJ2tVlblPwBJTi-J": refusal(REFUSED_AT[3]),
  // #641: Central is sending Hub 2 the shop's 2 M — open, untouched by any write-off.
  "-P2D7zGLmKPj6pjFYJaO": {
    productId: PID, size: "M", qty: 2, requestingLocation: "hub2", status: "open",
    createdAt: "2026-09-23T12:00:41.714Z", forDests: ["marathon-pe"],
    createdFrom: { engine: true, source: "central", passThrough: "disputed", forDests: ["marathon-pe"] },
  },
});
const OPEN = () => ({
  hub2: { [PID]: { M: { refillId: "-P2D7zGLmKPj6pjFYJaO", qty: 2, source: "central", createdAt: "2026-09-23T12:00:41.714Z", passThrough: "disputed", forDests: ["marathon-pe"] } } },
});
const STREAK = () => ({ "marathon-pe": { [PID]: { M: { count: 4, by: "hub2", lastTs: "2026-09-17T14:15:22.516Z" } } } });

function world(over = {}) {
  const stock = over.stock || STOCK();
  const init = {
    stock,
    refill_requests: over.rr || RR(),
    refill_engine: { open: OPEN(), rejectStreak: over.streak || STREAK(), ...(over.cursor ? { refusalWriteoffCursor: over.cursor } : {}) },
    users: { u_mike: { displayName: "Mike" } },
    stock_movements: over.movements || {},
  };
  return makeFakeDb(init, over.hooks || {});
}

// One scan's worth: read what the scan reads, plan, apply, return the patched snapshot.
async function scan(db, { config = CONFIG, now = NOW } = {}) {
  const root = db.state.root;
  const snapshot = {
    nowMs: now, config, products: PRODUCTS,
    stock: structuredClone(root.stock || {}),
    refillRequests: structuredClone(root.refill_requests || {}),
    movements: Object.values(structuredClone(root.stock_movements || {})),
    rejectStreak: structuredClone(root.refill_engine?.rejectStreak || {}),
    cursors: structuredClone(root.refill_engine?.refusalWriteoffCursor || {}),
    windowStartMs: now - 45 * 864e5,
  };
  const plan = planRefusalWriteoffs(snapshot);
  const update = async (patch, label) => {
    const { safe } = sanitizeUpdate(patch);
    try { await db.ref().update(safe); return true; } catch (e) { return false; }
  };
  const res = await applyRefusalWriteoffs({ db, writeoffs: plan.writeoffs, snapshot, update, nowMs: now, runId: "r1" });
  return { plan, res, snapshot };
}

const read = async (db, p) => (await db.ref(p).once("value")).val();

test("the tracksuit: Hub 2's phantom 3 M is erased as ONE refusal_writeoff, with its evidence", async () => {
  const db = world();
  const { plan, res } = await scan(db);
  assert.equal(plan.writeoffs.length, 1);
  assert.equal(res.applied.length, 1);
  const w = res.applied[0];
  assert.equal(w.loc, "hub2");
  assert.equal(w.size, "M");
  assert.equal(w.qty, 3);
  assert.deepEqual(w.days, ["2026-09-12", "2026-09-14", "2026-09-16", "2026-09-17"]);
  assert.deepEqual(w.refusals.map((r) => r.rrId), ["-P1JjNWAVHbqAgZsMicE", "-P1P_Uph_VRRq1rRY0um", "-P1dRdW8q1m4MUiAReYo", "-P1irJ2tVlblPwBJTi-J"]);
  assert.ok(w.refusals.every((r) => r.dest === "marathon-pe"));

  assert.equal((await read(db, `stock/hub2/${PID}/M`)).qty, 0);
  const row = await read(db, `stock_movements/${w.id}`);
  assert.equal(row.type, "refusal_writeoff");
  assert.equal(row.from, "hub2");
  assert.equal(row.to, undefined, "a debit has no destination (RTDB stores no null)");
  assert.equal(row.qty, 3);
  assert.deepEqual(row.before, { hub2: 3 });
  assert.deepEqual(row.after, { hub2: 0 });
  assert.deepEqual(row.writeoff.refusalIds, w.refusals.map((r) => r.rrId));
  // The record, the cursor and the digest queue all landed.
  assert.equal((await read(db, `refill_engine/refusalWriteoffs/${w.id}`)).qty, 3);
  assert.equal((await read(db, `refill_engine/refusalWriteoffCursor/hub2/${PID}/M`)).id, w.id);
  assert.equal(await read(db, `refill_engine/refusalWriteoffDigestQueue/${w.id}`), NOW);
});

test("ONLY the one cell moves: Hub 2 L/XL/XXL, another product at Hub 2, Central, PE and the open #641 leg are unchanged", async () => {
  const db = world();
  const before = structuredClone(db.state.root);
  await scan(db);
  const after = db.state.root;
  for (const s of ["L", "XL", "XXL"]) assert.deepEqual(after.stock.hub2[PID][s], before.stock.hub2[PID][s], `hub2 ${s}`);
  assert.deepEqual(after.stock.hub2[OTHER], before.stock.hub2[OTHER]);
  assert.deepEqual(after.stock.central, before.stock.central);
  assert.deepEqual(after.stock["marathon-pe"], before.stock["marathon-pe"]);
  // The inbound 2 M from Central: the request and the lock are untouched.
  assert.deepEqual(after.refill_requests["-P2D7zGLmKPj6pjFYJaO"], before.refill_requests["-P2D7zGLmKPj6pjFYJaO"]);
  assert.deepEqual(after.refill_engine.open, before.refill_engine.open);
  // Every cell except hub2/PID/M is byte-identical.
  const flat = (st) => {
    const out = {};
    for (const [l, byP] of Object.entries(st || {})) for (const [p, byS] of Object.entries(byP || {})) for (const [s, c] of Object.entries(byS || {})) out[`${l}|${p}|${s}`] = JSON.stringify(c);
    return out;
  };
  const a = flat(before.stock), b = flat(after.stock);
  const changed = Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);
  assert.deepEqual(changed, [`hub2|${PID}|M`]);
});

test("the item leaves Recount Needed in the same scan, the #641 leg stays, and PE asks when the 2 land", async () => {
  const db = world();
  const { snapshot } = await scan(db);
  // Recount Needed is built from the streak and the cell — both settled.
  assert.equal(await read(db, `refill_engine/rejectStreak/marathon-pe/${PID}/M`), null);
  const base = { nowMs: NOW, config: CONFIG, targets: TARGETS, products: PRODUCTS, openIndex: OPEN(), orders: {}, retryState: {}, heldLines: {} };
  const plan = computeRefillPlan({ ...base, stock: snapshot.stock, refillRequests: snapshot.refillRequests, movements: snapshot.movements, rejectStreak: snapshot.rejectStreak });
  assert.ok(!plan.exceptions.recountNeeded.items.some((r) => r.pid === PID), "off Recount Needed");
  // The pass-through lock is not closed or shrunk: PE still needs its 2.
  assert.ok(!plan.closes.some((c) => c.dest === "hub2" && c.pid === PID));
  assert.ok(!plan.resizes.some((r) => r.dest === "hub2" && r.pid === PID));
  // No card for Hub 2's staff for the size they said is not there.
  assert.ok(!plan.intents.some((i) => i.source === "hub2" && i.productId === PID && i.sizeKey === "M"));

  // The 2 M land at Hub 2 (the lock closes as fulfilled) → next scan, PE's leg fires.
  const stock2 = structuredClone(snapshot.stock);
  stock2.hub2[PID].M.qty = 2;
  const rr2 = { ...snapshot.refillRequests, "-P2D7zGLmKPj6pjFYJaO": { ...snapshot.refillRequests["-P2D7zGLmKPj6pjFYJaO"], status: "fulfilled", resolvedAt: "2026-09-23T15:00:00.000Z" } };
  const mv2 = [...snapshot.movements, { type: "transfer_in", productId: PID, size: "M", qty: 2, from: "central", to: "hub2", ts: "2026-09-23T15:00:00.000Z", after: { hub2: 2 } }];
  const plan2 = computeRefillPlan({ ...base, nowMs: NOW + 3 * 3600e3, openIndex: {}, stock: stock2, refillRequests: rr2, movements: mv2, rejectStreak: snapshot.rejectStreak });
  const pe = plan2.intents.find((i) => i.dest === "marathon-pe" && i.productId === PID && i.sizeKey === "M");
  assert.ok(pe, "PE's request fires once the 2 M land");
  assert.equal(pe.source, "hub2");
  assert.equal(pe.qty, 2);
});

test("idempotent: the next scan plans nothing and moves nothing — one run is written off once", async () => {
  const db = world();
  await scan(db);
  const once = structuredClone(db.state.root);
  const { plan, res } = await scan(db, { now: NOW + 3600e3 });
  assert.equal(plan.writeoffs.length, 0);
  assert.equal(res.applied.length, 0);
  assert.deepEqual(db.state.root.stock, once.stock);
  assert.equal(Object.values(db.state.root.stock_movements).filter((m) => m.type === "refusal_writeoff").length, 1);
});

test("a scan that dies after the cell but before the record is repaired next scan — no second debit", async () => {
  const db = world();
  const snapshot1 = { nowMs: NOW, config: CONFIG, products: PRODUCTS, stock: structuredClone(db.state.root.stock), refillRequests: RR(), movements: [], rejectStreak: STREAK(), cursors: {}, windowStartMs: WINDOW_START };
  const plan = planRefusalWriteoffs(snapshot1);
  // The record/cursor write fails.
  const r1 = await applyRefusalWriteoffs({ db, writeoffs: plan.writeoffs, snapshot: snapshot1, update: async () => false, nowMs: NOW, runId: "r1" });
  assert.equal(r1.applied.length, 0);
  assert.equal((await read(db, `stock/hub2/${PID}/M`)).qty, 0);
  assert.equal(await read(db, "refill_engine/refusalWriteoffCursor"), null);
  const { plan: p2, res } = await scan(db, { now: NOW + 3600e3 });
  assert.equal(p2.writeoffs.length, 1);
  assert.equal(p2.writeoffs[0].repair, true);
  assert.equal(res.applied.length, 1);
  assert.equal(res.applied[0].qty, 3, "qty read back from the ledger");
  assert.equal(res.units, 0, "a repair debits nothing");
  assert.equal((await read(db, `stock/hub2/${PID}/M`)).qty, 0);
  assert.equal(Object.values(db.state.root.stock_movements).filter((m) => m.type === "refusal_writeoff").length, 1);
  assert.ok(await read(db, `refill_engine/refusalWriteoffs/${plan.writeoffs[0].id}`));
});

test("stock that arrived after the refusals is never erased: the #641 2 M already received at Hub 2", async () => {
  const stock = STOCK();
  stock.hub2[PID].M = cell(5, { updatedAt: "2026-09-23T13:00:00.000Z" });
  const movements = {
    arr: { type: "transfer_in", productId: PID, size: "M", qty: 2, from: "central", to: "hub2", ts: "2026-09-23T13:00:00.000Z", before: { central: 38, hub2: 3 }, after: { central: 36, hub2: 5 } },
  };
  const rr = RR();
  rr["-P2D7zGLmKPj6pjFYJaO"].status = "fulfilled";   // Central's leg to Hub 2 — Central's fulfilment, not Hub 2's
  const db = world({ stock, movements });
  const { res } = await scan(db);
  assert.equal(res.applied.length, 1);
  assert.equal(res.applied[0].qty, 3);
  assert.equal((await read(db, `stock/hub2/${PID}/M`)).qty, 2, "the 2 that arrived stay");
});

test("the pre-refusal bound: a sale in between never lets more than was on paper be erased", async () => {
  // Paper 3 at the first refusal; +2 arrived, then 2 sold → today 3. Arrivals
  // protect 2 → at most 1 goes (min(3−2, 3)).
  const stock = STOCK();
  stock.hub2[PID].M = cell(3, { updatedAt: "2026-09-20T10:00:00.000Z" });
  const movements = {
    a: { type: "transfer_in", productId: PID, size: "M", qty: 2, from: "central", to: "hub2", ts: "2026-09-13T10:00:00.000Z", before: { hub2: 3 }, after: { hub2: 5 } },
    b: { type: "sold", productId: PID, size: "M", qty: 2, from: "hub2", ts: "2026-09-20T10:00:00.000Z", before: { hub2: 5 }, after: { hub2: 3 } },
  };
  const db = world({ stock, movements });
  const { res } = await scan(db);
  assert.equal(res.applied[0].qty, 1);
  assert.equal((await read(db, `stock/hub2/${PID}/M`)).qty, 2);

  // Paper 3 at the first refusal, then 2 sold → today 1: the whole 1 goes, never more.
  const stock2 = STOCK();
  stock2.hub2[PID].M = cell(1, { updatedAt: "2026-09-20T10:00:00.000Z" });
  const db2 = world({ stock: stock2, movements: { b: { type: "sold", productId: PID, size: "M", qty: 2, from: "hub2", ts: "2026-09-13T10:00:00.000Z", before: { hub2: 3 }, after: { hub2: 1 } } } });
  const { res: r2 } = await scan(db2);
  assert.equal(r2.applied[0].qty, 1);
  assert.equal((await read(db2, `stock/hub2/${PID}/M`)).qty, 0);
});

test("four refusals on only THREE different days is not enough (same SAST day counts once)", async () => {
  const rr = RR();
  // Move the 14 Sep refusal onto 12 Sep SAST (21:59 UTC on the 11th is 23:59 SAST on the 11th — use the 12th).
  rr["-P1P_Uph_VRRq1rRY0um"].resolvedAt = "2026-09-12T20:00:00.000Z";   // 22:00 SAST, 12 Sep
  const db = world({ rr });
  const { plan } = await scan(db);
  assert.equal(plan.writeoffs.length, 0);
  assert.equal((await read(db, `stock/hub2/${PID}/M`)).qty, 3);
});

test("the calendar day is Johannesburg's: 23:30 UTC is already the next day", () => {
  assert.equal(sastDay(Date.parse("2026-09-12T21:59:59.000Z")), "2026-09-12");
  assert.equal(sastDay(Date.parse("2026-09-12T22:00:00.000Z")), "2026-09-13");
});

test("a fulfilment of the size in between restarts the count", async () => {
  const rr = RR();
  rr.fulfilledMid = { ...refusal("2026-09-15T10:00:00.000Z"), status: "fulfilled" };
  const db = world({ rr });
  const { plan } = await scan(db);
  assert.equal(plan.writeoffs.length, 0);
  // A PARTIAL send (sentQty > 0) found some — it restarts the count too.
  const rr2 = RR();
  rr2.partial = refusal("2026-09-15T10:00:00.000Z", { sentQty: 1 });
  const { plan: p2 } = await scan(world({ rr: rr2 }));
  assert.equal(p2.writeoffs.length, 0);
});

test("the cell moved between plan and apply → nothing is erased (next scan re-plans)", async () => {
  const db = world({
    hooks: {
      // A return lands at Hub 2 M the moment the writer reads the cell — a
      // stale plan must not erase 3 from a count it never saw. (A sale in the
      // gap is also refused, by the writer's no-overdraw floor.)
      beforeRead: async (path, state) => {
        if (path === `stock/hub2/${PID}/M` && state.root.stock.hub2[PID].M.qty === 3) state.root.stock.hub2[PID].M.qty = 4;
      },
    },
  });
  const { res } = await scan(db);
  assert.equal(res.applied.length, 0);
  assert.equal(res.skipped[0].reason, "cell_changed");
  assert.equal((await read(db, `stock/hub2/${PID}/M`)).qty, 4);
  assert.equal(await read(db, "refill_engine/refusalWriteoffCursor"), null);
});

test("an open request against the location defers the write-off (someone may be picking it)", async () => {
  const rr = RR();
  rr.openAtHub2 = { ...refusal("2026-09-23T09:00:00.000Z"), status: "open", resolvedAt: null };
  const { plan } = await scan(world({ rr }));
  assert.equal(plan.writeoffs.length, 0);
  assert.equal(plan.deferred[0].reason, "request_open");
});

test("Central is covered too: Hub 2's leg refused by Central on four days erases Central's cell only", async () => {
  const rr = {};
  ["2026-09-01T09:00:00.000Z", "2026-09-03T09:00:00.000Z", "2026-09-05T09:00:00.000Z", "2026-09-08T09:00:00.000Z"].forEach((at, i) => {
    rr[`c${i}`] = { productId: PID, size: "XL", qty: 1, requestingLocation: "hub2", status: "cancelled", createdAt: at, resolvedAt: at,
      createdFrom: { engine: true, source: "central" }, rejectedBy: "admin", resolvedBy: "u_mike" };
  });
  const stock = STOCK();
  stock.central[PID].XL = cell(16, { updatedAt: "2026-08-17T10:35:03.044Z" });
  const db = world({ rr, stock, streak: { hub2: { [PID]: { XL: { count: 4, by: "central", lastTs: "2026-09-08T09:00:00.000Z" } } } } });
  const before = structuredClone(db.state.root.stock);
  const { res } = await scan(db);
  assert.equal(res.applied.length, 1);
  assert.equal(res.applied[0].loc, "central");
  assert.equal(res.applied[0].qty, 16);
  assert.deepEqual(res.applied[0].refusals.map((r) => r.byName), ["Mike", "Mike", "Mike", "Mike"]);
  assert.equal((await read(db, `stock/central/${PID}/XL`)).qty, 0);
  assert.deepEqual(db.state.root.stock.hub2, before.hub2);
  assert.deepEqual(db.state.root.stock.central[PID].M, before.central[PID].M);
  assert.equal(await read(db, `refill_engine/rejectStreak/hub2/${PID}/XL`), null, "Central's Recount Needed row is settled too");
});

test("Marathon Pine is excluded; a shop is never a refusing location; the kill switch stops it", async () => {
  const rrPine = {};
  REFUSED_AT.forEach((at, i) => { rrPine[`p${i}`] = refusal(at, { requestingLocation: "marathon-pine" }); });
  assert.equal((await scan(world({ rr: rrPine }))).plan.writeoffs.length, 0);

  const rrShop = {};
  REFUSED_AT.forEach((at, i) => { rrShop[`s${i}`] = refusal(at, { createdFrom: { engine: true, source: "marathon-pe" } }); });
  assert.equal((await scan(world({ rr: rrShop }))).plan.writeoffs.length, 0);

  const off = await scan(world(), { config: { ...CONFIG, refusalWriteoff: { enabled: false } } });
  assert.equal(off.plan.writeoffs.length, 0);
});

test("a run older than the ledger window: judged when the cell was untouched since, deferred when it was not", async () => {
  const rr = {};
  ["2026-07-20T09:00:00.000Z", "2026-07-22T09:00:00.000Z", "2026-07-24T09:00:00.000Z", "2026-07-27T09:00:00.000Z"].forEach((at, i) => { rr[`o${i}`] = refusal(at); });
  const untouched = STOCK();
  untouched.hub2[PID].M = cell(3, { updatedAt: "2026-07-14T12:17:22.608Z" });
  const a = await scan(world({ rr, stock: untouched }));
  assert.equal(a.res.applied.length, 1);
  assert.equal(a.res.applied[0].qty, 3);

  const touched = STOCK();
  touched.hub2[PID].M = cell(3, { updatedAt: "2026-07-30T09:00:00.000Z" });   // written after the first refusal, before the window
  const b = await scan(world({ rr, stock: touched }));
  assert.equal(b.plan.writeoffs.length, 0);
  assert.equal(b.plan.deferred[0].reason, "history_before_ledger_window");
});

test("the written-off cell stays inside the live /stock rule's lastType enum, so the next device sale validates", async () => {
  const db = world();
  await scan(db);
  const c = await read(db, `stock/hub2/${PID}/M`);
  assert.match(c.lastType, /^(received|opening|sold|transfer_in|transfer_out|adjustment|return)$/);
  assert.equal(c.qty, 0);
  assert.equal(c.relMv, undefined, "no in-flight stamp left behind");
});

test("an ARRAY-coerced /stock row (dense numeric sizes) is read and written at the right cell", async () => {
  const SNEAK = "p_sneak";
  const products = { ...PRODUCTS, [SNEAK]: { name: "Sneaker", productType: "footwear", sizes: ["0", "1", "2"] } };
  const stock = STOCK();
  stock.central[SNEAK] = [cell(1), cell(2), cell(7)];
  const rr = {};
  ["2026-09-01T09:00:00.000Z", "2026-09-03T09:00:00.000Z", "2026-09-05T09:00:00.000Z", "2026-09-08T09:00:00.000Z"].forEach((at, i) => {
    rr[`n${i}`] = { productId: SNEAK, size: "2", qty: 1, requestingLocation: "hub1", status: "cancelled", createdAt: at, resolvedAt: at, createdFrom: { engine: true, source: "central" } };
  });
  const db = world({ stock, rr });
  const root = db.state.root;
  const snapshot = { nowMs: NOW, config: CONFIG, products, stock: structuredClone(root.stock), refillRequests: rr, movements: [], rejectStreak: {}, cursors: {}, windowStartMs: WINDOW_START };
  const plan = planRefusalWriteoffs(snapshot);
  assert.equal(plan.writeoffs.length, 1);
  assert.equal(plan.writeoffs[0].qty, 7);
  const upd = async (patch) => { await db.ref().update(sanitizeUpdate(patch).safe); return true; };
  await applyRefusalWriteoffs({ db, writeoffs: plan.writeoffs, snapshot, update: upd, nowMs: NOW });
  assert.equal((await read(db, `stock/central/${SNEAK}/2`)).qty, 0);
  assert.equal((await read(db, `stock/central/${SNEAK}/1`)).qty, 2);
  assert.equal((await read(db, `stock/central/${SNEAK}/0`)).qty, 1);
});

// ── the engine's side: a write-off SETTLES the refusals it consumed ───────────
const writeoffRow = (loc, size, ts) => ({ type: "refusal_writeoff", productId: PID, size, qty: 3, from: loc, ts, before: { [loc]: 3 }, after: { [loc]: 0 } });
const planWith = (over) => computeRefillPlan({
  nowMs: NOW, config: CONFIG, targets: TARGETS, products: PRODUCTS, orders: {}, heldLines: {}, openIndex: {},
  stock: STOCK(), refillRequests: {}, movements: [], rejectStreak: {}, retryState: {}, ...over,
});

test("a shop resting out a 24h retry behind the refused size asks again the moment the hub's phantom is written off", () => {
  const stock = STOCK();
  stock.hub2[PID].M.qty = 0;
  const lastRej = "2026-09-23T09:00:00.000Z";
  const retryState = { "marathon-pe": { [PID]: { M: { retryCount: 4, lastRejectedAt: lastRej, firstRejectedAt: lastRej, nextRetryAt: "2026-09-24T09:00:00.000Z", source: "hub2" } } } };
  const refillRequests = { r: refusal(lastRej) };
  const parkedWithout = planWith({ stock, retryState, refillRequests });
  assert.ok(parkedWithout.exceptions.waitingForStock.items.some((r) => r.loc === "marathon-pe" && r.pid === PID && r.size === "M"), "control: without a write-off the shop waits");
  const lifted = planWith({ stock, retryState, refillRequests, movements: [writeoffRow("hub2", "M", "2026-09-23T10:00:00.000Z")] });
  assert.ok(!lifted.exceptions.waitingForStock.items.some((r) => r.loc === "marathon-pe" && r.pid === PID && r.size === "M"));
  // Hub 2 is empty, so the ask becomes a Central → Hub 2 leg — never a card for Hub 2's staff.
  assert.ok(!lifted.intents.some((i) => i.dest === "marathon-pe" && i.productId === PID && i.sizeKey === "M"));
  assert.ok(lifted.intents.some((i) => i.dest === "hub2" && i.source === "central" && i.productId === PID && i.sizeKey === "M"));
});

test("a write-off BEFORE the refusal does not lift it (only the refusals it consumed are settled)", () => {
  const stock = STOCK();
  stock.hub2[PID].M.qty = 0;
  const lastRej = "2026-09-23T09:00:00.000Z";
  const retryState = { "marathon-pe": { [PID]: { M: { retryCount: 1, lastRejectedAt: lastRej, firstRejectedAt: lastRej, nextRetryAt: "2026-09-24T09:00:00.000Z", source: "hub2" } } } };
  const plan = planWith({ stock, retryState, refillRequests: { r: refusal(lastRej) }, movements: [writeoffRow("hub2", "M", "2026-09-20T10:00:00.000Z")] });
  assert.ok(plan.exceptions.waitingForStock.items.some((r) => r.loc === "marathon-pe" && r.pid === PID && r.size === "M"));
});

test("#641's 'count disputed' Recount Needed row clears when the hub cell is written off", () => {
  const stock = STOCK();
  stock.hub2[PID].M.qty = 5;
  const landed = { productId: PID, size: "M", qty: 2, requestingLocation: "hub2", status: "fulfilled",
    createdAt: "2026-09-23T08:00:00.000Z", resolvedAt: "2026-09-23T09:00:00.000Z", forDests: ["marathon-pe"],
    createdFrom: { engine: true, source: "central", passThrough: "disputed", forDests: ["marathon-pe"] } };
  const withRow = planWith({ stock, refillRequests: { landed } });
  assert.ok(withRow.exceptions.recountNeeded.items.some((r) => r.countDisputed && r.pid === PID), "control: the disputed row is there");
  stock.hub2[PID].M.qty = 2;
  const cleared = planWith({ stock, refillRequests: { landed }, movements: [writeoffRow("hub2", "M", "2026-09-23T10:00:00.000Z")] });
  assert.ok(!cleared.exceptions.recountNeeded.items.some((r) => r.countDisputed && r.pid === PID));
});

test("a count that rose with NO arrival in the ledger is still capped at what was on paper when the refusals began", async () => {
  // The first movement after the first refusal says the cell held 3; today it
  // reads 6 with no arrival row to explain it (a direct write, a legacy tool).
  // Only the 3 that were on paper before the refusals can go.
  const stock = STOCK();
  stock.hub2[PID].M = cell(6, { updatedAt: "2026-09-20T10:00:00.000Z" });
  const movements = { s: { type: "sold", productId: PID, size: "M", qty: 1, from: "hub2", ts: "2026-09-13T10:00:00.000Z", before: { hub2: 3 }, after: { hub2: 2 } } };
  const db = world({ stock, movements });
  const { res } = await scan(db);
  assert.equal(res.applied[0].qty, 3);
  assert.equal((await read(db, `stock/hub2/${PID}/M`)).qty, 3);
});
