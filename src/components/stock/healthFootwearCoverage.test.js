// ─── THE HEALTH SCREEN READS THE KEYS THE SCAN WRITES ────────────────────────
// The two footwear coverage buckets are produced in functions/lib/refill-engine.cjs
// and drawn by HealthView.jsx. Those are two files in two runtimes with no
// import between them: the only thing holding them together is the STRING
// under which the snapshot stores each list. A renamed bucket would leave a
// card reading 0 forever, green, while the scan kept filling a list nobody
// drew — which is precisely the silent state this build exists to end.
//
// So this test crosses the boundary: it runs the engine on a snapshot that
// must populate both buckets, then asserts the screen source reads exactly
// those keys, in a card AND in a detail screen. It asserts the NUMBER the
// engine produced is non-zero (a bucket that exists but is empty by
// construction would prove nothing) and the exact strings the screen uses.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const { createRequire } = await import("node:module");
const req = createRequire(import.meta.url);
const engine = req("../../../functions/lib/refill-engine.cjs");
const health = readFileSync(fileURLToPath(new URL("./HealthView.jsx", import.meta.url)), "utf8");

const RUN = { 6: { target: 3, minQty: 2, reorderPoint: 1 } };
const snapshot = {
  nowMs: Date.parse("2026-09-15T09:00:00Z"),
  config: {
    mode: { hub1: "live", hub2: "live" }, routes: { hub1: "central", hub2: "central" },
    ruleBasedTargets: true, maxIntentsPerRun: 50, maxFootwearIntentsPerRun: 50, maxUnitsPerIntent: 20,
    categoryPolicy: { sneakers: { perSize: true, hub1: { sizes: RUN, carriedOnly: true }, hub2: { sizes: RUN, carriedOnly: true } } },
  },
  products: {
    boot: { id: "boot", name: "Boot", category: "Footwear", categoryKey: "designer-shoes", sizes: ["6"] },
    stranded: { id: "stranded", name: "Stranded", category: "Footwear", categoryKey: "sneakers", sizes: ["6"] },
  },
  stock: { hub1: { boot: { 6: { qty: 2 } } }, hub2: {}, central: { stranded: { 6: { qty: 4 } } } },
  targets: {}, openIndex: {}, refillRequests: {}, orders: {}, movements: [], targetDecisions: {}, rejectStreak: {}, retryState: {}, heldLines: {},
};

describe("footwear coverage: scan → /stock_exceptions → Health", () => {
  const ex = engine.computeRefillPlan(snapshot).exceptions;

  it("the engine fills both buckets for this snapshot (so the wiring check below is not vacuous)", () => {
    expect(ex.unarmedFootwear.count).toBe(1);
    expect(ex.unarmedFootwear.items[0]).toMatchObject({ loc: "hub1", pid: "boot", units: 2, reason: "no_policy", key: "designer-shoes" });
    expect(ex.unorderableFootwear.count).toBe(1);
    expect(ex.unorderableFootwear.items[0]).toMatchObject({ pid: "stranded", units: 4, byLoc: { central: 4 } });
  });

  for (const key of ["unarmedFootwear", "unorderableFootwear"]) {
    it(`HealthView draws a card AND a detail screen for exceptions.${key}`, () => {
      // The card: value from count(key), tap opens the screen of the same name.
      expect(health).toContain(`value={count("${key}")}`);
      expect(health).toContain(`onClick={() => setScreen("${key}")}`);
      // The detail screen: a case for it that lists items(key).
      expect(health).toContain(`case "${key}"`);
      expect(health).toContain(`items("${key}")`);
      expect(health).toContain(`count={count("${key}")}`);
    });
  }

  it("every field the detail screen reads is a field the engine writes", () => {
    // Unarmed rows: loc, units, reason, key. Unorderable rows: pid, units, byLoc.
    for (const f of ["loc", "units", "reason", "key"]) expect(ex.unarmedFootwear.items[0]).toHaveProperty(f);
    for (const f of ["pid", "units", "byLoc"]) expect(ex.unorderableFootwear.items[0]).toHaveProperty(f);
    // The reason vocabulary the screen translates must be the engine's vocabulary.
    const screenReasons = [...health.matchAll(/^\s+(no_category_key|no_policy|no_sizes_declared|sizes_outside_run):/gm)].map((m) => m[1]).sort();
    expect(screenReasons).toEqual(["no_category_key", "no_policy", "no_sizes_declared", "sizes_outside_run"]);
    const engineSrc = readFileSync(fileURLToPath(new URL("../../../functions/lib/refill-engine.cjs", import.meta.url)), "utf8");
    for (const r of screenReasons) expect(engineSrc).toContain(`"${r}"`);
  });

  it("neither bucket is written from the screen — read-only surface", () => {
    const block = health.slice(health.indexOf('case "unarmedFootwear"'), health.indexOf('case "shortfalls"'));
    expect(block.length).toBeGreaterThan(500);
    expect(block).not.toMatch(/\b(update|set|remove|push)\(/);
    expect(block).not.toContain("applyMovement");
  });
});
