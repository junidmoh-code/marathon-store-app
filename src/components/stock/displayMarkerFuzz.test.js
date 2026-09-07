// ─── A PROPERTY FUZZ: THE MARKER CANNOT REACH THE ANSWER ─────────────────────
//
// The standing substitute when CodeRabbit does not run (it was rate-limited on
// PR #576 — a 7-day allowance, not a short window) is a second adversarial
// architect pass PLUS a property fuzz of the thing under test. This is that
// fuzz, and it is not a formality: on #567 a fuzz found three defects in its
// first run that four reviewers had all missed.
//
// THE INVARIANT UNDER TEST, in one sentence: a registered display slot changes
// nothing about what a size offers. The example tests assert that at the sizes
// and depths the author thought to check. This asserts it as a DIFFERENTIAL
// over worlds nobody chose — the same random world answered twice, once with
// the display slots present and once with them stripped out, with the two runs
// required to agree on every output that reaches a screen or an order:
//
//   • how many units the cell offers (cellAvailability)
//   • which hub serves the size, and what is left there (resolveSneakerSourcing)
//   • which hub each cart line is charged to, and which cells over-drew
//     (allocateSneakerCart)
//   • the reason text's own inputs (cellBlockInfo)
//
// That is the differential-test rule this repo already keeps: run BOTH copies
// over the same inputs rather than asserting one of them looks right.
//
// It is a strong test precisely because it should be trivially true — nothing
// about the slots is passed into any of these functions today. What it fences
// is the future edit that quietly wires one back in, which is exactly how the
// deleted rule would return: not as a divert anyone could see, but as a term
// inside an availability computation, invisible until an assistant loses a
// sale in front of a customer.
//
// SEEDED, so a failure replays from its case index alone.

import { describe, it, expect } from "vitest";
import {
  cellAvailability, cellBlockInfo, resolveSneakerSourcing, allocateSneakerCart,
  promisedKey, DISPLAY_PAIR_HUB, GATED_SNEAKER_HUBS,
} from "./availabilityCore";
import { displayUnitsByCell, slotsAfterOrderExits, pendingDisplayPullsByCell } from "./displayPairCore";
// The cells map production hands these functions is keyed by decodedCellKey —
// "Free Size" lives under "_" and a half size under "5_5". Building the fixture
// any other way tests a shape the app never produces: the fuzz's first two runs
// both failed on exactly that, reading a real cell as an empty one.
import { decodedCellKey } from "../../utils/sizeKey";

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const int = (r, n) => Math.floor(r() * n);

const SIZES = ["5", "5.5", "6", "7", "8", "9", "10", "11", "Free Size"];
const STORES = ["marathon-pe", "trophy", "marathon-pine"];
const PIDS = ["p1", "p2", "p3"];
// Values that have genuinely reached a JS object from RTDB in this codebase:
// an absent child, a legacy empty string, a number where a string belongs, a
// negative cell (they exist and clamp), a cell that is a bare number rather
// than the { qty } object the schema promises.
const QTYS = [0, 1, 2, 3, 4, 7, -2, null, undefined, "3", NaN];

/** One random world: stock cells, promises, a cart, and a set of display slots. */
function world(r) {
  const cells = {};
  for (const pid of PIDS) {
    cells[pid] = {};
    for (const sz of SIZES) if (r() < 0.6) cells[pid][decodedCellKey(sz)] = { qty: pick(r, QTYS) };
  }
  const promised = {};
  for (const pid of PIDS) for (const sz of SIZES) if (r() < 0.2) promised[promisedKey(pid, sz)] = int(r, 4);

  // The slots node, in its live shape. Deliberately includes tombstones
  // (size null), the one-size sentinel and hub2-booked rows — every kind of
  // row displayUnitsByCell has to survive.
  const slots = {};
  for (const store of STORES) {
    for (const pid of PIDS) {
      if (r() > 0.45) continue;
      const tomb = r() < 0.2;
      const size = tomb ? null : pick(r, SIZES);
      slots[store] = slots[store] || {};
      slots[store][pid] = {
        size, sizeKey: size === "5.5" ? "5_5" : size === "Free Size" ? "_" : size,
        bookedHub: r() < 0.85 ? "hub1" : "hub2",
        source: pick(r, ["registration", "display_refill", "display_sold", "manual"]),
        ...(tomb ? { prevSize: pick(r, SIZES) } : {}),
      };
    }
  }

  const lines = [];
  for (let i = 0; i < int(r, 6); i++) {
    lines.push({ product: { id: pick(r, PIDS), category: "Footwear", productType: "sneaker" }, size: pick(r, SIZES) });
  }
  return { cells, promised, slots, lines };
}

const hubData = (cells, promised, ready = true) => ({
  hub1: { cells, promised, ready },
  hub2: { cells: {}, promised: {}, ready },
});

