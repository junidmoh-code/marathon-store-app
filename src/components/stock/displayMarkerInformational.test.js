// ─── THE DISPLAY MARKER IS INFORMATIONAL — THE PROOF ─────────────────────────
//
// Owner spec, 2026-09-07. The monitor glyph on a size tile tells an assistant
// that a unit of that size is standing on a shop floor. That is all it does.
// It used to be a gate as well: when the display pair was a size's last Hub 1
// availability — the predicate was `0 < available <= displayUnits` — the tile
// went amber, the tap was intercepted, and a "Request display pair" panel
// opened instead of the size being selected. One unit with one slot lost its
// only sale, and because `available` was the resolver's LIVE remaining count,
// a cell physically holding four lost the lot the moment three were promised
// or already in a cart.
//
// This file proves the three things the spec asks for, in two registers:
//
//   PART 1 — BEHAVIOURAL, against the real availability and allocation code.
//     A registered display slot changes NOTHING about what a size offers: not
//     the number available, not whether it is out, not whether a cart line for
//     it allocates. Quantity alone governs, and a marked cell at zero behaves
//     identically to an unmarked cell at zero.
//
//   PART 2 — STRUCTURAL, against App.jsx as text. The three size grids live
//     inside AssistantView / AssistantDesktop, which cannot be mounted without
//     a live firebase subscription (the honest limit altSheetWiring.test.js
//     states, and the reason those pins exist at all). So the tap path is
//     proved the only other way it can be: by reading the handlers and showing
//     there is no display-shaped branch left in any of them — no early return,
//     no divert, no separate style, on any of the three surfaces.
//
// Part 2 is circular and admitted. What makes it worth having is that the
// failure it guards is invisible: a re-introduced divert looks like a working
// screen right up until an assistant loses a sale in front of a customer.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  cellAvailability, cellBlockInfo, allocateSneakerCart, resolveSneakerSourcing,
  promisedKey, DISPLAY_PAIR_HUB,
} from "./availabilityCore";
import { displayUnitsByCell } from "./displayPairCore";

const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");

const SNEAKER = { id: "p1", category: "Footwear", productType: "sneaker" };

// One shoe, size 9, with a display pair registered against it at Hub 1 — the
// exact live shape (/settings/displaySlots/{store}/{pid}).
const MARKED_SLOTS = {
  "marathon-pe": { p1: { size: "9", sizeKey: "9", bookedHub: "hub1", source: "registration" } },
};
const cells = (qty) => ({ p1: { 9: { qty } } });

