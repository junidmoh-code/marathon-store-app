// ─── SHELF CHECKS + THE SINGLE-PIECE WRITE-DOWN (Junid, 24 Nov 2026) ─────────
// functions/webShelf (the daily list and its answers) and functions/lib/
// web-writedown.cjs (a rejection writes a lone piece to zero and undoes itself).
// Run: cd functions && npm test
"use strict";
process.env.FIREBASE_DATABASE_EMULATOR_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || "127.0.0.1:9";

const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../webShelf/lib.cjs");
const { _runAnswer: runAnswer } = require("../webShelf/index.js");
const W = require("../lib/web-writedown.cjs");
const lib = require("../displayChecks/lib.cjs");
const { runComplete, _displayCheckAllowed } = require("../displayChecks/completeCheck.js");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

const NOW = Date.parse("2026-11-24T10:00:00.000Z");
const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString();
const cell = (qty, at = NOW - 40 * DAY, mv = "seed") => ({ qty, updatedAt: iso(at), mv, v: 1, lastType: "received" });
const root = (db) => db.state.root;
const moves = (db, type) => Object.entries(root(db).stock_movements || {}).filter(([, m]) => m.type === type);

// ── the write-down ───────────────────────────────────────────────────────────
const W1 = { pid: "p9", sizeKey: "M", size: "M", loc: "marathon-pe", kind: "shop_not_found", orderId: "5550001", orderNumber: 2301, line: 1, gen: 0, by: "u-nomusa", at: NOW };

