// ─── The server-side writer is a MIRROR of applyMovement — differential fuzz ──
// functions/lib/admin-movement.cjs reproduces the client contract so the
// stranded-transit sweep and the repair script write exactly what a device
// would. Two copies of one rule drift; the only proof they have not is to run
// BOTH over the same random inputs and compare every observable — cell qty,
// cell v, the movement's before/after and negativeCleared, and the refusal
// reason. (feedback: differential-test the mirror, never each copy alone.)
//
// Inputs: random starting cells (negative, zero, positive, missing) at
// in_transit and a hub, random sequences of transfer_in (in_transit → hub) and
// ± adjustments, with and without allowNegative. Seeded, so a failure is
// reproducible from the printed seed.

import { describe, it, expect } from "vitest";
import { vi } from "vitest";
import { createRequire } from "node:module";
import { stockCellPath } from "../../utils/sizeKey";

// ── the client writer, on a tiny in-memory RTDB ──────────────────────────────
let store = {};
function getPath(path) {
  let node = store;
  for (const part of String(path).split("/")) { if (node == null || typeof node !== "object") return null; node = node[part]; }
  return node === undefined ? null : node;
}
function setPath(path, value) {
  const parts = String(path).split("/");
  let node = store;
  for (let i = 0; i < parts.length - 1; i++) { if (typeof node[parts[i]] !== "object" || node[parts[i]] === null) node[parts[i]] = {}; node = node[parts[i]]; }
  if (value === null) delete node[parts[parts.length - 1]]; else node[parts[parts.length - 1]] = value;
}
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: async (node) => ({ val: () => getPath(node.path), exists: () => getPath(node.path) != null }),
  update: async (node, updates) => { for (const [k, v] of Object.entries(updates)) setPath(node.path ? `${node.path}/${k}` : k, v); },
  push: () => ({ key: "never-used" }),
}));
vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "system:test" } } }));
const { applyMovement } = await import("./applyMovement.js");

// ── the server writer, on the functions fake RTDB ────────────────────────────
const require = createRequire(import.meta.url);
const { applyMovementAdmin } = require("../../../functions/lib/admin-movement.cjs");
const { makeFakeDb } = require("../../../functions/test/helpers/fake-rtdb.cjs");

// ── a seeded PRNG ────────────────────────────────────────────────────────────
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

const PID = "p1"; const SIZE = pick(rng(7), ["6", "5.5", "M"]);
const LOCS = ["in_transit", "hub1"];
const strip = (cell) => (cell ? { qty: cell.qty, v: cell.v, mv: cell.mv, lastType: cell.lastType } : null);

function randomMovement(r, i) {
  const kind = r();
  if (kind < 0.5) return { type: "transfer_in", productId: PID, size: SIZE, qty: 1 + Math.floor(r() * 3), from: "in_transit", to: "hub1", movementId: `m${i}`, reason: "stock_hold_release", allowNegative: r() < 0.2 };
  const positive = r() < 0.5;
  return { type: "adjustment", productId: PID, size: SIZE, qty: 1 + Math.floor(r() * 3), ...(positive ? { to: pick(r, LOCS), from: null } : { from: pick(r, LOCS), to: null }), movementId: `m${i}`, reason: "fuzz", allowNegative: r() < 0.3 };
}

async function runBoth(seed) {
  const r = rng(seed);
  const start = {};
  for (const loc of LOCS) {
    const q = pick(r, [null, -3, -1, 0, 1, 2, 5]);
    if (q !== null) start[loc] = { qty: q, v: Math.floor(r() * 5), mv: "seed", lastType: "received" };
  }
  // client
  store = {};
  for (const loc of LOCS) if (start[loc]) setPath(stockCellPath(loc, PID, SIZE), { ...start[loc] });
  // server
  const initial = { stock: {} };
  for (const loc of LOCS) if (start[loc]) initial.stock[loc] = { [PID]: { [stockCellPath(loc, PID, SIZE).split("/").pop()]: { ...start[loc] } } };
  const db = makeFakeDb(initial);

  const steps = 1 + Math.floor(r() * 6);
  const movements = Array.from({ length: steps }, (_, i) => randomMovement(r, i));
  // replay one id at random to exercise idempotency on both sides
  if (steps > 1 && r() < 0.5) movements.push({ ...movements[0] });

  const trace = [];
  for (const m of movements) {
    const nowIso = "2026-09-11T10:00:00.000Z";
    const c = await applyMovement({ ...m, actorRole: "admin" }, { maxRetries: 1 });
    const s = await applyMovementAdmin(db, { ...m, actor: "system:test", actorRole: "admin" }, { nowIso });
    trace.push({ m, c: { ok: c.ok, reason: c.reason || null, idempotent: !!c.idempotent }, s: { ok: s.ok, reason: s.reason || null, idempotent: !!s.idempotent } });
  }
  const client = { cells: {}, ledger: {} }, server = { cells: {}, ledger: {} };
  for (const loc of LOCS) {
    client.cells[loc] = strip(getPath(stockCellPath(loc, PID, SIZE)));
    server.cells[loc] = strip((await db.ref(stockCellPath(loc, PID, SIZE)).once("value")).val());
  }
  for (const [id, mv] of Object.entries(getPath("stock_movements") || {})) client.ledger[id] = { before: mv.before, after: mv.after, negativeCleared: mv.negativeCleared ?? null, type: mv.type, qty: mv.qty };
  for (const [id, mv] of Object.entries((await db.ref("stock_movements").once("value")).val() || {})) server.ledger[id] = { before: mv.before, after: mv.after, negativeCleared: mv.negativeCleared ?? null, type: mv.type, qty: mv.qty };
  return { start, trace, client, server };
}

describe("admin-movement.cjs mirrors applyMovement.js — differential fuzz", () => {
  it("2,000 seeded random sequences agree on every cell, every ledger row and every refusal", async () => {
    let clamped = 0, refused = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const { start, trace, client, server } = await runBoth(seed);
      const ctx = `seed ${seed} start ${JSON.stringify(start)} trace ${JSON.stringify(trace)}`;
      for (const t of trace) {
        expect(t.c.ok, ctx).toBe(t.s.ok);
        expect(t.c.reason, ctx).toBe(t.s.reason);
        expect(t.c.idempotent, ctx).toBe(t.s.idempotent);
        if (!t.c.ok) refused++;
      }
      expect(client.cells, ctx).toEqual(server.cells);
      expect(client.ledger, ctx).toEqual(server.ledger);
      for (const row of Object.values(client.ledger)) if (row.negativeCleared) clamped++;
    }
    // the fuzz must actually have exercised the interesting paths
    expect(clamped).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(50);
  }, 120000);
});