describe("PART 1 — a display slot does not change what the size offers", () => {
  it("the slot IS seen — the glyph has its input", () => {
    // If this ever stopped being true the rest of the file would pass
    // vacuously: "no difference" is only meaningful while there is a marker.
    expect(displayUnitsByCell(MARKED_SLOTS, "hub1")[promisedKey("p1", "9")])
      .toEqual({ units: 1, stores: ["marathon-pe"], unverified: 0 });
  });

  // ── TAP SELECTS, ADD-TO-CART SUCCEEDS ─────────────────────────────────────
  // FOUR UNITS, ONE ON A WALL. This is the owner's own example and the whole
  // reason for the change: the marked size must offer four, not zero.
  it("four in stock with one on display still offers FOUR", () => {
    const avail = cellAvailability({ cells: cells(4), promised: {}, productId: "p1", size: "9" });
    expect(avail).toBe(4);
    expect(avail > 0).toBe(true);            // sneakerOut's own test: not out
  });

  // THE HARDEST CASE, and the one the old rule fired on: the display pair is
  // the ONLY unit. displayOnly(1, 1) was true, so the tile lost its tap. A
  // display pair is hub stock (#324) — it is one sellable unit like any other,
  // and selling it is the shop's decision, not the tile's.
  it("ONE in stock and it is the display pair — still one available, still sellable", () => {
    expect(cellAvailability({ cells: cells(1), promised: {}, productId: "p1", size: "9" })).toBe(1);
  });

  // A REAL DIFFERENTIAL, not a function compared against itself. The first
  // draft of this test called cellAvailability twice with the same arguments
  // and never passed the slots in at all — it would have passed whatever the
  // code did (independent review, 2026-09-07). The comparison has to be made
  // where the two worlds actually differ, which is the TILE: composed the way
  // the screen composes it, from the same cell once WITH its slots and once
  // with the slots node emptied. Everything that governs the tile must agree;
  // the only permitted difference is the glyph.
  const tile = (qty, slotsNode) => {
    const info = cellBlockInfo({ cells: cells(qty), promised: {}, productId: "p1", size: "9" });
    const mk = displayUnitsByCell(slotsNode, "hub1")[promisedKey("p1", "9")];
    return {
      booked: info.booked, promised: info.promised, available: info.available,
      out: info.available <= 0,                       // sneakerOut's own rule
      glyph: info.available > 0 && !!mk,              // the ✕ suppresses it
    };
  };
  it("the tile is identical with the slots and without them — except for the glyph", () => {
    for (const qty of [0, 1, 2, 3, 4, 10]) {
      const marked = tile(qty, MARKED_SLOTS);
      const plain = tile(qty, {});
      for (const f of ["booked", "promised", "available", "out"]) {
        expect(marked[f], `qty ${qty}: the slots changed ${f}`).toBe(plain[f]);
      }
      expect(plain.glyph, `qty ${qty}: a glyph with no slots`).toBe(false);
      expect(marked.glyph, `qty ${qty}: the glyph did not follow availability`).toBe(qty > 0);
    }
  });

  // ── A CART LINE FOR A MARKED SIZE ALLOCATES LIKE ANY OTHER ────────────────
  // The line is a PLAIN one — no displayPairRequest flag, because the divert
  // that used to stamp it is gone. It must still be charged to Hub 1 and must
  // not be treated as over-allocated.
  it("a plain cart line for a marked size allocates at Hub 1, unflagged", () => {
    const line = { product: SNEAKER, size: "9" };
    const alloc = allocateSneakerCart({
      lines: [line],
      hubData: { hub1: { cells: cells(1), promised: {}, ready: true }, hub2: { cells: {}, promised: {}, ready: true } },
      taggedHubFor: () => DISPLAY_PAIR_HUB,
    });
    expect(alloc.hubOf.get(line)).toBe("hub1");
    expect(alloc.overAllocated.has(promisedKey("p1", "9"))).toBe(false);
    expect(line.displayPairRequest).toBeUndefined();
  });

  // ── THE QUANTITY CONTROLS WORK, AND THEY ALSO STOP ────────────────────────
  // "Quantity controls work" is not "quantity controls are unbounded". The
  // desktop quick-add had a zero check and no clamp, so a stepper set to five
  // against a cell holding one added five lines. That was a pre-existing gap
  // this change WIDENED: a display-only size used to divert into a request
  // that forced quantity 1, and now takes the ordinary path with the stepper
  // live — five orders against one pair standing on a shop floor (independent
  // review, 2026-09-07). quickAdd now runs addToCart's own belt.
  it("a quantity larger than the hub can supply is clamped to what it has", () => {
    const world = { hub1: { cells: cells(1), promised: {}, ready: true }, hub2: { cells: {}, promised: {}, ready: true } };
    const { available } = resolveSneakerSourcing({ product: SNEAKER, taggedHub: "hub1", size: "9", hubData: world });
    expect(available).toBe(1);
    // The clamp is Math.min(reps, Math.max(1, available)) — the exact
    // expression both surfaces now use.
    expect(Math.min(5, Math.max(1, available))).toBe(1);
  });
  it("and the clamp is wired into the desktop path, not just the phone sheet", () => {
    // Both surfaces, same belt, from the resolver's own remaining count —
    // recomputing one double-counts the cart (the defect #570 closed).
    expect(APP.match(/reps = Math\.min\(reps, Math\.max\(1, clampLeft\)\);/g) || []).toHaveLength(2);
    const i = APP.indexOf("const quickAdd = (p, size, qty = 1) => {");
    expect(i).toBeGreaterThan(-1);
    const body = APP.slice(i, APP.indexOf("\n  };", i));
    expect(body).toContain("const { hub: clampHub, available: clampLeft } = sneakerSourcing(p, size);");
    expect(body).toContain("if (sneakerGateReady(clampHub) && Number.isFinite(clampLeft)) {");
  });

  // FOUR UNITS, FOUR TAPS. The quantity controls have to keep working on a
  // marked size — "it selects, it adds, quantity controls work".
  it("four cart lines against four units are all allocated, none over-drawn", () => {
    const lines = Array.from({ length: 4 }, () => ({ product: SNEAKER, size: "9" }));
    const alloc = allocateSneakerCart({
      lines,
      hubData: { hub1: { cells: cells(4), promised: {}, ready: true }, hub2: { cells: {}, promised: {}, ready: true } },
      taggedHubFor: () => DISPLAY_PAIR_HUB,
    });
    for (const l of lines) expect(alloc.hubOf.get(l)).toBe("hub1");
    expect(alloc.overAllocated.has(promisedKey("p1", "9"))).toBe(false);
  });

  // ── AT ZERO, THE MARKED SIZE IS EXACTLY AN UNMARKED SIZE ──────────────────
  // The existing out-of-stock behaviour applies, unchanged. Not "unchanged
  // apart from a display note": byte-identical, because the ✕ is authoritative
  // and a cell the books call empty must never advertise a display.
  it("quantity 0 with a slot registered is out — identically to quantity 0 without one", () => {
    const marked = cellAvailability({ cells: cells(0), promised: {}, productId: "p1", size: "9" });
    const plain  = cellAvailability({ cells: { p1: {} }, promised: {}, productId: "p1", size: "9" });
    expect(marked).toBe(0);
    expect(plain).toBe(0);
    expect(marked).toBe(plain);
  });
  it("and the WHY behind that ✕ says nothing about a display either", () => {
    const why = cellBlockInfo({ cells: cells(0), promised: {}, productId: "p1", size: "9" });
    expect(JSON.stringify(why)).not.toMatch(/display/i);
  });
  // The last unit sold while a slot row still stands (the drift the register
  // used to cause, #574): 0 available, and the tile must be a plain ✕.
  it("a stale slot on an empty cell cannot resurrect the size", () => {
    expect(displayUnitsByCell(MARKED_SLOTS, "hub1")[promisedKey("p1", "9")].units).toBe(1);
    expect(cellAvailability({ cells: cells(0), promised: {}, productId: "p1", size: "9" })).toBe(0);
  });
});

