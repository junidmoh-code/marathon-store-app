// ─── SOLVE'S CARRIAGE GATE — BEHAVIOURAL TESTS ────────────────────────────────
// Run: npx vitest run src/components/stock/solveCarriage.test.js
//
// The regression under test is a LIE, not a crash: Solve seeds a cell and says "the
// engine will refill on its next scan" while the engine refuses the line. Nothing
// throws, nothing logs, the row leaves Missing Products looking handled. So every
// test here asserts the ANSWER Solve gives, and the writes it makes, against the
// engine's real predicate — never that a function was called.
//
// Each test names the mutation it exists to catch; mutation proof is in
// scripts/mutation-proof-solve-carriage.mjs.

import { describe, it, expect } from "vitest";
import {
  carriageAt, solveCarriagePlan, introduceUpdates, carriageNotice,
  indexReadyAt, carriesByEntry, introducedAt,
  CARRIED, INTRODUCE, BLOCKED,
} from "./solveCarriage";

const PID = "p1784206551366";                 // "Nike NOCTA Golf T-Shirt White"
const SIZES = ["S", "M", "L", "XL", "XXL"];
const ready = (...locs) => Object.fromEntries(locs.map((l) => [l, { at: "2026-08-18T06:00:00.000Z", pairs: 12, version: 1 }]));

describe("indexReadyAt — strict, and matching the engine", () => {
  it("accepts a complete sentinel at the current version", () => {
    expect(indexReadyAt(ready("hub2"), "hub2")).toBe(true);
  });
  it("refuses absent, wrong-version, and half-written sentinels", () => {
    expect(indexReadyAt({}, "hub2")).toBe(false);
    expect(indexReadyAt(null, "hub2")).toBe(false);
    expect(indexReadyAt({ hub2: { at: "x", pairs: 1, version: 2 } }, "hub2")).toBe(false);
    expect(indexReadyAt({ hub2: { at: "", pairs: 1, version: 1 } }, "hub2")).toBe(false);
    expect(indexReadyAt({ hub2: { at: "x", version: 1 } }, "hub2")).toBe(false);
    expect(indexReadyAt({ hub2: [] }, "hub2")).toBe(false);
  });
  it("is per-location — one ready shop says nothing about another", () => {
    const m = ready("hub2");
    expect(indexReadyAt(m, "hub2")).toBe(true);
    expect(indexReadyAt(m, "trophy")).toBe(false);
  });
});

describe("carriesByEntry — identical to the engine's predicate", () => {
  it("a single recorded sale is enough", () => {
    expect(carriesByEntry({ s: 1 })).toBe(true);
  });
  it("stocked units count NET of undos", () => {
    expect(carriesByEntry({ k: 5 })).toBe(true);
    expect(carriesByEntry({ k: 5, u: 5 })).toBe(false);   // the Lacoste case
    expect(carriesByEntry({ k: 5, u: 6 })).toBe(false);
  });
  it("absent or empty is false — the fail-closed direction", () => {
    expect(carriesByEntry(null)).toBe(false);
    expect(carriesByEntry({})).toBe(false);
    expect(carriesByEntry({ k: 0, s: 0 })).toBe(false);
  });
});

