// ─── THE FLOOR NOTE: TRUE, QUIET, AND NEVER AN INSTRUCTION ───────────────────
//
// #576 made the display marker informational and deleted the divert. Right
// call — but the amber "take it off the display" banner only ever existed on
// the divert's output, so the warehouse stopped being told anything: a picker
// walks to an empty size slot with "Mark as Out of Stock" one tap away while
// the pair stands on a wall. This is the note that closes that, and these are
// the fences that keep it a note.
//
// Two things are at stake, and they pull in opposite directions:
//
//   1. IT MUST APPEAR when a unit really is on a floor, or the false
//      out-of-stock it exists to prevent happens anyway.
//   2. IT MUST NEVER BECOME THE PULL. The pull names an identified physical
//      pair and instructs a picker to send THAT one, which it may do because
//      the pull flow reserved it. This reserves nothing, so it must assert
//      nothing — no flag, no hub pin, no slot write, no second banner.
//
// Everything below is behavioural: it runs the predicate the screen consults.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  displayFloorsAtOrderTime, displayLocationNote, normaliseStores, snapshotDate, DISPLAY_LANE_HUB,
} from "./displayLocationNote";
import { displayUnitsByCell } from "./displayPairCore";
import { promisedKey } from "./availabilityCore";

// The live slot shape, and the map production actually hands the caller.
const SLOTS = {
  "marathon-pe": { p1: { size: "9", sizeKey: "9", bookedHub: "hub1", source: "registration" } },
  trophy: { p1: { size: "9", sizeKey: "9", bookedHub: "hub1", source: "registration" } },
};
const UNITS = displayUnitsByCell(SLOTS, "hub1")[promisedKey("p1", "9")];
const ok = (over = {}) => displayFloorsAtOrderTime({
  displayUnits: UNITS, placedHub: "hub1", productType: "sneaker",
  isPull: false, isPartnerRequest: false, laneReady: true, ...over,
});

describe("the map it reads is the one production builds", () => {
  it("two floors showing the same size both appear", () => {
    expect(UNITS).toEqual({ units: 2, stores: ["marathon-pe", "trophy"], unverified: 0 });
  });
});

describe("it appears when a unit really is on a floor", () => {
  it("names the floors, sorted, for an ordinary Hub 1 sneaker line", () => {
    expect(ok()).toEqual(["marathon-pe", "trophy"]);
  });
  it("one floor is one name", () => {
    const one = displayUnitsByCell({ trophy: SLOTS.trophy }, "hub1")[promisedKey("p1", "9")];
    expect(ok({ displayUnits: one })).toEqual(["trophy"]);
  });
  // The order in the record must not depend on which store the slots node
  // happened to enumerate first, or two identical situations write two
  // different records and a diff of them reads as a change.
  it("the order is stable whatever order the stores arrive in", () => {
    expect(ok({ displayUnits: { units: 2, stores: ["trophy", "marathon-pe"] } }))
      .toEqual(ok({ displayUnits: { units: 2, stores: ["marathon-pe", "trophy"] } }));
  });
});

describe("it says NOTHING rather than something it cannot stand behind", () => {
  // AN UNANSWERED LANE IS NOT AN EMPTY FLOOR. This is the same fail-open trap
  // the alternatives sheet had: before the subscription answers, the map is
  // empty, which is indistinguishable from "nothing is on a display". Writing
  // that absence into a durable order record would make it look like a fact.
  it("nothing while the display lane has not answered", () => {
    expect(ok({ laneReady: false })).toBeNull();
  });
  it("nothing for a line allocated away from the display lane's hub", () => {
    expect(ok({ placedHub: "hub2" })).toBeNull();
    expect(ok({ placedHub: "hub3" })).toBeNull();
    expect(ok({ placedHub: null })).toBeNull();
  });
  it("nothing for clothing — it has no display lane", () => {
    expect(ok({ productType: "clothing" })).toBeNull();
  });
  it("nothing when no slot stands for that cell", () => {
    expect(ok({ displayUnits: null })).toBeNull();
    expect(ok({ displayUnits: undefined })).toBeNull();
    expect(ok({ displayUnits: { units: 0, stores: [] } })).toBeNull();
    expect(ok({ displayUnits: { units: 2, stores: [] } })).toBeNull();
  });
  // NULL, NEVER []. RTDB deletes a key written an empty array and reads it back
  // as null, so the two are one value in the database — returning [] would put
  // a field in the record that vanishes on the way to the warehouse.
  it("an empty answer is null, never an empty array", () => {
    for (const empty of [{ units: 2, stores: [] }, { units: 2, stores: {} }, { units: 2, stores: null }]) {
      const r = ok({ displayUnits: empty });
      expect(r, JSON.stringify(empty)).toBeNull();
      expect(Array.isArray(r)).toBe(false);
    }
  });
});