describe("PART 2 — no size grid has a display-shaped branch left", () => {
  // The three surfaces, named by the line each tile's handler is built around.
  // If a grid is renamed or moved these lookups fail loudly rather than
  // silently vouching for nothing.
  const grids = {
    "phone sheet": { start: "{selectedSizes.map(s => {", end: "\n            </div>" },
    "desktop quick-view": { start: "{sizesOf(qv).map(sz => {", end: "\n                    </div>" },
    "desktop hover grid": { start: "{szs.map(sz => {", end: "\n                          </div>" },
  };
  const bodyOf = (name) => {
    const { start, end } = grids[name];
    const i = APP.indexOf(start);
    expect(i, `the ${name} size grid moved`).toBeGreaterThan(-1);
    const j = APP.indexOf(end, i);
    expect(j, `the ${name} size grid's end moved`).toBeGreaterThan(i);
    return APP.slice(i, j);
  };

  for (const name of Object.keys(grids)) {
    describe(name, () => {
      // THE TAP. Every early return in the handler must be an availability
      // return or a deselect — never a display one.
      //
      // AND THE PIN IS ON THE HANDLER, NOT THE TILE. Naming the old divert's
      // own tokens is not enough: a rebuilt one written as
      // `if (dispInfo) { setPendingDisplayPartner(true); return; }` uses no
      // amber, no prompt state and none of the deleted names, and every
      // token-level pin would wave it through (review, 2026-09-07). So the
      // onClick body is sliced out and required to mention nothing display-
      // shaped at all — which it currently does not, so the pin costs nothing
      // and closes the loophole.
      it("the tap is never intercepted by the display data", () => {
        const body = bodyOf(name);
        expect(body).not.toMatch(/sneakerDisplayOnly/);
        expect(body).not.toMatch(/setDisplayPrompt|setQvDisplayPrompt/);
        expect(body).not.toMatch(/\bdOnly\b|\bdispOnly\b/);
      });
      it("…and the tap handler mentions nothing display-shaped at all", () => {
        const body = bodyOf(name);
        const i = body.indexOf("onClick=");
        expect(i, `${name} lost its onClick`).toBeGreaterThan(-1);
        // To the end of the handler: the `}}` that closes the arrow and the
        // JSX attribute together. Every grid writes it that way.
        const j = body.indexOf("}}", i);
        expect(j, `${name}'s onClick body has no end`).toBeGreaterThan(i);
        // CODE LINES ONLY — the handlers explain themselves in prose, and one
        // of those sentences names the Display Partner request the tap must
        // NOT be confused with. Burning the explanation is not the goal.
        const handler = body.slice(i, j).split("\n")
          .filter((l) => !/^\s*\/\//.test(l)).join("\n");
        expect(handler.length, `${name}'s onClick slice came back empty`).toBeGreaterThan(40);
        expect(handler, `a display term is back in ${name}'s tap handler: ${handler}`)
          .not.toMatch(/isplay|dInfo|dispInfo/);
      });
      // THE ONE THING THE MARKER MAY STILL DO. It reads the slots for the
      // glyph and for nothing else, so its only appearance is the info read.
      it("the only display read left is the informational one", () => {
        const body = bodyOf(name);
        const reads = body.match(/sneakerDisplay\w+/g) || [];
        expect(reads.length).toBeGreaterThan(0);          // the glyph is still drawn
        expect([...new Set(reads)]).toEqual(["sneakerDisplayInfo"]);
      });
      // NO SEPARATE CHIP. An amber tile is a different affordance whatever the
      // handler does; the spec keeps the icon and the label, nothing else.
      it("a marked chip is styled exactly like an unmarked one", () => {
        const body = bodyOf(name);
        expect(body).not.toContain("251,191,36");         // the amber the marker used
        expect(body).not.toContain("#FBBF24");
      });
    });
  }

  // THE DIVERT ITSELF — both panels, and the words on them. Code lines only:
  // the comments where the divert is explained are the record of why it went,
  // and burning them would delete the explanation with the feature.
  const CODE = APP.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  it("neither divert panel exists any more", () => {
    expect(CODE).not.toContain("Request display pair");
    expect(CODE).not.toContain("— on display");
    expect(CODE).not.toContain("The only size");
  });
  it("nor the reader that opened them, anywhere in the file", () => {
    expect(APP).not.toContain("sneakerDisplayOnly");
    expect(APP).not.toContain("displayOnly");
  });
  // ── THE CLAIM STATE IS GONE FROM THE COMPOSER, NOT LEFT DORMANT ───────────
  // The divert was the only thing that ever set pendingDisplayPair /
  // qvDisplayPair to anything but null, so with it gone they were state with
  // no input feeding a branch that WRITES a flag onto a cart line. Three
  // independent reviewers landed on the same call and it is the right one: a
  // dormant minter re-arms silently — a future edit that repopulates either
  // one would start stamping pull flags with no UI trace at all, and no
  // tap-handler pin would notice, because it need not touch a tap handler to
  // do it. So the state, the branch in addToCart and addDisplayPartner's third
  // argument are all deleted.
  //
  // The ORDER-side readers stay, and the difference is the direction: they only
  // ever READ a flag off a record in RTDB, for orders placed before this
  // shipped. The checkout pre-flight stays for the same reason — it can only
  // refuse, never write.
  it("no display-pair claim state survives in the composer", () => {
    expect(APP).not.toContain("pendingDisplayPair");
    expect(APP).not.toContain("qvDisplayPair");
    expect(APP).not.toContain("line.displayPairRequest = true");
    // And addDisplayPartner takes the two arguments it needs and no third.
    expect(APP).toContain("const addDisplayPartner = (p, size) =>");
  });
  // The order-side contract is NOT collateral damage — every reader that a
  // record placed before this shipped still depends on is still here.
  it("but every order-side reader of the flag is still standing", () => {
    for (const reader of [
      "item.displayPairRequest === true",                       // checkout pre-flight
      "order.displayPairRequest === true",                      // warehouse banner
      "displayPairRequest: item.displayPairRequest === true",   // the order record
      "displaySlotStoreFor(order)",                             // the slot clear / refill replay
    ]) {
      expect(APP, `an order-side reader of the pull flag was lost: ${reader}`).toContain(reader);
    }
  });

  // NOT BEHIND A FLAG. A divert that is merely disabled is a divert.
  it("and it is deleted, not switched off", () => {
    for (const l of APP.split("\n")) {
      if (!/displayPrompt/i.test(l)) continue;
      expect(l, `a display prompt survives: ${l.trim().slice(0, 100)}`).toMatch(/^\s*(\/\/|\*)/);
    }
  });
});

describe("PART 3 — the Request Display Partner button is untouched", () => {
  // It is now the ONLY way to ask for a display partner, which is what it was
  // always for. Both surfaces keep their button, their toggle state and the
  // line shape that carries the request into placement.
  it("both surfaces still render the button", () => {
    const CODE = APP.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(CODE.match(/Request Display Partner/g) || []).toHaveLength(2);
  });
  it("the phone sheet's toggle still drives the request flag", () => {
    expect(APP).toContain("setPendingDisplayPartner(v => !v);");
    expect(APP).toContain("requestDisplayPartner: pendingDisplayPartner };");
  });
  it("the quick-view's toggle still drives it too, through addDisplayPartner", () => {
    expect(APP).toContain("setQvDP(v => !v);");
    expect(APP).toContain("if (dp) { onAddDisplayPartner(qv, qvSize || null); setQv(null); return; }");
    expect(APP).toContain("product: p, size: size || null, requestDisplay: false, requestDisplayPartner: true,");
  });
  // The button's whole point: it asks for what the hub cannot supply, so the
  // partner toggle lifts the ✕. That exemption predates this change and must
  // survive it — removing the divert must not have narrowed the button.
  it("partner mode still lifts the ✕ on both surfaces", () => {
    expect(APP).toContain("const snkOut = !clothing && !pendingDisplayPartner && !deadForOrder(selected) && sneakerOut(selected, s);");
    expect(APP).toContain("const snkOut = !clothingOrder && !qvDP && !deadForOrder(qv) && !!sneakerOut?.(qv, sz);");
  });
  // A size is optional on a partner request — the requester is not holding the
  // shoe; the picker names the size at send (displaySend.js owns that rule).
  it("a partner request is still placeable with no size", () => {
    expect(APP).toContain("if (!pendingSize && !pendingDisplayPartner) return;");
    expect(APP).toContain('"Add Display Partner Request to Cart"');
  });
});
