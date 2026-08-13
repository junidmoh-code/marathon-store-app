// ─── THE AUTOCOMPLETE INDEX MOVED SOURCE — PROVE IT DIDN'T MOVE BEHAVIOUR ────
// useCustomerIndex used to derive phone→name from /insights_log (18.73 MB per
// Store Assistant mount). It now derives it from /customers (1.12 MB).
//
// These exercise THE PRODUCTION REDUCER (src/insights/customerIndex.js) — the
// same functions useCustomerIndex calls. The first version of this file kept a
// local re-implementation, which drifted from the hook and let a real bug in the
// phone fallback pass 718 tests (CodeRabbit, PR #300). Never re-implement here.
//
// The pairs /customers cannot supply, and the names it spells differently, are
// ACCEPTED and enumerated in the PR description — data differences, not logic.
import { describe, it, expect } from "vitest";
import { buildCustomerIndex, indexCustomersByPhone, beatsHeldCustomer, byMostRecentOrder } from "./customerIndex";

describe("duplicate-phone winner rule", () => {
  it("prefers the record WITH a name (the real shape of most duplicates)", () => {
    const idx = buildCustomerIndex({
      "0611182298": { phone: "0611182298", name: "Mandla", lastOrderAt: "2026-06-01T00:00:00Z" },
      "27611182298": { phone: "+27611182298", name: "", lastOrderAt: "2026-07-01T00:00:00Z" },
    });
    expect(idx).toHaveLength(1);
    expect(idx[0].name).toBe("Mandla");
  });

  it("then prefers the most recent lastOrderAt", () => {
    const idx = buildCustomerIndex({
      "0608575706": { phone: "0608575706", name: "bongi", lastOrderAt: "2026-05-01T00:00:00Z" },
      "27608575706": { phone: "+27608575706", name: "Bongi", lastOrderAt: "2026-07-20T00:00:00Z" },
    });
    expect(idx[0].lastOrderAt).toBe("2026-07-20T00:00:00Z");
  });

  it("then prefers the international key form", () => {
    const idx = indexCustomersByPhone({
      "0712345678": { phone: "0712345678", name: "Thabo", lastOrderAt: "2026-07-01T00:00:00Z" },
      "27712345678": { phone: "+27712345678", name: "Thabo", lastOrderAt: "2026-07-01T00:00:00Z" },
    });
    expect([...idx.values()][0]._key).toBe("27712345678");
  });

  // A FULLY tied pair — same name, same lastOrderAt, same key form — used to fall
  // through to `return false`, making the winner depend on Object.entries()
  // order. The final lexical _key comparison makes it deterministic.
  const TIED_A = { phone: "+27712345678", name: "Thabo", lastOrderAt: "2026-07-01T00:00:00Z" };
  const TIED_B = { phone: "+27712345678", name: "Thabo", lastOrderAt: "2026-07-01T00:00:00Z" };

  it("picks the SAME winner for a fully tied pair in both input orders", () => {
    const forwards = indexCustomersByPhone({ "27712345678a": TIED_A, "27712345678b": TIED_B });
    const backwards = indexCustomersByPhone({ "27712345678b": TIED_B, "27712345678a": TIED_A });
    const wf = [...forwards.values()][0], wb = [...backwards.values()][0];
    expect(forwards.size).toBe(1);
    expect(backwards.size).toBe(1);
    expect(wf._key).toBe(wb._key);          // deterministic, not insertion-ordered
    expect(wf._key).toBe("27712345678a");   // lexically smaller key wins
  });

  it("beatsHeldCustomer is antisymmetric on a full tie (a total order)", () => {
    const a = { name: "T", lastOrderAt: "2026-07-01T00:00:00Z", _key: "27700000001" };
    const b = { name: "T", lastOrderAt: "2026-07-01T00:00:00Z", _key: "27700000002" };
    expect(beatsHeldCustomer(a, b)).toBe(true);
    expect(beatsHeldCustomer(b, a)).toBe(false);
    expect(beatsHeldCustomer(a, a)).toBe(false); // never beats itself
  });

  it("is order-independent when one record is richer", () => {
    const a = { phone: "0712345678", name: "", lastOrderAt: "2026-07-05T00:00:00Z" };
    const b = { phone: "+27712345678", name: "Thabo", lastOrderAt: "2026-01-01T00:00:00Z" };
    expect(buildCustomerIndex({ k1: a, k2: b })[0].name).toBe("Thabo");
    expect(buildCustomerIndex({ k2: b, k1: a })[0].name).toBe("Thabo");
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
    const map = indexCustomersByPhone(db);
    expect(map.size).toBe(50);
    expect(buildCustomerIndex(db)).toHaveLength(50);
  });

  it("treats every accepted input format as the same customer", () => {
    const idx = buildCustomerIndex({
      a: { phone: "0712345678", name: "A", lastOrderAt: "2026-01-01T00:00:00Z" },
      b: { phone: "+27 71 234 5678", name: "A", lastOrderAt: "2026-01-02T00:00:00Z" },
      c: { phone: "27712345678", name: "A", lastOrderAt: "2026-01-03T00:00:00Z" },
      d: { phone: "0027712345678", name: "A", lastOrderAt: "2026-01-04T00:00:00Z" },
    });
    expect(idx).toHaveLength(1);
  });
});

