// ─── CENTRAL-FED CLOTHING (Concrete, owner 8 Oct 2026) — the pure layers ────
// Concrete keeps its clothing in the shop, N of every size, straight from
// Central. Off (no setting) ⇒ every answer below is what it always was.
import { describe, it, expect } from "vitest";
import { normalizeNetwork, SEED_REGISTRY } from "../../utils/networkRegistry";
import { engineSourceFor, solveStoreBlock } from "./sectionRouting";
import { solveBlocks } from "./solveSections";
import { seedLocations } from "./solvePlan";
import { firstBatchEligible, buildFirstBatchSolveUpdate, sourceQueueLists, isCentralShopEngineRow } from "./firstBatchCore";
import { resolveTarget } from "./seatingCore";
import { computeMissingProducts } from "./missingProductsCore";

const NET = SEED_REGISTRY;
const ROUTES = { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" };
const ON = { routes: ROUTES, centralFedClothing: { concrete: 4 } };
const OFF = { routes: ROUTES };
const TEE = { id: "tee", name: "Tee", productType: "clothing", categoryKey: "t-shirts", sizes: ["S", "M", "L", "XL", "XXL"] };
const SHOE = { id: "shoe", name: "Shoe", category: "Footwear", subcategory: "Sneakers", categoryKey: "sneakers", productType: "sneaker", sizes: ["8", "9"] };
const PERF = { id: "perf", name: "Perf", category: "Perfume", categoryKey: "perfumes", sizes: ["_"] };
const cell = (qty) => ({ qty, v: 1, mv: "m" });

describe("routing: Concrete clothing comes straight from Central", () => {
  it("engineSourceFor: Central for Concrete clothing with the setting; Hub 3 without it; Pine, sneakers and perfume unchanged", () => {
    expect(engineSourceFor(NET, ROUTES, "concrete", TEE, "tee", ON)).toBe("central");
    expect(engineSourceFor(NET, ROUTES, "concrete", TEE, "tee", OFF)).toBe("hub3");
    expect(engineSourceFor(NET, ROUTES, "concrete", TEE, "tee")).toBe("hub3");
    expect(engineSourceFor(NET, ROUTES, "marathon-pine", TEE, "tee", ON)).toBe("hub3");
    expect(engineSourceFor(NET, ROUTES, "concrete", SHOE, "shoe", ON)).toBe("hub3");
    expect(engineSourceFor(NET, ROUTES, "concrete", PERF, "perf", ON)).toBe("hub3");
    for (const s of ["marathon-pe", "trophy"]) expect(engineSourceFor(NET, ROUTES, s, TEE, "tee", ON)).toBe("hub2");
  });
  it("Auto-refill off at Concrete: no engine route, setting or not", () => {
    const dark = normalizeNetwork({ locations: { concrete: { solve: true, autoRefill: "off" } } });
    expect(engineSourceFor(dark, ROUTES, "concrete", TEE, "tee", ON)).toBe(undefined);
  });
  it("the Solve block: no hub; open from Central; a hub-stranded card is sent back to Central", () => {
    expect(solveStoreBlock(NET, { source: "central", store: "concrete", hub: null, centralFed: true })).toBe(null);
    expect(solveStoreBlock(NET, { source: "hub3", store: "concrete", hub: null, centralFed: true })).toBe("Concrete clothing comes from Central — send it back to Central first");
    const blocks = solveBlocks({ network: NET, sections: [1], source: "central", product: TEE, productId: "tee", engineConfig: ON });
    const byId = Object.fromEntries(blocks[0].stores.map((s) => [s.id, s]));
    expect(byId.concrete).toMatchObject({ hub: null, centralFed: true, blocked: null });
    expect(byId["marathon-pine"]).toMatchObject({ hub: "hub3", centralFed: false });
    // without the setting: as before
    expect(solveBlocks({ network: NET, sections: [1], source: "central", product: TEE, productId: "tee" })[0].stores.find((s) => s.id === "concrete").hub).toBe("hub3");
  });
  it("seedLocations: no hub ⇒ the store alone", () => {
    expect(seedLocations("central", "concrete", null)).toEqual(["concrete"]);
    expect(seedLocations("central", "concrete", "hub3")).toEqual(["hub3", "concrete"]);
  });
});

describe("the DIRECT first batch", () => {
  it("eligible from Central with no hub test; never a sneaker; never from a hub", () => {
    expect(firstBatchEligible({ source: "central", store: "concrete", product: TEE, centralFed: true })).toBe(true);
    expect(firstBatchEligible({ source: "hub3", store: "concrete", product: TEE, centralFed: true })).toBe(false);
    expect(firstBatchEligible({ source: "central", store: "concrete", product: SHOE, centralFed: true })).toBe(false);
  });
  it("the write: N per size Central sends, the store alone seeded (only those sizes), the request says direct — nothing at Hub 3", () => {
    const split = { firstBatch: [{ size: "S", qty: 4 }, { size: "M", qty: 2 }], normal: ["XXL"], held: [] };
    let n = 0;
    const { updates, requestIds } = buildFirstBatchSolveUpdate({
      pid: "tee", store: "concrete", hub: null, split, existing: {}, nowIso: "T", uid: "u1", solveId: "fb_tee",
      seedCell: () => ({ qty: 0, v: 0, mv: "seed", lastType: "count" }), newKey: () => `r${++n}`,
    });
    const keys = Object.keys(updates).sort();
    expect(keys).toEqual(["refill_requests/r1", "refill_requests/r2", "stock/concrete/tee/M", "stock/concrete/tee/S"]);
    expect(keys.some((k) => k.includes("hub3") || k.includes("XXL"))).toBe(false);
    for (const id of requestIds) {
      expect(updates[`refill_requests/${id}`]).toMatchObject({ requestingLocation: "concrete", status: "open", createdFrom: { firstBatch: true, source: "central", store: "concrete", direct: true } });
      expect(updates[`refill_requests/${id}`].createdFrom.hub2Seeded).toBeUndefined();
    }
    expect(updates["refill_requests/r1"].qty).toBe(4);
  });
  it("Source: Concrete's tab lists its engine rows from Central; Marathon's engine rows from Hub 2 stay off the shop tab", () => {
    const shops = ["concrete", "marathon-pe"];
    const engineCentral = { status: "open", productId: "tee", requestingLocation: "concrete", createdFrom: { engine: true, source: "central" } };
    const engineHub2 = { status: "open", productId: "tee", requestingLocation: "marathon-pe", createdFrom: { engine: true, source: "hub2" } };
    expect(isCentralShopEngineRow(engineCentral)).toBe(true);
    expect(sourceQueueLists(engineCentral, shops)).toBe(true);
    expect(sourceQueueLists(engineHub2, shops)).toBe(false);
  });
});

describe("targets: N of every declared size at Concrete", () => {
  const ctx = (config, network) => ({ targets: {}, config, products: { tee: TEE, shoe: SHOE }, stock: {}, network });
  it("with the registry and the setting: 4 for every declared size, nothing for an undeclared one", () => {
    for (const sz of TEE.sizes) expect(resolveTarget(ctx(ON, NET), "concrete", "tee", sz)).toMatchObject({ target: 4, minQty: 3, source: "central_fed" });
    expect(resolveTarget(ctx(ON, NET), "concrete", "tee", "XS")).toBe(null);
  });
  it("without the setting: unchanged; Pine and sneakers unaffected (with no registry the SEED answers — every caller agrees with the engine)", () => {
    expect(resolveTarget(ctx(ON, undefined), "concrete", "tee", "M")?.source).toBe("central_fed");
    expect(resolveTarget(ctx(OFF, NET), "concrete", "tee", "M")?.source).not.toBe("central_fed");
    expect(resolveTarget(ctx(ON, NET), "marathon-pine", "tee", "M")?.source).not.toBe("central_fed");
    expect(resolveTarget(ctx(ON, NET), "concrete", "shoe", "8")?.source).not.toBe("central_fed");
  });
});

describe("Missing from Concrete", () => {
  const products = [TEE, SHOE];
  it("without the setting the list is what it always was", () => {
    const allStock = { central: { tee: { S: cell(5) } }, "marathon-pine": { tee: { S: cell(1) } } };
    expect(computeMissingProducts({ allStock, products, network: NET, section: 1 })).toEqual([]);   // Pine carries it
  });
  it("a tee Pine carries but Concrete does not: listed for Concrete, from Central", () => {
    const allStock = { central: { tee: { S: cell(5), M: cell(2) } }, "marathon-pine": { tee: { S: cell(1) } } };
    const [c] = computeMissingProducts({ allStock, products, network: NET, section: 1, centralFed: ON });
    expect(c).toMatchObject({ pid: "tee", source: "central", missing: ["concrete"], centralFed: "concrete" });
    expect(c.sizes.map((s) => [s.size, s.avail, !!s.centralNone])).toEqual([["S", 5, false], ["M", 2, false], ["L", 0, true], ["XL", 0, true], ["XXL", 0, true]]);
  });
  it("Concrete carries the tee but has no cell for XL and XXL: a size-gap card; sizes Central lacks read 'Central has none'", () => {
    const allStock = { central: { tee: { XL: cell(3) } }, concrete: { tee: { S: cell(4), M: cell(4), L: cell(4) } } };
    const [c] = computeMissingProducts({ allStock, products, network: NET, section: 1, centralFed: ON });
    expect(c.kind).toBe("Sizes missing at Concrete");
    expect(c.sizes.map((s) => [s.size, s.avail, !!s.centralNone])).toEqual([["XL", 3, false], ["XXL", 0, true]]);
  });
  it("an 'Only in Hub 3' card Pine needs SURVIVES; Concrete gets its own Central card (review fix)", () => {
    const allStock = { central: { tee: { S: cell(5) } }, hub3: { tee: { M: cell(3) } } };
    const off = computeMissingProducts({ allStock, products, network: NET, section: 1 });
    expect(off.map((c) => [c.source, c.missing])).toEqual([["hub3", ["marathon-pine", "concrete"]]]);
    const on = computeMissingProducts({ allStock, products, network: NET, section: 1, centralFed: ON });
    const hub3Card = on.find((c) => c.source === "hub3");
    const cf = on.find((c) => c.source === "central");
    expect(hub3Card.missing).toEqual(["marathon-pine"]);          // Pine still solvable from Hub 3
    expect(cf).toMatchObject({ missing: ["concrete"], centralFed: "concrete" });
  });
  it("a TRUSTED Concrete cell below N whose size Central has none of is listed 'Central has none'", () => {
    const trusted = (qty) => ({ qty, v: 1, mv: "m", trusted: true, trustedVia: "refill" });
    const allStock = { central: { tee: { S: cell(9), M: cell(9), L: cell(9), XL: cell(9) } },
      concrete: { tee: { S: trusted(4), M: trusted(4), L: trusted(4), XL: trusted(2), XXL: trusted(1) } } };
    const [c] = computeMissingProducts({ allStock, products, network: NET, section: 1, centralFed: ON });
    // XL is short but Central has it (the engine tops it up): not listed. XXL is short and Central has none: listed.
    expect(c.sizes.map((s) => [s.size, !!s.centralNone])).toEqual([["XXL", true]]);
  });
  it("an UNTRUSTED Concrete cell holding nothing is a gap; one holding units waits for a count", () => {
    const allStock = { central: { tee: { S: cell(9), M: cell(9) } }, concrete: { tee: { S: cell(0), M: cell(3), L: cell(4), XL: cell(4), XXL: cell(4) } } };
    const [c] = computeMissingProducts({ allStock, products, network: NET, section: 1, centralFed: ON });
    expect(c.sizes.map((s) => s.size)).toEqual(["S"]);
  });
  it("sneakers never take this list; the Marathon list is untouched", () => {
    const allStock = { central: { shoe: { 8: cell(3) }, tee: { S: cell(5) } } };
    const cards = computeMissingProducts({ allStock, products, network: NET, section: 1, centralFed: ON });
    expect(cards.map((c) => c.pid)).toEqual(["tee"]);
    expect(computeMissingProducts({ allStock, products, network: NET, centralFed: ON })).toEqual(computeMissingProducts({ allStock, products, network: NET }));
  });
});

describe("Source: Central's \"no\" to a DIRECT first batch", () => {
  it("is not stamped first_batch_central_declined (Central is the store's real source: the normal cooldown applies)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./RefillQueue.jsx", import.meta.url), "utf8");
    expect(src).toContain('cancelReason: isFirstBatchShopLeg(row._r) && row._r?.createdFrom?.direct !== true ? CENTRAL_DECLINED_REASON : null,');
  });
});

describe("resolveTarget agrees with the engine in every caller (review fix)", () => {
  const ctx = (extra = {}) => ({ targets: {}, config: ON, products: { tee: TEE }, stock: {}, ...extra });
  it("with NO registry handed in, the seed answers: Concrete clothing is N per declared size", () => {
    expect(resolveTarget(ctx(), "concrete", "tee", "M")).toMatchObject({ target: 4, source: "central_fed" });
  });
  it("the Central route must be open: Concrete with Auto-refill off is not central-fed", () => {
    const dark = normalizeNetwork({ locations: { concrete: { solve: true, autoRefill: "off" } } });
    const t = resolveTarget(ctx({ network: dark }), "concrete", "tee", "M");
    expect(t?.source).not.toBe("central_fed");
  });
  it("Marathon PE is never central-fed", () => {
    expect(resolveTarget(ctx(), "marathon-pe", "tee", "M")?.source).not.toBe("central_fed");
  });
});
