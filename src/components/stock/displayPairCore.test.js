// Tests for the display-pair pull decisions (displayPairCore.js). Pure — the
// module imports no firebase (asserted below); fixtures are built from the
// STORED shapes the live nodes hold.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  displayUnitsByCell, displayOnly, pendingDisplayPullsByCell, mergePromised,
  displaySlotStoreFor, depletedTaskRevivable,
} from "./displayPairCore";
import { promisedKey } from "./availabilityCore";

const SNEAKER = { id: "p1", category: "Footwear", productType: "sneaker" };
const PERFUME = { id: "pf", categoryKey: "perfumes" };   // NOT footwear
const PRODUCTS = { p1: SNEAKER, pf: PERFUME };

// The live slot shape: /settings/displaySlots/{store}/{pid}.
const SLOTS = {
  "marathon-pe": {
    p1: { size: "6", sizeKey: "6", bookedHub: "hub1", source: "registration" },
    p2: { size: "5.5", sizeKey: "5_5", bookedHub: "hub1", source: "display_refill" },
    p3: { size: null, sizeKey: null, prevSize: "8", bookedHub: "hub1", source: "display_sold" },   // tombstone
  },
  trophy: {
    p1: { size: "6", sizeKey: "6", bookedHub: "hub1", source: "registration" },  // second display, same cell
    p4: { size: "7", sizeKey: "7", bookedHub: "hub2", source: "registration" },  // OTHER hub — never hub1's
    p5: { size: "_", sizeKey: "_", bookedHub: "hub1", source: "manual" },        // one-size sentinel = not live
  },
};

describe("displayUnitsByCell — live slots per hub cell", () => {
  const m = displayUnitsByCell(SLOTS, "hub1");
  it("counts live hub1-booked slots per pid::sizeKey, with the stores", () => {
    expect(m["p1::6"]).toEqual({ units: 2, stores: ["marathon-pe", "trophy"], unverified: 0 });
    expect(m["p2::5_5"]).toEqual({ units: 1, stores: ["marathon-pe"], unverified: 0 });
  });
  it("HUB-SCOPED: a hub2-booked slot never appears in hub1's map (hub2/hub3 unchanged, pinned)", () => {
    expect(m["p4::7"]).toBeUndefined();
    expect(Object.keys(displayUnitsByCell(SLOTS, "hub2"))).toEqual(["p4::7"]);
    expect(displayUnitsByCell(SLOTS, "hub3")).toEqual({});
  });
  it("tombstoned and one-size-sentinel slots are not live", () => {
    expect(m["p3::8"]).toBeUndefined();
    expect(m["p5::_"]).toBeUndefined();
  });
  it("empty/absent slots map is safe", () => {
    expect(displayUnitsByCell(null, "hub1")).toEqual({});
  });
});

describe("displayUnitsByCell — the REGISTER as the store-less second source", () => {
  // The live /settings/hubSneakerCount/register/{hub} shape: keys pid__sizeKey.
  const REGISTER = {
    p1__6: { qty: 1 },        // ALSO slot-backed (pe+trophy) — double-count guard case
    p9__8: { qty: 1 },        // register-only: the 71% case — size known, store not
    p9__5_5: { qty: 2 },      // register-only, two units, half size
    p9___: { qty: 1 },        // one-size sentinel — never a display cell
    p9__9: { qty: 0 },        // zero qty — nothing to show
  };
  const m = displayUnitsByCell(SLOTS, "hub1", REGISTER);
  it("a register-only row shows the cell with unverified units and NO stores", () => {
    expect(m["p9::8"]).toEqual({ units: 1, stores: [], unverified: 1 });
    expect(m["p9::5_5"]).toEqual({ units: 2, stores: [], unverified: 2 });
  });
  it("DOUBLE-COUNT GUARD: a new-flow registration (slot + register) counts its slots, not the sum", () => {
    // p1 size 6: two live slots, register qty 1 → unexplained max(0, 1-2)=0.
    expect(m["p1::6"]).toEqual({ units: 2, stores: ["marathon-pe", "trophy"], unverified: 0 });
  });
  it("sentinel and zero-qty rows contribute nothing", () => {
    expect(m["p9::_"]).toBeUndefined();
    expect(m["p9::9"]).toBeUndefined();
  });
  it("register alone (no slots) still lights the marker map", () => {
    const only = displayUnitsByCell(null, "hub1", { p9__7: { qty: 1 } });
    expect(only["p9::7"]).toEqual({ units: 1, stores: [], unverified: 1 });
  });
  it("passing no register keeps the slot-only behaviour byte-identical", () => {
    expect(displayUnitsByCell(SLOTS, "hub1")).toEqual(displayUnitsByCell(SLOTS, "hub1", null));
  });
});

describe("displayOnly — the marker rule", () => {
  it("marks only when 0 < avail <= displays", () => {
    expect(displayOnly(1, 1)).toBe(true);
    expect(displayOnly(2, 2)).toBe(true);
    expect(displayOnly(1, 2)).toBe(true);    // stale second slot — still: what's left is on display
  });
  it("avail 0 is ✕ territory, NEVER marked — whatever a slot claims", () => {
    expect(displayOnly(0, 1)).toBe(false);
    expect(displayOnly(-2, 1)).toBe(false);
  });
  it("shelf stock beyond the displays = plain number", () => {
    expect(displayOnly(3, 1)).toBe(false);
    expect(displayOnly(1, 0)).toBe(false);
  });
  it("garbage reads as unmarked", () => {
    expect(displayOnly(NaN, 1)).toBe(false);
    expect(displayOnly(1, undefined)).toBe(false);
  });
});

