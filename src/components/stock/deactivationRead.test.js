// ─── THE FLAG IS NOW READ, NOT JUST WRITTEN ──────────────────────────────────
// BUG 1, proven live 2026-08-31: "Air foce 1" sat in the Deactivated list
// ("Deactivated 31 Aug by gunidmoh") AND still rendered as an orderable
// Tap-to-add card in the product grid. The write was fine; nothing read it.
//
// These pins hold every surface that lists products for ordering, requesting,
// refilling or selecting to the same contract:
//
//   BROWSE  drops deactivated records — the grid, the CR refill list, the
//           engine decision queue, the introduce-to-engine migration, display
//           registration.
//   SEARCH  keeps them and MARKS them — a typed query must still find the copy
//           the operator is looking at, so they can act on it.
//   MERGE PICKER / DEACTIVATED LIST  keep them by design.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browsableProducts, isDeactivated, orderSizeOut } from "../../utils/deactivation.js";
import { computeUnintroduced } from "./introduceExistingCore.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(here, rel), "utf8");

const live = { id: "pLive", name: "Air force 1", productType: "sneaker" };
const dead = { id: "pDead", name: "Air foce 1", productType: "sneaker", deactivated: { at: 1, by: "u", byName: "gunidmoh" } };

describe("browsableProducts — the one browse filter", () => {
  it("drops deactivated records and keeps everything else", () => {
    expect(browsableProducts([live, dead]).map((p) => p.id)).toEqual(["pLive"]);
  });
  it("tolerates null/undefined input", () => {
    expect(browsableProducts(null)).toEqual([]);
    expect(browsableProducts(undefined)).toEqual([]);
  });
  it("never mutates the caller's array", () => {
    const list = [live, dead];
    browsableProducts(list);
    expect(list).toHaveLength(2);
  });
  it("agrees with the predicate the engine uses", () => {
    expect(isDeactivated(dead)).toBe(true);
    expect(isDeactivated(live)).toBe(false);
    // and the size rule is unchanged: deactivated is out for ANY product type
    expect(orderSizeOut(dead, { clothingOrder: false, hubQty: 99 })).toBe(true);
    expect(orderSizeOut(live, { clothingOrder: false, hubQty: 99 })).toBe(false);
  });
});

describe("the ordering grid (App.jsx AssistantView) — phone AND desktop", () => {
  const app = read("../../App.jsx");
  it("browses from a filtered list, not the raw universe", () => {
    expect(app).toContain("const browse = useMemo(() => browsableProducts(base), [base]);");
  });
  it("an EMPTY query renders `browse`, so a deactivated product has no card", () => {
    expect(app).toContain("if (!q) return browse;");
  });
  it("a TYPED query still searches the FULL universe, so search can find it", () => {
    // Fuse is built over `base`, and the code-hit branch filters `base` too.
    expect(app).toContain("const fuse = useMemo(() => new Fuse(base, {");
    expect(app).toContain("const codeHits = /\\d/.test(q) ? base.filter(p => {");
  });
  it("the desktop overlay is handed the SAME browse list — one memo, no drift", () => {
    expect(app).toContain("products={browse} searchResults={filtered}");
  });
  it("a deactivated product that DOES surface (via search) is marked on every card", () => {
    // phone photo grid, CR refill card, desktop card
    expect(app).toContain("{p.name}{isDeactivated(p) && <DeactivatedChip small />}");
    expect(app).toContain("{product.name}{isDeactivated(product) && <DeactivatedChip small />}");
    expect(app).toContain('Deactivated — no sizes on offer');
  });
});

describe("the other lists a product can be requested or refilled from", () => {
  it("the engine decision queue owes no decision on a retired line", () => {
    const q = read("./NoTargetQueue.jsx");
    expect(q.split("if (isDeactivated(p)) continue;").length - 1).toBe(3);   // all three card loops
  });
  it("Introduce-to-engine refuses to arm a deactivated product", () => {
    const byId = new Map([[live.id, { ...live, productType: "clothing" }], [dead.id, { ...dead, productType: "clothing" }]]);
    const allStock = { "marathon-pe": { pLive: { M: { qty: 3 } }, pDead: { M: { qty: 3 } } } };
    const out = computeUnintroduced(allStock, {}, byId, ["marathon-pe"], null);
    expect(out.map((i) => i.pid)).toEqual(["pLive"]);
  });
  it("display registration will not offer a retired line a new display", () => {
    expect(read("./DisplayRegistrationView.jsx"))
      .toContain("predicate: (p) => isFootwearProduct(p) && !isDeactivated(p)");
  });
  it("Missing Footwear, Missing Products, Move Excess and the leftovers list already guard", () => {
    expect(read("./MissingFootwear.jsx")).toContain("isDeactivated(byId.get(card.pid))");
    expect(read("./missingProductsCore.js")).toContain("if (isDeactivated(p)) continue;");
    expect(read("./missingFootwearCore.js")).toContain("if (isDeactivated(p)) continue;");
    expect(read("./MoveExcess.jsx")).toContain("if (isDeactivated(p)) continue;");
  });
});

describe("the three places it MUST stay visible", () => {
  it("the merge picker keeps it and marks it", () => {
    expect(read("./mergeSearch.js")).toContain('const mark = isDeactivated(product) ? " · deactivated" : "";');
  });
  it("the Deactivated list is not footwear-gated and not identity-gated", () => {
    const core = read("./hubCleanupCore.js");
    expect(core).toContain("export function buildDeactivatedRows({ products = [], allStock = null })");
    expect(core).toContain("if (!p || !p.id || isMergedAway(p) || !isDeactivated(p)) continue;");
  });
  it("and one tap puts it back", () => {
    expect(read("./hubCleanupStore.js")).toContain("export async function reactivateProduct(productId)");
    expect(read("./HubCleanup.jsx")).toContain("doReactivate(product)");
  });
});