describe("a display slot is invisible to every answer the ordering screen gives", () => {
  // 400 worlds is enough to hit tombstones, one-size sentinels, hub2 rows,
  // negative cells and over-promised cells many times over, and still runs in
  // well under a second.
  const CASES = 400;

  it("the fuzz actually generates marked cells — otherwise it proves nothing", () => {
    // A differential over worlds with no markers in them would pass forever
    // while asserting nothing. This is the guard on the guard.
    let marked = 0;
    for (let i = 0; i < CASES; i++) {
      const { slots } = world(rng(i + 1));
      if (Object.keys(displayUnitsByCell(slots, "hub1")).length) marked++;
    }
    expect(marked).toBeGreaterThan(CASES / 4);
  });

  it("availability, sourcing, allocation and the ✕ reason are identical with and without the slots", () => {
    for (let i = 0; i < CASES; i++) {
      const r = rng(i + 1);
      const { cells, promised, slots, lines } = world(r);
      const marks = displayUnitsByCell(slots, DISPLAY_PAIR_HUB);
      const at = (msg) => `case ${i + 1}: ${msg}`;

      for (const pid of PIDS) {
        for (const sz of SIZES) {
          const key = promisedKey(pid, sz);
          const args = { cells, promised, productId: pid, size: sz };

          // 1. THE NUMBER ON THE TILE. Whatever the slots say, availability is
          //    the cell minus its promises — and a marked cell must not read
          //    lower than the identical unmarked one.
          const avail = cellAvailability(args);
          expect(avail, at(`availability went negative for ${key}`)).toBeGreaterThanOrEqual(0);

          // 2. THE DIFFERENTIAL, AND IT HAS TO BE A REAL ONE. Comparing a
          //    function against itself on the same arguments proves nothing —
          //    it passes whatever the function does. So the comparison is made
          //    where the two worlds actually differ: the TILE, composed the way
          //    the screen composes it, from the same world once WITH its slots
          //    and once with the slots node emptied.
          //
          //    Everything that governs the tile must agree between the two.
          //    The ONLY permitted difference is the glyph.
          const tile = (slotsNode) => {
            const info = cellBlockInfo(args);
            const mk = displayUnitsByCell(slotsNode, DISPLAY_PAIR_HUB)[key];
            return {
              booked: info.booked, promised: info.promised, available: info.available,
              out: info.available <= 0,                       // sneakerOut's rule
              // The screen suppresses the glyph on an ✕ tile — the ✕ is
              // authoritative (displayPairCore's drift rule).
              glyph: info.available > 0 && !!mk,
            };
          };
          const withSlots = tile(slots);
          const without = tile({});
          for (const field of ["booked", "promised", "available", "out"]) {
            expect(withSlots[field], at(`the slots changed ${field} for ${key}`)).toBe(without[field]);
          }
          expect(without.glyph, at(`a glyph appeared with no slots at ${key}`)).toBe(false);

          // 3. AND THE MARKER STILL SAYS SOMETHING. When a cell is marked the
          //    glyph has real content — units and the stores whose floors they
          //    are on — but that content never enters the arithmetic above.
          const m = marks[key];
          if (m) {
            expect(m.units, at(`a marked cell claims no units at ${key}`)).toBeGreaterThan(0);
            expect(Array.isArray(m.stores), at(`stores is not a list at ${key}`)).toBe(true);
            // THE ONE RULE THAT SURVIVED: a cell the books call empty must not
            // be resurrected by a slot. The glyph is suppressed there, and the
            // tile stays an ordinary ✕.
            expect(withSlots.glyph, at(`an empty cell advertised a display at ${key}`)).toBe(avail > 0);
          } else {
            expect(withSlots.glyph, at(`an unmarked cell drew a glyph at ${key}`)).toBe(false);
          }

          // 4. WHICH HUB SERVES IT. The routing answer is the other half of
          //    what the tile shows, and it has no slot term either.
          //    There is no slots parameter to vary, so what is asserted is the
          //    property that makes that true: the answer is a pure function of
          //    the cells, the promises and the tag, and it lands on a real hub
          //    with a non-negative count whether the cell is marked or not.
          for (const tag of [...GATED_SNEAKER_HUBS, "hub3", null]) {
            const a = resolveSneakerSourcing({
              product: { id: pid, category: "Footwear", productType: "sneaker" },
              taggedHub: tag, size: sz, hubData: hubData(cells, promised),
            });
            // The hub is the TAG, or the gated alternate the tag could not
            // supply (#568's fallback) — never nothing, and never a hub
            // outside that pair.
            // An UNGATED tag (hub3, or none at all) is returned untouched —
            // "this screen cannot answer for it" — and must never be quietly
            // routed into a gated hub.
            const allowed = GATED_SNEAKER_HUBS.includes(tag) ? GATED_SNEAKER_HUBS : [tag];
            expect(allowed, at(`sourcing landed on ${a.hub} for ${key} tagged ${tag}`)).toContain(a.hub);
            if (a.available !== null) {
              expect(a.available, at(`sourcing went negative for ${key}`)).toBeGreaterThanOrEqual(0);
              // AND IT AGREES WITH THE TILE. Two answers on one screen is the
              // defect #568 and #570 both existed to close; a marked cell must
              // not reopen it.
              if (GATED_SNEAKER_HUBS.includes(a.hub) && a.hub === DISPLAY_PAIR_HUB) {
                expect(a.available, at(`sourcing and the tile disagree at ${key}`)).toBe(avail);
              }
            }
          }
        }
      }

      // 5. THE CART. Every line is a PLAIN line — the divert that used to
      //    stamp displayPairRequest is gone — so allocation must charge each
      //    to a real hub and must never invent the pull lane's pin.
      const alloc = allocateSneakerCart({
        lines, hubData: hubData(cells, promised), taggedHubFor: () => DISPLAY_PAIR_HUB,
      });
      for (const l of lines) {
        expect(l.displayPairRequest, at("a plain cart line grew a pull flag")).toBeUndefined();
        const h = alloc.hubOf.get(l);
        expect(h === undefined || GATED_SNEAKER_HUBS.includes(h), at(`line routed to ${h}`)).toBe(true);
      }
      // Over-allocation is a cart-versus-shelf fact. It may never be a
      // cart-versus-DISPLAY fact: a marked cell holding 3 with 3 lines against
      // it is fully sellable, marker or no marker.
      for (const k of alloc.overAllocated) {
        const [pid] = k.split("::");
        const drawnLines = lines.filter(l => l.product.id === pid && alloc.hubOf.get(l) === DISPLAY_PAIR_HUB
          && promisedKey(l.product.id, l.size) === k);
        const drawn = drawnLines.length;
        // Ask with a SIZE the key was built from, not a string patched back out
        // of the key — promisedKey is one-way and un-patching it is how a
        // half size becomes a different cell.
        const have = cellAvailability({ cells, promised, productId: pid, size: drawnLines[0]?.size ?? "" });
        expect(drawn, at(`${k} flagged over-allocated while ${have} were available`)).toBeGreaterThan(have);
      }
    }
  });

  // ── THE ONE PLACE DISPLAY DATA MAY STILL TOUCH AVAILABILITY ───────────────
  // A PENDING PULL — an order that already asked for a named display pair — is
  // a hard claim on a unit whose slot was tombstoned at order creation, and it
  // is netted against Hub 1. That is the pull contract (#456), not the marker,
  // and nothing on this branch changed it. The fuzz pins the distinction: a
  // SLOT alone never nets, a pull ORDER always does.
  it("a slot alone nets nothing; only a pending pull ORDER does", () => {
    for (let i = 0; i < 120; i++) {
      const r = rng(1000 + i);
      const { cells, promised, slots } = world(r);
      const products = Object.fromEntries(PIDS.map(p => [p, { id: p, category: "Footwear", productType: "sneaker" }]));
      // No orders at all: whatever the slots hold, nothing is claimed.
      expect(pendingDisplayPullsByCell([], products), `case ${i}`).toEqual({});
      // And the slot map is unaffected by an empty order list, which is what
      // makes the two lanes independent.
      expect(displayUnitsByCell(slotsAfterOrderExits(slots, []), "hub1"))
        .toEqual(displayUnitsByCell(slots, "hub1"));
      // Availability with no promises is the raw cell, clamped — no slot term.
      //
      // Through decodedCellKey on BOTH sides, which is the only honest way to
      // ask: a raw "5.5" or "Free Size" key addresses a different cell from the
      // one production writes, and reads back as a false zero (#279's phantom
      // cells, and the half-size trap PR #446 fixed). The fuzz walked into both
      // on its first two runs — recorded here so the next reader does not
      // mistake that for a bug in the code under test.
      for (const pid of PIDS) for (const sz of SIZES) {
        // typeof === "number", exactly as cellBlockInfo requires: a cell whose
        // qty arrived from RTDB as the STRING "3" is deliberately read as zero
        // rather than coerced, and an expectation that coerced it would have
        // called correct behaviour a bug (the fuzz's third run did).
        const raw = cells[pid]?.[decodedCellKey(sz)]?.qty;
        const expected = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, raw) : 0;
        expect(cellAvailability({ cells, promised: {}, productId: pid, size: sz }), `case ${i} ${pid}::${sz}`)
          .toBe(expected);
      }
      // And the trap itself, pinned: a cell written under the RAW size is
      // invisible, while the same units under the decoded key are found.
      expect(cellAvailability({ cells: { x: { "Free Size": { qty: 5 } } }, promised: {}, productId: "x", size: "Free Size" }))
        .toBe(0);
      expect(cellAvailability({ cells: { x: { _: { qty: 5 } } }, promised: {}, productId: "x", size: "Free Size" }))
        .toBe(5);
      expect(promised).toBeTruthy();
    }
  });
});
