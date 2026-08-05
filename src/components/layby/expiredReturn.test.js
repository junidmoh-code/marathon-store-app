// ─── EXPIRED LAYBY RETURN — the two things that must not go wrong ────────────
//   1. the units are never added twice (double-tap / two clerks)
//   2. an unreadable parcel is REFUSED, never partially returned
// Plus the rule-forced detail that the movement is `received`, not `return` —
// warehouse stockRole cannot write `return`, so getting this wrong would fail
// on every line in production while passing any test that only checked "a
// movement was made".

import { describe, it, expect, beforeEach, vi } from "vitest";

let store = {};
const getPath = (p) => {
  let n = store;
  for (const k of String(p).split("/")) { if (n == null || typeof n !== "object") return null; n = n[k]; }
  return n === undefined ? null : n;
};
const setPath = (p, v) => {
  const parts = String(p).split("/"); let n = store;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof n[parts[i]] !== "object" || n[parts[i]] === null) n[parts[i]] = {};
    n = n[parts[i]];
  }
  if (v === null) delete n[parts[parts.length - 1]]; else n[parts[parts.length - 1]] = v;
};

let raceDuringClaim = null;

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: async (node) => ({ val: () => getPath(node.path) }),
  update: async (node, updates) => {
    for (const [k, v] of Object.entries(updates)) setPath(node.path ? `${node.path}/${k}` : k, v);
  },
  runTransaction: async (node, fn) => {
    for (let i = 0; i < 5; i++) {
      const cur = getPath(node.path);
      const next = fn(cur);
      if (raceDuringClaim) { const w = raceDuringClaim; raceDuringClaim = null; w(); }
      const now = getPath(node.path);
      if (JSON.stringify(now) !== JSON.stringify(cur)) continue;
      if (next === undefined) return { committed: false, snapshot: { val: () => cur } };
      setPath(node.path, next);
      return { committed: true, snapshot: { val: () => next } };
    }
    return { committed: false, snapshot: { val: () => getPath(node.path) } };
  },
}));
vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "clerk-1" } } }));

const applyMovementMock = vi.fn(async () => ({ ok: true, movementId: `mv${++mvN}` }));
let mvN = 0;
vi.mock("../stock/applyMovement", () => ({ applyMovement: (...a) => applyMovementMock(...a) }));

const { returnExpiredLaybyToStock, loadLaybyLines, returnDestFor } = await import("./expiredReturn.js");
const { LAYBY_STATUS } = await import("./contract.js");

const LAYBY = { laybyId: "lb1", saleId: "s1", invoiceNo: "L-00045", status: "storedAtHub", dueDate: "2026-01-01", storageHub: "hub1" };
const PINE  = { ...LAYBY, laybyId: "lb9", storageHub: "hub3" };
const seedSale = (lines) => setPath("pos/sales/s1/lineItems", lines);
const GOOD = [
  { productId: "p1", size: "L", qty: 2, name: "Tracksuit" },
  { productId: "p2", size: "_", qty: 1, name: "Perfume" },
];

beforeEach(() => { store = {}; mvN = 0; raceDuringClaim = null; applyMovementMock.mockClear(); applyMovementMock.mockImplementation(async () => ({ ok: true, movementId: `mv${++mvN}` })); });

describe("the units go back exactly once", () => {
  it("moves every line into hub 1 and marks the layby terminal", async () => {
    seedSale(GOOD);
    const res = await returnExpiredLaybyToStock(LAYBY, { actorRole: "warehouse", hubLabel: "Hub 1" });

    expect(res.ok).toBe(true);
    expect(res.lines).toBe(2);
    expect(res.units).toBe(3);
    expect(applyMovementMock).toHaveBeenCalledTimes(2);
    expect(getPath("laybys/lb1/status")).toBe(LAYBY_STATUS.EXPIRED_RETURNED);
    expect(getPath("laybys/lb1/expiredReturnMovements")).toHaveLength(2);
  });

  it("writes `received` into hub1 — NOT `return`, which warehouse role cannot write", async () => {
    seedSale(GOOD);
    await returnExpiredLaybyToStock(LAYBY, { actorRole: "warehouse" });
    for (const [mv] of applyMovementMock.mock.calls) {
      expect(mv.type).toBe("received");
      expect(mv.to).toBe("hub1");
      expect(mv.reason).toBe("layby_expired_return");
      expect(mv.link.laybyId).toBe("lb1");
    }
  });

  it("REFUSES a second return — the claim is already held", async () => {
    seedSale(GOOD);
    await returnExpiredLaybyToStock(LAYBY, { actorRole: "warehouse", hubLabel: "Hub 1" });
    applyMovementMock.mockClear();

    const again = await returnExpiredLaybyToStock(LAYBY, { actorRole: "warehouse", hubLabel: "Hub 1" });
    expect(again.ok).toBe(false);
    expect(again.alreadyClaimed).toBe(true);
    expect(applyMovementMock).not.toHaveBeenCalled();   // no second set of units
  });

  it("two clerks racing: exactly one wins, one is told", async () => {
    seedSale(GOOD);
    // The other tablet's claim lands while ours is in flight.
    raceDuringClaim = () => setPath("laybys/lb1/expiredReturn", { by: "Hub 1 · Paul", at: "t" });
    const res = await returnExpiredLaybyToStock(LAYBY, { actorRole: "warehouse", hubLabel: "Hub 1 · Zama" });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Paul/);
    expect(applyMovementMock).not.toHaveBeenCalled();
  });
});

