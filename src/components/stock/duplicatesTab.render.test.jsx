// ─── THE DUPLICATES SCREEN, RENDERED FOR REAL ────────────────────────────────
// BUILD 3 (owner spec 2026-08-31). Claims a pure test cannot make:
//
//   • both sides of a group are on screen, side by side, with the facts;
//   • a survivor is RECOMMENDED and PRE-SELECTED, and the owner can swap it;
//   • one tap opens the EXISTING merge flow with BOTH sides already chosen;
//   • nothing merges automatically;
//   • the reads are bounded — a key-range page of /insights_log and per-location
//     stock, never a whole-node read.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ permRecord: { stockRole: "admin" }, isSuperAdmin: false }) }));
vi.mock("./useStock", () => ({ useLocations: () => ({ hub1: { id: "hub1", label: "Hub 1" } }) }));
vi.mock("../../firebase", () => ({ database: {}, auth: {}, functions: {} }));
vi.mock("firebase/database", () => ({ ref: () => ({}), get: async () => ({ exists: () => false, val: () => null }) }));
vi.mock("../../utils/labelIdentityStore", () => ({ useLabelIdentity: () => ({ map: {}, ready: true, refreshing: false }) }));

const STOCK = {
  hub1: { pKeep: { 9: { qty: 84, v: 0 } }, pDrop: { 9: { qty: 3, v: 0 } } },
  trophy: { pKeep: { 10: { qty: 5, v: 0 } } },
};
const loadAllStock = vi.fn(async () => STOCK);
vi.mock("./hubCleanupStore", () => ({ loadAllStock: (...a) => loadAllStock(...a) }));

const loadSalesByPid = vi.fn(async () => ({ pKeep: { units: 62, lastMs: Date.UTC(2026, 7, 12) }, pDrop: { units: 4, lastMs: 0 } }));
vi.mock("./duplicateSales", () => ({
  loadSalesByPid: (...a) => loadSalesByPid(...a),
  SINCE_LABEL: "10 Jun 2026",
  SINCE_MS: 0,
}));

let mergeProps = null;
vi.mock("./MergeProducts.jsx", () => ({ default: (props) => { mergeProps = props; return null; } }));

const { default: DuplicatesTab } = await import("./DuplicatesTab.jsx");

const PRODUCTS = [
  { id: "pKeep", name: "Nike Air Force 1", brand: "Nike", photoUrl: "u", styleCodeNormalised: "315122111" },
  { id: "pDrop", name: "Nike Air Foce 1", brand: "Nike", photoUrl: null },
  { id: "pLone", name: "Puma Suede", brand: "Puma" },
];

const flat = (n) => {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(flat).join("");
  return flat(n.children);
};
const text = (tr) => flat(tr.toJSON());
const btn = (tr, needle) => tr.root.findAll((n) => n.type === "button" && flat(n.children).includes(needle))[0];

async function mount() {
  let tr;
  await act(async () => { tr = TestRenderer.create(<DuplicatesTab products={PRODUCTS} registry={{ hub1: { id: "hub1", label: "Hub 1" }, trophy: { id: "trophy", label: "Trophy" } }} />); });
  await act(async () => {});
  return tr;
}

beforeEach(() => { mergeProps = null; loadAllStock.mockClear(); loadSalesByPid.mockClear(); });

describe("both sides, side by side", () => {
  it("renders every member of the group with its facts, and leaves lone products out", async () => {
    const tr = await mount();
    const t = text(tr);
    expect(t).toContain("Nike Air Force 1");
    expect(t).toContain("Nike Air Foce 1");
    expect(t).not.toContain("Puma Suede");
    expect(t).toContain("89 units");           // 84 + 5, the survivor's stock
    expect(t).toContain("62 sold");
    expect(t).toContain("Code 315122111");
    expect(t).toContain("No style code");      // the other copy carries none
    expect(t).toContain("no product photo");   // and no photo
  });

  it("says the stock is SPLIT — the group that actually loses sales", async () => {
    expect(text(await mount())).toContain("STOCK IS SPLIT");
  });

  it("names the survivor and why, in one line", async () => {
    const t = text(await mount());
    expect(t).toMatch(/keeps: has 89 units across 2 locations, 62 sold/);
  });
});

describe("recommended, pre-selected, swappable — never automatic", () => {
  it("the recommendation is pre-selected and the button names it", async () => {
    const tr = await mount();
    expect(btn(tr, "Open merge")).toBeTruthy();
    expect(flat(btn(tr, "Open merge").children)).toContain('keep "Nike Air Force 1"');
  });

  it("nothing merged just by rendering", async () => {
    await mount();
    expect(mergeProps).toBeNull();
  });

  it("the owner can swap the survivor with one tap", async () => {
    const tr = await mount();
    const row = tr.root.findAll((n) => n.type === "button" && flat(n.children).includes("Nike Air Foce 1"))[0];
    await act(async () => { row.props.onClick(); });
    expect(flat(btn(tr, "Open merge").children)).toContain('keep "Nike Air Foce 1"');
  });

  it("one tap opens the EXISTING merge flow with BOTH sides selected", async () => {
    const tr = await mount();
    await act(async () => { btn(tr, "Open merge").props.onClick(); });
    await act(async () => {});
    expect(mergeProps.initialSurvivor.id).toBe("pKeep");
    expect(mergeProps.initialLoser.id).toBe("pDrop");
  });

  it("and after a swap the two sides swap with it", async () => {
    const tr = await mount();
    const row = tr.root.findAll((n) => n.type === "button" && flat(n.children).includes("Nike Air Foce 1"))[0];
    await act(async () => { row.props.onClick(); });
    await act(async () => { btn(tr, "Open merge").props.onClick(); });
    await act(async () => {});
    expect(mergeProps.initialSurvivor.id).toBe("pDrop");
    expect(mergeProps.initialLoser.id).toBe("pKeep");
  });
});

describe("the reads are bounded and lazy", () => {
  it("stock is read per LOCATION, and sales through the key-range reader", async () => {
    await mount();
    expect(loadAllStock).toHaveBeenCalledWith(["hub1", "trophy"]);
    expect(loadSalesByPid).toHaveBeenCalledTimes(1);
  });
  it("the sales window is named on screen — the number is honest about its era", async () => {
    expect(text(await mount())).toContain("10 Jun 2026");
  });
});

describe("the bounded sales reader itself", () => {
  it("pages with orderByKey + startAt + limitToFirst, never a bare node read", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("./duplicateSales.js", import.meta.url), "utf8");
    expect(src).toContain("orderByKey(), startAt(cursor), limitToFirst(page)");
    expect(src).toContain("pushKeyForMs(sinceMs)");
    // forEach with a BRACED body — an implicit truthy return cancels RTDB's
    // forEach after ONE child, which would silently read a single event.
    expect(src).toContain("snap.forEach((child) => { keys.push(child.key); });");
  });
});
