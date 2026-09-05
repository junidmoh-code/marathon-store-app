// ─── BUILD 2 — MERGE IS AN OPTION ON EVERY LEFTOVER, ZERO STOCK INCLUDED ─────
// (Owner spec 2026-09-05.) A zero-stock leftover used to offer Deactivate and
// nothing else, which leaves the bad NAME in the catalogue forever. Merging
// removes it AND repoints its barcodes onto the survivor, so a scan of the old
// sticker still finds the shoe. Merge is therefore the primary action and
// Deactivate the fallback for a line with no twin.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTwinIndex, suggestTwin } from "./duplicateGroups.js";
import { buildFinishedLines, buildUnregisteredElsewhere } from "./hubCleanupCore.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(here, rel), "utf8");

// ── THE TWIN FINDER ──────────────────────────────────────────────────────────
const dead = { id: "pBad", name: "Air foce 1", brand: "Nike", productType: "sneaker" };
const twin = { id: "pGood", name: "Air Force 1", brand: "Nike", productType: "sneaker", photoUrl: "g.jpg" };
const other = { id: "pOther", name: "Air Max 95", brand: "Nike", productType: "sneaker" };
const otherBrand = { id: "pAdi", name: "Air Force 1", brand: "Adidas", productType: "sneaker" };
const CAT = [dead, twin, other, otherBrand];

const twinOf = (p, products = CAT, opts = {}) =>
  suggestTwin(p, { index: buildTwinIndex({ products, identityMap: opts.identityMap || null }), products, ...opts });

describe("suggestTwin — a one-tap merge target, never an automatic merge", () => {
  it("finds the near-miss name inside the same brand", () => {
    const t = twinOf(dead);
    expect(t.product.id).toBe("pGood");
    expect(t.via).toBe("name");
  });
  it("will not cross a brand boundary", () => {
    expect(twinOf(dead, [dead, otherBrand])).toBeNull();
  });
  it("will not join on a model NUMBER — Air Max 95 is not Air Max 97", () => {
    expect(twinOf({ id: "p95", name: "Air Max 95", brand: "Nike" }, [{ id: "p95", name: "Air Max 95", brand: "Nike" }, { id: "p97", name: "Air Max 97", brand: "Nike" }]))
      .toBeNull();
  });
  it("prefers a SHARED IDENTITY TOKEN over a close name, and names the token", () => {
    const coded = { id: "pCoded", name: "Something else entirely", brand: "Puma", styleCodeNormalised: "ABC123" };
    const loser = { id: "pL", name: "Air foce 1", brand: "Nike", styleCodeNormalised: "ABC123" };
    const t = twinOf(loser, [loser, coded, twin]);
    expect(t.product.id).toBe("pCoded");
    expect(t.via).toBe("code");
    expect(t.reason).toContain("ABC123");
  });
  it("never nominates a merged-away or a deactivated record", () => {
    const gone = { id: "pGone", name: "Air Force 1", brand: "Nike", mergedInto: "pX" };
    const off = { id: "pOff", name: "Air Force 1", brand: "Nike", deactivated: { at: 1, by: "u" } };
    expect(twinOf(dead, [dead, gone, off])).toBeNull();
  });
  it("…even from a STALE index that still lists them", () => {
    // The index is built once per screen and the product list is live, so a
    // record deactivated (or merged away) between the two is exactly the case
    // the per-candidate guard exists for. Building the index BEFORE the flag
    // lands reproduces it.
    const gone = { id: "pGone", name: "Air Force 1", brand: "Nike", mergedInto: "pX" };
    const off = { id: "pOff", name: "Air Force 1", brand: "Nike", styleCodeNormalised: "ZZ9" };
    const loser = { id: "pL", name: "Air foce 1", brand: "Nike", styleCodeNormalised: "ZZ9" };
    const stale = buildTwinIndex({ products: [loser, { ...gone, mergedInto: undefined }, off] });
    // now both go away underneath it
    stale.byBrand.set("nike", [loser, gone, { ...off, deactivated: { at: 1, by: "u" } }]);
    stale.byCode.set("zz9", [{ product: { ...off, deactivated: { at: 1, by: "u" } }, code: "ZZ9" }]);
    expect(suggestTwin(loser, { index: stale })).toBeNull();
  });
  it("never nominates the product itself", () => {
    expect(twinOf(dead, [dead])).toBeNull();
  });
  it("ranks on evidence — the copy holding the stock wins", () => {
    const a = { id: "pA", name: "Air Force 1", brand: "Nike" };
    const b = { id: "pB", name: "Air force 1", brand: "Nike" };
    const allStock = { hub1: { pB: { "7": { qty: 6 } } } };
    const t = suggestTwin(dead, {
      index: buildTwinIndex({ products: [dead, a, b] }), products: [dead, a, b], allStock,
    });
    expect(t.product.id).toBe("pB");
    expect(t.units).toBe(6);
  });
  it("a zero-stock loser still gets a suggestion — stock is not a precondition", () => {
    expect(twinOf(dead, CAT, { allStock: {} }).product.id).toBe("pGood");
  });
});