describe("it never becomes the pull", () => {
  // THE STRONGER BANNER WINS, AT BOTH ENDS. A pull already tells the picker to
  // take THAT pair off the wall; a second, softer banner beside it saying
  // "any pair of this size is fine" contradicts it on the one card where
  // getting it wrong loses the identified unit.
  it("a display-pair pull writes no floor note", () => {
    expect(ok({ isPull: true })).toBeNull();
  });
  // The opposite errand: a partner request asks the hub to send a pair TO
  // BECOME a display. Pointing that picker at another shop's display wall
  // invites them to furnish one display from another, which leaves the first
  // shop's slot standing against a shoe that has gone.
  it("a Display Partner request writes none either", () => {
    expect(ok({ isPartnerRequest: true })).toBeNull();
  });
  it("and a pull order renders no floor note either, whatever the field says", () => {
    expect(displayLocationNote({ displayPairRequest: true, displayOnFloorAt: ["trophy"] })).toBeNull();
  });
  // The note is a NOTE. It writes one field and there is nothing else on it to
  // mistake for a claim on a unit.
  it("the answer is store names and nothing else — no flag, no hub, no store-to-clear", () => {
    const r = ok();
    expect(Array.isArray(r)).toBe(true);
    for (const v of r) expect(typeof v).toBe("string");
    expect(DISPLAY_LANE_HUB).toBe("hub1");
  });
});

describe("reading it back off an order", () => {
  it("an order that carries floors gets the note, dated from its own createdAt", () => {
    const r = displayLocationNote({ displayOnFloorAt: ["marathon-pe"], createdAt: "2026-09-07T10:00:00.000Z" });
    expect(r.stores).toEqual(["marathon-pe"]);
    expect(r.when).toMatch(/2026/);
  });
  // ── THE TENSE, AND WHY IT IS PINNED ────────────────────────────────────────
  // "IS on a display" asserts a present fact from a snapshot that may be days
  // old when a picker reads it, and no later slot repair can reach a note
  // already written into an order record. A card that cannot date its evidence
  // must say so by omission rather than implying the claim is current.
  it("an order with no readable date gets no date, not a wrong one", () => {
    for (const bad of [undefined, null, "", "not a date", 0, {}, []]) {
      expect(displayLocationNote({ displayOnFloorAt: ["trophy"], createdAt: bad }).when,
        JSON.stringify(bad)).toBeNull();
    }
    expect(snapshotDate("2026-09-07T10:00:00.000Z")).toMatch(/2026/);
  });
  // ORDERS PLACED BEFORE THIS SHIPPED. They carry no field at all and must
  // render exactly as they do today — no note, no crash, no "undefined".
  it("an order from before this shipped gets nothing, and does not throw", () => {
    expect(displayLocationNote({ id: "1", productId: "p1", size: "9" })).toBeNull();
    expect(displayLocationNote({ displayOnFloorAt: null })).toBeNull();
    expect(displayLocationNote(null)).toBeNull();
    expect(displayLocationNote(undefined)).toBeNull();
  });
  // RTDB hands an array back as an array only while its keys are a dense 0..n
  // run; delete one and the SAME node returns an object with numeric string
  // keys. Both shapes must read identically or a note disappears from an order
  // nobody edited on purpose.
  it("the object shape RTDB returns for a sparse array reads the same as the array", () => {
    expect(displayLocationNote({ displayOnFloorAt: { 0: "marathon-pe", 2: "trophy" } }).stores)
      .toEqual(["marathon-pe", "trophy"]);
  });
  it("junk in the list is dropped, not rendered", () => {
    expect(normaliseStores(["marathon-pe", "", "   ", null, 7, {}, "marathon-pe", "trophy"]))
      .toEqual(["marathon-pe", "trophy"]);
    expect(displayLocationNote({ displayOnFloorAt: ["", null, 0] })).toBeNull();
  });
});

