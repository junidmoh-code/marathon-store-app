// Terminal settings: the pure planner (lib/card-terminal-admin.cjs), the POS
// till list (lib/pos-tills.cjs), and the callable's handler end to end against
// an in-memory database that behaves like RTDB's transaction (null first).
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  planAdd, planEdit, planRetire, planReinstate, planReplace, readTypedTid, readMid,
} = require("../lib/card-terminal-admin.cjs");
const { posStores, TILLS_FALLBACK } = require("../lib/pos-tills.cjs");
const { tillMoveWarning, isRetiredTerminal } = require("../lib/card-terminals.cjs");
const { _handle, _assertOwner } = require("../cardRecon/cardTerminalAdmin.js");

const NOW = 1790000000000;
const stores = posStores({});
const TILL2 = { mid: "000000004977890", storeId: "pe", tillId: "till-2", label: "Marathon Till 2", activeFrom: 1 };

// ── the POS list ─────────────────────────────────────────────────────────────
test("the POS stores are pe / pine / trophy, by trading name, with their real tills", () => {
  assert.deepEqual(stores.map((s) => [s.storeId, s.label, s.tills.map((t) => t.tillId).join(",")]), [
    ["pe", "Marathon PE", "till-1,till-2,till-3"],
    ["pine", "Marathon Pine", "till-1"],
    ["trophy", "Trophy", "till-1,till-2"],
  ]);
  assert.ok(stores.every((s) => s.source === "pos-fallback"));
});

test("a seeded /pos/config/{store}/tills wins over the fallback, as it does in the POS", () => {
  const s = posStores({ pine: { a: { tillId: "till-1", name: "Till 1" }, b: { tillId: "till-2", name: "Till 2" } } });
  assert.deepEqual(s.find((x) => x.storeId === "pine").tills.map((t) => t.tillId), ["till-1", "till-2"]);
  assert.equal(s.find((x) => x.storeId === "pine").source, "pos-config");
});

test("the fallback is marathon-pos-app's TILLS_FALLBACK as of origin/main 908da4f (21 Sept 2026)", () => {
  // Pinned rather than read from a sibling checkout, which may be stale.
  assert.deepEqual(Object.fromEntries(Object.entries(TILLS_FALLBACK).map(([k, v]) => [k, v.map((t) => t.tillId)])),
    { pe: ["till-1", "till-2", "till-3"], pine: ["till-1"], trophy: ["till-1", "till-2"] });
});

// ── the TID ──────────────────────────────────────────────────────────────────
test("a typed TID is [A-Z0-9]{4,16}, uppercased, and never repaired", () => {
  assert.equal(readTypedTid(" 0000hp1x "), "0000HP1X");
  assert.equal(readTypedTid("67377843"), "67377843");
  for (const bad of ["", "abc", "0000-HP1X", "TID:0000HP1X", "A".repeat(17), null]) assert.equal(readTypedTid(bad), null, String(bad));
  assert.deepEqual(readMid(""), { ok: true, mid: null });
  assert.equal(readMid("0000 0000 4977 890").mid, "000000004977890");
  assert.equal(readMid("MID123").ok, false);
});

// ── add ──────────────────────────────────────────────────────────────────────
const addInput = { tid: "0000ab1c", storeId: "trophy", tillId: "till-2", label: " Trophy  Till 2 ", mid: "", capture: "photo" };

test("add: picked store and till, activeFrom stamped, uppercased TID", () => {
  const p = planAdd(addInput, null, { stores, now: NOW });
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.tid, "0000AB1C");
  assert.deepEqual(p.row, { storeId: "trophy", tillId: "till-2", label: "Trophy Till 2", capture: "photo", activeFrom: NOW });
});

test("add: refuses a TID already active, and a retired one points at reinstate", () => {
  assert.match(planAdd(addInput, TILL2, { stores, now: NOW }).reason, /already active/);
  assert.match(planAdd(addInput, { ...TILL2, retiredAt: 5 }, { stores, now: NOW }).reason, /Reinstate/);
});