// ── THE CARD ─────────────────────────────────────────────────────────────────
// LeftoverExits is not exported (it is one screen's private card block), so it
// is exercised through the source: order and wiring are what the spec fixes.
describe("the exits block — merge primary, deactivate fallback", () => {
  const hc = read("./HubCleanup.jsx");
  it("is rendered by ALL THREE leftovers sections, zero-stock ones included", () => {
    expect(hc.split("<LeftoverExits product={product} twin={twinFor(product)} busy={busy}").length - 1).toBe(3);
  });
  it("puts MERGE before DEACTIVATE inside the block", () => {
    const block = hc.slice(hc.indexOf("function LeftoverExits("), hc.indexOf("// One overlay to rule the flow"));
    expect(block.indexOf("MERGE INTO THIS ONE")).toBeGreaterThan(-1);
    expect(block.indexOf("Merge into another product")).toBeLessThan(block.indexOf("Deactivate — finished line"));
  });
  it("the twin row carries the candidate's PHOTO and opens the merge pre-picked", () => {
    const block = hc.slice(hc.indexOf("function LeftoverExits("), hc.indexOf("// One overlay to rule the flow"));
    expect(block).toContain("<Photo url={twin.product.photoUrl}");
    expect(block).toContain("onMerge(product, twin.product)");
    // …and the escape hatch stays, because a photo nobody recognises must never
    // be the only door.
    expect(block).toContain("onMerge(product, null)");
  });
  it("both zero-stock sections build the SAME merge route as the stock-holding one", () => {
    expect(hc).toContain("const openMerge = useCallback(async (loser, other) => {");
    expect(hc).toContain("setMerge({ loser, other: other || null });");
  });
  it("the twin index is built once per screen, not once per card", () => {
    expect(hc).toContain("buildTwinIndex({ products, identityMap: identity.map })");
  });
});

// ── THE SECTIONS THAT WERE MERGE-LESS ────────────────────────────────────────
describe("the zero-stock rows these exits now serve", () => {
  const p = { id: "pZ", name: "Sold out line", productType: "sneaker", categoryKey: "sneakers" };
  it("a finished line (cells everywhere, all empty) is still listed", () => {
    const rows = buildFinishedLines({
      hub: "hub1", products: [p], hubStock: {}, registered: {},
      allStock: { hub1: { pZ: { "7": { qty: 0 } } } },
    });
    expect(rows.map((r) => r.product.id)).toEqual(["pZ"]);
  });
  it("an unregistered product with no cells at all is still listed", () => {
    const rows = buildUnregisteredElsewhere({
      hub: "hub1", products: [p], hubStock: {}, registered: {}, allStock: { hub1: {} },
    });
    expect(rows.map((r) => r.product.id)).toEqual(["pZ"]);
  });
});

// ── MERGE AT ZERO STOCK, ON THE SERVER ───────────────────────────────────────
// Nothing about a merge requires the loser to hold units — pinned here so a
// future precondition cannot be added silently.
describe("the merge itself has no quantity precondition", () => {
  const srv = fs.readFileSync(path.resolve(here, "../../../functions/lib/product-merge.cjs"), "utf8");
  it("refuses only on identity, merge-state and readability — never on stock", () => {
    const refusals = srv.match(/new MergeRefused\([^)]*\)/g) || [];
    expect(refusals.length).toBeGreaterThan(5);
    for (const r of refusals) {
      expect(r).not.toMatch(/holds no stock|no units|zero stock|empty/i);
    }
  });
  it("and the client's confirm button waits only on the PLAN, not on a quantity", () => {
    const mp = read("./MergeProducts.jsx");
    expect(mp).toContain("disabled={busy || !allStock || plan === null || plan === PLAN_ERROR}");
  });
});
