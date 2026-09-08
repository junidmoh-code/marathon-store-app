// ─── EVERY HUB'S WALLS DRAW A MARKER; ONLY HUB 1 MAY PULL ────────────────────
//
// THE SYMPTOM, REPORTED BY THE OWNER 2026-09-08: "most items don't have display
// signs on them any more". True, and measured against live RTDB the same day:
//
//   slot rows by bookedHub   hub1 270   hub2 228   hub3 18
//   drawing a glyph          hub1 only — 242 at marathon-pe, 6 at trophy
//   drawing nothing at all   every one of Trophy's 113 hub2 displays, and
//                            every one of Pine's, which are all hub3
//
// Pine showed zero markers. Trophy showed six. Each of those slots names a real
// shop, a real product and a real size — they were invisible only because the
// marker rode the display-PULL lane's map and predicate, and the pull lane is
// Hub 1's by construction.
//
// ── THE TWO LANES, AND WHY THE SPLIT IS THE WHOLE CHANGE ────────────────────
//
// THE MARKER asks "is a unit of this size standing on a shop floor?" Every hub
// can answer that, because every hub's shops have walls. It draws a glyph and
// nothing else: it nets nothing, gates nothing, refuses nothing (#576).
//
// THE PULL asks "may this order name an identified physical pair and instruct
// the warehouse to take it off a wall?" That is Hub 1 only. The pull is charged
// at hub1 in the allocation, verified against hub1 in the checkout pre-flight,
// and pendingDisplayPullsByCell is keyed pid::sizeKey with NO hub term — so it
// may only ever be netted against a hub whose lane actually raises such claims.
// Netting it anywhere else imports a Hub 1 claim's ✕ onto an unrelated cell.
// displayPairCore's own header carries that warning; this file is the fence
// that the marker widening did not walk into it.
//
// So: the glyph reads the map of the hub THIS SIZE resolves to, and the pull
// keeps its own hub1 map under its own name. Widening one can no longer widen
// the other by accident, which is the failure the display-cleanup session
// flagged when it saw this change coming.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { displayUnitsByCell } from "./displayPairCore";
import { promisedKey, cellAvailability, cellBlockInfo, allocateSneakerCart, resolveSneakerSourcing } from "./availabilityCore";

const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");

// The live shape, with one product on three different shops' walls, each booked
// to that shop's own supplying hub — which is exactly the arrangement that drew
// one marker out of three before this change.
const SLOTS = {
  "marathon-pe": { p1: { size: "9", sizeKey: "9", bookedHub: "hub1", source: "registration" } },
  trophy:        { p1: { size: "9", sizeKey: "9", bookedHub: "hub2", source: "registration" },
                   p2: { size: "8", sizeKey: "8", bookedHub: "hub2", source: "registration" } },
  "marathon-pine": { p3: { size: "7", sizeKey: "7", bookedHub: "hub3", source: "registration" } },
};
const mapFor = (hub) => displayUnitsByCell(SLOTS, hub);

