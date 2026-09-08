// ─── EVERY HUB'S WALLS DRAW A MARKER; ONLY HUB 1 MAY PULL ────────────────────
//
// THE SYMPTOM, REPORTED BY THE OWNER 2026-09-08: "most items don't have display
// signs on them any more". True, and measured against live RTDB the same day:
//
//   slot rows by bookedHub   hub1 270   hub2 228   hub3 18
//   drawing a glyph          hub1 only — 242 at marathon-pe, 6 at trophy
//   drawing nothing at all   every one of Trophy's 113 hub2 displays
//
// Trophy showed six. Each of the rest names a real shop, a real product and a
// real size — they were invisible only because the marker rode the display-PULL
// lane's map and predicate, and the pull lane is Hub 1's by construction.
//
// ── WHAT THIS DOES NOT FIX, SAID FIRST ───────────────────────────────────────
// PINE IS NOT FIXED. The first version of this file, and the commit it shipped
// with, said Pine's 18 hub3 slots would now be marked. They are not, and three
// independent reviewers caught the same overstatement (2026-09-08). The glyph
// asks the SERVING hub, and a serving hub comes from gatedSneakerHub, which
// answers only from GATED_SNEAKER_HUBS = ["hub1", "hub2"] — a Pine sneaker
// resolves to no hub at all on this screen, which is why sneakerOut declines to
// answer for it and the alternatives sheet says as much. On top of that a Pine
// device never subscribes to the slots node, so there is nothing to read there
// anyway. Marking Pine needs a wider sneaker gate and a new listener: a
// stock-routing change and a data-cost one, neither of them a glyph. The
// residual is pinned below and in hubIsolation, so it cannot be claimed away
// again without a test going red.
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
import { promisedKey, gatedSneakerHub, GATED_SNEAKER_HUBS } from "./availabilityCore";

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
  // AND PINE, WHICH THE SCREEN STILL CANNOT MARK. displayUnitsByCell will
  // happily build a hub3 map — the data is there and correct — but nothing on
  // the ordering screen can key into it, because no size resolves to hub3. The
  // map builder is not the limit; the sneaker gate is.
  it("hub3 slots are readable as data, but no size can ever resolve to hub3", () => {
    expect(mapFor("hub3")[promisedKey("p3", "7")]).toEqual({ units: 1, stores: ["marathon-pine"], unverified: 0 });
    expect(GATED_SNEAKER_HUBS).toEqual(["hub1", "hub2"]);
    expect(gatedSneakerHub({ id: "p3", category: "Footwear", productType: "sneaker" }, "hub3")).toBe(null);
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

// ─── "AND IT IS STILL INERT ON THE WIDER LANE" LIVES IN THE FUZZ ─────────────
//
// This file had a hand-written Hub 2 version of #576's behavioural block, and
// it was struck out as decoration: the slots node was never passed to
// resolveSneakerSourcing or allocateSneakerCart — it cannot be, they take no
// such parameter — so "four in stock with one on Trophy's wall still offers
// four" was two pure functions with disjoint inputs being observed not to share
// them, and the tile helper compared cellBlockInfo against itself and then
// checked a glyph rule the test had written a line earlier (two independent
// reviews, 2026-09-08).
//
// The property is real and worth holding; the way to hold it is a differential
// over worlds nobody chose. It lives in displayMarkerFuzz.test.js, in "the
// widened marker reads the serving hub, and only the serving hub": the serving
// hub comes from the REAL resolver over random stock, the glyph is read the way
// App.jsx reads it, and the case that bites — the other hub holds a slot for
// this cell and the serving hub does not — is counted to prove it occurred.
// A hub1 fallback introduced there goes red on the first case.

// ─── THE WIRING ──────────────────────────────────────────────────────────────
// Source pins, and labelled as such: the predicates live in AssistantView,
// which cannot be mounted without a live firebase subscription. They prove the
// wiring has not moved, never that the screen behaves.
describe("the wiring keeps the two lanes apart", () => {
  it("the marker reads the SERVING hub's map", () => {
    expect(APP).toContain("const sneakerDisplayInfo = (p, s) => {");
    expect(APP).toContain("return hub ? (displayUnitsByHub[hub]?.[promisedKey(p.id, s)] || null) : null;");
  });
  // DERIVED FROM THE GATE, NOT LISTED BESIDE IT. The first cut wrote hub1,
  // hub2 and hub3 out by hand, and the hub3 entry was unreachable — a map no
  // caller could key into, reading as a delivered promise. Building it from
  // GATED_SNEAKER_HUBS makes the marker exactly as wide as the availability
  // lane it hangs off, in both directions and without anyone remembering.
  it("and there is one map per GATED hub, derived from the gate itself", () => {
    expect(APP).toContain('GATED_SNEAKER_HUBS.map((h) => [h, displayUnitsByCell(displaySlotsLive, h)])');
    expect(APP, "a hardcoded per-hub map is back").not.toMatch(/hub[123]: displayUnitsByCell\(displaySlotsLive/);
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
