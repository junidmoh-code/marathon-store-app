import { describe, it, expect } from "vitest";
import { routeLine as routeLineWhy, routeLines as routeLinesWhy, availableAt, ROUTED_LOCATIONS, shelfRisk, routingRulesFrom, chainOrder, FOOTWEAR_ROUTE, OTHER_ROUTE } from "./routing.mjs";

// The place and the quantity are what these older cases pin; `why` (routing's own words) has its own cases below.
const bare = (pieces) => pieces.map(({ why, ...p }) => p);
const routeLine = (a) => bare(routeLineWhy(a));
const routeLines = (...a) => routeLinesWhy(...a).map(bare);

const pick = (locationId, qty = 1) => ({ qty, locationId, status: "pick" });
const display = (locationId, qty = 1) => ({ qty, locationId, status: "display" });
const none = (qty = 1) => ({ qty, locationId: null, status: "no_stock" });

describe("routeLine — footwear and slides", () => {
  it("hub1 when it has the size", () => {
    expect(routeLine({ qty: 1, isFootwear: true, available: { hub1: 1, hub2: 5 } })).toEqual([pick("hub1")]);
  });
  it("hub2 when hub1 does not", () => {
    expect(routeLine({ qty: 1, isFootwear: true, available: { hub1: 0, hub2: 2 } })).toEqual([pick("hub2")]);
  });
  it("never a shop, even when a shop shows units", () => {
    expect(routeLine({ qty: 1, isFootwear: true, available: { "marathon-pe": 3, trophy: 3 } })).toEqual([none()]);
  });
  it("no_stock when neither hub has it", () => {
    expect(routeLine({ qty: 1, isFootwear: true, available: {} })).toEqual([none()]);
  });
  it("qty 2 with one at hub1 splits hub1 ×1 then hub2 ×1", () => {
    expect(routeLine({ qty: 2, isFootwear: true, available: { hub1: 1, hub2: 4 } })).toEqual([pick("hub1"), pick("hub2")]);
  });
  it("qty 2 both at hub1 stays one line", () => {
    expect(routeLine({ qty: 2, isFootwear: true, available: { hub1: 2 } })).toEqual([pick("hub1", 2)]);
  });
  it("qty 3, one at each hub, leaves the third as no_stock", () => {
    expect(routeLine({ qty: 3, isFootwear: true, available: { hub1: 1, hub2: 1 } })).toEqual([pick("hub1"), pick("hub2"), none()]);
  });
});

describe("routeLine — everything else", () => {
  it("Marathon PE first", () => {
    expect(routeLine({ qty: 1, isFootwear: false, available: { "marathon-pe": 1, trophy: 1, hub2: 1 } })).toEqual([display("marathon-pe")]);
  });
  it("Trophy when PE has none", () => {
    expect(routeLine({ qty: 1, isFootwear: false, available: { trophy: 2, hub2: 1 } })).toEqual([display("trophy")]);
  });
  it("Hub 2 as a pick when neither shop has it", () => {
    expect(routeLine({ qty: 1, isFootwear: false, available: { hub2: 1 } })).toEqual([pick("hub2")]);
  });
  it("never hub1 (sneakers only)", () => {
    expect(routeLine({ qty: 1, isFootwear: false, available: { hub1: 9 } })).toEqual([none()]);
  });
  it("no_stock when nowhere has it", () => {
    expect(routeLine({ qty: 1, isFootwear: false, available: {} })).toEqual([none()]);
  });
  it("qty 2 with one at PE: PE ×1 then Trophy ×1", () => {
    expect(routeLine({ qty: 2, isFootwear: false, available: { "marathon-pe": 1, trophy: 1 } })).toEqual([display("marathon-pe"), display("trophy")]);
  });
  it("qty 2 with one at PE and none at Trophy: PE ×1 then Hub 2 ×1", () => {
    expect(routeLine({ qty: 2, isFootwear: false, available: { "marathon-pe": 1, hub2: 3 } })).toEqual([display("marathon-pe"), pick("hub2")]);
  });
  it("qty 4 across all three, remainder no_stock", () => {
    expect(routeLine({ qty: 4, isFootwear: false, available: { "marathon-pe": 1, trophy: 1, hub2: 1 } }))
      .toEqual([display("marathon-pe"), display("trophy"), pick("hub2"), none()]);
  });
  it("quantities always sum to the order quantity", () => {
    for (let qty = 1; qty <= 6; qty++) {
      const pieces = routeLine({ qty, isFootwear: false, available: { "marathon-pe": 1, trophy: 2, hub2: 1 } });
      expect(pieces.reduce((n, p) => n + p.qty, 0)).toBe(qty);
      expect(new Set(pieces.map((p) => p.locationId)).size).toBe(pieces.length);
    }
  });
  it("treats negative and junk availability as nothing", () => {
    expect(routeLine({ qty: 1, isFootwear: false, available: { "marathon-pe": -2, trophy: "x", hub2: NaN } })).toEqual([none()]);
  });
  it("routes nothing for a zero quantity", () => {
    expect(routeLine({ qty: 0, isFootwear: false, available: { "marathon-pe": 1 } })).toEqual([]);
  });
});

