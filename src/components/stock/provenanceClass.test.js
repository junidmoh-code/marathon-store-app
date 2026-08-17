// ─── THE CLASSIFIER — what a ledger record proves about a shop ────────────────
//
// Fixtures are REAL records, copied field-for-field out of /stock_movements. That
// matters more than usual here: the whole claim of the provenance study is that the
// recorded shape separates stocking from collection cleanly, and a hand-idealised
// fixture would prove nothing about the shapes that actually exist — including the
// odd ones (`link: { reason: … }`, a `to` of `in_transit`, an undo whose only marker
// is a reason string).
//
// MUTATION-PROVED: every test names the edit that must break it. No test rebuilds
// classifyMovement's rules and compares against a re-implementation.

import { describe, it, expect } from "vitest";
import {
  classifyMovement, foldProvenance, carriesByProvenance,
  STOCKING, COLLECTION, SALE, UNSTOCK, NEUTRAL, UNDO_REASONS, NON_STOCKING_LOCATIONS,
} from "./provenanceClass.js";

const NAVY = "p1786452575638";
const GREY = "p1786453234097";

// ── the eight real movements that made up the 2026-08-17 incident at PE ───────
// Verbatim from the ledger, in ledger order.
const INCIDENT = [
  { id: "disp_018_2026-08-17T07_31_13_672Z", m: { type: "transfer_out", productId: NAVY, size: "M", qty: 1, from: "hub2", to: "marathon-pe", reason: "clothing_order", link: { orderId: "018" }, appliedAt: "2026-08-17T07:58:58.755Z" } },
  { id: "-P-DkDYQQGLR1v-BAwje:p1786452575638:M", m: { type: "transfer_out", productId: NAVY, size: "M", qty: 1, from: "marathon-pe", to: "trophy", reason: null, link: { transferId: "-P-DkDYQQGLR1v-BAwje" }, appliedAt: "2026-08-17T08:05:19.123Z" } },
  { id: "cr_R004-2_...", m: { type: "transfer_out", productId: NAVY, size: "M", qty: 1, from: "hub2", to: "marathon-pe", reason: "clothing_cr", link: { orderId: "R004-2", refillId: "cr_marathon-pe_p1786452575638" }, appliedAt: "2026-08-17T08:20:53.990Z" } },
  { id: "cr_R004-3_...", m: { type: "transfer_out", productId: NAVY, size: "L", qty: 2, from: "hub2", to: "marathon-pe", reason: "clothing_cr", link: { orderId: "R004-3", refillId: "cr_marathon-pe_p1786452575638" }, appliedAt: "2026-08-17T08:20:55.095Z" } },
  { id: "cr_R004-4_...", m: { type: "transfer_out", productId: NAVY, size: "XL", qty: 1, from: "hub2", to: "marathon-pe", reason: "clothing_cr", link: { orderId: "R004-4", refillId: "cr_marathon-pe_p1786452575638" }, appliedAt: "2026-08-17T08:20:56.006Z" } },
  { id: "crundo_R004-2_...", m: { type: "transfer_out", productId: NAVY, size: "M", qty: 1, from: "marathon-pe", to: "hub2", reason: "clothing_cr_undo", link: { orderId: "R004-2", refillId: "cr_marathon-pe_p1786452575638" }, appliedAt: "2026-08-17T08:54:04.280Z" } },
  { id: "crundo_R004-3_...", m: { type: "transfer_out", productId: NAVY, size: "L", qty: 2, from: "marathon-pe", to: "hub2", reason: "clothing_cr_undo", link: { orderId: "R004-3", refillId: "cr_marathon-pe_p1786452575638" }, appliedAt: "2026-08-17T08:54:05.044Z" } },
  { id: "crundo_R004-4_...", m: { type: "transfer_out", productId: NAVY, size: "XL", qty: 1, from: "marathon-pe", to: "hub2", reason: "clothing_cr_undo", link: { orderId: "R004-4", refillId: "cr_marathon-pe_p1786452575638" }, appliedAt: "2026-08-17T08:54:05.907Z" } },
];

