// ─── WHAT THIS CHANGE DID *NOT* TOUCH (2026-09-05) ───────────────────────────
//
// Hub 2 sneakers gained the grid ✕ and the Tomorrow gate. Exactly two things
// were supposed to change, and this file is the fence around everything else:
//
//   • HUB 3 (Pine) and THE SHOPS must be byte-identical to what they were the
//     day before. Pine's grid has never been gated and its queue rows have
//     never probed Central; the shops are order DESTINATIONS, never a
//     supplying hub, so they run neither surface at all.
//   • HUB 2 CLOTHING must be byte-identical. It already worked. The only thing
//     that happened to it is that its zero-test now calls availableUnits
//     instead of its own copy of the same arithmetic — a definition merge, and
//     hub2SneakerAvailability.test.js exhausts the proof that it changes no
//     answer. What is pinned HERE is that its cell LOOKUP was left alone, and
//     that its warehouse rows are still not probed at Central: a customer
//     clothing order in the central universe is stamped hub:"hub2", so the
//     first cut of the Tomorrow rule swept every one of them into the gate.
//     Review caught it; the hub2 arm is footwear-only and this file says so.
//
// NOTE ON THE COMMIT 4 "RE-PIN": there was nothing to re-pin. The pre-change
// App.jsx comment claimed hub2's exclusion was "pinned by test", but no test on
// main asserted it — the fences below are the first. Said plainly rather than
// implying an old pin was re-scoped.
//
// A note on shape: the two hub predicates were lifted out of App.jsx into the
// pure modules they belong to (gatedSneakerHub → availabilityCore, centralFedRow
// → tomorrowGate) precisely so these fences could be behavioural tests rather
// than source-string pins alone. Source pins remain where the behaviour lives
// inside the component and cannot be reached any other way.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gatedSneakerHub, GATED_SNEAKER_HUBS, readyPromisedByCell, cellAvailability } from "./availabilityCore";
import { centralFedRow, CENTRAL_FED_HUBS, tomorrowTapOutcome } from "./tomorrowGate";
import { orderSizeOut } from "../../utils/deactivation";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, p), "utf8");
const app = () => src("../../App.jsx");

const SNEAKER  = { id: "s1", category: "Footwear", productType: "sneaker" };
const CLOTHING = { id: "c1", category: "Clothing", productType: "clothing" };
const PERFUME  = { id: "f1", category: "Perfumes" };
const SHOPS = ["marathon-pe", "trophy", "pine", "central"];

// ─── FENCE 1: HUB 3 AND THE SHOPS ────────────────────────────────────────────
describe("Hub 3 and the shops are untouched by the sneaker availability gate", () => {
  it("the gate covers hub1 and hub2 — and nothing else, ever", () => {
    expect(GATED_SNEAKER_HUBS).toEqual(["hub1", "hub2"]);
  });
  it("a Pine-routed sneaker gets NO gate — the tile behaves as it did yesterday", () => {
    expect(gatedSneakerHub(SNEAKER, "hub3")).toBe(null);
  });
  it("a shop is never the supplying hub — no shop id can arm the gate", () => {
    for (const shop of SHOPS) expect(gatedSneakerHub(SNEAKER, shop)).toBe(null);
  });
  it("hub1 and hub2 DO arm it, and each answers as itself", () => {
    expect(gatedSneakerHub(SNEAKER, "hub1")).toBe("hub1");
    expect(gatedSneakerHub(SNEAKER, "hub2")).toBe("hub2");
  });
  it("a null / missing / unknown routing answer never arms it", () => {
    for (const h of [null, undefined, "", "hubC", "hub9", "HUB1"]) {
      expect(gatedSneakerHub(SNEAKER, h)).toBe(null);
    }
  });
  it("non-footwear keeps yesterday's behaviour even on a gated hub (PR #446 rule)", () => {
    expect(gatedSneakerHub(CLOTHING, "hub2")).toBe(null);
    expect(gatedSneakerHub(PERFUME, "hub2")).toBe(null);
    expect(gatedSneakerHub({ ...SNEAKER, productType: "clothing" }, "hub1")).toBe(null);
    expect(gatedSneakerHub(null, "hub1")).toBe(null);
  });
  it("Pine devices subscribe to NEITHER hub subtree — no stream that could never gate", () => {
    const a = app();
    expect(a).toContain('useStockCellsState(effectiveStoreMode === "pine" ? null : "hub1")');
    expect(a).toContain('useStockCellsState(effectiveStoreMode === "pine" ? null : "hub2")');
  });
  it("hub3 promises never book a hub1 or hub2 cell", () => {
    const rows = [{ status: "ready", productId: "s1", size: "8", hub: "hub3", placedAtHub: "hub3" }];
    const PRODUCTS = { s1: SNEAKER };
    expect(readyPromisedByCell(rows, "hub1", PRODUCTS)).toEqual({});
    expect(readyPromisedByCell(rows, "hub2", PRODUCTS)).toEqual({});
    expect(readyPromisedByCell(rows, "hub3", PRODUCTS)["s1::8"]).toBe(1);
  });
});

