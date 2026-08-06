// ─── HUB STOCK CLEANUP — REGISTRATION IDEMPOTENCY, PROVEN ────────────────────
// The owner's mandatory mutation proof: "registering the same display twice
// adds one unit, not two". The mechanism is the DETERMINISTIC movement id —
// applyMovement treats the movement id as its idempotency key, so the fake
// writer below reproduces exactly that semantic (a movement id that already
// landed is a no-op). Kill the deterministic id (the mutation) and these tests
// fail; nothing here asserts on function names or call counts alone.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { stockCellPath } from "../../utils/sizeKey";

// ── In-memory RTDB (same fake as hubCountStore.test.js) ──────────────────────
let store = {};
function getPath(path) {
  let node = store;
  for (const part of String(path).split("/")) {
    if (node == null || typeof node !== "object") return null;
    node = node[part];
  }
  return node === undefined ? null : node;
}
function setPath(path, value) {
  const parts = String(path).split("/");
  let node = store;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== "object" || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  if (value === null) delete node[parts[parts.length - 1]];
  else node[parts[parts.length - 1]] = value;
}

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: async (node) => ({ val: () => getPath(node.path), exists: () => getPath(node.path) != null }),
  update: async (node, updates) => {
    for (const [k, v] of Object.entries(updates)) setPath(node.path ? `${node.path}/${k}` : k, v);
  },
  push: () => ({ key: `pk${++pushN}` }),
  runTransaction: async (node, fn) => {
    const cur = getPath(node.path);
    const next = fn(cur);
    if (next === undefined) return { committed: false, snapshot: { val: () => cur } };
    setPath(node.path, next);
    return { committed: true, snapshot: { val: () => next } };
  },
}));
let pushN = 0;
vi.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {} }));
vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "walker-1" } } }));
vi.mock("../../device/deviceId", () => ({ getDeviceId: () => "dev-1" }));

// The fake writer with the REAL writer's idempotency semantic: the movement id
// is the key. A movement that already exists changes NOTHING and reports
// { idempotent: true } — byte-for-byte the contract in applyMovement.js:112.
const applyMovementMock = vi.fn(async (mv) => {
  const id = mv.movementId || `auto${++pushN}`;
  if (getPath(`stock_movements/${id}`)) return { ok: true, movementId: id, idempotent: true };
  const loc = mv.to || mv.from;
  const path = stockCellPath(loc, mv.productId, mv.size);
  const cell = getPath(path);
  const cur = cell && typeof cell.qty === "number" ? cell.qty : 0;
  const delta = mv.to ? Number(mv.qty) : -Number(mv.qty);
  setPath(path, { ...(cell || {}), qty: cur + delta, v: cell && typeof cell.v === "number" ? cell.v + 1 : 0, mv: id, lastType: mv.type });
  setPath(`stock_movements/${id}`, { ...mv, id });
  return { ok: true, movementId: id };
});
vi.mock("./applyMovement", () => ({ applyMovement: (...a) => applyMovementMock(...a) }));

const {
  registerDisplayUnit, addExtraDisplayUnit, recordUnresolvedScan, loadRegister,
} = await import("./hubCleanupStore.js");

const HUB = "hub2";
const PRODUCT = { id: "p100", name: "Nike Dunk Low" };
const cellQty = (size = "6") => {
  const c = getPath(stockCellPath(HUB, PRODUCT.id, size));
  return c && typeof c.qty === "number" ? c.qty : 0;
};
const movementCount = () => Object.keys(getPath("stock_movements") || {}).length;

beforeEach(() => {
  store = {};
  pushN = 0;
  applyMovementMock.mockClear();
});

