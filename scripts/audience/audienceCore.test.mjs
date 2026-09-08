// ─── MERGING CUSTOMER BOOKS — the rules, on fabricated people ────────────────
// Every test here uses invented records. Nothing in this suite reads a real
// customer, which is the point: the merge rules have to be checkable without
// anyone running them over 9,611 real phone numbers to see what they do.
import { describe, it, expect } from "vitest";
import {
  toMs, splitName, normEmail, normName, makeRow, mergeRows, hasKey,
  segmentOf, estimateMatchRate, toCsv, META_COLUMNS, SOURCE_RANK, RECENT_MONTHS,
} from "./audienceCore.mjs";

const NOW = Date.UTC(2026, 7, 27);
const months = (n) => NOW - n * 30.44 * 86400000;

describe("toMs — the bug that filed every customer as undated", () => {
  it("parses the ISO strings /customers actually stores", () => {
    // lastOrderAt is "2026-06-05T12:48:48.421Z", NOT epoch ms. Number() on that
    // is NaN, `NaN || null` is null, and the first build put all 9,611 people
    // in one bucket with no error anywhere.
    expect(toMs("2026-06-05T12:48:48.421Z")).toBe(Date.parse("2026-06-05T12:48:48.421Z"));
  });
  it("still takes epoch numbers and numeric strings", () => {
    expect(toMs(1786097073101)).toBe(1786097073101);
    expect(toMs("1786097073101")).toBe(1786097073101);
  });
  it("refuses what is not a time, rather than inventing one", () => {
    for (const v of [null, undefined, "", "nonsense", NaN, Infinity]) expect(toMs(v)).toBe(null);
  });
  it("keeps a real zero", () => { expect(toMs(0)).toBe(0); });
});

describe("names and emails are normalised the way Meta normalises them", () => {
  it("splits one name field into first and last", () => {
    expect(splitName("Junid Mohammed")).toEqual({ fn: "junid", ln: "mohammed" });
    expect(splitName("Cher")).toEqual({ fn: "cher", ln: "" });
    expect(splitName("  Ana  Maria  Silva ")).toEqual({ fn: "ana", ln: "maria silva" });
    expect(splitName("")).toEqual({ fn: "", ln: "" });
  });
  it("keeps accents and apostrophes, drops the rest", () => {
    expect(normName("O'Brien")).toBe("o'brien");
    expect(normName("José")).toBe("josé");
    // The punctuation goes, the letters inside it stay — "bob vip", not "bob".
    // That matches how Meta strips punctuation before hashing, and losing the
    // word would be inventing a different name than the one on the record.
    expect(normName("Bob (VIP)")).toBe("bob vip");
  });
  it("refuses a non-email rather than uploading rubbish as a match key", () => {
    expect(normEmail(" Someone@Example.COM ")).toBe("someone@example.com");
    for (const v of ["notanemail", "a@b", "", null, "@x.com"]) expect(normEmail(v)).toBe("");
  });
});

describe("who gets in", () => {
  it("a row with neither phone nor email is not a person Meta can match", () => {
    expect(hasKey(makeRow({ source: "pos", fn: "bob" }))).toBe(false);
    expect(mergeRows([makeRow({ source: "pos", fn: "bob" })])).toEqual([]);
  });
  it("a row with only a phone, or only an email, is kept", () => {
    expect(mergeRows([makeRow({ source: "pos", phone: "+27811111111" })]).length).toBe(1);
    expect(mergeRows([makeRow({ source: "oldpos", email: "a@b.com" })]).length).toBe(1);
  });
});

