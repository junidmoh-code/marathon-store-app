// ─── CENTRAL-FED CLOTHING — the predicate, and its two copies kept as one ───
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import * as esm from "./centralFed";
import { normalizeNetwork } from "../../utils/networkRegistry";

const require = createRequire(import.meta.url);
const B = "// ── BEGIN SHARED BODY", E = "// ── END SHARED BODY";
const body = (f) => { const t = readFileSync(join(process.cwd(), f), "utf8"); return t.slice(t.indexOf(B), t.indexOf("\n", t.indexOf(E)) + 1); };
const NET = normalizeNetwork(null);
const TEE = { id: "tee", productType: "clothing", sizes: ["S", "M", "L"] };
const SHOE = { id: "s", category: "Footwear", productType: "sneaker", sizes: ["8", "9"] };
const PERF = { id: "p", category: "Perfume", sizes: ["_"] };
const cfg = (m, routes = { "marathon-pe": "hub2", trophy: "hub2" }) => ({ routes, centralFedClothing: m });

describe("two copies, one body", () => {
  it("the client copy is the functions copy, byte for byte, and answers the same", () => {
    const a = body("src/components/stock/centralFed.js");
    expect(a.length).toBeGreaterThan(500);
    expect(body("functions/lib/central-fed.cjs")).toBe(a);
    const cjs = require("../../../functions/lib/central-fed.cjs");
    expect(Object.keys(cjs).sort()).toEqual(Object.keys(esm).sort());
  });
});

describe("centralFedPerSize / isCentralFedProduct", () => {
  it("absent or garbled → off everywhere", () => {
    for (const c of [null, {}, cfg(null), cfg([]), cfg({ concrete: 0 }), cfg({ concrete: -1 }), cfg({ concrete: 4.5 }), cfg({ concrete: "4" }), cfg({ concrete: 100 })]) {
      expect(esm.centralFedPerSize(c, NET, "concrete")).toBe(null);
    }
  });
  it("Concrete with N set → N; clothing only", () => {
    const c = cfg({ concrete: 4 });
    expect(esm.centralFedPerSize(c, NET, "concrete")).toBe(4);
    expect(esm.isCentralFedProduct(c, NET, "concrete", TEE)).toBe(true);
    for (const p of [SHOE, PERF, null]) expect(esm.isCentralFedProduct(c, NET, "concrete", p)).toBe(false);
    expect(esm.isCentralFedProduct(c, NET, "marathon-pine", TEE)).toBe(false);   // Pine unchanged
  });
  it("never a store config.routes names (Marathon PE, Trophy), never a hub", () => {
    const c = cfg({ "marathon-pe": 4, trophy: 4, hub3: 4 });
    for (const s of ["marathon-pe", "trophy", "hub3"]) expect(esm.centralFedPerSize(c, NET, s)).toBe(null);
  });
  it("sizes: every declared size; one-size → '_'", () => {
    expect(esm.centralFedSizes(TEE)).toEqual(["S", "M", "L"]);
    expect(esm.centralFedSizes({ sizes: ["_"] })).toEqual(["_"]);
    expect(esm.centralFedSizes({})).toEqual(["_"]);
    expect(esm.centralFedTarget(4)).toEqual({ target: 4, minQty: 3, reorderPoint: null, source: "central_fed" });
  });
});