describe("Hub 3 and the shops are untouched by the Tomorrow gate", () => {
  it("the row rule covers hub1 and hub2 — and nothing else, ever", () => {
    expect(CENTRAL_FED_HUBS).toEqual(["hub1", "hub2"]);
  });
  it("a hub3 row is NOT probed — it keeps offering Tomorrow, as it always has", () => {
    expect(centralFedRow({ hub: "hub3", placedAtHub: "hub3" })).toBe(false);
    expect(centralFedRow({ placedAtHub: "hub3" })).toBe(false);           // legacy hub-less shape
  });
  it("a hubC (customer clothing) row is NOT probed", () => {
    expect(centralFedRow({ hub: "hub1", placedAtHub: "hubC" })).toBe(false);
    expect(centralFedRow({ placedAtHub: "hubC" })).toBe(false);
  });
  it("hub1's answer is unchanged, character for character", () => {
    // The pre-2026-09-05 expression, re-evaluated here against the extracted
    // predicate for every shape a row can take. hub1 must agree everywhere.
    const legacyHub1Row = (o) => (o.hub || "hub1") === "hub1"
      && o.placedAtHub !== "hub3" && o.placedAtHub !== "hubC";
    const SHAPES = [
      {}, { hub: "hub1" }, { hub: "hub1", placedAtHub: "hub1" },
      { hub: "hub1", placedAtHub: "hub3" }, { hub: "hub1", placedAtHub: "hubC" },
      { placedAtHub: "hub1" }, { placedAtHub: "hub3" }, { placedAtHub: "hubC" },
      { hub: "hub3" }, { hub: "hub3", placedAtHub: "hub3" },
      { hub: "hubC" },
    ];
    for (const o of SHAPES) {
      if (legacyHub1Row(o)) expect(centralFedRow(o)).toBe(true);          // every old TRUE is still true
      if (!legacyHub1Row(o) && (o.hub || "hub1") !== "hub2") {
        expect(centralFedRow(o)).toBe(false);                             // and no old FALSE flipped, outside hub2
      }
      // The same sweep with a clothing productType: hub1 rows must not shift
      // either, and every hub2 clothing row must stay out of the gate.
      const c = { ...o, productType: "clothing" };
      if (legacyHub1Row(c)) expect(centralFedRow(c)).toBe(true);
      if (!legacyHub1Row(c)) expect(centralFedRow(c)).toBe(false);
    }
  });
  it("hub2 is the ONLY row class that changed", () => {
    expect(centralFedRow({ hub: "hub2" })).toBe(true);
    expect(centralFedRow({ hub: "hub2", placedAtHub: "hub2" })).toBe(true);
    expect(centralFedRow({ hub: "hub2", placedAtHub: "hub3" })).toBe(false);   // still listed under hub3 too
  });
  it("HUB 2 CLOTHING is not probed — it always offered Tomorrow and still does", () => {
    // The breach caught in review: a customer clothing order placed in the
    // central universe is stamped hub:"hub2", placedAtHub:"hub2" (App.jsx
    // placedHub = CR_HUB_BY_UNIVERSE[...] for a clothing line), so a bare hub2
    // disjunct swept every Hub 2 clothing row into the gate. Hub 2 clothing was
    // live and correct and had to stay byte-identical.
    expect(centralFedRow({ hub: "hub2", placedAtHub: "hub2", productType: "clothing" })).toBe(false);
    expect(centralFedRow({ hub: "hub2", productType: "clothing" })).toBe(false);
    // A Hub 2 SNEAKER row is the thing that changed, and only it.
    expect(centralFedRow({ hub: "hub2", placedAtHub: "hub2", productType: "sneaker" })).toBe(true);
    expect(centralFedRow({ hub: "hub2", placedAtHub: "hub2" })).toBe(true);   // untyped = sneaker, the app's default
  });
  it("HUB 1 carries no type test at all — its rule is the 2026-08-25 one, verbatim", () => {
    // hub1 stocks no clothing, so there is nothing to filter; adding a test
    // there for symmetry would be a behaviour change to a rule already right.
    expect(centralFedRow({ hub: "hub1", productType: "clothing" })).toBe(true);
    expect(centralFedRow({ productType: "clothing" })).toBe(true);
  });
  it("the fail-open rule is untouched: unknown Central availability still offers Tomorrow", () => {
    expect(tomorrowTapOutcome(null)).toBe("tomorrow");
    expect(tomorrowTapOutcome(0)).toBe("out_of_stock");
    expect(tomorrowTapOutcome(1)).toBe("tomorrow");
  });
  it("an ungated row still short-circuits to the Tomorrow outcome, with no read", () => {
    const a = app();
    expect(a).toContain('if (!gatedRow) { await onOutcome("tomorrow"); return; }');
    expect(a).toContain("if (!gatedRow) return undefined;");
  });
});

