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
const PRODUCTS = { p1: SNEAKER };

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
    expect(m["p1::6"]).toEqual({ units: 2, stores: ["marathon-pe", "trophy"] });
    expect(m["p2::5_5"]).toEqual({ units: 1, stores: ["marathon-pe"] });
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
    { status: "incoming", productId: "p1", size: "8" },                             // plain order — not a pull
    { status: "incoming", displayPairRequest: true, productId: "p1" },              // sizeless — unattributable
    null,
  ];
  it("counts only INCOMING displayPairRequest footwear orders, encoded-key space", () => {
    const m = pendingDisplayPullsByCell(orders, PRODUCTS);
    expect(m["p1::6"]).toBe(1);
    expect(m["p1::5_5"]).toBe(1);
    expect(Object.keys(m).sort()).toEqual(["p1::5_5", "p1::6"]);
  });
  it("merges with the ready-promise map by summing shared keys", () => {
    const merged = mergePromised({ "p1::6": 1 }, pendingDisplayPullsByCell(orders, PRODUCTS));
    expect(merged["p1::6"]).toBe(2);
    expect(merged["p1::5_5"]).toBe(1);
  });
});

describe("displaySlotStoreFor — whose slot the order clears / refills", () => {
  it("the slot named on the order wins over the ordering shop", () => {
    expect(displaySlotStoreFor({ displayPairStore: "marathon-pe", destShop: "trophy" })).toBe("marathon-pe");
  });
  it("classic partner orders keep destShop", () => {
    expect(displaySlotStoreFor({ destShop: "trophy" })).toBe("trophy");
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
