// ─── "CONCRETE DIVISION POLICY" — THE SCREEN READS WHAT THE SCAN WRITES ──────
// exceptions.divisionPolicy is produced by functions/lib/refill-engine.cjs and
// drawn by HealthView.jsx: two runtimes held together only by the key and the
// row fields. Run the real engine on a snapshot that MUST produce a mismatch
// (non-zero, or the wiring check is vacuous), then hold the screen to them.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const { createRequire } = await import("node:module");
const req = createRequire(import.meta.url);
const engine = req("../../../functions/lib/refill-engine.cjs");
const reg = req("../../../functions/lib/network-registry.cjs");
const health = readFileSync(fileURLToPath(new URL("./HealthView.jsx", import.meta.url)), "utf8");

const ISO = "2026-11-10T09:00:00.000Z";
const snapshot = {
  nowMs: Date.parse(ISO),
  config: {
    routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
    mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
    ruleBasedTargets: true, maxIntentsPerRun: 75,
    concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 }, fromHub3: { perSize: 1, oneSize: 5, askAt: 0 }, hub3Keep: { on: false, perSize: 2, oneSize: 10 } },
  },
  products: { t1: { id: "t1", name: "Tee", category: "Clothing", categoryKey: "t-shirts", productType: "clothing", sizes: ["S"] } },
  targets: { concrete: { t1: { S: { target: 4, minQty: 3 } } } },
  stock: { central: { t1: { S: { qty: 9, v: 1 } } }, concrete: { t1: { S: { qty: 1, v: 1 } } }, hub3: {}, "marathon-pine": {} },
  openIndex: {}, refillRequests: {}, orders: {}, movements: [], network: reg.SEED_REGISTRY,
  seats: { concrete: { t1: { via: "stock", at: ISO } } },
};

describe("Concrete division policy: scan → /stock_exceptions → Health", () => {
  const dp = engine.computeRefillPlan(snapshot).exceptions.divisionPolicy;
  it("the engine produces the list, non-empty", () => {
    expect(dp.count).toBe(1);
    expect(dp.items[0].reason).toBe("explicit_row");
  });
  it("the screen reads the same key and every field it draws", () => {
    expect(health).toContain('case "divisionPolicy"');
    expect(health).toContain('setScreen("divisionPolicy")');
    expect(health).toContain("ex.divisionPolicy");
    for (const f of ["perLoc", "reason", "expected", "effective", "loc", "pid", "size"]) expect(Object.keys({ ...dp, ...dp.items[0] })).toContain(f);
    for (const f of ["dp.perLoc", "r.reason", "r.expected", "r.effective", "r.loc", "r.pid", "r.size", "t.correct", "t.products", "t.mismatched", "t.switchedOff"]) expect(health).toContain(f);
    for (const k of Object.keys(dp.perLoc.concrete)) expect(["products", "correct", "mismatched", "cells", "switchedOff"]).toContain(k);
  });
  it("the screen names every mismatch reason the engine can write", () => {
    const src = readFileSync(fileURLToPath(new URL("../../../functions/lib/concrete-division.cjs", import.meta.url)), "utf8");
    const body = src.slice(src.indexOf("function divisionAuditVerdict"), src.indexOf("// ── THE SOLVE'S SEAT"));
    const reasons = [...new Set([...body.matchAll(/"([a-z]+(?:_[a-z]+)*)"/g)].map((m) => m[1]))].filter((r) => !["switched_off", "dead_size", "none", "kept", "explicit"].includes(r));
    expect(new Set(reasons)).toEqual(new Set(["missing", "unexpected", "explicit_row", "wrong_number"]));
    for (const r of reasons) expect(health).toContain(`${r}:`);
  });
});
