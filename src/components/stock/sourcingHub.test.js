// ─── THE SOURCING HUB IS A STOCK QUESTION, NOT ONLY A TAG (2026-09-06) ───────
//
// THE REPORT THIS PINS. A shop opened the order sheet for CHRISTINA LOUBOUTIN
// LOUIS PARIS black. The sheet was headed "Hub 1" and every one of its six
// sizes (6–11) rendered ✕: "Size 6 isn't available at Hub 1 right now — it
// can't be ordered." The Counted Stock screen, filtered to HUB 2, showed the
// same product with 11 units across those same six sizes.
//
// THE GATE WAS RIGHT AND WAS NOT TOUCHED. Live read, 2026-09-06:
// /stock/hub1/p1788276348886 did not exist — no row, not even a zero. Every
// unit was at /stock/hub2 (6→2, 7→2, 8→2, 9→2, 10→2, 11→1), transferred out of
// Central on 3 and 5 September. Hub 1 could supply nothing and said so. The
// fault was the question: App.jsx computeHubForItem picks the sourcing hub from
// the product record's `hubs` TAG, the tag still read ["hub1"], and nothing
// moves a tag when stock moves.
//
// Census the day this shipped (scripts/census-sneaker-hub-misroute.mjs), over
// 1,438 active gated sneakers / 9,053 declared chips: 31 products WHOLLY
// unorderable this way — routed hub empty across every declared size while the
// other gated hub held stock — 187 units stranded (26 tagged hub1 with the
// stock at hub2, 5 the reverse), across 107 product×size chips.
//
// NOT the 1-September seam. Lacoste Powercourt size 8 was a GHOST PROMISE: the
// right hub, a real cell, subtracted by a stale ready order — fixed by
// READY_PROMISE_MAX_AGE_MS. Here the promised term is zero and the cell is
// absent. Same ✕, unrelated cause; both are pinned, in their own files.
import { describe, it, expect } from "vitest";
import { resolveSneakerSourcingHub, cellAvailability, promisedKey } from "./availabilityCore";
import { decodeSizeKey } from "../../utils/sizeKey";

const SNEAKER = { id: "s1", category: "Footwear", productType: "sneaker" };
const CLOTHING = { id: "c1", category: "Clothing", productType: "clothing" };
const PERFUME = { id: "f1", category: "Perfume" };

// Built the way production builds it — STORED keys run through decodeSizeKey,
// which is what useStockCellsState hands the caller. Never hand-type a raw-size
// fixture here (it hides the encoded-vs-decoded indexing bug, PR #446).
const cells = (pid, rows) => {
  const out = { [pid]: {} };
  for (const [storedKey, qty] of Object.entries(rows)) out[pid][decodeSizeKey(storedKey)] = { qty };
  return out;
};
const hub = (cellsMap, promised = {}) => ({ cells: cellsMap, promised, ready: true });
const EMPTY = hub({});

// The live product, as it actually was at 10:59 on 2026-09-06.
const LOUBOUTIN = { id: "p1788276348886", category: "Footwear", productType: "sneaker" };
const LOUB_HUB2 = cells("p1788276348886", { 6: 2, 7: 2, 8: 2, 9: 2, 10: 2, 11: 1 });

describe("the reported case — six sizes, eleven units, the wrong hub asked", () => {
  it("every one of the six sizes now sources from the hub that holds it", () => {
    for (const size of ["6", "7", "8", "9", "10", "11"]) {
      // BEFORE: the tag answered hub1, whose subtree has no row at all →
      // cellAvailability 0 → ✕ on every size.
      expect(cellAvailability({ cells: {}, promised: {}, productId: LOUBOUTIN.id, size })).toBe(0);
      // AFTER: the zero reroutes to the hub that can actually supply it.
      expect(resolveSneakerSourcingHub({
        product: LOUBOUTIN, taggedHub: "hub1", size,
        hubData: { hub1: EMPTY, hub2: hub(LOUB_HUB2) },
      })).toBe("hub2");
    }
  });

  it("and the size is orderable there — the exact counted quantities", () => {
    const expected = { 6: 2, 7: 2, 8: 2, 9: 2, 10: 2, 11: 1 };
    for (const [size, units] of Object.entries(expected)) {
      const resolved = resolveSneakerSourcingHub({
        product: LOUBOUTIN, taggedHub: "hub1", size,
        hubData: { hub1: EMPTY, hub2: hub(LOUB_HUB2) },
      });
      expect(cellAvailability({
        cells: LOUB_HUB2, promised: {}, productId: LOUBOUTIN.id, size,
      })).toBe(units);
      expect(resolved).toBe("hub2");
    }
  });
});