// The bug the old local re-implementation could not catch: a record whose phone
// FIELD is junk but whose KEY holds the real number was rescued for identity but
// still rendered — and searched — under the junk value.
describe("junk phone field, real number in the key", () => {
  const DB = { "0821234567": { phone: "John Doe", name: "John", lastOrderAt: "2026-07-01T00:00:00Z" } };

  it("indexes the record under the KEY's normalised number", () => {
    expect([...indexCustomersByPhone(DB).keys()]).toEqual(["+27821234567"]);
  });

  it("EXPOSES the key as the phone — never the junk value", () => {
    // Otherwise matchCustomers (mode "phone") matches saSignificantDigits("John
    // Doe") — nothing — and the dropdown prints a name in the phone column.
    const [rec] = buildCustomerIndex(DB);
    expect(rec.phone).toBe("0821234567");
    expect(rec.phone).not.toBe("John Doe");
  });
});

// normalizeSAPhone turns partial input into a non-empty string ("071" → "+2771"),
// so "the field normalised to something" is NOT evidence of a usable number. The
// key fallback must be reachable whenever the field is incomplete, or a customer
// whose only complete number lives in the record key is lost.
describe("incomplete phone field, complete number in the key", () => {
  const PARTIAL = { "0821234567": { phone: "071", name: "Sipho", lastOrderAt: "2026-07-01T00:00:00Z" } };

  it("indexes under the KEY when the phone field is only partial digits", () => {
    expect([...indexCustomersByPhone(PARTIAL).keys()]).toEqual(["+27821234567"]);
    expect(buildCustomerIndex(PARTIAL)[0].phone).toBe("0821234567");
  });

  it("rescues a malformed international field when the key is a real SA number", () => {
    // The one live case: phone "+656996104" (9 digits, not SA) vs a complete key.
    const db = { "27656996104": { phone: "+656996104", name: "S", lastOrderAt: "2026-06-01T00:00:00Z" } };
    expect([...indexCustomersByPhone(db).keys()]).toEqual(["+27656996104"]);
  });

  it("still prefers the FIELD when it is a complete SA number", () => {
    const db = { "0000000000": { phone: "0712345678", name: "Thabo", lastOrderAt: "2026-07-01T00:00:00Z" } };
    expect([...indexCustomersByPhone(db).keys()]).toEqual(["+27712345678"]);
    expect(buildCustomerIndex(db)[0].phone).toBe("0712345678");
  });

  it("keeps a partial number rather than dropping the customer when NEITHER is complete", () => {
    const db = { "071": { phone: "072", name: "Partial" } };
    expect(buildCustomerIndex(db)).toHaveLength(1);
    expect(buildCustomerIndex(db)[0].phone).toBe("072"); // field first
  });
});