// ─── FENCE 2: HUB 2 CLOTHING ─────────────────────────────────────────────────
describe("Hub 2 clothing behaves exactly as it did before this change", () => {
  it("clothing never enters the sneaker gate, at hub2 or anywhere", () => {
    expect(gatedSneakerHub(CLOTHING, "hub2")).toBe(null);
    expect(gatedSneakerHub(CLOTHING, "hub1")).toBe(null);
  });
  it("orderSizeOut is still the clothing predicate, unchanged", () => {
    expect(orderSizeOut(CLOTHING, { clothingOrder: true, hubQty: 0 })).toBe(true);
    expect(orderSizeOut(CLOTHING, { clothingOrder: true, hubQty: 1 })).toBe(false);
    // A sneaker never gets the clothing zero-test — that is the sneaker gate's job.
    expect(orderSizeOut(SNEAKER, { clothingOrder: false, hubQty: 0 })).toBe(false);
  });
  it("the clothing cell LOOKUP was left alone — raw declared size, not decodedCellKey", () => {
    // Deliberate, and the one thing that must not be "tidied up": the sneaker
    // lane resolves "Free Size" to the "_" cell, clothing does not. Merging
    // them would change which cell a live Hub 2 clothing size reads.
    expect(app()).toContain("const hubQty = (pid, size) => availableUnits(servingHubCells?.[pid]?.[size]?.qty);");
  });
  it("the clothing grey-out still reads the SERVING hub, chosen by universe", () => {
    const a = app();
    expect(a).toContain('const servingHub = CR_HUB_BY_UNIVERSE[effectiveStoreMode] || "hub2";');
    expect(a).toContain("const servingHubCells = useStockCells(servingHub);");
    expect(a).toContain('const CR_HUB_BY_UNIVERSE = { central: "hub2", pine: "hub3" };');
  });
  it("clothing nets no promises — the resolver's promise term is footwear-only", () => {
    const rows = [{ status: "ready", productId: "c1", size: "M", hub: "hub2" }];
    expect(readyPromisedByCell(rows, "hub2", { c1: CLOTHING })).toEqual({});
  });
  it("all three clothing chip surfaces still go through orderSizeOut", () => {
    expect(app().split("orderSizeOut(").length - 1).toBeGreaterThanOrEqual(3);
  });
});