// ─── A PROPERTY FUZZ OVER THE WHOLE INPUT SPACE ──────────────────────────────
// The examples above assert what I thought to check. This asserts the two
// invariants that actually matter over every combination of the five inputs,
// including the malformed ones RTDB has genuinely produced in this codebase.
describe("fuzz: the note is never wrong and never an instruction", () => {
  const HUBS = ["hub1", "hub2", "hub3", null, undefined, "", "HUB1"];
  const TYPES = ["sneaker", "clothing", undefined, null, "", "perfume"];
  const UNIT_SHAPES = [
    null, undefined, {}, { units: 0, stores: ["a"] }, { units: -1, stores: ["a"] },
    { units: 1, stores: [] }, { units: 1, stores: null }, { units: 1, stores: ["a"] },
    { units: 2, stores: ["b", "a"] }, { units: 1, stores: [null, "a", "  a  "] },
    { units: "2", stores: ["a"] }, { units: NaN, stores: ["a"] },
    { units: 1, stores: { 0: "a", 3: "b" } },
  ];
  let sawNote = 0, sawNull = 0;
  it("holds over every combination", () => {
    for (const displayUnits of UNIT_SHAPES) {
      for (const placedHub of HUBS) {
        for (const productType of TYPES) {
          for (const [isPull, isPartnerRequest] of [[true, true], [true, false], [false, true], [false, false], [undefined, undefined]]) {
            for (const laneReady of [true, false]) {
              const r = displayFloorsAtOrderTime({ displayUnits, placedHub, productType, isPull, isPartnerRequest, laneReady });
              const at = JSON.stringify({ displayUnits, placedHub, productType, isPull, isPartnerRequest, laneReady });

              // 1. NULL OR A NON-EMPTY LIST OF NAMES. Never [], never a string,
              //    never undefined — the record has one shape.
              if (r === null) { sawNull++; continue; }
              sawNote++;
              expect(Array.isArray(r), at).toBe(true);
              expect(r.length, at).toBeGreaterThan(0);
              for (const v of r) expect(typeof v === "string" && v.trim() === v && v !== "", at).toBe(true);
              expect(r, at).toEqual([...r].sort());
              expect(new Set(r).size, at).toBe(r.length);

              // 2. IT ONLY EVER SPEAKS WHERE IT HAS STANDING. Every condition
              //    that must hold for a note to be true, asserted on the note
              //    rather than on the branch that produced it.
              expect(laneReady, at).toBe(true);
              expect(placedHub, at).toBe("hub1");
              expect(productType === "clothing", at).toBe(false);
              expect(isPull === true, at).toBe(false);
              expect(isPartnerRequest === true, at).toBe(false);
              expect(Number(displayUnits.units) > 0, at).toBe(true);

              // 3. AND A NOTE ALWAYS SURVIVES THE ROUND TRIP through the field
              //    it is written to — the writer and the reader agree.
              expect(displayLocationNote({ displayPairRequest: false, displayOnFloorAt: r }).stores, at)
                .toEqual(r);
            }
          }
        }
      }
    }
    // A guard on the guard: both outcomes have to occur, or the invariants
    // above are satisfied by a constant.
    expect(sawNote, "no combination ever produced a note").toBeGreaterThan(10);
    expect(sawNull, "no combination was ever refused").toBeGreaterThan(10);
  });
});

