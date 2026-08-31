// ─── Leftovers tab × deactivation — the three lists' contracts ───────────────
// Run: npx vitest run src/components/stock/leftoversDeactivate.test.js
//
//   • buildLeftovers SKIPS a deactivated product (that is the point of the
//     card's Deactivate button) and is otherwise byte-identical.
//   • buildFinishedLines finds the census gap: unregistered footwear with
//     cells at this hub and zero total stock everywhere.
//   • buildDeactivatedRows lists EVERY deactivated product, stock-holders
//     first — the "never silently lost" visibility guarantee.

import { describe, it, expect } from "vitest";
import { buildLeftovers, buildFinishedLines, buildDeactivatedRows } from "./hubCleanupCore.js";

const shoe = (id, over = {}) => ({ id, name: `Shoe ${id}`, category: "Footwear", sizes: ["8", "9"], ...over });
const DEACT = { at: 1756100000000, by: "u1", byName: "junid" };

const products = [
  shoe("keep"),                                   // leftover with stock
  shoe("dead", { deactivated: DEACT }),           // deactivated, holds stock
  shoe("ghost"),                                  // cells here, zero everywhere
  shoe("deadGhost", { deactivated: DEACT }),      // deactivated, zero stock
  shoe("coded", { styleCodeNormalised: "AB1" }),  // registered — never a leftover
];
const hubStock = {
  keep: { "8": { qty: 2 } },
  dead: { "8": { qty: 3 } },
  ghost: { "8": { qty: 0 }, "9": { qty: 0 } },
  deadGhost: { "8": { qty: 0 } },
  coded: { "8": { qty: 1 } },
};
const allStock = {
  hub1: hubStock,
  central: { keep: { "9": { qty: 1 } } },
};
const args = { hub: "hub1", products, hubStock, registered: {}, allStock, identityMap: {} };

describe("buildLeftovers", () => {
  it("skips a deactivated product; everything else exactly as before", () => {
    const rows = buildLeftovers(args);
    expect(rows).toHaveLength(1);
    expect(rows[0].product.id).toBe("keep");
    expect(rows[0].hubQty).toBe(2);
  });
});

describe("buildFinishedLines", () => {
  it("lists unregistered footwear with cells here and zero stock everywhere — not deactivated, not registered, not stock-holding", () => {
    const rows = buildFinishedLines(args);
    expect(rows.map((r) => r.product.id)).toEqual(["ghost"]);
  });
  it("returns nothing without the network view — 'zero everywhere' is never guessed", () => {
    expect(buildFinishedLines({ ...args, allStock: null })).toEqual([]);
  });
  it("NETWORK-WIDE: a ghost with cells ONLY at another location still lists here (owner order 2026-08-25)", () => {
    const remote = shoe("peGhost");
    const rows = buildFinishedLines({
      ...args,
      products: [...products, remote],
      allStock: { ...allStock, "marathon-pe": { peGhost: { "8": { qty: 0 } } } },
    });
    expect(rows.map((r) => r.product.id).sort()).toEqual(["ghost", "peGhost"]);
    expect(rows.find((r) => r.product.id === "peGhost").cellLocs).toEqual(["marathon-pe"]);
  });
  it("negative cells elsewhere do not disqualify (total <= 0 is still finished)", () => {
    const rows = buildFinishedLines({
      ...args,
      allStock: { ...allStock, central: { ...allStock.central, ghost: { "9": { qty: -2 } } } },
    });
    expect(rows.map((r) => r.product.id)).toEqual(["ghost"]);
  });
});

describe("buildDeactivatedRows", () => {
  it("lists EVERY deactivated product, stock-holders first with their locations", () => {
    const rows = buildDeactivatedRows({ products, allStock });
    expect(rows.map((r) => r.product.id)).toEqual(["dead", "deadGhost"]);
    expect(rows[0].units).toBe(3);
    expect(rows[0].locations.map((l) => l.loc)).toEqual(["hub1"]);
    expect(rows[1].units).toBe(0);
  });
  it("is empty when nothing is deactivated", () => {
    expect(buildDeactivatedRows({ products: [shoe("a")], allStock })).toEqual([]);
  });
});