test("write-down: exactly one piece on the shelf → zero, its own movement type, who / when / order on the row, and a row to undo it by", async () => {
  const db = makeFakeDb({ stock: { "marathon-pe": { p9: { M: cell(1) } } } });
  const r = await W.writeDownSingle(db, W1, { nowIso: iso(NOW) });
  assert.deepEqual({ ok: r.ok, wroteDown: r.wroteDown, movementId: r.movementId }, { ok: true, wroteDown: true, movementId: "web_nf_5550001_1_g0_marathon-pe" });
  const c = root(db).stock["marathon-pe"].p9.M;
  assert.equal(c.qty, 0);
  assert.equal(c.lastType, "adjustment"); // inside the live /stock rule's enum, so the next till sale on this cell validates
  assert.equal(c.updatedBy, "u-nomusa");
  const [[id, mv]] = moves(db, "web_not_found");
  assert.equal(id, r.movementId);
  assert.deepEqual({ from: mv.from, to: mv.to ?? null, qty: mv.qty, before: mv.before, after: mv.after, actor: mv.actor, orderId: mv.link.orderId }, { from: "marathon-pe", to: null, qty: 1, before: { "marathon-pe": 1 }, after: { "marathon-pe": 0 }, actor: "u-nomusa", orderId: "5550001" });
  assert.deepEqual(mv.web, { kind: "shop_not_found", orderId: "5550001", orderNumber: 2301, line: 1, by: "u-nomusa", rejectedAt: NOW });
  assert.match(mv.reason, /website pick not found #2301/);
  assert.deepEqual(root(db).online_writedowns.p9.M["marathon-pe"], { at: NOW, mvId: id, qty: 1, kind: "shop_not_found", size: "M", orderId: "5550001", orderNumber: 2301, line: 1, by: "u-nomusa" });
});

test("write-down: two or more, or none, on the shelf → the count is NOT changed and nothing is written", async () => {
  for (const qty of [2, 5, 0]) {
    const db = makeFakeDb({ stock: { "marathon-pe": { p9: { M: cell(qty) } } } });
    const r = await W.writeDownSingle(db, W1, { nowIso: iso(NOW) });
    assert.deepEqual({ ok: r.ok, wroteDown: r.wroteDown, qty: r.qty }, { ok: true, wroteDown: false, qty });
    assert.equal(root(db).stock["marathon-pe"].p9.M.qty, qty);
    assert.equal(root(db).stock_movements, undefined);
    assert.equal(root(db).online_writedowns, undefined);
  }
});

test("write-down: the shelf moved AFTER the rejection → left alone; a repeat of the same rejection writes nothing twice", async () => {
  const moved = makeFakeDb({ stock: { "marathon-pe": { p9: { M: cell(1, NOW + 1) } } } });
  assert.equal((await W.writeDownSingle(moved, W1, { nowIso: iso(NOW + 5) })).wroteDown, false);
  assert.equal(root(moved).stock["marathon-pe"].p9.M.qty, 1);

  const db = makeFakeDb({ stock: { "marathon-pe": { p9: { M: cell(1) } } } });
  await W.writeDownSingle(db, W1, { nowIso: iso(NOW) });
  // A delivery lands, then the SAME rejection is re-applied (a heal): the delivered piece must survive.
  root(db).stock["marathon-pe"].p9.M = { ...root(db).stock["marathon-pe"].p9.M, qty: 1, mv: "refill-1", updatedAt: iso(NOW + 60e3) };
  const again = await W.writeDownSingle(db, W1, { nowIso: iso(NOW + 120e3) });
  assert.equal(again.ok, true);
  assert.equal(root(db).stock["marathon-pe"].p9.M.qty, 1);
  assert.equal(moves(db, "web_not_found").length, 1);
});

test("write-down: a bad key, kind or time is refused before anything is read", async () => {
  const db = makeFakeDb({ stock: { "marathon-pe": { p9: { M: cell(1) } } } });
  for (const bad of [{ pid: "a/b" }, { sizeKey: "" }, { loc: "x.y" }, { kind: "because" }, { at: 0 }, { at: "soon" }]) {
    assert.equal((await W.writeDownSingle(db, { ...W1, ...bad }, { nowIso: iso(NOW) })).ok, false);
  }
  assert.equal(root(db).stock["marathon-pe"].p9.M.qty, 1);
});

test("restoreFound: puts the piece back as web_found, closes the row; a shelf a sale drove to -1 lands on ZERO, not +1", async () => {
  const db = makeFakeDb({ stock: { "marathon-pe": { p9: { M: cell(1) } } } });
  await W.writeDownSingle(db, W1, { nowIso: iso(NOW) });
  const r = await W.restoreFound(db, { pid: "p9", sizeKey: "M", loc: "marathon-pe", why: "found_on_check", by: "u-x" }, { nowIso: iso(NOW + 1) });
  assert.equal(r.restored, true);
  assert.equal(root(db).stock["marathon-pe"].p9.M.qty, 1);
  assert.equal(root(db).online_writedowns, undefined);
  const [[id, mv]] = moves(db, "web_found");
  assert.equal(id, "web_found_web_nf_5550001_1_g0_marathon-pe");
  assert.equal(mv.web.undoes, "web_nf_5550001_1_g0_marathon-pe");
  assert.match(mv.reason, /found after a website not-found #2301 \(found on check\)/);
  // Nothing to undo → nothing happens.
  assert.deepEqual(await W.restoreFound(db, { pid: "p9", sizeKey: "M", loc: "marathon-pe", why: "found_on_check" }, { nowIso: iso(NOW + 2) }), { ok: true, restored: false });

  const sold = makeFakeDb({ stock: { hub1: { s1: { 8: cell(1) } } } });
  await W.writeDownSingle(sold, { ...W1, pid: "s1", sizeKey: "8", size: "8", loc: "hub1", kind: "hub_out_of_stock" }, { nowIso: iso(NOW) });
  root(sold).stock.hub1.s1["8"] = { ...root(sold).stock.hub1.s1["8"], qty: -1, mv: "sale-1", lastType: "sold" };
  const out = await W.sweepWriteDowns(sold, { nowIso: iso(NOW + 9), nowMs: NOW + 9 });
  assert.deepEqual(out, { rows: 1, restored: 1, closed: 0 });
  assert.equal(root(sold).stock.hub1.s1["8"].qty, 0);
});

test("Found after a delivery already landed on the shelf adds NOTHING (the count is settled); the row just closes", async () => {
  const db = makeFakeDb({ stock: { trophy: { a: { M: cell(1) } } } });
  await W.writeDownSingle(db, { ...W1, pid: "a", loc: "trophy" }, { nowIso: iso(NOW) });
  root(db).stock.trophy.a.M = { ...root(db).stock.trophy.a.M, qty: 1, mv: "refill-7", lastType: "transfer_in" };
  const r = await W.restoreFound(db, { pid: "a", sizeKey: "M", loc: "trophy", why: "found_on_check" }, { nowIso: iso(NOW + 5) });
  assert.deepEqual({ ok: r.ok, restored: r.restored, settled: r.settled }, { ok: true, restored: false, settled: true });
  assert.equal(root(db).stock.trophy.a.M.qty, 1);
  assert.equal(moves(db, "web_found").length, 0);
  assert.equal(root(db).online_writedowns, undefined);
});

test("a heal of the same rejection after the row was closed does NOT bring the row back", async () => {
  const db = makeFakeDb({ stock: { trophy: { a: { M: cell(1) } } } });
  const w = { ...W1, pid: "a", loc: "trophy" };
  await W.writeDownSingle(db, w, { nowIso: iso(NOW) });
  await W.restoreFound(db, { pid: "a", sizeKey: "M", loc: "trophy", why: "found_on_check" }, { nowIso: iso(NOW + 1) });
  assert.equal(root(db).stock.trophy.a.M.qty, 1);
  const again = await W.writeDownSingle(db, w, { nowIso: iso(NOW + 2) });
  assert.equal(again.ok, true);
  assert.equal(root(db).online_writedowns, undefined);
  assert.equal(root(db).stock.trophy.a.M.qty, 1);
});

test("the reversal is pinned to the shelf it read: a movement landing in between adds nothing", async () => {
  const db = makeFakeDb({ stock: { hub1: { s1: { 8: cell(1) } } } });
  await W.writeDownSingle(db, { ...W1, pid: "s1", sizeKey: "8", size: "8", loc: "hub1", kind: "hub_out_of_stock" }, { nowIso: iso(NOW) });
  root(db).stock.hub1.s1["8"] = { ...root(db).stock.hub1.s1["8"], qty: -1, mv: "sale-1", lastType: "sold" };
  // Between restoreFound's read of the shelf and its write, a delivery lands (the fake's read hook simulates it).
  const realRef = db.ref.bind(db);
  let armed = true;
  db.ref = (p) => {
    const r = realRef(p);
    if (p === "stock_movements/web_found_web_nf_5550001_1_g0_hub1" && armed) { armed = false; root(db).stock.hub1.s1["8"] = { ...root(db).stock.hub1.s1["8"], qty: 2, mv: "refill-2", lastType: "transfer_in" }; }
    return r;
  };
  const r = await W.restoreFound(db, { pid: "s1", sizeKey: "8", loc: "hub1", why: "sold_or_picked" }, { nowIso: iso(NOW + 5) });
  assert.equal(r.restored, false);
  assert.equal(root(db).stock.hub1.s1["8"].qty, 2);
});

test("a Found given BEFORE the write-down (an old confirmation replayed) does not undo it; the sweep only undoes the row it judged", async () => {
  const db = makeFakeDb({ stock: { trophy: { a: { M: cell(1) } } } });
  await W.writeDownSingle(db, { ...W1, pid: "a", loc: "trophy" }, { nowIso: iso(NOW) });
  const early = await W.restoreFound(db, { pid: "a", sizeKey: "M", loc: "trophy", why: "found_on_check", at: NOW - 1 }, { nowIso: iso(NOW + 5) });
  assert.equal(early.restored, false);
  assert.equal(root(db).stock.trophy.a.M.qty, 0);
  const other = await W.restoreFound(db, { pid: "a", sizeKey: "M", loc: "trophy", why: "sold_or_picked", expectMvId: "web_nf_some_other" }, { nowIso: iso(NOW + 5) });
  assert.equal(other.restored, false);
  assert.ok(root(db).online_writedowns.a.M.trophy);
  const later = await W.restoreFound(db, { pid: "a", sizeKey: "M", loc: "trophy", why: "found_on_check", at: NOW + 1 }, { nowIso: iso(NOW + 5) });
  assert.equal(later.restored, true);
});

test("a recount that lands between judging the shelf and writing it down keeps the recount (same quantity, newer movement)", async () => {
  const db = makeFakeDb({ stock: { trophy: { a: { M: cell(1) } } } });
  const realRef = db.ref.bind(db);
  let armed = true;
  db.ref = (p) => {
    // The ledger look-up inside applyMovementAdmin comes after writeDownSingle judged the shelf: the recount lands here.
    if (armed && p === "stock/trophy/a/M") { const r = realRef(p); const tx = r.transaction.bind(r); r.transaction = (fn) => { if (armed) { armed = false; root(db).stock.trophy.a.M = { ...root(db).stock.trophy.a.M, qty: 1, mv: "recount-1" }; } return tx(fn); }; return r; }
    return realRef(p);
  };
  const res = await W.writeDownSingle(db, { ...W1, pid: "a", loc: "trophy" }, { nowIso: iso(NOW) });
  assert.deepEqual({ ok: res.ok, wroteDown: res.wroteDown }, { ok: true, wroteDown: false });
  assert.equal(root(db).stock.trophy.a.M.qty, 1);
  assert.equal(root(db).stock_movements, undefined);
});

test("the sweep: untouched → kept; moved without going below zero → closed with nothing added", async () => {
  const db = makeFakeDb({ stock: { hub1: { s1: { 8: cell(1) } }, hub2: { s1: { 8: cell(1) } } } });
  await W.writeDownSingle(db, { ...W1, pid: "s1", sizeKey: "8", size: "8", loc: "hub1", kind: "hub_out_of_stock" }, { nowIso: iso(NOW) });
  await W.writeDownSingle(db, { ...W1, pid: "s1", sizeKey: "8", size: "8", loc: "hub2", kind: "hub_out_of_stock" }, { nowIso: iso(NOW) });
  root(db).stock.hub2.s1["8"] = { ...root(db).stock.hub2.s1["8"], qty: 3, mv: "refill-9", lastType: "transfer_in" };
  assert.deepEqual(await W.sweepWriteDowns(db, { nowIso: iso(NOW + 9), nowMs: NOW + 9 }), { rows: 2, restored: 0, closed: 1 });
  assert.equal(root(db).stock.hub2.s1["8"].qty, 3);
  assert.equal(moves(db, "web_found").length, 0);
  assert.deepEqual(Object.keys(root(db).online_writedowns.s1["8"]), ["hub1"]);
});

// ── a shop's Not found, through the real completion ──────────────────────────
const KEY = "online__5550001__1";
const pick = (store, over = {}) => ({ checkId: "c1", productId: "p9", productName: "Boss Tee", size: "M", sizeKey: "M", status: "open", activatedAt: NOW - 600e3, activatedSaDate: "2026-11-24", createdAt: NOW - 600e3, kind: "online_pick", orderId: "5550001", orderNumber: 2301, lineIndex: 1, qty: 1, dedupeKey: KEY, ...over });
const orderAt = (store) => ({ orderNumber: 2301, status: "picking", lines: [{ pid: "p1", source: { status: "handed" } }, { pid: "p9", sizeKey: "M", size: "M", qty: 1, source: { status: "display", locationId: store, entryKey: `displayChecks_active/${store}/${KEY}` } }] });
const ACTOR = { uid: "u-nomusa", name: "Nomusa", email: "n@marathon.internal" };
const complete = (db, store, result) => runComplete(db, { store, key: KEY, checkId: "c1", result, actor: ACTOR, nowMs: NOW, websiteOnly: store === "central", storeName: store });

test("Not found on a shop's strip with ONE piece on the shelf: the line fails with its time, the shelf is written to zero", async () => {
  const db = makeFakeDb({ displayChecks_active: { "marathon-pe": { [KEY]: pick("marathon-pe") } }, online_orders: { 5550001: orderAt("marathon-pe") }, stock: { "marathon-pe": { p9: { M: cell(1) } } } });
  const r = await complete(db, "marathon-pe", "not_found");
  assert.equal(r.kind, "ok");
  assert.deepEqual({ status: root(db).online_orders["5550001"].lines[1].source.status, failedAt: root(db).online_orders["5550001"].lines[1].source.failedAt }, { status: "not_found", failedAt: NOW });
  assert.equal(root(db).stock["marathon-pe"].p9.M.qty, 0);
  assert.equal(moves(db, "web_not_found")[0][1].web.kind, "shop_not_found");
  assert.equal(root(db).online_writedowns.p9.M["marathon-pe"].orderNumber, 2301);
});

test("…with TWO on the shelf: the count stays, the shelf hold is written; with Junid's switch off no count is ever touched", async () => {
  const db = makeFakeDb({ displayChecks_active: { "marathon-pe": { [KEY]: pick("marathon-pe") } }, online_orders: { 5550001: orderAt("marathon-pe") }, stock: { "marathon-pe": { p9: { M: cell(2) } } } });
  await complete(db, "marathon-pe", "not_found");
  assert.equal(root(db).stock["marathon-pe"].p9.M.qty, 2);
  assert.equal(root(db).stock_movements, undefined);
  assert.equal(root(db).online_cell_holds.p9.M["marathon-pe"].kind, "shop_not_found");

  const off = makeFakeDb({ config: { onlineOrders: { writeDown: { off: true } } }, displayChecks_active: { "marathon-pe": { [KEY]: pick("marathon-pe") } }, online_orders: { 5550001: orderAt("marathon-pe") }, stock: { "marathon-pe": { p9: { M: cell(1) } } } });
  await complete(off, "marathon-pe", "not_found");
  assert.equal(root(off).stock["marathon-pe"].p9.M.qty, 1);
});

test("Handed over never touches a count", async () => {
  const db = makeFakeDb({ displayChecks_active: { "marathon-pe": { [KEY]: pick("marathon-pe") } }, online_orders: { 5550001: orderAt("marathon-pe") }, stock: { "marathon-pe": { p9: { M: cell(1) } } } });
  await complete(db, "marathon-pe", "handed");
  assert.equal(root(db).stock["marathon-pe"].p9.M.qty, 1);
  assert.equal(root(db).stock_movements, undefined);
});

// ── Central's strip ──────────────────────────────────────────────────────────
test("Central has a website strip (on unless switched off); a hub still has none", () => {
  assert.equal(lib.isWebsiteStripEnabled("central", null, null), true);
  assert.equal(lib.isWebsiteStripEnabled("central", null, { enabled: false }), false);
  assert.equal(lib.isWebsiteStripEnabled("hub2", null, null), false);
  assert.equal(lib.isWebsiteStripEnabled("nowhere", null, null), false);
});

test("who may answer Central's strip: whoever may work Source; a shop's strip still needs display_checks", () => {
  const allowed = (permissions, store) => _displayCheckAllowed({ email: "s@marathon.internal", emailVerified: false, userRec: { permissions }, store });
  assert.equal(allowed(["source"], "central"), true);
  assert.equal(allowed(["source"], "marathon-pe"), false);
  assert.equal(allowed(["display_checks"], "central"), false); // Central is not a shop
  assert.equal(allowed([], "central"), false);
});

test("Found at Central: the line is handed FROM Central (the pack deducts there); Not found with one piece writes Central's shelf to zero", async () => {
  const found = makeFakeDb({ displayChecks_active: { central: { [KEY]: pick("central") } }, online_orders: { 5550001: orderAt("central") }, stock: { central: { p9: { M: cell(4) } } } });
  assert.equal((await complete(found, "central", "handed")).kind, "ok");
  const src = root(found).online_orders["5550001"].lines[1].source;
  assert.deepEqual({ status: src.status, locationId: src.locationId, handedAt: src.handedAt }, { status: "handed", locationId: "central", handedAt: NOW });
  assert.equal(root(found).stock.central.p9.M.qty, 4); // nothing is deducted before the pack

  const none = makeFakeDb({ displayChecks_active: { central: { [KEY]: pick("central") } }, online_orders: { 5550001: orderAt("central") }, stock: { central: { p9: { M: cell(1) } } } });
  await complete(none, "central", "not_found");
  assert.equal(root(none).stock.central.p9.M.qty, 0);
  assert.equal(moves(none, "web_not_found")[0][1].web.kind, "central_not_found");
});

// ── the daily list (pure) ────────────────────────────────────────────────────
test("the settings: 20 a day, rechecked after 30 days, not selling after 21, and every shop's own tab OFF until Junid turns it on", () => {
  const shopsOff = { "marathon-pe": false, trophy: false, concrete: false, "marathon-pine": false };
  assert.deepEqual(L.configFrom(null), { on: true, perDay: 20, perDayAt: {}, recheckDays: 30, idleDays: 21, shops: shopsOff });
  // A place's own number.
  const own = L.configFrom({ perDay: 20, perDayAt: { hub2: 30, central: "lots", mars: 9 } });
  assert.deepEqual(own.perDayAt, { hub2: 30, central: 20 });
  assert.equal(L.perDayFor(own, "hub2"), 30);
  assert.equal(L.perDayFor(own, "hub1"), 20);
  assert.equal(L.configFrom({ perDay: 35 }).perDay, 35);
  assert.deepEqual(L.configFrom({ perDay: 0, off: true }).on, false);
  assert.equal(L.configFrom({ perDay: "many" }).perDay, 20);
  assert.equal(L.configFrom({ recheckDays: 7, idleDays: 28 }).recheckDays, 7);
  assert.equal(L.configFrom({ idleDays: 0 }).idleDays, 21);
  const c = L.configFrom({ shops: { trophy: { on: true }, concrete: { on: "yes" } } });
  assert.deepEqual(c.shops, { ...shopsOff, trophy: true });
  // Hubs and Central run whenever the routine is on; a shop only once switched on.
  assert.equal(L.placeOn(c, "hub2"), true);
  assert.equal(L.placeOn(c, "central"), true);
  assert.equal(L.placeOn(c, "trophy"), true);
  assert.equal(L.placeOn(c, "marathon-pe"), false);
  assert.equal(L.placeOn(L.configFrom({ off: true, shops: { trophy: { on: true } } }), "trophy"), false);
});

test("who may work a place's list: its own screen's permission", () => {
  const can = (perms, loc, isSuper = false) => L.shelfAccess({ isSuper, perms, loc });
  assert.equal(can(["display_checks"], "trophy"), true);
  assert.equal(can(["display_checks"], "hub1"), false);
  assert.equal(can(["warehouse"], "trophy"), false);
  assert.equal(can(["source"], "trophy"), false);
  assert.equal(can(["source"], "hub2"), false);
  assert.equal(can(["display_checks"], "central"), false);
  assert.equal(can(["warehouse"], "hub1"), true);
  assert.equal(can(["warehouse"], "central"), false);
  assert.equal(can(["source"], "central"), true);
  assert.equal(can([], "trophy", true), true);
  assert.equal(can(["display_checks"], "in_transit", true), false);
});

test("tonight's top-up: what is open rolls over; wrong-by-more first, then the oldest single pieces, up to the day's number", () => {
  const open = { a__M: { pid: "a", sizeKey: "M", shown: 1, why: "old_single" } };
  const more = [{ pid: "w2", sizeKey: "L", shown: 3, holdAt: NOW - DAY }, { pid: "w1", sizeKey: "L", shown: 2, holdAt: NOW - 5 * DAY }, { pid: "one", sizeKey: "L", shown: 1, holdAt: 1 }];
  const singles = [{ pid: "new", sizeKey: "S", at: NOW - 2 * DAY }, { pid: "old", sizeKey: "S", at: NOW - 200 * DAY }, { pid: "a", sizeKey: "M", at: NOW - 300 * DAY }, { pid: "mid", sizeKey: "S", at: NOW - 90 * DAY }];
  const plan = L.planTopUp({ open, more, singles, perDay: 4, nowMs: NOW, saDate: "2026-11-25" });
  assert.deepEqual(Object.keys(plan.add), ["w1__L", "w2__L", "old__S"]); // oldest hold first; a hold on a ONE-piece shelf is not "wrong by more"; "a" is already open
  assert.equal(plan.listed, 4);
  assert.deepEqual(plan.add.w1__L, { pid: "w1", sizeKey: "L", shown: 2, why: "wrong_by_more", holdAt: NOW - 5 * DAY, lastMoved: null, addedAt: NOW, addedDay: "2026-11-25" });
  assert.deepEqual(plan.add.old__S, { pid: "old", sizeKey: "S", shown: 1, why: "old_single", lastMoved: NOW - 200 * DAY, addedAt: NOW, addedDay: "2026-11-25" });
  // A full list takes nothing new.
  assert.deepEqual(L.planTopUp({ open, more, singles, perDay: 1, nowMs: NOW, saDate: "d" }), { add: {}, listed: 1 });
});

test("what an answer does", () => {
  const one = { pid: "a", sizeKey: "M", shown: 1, lastMoved: NOW - 40 * DAY };
  const three = { pid: "a", sizeKey: "M", shown: 3, lastMoved: NOW - 40 * DAY };
  const plan = (item, c, result, count) => L.answerPlan({ item, cell: c, result, count });
  assert.deepEqual(plan(one, cell(1), "found"), { kind: "touch", outcome: "found", target: 1 });
  assert.deepEqual(plan(one, cell(1), "not_found"), { kind: "write_down", outcome: "notFound", target: 0 });
  assert.deepEqual(plan(one, cell(1), "count", 0), { kind: "write_down", outcome: "notFound", target: 0 });
  assert.deepEqual(plan(one, cell(1), "count", 2), { kind: "adjust", delta: 1, outcome: "corrected", target: 2 });
  assert.deepEqual(plan(three, cell(3), "count", 3), { kind: "touch", outcome: "counted", target: 3 });
  assert.deepEqual(plan(three, cell(3), "count", 1), { kind: "adjust", delta: -2, outcome: "corrected", target: 1 });
  assert.deepEqual(plan(three, cell(3), "count", 0), { kind: "adjust", delta: -3, outcome: "corrected", target: 0 });
  // Several on the shelf: Found / Not found is not an answer — the number is.
  assert.deepEqual(plan(three, cell(3), "found"), { error: "pick_a_number" });
  assert.deepEqual(plan(three, cell(3), "not_found"), { error: "pick_a_number" });
  for (const bad of [-1, 1.5, 31, "x", "2", null, undefined, true]) assert.deepEqual(plan(three, cell(3), "count", bad), { error: "bad_count" });
  // The shelf changed since it was listed (a sale, a delivery): the item is stale, nothing is answered.
  assert.deepEqual(plan(one, cell(2), "found"), { error: "stale" });
  assert.deepEqual(plan(one, cell(1, NOW - DAY), "found"), { error: "stale" });
  assert.deepEqual(plan(null, cell(1), "found"), { error: "gone" });
  assert.deepEqual(plan(one, cell(1), "maybe"), { error: "bad_result" });
});

// ── the answers, written ─────────────────────────────────────────────────────
const listed = (loc, item, c, extra = {}) => makeFakeDb({ shelf_checks: { [loc]: { open: { [`${item.pid}__${item.sizeKey}`]: item } } }, stock: { [loc]: { [item.pid]: { [item.sizeKey]: c } } }, ...extra });
const answer = (db, loc, id, result, count) => runAnswer(db, { loc, id, result, count, uid: "u-staff", name: "Staff", nowMs: NOW });

test("Found on a single piece: the count stays, the shelf is stamped touched, a standing hold is lifted, the website is told", async () => {
  const item = { pid: "a", sizeKey: "M", shown: 1, why: "old_single", lastMoved: NOW - 40 * DAY };
  const db = listed("trophy", item, cell(1), { online_cell_holds: { a: { M: { trophy: { at: NOW - 3 * DAY, kind: "shop_not_found" } } } } });
  assert.deepEqual(await answer(db, "trophy", "a__M", "found"), { outcome: "found", unitsCorrected: 0 });
  const c = root(db).stock.trophy.a.M;
  assert.deepEqual({ qty: c.qty, updatedAt: c.updatedAt, checkedAt: c.checkedAt, checkedBy: c.checkedBy, mv: c.mv }, { qty: 1, updatedAt: iso(NOW), checkedAt: iso(NOW), checkedBy: "u-staff", mv: "seed" });
  assert.equal(root(db).stock_movements, undefined);
  assert.equal(root(db).online_cell_holds, undefined);
  assert.equal(root(db).shelf_checks.trophy.open, undefined);
  assert.deepEqual(root(db).shelf_checks.trophy.done["2026-11-24"].a__M, { result: "found", shown: 1, by: "u-staff", byName: "Staff", at: NOW, why: "old_single" });
  assert.equal(root(db).shelf_checks.trophy.days["2026-11-24"].found, 1);
  assert.ok(root(db).shopify_inventory_dirty.a); // the website is told
});

test("Not found on a single piece follows the write-down: zero, own movement, a row that undoes itself", async () => {
  const item = { pid: "a", sizeKey: "M", shown: 1, why: "old_single", lastMoved: NOW - 40 * DAY };
  const db = listed("trophy", item, cell(1));
  assert.deepEqual(await answer(db, "trophy", "a__M", "not_found"), { outcome: "notFound", unitsCorrected: 1 });
  assert.equal(root(db).stock.trophy.a.M.qty, 0);
  const [[id, mv]] = moves(db, "web_not_found");
  assert.equal(id, "web_nf_check_trophy_a__M_2026-11-24_trophy");
  assert.deepEqual({ kind: mv.web.kind, by: mv.web.by, actor: mv.actor }, { kind: "shelf_check_not_found", by: "u-staff", actor: "u-staff" });
  assert.equal(root(db).online_writedowns.a.M.trophy.kind, "shelf_check_not_found");
  assert.equal(root(db).shelf_checks.trophy.days["2026-11-24"].notFound, 1);
});

test("a shelf showing several: the number tapped becomes the count, as an adjustment that says so; the hold ends", async () => {
  const item = { pid: "w", sizeKey: "L", shown: 3, why: "wrong_by_more", lastMoved: NOW - 40 * DAY, holdAt: NOW - 2 * DAY };
  const db = listed("hub2", item, cell(3), { online_cell_holds: { w: { L: { hub2: { at: NOW - 2 * DAY, kind: "hub_out_of_stock" } } } } });
  assert.deepEqual(await answer(db, "hub2", "w__L", "count", 1), { outcome: "corrected", unitsCorrected: 2 });
  assert.equal(root(db).stock.hub2.w.L.qty, 1);
  const [[, mv]] = moves(db, "adjustment");
  assert.deepEqual({ from: mv.from, qty: mv.qty, reason: mv.reason, before: mv.before, after: mv.after }, { from: "hub2", qty: 2, reason: "shelf check: counted 1, the app showed 3", before: { hub2: 3 }, after: { hub2: 1 } });
  assert.equal(root(db).online_cell_holds, undefined);
  assert.deepEqual(root(db).shelf_checks.hub2.done["2026-11-24"].w__L, { result: "corrected", shown: 3, counted: 1, setTo: 1, units: 2, by: "u-staff", byName: "Staff", at: NOW, why: "wrong_by_more" });
  // When the shelf was settled (the recheck window) and the day's counters by source and units.
  assert.equal(root(db).shelf_checks.hub2.checked.w__L, NOW);
  assert.deepEqual(root(db).shelf_checks.hub2.days["2026-11-24"], { corrected: 1, units: 2, by: { wrong_by_more: 1 } });

  const up = listed("hub2", item, cell(3));
  await answer(up, "hub2", "w__L", "count", 5);
  assert.equal(root(up).stock.hub2.w.L.qty, 5);
  const same = listed("hub2", item, cell(3));
  assert.deepEqual(await answer(same, "hub2", "w__L", "count", 3), { outcome: "counted", unitsCorrected: 0 });
  assert.equal(root(same).stock_movements, undefined);
  assert.equal(root(same).stock.hub2.w.L.updatedAt, iso(NOW));
});

test("the shelf moved since it was listed: nothing is written to stock and the item leaves the list", async () => {
  const item = { pid: "a", sizeKey: "M", shown: 1, why: "old_single", lastMoved: NOW - 40 * DAY };
  const db = listed("trophy", item, cell(2, NOW - 60e3, "refill-1"));
  assert.deepEqual(await answer(db, "trophy", "a__M", "not_found"), { error: "stale" });
  assert.equal(root(db).stock.trophy.a.M.qty, 2);
  assert.equal(root(db).shelf_checks, undefined);
  assert.deepEqual(await answer(db, "trophy", "a__M", "found"), { error: "gone" });
});

test("a display check answered 'it is on display' puts a written-down piece back; any other answer, or nothing to undo, changes nothing", async () => {
  const { applyFoundOnCheck } = require("../displayChecks/onlineOrder.cjs");
  const rec = (over = {}) => ({ checkId: "d1", productId: "a", sizeKey: "M", status: "completed", result: "confirmed", completedBy: { uid: "u-staff" }, ...over });
  const db = makeFakeDb({ stock: { trophy: { a: { M: cell(1) } } } });
  await W.writeDownSingle(db, { ...W1, pid: "a", loc: "trophy" }, { nowIso: iso(NOW - 60e3) });
  await applyFoundOnCheck(db, "trophy", rec({ result: "no_stock" }));
  await applyFoundOnCheck(db, "marathon-pe", rec());
  await applyFoundOnCheck(db, "trophy", rec({ kind: "online_pick" }));
  assert.equal(root(db).stock.trophy.a.M.qty, 0);
  await applyFoundOnCheck(db, "trophy", rec());
  assert.equal(root(db).stock.trophy.a.M.qty, 1);
  assert.equal(moves(db, "web_found")[0][1].web.kind, "found_on_check");
  await applyFoundOnCheck(db, "trophy", rec());
  assert.equal(root(db).stock.trophy.a.M.qty, 1);
});

test("progress per place: by day, by week, found against corrected, units corrected, and today's list by source", () => {
  const p = L.progressOf({
    "2026-11-16": { found: 5, corrected: 1, units: 2 },
    "2026-11-23": { listed: 20, found: 12, notFound: 3, units: 3 },
    "2026-11-24": { listed: 20, found: 4, corrected: 2, counted: 1, units: 5, by: { web_reject: 2, not_selling: 5 } },
  }, { x: { why: "web_reject" }, y: { why: "not_selling" }, z: { why: "not_selling" } });
  assert.deepEqual(p.days[0], { day: "2026-11-24", listed: 20, checked: 7, found: 5, fixed: 2, notFound: 0, counted: 1, corrected: 2, units: 5, by: { web_reject: 2, not_selling: 5 }, added: {} });
  assert.deepEqual({ open: p.open, checked14: p.checked14, wrong14: p.wrong14 }, { open: 3, checked14: 28, wrong14: 6 });
  assert.deepEqual(p.openBySource, { web_reject: 1, not_selling: 2 });
  // Weeks start on Monday: 23 and 24 Nov are one week, 16 Nov the week before.
  assert.deepEqual(p.weeks, [{ week: "2026-11-23", checked: 22, found: 17, fixed: 5, units: 8 }, { week: "2026-11-16", checked: 6, found: 5, fixed: 1, units: 2 }]);
});

// ── THE DAILY ROUTINE (Junid, 24 Nov 2026 evening) ───────────────────────────
test("planDay: filled in order — website rejections, other rejections, wrong by more, not selling, old singles — oldest first, never past the day's number", () => {
  const c = (pid, why, at, extra = {}) => ({ pid, sizeKey: "M", why, shown: 2, at, ...extra });
  const candidates = [c("old1", "old_single", 10), c("idle1", "not_selling", 50), c("idle0", "not_selling", 20), c("more1", "wrong_by_more", 30), c("st1", "store_reject", 40, { src: "store_order_oos", ref: "hub2 order 187" }), c("web1", "web_reject", 60, { mvId: "web_nf_1" })];
  const p = L.planDay({ candidates, perDay: 4, nowMs: NOW, saDate: "2026-11-24" });
  assert.deepEqual(Object.keys(p.open), ["web1__M", "st1__M", "more1__M", "idle0__M"]);
  assert.deepEqual(p.bySource, { web_reject: 1, store_reject: 1, wrong_by_more: 1, not_selling: 1 });
  assert.deepEqual({ src: p.open.st1__M.src, ref: p.open.st1__M.ref, mvId: p.open.web1__M.mvId }, { src: "store_order_oos", ref: "hub2 order 187", mvId: "web_nf_1" });
});

test("planDay: unchecked items roll over; a new rejection can push a quieter rolled item back into the pool; nothing is ever listed twice", () => {
  const open = { "idle9__M": { pid: "idle9", sizeKey: "M", why: "not_selling", shown: 3, at: 5, addedDay: "2026-11-23", addedAt: NOW - DAY } };
  const p = L.planDay({ open, candidates: [{ pid: "st1", sizeKey: "M", why: "store_reject", shown: 2, at: 99 }, { pid: "idle9", sizeKey: "M", why: "not_selling", shown: 3, at: 5 }], perDay: 1, nowMs: NOW, saDate: "2026-11-24" });
  assert.deepEqual(Object.keys(p.open), ["st1__M"]);
  assert.deepEqual(p.dropped, ["idle9__M"]);
  const q = L.planDay({ open, candidates: [{ pid: "idle9", sizeKey: "M", why: "not_selling", shown: 3, at: 5 }], perDay: 5, nowMs: NOW, saDate: "2026-11-24" });
  assert.deepEqual(Object.keys(q.open), ["idle9__M"]);
  assert.equal(q.open.idle9__M.addedDay, "2026-11-23"); // a rolled item keeps the day it was first listed
  assert.deepEqual(q.added, []);
  // A rolled item seen again from a stronger source takes the stronger reason.
  const r = L.planDay({ open, candidates: [{ pid: "idle9", sizeKey: "M", why: "store_reject", shown: 3, at: 70, src: "refill_refused" }], perDay: 5, nowMs: NOW, saDate: "2026-11-24" });
  assert.equal(r.open.idle9__M.why, "store_reject");
});

test("planDay: a shelf settled within the recheck window is not asked again unless a NEW rejection arrived; stock on the way keeps it off", () => {
  const checked = { "a__M": NOW - 10 * DAY, "b__M": NOW - 10 * DAY, "c__M": NOW - 40 * DAY };
  const candidates = [
    { pid: "a", sizeKey: "M", why: "old_single", shown: 1, at: 1 },                 // checked 10 days ago: left off
    { pid: "b", sizeKey: "M", why: "store_reject", shown: 2, at: NOW - DAY },       // a rejection since the check: back on
    { pid: "c", sizeKey: "M", why: "not_selling", shown: 2, at: 2 },               // checked 40 days ago: due again
    { pid: "d", sizeKey: "M", why: "web_reject", shown: 1, at: NOW - 2 * DAY },     // stock on the way: left off
    { pid: "e", sizeKey: "M", why: "wrong_by_more", shown: 3, at: NOW - 20 * DAY - 1 }, // a rejection a check has settled since: left off
  ];
  const p = L.planDay({ candidates, checked: { ...checked, "e__M": NOW - 20 * DAY }, onTheWay: (id) => (id === "d__M" ? 1 : 0), perDay: 20, recheckDays: 30, nowMs: NOW, saDate: "2026-11-24" });
  assert.deepEqual(Object.keys(p.open).sort(), ["b__M", "c__M"]);
  assert.deepEqual(p.skipped, { recent: 2, travelling: 1 });
  // A recheck window of 0 asks again at once.
  assert.equal(Object.keys(L.planDay({ candidates: candidates.slice(0, 1), checked, recheckDays: 0, nowMs: NOW, saDate: "x" }).open).length, 1);
});

test("a website write-down on the list: Found puts the piece back (only that write-down); Not found confirms it and changes nothing", async () => {
  const db = makeFakeDb({ stock: { "marathon-pe": { p9: { M: cell(1) } } } });
  const w = await W.writeDownSingle(db, { pid: "p9", sizeKey: "M", size: "M", loc: "marathon-pe", kind: "hub_out_of_stock", orderId: "o1", orderNumber: 2400, line: 0, gen: 0, at: NOW }, { nowIso: iso(NOW) });
  assert.equal(w.wroteDown, true);
  const after = root(db).stock["marathon-pe"].p9.M;
  const item = { pid: "p9", sizeKey: "M", shown: 0, why: "web_reject", mvId: w.movementId, lastMoved: Date.parse(after.updatedAt), at: NOW, ref: "website order #2400" };
  await db.ref("shelf_checks/marathon-pe/open/p9__M").set(item);
  assert.deepEqual(await runAnswer(db, { loc: "marathon-pe", id: "p9__M", result: "found", uid: "u-z", name: "Zee", nowMs: NOW + 60e3 }), { outcome: "found", unitsCorrected: 1 });
  assert.equal(root(db).stock["marathon-pe"].p9.M.qty, 1);
  assert.equal(root(db).online_writedowns, undefined);
  // Not found on a second write-down: the count stays at zero, the row stays (a later sale can still prove it was there).
  const db2 = makeFakeDb({ stock: { "marathon-pe": { p9: { M: cell(1) } } } });
  const w2 = await W.writeDownSingle(db2, { pid: "p9", sizeKey: "M", size: "M", loc: "marathon-pe", kind: "hub_out_of_stock", orderId: "o2", orderNumber: 2401, line: 0, gen: 0, at: NOW }, { nowIso: iso(NOW) });
  const a2 = root(db2).stock["marathon-pe"].p9.M;
  await db2.ref("shelf_checks/marathon-pe/open/p9__M").set({ ...item, mvId: w2.movementId, lastMoved: Date.parse(a2.updatedAt) });
  assert.deepEqual(await runAnswer(db2, { loc: "marathon-pe", id: "p9__M", result: "not_found", uid: "u-z", name: "Zee", nowMs: NOW + 60e3 }), { outcome: "notFound", unitsCorrected: 0 });
  assert.equal(root(db2).stock["marathon-pe"].p9.M.qty, 0);
  assert.ok(root(db2).online_writedowns.p9.M["marathon-pe"]);
  assert.equal(root(db2).shelf_checks["marathon-pe"].done["2026-11-24"].p9__M.ref, "website order #2400");
});
