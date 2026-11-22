// ─── DESTINATIONS FOLLOW THE DIVISION LIST YOU ARE STANDING IN ───────────────
// Junid, 22 Nov 2026. Enforced twice: the chooser renders only the allowed
// destinations, and the confirm step refuses a payload carrying any other —
// so a stale screen cannot write a wrong one.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sneakerDestinations, shopDestinations, shopsAreExclusive, switchShopPick, destinationProblem, concreteSectionOf } from "./divisionDestinations";
import { SEED_REGISTRY } from "../../utils/networkRegistry";

const N = SEED_REGISTRY;
const MARATHON = 2, CONCRETE = 1;

describe("what each list offers", () => {
  it("Concrete: sneakers → Hub 3 only; everything else → Pine and Concrete only, no hub", () => {
    expect(concreteSectionOf(N)).toBe(CONCRETE);
    expect(sneakerDestinations(N, CONCRETE, { solveOnly: false })).toEqual(["hub3"]);
    expect([...shopDestinations(N, CONCRETE)].sort()).toEqual(["concrete", "marathon-pine"]);
    expect(shopDestinations(N, CONCRETE).some((s) => /hub/.test(s))).toBe(false);
  });
  it("Marathon: sneakers → Hub 1 and Hub 2 only, never Hub 3; everything else → Marathon's shops, never Pine or Concrete", () => {
    expect(sneakerDestinations(N, MARATHON)).toEqual(["hub1", "hub2"]);
    expect([...shopDestinations(N, MARATHON)].sort()).toEqual(["marathon-pe", "trophy"]);
  });
  it("Pine and Concrete are one or the other; Marathon's shops are not", () => {
    expect(shopsAreExclusive(N, CONCRETE)).toBe(true);
    expect(shopsAreExclusive(N, MARATHON)).toBe(false);
  });
});

describe("switchShopPick", () => {
  const x = { exclusive: true };
  it("Pine then Concrete gives Concrete only; Concrete then Pine gives Pine only", () => {
    expect(switchShopPick(["marathon-pine"], "concrete", x)).toEqual(["concrete"]);
    expect(switchShopPick(["concrete"], "marathon-pine", x)).toEqual(["marathon-pine"]);
  });
  it("both together is impossible, whatever is tapped in whatever order — and no tap is a no-op", () => {
    const walk = (sel, depth) => {
      expect(sel.length).toBeLessThanOrEqual(1);
      if (!depth) return;
      for (const t of ["marathon-pine", "concrete"]) {
        const next = switchShopPick(sel, t, x);
        expect(next).not.toEqual(sel);
        walk(next, depth - 1);
      }
    };
    walk([], 6);
  });
  it("Marathon's shops tick freely, in the order ticked", () => {
    expect(switchShopPick(["trophy"], "marathon-pe")).toEqual(["trophy", "marathon-pe"]);
    expect(switchShopPick(["trophy", "marathon-pe"], "trophy")).toEqual(["marathon-pe"]);
  });
});