describe("routeLines — one availability picture per order", () => {
  it("two lines of the same pid/size cannot both take the last unit", () => {
    const out = routeLines(
      [{ key: "p|M", qty: 1, isFootwear: false }, { key: "p|M", qty: 1, isFootwear: false }],
      { "p|M": { "marathon-pe": 1, trophy: 1 } },
    );
    expect(out).toEqual([[display("marathon-pe")], [display("trophy")]]);
  });
  it("different sizes do not share a pool", () => {
    const out = routeLines(
      [{ key: "p|M", qty: 1, isFootwear: false }, { key: "p|L", qty: 1, isFootwear: false }],
      { "p|M": { "marathon-pe": 1 }, "p|L": { "marathon-pe": 1 } },
    );
    expect(out).toEqual([[display("marathon-pe")], [display("marathon-pe")]]);
  });
  it("does not mutate the caller's picture", () => {
    const available = { "p|M": { "marathon-pe": 1 } };
    routeLines([{ key: "p|M", qty: 1, isFootwear: false }], available);
    expect(available).toEqual({ "p|M": { "marathon-pe": 1 } });
  });
});

describe("availableAt — live cells minus other orders' holds", () => {
  it("subtracts other orders' units at that location only", () => {
    const a = availableAt({
      stockQty: { "marathon-pe": 2, trophy: 1, hub1: 3, hub2: 0 },
      holdsCell: { o1: { qty: 1, locs: { "marathon-pe": 1 } }, o2: { qty: 2, locs: { hub1: 2 } } },
      orderId: "o9",
    });
    expect(a).toEqual({ hub1: 1, hub2: 0, hub3: 0, "marathon-pe": 1, trophy: 1, concrete: 0, "marathon-pine": 0, central: 0 });
  });
  it("never counts the order's own hold against it", () => {
    const a = availableAt({ stockQty: { "marathon-pe": 1 }, holdsCell: { o1: { qty: 1, locs: { "marathon-pe": 1 } } }, orderId: "o1" });
    expect(a["marathon-pe"]).toBe(1);
  });
  it("floors at zero when holds exceed the cell", () => {
    const a = availableAt({ stockQty: { "marathon-pe": 1 }, holdsCell: { o1: { locs: { "marathon-pe": 3 } } } });
    expect(a["marathon-pe"]).toBe(0);
  });
  it("covers exactly the routed locations", () => {
    expect(Object.keys(availableAt({})).sort()).toEqual([...ROUTED_LOCATIONS].sort());
  });
});