test("add: the store and till must be the POS's — never free text", () => {
  assert.match(planAdd({ ...addInput, storeId: "marathon-pe" }, null, { stores, now: NOW }).reason, /not a POS store/);
  assert.match(planAdd({ ...addInput, storeId: "pine", tillId: "till-2" }, null, { stores, now: NOW }).reason, /no till "till-2"/);
  assert.match(planAdd({ ...addInput, capture: "fax" }, null, { stores, now: NOW }).reason, /Email, Photo or Both/);
  assert.match(planAdd({ ...addInput, label: "  " }, null, { stores, now: NOW }).reason, /label/);
});

// ── edit ─────────────────────────────────────────────────────────────────────
test("edit: moving tills stamps tillChangedAt, and tillMoveWarning then reads it", () => {
  const p = planEdit({ tid: "0000HP1X", storeId: "pe", tillId: "till-3", label: "Marathon Till 2", mid: TILL2.mid, capture: "both" }, TILL2, { stores, now: NOW });
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.row.tillChangedAt, NOW);
  assert.equal(p.row.activeFrom, 1, "unknown fields on the row are kept");
  assert.match(tillMoveWarning("0000HP1X", p.row, NOW - 1000), /spans the move/);
});

test("edit: a label-only change does NOT stamp tillChangedAt", () => {
  const p = planEdit({ tid: "0000HP1X", storeId: "pe", tillId: "till-2", label: "Till 2 (new name)", mid: TILL2.mid, capture: "both" }, TILL2, { stores, now: NOW });
  assert.equal(p.ok, true);
  assert.equal("tillChangedAt" in p.row, false);
});

test("edit: never changes store in place, never edits a retired row, refuses a no-op", () => {
  assert.match(planEdit({ tid: "0000HP1X", storeId: "trophy", tillId: "till-2", label: "x", capture: "both" }, TILL2, { stores, now: NOW }).reason, /never changes store/);
  assert.match(planEdit({ tid: "0000HP1X", storeId: "pe", tillId: "till-2", label: "x", capture: "both" }, { ...TILL2, retiredAt: 1 }, { stores, now: NOW }).reason, /retired/);
  assert.match(planEdit({ tid: "0000HP1X", storeId: "pe", tillId: "till-2", label: "Marathon Till 2", mid: TILL2.mid, capture: "both" }, { ...TILL2, capture: "both" }, { stores, now: NOW }).reason, /Nothing changed/);
  assert.match(planEdit({ tid: "NOPE1", storeId: "pe" }, null, { stores, now: NOW }).reason, /not registered/);
});

test("edit: clearing the MID removes it", () => {
  const p = planEdit({ tid: "0000HP1X", storeId: "pe", tillId: "till-2", label: "Marathon Till 2", mid: "", capture: "both" }, TILL2, { stores, now: NOW });
  assert.equal("mid" in p.row, false);
});

// ── retire / reinstate ───────────────────────────────────────────────────────
test("retire stamps retiredAt and keeps the row; reinstate lifts it", () => {
  const r = planRetire({ tid: "0000HP1X" }, TILL2, { now: NOW });
  assert.equal(r.row.retiredAt, NOW);
  assert.equal(r.row.label, TILL2.label);
  assert.equal(isRetiredTerminal(r.row), true);
  assert.match(planRetire({ tid: "0000HP1X" }, r.row, { now: NOW }).reason, /already retired/);
  const back = planReinstate({ tid: "0000HP1X" }, r.row);
  assert.equal(back.ok, true);
  assert.equal("retiredAt" in back.row, false);
});

// ── replace ──────────────────────────────────────────────────────────────────
test("replace: retires the old, adds the new on the same store and till, links both ways", () => {
  const p = planReplace({ oldTid: "0000HP1X", newTid: "0000cd2e", mid: "" }, TILL2, null, { stores, now: NOW });
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.oldRow.retiredAt, NOW);
  assert.equal(p.oldRow.replacedBy, "0000CD2E");
  assert.equal(p.oldRow.mid, TILL2.mid, "the old row is never overwritten, only stamped");
  assert.deepEqual(
    { s: p.newRow.storeId, t: p.newRow.tillId, l: p.newRow.label, r: p.newRow.replaces, a: p.newRow.activeFrom },
    { s: "pe", t: "till-2", l: "Marathon Till 2", r: "0000HP1X", a: NOW });
  assert.equal("mid" in p.newRow, false, "a new machine's MID is never carried over silently");
});

