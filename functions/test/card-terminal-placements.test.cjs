// Placements — where a terminal stood, and when (lib/card-terminal-placements.cjs)
// and the settings sheet's "Moved" action (planMove in lib/card-terminal-admin.cjs),
// exercised on the 5 Oct 2026 12:46 SAST swap of PE Till 1 ↔ Trophy Till 1.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { planMove, planEdit, MOVE_BACKDATE_MS } = require("../lib/card-terminal-admin.cjs");
const { placementAt, placementKey, terminalPlacements, tillAt, seedPlacement } = require("../lib/card-terminal-placements.cjs");
const { posStores } = require("../lib/pos-tills.cjs");
const { _handle } = require("../cardRecon/cardTerminalAdmin.js");

const SWAP = Date.parse("2026-10-05T10:46:00Z");
const NOW_MS = Date.parse("2026-10-05T11:30:00Z");
const NOW = { ".sv": "timestamp" };
const stores = posStores({});
const ctx = { stores, now: NOW, nowMs: NOW_MS, by: "uid-junid" };

// The live rows, 5 Oct 2026 before the swap.
const A = { activeFrom: 1789733243057, label: "Marathon Till 1", mid: "100000002453164", storeId: "pe", tillId: "till-1" };
const B = { label: "Trophy Till 1", mid: "100000002816030", storeId: "trophy", tillId: "till-1" };
const HP1X = { label: "Marathon Till 2", mid: "000000004977890", storeId: "pe", tillChangedAt: 1789733243057, tillId: "till-2" };

test("the swap, PE → Trophy: a placement at 12:46, the history seeded, the filing store untouched", () => {
  const p = planMove({ tid: "67325636", storeId: "trophy", tillId: "till-1", label: "Trophy Till 1", effectiveFrom: SWAP }, A, ctx);
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.row.storeId, "pe", "the filing key never moves");
  assert.equal(p.row.tillId, "till-1", "across stores the row's till stays the filing till");
  assert.equal(p.row.label, "Trophy Till 1", "the capture card names where it stands now");
  assert.equal(p.row.tillChangedAt, undefined, "a cross-store move stamps no same-store till move");
  assert.deepEqual(Object.keys(p.row.placements).sort(), [placementKey(A.activeFrom), placementKey(SWAP)].sort());
  assert.deepEqual(tillAt(p.row, SWAP - 1), { storeId: "pe", tillId: "till-1", label: "Marathon Till 1" });
  assert.deepEqual(tillAt(p.row, SWAP), { storeId: "trophy", tillId: "till-1", label: "Trophy Till 1" });
  assert.equal(p.row.placements[placementKey(SWAP)].setBy, "uid-junid");
  assert.deepEqual(p.from, { storeId: "pe", tillId: "till-1", label: "Marathon Till 1" });
});

test("the swap, Trophy → PE: a row with no activeFrom seeds from 0", () => {
  const p = planMove({ tid: "67377843", storeId: "pe", tillId: "till-1", label: "Marathon Till 1", effectiveFrom: SWAP }, B, ctx);
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.row.storeId, "trophy");
  assert.equal(placementAt(p.row, 0).storeId, "trophy");
  assert.equal(placementAt(p.row, SWAP).storeId, "pe");
  assert.equal(p.row.label, "Marathon Till 1");
});

test("the seed starts at the row's last till move, else its arrival, else 0", () => {
  assert.equal(seedPlacement(HP1X).effectiveFrom, 1789733243057);
  assert.equal(seedPlacement(A).effectiveFrom, A.activeFrom);
  assert.equal(seedPlacement(B).effectiveFrom, 0);
  assert.notEqual(Number.isInteger(Number(placementKey(0))), true, "a key RTDB would turn into an array index");
});

test("within the filing store, a move also moves the row's till and stamps tillChangedAt", () => {
  const p = planMove({ tid: "0000HP1X", storeId: "pe", tillId: "till-3", label: "Marathon Till 3", effectiveFrom: SWAP }, HP1X, ctx);
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.row.tillId, "till-3");
  assert.equal(p.row.tillChangedAt, SWAP);
});