describe("destinationProblem — what Confirm refuses", () => {
  const p = (section, kind, destinations) => destinationProblem({ network: N, section, kind, destinations });
  it("passes each list's own destinations", () => {
    expect(p(CONCRETE, "sneaker", ["hub3"])).toBeNull();
    expect(p(MARATHON, "sneaker", ["hub1"])).toBeNull();
    expect(p(MARATHON, "sneaker", ["hub2"])).toBeNull();
    expect(p(CONCRETE, "product", ["marathon-pine"])).toBeNull();
    expect(p(CONCRETE, "product", ["concrete"])).toBeNull();
    expect(p(MARATHON, "product", ["marathon-pe", "trophy"])).toBeNull();
  });
  it("refuses a cross-division destination, on every list and for both kinds", () => {
    expect(p(CONCRETE, "sneaker", ["hub1"])).toMatch(/Hub 1 is not a destination on the "Missing from Concrete" list.*Missing from Marathon/);
    expect(p(CONCRETE, "sneaker", ["hub3", "hub2"])).toMatch(/Hub 2 is not a destination/);
    expect(p(MARATHON, "sneaker", ["hub3"])).toMatch(/Hub 3 is not a destination on the "Missing from Marathon" list.*Missing from Concrete/);
    expect(p(MARATHON, "sneaker", ["hub1", "hub3"])).toMatch(/Hub 3 is not a destination/);
    expect(p(CONCRETE, "product", ["trophy"])).toMatch(/Trophy is not a destination/);
    expect(p(CONCRETE, "product", ["concrete", "marathon-pe"])).toMatch(/Marathon PE is not a destination/);
    expect(p(MARATHON, "product", ["concrete"])).toMatch(/Concrete is not a destination/);
    expect(p(MARATHON, "product", ["marathon-pe", "marathon-pine"])).toMatch(/Marathon Pine is not a destination/);
  });
  it("refuses a hub as a clothing destination, and a shop as a sneaker destination", () => {
    expect(p(CONCRETE, "product", ["hub3"])).toMatch(/Hub 3 is not a destination/);
    expect(p(MARATHON, "sneaker", ["trophy"])).toMatch(/Trophy is not a destination/);
  });
  it("refuses Pine + Concrete together, and Hub 1 + Hub 2 together", () => {
    expect(p(CONCRETE, "product", ["marathon-pine", "concrete"])).toMatch(/cannot both be solved for the same product/);
    expect(p(MARATHON, "sneaker", ["hub1", "hub2"])).toMatch(/never share a sneaker/);
  });
  it("refuses an empty payload", () => {
    expect(p(CONCRETE, "sneaker", [])).toBe("Pick a hub first.");
    expect(p(MARATHON, "product", [])).toBe("Tick at least one store.");
    expect(p(MARATHON, "product", null)).toBe("Tick at least one store.");
  });
});

// ── THE SECOND GATE IS WIRED: before any read, before any write ──────────────
const here = dirname(fileURLToPath(import.meta.url));
const FOOT = readFileSync(join(here, "MissingFootwear.jsx"), "utf8");
const NET = readFileSync(join(here, "NetworkTransfer.jsx"), "utf8");
const body = (src, start) => { const a = src.indexOf(start); return src.slice(a, src.indexOf("\n  };\n", a)); };

describe("Confirm asks destinationProblem of the payload it is about to write", () => {
  it("the sneaker request: refused before the plan, the live read and the update — on both writers", () => {
    const solve = body(FOOT, "  const solve = async (card, only = null) => {");
    const gate = solve.indexOf('destinationProblem({ network, section, destinations: picked, kind: "sneaker" })');
    expect(gate).toBeGreaterThan(-1);
    for (const later of ["solveDivision(card, picked, !!only)", "readPathOnce(", "update(ref(database)"]) expect(solve.indexOf(later)).toBeGreaterThan(gate);
    const division = body(FOOT, "  const solveDivision = async (card, hubs, oneTap = false) => {");
    const gate2 = division.indexOf('destinationProblem({ network, section, destinations: hubs, kind: "sneaker" })');
    expect(gate2).toBeGreaterThan(-1);
    for (const later of ["readPathOnce(", "httpsCallable(", "update(ref(database)"]) expect(division.indexOf(later)).toBeGreaterThan(gate2);
  });
  it("the clothing Solve: refused before the optimistic hide, every read and the update", () => {
    const solve = body(NET, "  const solve = async (card, only = null) => {");
    const gate = solve.indexOf('destinationProblem({ network, section: division, destinations: ticks, kind: "product" })');
    expect(gate).toBeGreaterThan(-1);
    for (const later of ['setResolving((m) => ({ ...m, [card.pid]: "pending" }))', "readOpenLocks(card.pid)", "await update(ref(database), updates)"]) expect(solve.indexOf(later)).toBeGreaterThan(gate);
  });
  it("the choosers render from the same module the gate reads", () => {
    expect(FOOT).toContain("const SOLVE_HUBS = useMemo(() => sneakerDestinations(network, section), [network, section]);");
    expect(NET).toContain("const solveSectionsFor = (card) => [divisionOf(card)].filter((x) => mySections.includes(x));");
    expect(NET).toContain("switchShopPick(cur, store, { exclusive: shopsAreExclusive(network, divisionOf(card)) })");
  });
});