describe("what the index excludes", () => {
  it("drops nameless records — they would render a blank suggestion row", () => {
    const idx = buildCustomerIndex({
      "0712345678": { phone: "0712345678", name: "", lastOrderAt: "2026-07-01T00:00:00Z" },
      "0712345679": { phone: "0712345679", name: "Sara", lastOrderAt: "2026-07-01T00:00:00Z" },
    });
    expect(idx.map(c => c.name)).toEqual(["Sara"]);
  });

  it("drops records where NEITHER the phone nor the key can be normalised", () => {
    expect(buildCustomerIndex({ junk: { phone: "Mike from Model", name: "Mike" } })).toHaveLength(0);
  });

  it("drops merged-away tombstones — the survivor wins the slot, even when the tombstone would beat it on the winner rule", () => {
    const idx = indexCustomersByPhone({
      // Tombstone is named AND newer — would beat the survivor if not excluded.
      "27712345678": { phone: "+27712345678", name: "Old Twin", lastOrderAt: "2026-08-01T00:00:00Z", mergedInto: "0712345678" },
      "0712345678": { phone: "0712345678", name: "Musa", lastOrderAt: "2026-07-01T00:00:00Z" },
    });
    expect(idx.get("+27712345678").name).toBe("Musa");
    expect(idx.get("+27712345678")._key).toBe("0712345678");
  });

  it("carries lastOrderAt for ordering, and COPIES orderCount for display", () => {
    const [rec] = buildCustomerIndex({
      "0712345678": { phone: "0712345678", name: "Sara", lastOrderAt: "2026-07-01T00:00:00Z", orderCount: 9 },
    });
    expect(rec.lastOrderAt).toBe("2026-07-01T00:00:00Z");
    expect(rec.orderCount).toBe(9);   // verbatim from /customers, never derived
  });

  it("defaults orderCount to 0 so the label never prints 'undefined past orders'", () => {
    const [rec] = buildCustomerIndex({ "0712345678": { phone: "0712345678", name: "NoCount" } });
    expect(rec.orderCount).toBe(0);
    expect(Number.isFinite(rec.orderCount)).toBe(true);
  });

  it("orderCount never influences which duplicate wins", () => {
    // Same name, same lastOrderAt, same key form — only orderCount differs, and
    // it must not break the tie (display-only field).
    const a = { name: "T", lastOrderAt: "2026-07-01T00:00:00Z", orderCount: 99, _key: "27700000002" };
    const b = { name: "T", lastOrderAt: "2026-07-01T00:00:00Z", orderCount: 0, _key: "27700000001" };
    expect(beatsHeldCustomer(a, b)).toBe(false); // b's key is lexically smaller — count is irrelevant
  });

  it("a customer with NO lastOrderAt is still included", () => {
    const idx = buildCustomerIndex({ "0712345678": { phone: "0712345678", name: "NoDate" } });
    expect(idx).toHaveLength(1);
    expect(idx[0].lastOrderAt).toBe("");
  });
});

// The ORDER staff see, asserted in the layer that owns it: matchCustomers sorts
// with byMostRecentOrder and slices 5, so this comparator decides which five
// suggestions appear. Asserting it through buildCustomerIndex (which does not
// sort) could never catch an ordering regression.
describe("suggestion ordering — byMostRecentOrder", () => {
  const dated = (name, lastOrderAt) => ({ name, phone: "0712345678", lastOrderAt });

  it("puts the most recent order first", () => {
    const list = [dated("Older", "2026-01-01T00:00:00Z"), dated("Newer", "2026-07-01T00:00:00Z")];
    expect([...list].sort(byMostRecentOrder).map(c => c.name)).toEqual(["Newer", "Older"]);
  });

  it("sorts a customer with NO lastOrderAt LAST, whichever way round the input is", () => {
    const withDate = dated("Dated", "2026-07-01T00:00:00Z");
    const without = dated("NoDate", "");
    expect([without, withDate].sort(byMostRecentOrder).map(c => c.name)).toEqual(["Dated", "NoDate"]);
    expect([withDate, without].sort(byMostRecentOrder).map(c => c.name)).toEqual(["Dated", "NoDate"]);
  });

  it("treats missing and unparseable dates the same as absent (never ahead of a real one)", () => {
    const real = dated("Real", "2026-07-01T00:00:00Z");
    for (const bad of [undefined, null, "", "not-a-date"]) {
      expect([dated("Bad", bad), real].sort(byMostRecentOrder).map(c => c.name)).toEqual(["Real", "Bad"]);
    }
  });

  it("keeps the top-5 slice deterministic across the full pipeline", () => {
    const idx = buildCustomerIndex({
      a: { phone: "0712345671", name: "A", lastOrderAt: "2026-01-01T00:00:00Z" },
      b: { phone: "0712345672", name: "B", lastOrderAt: "2026-07-01T00:00:00Z" },
      c: { phone: "0712345673", name: "C" },                       // no date → last
      d: { phone: "0712345674", name: "D", lastOrderAt: "2026-05-01T00:00:00Z" },
    });
    expect(idx.sort(byMostRecentOrder).map(c => c.name)).toEqual(["B", "D", "A", "C"]);
  });
});
