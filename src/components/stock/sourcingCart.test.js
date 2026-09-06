// ─── THE CART IS PART OF THE SOURCING QUESTION ───────────────────────────────
//
// #568 made routing stock-aware but left the DEVICE'S OWN CART out of it, so
// the screen answered the same question twice with different inputs:
//
//   resolveSneakerSourcingHub:  available(tag) > 0        -> the tag wins
//   sneakerOut:                 available(tag) <= inCart  -> ✕
//
// and the alternate hub was never consulted, however much it held. An
// assistant holding one pair of a size was refused a second that physically
// exists at the other hub. Measured on live stock 2026-09-06: 14 product/size
// cells at cart depth 1, 46 at depth 2, 60 at depth 3.
//
// resolveSneakerSourcing returns the hub AND what is left at it, from one
// computation, with the cart as an input. This file is the proof that the two
// can no longer disagree.
import { describe, it, expect } from "vitest";
import {
  resolveSneakerSourcing, resolveSneakerSourcingHub, cellAvailability,
  GATED_SNEAKER_HUBS, DISPLAY_PAIR_HUB,
} from "./availabilityCore";
import { gatedSneakerHub } from "./availabilityCore";
import { decodeSizeKey } from "../../utils/sizeKey";

const SNEAKER = { id: "s1", category: "Footwear", productType: "sneaker" };
const CLOTHING = { id: "c1", category: "Clothing", productType: "clothing" };

// Built the way production builds it — STORED keys through decodeSizeKey, which
// is what useStockCellsState hands the caller.
const cells = (pid, rows) => {
  const out = { [pid]: {} };
  for (const [storedKey, qty] of Object.entries(rows)) out[pid][decodeSizeKey(storedKey)] = { qty };
  return out;
};
const hub = (cellsMap, promised = {}) => ({ cells: cellsMap, promised, ready: true });
const EMPTY = hub({});
const UNREAD = { cells: {}, promised: {}, ready: false };

// tagged hub1 with `h1` units of size 8, hub2 with `h2`.
const world = (h1, h2) => ({
  hub1: h1 === null ? UNREAD : hub(cells("s1", { 8: h1 })),
  hub2: h2 === null ? UNREAD : hub(cells("s1", { 8: h2 })),
});
const ask = (h1, h2, consumed, taggedHub = "hub1") =>
  resolveSneakerSourcing({ product: SNEAKER, taggedHub, size: "8", hubData: world(h1, h2), consumed });

describe("THE FAULT: a cart that exhausts the tag must not hide the other hub", () => {
  // The reported shape. One pair in the cart, the tagged hub's last unit spoken
  // for, three more standing at the other hub — and the chip said ✕.
  it("one in the cart, tag has one, alternate has three -> the alternate, orderable", () => {
    const got = ask(1, 3, 1);
    expect(got.hub).toBe("hub2");
    expect(got.available).toBe(3);
  });
  it("and with an EMPTY cart the tag still wins — nothing about #568 changed", () => {
    const got = ask(1, 3, 0);
    expect(got.hub).toBe("hub1");
    expect(got.available).toBe(1);
  });
  it("the old two-step disagreed exactly here, and no longer can", () => {
    const hubData = world(1, 3);
    // The BEFORE, reconstructed: route from stock alone, subtract the cart after.
    const beforeHub = resolveSneakerSourcingHub({ product: SNEAKER, taggedHub: "hub1", size: "8", hubData });
    const beforeLeft = cellAvailability({ ...hubData[beforeHub], productId: "s1", size: "8" }) - 1;
    expect(beforeHub).toBe("hub1");
    expect(beforeLeft).toBe(0);                       // ✕, with 3 pairs at hub2
    // The AFTER: one computation.
    const after = resolveSneakerSourcing({ product: SNEAKER, taggedHub: "hub1", size: "8", hubData, consumed: 1 });
    expect(after.hub).toBe("hub2");
    expect(after.available).toBe(3);
  });
});