test("replace: refuses a new TID already registered, the same TID, or a retired old one", () => {
  assert.match(planReplace({ oldTid: "0000HP1X", newTid: "67377843" }, TILL2, { label: "Trophy Till 1" }, { stores, now: NOW }).reason, /already registered/);
  assert.match(planReplace({ oldTid: "0000HP1X", newTid: "0000hp1x" }, TILL2, null, { stores, now: NOW }).reason, /same as the old/);
  assert.match(planReplace({ oldTid: "0000HP1X", newTid: "0000CD2E" }, { ...TILL2, retiredAt: 1 }, null, { stores, now: NOW }).reason, /already retired/);
});

// ── THE CALLABLE, END TO END, AGAINST A FAKE RTDB ────────────────────────────
// Transactions call the update function with NULL first (nothing cached) and
// re-run with the real value when the server disagrees — the behaviour the
// handler's null-first handling exists for. Server timestamps resolve to NOW.
function fakeDb(initial, { beforeTxn } = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  const pushed = [];
  // A SERVER stamp and the caller's view of it DIFFER, as in the real SDK: a
  // transaction completes with the node resolved against the instance's local
  // clock estimate, never the value the server stored. The fake stores NOW and
  // hands the caller NOW - 250 — so nothing may compare the two.
  const resolve = (v, t = NOW) => {
    if (v && typeof v === "object" && v[".sv"] === "timestamp") return t;
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, t)]));
    return v;
  };
  const get = (p) => p.split("/").reduce((o, k) => (o == null ? undefined : o[k]), data) ?? null;
  const set = (p, v) => {
    const ks = p.split("/"); let o = data;
    for (const k of ks.slice(0, -1)) o = o[k] ??= {};
    if (v === null) delete o[ks.at(-1)]; else o[ks.at(-1)] = v;
  };
  return {
    data, pushed,
    ref: (p) => ({
      once: async () => ({ val: () => JSON.parse(JSON.stringify(get(p))) }),
      push: async (v) => { pushed.push(resolve(v)); },
      transaction: async (fn) => {
        if (beforeTxn) beforeTxn(p, { get, set });
        let out = fn(null);                          // null first, always
        const real = get(p);
        if (out === undefined) return { committed: false, snapshot: { val: () => real } };
        if (JSON.stringify(null) !== JSON.stringify(real)) {
          out = fn(JSON.parse(JSON.stringify(real))); // server disagreed: re-run
          if (out === undefined) return { committed: false, snapshot: { val: () => real } };
        }
        set(p, out === null ? null : resolve(out));
        const local = out === null ? null : resolve(out, NOW - 250);
        return { committed: true, snapshot: { val: () => local } };
      },
    }),
  };
}
const REQ = (data) => ({ data, auth: { uid: "owner", token: { email: "gunidmoh@gmail.com", email_verified: true } } });
const estate = () => ({ config: { cardTerminals: { "0000HP1X": { ...TILL2 } } }, card_batches: { pe: { "0000HP1X": { 509: { x: 1 } } } } });

test("only Junid's account may call it", () => {
  assert.throws(() => _assertOwner({ auth: { uid: "u", token: { email: "junidmoh@gmail.com" } } }), /Only Junid/);
  assert.throws(() => _assertOwner({}), /Only Junid/);
  assert.throws(() => _assertOwner({ auth: { uid: "x", token: { email: "gunidmoh@gmail.com", email_verified: false } } }), /Only Junid/,
    "an UNVERIFIED account carrying the owner's address is refused");
  assert.doesNotThrow(() => _assertOwner(REQ({})));
});

test("options returns the POS stores and tills", async () => {
  const out = await _handle(fakeDb(estate()), REQ({ action: "options" }));
  assert.deepEqual(out.stores.map((s) => s.storeId), ["pe", "pine", "trophy"]);
});

