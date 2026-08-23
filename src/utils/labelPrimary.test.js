// ─── THE PRIMARY-CODE RULE — deterministic, reportable, never a question ─────
// Mutation-proved (scripts/mutation-proof-label-reader.mjs): flipping the rank
// table, dropping the stable tie-break, or re-introducing the "options"
// question in chooseFromLabelRead each fails at least one assertion below.

import { describe, it, expect } from "vitest";
import { choosePrimaryCode, choosePrimaryCodeIndex, primaryCodeRank } from "./labelPrimary.js";
import { chooseFromLabelRead } from "../components/stock/hubCleanupCore.js";

describe("choosePrimaryCode — the head of a multi-code label", () => {
  it("Lacoste: the article code heads the production code and the serial", () => {
    // Server order on a real Lacoste label read: article, production, serial.
    expect(choosePrimaryCode(["45SMA0018", "352890625", "TTJJ21FB00001"])).toBe("45SMA0018");
    // …and it does not depend on reading order: production first still yields the article.
    expect(choosePrimaryCode(["352890625", "45SMA0018"])).toBe("45SMA0018");
  });

  it("Timberland: the LONGER, more specific token heads a loose-shape tie — A6CWNEN3 over A8425", () => {
    // adidas-block and label-serial share a rank; a wrong head is permanent
    // (it becomes styleCodeNormalised), so the more specific token wins.
    expect(choosePrimaryCode(["A6CWNEN3", "A8425"])).toBe("A6CWNEN3");
    expect(choosePrimaryCode(["A8425", "A6CWNEN3"])).toBe("A6CWNEN3");
  });

  it("full ties (same rank, same length) keep the server's (reading) order — same label, same answer", () => {
    // Two Nike-shaped codes: the first read wins, deterministically.
    expect(choosePrimaryCode(["CT8527016", "DD1391100"])).toBe("CT8527016");
    expect(choosePrimaryCode(["DD1391100", "CT8527016"])).toBe("DD1391100");
    // Two numeric codes (Diesel Big D): first read wins.
    expect(choosePrimaryCode(["190935505", "74075035"])).toBe("190935505");
  });

  it("the rank table is what the report says it is", () => {
    expect(primaryCodeRank("45SMA0018")).toBe(0);     // lacoste-ref
    expect(primaryCodeRank("CT8527016")).toBe(0);     // nike-alpha-6-3
    expect(primaryCodeRank("M990GL6")).toBe(0);       // new-balance
    expect(primaryCodeRank("A8425")).toBe(1);         // adidas-block
    expect(primaryCodeRank("A6CWNEN3")).toBe(1);      // label-serial
    expect(primaryCodeRank("352890625")).toBe(2);     // numeric-6-3
    expect(primaryCodeRank("19093550")).toBe(2);      // puma-6-2
    expect(primaryCodeRank("ZZZZZZZZZZZZZZZZZZZ")).toBe(3); // no known format
  });

  it("empty / junk input is handled", () => {
    expect(choosePrimaryCode([])).toBe(null);
    expect(choosePrimaryCode(null)).toBe(null);
    expect(choosePrimaryCodeIndex([null, "A8425"])).toBe(1);
  });
});

describe("chooseFromLabelRead never returns a question", () => {
  const reads = [
    { candidates: ["45SMA0018", "352890625"], displayCandidates: ["45SMA0018", "352890-625"] },
    { candidates: ["A6CWNEN3", "A8425"], displayCandidates: ["A6CWNEN3", "A8425"] },
    { candidates: ["CT8527016", "DD1391100"], displayCandidates: ["CT8527-016", "DD1391-100"], autoPick: "NOT-A-CANDIDATE" },
    { candidates: ["190935505", "74075035"], displayCandidates: ["190935-505", "740750-35"], preferred: "ZZ" },
    { candidates: ["A", "B", "C", "D", "E", "F", "G", "H"], displayCandidates: ["A", "B", "C", "D", "E", "F", "G", "H"] },
  ];
  it("every multi-candidate read without a server pick is CHOSEN by the rule, with the full set riding along", () => {
    for (const read of reads) {
      const out = chooseFromLabelRead(read);
      expect(out.kind).toBe("chosen");
      expect(out.auto).toBe(true);
      expect(out.autoSource).toBe("rule");
      expect(out.allCandidates).toEqual(read.candidates);
      expect(read.candidates.map((c, i) => read.displayCandidates[i])).toContain(out.code);
    }
    // The shape "options" does not exist any more — nothing downstream can
    // be asked to tap before the flow proceeds.
    expect(reads.map((r) => chooseFromLabelRead(r).kind)).not.toContain("options");
  });
  it("a server pick still beats the rule — a layout rule first, then tier 2's read", () => {
    const base = { candidates: ["A6CWNEN3", "A8425"], displayCandidates: ["A6CWNEN3", "A8425"] };
    expect(chooseFromLabelRead({ ...base, autoPick: "A6CWNEN3" })).toMatchObject({ code: "A6CWNEN3", autoSource: "layout" });
    expect(chooseFromLabelRead({ ...base, preferred: "A6CWNEN3" })).toMatchObject({ code: "A6CWNEN3", autoSource: "read" });
    expect(chooseFromLabelRead({ ...base, autoPick: "A6CWNEN3", preferred: "A8425" })).toMatchObject({ code: "A6CWNEN3", autoSource: "layout" });
  });
});