test("a move is refused when it changes nothing, is in the future, is too old, predates arrival, or the place is not a POS till", () => {
  const m = (over, row = A) => planMove({ tid: "67325636", storeId: "trophy", tillId: "till-1", label: "Trophy Till 1", effectiveFrom: SWAP, ...over }, row, ctx);
  assert.match(m({ storeId: "pe" }).reason, /already on that till/);
  assert.match(m({ effectiveFrom: NOW_MS + 60 * 60 * 1000 }).reason, /future/);
  assert.match(m({ effectiveFrom: NOW_MS - MOVE_BACKDATE_MS - 1 }).reason, /more than a month/);
  assert.match(m({ effectiveFrom: A.activeFrom - 1 }).reason, /only arrived/);
  assert.match(m({ tillId: "till-9" }).reason, /no till "till-9"/);
  assert.match(m({ effectiveFrom: "soon" }).reason, /when the machine moved/);
  assert.match(m({}, { ...A, retiredAt: 5 }).reason, /retired/);
  const once = m({});
  assert.match(m({ storeId: "pine" }, once.row).reason, /already has a move at exactly that time/);
});

test("a move back-dated before a later one leaves NOW's till and label where the later move put them", () => {
  const first = planMove({ tid: "67325636", storeId: "trophy", tillId: "till-1", label: "Trophy Till 1", effectiveFrom: SWAP }, A, ctx);
  const earlier = planMove({ tid: "67325636", storeId: "pine", tillId: "till-1", label: "Pine Till 1", effectiveFrom: SWAP - 3600e3 }, first.row, ctx);
  assert.equal(earlier.ok, true, earlier.reason);
  assert.equal(earlier.row.label, "Trophy Till 1");
  assert.deepEqual(terminalPlacements(earlier.row).map((p) => p.storeId), ["pe", "pine", "trophy"]);
});

test("an in-place till edit on a row that keeps placements adds one, so the history stays true", () => {
  const moved = planMove({ tid: "0000HP1X", storeId: "pe", tillId: "till-3", label: "Marathon Till 3", effectiveFrom: SWAP }, HP1X, ctx).row;
  const e = planEdit({ tid: "0000HP1X", storeId: "pe", tillId: "till-1", label: "Marathon Till 1", mid: HP1X.mid, capture: "both" }, moved, ctx);
  assert.equal(e.ok, true, e.reason);
  assert.equal(placementAt(e.row, NOW_MS).tillId, "till-1");
  // …and a row without placements is edited exactly as before.
  const legacy = planEdit({ tid: "0000HP1X", storeId: "pe", tillId: "till-3", label: "Marathon Till 2", mid: HP1X.mid, capture: "both" }, HP1X, ctx);
  assert.equal(legacy.row.placements, undefined);
});

// ── the callable, end to end against an in-memory RTDB (null-first transactions) ──
function fakeDb(data) {
  const at = (path) => path.split("/").filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), data);
  const put = (path, v) => {
    const ks = path.split("/").filter(Boolean); let o = data;
    for (const k of ks.slice(0, -1)) o = o[k] ??= {};
    if (v === null) delete o[ks.at(-1)]; else o[ks.at(-1)] = v;
  };
  const resolve = (v) => JSON.parse(JSON.stringify(v ?? null), (k, x) => (x && x[".sv"] === "timestamp" ? NOW_MS : x));
  return {
    data,
    ref: (path) => ({
      once: async () => ({ val: () => structuredClone(at(path) ?? null) }),
      push: async (v) => { put(`${path}/k${Math.random().toString(36).slice(2)}`, resolve(v)); },
      transaction: async (fn) => {
        let first = fn(null);
        let out = first === undefined ? undefined : fn(structuredClone(at(path) ?? null));
        if (out === undefined) return { committed: false, snapshot: { val: () => at(path) ?? null } };
        put(path, resolve(out));
        return { committed: true, snapshot: { val: () => structuredClone(at(path) ?? null) } };
      },
    }),
  };
}

test("cardTerminalAdmin move: Junid enters a swap from the screen, and it lands as placements", async () => {
  const db = fakeDb({ config: { cardTerminals: { "67325636": structuredClone(A) } }, pos: { config: {} } });
  const res = await _handle(db, { auth: { uid: "uid-junid", token: { email: "gunidmoh@gmail.com", email_verified: true } },
    data: { action: "move", terminal: { tid: "67325636", storeId: "trophy", tillId: "till-1", label: "Trophy Till 1", effectiveFrom: SWAP } } });
  assert.equal(res.ok, true, res.reason);
  const row = db.data.config.cardTerminals["67325636"];
  assert.equal(row.storeId, "pe");
  assert.equal(placementAt(row, SWAP).storeId, "trophy");
  assert.equal(typeof row.placements[placementKey(SWAP)].setAt, "number");
  assert.equal(Object.values(db.data.card_terminal_audit).length, 1);
});