test("add → edit → replace, end to end: history keeps resolving and nothing is overwritten", async () => {
  const db = fakeDb(estate());
  const add = await _handle(db, REQ({ action: "add", terminal: addInput }));
  assert.equal(add.ok, true, add.reason);
  assert.equal(db.data.config.cardTerminals["0000AB1C"].activeFrom, NOW);

  const dup = await _handle(db, REQ({ action: "add", terminal: addInput }));
  assert.equal(dup.ok, false, "the null-first call must not let a duplicate through");
  assert.match(dup.reason, /already active/);

  const edit = await _handle(db, REQ({ action: "edit", terminal: { tid: "0000HP1X", storeId: "pe", tillId: "till-3", label: "Marathon Till 2", mid: TILL2.mid, capture: "email" } }));
  assert.equal(edit.ok, true, edit.reason);
  assert.equal(db.data.config.cardTerminals["0000HP1X"].tillChangedAt, NOW);
  assert.equal(db.data.config.cardTerminals["0000HP1X"].capture, "email");

  const rep = await _handle(db, REQ({ action: "replace", oldTid: "0000HP1X", terminal: { tid: "0000CD2E", mid: "000000004977890" } }));
  assert.equal(rep.ok, true, rep.reason);
  const reg = db.data.config.cardTerminals;
  assert.equal(reg["0000HP1X"].retiredAt, NOW);
  assert.equal(reg["0000HP1X"].replacedBy, "0000CD2E");
  assert.equal(reg["0000CD2E"].tillId, "till-3");
  assert.equal(reg["0000CD2E"].capture, "email");
  assert.equal(reg["0000CD2E"].replaces, "0000HP1X");
  assert.deepEqual(db.data.card_batches, estate().card_batches, "no batch record is touched");
  assert.deepEqual(db.pushed.map((a) => a.action), ["add", "edit", "replace"], "every write is audited");
});

test("replace refuses when the new TID is taken, and leaves both rows exactly as they were", async () => {
  const db = fakeDb(estate());
  await _handle(db, REQ({ action: "add", terminal: addInput }));
  const before = JSON.stringify(db.data.config);
  const rep = await _handle(db, REQ({ action: "replace", oldTid: "0000HP1X", terminal: { tid: "0000AB1C" } }));
  assert.equal(rep.ok, false);
  assert.equal(JSON.stringify(db.data.config), before);
});

test("an unknown TID cannot be edited or retired, and nothing is created by trying", async () => {
  const db = fakeDb(estate());
  for (const action of ["edit", "retire", "reinstate"]) {
    const out = await _handle(db, REQ({ action, terminal: { tid: "99999999", storeId: "pe", tillId: "till-1", label: "x", capture: "both" } }));
    assert.equal(out.ok, false, action);
  }
  assert.deepEqual(Object.keys(db.data.config.cardTerminals), ["0000HP1X"]);
});

test("replace: if the old row is retired mid-way, the new row is removed again and nothing changed", async () => {
  // Someone retires 0000HP1X between the replace's read and its retire step.
  const db = fakeDb(estate(), {
    beforeTxn: (p, { get, set }) => {
      if (p.endsWith("/0000HP1X") && !get(p).retiredAt) set(p, { ...get(p), retiredAt: 7 });
    },
  });
  const rep = await _handle(db, REQ({ action: "replace", oldTid: "0000HP1X", terminal: { tid: "0000CD2E" } }));
  assert.equal(rep.ok, false);
  assert.match(rep.reason, /new terminal was not added/);
  assert.equal(db.data.config.cardTerminals["0000CD2E"], undefined, "the half-made new row is rolled back");
  assert.equal(db.data.config.cardTerminals["0000HP1X"].retiredAt, 7, "the other writer's retirement stands");
  assert.equal(db.data.config.cardTerminals["0000HP1X"].replacedBy, undefined);
});

test("replace: a THROWN failure retiring the old row also rolls the new row back", async () => {
  const db = fakeDb(estate(), {
    beforeTxn: (p) => { if (p.endsWith("/0000HP1X")) throw new Error("network went away"); },
  });
  const rep = await _handle(db, REQ({ action: "replace", oldTid: "0000HP1X", terminal: { tid: "0000CD2E" } }));
  assert.equal(rep.ok, false);
  assert.match(rep.reason, /network went away.*not added/);
  assert.equal(db.data.config.cardTerminals["0000CD2E"], undefined);
  assert.equal(db.data.config.cardTerminals["0000HP1X"].retiredAt, undefined);
});

test("a REPLACED terminal cannot be reinstated — its till has a new owner", () => {
  const out = planReinstate({ tid: "0000HP1X" }, { ...TILL2, retiredAt: 5, replacedBy: "0000CD2E" });
  assert.equal(out.ok, false);
  assert.match(out.reason, /replaced by 0000CD2E/);
});