// ─── THE FENCE THAT MATTERS MOST ─────────────────────────────────────────────
// This is a defect fix, not a load balancer. The tag encodes where the owner
// wants a shoe served from; moving a size the tagged hub CAN supply would
// change live Hub 1 behaviour beyond the defect, which this change is not
// allowed to do. Only a zero may move.
describe("the tag still wins whenever it can supply", () => {
  it("one unit at the tagged hub is enough to keep it, however full the other is", () => {
    expect(resolveSneakerSourcingHub({
      product: SNEAKER, taggedHub: "hub1", size: "8",
      hubData: { hub1: hub(cells("s1", { 8: 1 })), hub2: hub(cells("s1", { 8: 99 })) },
    })).toBe("hub1");
  });

  it("and the same in the other direction — hub2 tags are not drained to hub1", () => {
    expect(resolveSneakerSourcingHub({
      product: SNEAKER, taggedHub: "hub2", size: "8",
      hubData: { hub1: hub(cells("s1", { 8: 99 })), hub2: hub(cells("s1", { 8: 1 })) },
    })).toBe("hub2");
  });

  it("a promised-out last unit is NOT availability — that zero may reroute", () => {
    // The promised term is part of "can this hub supply it", exactly as the
    // gate reads it. A cell booked 1 / promised 1 is a zero like any other.
    const promised = { [promisedKey("s1", "8")]: 1 };
    expect(resolveSneakerSourcingHub({
      product: SNEAKER, taggedHub: "hub1", size: "8",
      hubData: { hub1: hub(cells("s1", { 8: 1 }), promised), hub2: hub(cells("s1", { 8: 2 })) },
    })).toBe("hub2");
  });

  it("a NEGATIVE cell is a zero, not a reason to stay", () => {
    expect(resolveSneakerSourcingHub({
      product: SNEAKER, taggedHub: "hub1", size: "8",
      hubData: { hub1: hub(cells("s1", { 8: -2 })), hub2: hub(cells("s1", { 8: 1 })) },
    })).toBe("hub2");
  });
});

describe("both hubs empty — the tag, and a true ✕ naming it", () => {
  it("keeps the tagged hub so the note says the useful thing", () => {
    expect(resolveSneakerSourcingHub({
      product: SNEAKER, taggedHub: "hub1", size: "8",
      hubData: { hub1: EMPTY, hub2: EMPTY },
    })).toBe("hub1");
    expect(resolveSneakerSourcingHub({
      product: SNEAKER, taggedHub: "hub2", size: "8",
      hubData: { hub1: EMPTY, hub2: EMPTY },
    })).toBe("hub2");
  });
});

// ─── SILENCE IS NOT ZERO ─────────────────────────────────────────────────────
// An unsettled or errored subtree is not evidence of an empty hub. The gate has
// refused to ✕ on unsettled data since it was built; routing must refuse to
// MOVE on it for the same reason — otherwise a slow Hub 1 stream would quietly
// re-address orders during every page load.
describe("never reroutes on data that has not settled", () => {
  it("an unread tagged hub is not empty — no reroute", () => {
    expect(resolveSneakerSourcingHub({
      product: SNEAKER, taggedHub: "hub1", size: "8",
      hubData: { hub1: { cells: {}, promised: {}, ready: false }, hub2: hub(cells("s1", { 8: 5 })) },
    })).toBe("hub1");
  });

  it("an unread alternate cannot be chosen, even though it may hold everything", () => {
    expect(resolveSneakerSourcingHub({
      product: SNEAKER, taggedHub: "hub1", size: "8",
      hubData: { hub1: EMPTY, hub2: { cells: cells("s1", { 8: 5 }), promised: {}, ready: false } },
    })).toBe("hub1");
  });

  it("missing hubData entirely leaves the tag alone", () => {
    expect(resolveSneakerSourcingHub({ product: SNEAKER, taggedHub: "hub1", size: "8" })).toBe("hub1");
    expect(resolveSneakerSourcingHub({ product: SNEAKER, taggedHub: "hub1", size: "8", hubData: {} })).toBe("hub1");
  });
});

// ─── WHAT THIS RULE MUST NEVER TOUCH ─────────────────────────────────────────
describe("out of scope, and byte-for-byte unchanged", () => {
  it("Pine (hub3) is never rerouted away from — its grid has never been gated", () => {
    expect(resolveSneakerSourcingHub({
      product: SNEAKER, taggedHub: "hub3", size: "8",
      hubData: { hub1: hub(cells("s1", { 8: 9 })), hub2: hub(cells("s1", { 8: 9 })) },
    })).toBe("hub3");
  });

  it("and hub3 is never rerouted TO — it is not a gated hub", () => {
    // Even with both gated hubs empty, nothing can name hub3.
    expect(resolveSneakerSourcingHub({
      product: SNEAKER, taggedHub: "hub1", size: "8",
      hubData: { hub1: EMPTY, hub2: EMPTY, hub3: hub(cells("s1", { 8: 9 })) },
    })).toBe("hub1");
  });

  it("clothing keeps its own routing — the sneaker gate does not model it", () => {
    expect(resolveSneakerSourcingHub({
      product: CLOTHING, taggedHub: "hub1", size: "M",
      hubData: { hub1: EMPTY, hub2: hub(cells("c1", { M: 9 })) },
    })).toBe("hub1");
  });

  it("perfume / bags / one-size accessories on the sneaker grid keep theirs too", () => {
    expect(resolveSneakerSourcingHub({
      product: PERFUME, taggedHub: "hub1", size: "Free Size",
      hubData: { hub1: EMPTY, hub2: hub(cells("f1", { _: 9 })) },
    })).toBe("hub1");
  });

  it("no size, no per-cell question — the tag answers", () => {
    expect(resolveSneakerSourcingHub({
      product: SNEAKER, taggedHub: "hub1", size: "",
      hubData: { hub1: EMPTY, hub2: hub(cells("s1", { 8: 9 })) },
    })).toBe("hub1");
  });

  it("a null tagged hub stays null — callers read that as 'no gate'", () => {
    expect(resolveSneakerSourcingHub({
      product: SNEAKER, taggedHub: null, size: "8",
      hubData: { hub1: EMPTY, hub2: hub(cells("s1", { 8: 9 })) },
    })).toBeNull();
  });
});