describe("carriageAt — the three outcomes", () => {
  const base = { provenance: {}, provenanceMeta: ready("hub2"), targets: {}, categoryPolicy: {}, categoryKey: "t-shirts", pid: PID };

  it("CARRIED when the index says the shop has sold or stocked it", () => {
    const r = carriageAt({ ...base, provenance: { hub2: { [PID]: { s: 4 } } }, loc: "hub2" });
    expect(r.state).toBe(CARRIED);
    expect(r.via).toBe("provenance");
  });

  it("INTRODUCE when the index is ready and genuinely has nothing", () => {
    const r = carriageAt({ ...base, loc: "hub2" });
    expect(r.state).toBe(INTRODUCE);
  });

  it("BLOCKED when the index is not ready — 'no' and 'don't know' must not be merged", () => {
    // The whole point. An unready index looks exactly like an empty one, and the two
    // demand opposite actions: introduce vs wait. Merging them is how a fail-closed
    // design becomes a fail-silent one.
    const r = carriageAt({ ...base, provenanceMeta: {}, loc: "hub2" });
    expect(r.state).toBe(BLOCKED);
    expect(r.reason).toBe("index-unready");
  });

  it("an existing introduce row wins BEFORE the readiness check", () => {
    // Mirrors storeCarries(): the opt-in is owner intent off the row, so it stands
    // during the window where the index has not been built. Checking readiness first
    // would block a pair the engine would arm.
    const r = carriageAt({
      ...base, provenanceMeta: {},
      targets: { hub2: { [PID]: { M: { introduce: true } } } }, loc: "hub2",
    });
    expect(r.state).toBe(CARRIED);
    expect(r.via).toBe("introduce");
  });

  it("a categoryPolicy introduction also counts — the engine's second branch", () => {
    const r = carriageAt({
      ...base, provenanceMeta: {},
      categoryPolicy: { "t-shirts": { hub2: { introduce: true } } }, loc: "hub2",
    });
    expect(r.state).toBe(CARRIED);
  });

  it("introducedAt is strictly === true — a truthy value is not an opt-in", () => {
    for (const v of [1, "true", "yes", {}]) {
      expect(introducedAt({ hub2: { [PID]: { M: { introduce: v } } } }, {}, "t-shirts", "hub2", PID)).toBe(false);
    }
    expect(introducedAt({ hub2: { [PID]: { M: { introduce: true } } } }, {}, "t-shirts", "hub2", PID)).toBe(true);
  });
});

describe("solveCarriagePlan — all-or-nothing across the seed locations", () => {
  const base = { pid: PID, sizes: SIZES, targets: {}, categoryPolicy: {}, categoryKey: "t-shirts" };

  it("a central-stranded solve with both locations carried just seeds", () => {
    const plan = solveCarriagePlan({
      ...base, locs: ["hub2", "trophy"],
      provenanceMeta: ready("hub2", "trophy"),
      provenance: { hub2: { [PID]: { k: 10 } }, trophy: { [PID]: { s: 2 } } },
    });
    expect(plan.ok).toBe(true);
    expect(plan.introduce).toHaveLength(0);
    expect(plan.carried).toHaveLength(2);
  });

  it("names every location that needs introducing", () => {
    const plan = solveCarriagePlan({
      ...base, locs: ["hub2", "trophy"],
      provenanceMeta: ready("hub2", "trophy"),
      provenance: { hub2: { [PID]: { k: 10 } } },
    });
    expect(plan.ok).toBe(true);
    expect(plan.introduce.map((i) => i.loc)).toEqual(["trophy"]);
  });

  it("ONE unready location blocks the WHOLE solve, including the readable half", () => {
    // central→hub2→store is one causal chain. Seeding only the half we can vouch for
    // leaves demand that can never complete — the same false promise, one step later.
    const plan = solveCarriagePlan({
      ...base, locs: ["hub2", "trophy"],
      provenanceMeta: ready("hub2"),                 // trophy unready
      provenance: { hub2: { [PID]: { k: 10 } } },
    });
    expect(plan.ok).toBe(false);
    expect(plan.blocked.map((b) => b.loc)).toEqual(["trophy"]);
    expect(plan.message).toContain("trophy");
    expect(plan.message).toContain("Nothing was seeded");
  });

  it("blocks with NO index at all — the state the network is in before the backfill", () => {
    const plan = solveCarriagePlan({ ...base, locs: ["hub2"], provenanceMeta: {}, provenance: {} });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe("index-unready");
  });
});