// ── Junid, 12 Nov 2026: shops and hubs only, Marathon first, then Concrete ──
describe("routeLine — the Concrete division after Marathon (12 Nov 2026)", () => {
  it("sneakers: Hub 3 when neither Hub 1 nor Hub 2 has the size — a hub order (pick)", () => {
    expect(routeLine({ qty: 1, isFootwear: true, available: { hub3: 2 } })).toEqual([pick("hub3")]);
  });
  it("sneakers: Marathon wins — Hub 1 before Hub 3 even when Hub 3 has more", () => {
    expect(routeLine({ qty: 1, isFootwear: true, available: { hub1: 1, hub3: 9 } })).toEqual([pick("hub1")]);
  });
  it("sneakers never go to the Concrete or Pine shop", () => {
    expect(routeLine({ qty: 1, isFootwear: true, available: { concrete: 5, "marathon-pine": 5 } })).toEqual([none()]);
  });
  it("clothing: Concrete after PE, Trophy and Hub 2 — a strip entry (display)", () => {
    expect(routeLine({ qty: 1, isFootwear: false, available: { concrete: 1, "marathon-pine": 1 } })).toEqual([display("concrete")]);
  });
  it("clothing: Pine last", () => {
    expect(routeLine({ qty: 1, isFootwear: false, available: { "marathon-pine": 1 } })).toEqual([display("marathon-pine")]);
  });
  it("clothing: Hub 2 before Concrete", () => {
    expect(routeLine({ qty: 1, isFootwear: false, available: { hub2: 1, concrete: 4 } })).toEqual([pick("hub2")]);
  });
  it("clothing never goes to Hub 3 (sneakers only there)", () => {
    expect(routeLine({ qty: 1, isFootwear: false, available: { hub3: 5 } })).toEqual([none()]);
  });
  it("qty 3 splits PE ×1, Concrete ×1, Pine ×1", () => {
    expect(routeLine({ qty: 3, isFootwear: false, available: { "marathon-pe": 1, concrete: 1, "marathon-pine": 1 } }))
      .toEqual([display("marathon-pe"), display("concrete"), display("marathon-pine")]);
  });
  it("CENTRAL IS THE LAST STOP (Junid, 24 Nov 2026) — a line only Central holds goes to Central's strip", () => {
    expect(routeLine({ qty: 1, isFootwear: false, available: { central: 50 } })).toEqual([display("central")]);
    expect(routeLine({ qty: 1, isFootwear: true, available: { central: 50 } })).toEqual([display("central")]);
    expect(FOOTWEAR_ROUTE.at(-1).locationId).toBe("central");
    expect(OTHER_ROUTE.at(-1).locationId).toBe("central");
  });
  it("Central is last even when every nearer place is doubtful and Central is not", () => {
    const risk = { "marathon-pe": { risky: true, why: ["one piece", "untouched 40 days"] } };
    expect(routeLine({ qty: 1, isFootwear: false, available: { "marathon-pe": 1, central: 9 }, risk })).toEqual([display("marathon-pe")]);
  });
  it("Junid's switch takes Central out of the chain again", () => {
    expect(routeLine({ qty: 1, isFootwear: false, available: { central: 50 }, central: false })).toEqual([none()]);
  });
  it("routing reads the shops and hubs of both divisions, and Central", () => {
    expect([...ROUTED_LOCATIONS].sort()).toEqual(["central", "concrete", "hub1", "hub2", "hub3", "marathon-pe", "marathon-pine", "trophy"]);
  });
});

