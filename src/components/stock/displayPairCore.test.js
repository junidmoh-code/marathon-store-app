// Tests for the display-pair pull decisions (displayPairCore.js). Pure — the
// module imports no firebase (asserted below); fixtures are built from the
// STORED shapes the live nodes hold.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  displayUnitsByCell, slotsAfterOrderExits, displayOnly, pendingDisplayPullsByCell,
  mergePromised, displaySlotStoreFor, depletedTaskRevivable,
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
  // STILL TRUE after Hub 2 sneakers joined the availability gate (2026-09-05):
  // the gate spread, the DISPLAY-PAIR lane did not. Slots, the register and the
  // 48h pull claim stay hub1-scoped, so a hub2-booked slot is still nobody's
  // marker but hub2's own. hubIsolation.test.js fences the other half.
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

// ─── THE REGISTER IS NOT A SOURCE, AND A SECOND ARGUMENT CANNOT MAKE IT ONE ──
// It was one until 2026-09-07 and that is the whole duplicate-marker bug: the
// register is keyed pid__sizeKey and is never decremented, so a display that
// changed size left its old row drawing a second glyph forever. 51 products
// carried 2+ markers live. These say the door is shut.
describe("displayUnitsByCell — ONE SOURCE, and the register is not it", () => {
  // The live /settings/hubSneakerCount/register/{hub} shape: keys pid__sizeKey.
  const REGISTER = {
    p1__6: { qty: 1 },
    p9__8: { qty: 1 },        // register-only — would once have drawn a glyph
    p9__5_5: { qty: 2 },
  };
  it("a register-only row draws NOTHING — no slot, no marker", () => {
    const m = displayUnitsByCell(SLOTS, "hub1", REGISTER);
    expect(m["p9::8"]).toBeUndefined();
    expect(m["p9::5_5"]).toBeUndefined();
  });
  it("a stray second argument cannot re-open the second source", () => {
    // The signature takes (slots, hub). Anything passed third is ignored — a
    // later edit that reinstates the old call site changes no behaviour.
    expect(displayUnitsByCell(SLOTS, "hub1", REGISTER)).toEqual(displayUnitsByCell(SLOTS, "hub1"));
    expect(displayUnitsByCell(null, "hub1", { p9__7: { qty: 1 } })).toEqual({});
  });
  it("THE BUG, by construction: a replacement REPLACES — one product, one marker", () => {
    // Registered at 8, then a display refill sends 6. The slot is one record
    // per product per store, so the refill OVERWRITES it. Under the old
    // two-source map the size-8 register row survived and both were marked.
    const registered = { "marathon-pe": { p7: { size: "8", sizeKey: "8", bookedHub: "hub1", source: "registration" } } };
    const afterRefill = { "marathon-pe": { p7: { size: "6", sizeKey: "6", bookedHub: "hub1", source: "display_refill" } } };
    const stranded = { p7__8: { qty: 1 } };   // the register row nothing ever clears
    const before = displayUnitsByCell(registered, "hub1", stranded);
    const after  = displayUnitsByCell(afterRefill, "hub1", stranded);
    expect(Object.keys(before)).toEqual(["p7::8"]);
    expect(Object.keys(after)).toEqual(["p7::6"]);          // exactly one, and it is the NEW size
    expect(after["p7::8"]).toBeUndefined();
  });
  it("no marked unit is unverified any more — every one names its store", () => {
    for (const cell of Object.values(displayUnitsByCell(SLOTS, "hub1", REGISTER))) {
      expect(cell.unverified).toBe(0);
      expect(cell.stores.length).toBe(cell.units);
    }
  });
  it("TWO STORES is not accumulation — two real displays keep two marked cells", () => {
    const two = {
      "marathon-pe": { p8: { size: "6", sizeKey: "6", bookedHub: "hub1", source: "registration" } },
      trophy:        { p8: { size: "9", sizeKey: "9", bookedHub: "hub1", source: "registration" } },
    };
    expect(Object.keys(displayUnitsByCell(two, "hub1")).sort()).toEqual(["p8::6", "p8::9"]);
  });
  it("the module never names the register path", () => {
    const src = readFileSync(new URL("./displayPairCore.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/register\s*\)/);                 // no register parameter
    expect(src.match(/hubSneakerCount/g) || []).toHaveLength(1); // the comment only
  });
});

// ─── THE EXITS ───────────────────────────────────────────────────────────────
// Every exit writes the slot best-effort; these prove the marker survives the
// write being dropped, because the same events are replayed off the orders.
// The four scenarios the owner named: sold, replaced, returned to hub,
// and a pull that failed (the display never left).
describe("slotsAfterOrderExits — a display that leaves the floor stops being marked", () => {
  const PE = "marathon-pe";
  const slotAt = (size, at, source = "registration") => ({
    "marathon-pe": { p1: { size, sizeKey: size.replace(".", "_"), bookedHub: "hub1", source, at, productId: "p1" } },
  });
  const units = (slots, orders) => displayUnitsByCell(slotsAfterOrderExits(slots, orders), "hub1");

  it("THE OWNER'S CASE: send size 6, replace with size 8 — ONE marker, and it is 8", () => {
    // The slot write for the replacement was dropped; only the order landed.
    const slots = slotAt("6", "2026-09-01T10:00:00.000Z", "display_refill");
    const orders = [{
      id: "206", productId: "p1", destShop: PE, requestDisplayPartner: true,
      createdAt: "2026-09-01T09:00:00.000Z",           // older than the slot — already applied
      displayRefillStatus: "refilled", displayRefillSize: "8",
      displayRefilledAt: "2026-09-05T11:00:00.000Z",
    }];
    const m = units(slots, orders);
    expect(Object.keys(m)).toEqual(["p1::8"]);          // exactly one
    expect(m["p1::6"]).toBeUndefined();                 // the old size is NOT still marked
    expect(m["p1::8"].units).toBe(1);
  });

  it("THE OWNER'S CASE: sell the display — ZERO markers", () => {
    const slots = slotAt("6", "2026-09-01T10:00:00.000Z");
    const orders = [{ id: "301", productId: "p1", destShop: PE, requestDisplayPartner: true,
                      createdAt: "2026-09-06T08:00:00.000Z" }];
    expect(units(slots, orders)).toEqual({});
  });

  it("and it clears whatever size sold — the slot is per product, not per size", () => {
    const slots = slotAt("11", "2026-09-01T10:00:00.000Z");
    const orders = [{ id: "302", productId: "p1", destShop: PE, requestDisplayPartner: true,
                      createdAt: "2026-09-06T08:00:00.000Z", size: "6", sentSize: "6" }];
    expect(units(slots, orders)).toEqual({});
  });

  it("A PULL TAKES ANOTHER SHOP'S DISPLAY — the slot cleared is that shop's, not the buyer's", () => {
    const slots = {
      "marathon-pe": { p1: { size: "6", sizeKey: "6", bookedHub: "hub1", source: "registration", at: "2026-09-01T10:00:00.000Z" } },
      trophy:        { p1: { size: "9", sizeKey: "9", bookedHub: "hub1", source: "registration", at: "2026-09-01T10:00:00.000Z" } },
    };
    // Trophy orders the size; the pair stands on Marathon PE's floor.
    const orders = [{ id: "303", productId: "p1", destShop: "trophy", requestDisplayPartner: true,
                      displayPairRequest: true, displayPairStore: PE,
                      createdAt: "2026-09-06T08:00:00.000Z" }];
    const m = units(slots, orders);
    expect(m["p1::6"]).toBeUndefined();                          // PE's display went
    expect(m["p1::9"]).toEqual({ units: 1, stores: ["trophy"], unverified: 0 });  // Trophy's did not
  });

  it("A PULL THAT REFUSES TO GUESS (displayPairStore null) touches nothing", () => {
    const slots = slotAt("6", "2026-09-01T10:00:00.000Z");
    const orders = [{ id: "304", productId: "p1", destShop: PE, requestDisplayPartner: true,
                      displayPairRequest: true, displayPairStore: null,
                      createdAt: "2026-09-06T08:00:00.000Z" }];
    expect(Object.keys(units(slots, orders))).toEqual(["p1::6"]);
  });

  it("RETURNED TO HUB: an already-tombstoned slot stays gone, orders or none", () => {
    const slots = { "marathon-pe": { p1: { size: null, sizeKey: null, prevSize: "6", bookedHub: "hub1", source: "manual", at: "2026-09-06T12:00:00.000Z" } } };
    expect(units(slots, [])).toEqual({});
    expect(units(slots, [{ id: "305", productId: "p1", destShop: PE, requestDisplayPartner: true, createdAt: "2026-09-05T08:00:00.000Z" }])).toEqual({});
  });

  it("THE PULL FAILED — the reinstated slot is NEWER, so the sale event cannot re-clear it", () => {
    // Order created 09:00 (cleared the slot), warehouse marked out_of_stock and
    // reinstated the slot at 10:00. The display never left the floor.
    const slots = slotAt("6", "2026-09-06T10:00:00.000Z", "manual");
    const orders = [{ id: "306", productId: "p1", destShop: PE, requestDisplayPartner: true,
                      createdAt: "2026-09-06T09:00:00.000Z", status: "out_of_stock" }];
    expect(Object.keys(units(slots, orders))).toEqual(["p1::6"]);
  });

  it("A HAND CORRECTION AFTER THE FACT WINS — the replay never resurrects", () => {
    // The card re-registered size 7 at 12:00; the refill order says 8 at 11:00.
    const slots = slotAt("7", "2026-09-06T12:00:00.000Z");
    const orders = [{ id: "307", productId: "p1", destShop: PE, requestDisplayPartner: true,
                      createdAt: "2026-09-01T09:00:00.000Z",
                      displayRefillStatus: "refilled", displayRefillSize: "8",
                      displayRefilledAt: "2026-09-06T11:00:00.000Z" }];
    expect(Object.keys(units(slots, orders))).toEqual(["p1::7"]);
  });

  it("SALE THEN REPLACEMENT ON THE SAME ORDER: the later event is the state", () => {
    const slots = slotAt("6", "2026-09-01T08:00:00.000Z");
    const sale = { id: "308", productId: "p1", destShop: PE, requestDisplayPartner: true,
                   createdAt: "2026-09-02T09:00:00.000Z" };
    expect(units(slots, [sale])).toEqual({});                       // sold — nothing marked
    const refilled = { ...sale, displayRefillStatus: "refilled", displayRefillSize: "8",
                       displayRefilledAt: "2026-09-03T09:00:00.000Z" };
    expect(Object.keys(units(slots, [refilled]))).toEqual(["p1::8"]);  // replaced — one marker, the new size
  });

  it("a depleted refill leaves the slot cleared — no unit came back", () => {
    const slots = slotAt("6", "2026-09-01T08:00:00.000Z");
    const orders = [{ id: "309", productId: "p1", destShop: PE, requestDisplayPartner: true,
                      createdAt: "2026-09-02T09:00:00.000Z",
                      displayRefillStatus: "stockDepleted", displayRefillStockDepletedAt: "2026-09-03T09:00:00.000Z" }];
    expect(units(slots, orders)).toEqual({});
  });

  it("ordinary orders are not display exits and change nothing", () => {
    const slots = slotAt("6", "2026-09-01T08:00:00.000Z");
    const orders = [
      { id: "310", productId: "p1", destShop: PE, createdAt: "2026-09-06T09:00:00.000Z" },                     // plain sale
      { id: "311", productId: "p1", destShop: PE, requestDisplay: true, createdAt: "2026-09-06T09:00:00.000Z" },// "show me one"
      { id: "312", productId: "p2", destShop: PE, requestDisplayPartner: true, createdAt: "2026-09-06T09:00:00.000Z" },
    ];
    expect(Object.keys(units(slots, orders))).toEqual(["p1::6"]);
  });

  it("a one-size sentinel refill size can never mint a marker", () => {
    const slots = slotAt("6", "2026-09-01T08:00:00.000Z");
    const orders = [{ id: "313", productId: "p1", destShop: PE, requestDisplayPartner: true,
                      createdAt: "2026-09-01T07:00:00.000Z",
                      displayRefillStatus: "refilled", displayRefillSize: "Free Size",
                      displayRefilledAt: "2026-09-06T09:00:00.000Z" }];
    expect(Object.keys(units(slots, orders))).toEqual(["p1::6"]);   // untouched, no "p1::_"
  });

  it("is a pure projection: no orders, no timestamps, no slots — all safe and unchanged", () => {
    const slots = slotAt("6", "2026-09-01T08:00:00.000Z");
    expect(slotsAfterOrderExits(slots, [])).toBe(slots);       // nothing to apply, same object
    expect(slotsAfterOrderExits(slots, null)).toBe(slots);
    expect(slotsAfterOrderExits(null, [])).toEqual({});
    expect(slotsAfterOrderExits(undefined, [{ id: "1", productId: "p1", destShop: PE, requestDisplayPartner: true, createdAt: "2026-09-06T09:00:00.000Z" }])).toEqual({});
    // A slot with no `at` is a hand-written record; the replay leaves it alone
    // rather than guessing which came first.
    const noAt = { "marathon-pe": { p1: { size: "6", sizeKey: "6", bookedHub: "hub1" } } };
    expect(Object.keys(units(noAt, [{ id: "1", productId: "p1", destShop: PE, requestDisplayPartner: true, createdAt: "2026-09-06T09:00:00.000Z" }]))).toEqual(["p1::6"]);
    // An event with no timestamp is not an event.
    expect(Object.keys(units(slots, [{ id: "1", productId: "p1", destShop: PE, requestDisplayPartner: true }]))).toEqual(["p1::6"]);
  });

  it("ACCUMULATION IS IMPOSSIBLE: whatever the orders say, a store keeps at most one marked size per product", () => {
    const slots = slotAt("6", "2026-09-01T08:00:00.000Z");
    const orders = [
      { id: "a", productId: "p1", destShop: PE, requestDisplayPartner: true, createdAt: "2026-09-02T08:00:00.000Z",
        displayRefillStatus: "refilled", displayRefillSize: "8", displayRefilledAt: "2026-09-02T09:00:00.000Z" },
      { id: "b", productId: "p1", destShop: PE, requestDisplayPartner: true, createdAt: "2026-09-03T08:00:00.000Z",
        displayRefillStatus: "refilled", displayRefillSize: "10", displayRefilledAt: "2026-09-03T09:00:00.000Z" },
      { id: "c", productId: "p1", destShop: PE, requestDisplayPartner: true, createdAt: "2026-09-04T08:00:00.000Z",
        displayRefillStatus: "refilled", displayRefillSize: "12", displayRefilledAt: "2026-09-04T09:00:00.000Z" },
    ];
    expect(Object.keys(units(slots, orders))).toEqual(["p1::12"]);   // three replacements, one marker
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
  // daily number is reused, so a dead pull claim aged past the PULL lane's
  // own window (PULL_CLAIM_MAX_AGE_MS, 48h — a coming_tomorrow claim must
  // survive overnight; the 20-minute collection deadline is a ready-lane
  // rule) must stop ✕-ing the restocked cell.
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
  it("the lane split: a pull claim outlives the 20-minute READY deadline (coming_tomorrow must survive overnight)", () => {
    const NOW = Date.parse("2026-09-01T12:00:00.000Z");
    const m = pendingDisplayPullsByCell([
      { status: "coming_tomorrow", displayPairRequest: true, productId: "p1", size: "9", createdAt: new Date(NOW - 20 * 3600000).toISOString() },   // 20h — dead under the ready rule, alive here
    ], PRODUCTS, NOW);
    expect(m["p1::9"]).toBe(1);
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