describe("THE COLLECTION PASS-THROUGH — the 07:58 / 08:05 / 08:54 sequence", () => {
  it("classifies each of the eight real movements the way the incident requires", () => {
    // MUTATION: change the COLLECTION discriminator from
    // `link.orderId && !link.refillId` to anything keyed on `reason`, and the
    // 07:58 dispatch (reason clothing_order) still passes while the 3,119
    // null-reason dispatches in the live ledger silently become STOCKING.
    const got = INCIDENT.map(({ m }) => {
      const c = classifyMovement(m);
      return [c.cls, c.loc];
    });
    expect(got).toEqual([
      [COLLECTION, "marathon-pe"],   // 07:58 the customer's parcel — proves nothing
      [STOCKING, "trophy"],          // 08:05 walked next door — stocks TROPHY, not PE
      [STOCKING, "marathon-pe"],     // 08:20 the engine's own fulfil
      [STOCKING, "marathon-pe"],
      [STOCKING, "marathon-pe"],
      [UNSTOCK, "marathon-pe"],      // 08:54 undone
      [UNSTOCK, "marathon-pe"],
      [UNSTOCK, "marathon-pe"],
    ]);
  });

  it("folds to: marathon-pe does NOT carry, trophy DOES", () => {
    // MUTATION: drop the net-of-undos in carriesByProvenance and marathon-pe
    // carries again — the loop returns.
    const prov = foldProvenance(INCIDENT.map((x) => x.m));
    const pe = prov.get(`marathon-pe|${NAVY}`);
    expect(pe).toMatchObject({ sold: 0, stockedUnits: 4, unstockedUnits: 4, collectedUnits: 1 });
    expect(carriesByProvenance(pe)).toBe(false);

    // The one unit that was walked next door genuinely stocks Trophy.
    expect(carriesByProvenance(prov.get(`trophy|${NAVY}`))).toBe(true);

    // AND — the design note this fixture exists to pin — an undo debits the shop
    // the units leave and credits NOBODY. hub2 gets the units back physically, but
    // this eight-record slice gives it no stocking provenance, so it does not carry
    // on the strength of the undo alone.
    //
    // That is deliberate. Crediting the `to` leg of an undo would let a hub start
    // "carrying" a line purely because a mistaken fulfil was reversed through it —
    // the same circular reasoning the net-of-undos exists to break, just one hop
    // upstream. hub2's real provenance comes from its own receives (`rrf_*`,
    // `stock_hold_release`), which live elsewhere in the ledger and are tested
    // separately below.
    expect(carriesByProvenance(prov.get(`hub2|${NAVY}`))).toBe(false);
    expect(prov.get(`hub2|${NAVY}`)).toBeUndefined();
  });

  it("a partial undo leaves real stock and DOES carry", () => {
    // Only the M line undone; L and XL stayed at PE. That is 3 units the shop kept.
    const partial = INCIDENT.filter((x) => !x.id.startsWith("crundo_R004-3") && !x.id.startsWith("crundo_R004-4"));
    const prov = foldProvenance(partial.map((x) => x.m));
    expect(carriesByProvenance(prov.get(`marathon-pe|${NAVY}`))).toBe(true);
  });
});

describe("COLLECTION is decided by link shape, never by reason", () => {
  it("a null-reason dispatch is still a collection", () => {
    // 3,119 of the 3,338 collection records in the live ledger look like this.
    const c = classifyMovement({ type: "transfer_out", productId: "p1", size: "9", qty: 1, from: "hub2", to: "marathon-pe", reason: null, link: { orderId: "089" } });
    expect(c.cls).toBe(COLLECTION);
    expect(c.loc).toBe("marathon-pe");
  });

  it("orderId WITH refillId is a refill fulfil, not a collection", () => {
    // The pair of keys is the whole discriminator. MUTATION: drop the
    // `!link.refillId` half and every CR refill becomes a collection, so no shop
    // ever accrues stocking provenance from a refill and the estate starves.
    const c = classifyMovement({ type: "transfer_out", productId: "p1", size: "M", qty: 2, from: "hub2", to: "trophy", reason: "clothing_cr", link: { orderId: "R045-4", refillId: "cr_trophy_p1" } });
    expect(c.cls).toBe(STOCKING);
  });

  it("a dispatch REVERSAL stocks nobody — link.reverses is the marker", () => {
    // 718 live records. Goods come back from a shop to a hub because a customer
    // never collected; reading that as the hub stocking the line would be wrong.
    const c = classifyMovement({ type: "transfer_out", productId: "p1", size: "7", qty: 1, from: "marathon-pe", to: "hub2", reason: "order return (reverses dispatch)", link: { orderId: "089", reverses: "disp_089_x" } });
    expect(c.cls).toBe(NEUTRAL);
    expect(c.loc).toBe(null);
  });
});