describe("every hub's walls are readable, and each map holds only its own", () => {
  it("Hub 1 sees PE's wall", () => {
    expect(mapFor("hub1")[promisedKey("p1", "9")]).toEqual({ units: 1, stores: ["marathon-pe"], unverified: 0 });
  });
  // THE 113 THAT WERE INVISIBLE. Trophy's displays are booked hub2 and drew
  // nothing at all while the marker was hub1's.
  it("Hub 2 sees Trophy's wall — the 113 that drew nothing", () => {
    expect(mapFor("hub2")[promisedKey("p1", "9")]).toEqual({ units: 1, stores: ["trophy"], unverified: 0 });
    expect(mapFor("hub2")[promisedKey("p2", "8")]).toEqual({ units: 1, stores: ["trophy"], unverified: 0 });
  });
  // AND PINE, WHICH SHOWED ZERO MARKERS LIVE.
  it("Hub 3 sees Pine's wall — Pine showed none at all", () => {
    expect(mapFor("hub3")[promisedKey("p3", "7")]).toEqual({ units: 1, stores: ["marathon-pine"], unverified: 0 });
  });

  // NO CROSS-CONTAMINATION, and this is the half that matters most. A size Hub 2
  // serves must be marked by a HUB 2 slot, never by a Hub 1 one — otherwise the
  // glyph claims a wall that has nothing to do with the shelf the pair would
  // actually come off, which is a worse lie than showing nothing.
  it("a hub's map never contains another hub's slot", () => {
    expect(Object.keys(mapFor("hub1"))).toEqual([promisedKey("p1", "9")]);
    expect(Object.keys(mapFor("hub2")).sort()).toEqual([promisedKey("p1", "9"), promisedKey("p2", "8")].sort());
    expect(Object.keys(mapFor("hub3"))).toEqual([promisedKey("p3", "7")]);
    // p3 is Pine's alone; p2 is Trophy's alone. Neither leaks into hub1.
    expect(mapFor("hub1")[promisedKey("p3", "7")]).toBeUndefined();
    expect(mapFor("hub1")[promisedKey("p2", "8")]).toBeUndefined();
  });
  // The same cell on two hubs' floors reports each floor to its own hub, and
  // never sums them — two shops each showing size 9 is two separate facts.
  it("one cell on two hubs' floors is two answers, not one merged one", () => {
    expect(mapFor("hub1")[promisedKey("p1", "9")].stores).toEqual(["marathon-pe"]);
    expect(mapFor("hub2")[promisedKey("p1", "9")].stores).toEqual(["trophy"]);
    expect(mapFor("hub1")[promisedKey("p1", "9")].units
         + mapFor("hub2")[promisedKey("p1", "9")].units).toBe(2);
  });
  it("a hub with no walls answers empty, not undefined", () => {
    expect(displayUnitsByCell(SLOTS, "hubC")).toEqual({});
    expect(displayUnitsByCell(null, "hub2")).toEqual({});
  });
});

// ─── THE WIDENED MARKER IS AS INERT AS THE NARROW ONE WAS ────────────────────
//
// #576 proved a HUB 1 marked size still selects, adds and steps. Widening the
// glyph to hub2 and hub3 puts the same claim on two lanes it was never made
// about, and "it is only a glyph" has to be shown there too rather than
// assumed — a Trophy assistant losing a sale to a Trophy display is the same
// lost sale, and until 2026-09-08 no Trophy size drew a glyph at all, so no
// test in the tree had ever exercised one.
describe("a HUB 2 marked size behaves exactly like an unmarked one", () => {
  const SNEAKER = { id: "p1", category: "Footwear", productType: "sneaker" };
  // Trophy's wall holds the one on display; Hub 2 holds the stock the size is
  // actually served from. The glyph and the shelf are the same hub, which is
  // the arrangement the split was built to produce.
  const world = (qty) => ({
    hub1: { cells: {}, promised: {}, ready: true },
    hub2: { cells: { p1: { 9: { qty } } }, promised: {}, ready: true },
  });

  it("the glyph is really there — otherwise the rest of this block is vacuous", () => {
    expect(mapFor("hub2")[promisedKey("p1", "9")].units).toBe(1);
  });

  // FOUR UNITS AT TROPHY, ONE ON TROPHY'S WALL: four available, not zero.
  it("four in stock with one on Trophy's wall still offers four", () => {
    const { hub, available } = resolveSneakerSourcing({
      product: SNEAKER, taggedHub: "hub2", size: "9", hubData: world(4) });
    expect(hub).toBe("hub2");
    expect(available).toBe(4);
  });

  // THE HARDEST CASE ON THE WIDER LANE: the display pair is the only unit.
  // A display is hub stock (#324); the tile does not get to refuse the sale.
  it("one in stock and it IS the display — still sellable, and charged to Hub 2", () => {
    const line = { product: SNEAKER, size: "9" };
    const alloc = allocateSneakerCart({
      lines: [line], hubData: world(1), taggedHubFor: () => "hub2" });
    expect(alloc.hubOf.get(line)).toBe("hub2");
    expect(alloc.overAllocated.has(promisedKey("p1", "9"))).toBe(false);
    // Plain line: nothing on the marker's path stamps a pull flag, and a pull
    // flag on a hub2 line would be a Hub 1 claim raised on the wrong lane.
    expect(line.displayPairRequest).toBeUndefined();
  });

  // AT ZERO, IDENTICAL TO AN UNMARKED SIZE AT ZERO — the ✕ is authoritative and
  // says nothing about a display, on this lane as on Hub 1's.
  it("quantity 0 with a Trophy slot registered is out, exactly as with none", () => {
    const marked = cellAvailability({ cells: { p1: { 9: { qty: 0 } } }, promised: {}, productId: "p1", size: "9" });
    const plain  = cellAvailability({ cells: { p1: {} }, promised: {}, productId: "p1", size: "9" });
    expect(marked).toBe(0);
    expect(marked).toBe(plain);
    const why = cellBlockInfo({ cells: { p1: { 9: { qty: 0 } } }, promised: {}, productId: "p1", size: "9" });
    expect(JSON.stringify(why)).not.toMatch(/display/i);
  });

  // THE TILE DIFFERENTIAL, on Hub 2 this time: the same cell composed once with
  // Trophy's slots and once with the slots node emptied must agree on
  // everything that governs the tile, and differ only in the glyph.
  it("the Hub 2 tile is identical with the slots and without them, bar the glyph", () => {
    const tile = (qty, slotsNode) => {
      const info = cellBlockInfo({ cells: { p1: { 9: { qty } } }, promised: {}, productId: "p1", size: "9" });
      const mk = displayUnitsByCell(slotsNode, "hub2")[promisedKey("p1", "9")];
      return { booked: info.booked, promised: info.promised, available: info.available,
               out: info.available <= 0, glyph: info.available > 0 && !!mk };
    };
    for (const qty of [0, 1, 2, 4, 10]) {
      const marked = tile(qty, SLOTS), plain = tile(qty, {});
      for (const f of ["booked", "promised", "available", "out"]) {
        expect(marked[f], `qty ${qty}: Trophy's slots changed ${f}`).toBe(plain[f]);
      }
      expect(plain.glyph).toBe(false);
      expect(marked.glyph, `qty ${qty}: the glyph did not follow availability`).toBe(qty > 0);
    }
  });
});

