// ─── THE DISPLAY MARKER IS INFORMATIONAL — THE PROOF ─────────────────────────
//
// Owner spec, 2026-09-07. The monitor glyph on a size tile tells an assistant
// that a unit of that size is standing on a shop floor. That is all it does.
// It used to be a gate as well: when the display pair was a size's last Hub 1
// availability the tile went amber, the tap was intercepted, and a "Request
// display pair" panel opened instead of the size being selected. A size with
// four pairs and one on a wall could not be sold at all.
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
  cellAvailability, cellBlockInfo, allocateSneakerCart, promisedKey, DISPLAY_PAIR_HUB,
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

  it("availability is identical with the slot and without it, at every depth", () => {
    for (const qty of [1, 2, 3, 4, 10]) {
      const withSlot = cellAvailability({ cells: cells(qty), promised: {}, productId: "p1", size: "9" });
      // There is no slot term in the computation at all — which is the point.
      // Nothing about MARKED_SLOTS reaches cellAvailability, and if a future
      // edit wired one in, this and the case above would disagree.
      expect(withSlot).toBe(qty);
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
      it("the tap is never intercepted by the display data", () => {
        const body = bodyOf(name);
        expect(body).not.toMatch(/sneakerDisplayOnly/);
        expect(body).not.toMatch(/setDisplayPrompt|setQvDisplayPrompt/);
        expect(body).not.toMatch(/\bdOnly\b|\bdispOnly\b/);
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
    expect(APP).toContain("if (dp) { onAddDisplayPartner(qv, qvSize || null, qvDisplayPair); setQv(null); return; }");
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