describe("registration is idempotent — the mandatory mutation proof", () => {
  it("registering the same display twice adds ONE unit, not two", async () => {
    const r1 = await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6" });
    expect(r1.ok).toBe(true);
    expect(cellQty("6")).toBe(1);

    const r2 = await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6" });
    expect(r2.ok).toBe(true);
    expect(r2.already).toBe(true);
    expect(cellQty("6")).toBe(1);          // still one unit
    expect(movementCount()).toBe(1);       // still one movement
  });

  it("even with the progress record lost, the movement id blocks a double add", async () => {
    await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6" });
    // Simulate the record vanishing (cleared node, other device's session wipe):
    setPath(`settings/hubSneakerCount/register/${HUB}/${PRODUCT.id}__6`, null);
    const r = await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6" });
    expect(r.ok).toBe(true);
    expect(cellQty("6")).toBe(1, "the deterministic movement id is the real guard");
  });

  it("adds onto the hub's EXISTING quantity — a size 6 display adds 1 to size 6", async () => {
    setPath(stockCellPath(HUB, PRODUCT.id, "6"), { qty: 4, v: 7, mv: "m0" });
    await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6" });
    expect(cellQty("6")).toBe(5);
    const cell = getPath(stockCellPath(HUB, PRODUCT.id, "6"));
    expect(cell.v).toBe(8);                // v moved by exactly 1
  });

  it("different sizes are different displays — each registers its own unit", async () => {
    await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6" });
    await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "8" });
    expect(cellQty("6")).toBe(1);
    expect(cellQty("8")).toBe(1);
  });

  it("a deliberate extra unit adds exactly one; replaying it does not", async () => {
    await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6" });
    const r = await addExtraDisplayUnit({ hub: HUB, product: PRODUCT, size: "6" });
    expect(r.ok).toBe(true);
    expect(cellQty("6")).toBe(2);
    // Two devices adding "one more" from the same base build the SAME movement
    // id — the second is a no-op on stock:
    setPath(`settings/hubSneakerCount/register/${HUB}/${PRODUCT.id}__6/qty`, 1); // other device still sees base 1
    const r2 = await addExtraDisplayUnit({ hub: HUB, product: PRODUCT, size: "6" });
    expect(r2.ok).toBe(true);
    expect(r2.idempotent).toBe(true);
    expect(cellQty("6")).toBe(2);          // still two — never three
  });
});

describe("scope and size discipline", () => {
  it("refuses every hub outside hub1/hub2 — Pine can never be touched", async () => {
    for (const hub of ["hub3", "marathon-pine", "marathon-pe", "trophy", "central"]) {
      const r = await registerDisplayUnit({ hub, product: PRODUCT, size: "6" });
      expect(r.ok).toBe(false);
      const extra = await addExtraDisplayUnit({ hub, product: PRODUCT, size: "6" });
      expect(extra.ok).toBe(false);
    }
    expect(getPath("stock")).toBe(null);
    expect(movementCount()).toBe(0);
  });

  it("refuses a size that would encode to the one-size sentinel — the Free Size leak", async () => {
    for (const size of ["", "_", "Free Size", null]) {
      const r = await registerDisplayUnit({ hub: HUB, product: PRODUCT, size });
      expect(r.ok).toBe(false);
    }
    expect(getPath("stock")).toBe(null);
  });

  it("stock changes go through applyMovement — the register write path builds a received movement to the hub", async () => {
    await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6", qty: 2 });
    const mv = applyMovementMock.mock.calls[0][0];
    expect(mv.type).toBe("received");
    expect(mv.to).toBe(HUB);
    expect(mv.qty).toBe(2);
    expect(mv.size).toBe("6");             // RAW size in — the writer owns encoding
    expect(mv.reason).toBe("display_registration");
    expect(cellQty("6")).toBe(2);
  });
});

describe("the register record and unresolved scans", () => {
  it("keeps a per-slot record the count pass and Leftovers read", async () => {
    await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "5.5" });
    const reg = await loadRegister(HUB);
    const rec = reg[`${PRODUCT.id}__5_5`];
    expect(rec).toBeTruthy();
    expect(rec.size).toBe("5.5");          // raw size preserved as a VALUE
    expect(rec.sizeKey).toBe("5_5");       // encoded form only in the KEY
    expect(rec.qty).toBe(1);
  });

  it("an unresolved scan is recorded calmly, keyed so re-scans do not pile up", async () => {
    await recordUnresolvedScan({ hub: HUB, code: "199.55/X", context: "count" });
    await recordUnresolvedScan({ hub: HUB, code: "199.55/X", context: "count" });
    const rows = getPath(`settings/hubSneakerCount/unresolved/${HUB}`);
    expect(Object.keys(rows)).toHaveLength(1);
    expect(Object.values(rows)[0].code).toBe("199.55/X");
  });
});
