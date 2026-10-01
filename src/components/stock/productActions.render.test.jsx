// ─── ACT WHERE I SEE THE PRODUCT — rendered for real ─────────────────────────
// BUILD 4 (owner spec 2026-08-31). Four claims a source pin cannot make:
//
//   1. Deactivate and Merge are reachable FROM A CARD, not from a tab.
//   2. Deactivation succeeds while the product holds stock — a phantom unit is
//      never a reason to keep a dead product alive.
//   3. If it still holds stock the card SAYS SO, per location.
//   4. Zeroing those cells is a SEPARATE, confirmed action, and every cell goes
//      through applyMovement as a reasoned negative adjustment. Never silent,
//      never bundled with the flag write.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

let PERMS = { permRecord: { stockRole: "admin" }, isSuperAdmin: false };
vi.mock("../PermissionsContext", () => ({ usePermissions: () => PERMS }));
vi.mock("./useStock", () => ({
  useLocations: () => ({ hub1: { id: "hub1", label: "Hub 1", active: true }, trophy: { id: "trophy", label: "Trophy", active: true } }),
}));
vi.mock("../../firebase", () => ({ database: {}, auth: {}, functions: {} }));

// The stock read: one per-product get() per location — never a whole-node read.
const GETS = [];
let CELLS = {};
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  get: async (r) => {
    GETS.push(r.path);
    const v = CELLS[r.path];
    return { exists: () => !!v, val: () => v };
  },
}));

const deactivateProduct = vi.fn(async () => ({ ok: true }));
const reactivateProduct = vi.fn(async () => ({ ok: true }));
vi.mock("./hubCleanupStore", () => ({
  deactivateProduct: (...a) => deactivateProduct(...a),
  reactivateProduct: (...a) => reactivateProduct(...a),
  loadAllStock: async () => ({}),
}));

const movements = [];
let movementResult = { ok: true };
vi.mock("./applyMovement", () => ({
  applyMovement: async (m) => { movements.push(m); return movementResult; },
}));

let mergeProps = null;
vi.mock("./MergeProducts.jsx", () => ({
  default: (props) => { mergeProps = props; return null; },
}));

const { ProductActionsButton, ProductActionSheet, DeactivatedChip } = await import("./ProductActions.jsx");

const live = { id: "pLive", name: "Air force 1", photoUrl: null };
const dead = { id: "pDead", name: "Air foce 1", deactivated: { at: 1788170934654, by: "u", byName: "gunidmoh" } };

const textIn = (n) => (typeof n === "string" ? n : (n.children || []).map(textIn).join(" "));
// Flattened visible text: JSX splits `Still holds {n} unit{s}` into four
// children, so a raw JSON.stringify never contains the sentence a person reads.
const json = (tr) => {
  const walk = (n) => {
    if (n == null || typeof n === "boolean") return "";
    if (typeof n === "string" || typeof n === "number") return String(n);
    if (Array.isArray(n)) return n.map(walk).join("");
    return walk(n.children);
  };
  return walk(tr.toJSON());
};
const btn = (tr, needle) => tr.root.findAll((n) => n.type === "button" && textIn(n).includes(needle))[0];

async function sheet(product) {
  let tr;
  await act(async () => { tr = TestRenderer.create(<ProductActionSheet product={product} products={[live, dead]} onClose={() => {}} />); });
  await act(async () => {});
  return tr;
}

beforeEach(() => {
  GETS.length = 0;
  movements.length = 0;
  movementResult = { ok: true };
  mergeProps = null;
  CELLS = {};
  PERMS = { permRecord: { stockRole: "admin" }, isSuperAdmin: false };
  deactivateProduct.mockClear();
  reactivateProduct.mockClear();
});

describe("1 — reachable from the card", () => {
  it("an admin gets the affordance on the card", async () => {
    let tr;
    await act(async () => { tr = TestRenderer.create(<ProductActionsButton product={live} products={[live]} />); });
    expect(tr.root.findAll((n) => n.type === "button")).toHaveLength(1);
  });
  it("a non-admin gets NOTHING — the card is unchanged for staff", async () => {
    PERMS = { permRecord: { stockRole: "warehouse" }, isSuperAdmin: false };
    let tr;
    await act(async () => { tr = TestRenderer.create(<ProductActionsButton product={live} products={[live]} />); });
    expect(tr.toJSON()).toBeNull();
  });
  it("tapping it opens the sheet with both actions", async () => {
    let tr;
    await act(async () => { tr = TestRenderer.create(<ProductActionsButton product={live} products={[live]} />); });
    await act(async () => { tr.root.findAll((n) => n.type === "button")[0].props.onClick({ stopPropagation() {} }); });
    await act(async () => {});
    expect(json(tr)).toContain("Deactivate");
    expect(json(tr)).toContain("Merge into another product");
  });
  it("the card's own tap never fires — the sheet swallows every click", async () => {
    const onCardClick = vi.fn();
    let tr;
    await act(async () => {
      tr = TestRenderer.create(<div onClick={onCardClick}><ProductActionsButton product={live} products={[live]} /></div>);
    });
    const stop = vi.fn();
    await act(async () => { tr.root.findAll((n) => n.type === "button")[0].props.onClick({ stopPropagation: stop }); });
    expect(stop).toHaveBeenCalled();
  });
  it("MERGE opens the EXISTING merge screen with this product pre-loaded", async () => {
    const tr = await sheet(live);
    await act(async () => { btn(tr, "Merge into another").props.onClick(); });
    await act(async () => {});
    expect(mergeProps).toBeTruthy();
    expect(mergeProps.initialLoser.id).toBe("pLive");
  });
});

