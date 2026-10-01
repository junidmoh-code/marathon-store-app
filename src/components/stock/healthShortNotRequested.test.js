// ─── "SHORT BUT NOT REQUESTED" — THE SCREEN READS WHAT THE SCAN WRITES ───────
// exceptions.shortNotRequested is produced by functions/lib/refill-engine.cjs
// and drawn by HealthView.jsx: two runtimes, no import between them, held
// together only by the key string and the row fields. A rename on either side
// would leave the card reading 0, GREEN, forever — the exact silence this card
// exists to end. So: run the real engine on a snapshot that MUST populate the
// list (non-zero, or the wiring check is vacuous), then hold the screen source
// to that key, those fields, and the engine's reason vocabulary.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const { createRequire } = await import("node:module");
const req = createRequire(import.meta.url);
const engine = req("../../../functions/lib/refill-engine.cjs");
const health = readFileSync(fileURLToPath(new URL("./HealthView.jsx", import.meta.url)), "utf8");
const engineSrc = readFileSync(fileURLToPath(new URL("../../../functions/lib/refill-engine.cjs", import.meta.url)), "utf8");

const cell = (qty) => ({ qty, v: 1 });
const NOW = Date.parse("2026-09-23T10:00:00Z");
// PE / M exactly as the owner found it, but with Central EMPTY — the one shape
// no automation can fix (a disputed hub count and nothing else anywhere), so
// it must stay visible.
const snapshot = {
  nowMs: NOW,
  config: {
    mode: { hub2: "live", "marathon-pe": "live", trophy: "live" },
    routes: { hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
    ruleBasedTargets: false, maxIntentsPerRun: 75, maxUnitsPerIntent: 20, rejectStreakLimit: 4, recheckCooldownMinutes: 1440,
  },
  products: { tr: { id: "tr", name: "Nike Tech Fleece Tracksuit Brown 2", productType: "clothing", sizes: ["M"] } },
  targets: { "marathon-pe": { tr: { M: { target: 2, minQty: 1 } } }, hub2: { tr: { M: { target: 3, minQty: 2 } } } },
  stock: { "marathon-pe": { tr: { M: cell(0) } }, hub2: { tr: { M: cell(3) } }, central: {}, trophy: {} },
  rejectStreak: { "marathon-pe": { tr: { M: { count: 4, by: "hub2", lastTs: "2026-09-17T14:15:22.516Z" } } } },
  openIndex: {}, refillRequests: {}, orders: {}, movements: [], targetDecisions: {}, retryState: {}, heldLines: {},
};

describe("short but not requested: scan → /stock_exceptions → Health", () => {
  const ex = engine.computeRefillPlan(snapshot).exceptions;
  const key = "shortNotRequested";

  it("the engine fills the list for this snapshot (so the wiring check is not vacuous)", () => {
    expect(ex[key].count).toBe(1);
    expect(ex[key].items[0]).toMatchObject({ loc: "marathon-pe", pid: "tr", size: "M", have: 0, keep: 2, hub: "hub2", hubHas: 3, upstream: "central", upHas: 0, reason: "recount" });
    expect(ex[key].shops).toEqual(["marathon-pe", "trophy"]);
  });

  it("HealthView draws a card AND a detail screen for it", () => {
    expect(health).toContain(`value={count("${key}")}`);
    expect(health).toContain(`onClick={() => setScreen("${key}")}`);
    expect(health).toContain(`case "${key}"`);
    expect(health).toContain(`items("${key}")`);
    expect(health).toContain(`count={count("${key}")}`);
  });

  it("every field the screen reads is a field the engine writes", () => {
    for (const f of ["loc", "pid", "size", "have", "keep", "hub", "hubHas", "upstream", "upHas", "reason"]) {
      expect(ex[key].items[0]).toHaveProperty(f);
      if (f !== "pid") expect(health).toContain(`r.${f}`);
    }
    for (const f of ["byReason", "shops"]) {
      expect(ex[key]).toHaveProperty(f);
      expect(health).toContain(`snr.${f}`);
    }
  });

  it("the screen translates exactly the reasons the engine records — no more, no fewer", () => {
    const block = health.slice(health.indexOf(`case "${key}"`), health.indexOf('case "unarmedFootwear"'));
    const screenReasons = [...block.matchAll(/^\s+([a-z_]+): "/gm)].map((m) => m[1]).sort();
    const engineReasons = [...engineSrc.matchAll(/parked\(dest, pid, sizeKey, "([a-z_]+)"\)/g)].map((m) => m[1]);
    // The two reasons the list assigns itself, and the three the awaitingSupplier
    // site picks between.
    engineReasons.push("throttled", "upstream_blocked", "hub_no_target");
    // chain_empty / nothing_anywhere cannot reach the list (upstream holds the
    // size by construction) and fall to the screen's "Unexplained — report
    // this" line on purpose.
    const expected = [...new Set(engineReasons)].filter((r) => r !== "chain_empty" && r !== "nothing_anywhere").sort();
    expect(screenReasons).toEqual(expected);
  });

  it("read-only surface — the screen writes nothing", () => {
    const block = health.slice(health.indexOf(`case "${key}"`), health.indexOf('case "unarmedFootwear"'));
    expect(block.length).toBeGreaterThan(500);
    expect(block).not.toMatch(/\b(update|set|remove|push)\(/);
    expect(block).not.toContain("applyMovement");
  });
});