describe("the most trustworthy place first (Junid, 24 Nov 2026)", () => {
  const NOW = Date.UTC(2026, 10, 24, 10);
  const days = (n) => NOW - n * 864e5;
  const rules = routingRulesFrom(null);

  it("one point per proven signal; risky at two", () => {
    expect(shelfRisk({ free: 1, stampMs: days(2), nowMs: NOW, rules })).toMatchObject({ score: 1, risky: false });
    expect(shelfRisk({ free: 1, stampMs: days(40), nowMs: NOW, rules })).toMatchObject({ score: 2, risky: true, why: ["one piece", "untouched 40 days"] });
    expect(shelfRisk({ free: 3, stampMs: days(40), nowMs: NOW, rules })).toMatchObject({ score: 1, risky: false });
    expect(shelfRisk({ free: 1, stampMs: days(2), rejectedAt: days(3), nowMs: NOW, rules })).toMatchObject({ score: 2, risky: true });
    expect(shelfRisk({ free: 3, stampMs: days(40), rejectedAt: days(3), nowMs: NOW, rules })).toMatchObject({ score: 2, risky: true });
  });
  it("exactly the threshold day is not stale; a rejection older than the window scores nothing", () => {
    expect(shelfRisk({ free: 1, stampMs: days(14), nowMs: NOW, rules }).score).toBe(1);
    expect(shelfRisk({ free: 1, stampMs: days(14) - 1, nowMs: NOW, rules }).score).toBe(2);
    expect(shelfRisk({ free: 1, stampMs: days(1), rejectedAt: days(31), nowMs: NOW, rules }).score).toBe(1);
  });
  it("a shelf with no stamp gives no evidence of its age; an empty shelf is never risky", () => {
    expect(shelfRisk({ free: 1, stampMs: null, nowMs: NOW, rules })).toMatchObject({ score: 1, risky: false });
    expect(shelfRisk({ free: 0, stampMs: days(90), rejectedAt: days(1), nowMs: NOW, rules })).toMatchObject({ score: 0, risky: false });
  });
  it("the thresholds are settings; trustOff scores nothing", () => {
    const strict = routingRulesFrom({ riskyAt: 1, staleDays: 7 });
    expect(shelfRisk({ free: 2, stampMs: days(8), nowMs: NOW, rules: strict }).risky).toBe(true);
    expect(shelfRisk({ free: 1, stampMs: days(90), nowMs: NOW, rules: routingRulesFrom({ trustOff: true }) })).toMatchObject({ score: 0, risky: false });
    expect(routingRulesFrom({ riskyAt: "x", staleDays: -3, weights: { single: 2 } })).toMatchObject({ riskyAt: 2, staleDays: 14, weights: { single: 2, stale: 1, rejected: 1 } });
  });
  it("a doubtful Marathon PE piece yields to a trusted Hub 2 shelf — a hub order, like sneakers", () => {
    const risk = { "marathon-pe": { risky: true, why: ["one piece", "untouched 40 days"] } };
    const [p] = routeLineWhy({ qty: 1, isFootwear: false, available: { "marathon-pe": 1, hub2: 3 }, risk });
    expect(p).toMatchObject({ locationId: "hub2", status: "pick" });
    expect(p.why).toBe("trusted shelf, ahead of marathon-pe (one piece, untouched 40 days)");
  });
  it("a doubtful shelf is still used when it is the only place, and says so", () => {
    const risk = { hub1: { risky: true, why: ["one piece", "untouched 20 days"] } };
    const [p] = routeLineWhy({ qty: 1, isFootwear: true, available: { hub1: 1 }, risk });
    expect(p).toMatchObject({ locationId: "hub1", status: "pick" });
    expect(p.why).toMatch(/only place on the chain.*one piece, untouched 20 days/);
  });
  it("a doubtful shelf comes before Central (its rejection moves the line on at once); Central says it is the last stop", () => {
    const risk = { hub1: { risky: true, why: ["one piece"] } };
    expect(chainOrder(true, risk).map((s) => `${s.locationId}:${s.pass}`)).toEqual(["hub2:trusted", "hub3:trusted", "hub1:risky", "central:central"]);
    const pieces = routeLineWhy({ qty: 2, isFootwear: true, available: { hub1: 1, central: 4 }, risk });
    expect(bare(pieces)).toEqual([pick("hub1"), display("central")]);
    expect(pieces[1].why).toMatch(/^last stop/);
  });
  it("with no risk given the chain is walked exactly as written", () => {
    expect(routeLineWhy({ qty: 1, isFootwear: false, available: { "marathon-pe": 1, hub2: 3 } })[0]).toMatchObject({ locationId: "marathon-pe", why: "first on the chain with it" });
  });
  it("two doubtful places keep chain order between them", () => {
    const risk = { "marathon-pe": { risky: true, why: [] }, trophy: { risky: true, why: [] } };
    expect(routeLine({ qty: 2, isFootwear: false, available: { "marathon-pe": 1, trophy: 1 }, risk })).toEqual([display("marathon-pe"), display("trophy")]);
  });
});