// ─── PER SIZE, NOT PER PRODUCT ───────────────────────────────────────────────
// 107 chips were affected but only 31 whole products: a shoe can hold its 8s at
// one hub and its 9s at the other. Routing per product would fix the Louboutin
// and leave the rest, and worse, would let a tile gated on one hub place a line
// against another.
describe("one shoe can source two hubs, size by size", () => {
  const split = { hub1: hub(cells("s1", { 8: 3, 9: 0 })), hub2: hub(cells("s1", { 8: 0, 9: 4 })) };
  it("the size Hub 1 holds stays at Hub 1", () => {
    expect(resolveSneakerSourcingHub({ product: SNEAKER, taggedHub: "hub1", size: "8", hubData: split })).toBe("hub1");
  });
  it("the size only Hub 2 holds goes to Hub 2", () => {
    expect(resolveSneakerSourcingHub({ product: SNEAKER, taggedHub: "hub1", size: "9", hubData: split })).toBe("hub2");
  });
});

// ─── HALF SIZES GO THROUGH THE SAME KEY SPACE ────────────────────────────────
describe("half sizes resolve on the decoded key, like every other lookup", () => {
  it('a "5.5" stored as "5_5" is found at the hub that holds it', () => {
    expect(resolveSneakerSourcingHub({
      product: SNEAKER, taggedHub: "hub1", size: "5.5",
      hubData: { hub1: EMPTY, hub2: hub(cells("s1", { "5_5": 2 })) },
    })).toBe("hub2");
  });
});

// ─── NOTHING GETS WORSE ──────────────────────────────────────────────────────
// The deploy safety property, stated as an invariant rather than a hope: for
// every product×size, availability at the RESOLVED hub is greater than or equal
// to availability at the TAGGED hub. No chip that was orderable on 2026-09-05
// can read ✕ on 2026-09-06 because of this change — the only movement is
// 0 → something. (It follows from "the tag wins whenever it can supply", but
// that is the sentence a future edit would break, so it is tested directly.)
describe("availability is monotonic — no chip can lose an order it had", () => {
  const QTYS = [-2, -1, 0, 1, 2, 5];
  it("holds for every combination of the two hubs' quantities", () => {
    for (const a of QTYS) for (const b of QTYS) for (const tagged of ["hub1", "hub2"]) {
      const hubData = { hub1: hub(cells("s1", { 8: a })), hub2: hub(cells("s1", { 8: b })) };
      const resolved = resolveSneakerSourcingHub({ product: SNEAKER, taggedHub: tagged, size: "8", hubData });
      const before = cellAvailability({ ...hubData[tagged], productId: "s1", size: "8" });
      const after = cellAvailability({ ...hubData[resolved], productId: "s1", size: "8" });
      expect(after).toBeGreaterThanOrEqual(before);
      // and it only ever MOVES when the tagged hub had nothing to give
      if (resolved !== tagged) expect(before).toBe(0);
    }
  });
});

// ─── THE ✕ NOTE TELLS THE TRUTH ABOUT WHAT WAS CHECKED ───────────────────────
// The report's staff read "isn't available at Hub 1" as "this size doesn't
// exist" and stopped — while eleven units sat at Hub 2. Once routing reads both
// hubs, an ✕ means both were asked, and the note has to say that. This also
// pins the literal used as the post-deploy bundle probe.
import { readFileSync } from "fs";
const appSrc = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");

describe("the both-hubs-empty note", () => {
  it("names both hubs when both were actually read and both were empty", () => {
    expect(appSrc).toContain("Size ${sz} isn't at Hub 1 or Hub 2 right now — it can't be ordered.");
  });
  it("keeps the single-hub wording verbatim when it was not", () => {
    expect(appSrc).toContain("Size ${sz} isn't available at ${hub} right now — it can't be ordered.");
  });
  it("checkedBoth requires BOTH hubs settled — silence is never 'checked'", () => {
    expect(appSrc).toContain("GATED_SNEAKER_HUBS.every(h => sneakerGateReady(h))");
    expect(appSrc).toContain("GATED_SNEAKER_HUBS.every(h => sneakerAvail(p.id, s, h) <= 0)");
  });
});