describe("the same person in more than one book", () => {
  it("joins on phone and keeps the UNION of what each source knew", () => {
    const merged = mergeRows([
      makeRow({ source: "oldpos", phone: "+27811111111", fn: "Junid" }),
      makeRow({ source: "pos", phone: "+27811111111", ln: "Mohammed", orderCount: 3, lastOrderAt: months(2) }),
    ]);
    expect(merged.length).toBe(1);
    expect(merged[0].fn).toBe("junid");
    expect(merged[0].ln).toBe("mohammed");
    expect(merged[0].orderCount).toBe(3);
    expect(merged[0].sources).toEqual(["oldpos", "pos"]);
  });

  it("joins on email when there is no usable phone", () => {
    const merged = mergeRows([
      makeRow({ source: "oldpos", email: "a@b.com", fn: "Ana" }),
      makeRow({ source: "shopify", email: "a@b.com", ln: "Silva" }),
    ]);
    expect(merged.length).toBe(1);
    expect(merged[0].ln).toBe("silva");
  });

  it("a row carrying BOTH links the two identities for everything after it", () => {
    // phone-only, then phone+email, then email-only → one person, not three.
    const merged = mergeRows([
      makeRow({ source: "pos", phone: "+27811111111" }),
      makeRow({ source: "shopify", phone: "+27811111111", email: "a@b.com" }),
      makeRow({ source: "oldpos", email: "a@b.com", fn: "Ana" }),
    ]);
    expect(merged.length).toBe(1);
    expect(merged[0].fn).toBe("ana");
  });

  it("a better source WINS a contested field, whatever order it arrived in", () => {
    // Arrival order would make the answer depend on which file was read first.
    const forward = mergeRows([
      makeRow({ source: "oldpos", phone: "+27811111111", fn: "Bobby" }),
      makeRow({ source: "shopify", phone: "+27811111111", fn: "Robert" }),
    ]);
    const backward = mergeRows([
      makeRow({ source: "shopify", phone: "+27811111111", fn: "Robert" }),
      makeRow({ source: "oldpos", phone: "+27811111111", fn: "Bobby" }),
    ]);
    expect(forward[0].fn).toBe("robert");
    expect(backward[0].fn).toBe("robert");
  });

  it("shopify outranks pos outranks oldpos", () => {
    expect(SOURCE_RANK.shopify).toBeGreaterThan(SOURCE_RANK.pos);
    expect(SOURCE_RANK.pos).toBeGreaterThan(SOURCE_RANK.oldpos);
  });

  it("keeps the EARLIEST first order and the LATEST last order", () => {
    const m = mergeRows([
      makeRow({ source: "pos", phone: "+27811111111", firstOrderAt: months(30), lastOrderAt: months(20) }),
      makeRow({ source: "oldpos", phone: "+27811111111", firstOrderAt: months(40), lastOrderAt: months(3) }),
    ]);
    expect(m[0].firstOrderAt).toBe(months(40));
    expect(m[0].lastOrderAt).toBe(months(3));
  });
});

describe("segments — the seed decides the Lookalike", () => {
  const withDate = (src, ago) => ({ ...makeRow({ source: src, phone: "+27811111111", lastOrderAt: months(ago) }), sources: [src] });

  it("an online buyer is its own segment, recent or not", () => {
    expect(segmentOf(withDate("shopify", 2), NOW)).toBe("online-recent");
    expect(segmentOf(withDate("shopify", 40), NOW)).toBe("online-old");
  });
  it("in-store splits on the same window", () => {
    expect(segmentOf(withDate("pos", 2), NOW)).toBe("instore-recent");
    expect(segmentOf(withDate("pos", 40), NOW)).toBe("instore-old");
  });
  it("no order date is UNDATED, never 'old'", () => {
    // Calling an undated record old would quietly bury everyone the POS never
    // stamped in with the 2019 walk-ins — the exact group being separated out.
    const r = { ...makeRow({ source: "pos", phone: "+27811111111" }), sources: ["pos"] };
    expect(segmentOf(r, NOW)).toBe("instore-undated");
  });
  it("the window is a stated number of months, not a magic constant", () => {
    expect(RECENT_MONTHS).toBeGreaterThanOrEqual(6);
    expect(RECENT_MONTHS).toBeLessThanOrEqual(36);
  });
});

describe("the file that gets uploaded", () => {
  it("carries ONLY Meta's match columns — no segment, no internal id", () => {
    const csv = toCsv([{ ...makeRow({ source: "pos", phone: "+27811111111", fn: "A" }), sources: ["pos"], orderCount: 9 }]);
    expect(csv.split("\n")[0]).toBe(META_COLUMNS.join(","));
    expect(csv).not.toMatch(/orderCount|sources|pos/);
  });
  it("escapes a comma in a name instead of shifting every column", () => {
    const csv = toCsv([makeRow({ source: "pos", phone: "+27811111111", ln: "Smith Jones" })]);
    expect(csv.split("\n")[1].split(",").length).toBe(META_COLUMNS.length);
  });
});

describe("the match-rate estimate is a range, and an honest one", () => {
  it("email-rich beats phone-only", () => {
    const emails = Array.from({ length: 100 }, (_, i) => makeRow({ source: "shopify", email: `a${i}@b.com` }));
    const phones = Array.from({ length: 100 }, (_, i) => makeRow({ source: "pos", phone: `+2781111${String(i).padStart(4, "0")}` }));
    expect(estimateMatchRate(emails).hiPct).toBeGreaterThan(estimateMatchRate(phones).hiPct);
  });
  it("never claims a single number", () => {
    const e = estimateMatchRate([makeRow({ source: "pos", phone: "+27811111111" })]);
    expect(e.hi).toBeGreaterThan(e.lo);
  });
});