describe("2 & 3 — stock is reported, never a blocker", () => {
  beforeEach(() => {
    CELLS = { "stock/hub1/pLive": { 9: { qty: 1, v: 0 } }, "stock/trophy/pLive": { 10: { qty: 2, v: 0 } } };
  });

  it("reads ONE path per location per product — never a whole-node read", async () => {
    await sheet(live);
    expect(GETS.sort()).toEqual(["stock/hub1/pLive", "stock/trophy/pLive"]);
    expect(GETS.some((p) => p === "stock" || p === "products")).toBe(false);
  });

  it("says what it still holds, per location, with sizes", async () => {
    const tr = await sheet(live);
    const t = json(tr);
    expect(t).toContain("Still holds 3 units");
    expect(t).toContain("Hub 1");
    expect(t).toContain("Trophy");
  });

  it("DEACTIVATES ANYWAY — a phantom unit is not a reason to keep it alive", async () => {
    const tr = await sheet(live);
    const b = btn(tr, "Deactivate");
    expect(b.props.disabled).toBeFalsy();
    await act(async () => { b.props.onClick(); });
    expect(deactivateProduct).toHaveBeenCalledWith("pLive");
    // and the flag write touched NO cell
    expect(movements).toHaveLength(0);
  });

  it("reactivates a retired line from the same sheet", async () => {
    const tr = await sheet(dead);
    await act(async () => { btn(tr, "Reactivate").props.onClick(); });
    expect(reactivateProduct).toHaveBeenCalledWith("pDead");
  });

  it("marks the retired product and says who retired it", async () => {
    const tr = await sheet(dead);
    expect(json(tr)).toContain("DEACTIVATED");
    expect(json(tr)).toContain("gunidmoh");
  });
});

describe("4 — zeroing is separate, deliberate, and goes through applyMovement", () => {
  beforeEach(() => {
    CELLS = { "stock/hub1/pLive": { 9: { qty: 4, v: 0 }, 10: { qty: 2, v: 0 } } };
  });

  it("the first tap only ASKS — nothing is written", async () => {
    const tr = await sheet(live);
    await act(async () => { btn(tr, "Zero its").props.onClick(); });
    expect(movements).toHaveLength(0);
    expect(json(tr)).toContain("Yes, zero them");
  });

  it("confirming writes ONE reasoned negative adjustment per cell", async () => {
    const tr = await sheet(live);
    await act(async () => { btn(tr, "Zero its").props.onClick(); });
    await act(async () => { btn(tr, "Yes, zero them").props.onClick(); });
    expect(movements).toHaveLength(2);
    for (const m of movements) {
      expect(m.type).toBe("adjustment");
      expect(m.productId).toBe("pLive");
      expect(m.from).toBe("hub1");
      expect(m.to).toBeUndefined();
      expect(String(m.reason)).toMatch(/deliberately/i);
      expect(m.expect.qty).toBe(m.qty);        // refuse if the cell moved since the read
    }
    expect(movements.map((m) => [m.size, m.qty]).sort()).toEqual([["10", 2], ["9", 4]]);
  });

  it("never zeroes as a side effect of deactivating", async () => {
    const tr = await sheet(live);
    await act(async () => { btn(tr, "Deactivate").props.onClick(); });
    expect(movements).toHaveLength(0);
  });

  it("reports a refusal honestly instead of claiming success", async () => {
    movementResult = { ok: false, reason: "stale_expectation" };
    const tr = await sheet(live);
    await act(async () => { btn(tr, "Zero its").props.onClick(); });
    await act(async () => { btn(tr, "Yes, zero them").props.onClick(); });
    expect(json(tr)).toContain("refused");
    expect(json(tr)).toContain("stale_expectation");
  });

  it("offers nothing to zero when the product holds nothing", async () => {
    CELLS = {};
    const tr = await sheet(live);
    expect(json(tr)).toContain("Holds no stock anywhere");
    expect(btn(tr, "Zero its")).toBeUndefined();
  });
});

describe("the chip", () => {
  it("says one word, in both sizes", async () => {
    let tr;
    await act(async () => { tr = TestRenderer.create(<DeactivatedChip />); });
    expect(json(tr)).toContain("DEACTIVATED");
    await act(async () => { tr.update(<DeactivatedChip small />); });
    expect(json(tr)).toContain("DEACTIVATED");
  });
});