// ── The two "still findable, clearly marked" surfaces ────────────────────────
import { mergeTargetPool, rowLabel } from "./mergeSearch.js";
import { computeMissingFootwear } from "./missingFootwearCore.js";

describe("merge picker keeps deactivated products, marked", () => {
  it("mergeTargetPool does NOT filter a deactivated product", () => {
    const loser = shoe("loser");
    const pool = mergeTargetPool([shoe("a"), shoe("b", { deactivated: DEACT }), loser], loser);
    expect(pool.map((p) => p.id).sort()).toEqual(["a", "b"]);
  });
  it("rowLabel marks a deactivated product and leaves active ones untouched", () => {
    expect(rowLabel(shoe("b", { deactivated: DEACT }))).toBe("Shoe b · deactivated");
    expect(rowLabel(shoe("a"))).toBe("Shoe a");
  });
});

describe("Missing Sneakers never offers a deactivated product", () => {
  const stranded = {
    central: { dead: { "8": { qty: 4 } }, live: { "8": { qty: 4 } } },
    hub1: {}, hub2: {},
  };
  it("a deactivated product with stranded Central stock raises no card; active twin unchanged", () => {
    const cards = computeMissingFootwear({
      allStock: stranded,
      products: [shoe("dead", { deactivated: DEACT }), shoe("live")],
      hubs: ["hub1", "hub2"],
    });
    expect(cards.map((c) => c.pid)).toEqual(["live"]);
  });
});

// ── SOURCE PINS (the refill-hidden-invariance idiom) ─────────────────────────
// The pure predicates above are behaviour-proven; these pin that the JSX
// surfaces actually CALL them, so deleting a call site cannot pass silently.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, p), "utf8");

describe("clothing/perfume twin — computeMissingProducts skips deactivated too", () => {
  it("a deactivated clothing product with stranded Central stock raises no card; active twin unchanged", async () => {
    const { computeMissingProducts } = await import("./missingProductsCore.js");
    const tee = (id, over = {}) => ({ id, name: `Tee ${id}`, productType: "clothing", sizes: ["M"], ...over });
    const allStock = {
      central: { dead: { M: { qty: 4 } }, live: { M: { qty: 4 } } },
      hub2: {}, "marathon-pe": {}, trophy: {},
    };
    const cards = computeMissingProducts({
      allStock,
      products: [tee("dead", { deactivated: DEACT }), tee("live")],
    });
    expect(cards.map((c) => c.pid)).toEqual(["live"]);
  });
});

describe("source pins — the call sites exist", () => {
  it("all three assistant ordering chip surfaces use orderSizeOut", () => {
    const app = src("../../App.jsx");
    expect(app.split("orderSizeOut(").length - 1).toBeGreaterThanOrEqual(3);
  });
  it("the global ReactivationNotice is mounted", () => {
    const app = src("../../App.jsx");
    expect(app).toContain("<ReactivationNotice />");
  });
  it("MissingFootwear write paths carry the stale-screen guard, twice (solve and request)", () => {
    const mf = src("./MissingFootwear.jsx");
    expect(mf.split("isDeactivated(byId.get(card.pid))").length - 1).toBe(2);
  });
  it("placeOrders carries the submit-time stale-cart guard", () => {
    const app = src("../../App.jsx");
    expect(app).toContain("isDeactivated(resolveProductById(item.product.id) || item.product)");
  });
  it("MoveExcess skips deactivated products in lockstep with the engine's excess pass", () => {
    const me = src("./MoveExcess.jsx");
    expect(me).toContain("if (isDeactivated(p)) continue;");
  });
  it("the Deactivated section waits for allStock so a stock-holder never reads as empty", () => {
    const hc = src("./HubCleanup.jsx");
    expect(hc).toContain("{allStock && deactivatedRows.length > 0 && (");
  });
  // THREE since 2026-08-31: leftovers, finished lines, and the new
  // "Unregistered, not held here" section (the 174 products that were in no
  // list at all — see buildUnregisteredElsewhere).
  it("HubCleanup renders Deactivate on leftover, finished-line AND not-held-here cards, and Reactivate", () => {
    const hc = src("./HubCleanup.jsx");
    expect(hc.split("doDeactivate(product)").length - 1).toBe(3);
    expect(hc).toContain("doReactivate(product)");
  });
});