describe("the cart drains the tagged hub FIRST, then spills", () => {
  // Subtracting the whole cart from BOTH hubs would double-count it and refuse
  // a pair that exists. A cart line is a claim on one unit of a product+size,
  // not on a hub, and the tag is drawn down first because the tag wins whenever
  // it can supply.
  it("tag 1 + alternate 1 + cart 1 leaves ONE orderable, not none", () => {
    const got = ask(1, 1, 1);
    expect(got.hub).toBe("hub2");
    expect(got.available).toBe(1);
  });
  it("tag 1 + alternate 1 + cart 2 is genuinely out", () => {
    const got = ask(1, 1, 2);
    expect(got.hub).toBe("hub1");                     // the tag, and a true ✕
    expect(got.available).toBe(0);
  });
  it("the spill only reaches the alternate once the tag is actually exhausted", () => {
    // tag 3, alternate 5, cart 2 -> the tag still has one, so nothing spills.
    expect(ask(3, 5, 2)).toEqual({ hub: "hub1", available: 1 });
    // cart 4 -> tag exhausted and one unit over, so the alternate loses one.
    expect(ask(3, 5, 4)).toEqual({ hub: "hub2", available: 4 });
  });
  it("total orderable never exceeds total stock, at any depth", () => {
    for (let h1 = 0; h1 <= 4; h1++) for (let h2 = 0; h2 <= 4; h2++) {
      for (let c = 0; c <= 8; c++) {
        const { available } = ask(h1, h2, c);
        const left = Math.max(h1 + h2 - c, 0);
        expect(available, `h1=${h1} h2=${h2} cart=${c}`).toBeLessThanOrEqual(left);
      }
    }
  });
  // The property that matters to a customer: if any unit remains anywhere, the
  // screen must offer one. Nothing may be stranded.
  it("if ANY unit remains across both hubs, the answer is orderable", () => {
    for (let h1 = 0; h1 <= 4; h1++) for (let h2 = 0; h2 <= 4; h2++) {
      for (let c = 0; c <= 8; c++) {
        const { hub: chosen, available } = ask(h1, h2, c);
        const left = h1 + h2 - c;
        if (left > 0) {
          expect(available, `h1=${h1} h2=${h2} cart=${c} -> ${chosen}`).toBeGreaterThan(0);
        } else {
          expect(available, `h1=${h1} h2=${h2} cart=${c}`).toBe(0);
        }
      }
    }
  });
  it("a chosen hub always actually holds what it claims", () => {
    for (let h1 = 0; h1 <= 4; h1++) for (let h2 = 0; h2 <= 4; h2++) {
      for (let c = 0; c <= 6; c++) {
        const { hub: chosen, available } = ask(h1, h2, c);
        if (available > 0) expect(chosen === "hub1" ? h1 : h2, `h1=${h1} h2=${h2} cart=${c}`).toBeGreaterThanOrEqual(available);
      }
    }
  });
});

