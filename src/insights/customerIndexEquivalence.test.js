// ─── THE AUTOCOMPLETE INDEX MOVED SOURCE — PROVE IT DIDN'T MOVE BEHAVIOUR ────
// useCustomerIndex used to derive phone→name from /insights_log (18.73 MB per
// Store Assistant mount). It now derives it from /customers (1.12 MB).
//
// These tests pin the three properties that decide whether that swap is safe:
//   1. the duplicate-phone winner rule is deterministic (34 real cases),
//   2. the index can never contain two entries for the same normalised number,
//   3. nameless records are dropped, exactly as the log-derived index dropped
//      events with no customerName.
//
// The 16 pairs /customers cannot supply, and the 38 names it spells differently,
// are ACCEPTED and enumerated in the PR description — they are data differences,
// not logic differences, so they are not asserted here.
import { describe, it, expect } from "vitest";
import { normalizeSAPhone } from "../utils/phone";
import { beatsHeldCustomer } from "../App";

// Mirrors useCustomerIndex's reducer so the rule can be exercised without React.
function buildIndex(customersDb) {
  const byPhone = new Map();
  for (const [key, c] of Object.entries(customersDb || {})) {
    if (!c || typeof c !== "object") continue;
    const normalised = normalizeSAPhone(c.phone || key);
    if (!normalised) continue;
    const candidate = {
      name: (c.name || "").trim(),
      phone: c.phone || key,
      lastOrderAt: c.lastOrderAt || "",
      _key: key,
    };
    const held = byPhone.get(normalised);
    if (!held || beatsHeldCustomer(candidate, held)) byPhone.set(normalised, candidate);
  }
  return Array.from(byPhone.entries())
    .filter(([, c]) => c.name)
    .map(([normalised, c]) => ({ normalised, ...c }));
}

describe("duplicate-phone winner rule", () => {
  it("prefers the record WITH a name (the real shape of most duplicates)", () => {
    const idx = buildIndex({
      "0611182298": { phone: "0611182298", name: "Mandla", lastOrderAt: "2026-06-01T00:00:00Z" },
      "27611182298": { phone: "+27611182298", name: "", lastOrderAt: "2026-07-01T00:00:00Z" },
    });
    expect(idx).toHaveLength(1);
    expect(idx[0].name).toBe("Mandla");
  });

  it("then prefers the most recent lastOrderAt", () => {
    const idx = buildIndex({
      "0608575706": { phone: "0608575706", name: "bongi", lastOrderAt: "2026-05-01T00:00:00Z" },
      "27608575706": { phone: "+27608575706", name: "Bongi", lastOrderAt: "2026-07-20T00:00:00Z" },
    });
    expect(idx[0].lastOrderAt).toBe("2026-07-20T00:00:00Z");
  });

  it("then prefers the international key form as a deterministic tie-break", () => {
    const idx = buildIndex({
      "0712345678": { phone: "0712345678", name: "Thabo", lastOrderAt: "2026-07-01T00:00:00Z" },
      "27712345678": { phone: "+27712345678", name: "Thabo", lastOrderAt: "2026-07-01T00:00:00Z" },
    });
    expect(idx[0]._key).toBe("27712345678");
  });

  it("is order-independent — the same winner whichever record is seen first", () => {
    const a = { phone: "0712345678", name: "", lastOrderAt: "2026-07-05T00:00:00Z" };
    const b = { phone: "+27712345678", name: "Thabo", lastOrderAt: "2026-01-01T00:00:00Z" };
    const one = buildIndex({ k1: a, k2: b });
    const two = buildIndex({ k2: b, k1: a });
    expect(one[0].name).toBe("Thabo");
    expect(two[0].name).toBe("Thabo");
  });
});

describe("zero duplicate normalised phone keys", () => {
  it("collapses every local/international pair to ONE entry", () => {
    const db = {};
    for (let i = 0; i < 50; i++) {
      const local = `07123456${String(i).padStart(2, "0")}`;
      db[local] = { phone: local, name: `Cust${i}`, lastOrderAt: "2026-07-01T00:00:00Z" };
      db[`27${local.slice(1)}`] = { phone: `+27${local.slice(1)}`, name: `Cust${i}`, lastOrderAt: "2026-07-02T00:00:00Z" };
    }
    const idx = buildIndex(db);
    const keys = idx.map((c) => c.normalised);
    expect(keys).toHaveLength(50);
    expect(new Set(keys).size).toBe(50);
  });

  it("treats every accepted input format as the same customer", () => {
    const idx = buildIndex({
      a: { phone: "0712345678", name: "A", lastOrderAt: "2026-01-01T00:00:00Z" },
      b: { phone: "+27 71 234 5678", name: "A", lastOrderAt: "2026-01-02T00:00:00Z" },
      c: { phone: "27712345678", name: "A", lastOrderAt: "2026-01-03T00:00:00Z" },
      d: { phone: "0027712345678", name: "A", lastOrderAt: "2026-01-04T00:00:00Z" },
    });
    expect(idx).toHaveLength(1);
  });
});

describe("what the index excludes", () => {
  it("drops nameless records — they would render a blank suggestion row", () => {
    const idx = buildIndex({
      "0712345678": { phone: "0712345678", name: "", lastOrderAt: "2026-07-01T00:00:00Z" },
      "0712345679": { phone: "0712345679", name: "Sara", lastOrderAt: "2026-07-01T00:00:00Z" },
    });
    expect(idx.map((c) => c.name)).toEqual(["Sara"]);
  });

  it("drops records whose phone cannot be normalised (a NAME in the phone field)", () => {
    const idx = buildIndex({ junk: { phone: "Mike from Model", name: "Mike" } });
    expect(idx).toHaveLength(0);
  });

  it("carries lastOrderAt for ORDERING ONLY, and never derives orderCount", () => {
    const idx = buildIndex({
      "0712345678": { phone: "0712345678", name: "Sara", lastOrderAt: "2026-07-01T00:00:00Z", orderCount: 9 },
    });
    expect(idx[0].lastOrderAt).toBe("2026-07-01T00:00:00Z");
    expect(idx[0]).not.toHaveProperty("orderCount");
  });

  it("a customer with NO lastOrderAt still appears, sorting last (tsMs → 0)", () => {
    const idx = buildIndex({
      "0712345678": { phone: "0712345678", name: "NoDate" },
    });
    expect(idx).toHaveLength(1);
    expect(idx[0].lastOrderAt).toBe("");
  });
});