// ─── THE WIRING, PINNED ──────────────────────────────────────────────────────
// The rule above is behavioural. Whether the screen actually CONSULTS it is not
// something a pure test can see, and placeOrders / the warehouse card live in
// App.jsx, which cannot be mounted without a live firebase subscription (the
// limit altSheetWiring.test.js states). So these are source pins, and they are
// labelled as such: they prove the wiring has not moved, never that it behaves.
describe("the wiring in App.jsx", () => {
  const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");

  it("the order record is stamped from the shared rule, not a second one", () => {
    expect(APP).toContain("displayOnFloorAt: displayFloorsAtOrderTime({");
    // The SAME map the glyph reads, keyed the same way — a second source for
    // "what is on a floor" is how the tile and the card come to disagree.
    expect(APP).toContain("displayUnits: hub1DisplayUnits[promisedKey(item.product.id, item.size)],");
    expect(APP).toContain("isPull: item.displayPairRequest === true,");
    expect(APP).toContain("isPartnerRequest: item.requestDisplayPartner === true,");
    // BOTH lanes. hub1DisplayUnits is the slot node with the ORDER-lane exits
    // replayed over it, so before /orders answers a display sale whose
    // best-effort slot clear was dropped still reads as live — and stamping
    // that into a durable record freezes a ghost the later repair cannot reach.
    expect(APP).toContain("laneReady: displayLaneReady && ordersSettled,");
  });

  // IT WRITES ONE FIELD. The point of the whole design is that nothing else on
  // the order moves — no pull flag, no store-to-clear, no hub pin — so the
  // slot bookkeeping, the refill replay and the allocation are all untouched.
  it("and it writes NOTHING else — the pull flag is still only ever the line's own", () => {
    expect(APP).toContain("displayPairRequest: item.displayPairRequest === true,");
    expect(APP).toContain("displayPairStore: item.displayPairRequest === true ? (item.displayPairStore || null) : null,");
    // No minter came back with it (#576's rule).
    expect(APP).not.toContain("line.displayPairRequest = true");
    expect(APP).not.toContain("pendingDisplayPair");
    expect(APP).not.toContain("qvDisplayPair");
  });

  // BOTH BRANCHES. The staged display-send flow only renders when
  // productIsFootwear agrees; a divergently-keyed product falls to the plain
  // 2×2 grid — where "Mark as Out of Stock" is one tap away, which is the exact
  // outcome this note exists to prevent. The pull banner already rides both for
  // that reason; so must this.
  it("the card renders it on BOTH branches, beside the pull banner", () => {
    expect(APP.match(/\{displayPairBanner\}\{displayFloorBanner\}/g) || []).toHaveLength(2);
    expect(APP).toContain("const floorNote = displayLocationNote(order);");
  });

  // THE CARD REPORTS EVIDENCE AND STOPS. Two things it must never do:
  //
  //   • tell a picker to take the pair off the wall — an ordinary send records
  //     NO display exit (the slot clear and the refill scheduling are both
  //     gated on requestDisplayPartner), so a note that invited it would strip
  //     a display and leave its slot standing against a shoe that had gone;
  //   • ask anyone to go and report it afterwards. That is a human step by
  //     another name, it names no one, it is unenforceable, and a gap that
  //     LOOKS covered is worse than one that is visibly open.
  it("the card never instructs a picker to take the pair, nor to go and tell somebody", () => {
    // The two sentences that were cut, by their exact text — a literal pin
    // catches a revert, not a paraphrase, and says so rather than pretending
    // to be a semantic guard (review, 2026-09-08).
    expect(APP).not.toContain("Any pair of this size is fine to send");
    expect(APP).not.toContain("tell whoever keeps the display register");
    // ONE instruction, not two ways of saying the same one. An earlier draft
    // read "check there … confirm it is still on the wall first", where
    // "first" dangled: it sequenced against the reporting step that had just
    // been removed, leaving a visible seam in copy a picker has to read fast.
    expect(APP).toContain("If the shelf is empty, check the display before marking it out of stock.");
    expect(APP).not.toContain("confirm it is still on the wall");
    expect(APP).toContain("WAS ON A DISPLAY at ");
    // Past tense, dated from the order itself.
    expect(APP).toContain("when this was ordered");
    expect(APP).toContain("floorNote.when");
  });

  // AND THE SIZE GRID NEVER READS IT. The note is warehouse-side only; a tile
  // that consulted it would be the divert coming back through the back door.
  it("nothing in the ordering screen's size grids reads the note", () => {
    for (const grid of ["{selectedSizes.map(s => {", "{sizesOf(qv).map(sz => {", "{szs.map(sz => {"]) {
      const i = APP.indexOf(grid);
      expect(i, `the grid moved: ${grid}`).toBeGreaterThan(-1);
      const body = APP.slice(i, i + 6000);
      expect(body, `a size grid reads the floor note: ${grid}`).not.toMatch(/displayOnFloorAt|displayLocationNote|displayFloorsAtOrderTime/);
    }
  });
});
