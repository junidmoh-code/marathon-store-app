// ─── releaseShipment — never success-with-no-move ────────────────────────────
// Two lines of the 4 Sep Hub 2 shipment are archived as released with NO
// release movement in the ledger and their units still parked in in_transit
// (FULFIL-CREDIT-GAP.md). Whatever produced that, the archive must only ever
// be written on the strength of a ledger row that is actually there. Here the
// movement writer is faked to REPORT success without writing the row — the
// exact shape that state implies — and the release must refuse to archive.
//
// Mutation-proved in scripts/mutation-proof-fulfil-credit-gap.mjs.

import { describe, it, expect, beforeEach, vi } from "vitest";

let store = {};
const getPath = (p) => {
  let n = store;
  for (const part of String(p).split("/")) { if (n == null || typeof n !== "object") return null; n = n[part]; }
  return n === undefined ? null : n;
};
const setPath = (p, v) => {
  // Real RTDB deletes a null leaf AND every parent left empty — the fake must too.
  const parts = String(p).split("/");
  const walk = (node, depth) => {
    const key = parts[depth];
    if (depth === parts.length - 1) {
      if (v === null) delete node[key]; else node[key] = v;
    } else {
      if (typeof node[key] !== "object" || node[key] == null) node[key] = {};
      walk(node[key], depth + 1);
      if (Object.keys(node[key]).length === 0) delete node[key];
    }
  };
  walk(store, 0);
};

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: async (node) => ({ val: () => getPath(node.path), exists: () => getPath(node.path) != null }),
  update: async (node, updates) => { for (const [k, v] of Object.entries(updates)) setPath(node.path ? `${node.path}/${k}` : k, v); },
  runTransaction: async () => ({ committed: true }),
}));
vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "owner" } } }));

// The writer that lies: ok:true, no ledger row, no cell change.
let writeLedgerRow = true;
vi.mock("./applyMovement", () => ({
  applyMovement: vi.fn(async (m) => {
    if (writeLedgerRow) setPath(`stock_movements/${m.movementId}`, { type: m.type, to: m.to, from: m.from, qty: m.qty, productId: m.productId, size: m.size });
    return { ok: true, movementId: m.movementId };
  }),
}));

const { releaseShipment } = await import("./stockHoldStore.js");

const LINE = { productId: "nb9060", productName: "New balance 9060", size: "7", sizeKey: "7", qty: 1, dest: "hub2", shipmentId: "2026-09-04_1400", windowLabel: "14:00", refillId: "-P0aagkr9NqZbJgFACHK", movementId: "rrf_-P0aagkr9NqZbJgFACHK" };
const shipment = () => ({ shipmentId: "2026-09-04_1400", dest: "hub2", lines: [{ lineId: LINE.movementId, ...LINE }] });

beforeEach(() => {
  store = {};
  setPath(`settings/stockHold/held/hub2/${LINE.movementId}`, LINE);
  writeLedgerRow = true;
});

describe("releaseShipment archives only on a recorded movement", () => {
  it("with the row in the ledger: line archived, held line removed", async () => {
    const out = await releaseShipment({ dest: "hub2", shipment: shipment() });
    expect(out.released).toBe(1);
    expect(getPath(`settings/stockHold/held/hub2/${LINE.movementId}`)).toBeNull();
    expect(getPath(`settings/stockHold/released/hub2/2026-09-04_1400/${LINE.movementId}/releaseMovementId`)).toBe(`rel_${LINE.movementId}`);
  });

  it("with NO row in the ledger: refuses the bookkeeping, the line stays held, the failure is visible", async () => {
    writeLedgerRow = false;
    const out = await releaseShipment({ dest: "hub2", shipment: shipment() });
    expect(out.released).toBe(0);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0].reason).toMatch(/not recorded/);
    expect(getPath(`settings/stockHold/held/hub2/${LINE.movementId}`)).not.toBeNull();   // still held
    expect(getPath("settings/stockHold/released")).toBeNull();                          // nothing archived
  });
});