describe("the units go back to THEIR OWN hub — Pine and hub3 are a separate network", () => {
  it("a Pine layby returns to hub3, not hub1", async () => {
    setPath("pos/sales/s1/lineItems", GOOD);
    const res = await returnExpiredLaybyToStock(PINE, { actorRole: "warehouse", hubLabel: "Hub 3" });
    expect(res.ok).toBe(true);
    expect(res.dest).toBe("hub3");
    for (const [mv] of applyMovementMock.mock.calls) expect(mv.to).toBe("hub3");
  });

  it("REFUSES a layby with no recognised storage hub — never guesses a shelf", async () => {
    setPath("pos/sales/s1/lineItems", GOOD);
    for (const hub of [undefined, null, "", "hub9", "warehouse", 3]) {
      applyMovementMock.mockClear();
      const res = await returnExpiredLaybyToStock({ ...LAYBY, storageHub: hub }, { actorRole: "warehouse" });
      expect(res.ok, `storageHub ${JSON.stringify(hub)} must be refused`).toBe(false);
      expect(res.message).toMatch(/no recognised storage hub/);
      expect(applyMovementMock).not.toHaveBeenCalled();
    }
  });

  it("returnDestFor accepts only canonical hubs", () => {
    expect(returnDestFor({ storageHub: "hub1" })).toBe("hub1");
    expect(returnDestFor({ storageHub: "hub3" })).toBe("hub3");
    expect(returnDestFor({ storageHub: "marathon-pine" })).toBeNull();
    expect(returnDestFor({})).toBeNull();
    expect(returnDestFor(null)).toBeNull();
  });
});

describe("an unreadable parcel is refused, never half-returned", () => {
  it("refuses when a line has no productId", async () => {
    seedSale([{ productId: "p1", size: "L", qty: 1 }, { size: "M", qty: 1, name: "mystery" }]);
    const res = await returnExpiredLaybyToStock(LAYBY, { actorRole: "warehouse" });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/missing a product/);
    expect(applyMovementMock).not.toHaveBeenCalled();
    expect(getPath("laybys/lb1/status")).toBeNull();     // untouched
  });

  it("refuses when the sale link is missing or empty", async () => {
    expect((await returnExpiredLaybyToStock({ laybyId: "lb1", storageHub: "hub1" }, {})).message).toMatch(/no linked sale/);
    seedSale([]);
    expect((await returnExpiredLaybyToStock(LAYBY, {})).message).toMatch(/no item lines/);
  });

  it("returns only what is still held after a partial refund", async () => {
    seedSale([{ productId: "p1", size: "L", qty: 3, refundedQty: 1, name: "Tracksuit" }]);
    const res = await returnExpiredLaybyToStock(LAYBY, { actorRole: "warehouse" });
    expect(res.units).toBe(2);
    expect(applyMovementMock.mock.calls[0][0].qty).toBe(2);
  });

  it("refuses when every line was already refunded", async () => {
    seedSale([{ productId: "p1", size: "L", qty: 2, refundedQty: 2, name: "Tracksuit" }]);
    const res = await returnExpiredLaybyToStock(LAYBY, { actorRole: "warehouse" });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/already refunded/);
  });
});

describe("a failed movement releases the claim so it can be retried", () => {
  it("reports how far it got and frees the layby", async () => {
    seedSale(GOOD);
    applyMovementMock
      .mockImplementationOnce(async () => ({ ok: true, movementId: "mvA" }))
      .mockImplementationOnce(async () => ({ ok: false, reason: "write_failed" }));

    const res = await returnExpiredLaybyToStock(LAYBY, { actorRole: "warehouse" });
    expect(res.ok).toBe(false);
    expect(res.partial).toBe(true);
    expect(res.movementIds).toEqual(["mvA"]);
    expect(res.message).toMatch(/Stopped after 1 of 2/);
    expect(getPath("laybys/lb1/expiredReturn")).toBeNull();      // claim released
    expect(getPath("laybys/lb1/status")).toBeNull();             // NOT marked terminal
  });
});

describe("loadLaybyLines", () => {
  it("tolerates the object-map shape RTDB can return", async () => {
    seedSale({ a: GOOD[0], b: GOOD[1] });
    const r = await loadLaybyLines(LAYBY);
    expect(r.ok).toBe(true);
    expect(r.lines).toHaveLength(2);
  });
});