describe("adjustments and returns establish nothing — the choice that keeps prose out", () => {
  it("a positive adjustment whose text says the shop holds nothing is neutral", () => {
    // 443 live records. Arithmetically identical to a genuine recount, separable
    // only by reading the sentence — so the whole TYPE is neutral instead.
    // MUTATION: classify positive adjustments as STOCKING and every dead
    // shop-sneaker pair starts carrying again.
    const heal = classifyMovement({ type: "adjustment", productId: "p1", size: "8", qty: 1, to: "marathon-pe", reason: "shop_sneaker_negative_heal: shop no longer holds sneaker stock; negative cleared to zero." });
    expect(heal.cls).toBe(NEUTRAL);
    // …and so is the honest recount, deliberately. Consistency is the point.
    const recount = classifyMovement({ type: "adjustment", productId: "p1", size: "8", qty: 3, to: "marathon-pe", reason: "recount: corrected on the spot" });
    expect(recount.cls).toBe(NEUTRAL);

    // `why` is asserted, not just `cls`. Deleting the adjustment branch leaves the
    // class NEUTRAL anyway — it would fall off the end of the type whitelist — so a
    // cls-only assertion cannot tell "deliberately neutral" from "neutral because
    // nothing matched". That distinction is the whole point: the day someone adds
    // `adjustment` to the stocking branch, this is what stops it silently arming
    // 1,470 correction records. (Proved: removing the branch fails on THIS line.)
    expect(heal.why).toBe("type=adjustment (corrections establish nothing)");
    expect(recount.why).toBe("type=adjustment (corrections establish nothing)");
  });

  it("a customer return is neutral — the sale record is what proves the shop", () => {
    const c = classifyMovement({ type: "return", productId: "p1", size: "7", qty: 1, to: "hub2", reason: null, link: { saleId: "-Ozk" } });
    expect(c.cls).toBe(NEUTRAL);
    // Same reasoning as adjustments above: pin the DECIDING RULE, not just the
    // outcome, or the branch can be deleted with every assertion still green.
    expect(c.why).toBe("type=return (the sale record proves the shop)");
  });
});

describe("stocking classes", () => {
  it("a bare receive stocks the destination — 15,707 live records", () => {
    const c = classifyMovement({ type: "received", productId: "p1", size: "M", qty: 12, to: "central", reason: null, link: {} });
    expect(c).toMatchObject({ cls: STOCKING, loc: "central" });
  });

  it("an opening balance stocks the destination", () => {
    expect(classifyMovement({ type: "opening", productId: "p1", size: "_", qty: 4, to: "marathon-pe", reason: "opening balance (bulk perfume load)" }).cls).toBe(STOCKING);
  });

  it("a refillId transfer stocks the destination", () => {
    expect(classifyMovement({ type: "transfer_in", productId: "p1", size: "M", qty: 3, from: "in_transit", to: "hub2", reason: "stock_hold_release", link: { refillId: "r1", holdLineId: "h1" } }).cls).toBe(STOCKING);
  });

  it("an empty-link scripted relocation into a shop stocks it", () => {
    // The perfume moves and the location merge look like this: a human decided the
    // goods belong there, which is a deliberate stock transfer.
    expect(classifyMovement({ type: "transfer_out", productId: "p1", size: "_", qty: 48, from: "central", to: "marathon-pe", reason: "Perfume relocation to PE for selling", link: {} }).cls).toBe(STOCKING);
  });

  it("the odd `link: { reason: … }` shape still stocks — 105 live records", () => {
    const c = classifyMovement({ type: "transfer_out", productId: "p1", size: "8", qty: 2, from: "marathon-pe", to: "hub1", reason: null, link: { reason: "recount: relocated" } });
    expect(c).toMatchObject({ cls: STOCKING, loc: "hub1" });
  });

  it("a sale proves carriage at the SOURCE and needs no link", () => {
    const c = classifyMovement({ type: "sold", productId: NAVY, size: "M", qty: 1, from: "trophy", reason: null, link: { saleId: "s1" } });
    expect(c).toMatchObject({ cls: SALE, loc: "trophy" });
  });
});

describe("locations that are not shelves", () => {
  it("in_transit, base and studio can never carry anything", () => {
    // MUTATION: empty NON_STOCKING_LOCATIONS and in_transit starts "carrying"
    // 892 live pairs, none of which is a shop that sells anything.
    expect([...NON_STOCKING_LOCATIONS].sort()).toEqual(["base", "in_transit", "studio"]);
    for (const loc of ["in_transit", "base", "studio"]) {
      const c = classifyMovement({ type: "transfer_out", productId: "p1", size: "M", qty: 3, from: "central", to: loc, reason: "hub2_auto_refill", link: { refillId: "r1", holdDest: "hub2" } });
      expect(c.cls).toBe(NEUTRAL);
      expect(c.loc).toBe(null);
    }
  });

  it("a sale FROM a non-shelf is not credited either", () => {
    expect(classifyMovement({ type: "sold", productId: "p1", size: "M", qty: 1, from: "in_transit" }).loc).toBe(null);
  });
});