describe("introduceUpdates — the row shape is the design", () => {
  const plan = { introduce: [{ loc: "trophy" }], ok: true };

  it("writes one leaf set per declared size, and NEVER a numeric target", () => {
    const u = introduceUpdates({ plan, pid: PID, sizes: ["S", "M"], at: "T", by: "uid", note: "n" });
    expect(Object.keys(u).sort()).toEqual([
      `stock_targets/trophy/${PID}/M/introduce`,
      `stock_targets/trophy/${PID}/M/introducedAt`,
      `stock_targets/trophy/${PID}/M/introducedBy`,
      `stock_targets/trophy/${PID}/M/note`,
      `stock_targets/trophy/${PID}/S/introduce`,
      `stock_targets/trophy/${PID}/S/introducedAt`,
      `stock_targets/trophy/${PID}/S/introducedBy`,
      `stock_targets/trophy/${PID}/S/note`,
    ]);
    // A `target` here would pin the quantities and outrank the size run forever.
    expect(Object.keys(u).some((k) => k.endsWith("/target") || k.endsWith("/minQty"))).toBe(false);
    expect(u[`stock_targets/trophy/${PID}/S/introduce`]).toBe(true);
  });

  it("writes nothing for a carried location", () => {
    expect(introduceUpdates({ plan: { introduce: [] }, pid: PID, sizes: ["S"], at: "T", by: "u", note: "n" })).toEqual({});
  });

  it("encodes the size key — a half size must not create a key RTDB rejects", () => {
    const u = introduceUpdates({ plan, pid: PID, sizes: ["5.5"], at: "T", by: "u", note: "n" });
    expect(Object.keys(u)[0]).toContain("/5_5/");
    expect(Object.keys(u).some((k) => k.includes("5.5"))).toBe(false);
  });
});

describe("carriageNotice — the user reads the consequence, not a reassurance", () => {
  it("says nothing when everything is already carried", () => {
    expect(carriageNotice({ plan: { ok: true, introduce: [] } })).toBe(null);
  });

  it("names the shop, the absence of history, AND the units it will raise", () => {
    const n = carriageNotice({
      plan: { ok: true, introduce: [{ loc: "trophy" }] },
      labelFor: () => "Trophy",
      unitsFor: () => 9,
    });
    expect(n.tone).toBe("introduce");
    expect(n.text).toContain("Trophy");
    expect(n.text).toContain("never stocked");
    expect(n.text).toContain("9 units");
    expect(n.text).toContain("standing decision");
  });

  it("surfaces the blocked reason verbatim rather than a generic failure", () => {
    const plan = solveCarriagePlan({
      locs: ["hub2"], pid: PID, sizes: SIZES, provenanceMeta: {}, provenance: {},
      targets: {}, categoryPolicy: {}, categoryKey: "t-shirts",
    });
    const n = carriageNotice({ plan, labelFor: () => "Hub 2" });
    expect(n.tone).toBe("blocked");
    expect(n.text).toContain("hasn't been built");
  });
});

describe("the live case this shipped for", () => {
  // hub2 × NOCTA on 2026-08-18: five seed cells, provenance absent, marathon-pe has
  // sold 4. Before this gate, Solve would seed and promise a refill the engine refuses.
  it("with the index ready, hub2 needs introducing and marathon-pe does not", () => {
    const provenance = { "marathon-pe": { [PID]: { s: 4 } } };
    const meta = ready("hub2", "marathon-pe");
    const args = { pid: PID, sizes: SIZES, provenance, provenanceMeta: meta, targets: {}, categoryPolicy: {}, categoryKey: "t-shirts" };
    expect(solveCarriagePlan({ ...args, locs: ["hub2"] }).introduce.map((i) => i.loc)).toEqual(["hub2"]);
    expect(solveCarriagePlan({ ...args, locs: ["marathon-pe"] }).introduce).toHaveLength(0);
  });

  it("TODAY — with no sentinel written yet, the same press is BLOCKED, not seeded", () => {
    const plan = solveCarriagePlan({
      locs: ["hub2"], pid: PID, sizes: SIZES,
      provenance: {}, provenanceMeta: {},          // live state before the backfill
      targets: {}, categoryPolicy: {}, categoryKey: "t-shirts",
    });
    expect(plan.ok).toBe(false);
    expect(introduceUpdates({ plan, pid: PID, sizes: SIZES, at: "T", by: "u", note: "n" })).toEqual({});
  });
});
