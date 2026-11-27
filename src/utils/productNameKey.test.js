import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { nameKey, sameName } from "./productNameKey";

const server = createRequire(import.meta.url)("../../functions/lib/product-rename.cjs");

describe("the page and the server agree on 'same name'", () => {
  const cases = ["Gucci slide brown ", "gucci  SLIDE brown", " Nike Air Max 96 DT blue Whitet", "", "   ", "A\tB", "Diesel Jeans-4"];
  it("nameKey is identical on both sides", () => {
    for (const c of cases) expect(nameKey(c)).toBe(server.nameKey(c));
  });
  it("sameName is identical on both sides", () => {
    for (const a of cases) for (const b of cases) expect(sameName(a, b)).toBe(server.sameName(a, b));
  });
});
