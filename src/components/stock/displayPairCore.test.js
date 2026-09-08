// Tests for the display-pair pull decisions (displayPairCore.js). Every export
// is a pure function of its arguments — no connection, no read, no write
// (asserted below); fixtures are built from the STORED shapes the live nodes
// hold.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  displayUnitsByCell, slotsAfterOrderExits, displaySlotRepairs, displayRepairKey,
  DISPLAY_EXIT_CREATE_MAX_AGE_MS, pendingDisplayPullsByCell,
  mergePromised, displaySlotStoreFor, depletedTaskRevivable,
} from "./displayPairCore";
import { promisedKey } from "./availabilityCore";
import { serverNowIso } from "../../utils/serverTime";

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
  // "now" is PINNED. Creating a slot from nothing is age-bounded, so a fixture
  // that silently aged past the bound would start passing for the wrong reason.
  const NOW = Date.parse("2026-09-07T12:00:00.000Z");
  const units = (slots, orders) => displayUnitsByCell(slotsAfterOrderExits(slots, orders, NOW), "hub1");

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

  // RETIRE (the registration card) writes NO order, so the replay cannot see
  // it and cannot repair a dropped clear there — the card says so in words to
  // the person standing at it. What the replay must not do is UNDO it.
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

  it("THE PULL FAILED AND THE REINSTATE WRITE DROPPED TOO — the display is still marked", () => {
    // The asymmetric failure two reviewers found: replaying ONLY the sale would
    // clear a display that never left the floor and there would be nothing to
    // put it back. The reinstate is the third replayed transition, mirroring
    // App.jsx's own OUT_OF_STOCK writer field for field.
    const slots = slotAt("6", "2026-09-01T08:00:00.000Z");     // neither write landed
    const orders = [{ id: "306", productId: "p1", destShop: PE, requestDisplayPartner: true,
                      displayPairRequest: true, displayPairStore: PE, size: "6",
                      createdAt: "2026-09-06T09:00:00.000Z",
                      status: "out_of_stock", outOfStockAt: "2026-09-06T10:00:00.000Z",
                      placedAtHub: "hub1" }];
    const m = units(slots, orders);
    expect(Object.keys(m)).toEqual(["p1::6"]);
    // The repair is a SET back to 6, never a clear. It writes the state the
    // slot ALREADY shows — what it is really for is the fence: stamping the
    // reinstate's own instant, so a clear delayed in flight behind it cannot
    // land afterwards and wipe a display that never left.
    expect(displaySlotRepairs(slots, orders, NOW)).toEqual([
      { op: "set", store: PE, productId: "p1", productName: "", size: "6", bookedHub: "hub1",
        source: "manual", at: "2026-09-06T10:00:00.000Z", orderId: "306" },
    ]);
  });

  it("a CLASSIC partner order going out of stock does NOT reinstate — that display did sell", () => {
    // Mirrors the writer, which reinstates for displayPairRequest only: a
    // classic partner order out of stock means the warehouse has no
    // replacement, not that the pair is back on the floor.
    const slots = slotAt("6", "2026-09-01T08:00:00.000Z");
    const orders = [{ id: "316", productId: "p1", destShop: PE, requestDisplayPartner: true,
                      size: "6", createdAt: "2026-09-06T09:00:00.000Z",
                      status: "out_of_stock", outOfStockAt: "2026-09-06T10:00:00.000Z" }];
    expect(units(slots, orders)).toEqual({});
  });

  it("A REPLACEMENT FOR A PRODUCT WITH NO SLOT RECORD CREATES ONE — the writer would have", () => {
    // setDisplaySlot creates the record; replaying only over existing records
    // would silently lose a real marker.
    const orders = [{ id: "317", productId: "p9", productName: "Nike AF1", destShop: PE,
                      requestDisplayPartner: true, createdAt: "2026-09-01T08:00:00.000Z",
                      displayRefillStatus: "refilled", displayRefillSize: "8",
                      displayRefilledAt: "2026-09-05T09:00:00.000Z", displayRefillHub: "hub1" }];
    const m = units({}, orders);
    expect(m["p9::8"]).toEqual({ units: 1, stores: [PE], unverified: 0 });
    // a CLEAR with no record stays nothing — clearDisplaySlot no-ops
    expect(units({}, [{ id: "318", productId: "p9", destShop: PE, requestDisplayPartner: true,
                        createdAt: "2026-09-05T09:00:00.000Z" }])).toEqual({});
  });

  it("BUT A CREATE IS AGE-BOUNDED — a stale order may not assert a display onto a floor", () => {
    // A create is the one unfenced move: with no record, nothing can contradict
    // it. Live dry run: five of six repairs were refills from 1-2 August, from
    // BEFORE /settings/displaySlots existed, whose evidence survives only
    // because their order ids were never recycled. Nothing in the window says
    // what became of those displays since, so they may not be re-asserted.
    const stale = (at) => [{ id: "320", productId: "p9", productName: "Nike AF1", destShop: PE,
                             requestDisplayPartner: true, createdAt: "2026-08-01T08:00:00.000Z",
                             displayRefillStatus: "refilled", displayRefillSize: "8",
                             displayRefilledAt: at, displayRefillHub: "hub1" }];
    const justInside = new Date(NOW - DISPLAY_EXIT_CREATE_MAX_AGE_MS + 1000).toISOString();
    const justOutside = new Date(NOW - DISPLAY_EXIT_CREATE_MAX_AGE_MS - 1000).toISOString();
    expect(Object.keys(units({}, stale(justInside)))).toEqual(["p9::8"]);
    expect(units({}, stale(justOutside))).toEqual({});
    expect(displaySlotRepairs({}, stale(justOutside), NOW)).toEqual([]);
    expect(displaySlotRepairs({}, stale(justInside), NOW)).toHaveLength(1);
    // An UPDATE is fenced by the record's own `at`, so age is no object there.
    const old = { "marathon-pe": { p9: { size: "6", sizeKey: "6", bookedHub: "hub1", at: "2026-07-01T08:00:00.000Z" } } };
    expect(Object.keys(units(old, stale(justOutside)))).toEqual(["p9::8"]);
  });

  it("A REPLACEMENT SENT FROM ANOTHER HUB re-points bookedHub, exactly like the writer", () => {
    const slots = slotAt("6", "2026-09-01T08:00:00.000Z");
    const orders = [{ id: "319", productId: "p1", destShop: PE, requestDisplayPartner: true,
                      createdAt: "2026-09-01T07:00:00.000Z",
                      displayRefillStatus: "refilled", displayRefillSize: "8",
                      displayRefilledAt: "2026-09-05T09:00:00.000Z", displayRefillHub: "hub2" }];
    expect(units(slots, orders)).toEqual({});                       // no longer hub1's
    expect(displayUnitsByCell(slotsAfterOrderExits(slots, orders), "hub2")["p1::8"].units).toBe(1);
  });

  it("EQUAL INSTANTS are ranked, not left to array order", () => {
    const at = "2026-09-06T10:00:01.000Z";
    const slots = slotAt("6", "2026-09-01T08:00:00.000Z");
    const sale = { id: "a", productId: "p1", destShop: PE, requestDisplayPartner: true, createdAt: at };
    const both = { ...sale, displayRefillStatus: "refilled", displayRefillSize: "8", displayRefilledAt: at };
    // A replacement at the same instant as the sale is always the later
    // transition on one order, so it wins whichever way the array is built.
    expect(Object.keys(units(slots, [both]))).toEqual(["p1::8"]);
    expect(Object.keys(units(slots, [both, sale]))).toEqual(["p1::8"]);
    expect(Object.keys(units(slots, [sale, both]))).toEqual(["p1::8"]);
  });

  it("AN EQUAL-INSTANT SLOT WINS — the replay is a stand-in, and a stand-in loses ties", () => {
    // The real writers may win a tie (supersededBy rejects only a strictly
    // newer record); this replay may not, because equal instants across two
    // different orders are not one transition. See the tie test below.
    const at = "2026-09-06T10:00:00.000Z";
    const slots = { "marathon-pe": { p1: { size: null, sizeKey: null, bookedHub: "hub1", source: "display_sold", at } } };
    const orders = [{ id: "b", productId: "p1", destShop: PE, requestDisplayPartner: true, createdAt: at }];
    expect(units(slots, orders)).toEqual({});
    expect(displaySlotRepairs(slots, orders, NOW)).toEqual([]);   // already done — no write
  });

  it("EVERY INSTANT IS A FIXED-FORMAT UTC STRING, which is why > is chronological", () => {
    // The whole ordering rests on this. serverNowIso() is Date#toISOString(),
    // so every timestamp in play is `YYYY-MM-DDTHH:MM:SS.mmmZ`. Lexicographic
    // comparison is only chronological for that shape — an offset form like
    // …+02:00 would sort wrongly — so the writers must never emit one.
    const iso = serverNowIso();
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(readFileSync(new URL("../../utils/serverTime.js", import.meta.url), "utf8"))
      .toMatch(/toISOString\(\)/);
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
    // And the healthy case is reference-stable too: /orders re-fires on every
    // till transaction, and a projection that changes nothing must not
    // invalidate every memo hanging off the slot map.
    const landed = [{ id: "z", productId: "p1", destShop: PE, requestDisplayPartner: true,
                      createdAt: "2026-09-01T07:00:00.000Z",
                      displayRefillStatus: "refilled", displayRefillSize: "6",
                      displayRefilledAt: "2026-09-01T08:00:00.000Z", displayRefillHub: "hub1" }];
    expect(slotsAfterOrderExits(slots, landed)).toBe(slots);
    // A `__proto__` store or product id is data, not a prototype assignment.
    //
    // The projection only builds a fresh (null-prototype) map when it has a
    // change to make, and the change here is the CREATE lane: `landed` names a
    // store this slot map has no record for, so it has to clear the seven-day
    // create bound (`DISPLAY_EXIT_CREATE_MAX_AGE_MS`) to count. With `nowMs`
    // left to default this assertion held for exactly seven days after the
    // fixture's instant and then began failing on the clock alone — it did, on
    // 2026-09-08. The claim being made is that `__proto__` is data, which has
    // no date in it, so the instant is pinned here rather than the bound moved.
    const evil = { __proto__: { p1: { size: "6", sizeKey: "6", bookedHub: "hub1", at: "2026-01-01T00:00:00.000Z" } } };
    const justAfter = Date.parse("2026-09-01T09:00:00.000Z");
    const evilOut = slotsAfterOrderExits({ ...evil, ok: {} }, landed, justAfter);
    expect(Object.getPrototypeOf(evilOut)).toBe(null);
    // And the pin is not doing the assertion's work for it: the fresh map is
    // only built when there is a change, so this proves the create lane really
    // fired. Without it a future bound change would make the line above pass by
    // returning the caller's own object, which has an Object prototype — i.e.
    // it would fail loudly, not silently, but the intent is worth stating.
    expect(Object.keys(evilOut).sort()).toEqual(["marathon-pe", "ok"]);
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

// ─── THE REPAIR IS PERSISTED, because the projection alone cannot hold ───────
// /orders recycles its ids daily and the feed is store-scoped, so a fix that
// lives only in the projection un-fixes itself. displaySlotRepairs turns each
// divergence into the write the exit dropped; App.jsx puts it through the
// ordinary fenced writers.
describe("displaySlotRepairs — the divergence as a write", () => {
  const PE = "marathon-pe";
  const NOW = Date.parse("2026-09-07T12:00:00.000Z");
  it("a dropped SALE clear becomes a clear, stamped with the ORDER's instant", () => {
    const slots = { "marathon-pe": { p1: { size: "6", sizeKey: "6", bookedHub: "hub1", source: "registration", at: "2026-09-01T08:00:00.000Z" } } };
    const orders = [{ id: "401", productId: "p1", destShop: PE, requestDisplayPartner: true, createdAt: "2026-09-06T09:00:00.000Z" }];
    expect(displaySlotRepairs(slots, orders, NOW)).toEqual([
      { op: "clear", store: PE, productId: "p1", source: "display_sold", at: "2026-09-06T09:00:00.000Z", orderId: "401" },
    ]);
  });
  it("a dropped REPLACEMENT becomes a set at the sent size and the sending hub", () => {
    const slots = { "marathon-pe": { p1: { productName: "AF1", size: "6", sizeKey: "6", bookedHub: "hub1", source: "registration", at: "2026-09-01T08:00:00.000Z" } } };
    const orders = [{ id: "402", productId: "p1", productName: "AF1", destShop: PE, requestDisplayPartner: true,
                      createdAt: "2026-09-01T07:00:00.000Z",
                      displayRefillStatus: "refilled", displayRefillSize: "8",
                      displayRefilledAt: "2026-09-06T09:00:00.000Z", displayRefillHub: "hub1" }];
    expect(displaySlotRepairs(slots, orders, NOW)).toEqual([
      { op: "set", store: PE, productId: "p1", productName: "AF1", size: "8", bookedHub: "hub1",
        source: "display_refill", at: "2026-09-06T09:00:00.000Z", orderId: "402" },
    ]);
  });
  it("NOTHING TO REPAIR when the write landed — the healthy case writes nothing", () => {
    const slots = { "marathon-pe": { p1: { size: "8", sizeKey: "8", bookedHub: "hub1", source: "display_refill", at: "2026-09-06T09:00:00.000Z" } } };
    const orders = [{ id: "403", productId: "p1", destShop: PE, requestDisplayPartner: true,
                      createdAt: "2026-09-01T07:00:00.000Z",
                      displayRefillStatus: "refilled", displayRefillSize: "8",
                      displayRefilledAt: "2026-09-06T09:00:00.000Z", displayRefillHub: "hub1" }];
    expect(displaySlotRepairs(slots, orders, NOW)).toEqual([]);
  });
  it("a slot that has moved on since is NOT repaired — the writers' own fence, applied early", () => {
    const slots = { "marathon-pe": { p1: { size: "7", sizeKey: "7", bookedHub: "hub1", source: "registration", at: "2026-09-07T12:00:00.000Z" } } };
    const orders = [{ id: "404", productId: "p1", destShop: PE, requestDisplayPartner: true, createdAt: "2026-09-06T09:00:00.000Z" }];
    expect(displaySlotRepairs(slots, orders, NOW)).toEqual([]);
  });
  it("clearing something already cleared, or never recorded, is not a write", () => {
    const orders = [{ id: "405", productId: "p1", destShop: PE, requestDisplayPartner: true, createdAt: "2026-09-06T09:00:00.000Z" }];
    expect(displaySlotRepairs({ "marathon-pe": { p1: { size: null, sizeKey: null, at: "2026-09-01T08:00:00.000Z" } } }, orders)).toEqual([]);
    expect(displaySlotRepairs({}, orders, NOW)).toEqual([]);
    expect(displaySlotRepairs(null, null, NOW)).toEqual([]);
  });
  it("THE REPAIR AND THE PROJECTION AGREE: applying the repairs yields the projected map", () => {
    // The two must never drift — a repair that writes something the marker
    // does not already show would make the screen flicker at the next sync.
    const slots = {
      "marathon-pe": { p1: { size: "6", sizeKey: "6", bookedHub: "hub1", source: "registration", at: "2026-09-01T08:00:00.000Z" },
                       p2: { size: "9", sizeKey: "9", bookedHub: "hub1", source: "registration", at: "2026-09-01T08:00:00.000Z" } },
      trophy:        { p1: { size: "7", sizeKey: "7", bookedHub: "hub1", source: "registration", at: "2026-09-01T08:00:00.000Z" } },
    };
    const orders = [
      { id: "406", productId: "p1", destShop: PE, requestDisplayPartner: true, createdAt: "2026-09-06T09:00:00.000Z" },
      { id: "407", productId: "p2", destShop: PE, requestDisplayPartner: true, createdAt: "2026-09-02T09:00:00.000Z",
        displayRefillStatus: "refilled", displayRefillSize: "11", displayRefilledAt: "2026-09-06T09:00:00.000Z", displayRefillHub: "hub1" },
    ];
    // apply the repairs to a copy, the way the writers would
    const applied = JSON.parse(JSON.stringify(slots));
    for (const r of displaySlotRepairs(slots, orders, NOW)) {
      const cur = applied[r.store][r.productId];
      applied[r.store][r.productId] = r.op === "clear"
        ? { ...cur, size: null, sizeKey: null, at: r.at }
        : { ...cur, size: r.size, sizeKey: r.size.replace(".", "_"), bookedHub: r.bookedHub, at: r.at };
    }
    expect(displayUnitsByCell(applied, "hub1")).toEqual(displayUnitsByCell(slotsAfterOrderExits(slots, orders), "hub1"));
  });
  it("A STALE FENCE IS A REPAIR even when the state already matches", () => {
    // Reviewer's case: slot says size 8 at 10:00:01, the replacement to 8
    // happened at 10:00:03 and its write dropped. Content matches, so an
    // earlier cut wrote nothing — and a clear stamped 10:00:02 then wiped a
    // display that had been replaced AFTER it. The repair advances the fence.
    const slots = { "marathon-pe": { p1: { size: "8", sizeKey: "8", bookedHub: "hub1", source: "display_refill", at: "2026-09-07T10:00:01.000Z" } } };
    const orders = [{ id: "408", productId: "p1", destShop: PE, requestDisplayPartner: true,
                      createdAt: "2026-09-07T09:00:00.000Z",
                      displayRefillStatus: "refilled", displayRefillSize: "8",
                      displayRefilledAt: "2026-09-07T10:00:03.000Z", displayRefillHub: "hub1" }];
    expect(displaySlotRepairs(slots, orders, NOW)).toEqual([
      { op: "set", store: PE, productId: "p1", productName: "", size: "8", bookedHub: "hub1",
        source: "display_refill", at: "2026-09-07T10:00:03.000Z", orderId: "408" },
    ]);
    // and it CONVERGES: once the fence is at the event's instant, no more writes
    const healed = { "marathon-pe": { p1: { ...slots["marathon-pe"].p1, at: "2026-09-07T10:00:03.000Z" } } };
    expect(displaySlotRepairs(healed, orders, NOW)).toEqual([]);
  });

  it("a stale TOMBSTONE fence is not repaired — the write could not land anyway", () => {
    // clearDisplaySlot refuses to re-stamp an already-cleared record by design,
    // and the only write that could slip in front of a newer sale event is one
    // putting a display back on the floor, which should win.
    const slots = { "marathon-pe": { p1: { size: null, sizeKey: null, at: "2026-09-01T08:00:00.000Z" } } };
    const orders = [{ id: "409", productId: "p1", destShop: PE, requestDisplayPartner: true, createdAt: "2026-09-06T09:00:00.000Z" }];
    expect(displaySlotRepairs(slots, orders, NOW)).toEqual([]);
  });

  it("A TIE NEVER LETS THE REPLAY OVERWRITE A LANDED WRITE", () => {
    // The regression an equal-instant rule introduced: PE's slot holds a
    // replacement stamped T; Trophy's store-scoped feed holds only its own
    // cross-shop pull, whose clear is ALSO stamped T. Equal timestamps do not
    // make them one transition, and this replay is never the author of one —
    // so it loses every tie and writes nothing.
    const T = "2026-09-07T10:00:00.000Z";
    const slots = { "marathon-pe": { p1: { size: "8", sizeKey: "8", bookedHub: "hub1", source: "display_refill", at: T } } };
    const trophyFeed = [{ id: "410", productId: "p1", destShop: "trophy", requestDisplayPartner: true,
                          displayPairRequest: true, displayPairStore: PE, createdAt: T }];
    expect(displaySlotRepairs(slots, trophyFeed, NOW)).toEqual([]);
    expect(Object.keys(displayUnitsByCell(slotsAfterOrderExits(slots, trophyFeed), "hub1"))).toEqual(["p1::8"]);
  });

  it("TWO ORDERS IN THE SAME MILLISECOND resolve the same way whatever the array order", () => {
    const T = "2026-09-07T10:00:00.000Z";
    const slots = { "marathon-pe": { p1: { size: "6", sizeKey: "6", bookedHub: "hub1", at: "2026-09-01T08:00:00.000Z" } } };
    const mk = (id, size) => ({ id, productId: "p1", destShop: PE, requestDisplayPartner: true,
                                createdAt: "2026-09-01T07:00:00.000Z",
                                displayRefillStatus: "refilled", displayRefillSize: size,
                                displayRefilledAt: T, displayRefillHub: "hub1" });
    const a = mk("501", "6"), b = mk("502", "7");
    expect(displaySlotRepairs(slots, [a, b], NOW)).toEqual(displaySlotRepairs(slots, [b, a], NOW));
    expect(displaySlotRepairs(slots, [a, b], NOW)[0].size).toBe("7");   // the higher order id
  });

  it("the repair key separates a hub correction that leaves size and instant alone", () => {
    const at = "2026-09-06T09:00:00.000Z";
    const base = { op: "set", store: PE, productId: "p1", at, size: "6" };
    expect(displayRepairKey({ ...base, bookedHub: "hub1" }))
      .not.toBe(displayRepairKey({ ...base, bookedHub: "hub2" }));
  });

  it("displayRepairKey is stable and distinguishes the ops it must", () => {
    const base = { op: "clear", store: PE, productId: "p1", at: "2026-09-06T09:00:00.000Z" };
    expect(displayRepairKey(base)).toBe(displayRepairKey({ ...base }));
    expect(displayRepairKey(base)).not.toBe(displayRepairKey({ ...base, op: "set", size: "8" }));
    expect(displayRepairKey({ ...base, op: "set", size: "8" })).not.toBe(displayRepairKey({ ...base, op: "set", size: "9" }));
    expect(displayRepairKey(base)).not.toBe(displayRepairKey({ ...base, at: "2026-09-06T09:00:01.000Z" }));
  });
});

// ─── THE MARKER RULE IS DELETED, NOT DISABLED ────────────────────────────────
// displayOnly() decided that a size whose last availability was the display
// pair could not simply be sold: the tile went amber and the tap was diverted
// into a request. Owner spec 2026-09-07 removed that — the glyph is
// informational and availability is quantity — and the function went with it,
// because an unused copy of a deleted rule is how the rule comes back.
describe("displayOnly is gone", () => {
  it("is not exported from this module any more", async () => {
    const mod = await import("./displayPairCore");
    expect("displayOnly" in mod).toBe(false);
  });
  it("and the slot map it fed still reports the units, which is all the glyph needs", () => {
    const slots = { "marathon-pe": { p9: { size: "9", sizeKey: "9", bookedHub: "hub1", source: "registration" } } };
    expect(displayUnitsByCell(slots, "hub1")["p9::9"]).toEqual({ units: 1, stores: ["marathon-pe"], unverified: 0 });
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
  // NOT "imports no firebase" — a reviewer pointed out twice that the old
  // wording was only ever true DIRECTLY: displayPairCore imports slotIsLive
  // from displaySlots.js, which does import firebase. What actually matters is
  // that every exported decision here is a PURE FUNCTION of its arguments: it
  // opens no connection, reads no node and writes nothing, so a caller can run
  // it on data it already holds and a test can run it on a literal. That is
  // asserted directly below, and by the fact that this whole file runs with no
  // firebase mock of any kind.
  it("displayPairCore names no firebase API and touches no database", () => {
    const src = readFileSync(new URL("./displayPairCore.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/from ["']firebase/);
    expect(src).not.toMatch(/\.\.\/\.\.\/firebase/);
    // The transitive import is slotIsLive ONLY, which is itself pure. Anything
    // that reads or writes would show up as one of these. Method calls are
    // stripped first so the Map's own .get/.set are not mistaken for the
    // firebase free functions of the same name. (No lookbehind: a parse-time
    // SyntaxError in src/ blanks the whole app on Safari < 16.4.)
    const bare = src.replace(/\.\s*\w+\s*\(/g, ".CALL(");
    for (const api of [/\bref\s*\(/, /\bget\s*\(/, /\bset\s*\(/, /\bupdate\s*\(/,
                       /\bchild\s*\(/, /runTransaction/, /onValue/, /\bdatabase\b/, /\bauth\b/]) {
      expect(bare).not.toMatch(api);
    }
  });
  it("and every exported decision is pure: same input, same output, input unmutated", () => {
    const slots = { "marathon-pe": { p1: { size: "6", sizeKey: "6", bookedHub: "hub1", at: "2026-09-01T08:00:00.000Z" } } };
    const orders = [{ id: "601", productId: "p1", destShop: "marathon-pe", requestDisplayPartner: true,
                      createdAt: "2026-09-06T09:00:00.000Z" }];
    const now = Date.parse("2026-09-07T12:00:00.000Z");
    const before = JSON.stringify({ slots, orders });
    const a = JSON.stringify(displaySlotRepairs(slots, orders, now));
    const b = JSON.stringify(displaySlotRepairs(slots, orders, now));
    expect(a).toBe(b);
    expect(JSON.stringify(slotsAfterOrderExits(slots, orders, now)))
      .toBe(JSON.stringify(slotsAfterOrderExits(slots, orders, now)));
    expect(JSON.stringify({ slots, orders })).toBe(before);   // nothing mutated
  });
  it("the display map and the promise map share one key space", () => {
    const m = displayUnitsByCell(SLOTS, "hub1");
    expect(m[promisedKey("p2", "5.5")]).toBeDefined();   // raw 5.5 → stored 5_5
    expect(m[promisedKey("p1", "6")]).toBeDefined();
  });
});