// ─── FENCE 3: THE DISPLAY-PAIR LANE STAYS HUB 1'S ────────────────────────────
// Display slots and the display register are hub1-scoped, and
// pendingDisplayPullsByCell is NOT hub-scoped at all. Letting Hub 2 ride those
// would put a Hub 1 pull claim's ✕ on an unrelated Hub 2 cell.
describe("the display-pair lane did not follow the gate to Hub 2", () => {
  it("the marker predicate is still hub1-only, separate from sneakerHubOf", () => {
    const a = app();
    expect(a).toContain('const sneakerServedByHub1 = (p) => sneakerHubOf(p) === "hub1";');
    expect(a).toContain('const hub1DisplayRegister = useDisplayRegister("hub1"');
    expect(a).toContain('displayUnitsByCell(displaySlots, "hub1", hub1DisplayRegister)');
  });
  it("hub2's promised map is READY ORDERS ONLY — no pull claims folded in", () => {
    const a = app();
    expect(a).toContain('readyPromisedByCell(orders, "hub2", productsById)');
    expect(a).not.toContain('mergePromised(hub2ReadyPromised');
  });
  it("the display-only check still asks Hub 1 explicitly", () => {
    expect(app()).toContain('const avail = sneakerAvail(p.id, s, "hub1") - sneakerInCart(p.id, s);');
  });
});

// ─── FENCE 4: ONE PATH, NOT THREE ────────────────────────────────────────────
describe("Hub 2 did not get its own code path", () => {
  it("there is no hub2-specific gate, predicate or note function", () => {
    const a = app();
    for (const forbidden of ["hub2SneakerOut", "sneakerOutHub2", "hub2Avail", "sneakerServedByHub2"]) {
      expect(a).not.toContain(forbidden);
    }
  });
  it("one sneakerOut, and it routes by hub name", () => {
    const a = app();
    expect(a).toContain("const sneakerOut = (p, s) => {");
    expect(a).toContain("const hub = sneakerHubOf(p);");
    expect(a).toContain("sneakerAvail(p.id, s, hub) <= sneakerInCart(p.id, s)");
    expect(a).toContain('const sneakerCellsState = (hub) => (hub === "hub2" ? hub2CellsState : hub1CellsState);');
    expect(a).toContain('const sneakerPromisedMap = (hub) => (hub === "hub2" ? hub2ReadyPromised : hub1Promised);');
  });
  it("the gate never opens before that hub's own subtree has settled", () => {
    expect(app()).toContain("return !!hub && st.settled && !st.error;");
  });
  it("the ✕ note names the hub that refused, not a hard-coded Hub 1", () => {
    const a = app();
    expect(a).toContain('const hub = w?.hubLabel || "Hub 1";');
    expect(a).toContain("hubLabel: HUB_LABELS[hub] || hub,");
    expect(a).toContain("Size ${sz} isn't available at ${hub} right now");
  });
  it("both hubs land on the same arithmetic, value for value", () => {
    const PRODUCTS = { s1: SNEAKER };
    const cells = { s1: { 8: { qty: 2 } } };
    const NOW = Date.parse("2026-09-05T10:05:00.000Z");
    const answers = ["hub1", "hub2"].map((h) => {
      const promised = readyPromisedByCell(
        [{ status: "ready", productId: "s1", size: "8", hub: h, readyAt: "2026-09-05T10:00:00.000Z" }],
        h, PRODUCTS, NOW);
      return cellAvailability({ cells, promised, productId: "s1", size: "8" });
    });
    expect(answers).toEqual([1, 1]);
  });
});