describe("pendingDisplayPullsByCell — the incoming-order claim", () => {
  const orders = [
    { status: "incoming", displayPairRequest: true, productId: "p1", size: "6" },
    { status: "incoming", displayPairRequest: true, productId: "p1", size: "5.5" },
    { status: "ready", displayPairRequest: true, productId: "p1", size: "7" },      // ready = the promise map's job
    { status: "coming_tomorrow", displayPairRequest: true, productId: "p1", size: "9" }, // deferred pull — STILL a claim
    { status: "incoming", productId: "p1", size: "8" },                             // plain order — not a pull
    { status: "incoming", displayPairRequest: true, productId: "p1" },              // sizeless — unattributable
    { status: "incoming", displayPairRequest: true, productId: "pf", size: "6" },   // not footwear — excluded
    { status: "incoming", displayPairRequest: true, productId: "p1", size: "10", qty: 2 }, // qty carries
    null,
  ];
  it("counts pending (incoming + coming_tomorrow) displayPairRequest FOOTWEAR orders, encoded-key space", () => {
    const m = pendingDisplayPullsByCell(orders, PRODUCTS);
    expect(m["p1::6"]).toBe(1);
    expect(m["p1::5_5"]).toBe(1);
    expect(m["p1::9"]).toBe(1);        // a Tomorrow'd pull keeps its claim
    expect(m["p1::10"]).toBe(2);       // qty carries, not a flat 1
    expect(m["pf::6"]).toBeUndefined(); // perfume never enters the footwear map
    expect(Object.keys(m).sort()).toEqual(["p1::10", "p1::5_5", "p1::6", "p1::9"]);
  });
  it("merges with the ready-promise map by summing shared keys", () => {
    const merged = mergePromised({ "p1::6": 1 }, pendingDisplayPullsByCell(orders, PRODUCTS));
    expect(merged["p1::6"]).toBe(2);
    expect(merged["p1::5_5"]).toBe(1);
  });
  // The ghost-promise bound (2026-09-01): /orders keeps records until their
  // daily number is reused, so a dead pull claim aged past the shared
  // freshness window (availabilityCore.promiseFresh) must stop ✕-ing the
  // restocked cell — same rule, same window as ready promises.
  it("a stale pull claim expires; a fresh or un-ageable one keeps its claim", () => {
    const NOW = Date.parse("2026-09-01T12:00:00.000Z");
    const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
    const m = pendingDisplayPullsByCell([
      { status: "incoming", displayPairRequest: true, productId: "p1", size: "6", createdAt: iso(31 * 86400000) },  // ghost
      { status: "incoming", displayPairRequest: true, productId: "p1", size: "7", createdAt: iso(3600000) },        // fresh
      { status: "incoming", displayPairRequest: true, productId: "p1", size: "8" },                                 // no ts — kept
    ], PRODUCTS, NOW);
    expect(m["p1::6"]).toBeUndefined();
    expect(m["p1::7"]).toBe(1);
    expect(m["p1::8"]).toBe(1);
  });
});

describe("displaySlotStoreFor — whose slot the order clears / refills", () => {
  it("a pull targets the slot named on the order", () => {
    expect(displaySlotStoreFor({ displayPairRequest: true, displayPairStore: "marathon-pe", destShop: "trophy" })).toBe("marathon-pe");
  });
  it("an AMBIGUOUS pull (two stores displayed the size) targets NOTHING — never a destShop guess", () => {
    expect(displaySlotStoreFor({ displayPairRequest: true, displayPairStore: null, destShop: "trophy" })).toBe(null);
  });
  it("classic partner orders keep destShop, byte-identical", () => {
    expect(displaySlotStoreFor({ destShop: "trophy" })).toBe("trophy");
    expect(displaySlotStoreFor({ requestDisplayPartner: true, destShop: "trophy" })).toBe("trophy");
    expect(displaySlotStoreFor({})).toBe(null);
  });
});

describe("depletedTaskRevivable — the empty-slot loop", () => {
  it("revives only when the RESOLVER's availability is positive", () => {
    // The pulled pair stays booked until the till sale, so booked 1 with a
    // ready promise of 1 is NOT revivable — nothing can actually go out.
    expect(depletedTaskRevivable({ cellQty: 1, promised: 1 })).toBe(false);
    expect(depletedTaskRevivable({ cellQty: 3, promised: 1 })).toBe(true);
    expect(depletedTaskRevivable({ cellQty: 0, promised: 0 })).toBe(false);
    expect(depletedTaskRevivable({ cellQty: -2, promised: 0 })).toBe(false);
  });
});

describe("module purity + key-space agreement", () => {
  it("displayPairCore imports no firebase", () => {
    const src = readFileSync(new URL("./displayPairCore.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/from ["']firebase/);
    expect(src).not.toMatch(/\.\.\/\.\.\/firebase/);
  });
  it("the display map and the promise map share one key space", () => {
    const m = displayUnitsByCell(SLOTS, "hub1");
    expect(m[promisedKey("p2", "5.5")]).toBeDefined();   // raw 5.5 → stored 5_5
    expect(m[promisedKey("p1", "6")]).toBeDefined();
  });
});
