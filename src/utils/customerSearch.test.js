// The find-by-any-format search contract: a customer stored in ANY phone
// dialect is found by a query typed in ANY dialect.

import { describe, it, expect } from "vitest";
import { filterCustomerList } from "./customerSearch";

const LIST = [
  { name: "Musa", phone: "+27619467420" },
  { name: "Beverley", phone: "0653112671" },
  { name: "Sfundo", phone: "27633984478" },
  { name: "Shaista", phone: "840110748" },       // bare-9 stored
  { name: "Nicolas", phone: "+62128907" },       // foreign / truncated — must stay findable as typed
];

describe("filterCustomerList", () => {
  it("finds a +27-stored customer by every query dialect", () => {
    for (const q of ["0619467420", "27619467420", "+27619467420", "619467420", "061 946 7420"]) {
      expect(filterCustomerList(LIST, q).map(c => c.name)).toEqual(["Musa"]);
    }
  });
  it("finds a 0-stored customer by 27/+27 queries and vice versa", () => {
    expect(filterCustomerList(LIST, "+27653112671")[0].name).toBe("Beverley");
    expect(filterCustomerList(LIST, "0633984478")[0].name).toBe("Sfundo");
  });
  it("finds a bare-9-stored customer by the local 0-form query", () => {
    expect(filterCustomerList(LIST, "0840110748")[0].name).toBe("Shaista");
  });
  it("matches partial digit fragments anywhere in the number", () => {
    expect(filterCustomerList(LIST, "946742").map(c => c.name)).toEqual(["Musa"]);
  });
  it("name search is unchanged (case-insensitive substring)", () => {
    expect(filterCustomerList(LIST, "bever")[0].name).toBe("Beverley");
  });
  it("a non-SA number is still findable by its own digits, not folded away", () => {
    expect(filterCustomerList(LIST, "62128907")[0].name).toBe("Nicolas");
  });
  it("empty query returns the full list", () => {
    expect(filterCustomerList(LIST, "")).toHaveLength(LIST.length);
  });
});