describe("the undo reasons are code constants, not prose", () => {
  it("names exactly the four declared in App.jsx and clothingSold.js", () => {
    // MUTATION: add a fifth, or drop one, and this fails. The set is small and
    // closed precisely so no free text is ever matched.
    expect([...UNDO_REASONS].sort()).toEqual([
      "clothing_cr_uncounted_undo", "clothing_cr_undo", "clothing_refill_undo", "source_refill_undo",
    ]);
  });

  it("an undo debits the location the units leave", () => {
    const c = classifyMovement({ type: "transfer_out", productId: "p1", size: "M", qty: 2, from: "trophy", to: "hub2", reason: "clothing_refill_undo", link: { refillId: "r1" } });
    expect(c).toMatchObject({ cls: UNSTOCK, loc: "trophy" });
  });

  it("a reason that merely CONTAINS an undo word is not an undo", () => {
    // Free text must never be pattern-matched. This one is a real live reason.
    const c = classifyMovement({ type: "transfer_out", productId: "p1", size: "8", qty: 1, from: "marathon-pine", to: "hub1", reason: "NR-00028 no-slip return restocked to Pine in error (PR #219) — moved to hub1", link: { saleId: "s1" } });
    expect(c.cls).toBe(STOCKING);
  });
});

describe("hostile and malformed records", () => {
  it("never throw and never establish anything", () => {
    for (const bad of [null, undefined, {}, "x", 7, [], { type: "sold" }, { type: "received" }, { productId: "p1" }, { type: "nonsense", productId: "p1", to: "hub2" }]) {
      const c = classifyMovement(bad);
      expect(c.loc == null || c.cls === NEUTRAL).toBe(true);
    }
  });

  it("a non-numeric qty folds as zero rather than NaN-poisoning a counter", () => {
    // MUTATION: drop the `Number(m.qty) || 0` coercion and one bad record turns a
    // whole pair's counters into NaN, which carriesByProvenance then reads as false
    // — a silent starvation that would be very hard to trace back.
    const prov = foldProvenance([
      { type: "received", productId: "p1", size: "M", qty: "junk", to: "hub2" },
      { type: "received", productId: "p1", size: "M", qty: 5, to: "hub2" },
    ]);
    expect(prov.get("hub2|p1").stockedUnits).toBe(5);
    expect(carriesByProvenance(prov.get("hub2|p1"))).toBe(true);
  });

  it("a record with no productId is skipped, not folded under undefined", () => {
    const prov = foldProvenance([{ type: "received", size: "M", qty: 5, to: "hub2" }]);
    expect(prov.size).toBe(0);
  });
});

describe("carriesByProvenance", () => {
  it("is the predicate, spelled out", () => {
    expect(carriesByProvenance({ sold: 1, stockedUnits: 0, unstockedUnits: 0 })).toBe(true);
    expect(carriesByProvenance({ sold: 0, stockedUnits: 1, unstockedUnits: 0 })).toBe(true);
    expect(carriesByProvenance({ sold: 0, stockedUnits: 4, unstockedUnits: 4 })).toBe(false);
    expect(carriesByProvenance({ sold: 0, stockedUnits: 0, unstockedUnits: 0 })).toBe(false);
    expect(carriesByProvenance({ sold: 0, stockedUnits: 0, unstockedUnits: 9 })).toBe(false);
    expect(carriesByProvenance(null)).toBe(false);
    expect(carriesByProvenance(undefined)).toBe(false);
  });

  it("a collection, however many units, never carries on its own", () => {
    const prov = foldProvenance([
      { type: "transfer_out", productId: "p1", size: "M", qty: 50, from: "hub2", to: "marathon-pe", link: { orderId: "1" } },
      { type: "transfer_out", productId: "p1", size: "M", qty: 50, from: "hub2", to: "marathon-pe", link: { orderId: "2" } },
    ]);
    expect(prov.get("marathon-pe|p1").collectedUnits).toBe(100);
    expect(carriesByProvenance(prov.get("marathon-pe|p1"))).toBe(false);
  });
});