describe("nothing else moved", () => {
  it("identical to the shipped rule at cart depth 0, over the whole grid", () => {
    // AGAINST A COPY OF THE ORIGINAL, not against the new function's own
    // wrapper. Comparing resolveSneakerSourcing to resolveSneakerSourcingHub
    // proves nothing once the latter delegates to the former — it is the same
    // code answering twice (independent review, 2026-09-06). This is #568's
    // rule as it shipped, transcribed.
    const asShipped = ({ product, taggedHub, size, hubData }) => {
      if (!gatedSneakerHub(product, taggedHub)) return taggedHub;
      if (!size) return taggedHub;
      const alternate = GATED_SNEAKER_HUBS.find((h) => h !== taggedHub);
      const tagged = hubData?.[taggedHub];
      const alt = hubData?.[alternate];
      if (!tagged?.ready || !alt?.ready) return taggedHub;
      const here = cellAvailability({ cells: tagged.cells, promised: tagged.promised, productId: product?.id, size });
      if (here > 0) return taggedHub;
      const there = cellAvailability({ cells: alt.cells, promised: alt.promised, productId: product?.id, size });
      return there > 0 ? alternate : taggedHub;
    };
    for (const h1 of [0, 1, 2, 3, null]) for (const h2 of [0, 1, 2, 3, null]) {
      const hubData = world(h1, h2);
      const args = { product: SNEAKER, taggedHub: "hub1", size: "8", hubData };
      expect(resolveSneakerSourcing({ ...args, consumed: 0 }).hub, `h1=${h1} h2=${h2}`).toBe(asShipped(args));
    }
    // …and for a product the rule does not cover, and for a missing size.
    for (const args of [{ product: CLOTHING, taggedHub: "hub1", size: "8", hubData: world(0, 3) },
                        { product: SNEAKER, taggedHub: "hub3", size: "8", hubData: world(0, 3) },
                        { product: SNEAKER, taggedHub: "hub1", size: "", hubData: world(0, 3) }]) {
      expect(resolveSneakerSourcing({ ...args, consumed: 0 }).hub).toBe(asShipped(args));
    }
  });
  it("silence is still not zero — an unread tag answers NOTHING, whatever the cart", () => {
    for (const c of [0, 1, 5]) {
      const got = ask(null, 3, c);
      expect(got.hub).toBe("hub1");
      expect(got.available).toBe(null);
    }
  });
  it("an unread ALTERNATE cannot be chosen, and the tag reports its own truth", () => {
    expect(ask(2, null, 0)).toEqual({ hub: "hub1", available: 2 });
    expect(ask(1, null, 1)).toEqual({ hub: "hub1", available: 0 });   // exhausted, nowhere to go
  });
  it("out of scope stays out of scope — and reports null, never zero", () => {
    // `null <= 0` is TRUE in JavaScript, so a caller that tested the value
    // rather than its finiteness would read "not our business" as "out of
    // stock" for every clothing line and every Pine shoe.
    for (const [p, tagHub] of [[CLOTHING, "hub1"], [SNEAKER, "hub3"], [SNEAKER, null]]) {
      const got = resolveSneakerSourcing({ product: p, taggedHub: tagHub, size: "8", hubData: world(0, 5), consumed: 2 });
      expect(got.available).toBe(null);
      expect(got.hub).toBe(tagHub);
    }
  });
  it("no size, no per-cell question", () => {
    expect(resolveSneakerSourcing({ product: SNEAKER, taggedHub: "hub1", size: "", hubData: world(0, 5), consumed: 1 }).available).toBe(null);
  });
  it("a junk cart count is treated as none, never as a negative credit", () => {
    for (const c of [-3, NaN, null, undefined, "2", {}]) {
      const got = ask(1, 3, c);
      expect(got.available, String(c)).toBeGreaterThan(0);
      expect(got.available).toBeLessThanOrEqual(3);
    }
  });
  it("resolveSneakerSourcingHub is still the same function, one field narrower", () => {
    const hubData = world(1, 3);
    expect(resolveSneakerSourcingHub({ product: SNEAKER, taggedHub: "hub1", size: "8", hubData }))
      .toBe(resolveSneakerSourcing({ product: SNEAKER, taggedHub: "hub1", size: "8", hubData }).hub);
  });
});

// ─── THE DISPLAY-PAIR HUB IS A FACT, NOT A ROUTING ANSWER ────────────────────
describe("a display pair belongs to one hub and cannot be rerouted", () => {
  it("the lane is hub1, named once", () => {
    expect(DISPLAY_PAIR_HUB).toBe("hub1");
    expect(GATED_SNEAKER_HUBS).toContain(DISPLAY_PAIR_HUB);
  });
  // The routing question DOES have an answer for the same product+size — that
  // is exactly the trap. Placement must not ask it for a display-pair line: the
  // pair is an identified physical unit on a named shop's floor, registered
  // against Hub 1, and Hub 2 has no display register to act on the instruction.
  it("the resolver would happily send this size to hub2 — which is why placement must not ask", () => {
    expect(ask(0, 4, 0).hub).toBe("hub2");
  });
});