// ─── THE WIRING ──────────────────────────────────────────────────────────────
// Source pins, and labelled as such: the predicates live in AssistantView,
// which cannot be mounted without a live firebase subscription. They prove the
// wiring has not moved, never that the screen behaves.
describe("the wiring keeps the two lanes apart", () => {
  it("the marker reads the SERVING hub's map", () => {
    expect(APP).toContain("const sneakerDisplayInfo = (p, s) => {");
    expect(APP).toContain("return hub ? (displayUnitsByHub[hub]?.[promisedKey(p.id, s)] || null) : null;");
  });
  it("and there is a map per hub, built from the same slots node", () => {
    for (const h of ["hub1", "hub2", "hub3"]) {
      expect(APP, `no map for ${h}`).toContain(`${h}: displayUnitsByCell(displaySlotsLive, "${h}"),`);
    }
  });
  // THE FENCE THE CLEANUP SESSION ASKED FOR. Widening the marker must not be
  // readable as having widened the pull.
  it("the pull lane keeps its own hub1 map, with exactly one reader", () => {
    expect(APP).toContain("const hub1DisplayUnits = displayUnitsByHub.hub1;");
    expect((APP.match(/hub1DisplayUnits\[/g) || []).length,
      "hub1DisplayUnits grew a reader — if that is the marker, the lanes have merged").toBe(1);
    expect(APP).toContain("const d = hub1DisplayUnits[promisedKey(item.product.id, item.size)];");
  });
  it("the pull claim map is still netted into Hub 1 alone", () => {
    expect(APP).toContain("mergePromised(hub1ReadyPromised, hub1PullPromised)");
    expect(APP).toContain('const sneakerPromisedMap = (hub) => (hub === "hub2" ? hub2ReadyPromised : hub1Promised);');
    expect((APP.match(/pendingDisplayPullsByCell\(/g) || []).length).toBe(1);
  });
  // AND THE MARKER STILL GATES NOTHING. #576's rule, restated against the wider
  // lane: a glyph on a Hub 2 size must be exactly as inert as one on a Hub 1
  // size. If widening it had made it an availability term anywhere, this is
  // where that would show.
  it("the marker is still absent from every availability computation", () => {
    const i = APP.indexOf("const sneakerOut = (p, s) => {");
    expect(i).toBeGreaterThan(-1);
    const body = APP.slice(i, APP.indexOf("\n  };", i));
    expect(body).not.toMatch(/isplay/);
    const j = APP.indexOf("sizeAvailable: (p, sz) => {");
    expect(j).toBeGreaterThan(-1);
    expect(APP.slice(j, APP.indexOf("},", j))).not.toMatch(/isplay/);
  });
});
