import { describe, it, expect } from "vitest";
import { patchProductTypeRule, PRODUCT_VALIDATE } from "./productTypeRule.mjs";

const live = () => ({ rules: { products: { ".write": "auth != null", $pid: { styleCode: { ".validate": "x" } } }, orders: { ".read": "y" } } });

describe("patchProductTypeRule", () => {
  it("adds ONE .validate at /products/$pid and changes nothing else", () => {
    const before = live();
    const out = patchProductTypeRule(before);
    expect(out.rules.products.$pid[".validate"]).toBe(PRODUCT_VALIDATE);
    const { ".validate": _v, ...rest } = out.rules.products.$pid;
    expect(rest).toEqual(before.rules.products.$pid);
    expect(out.rules.orders).toEqual(before.rules.orders);
    expect(out.rules.products[".write"]).toBe("auth != null");
    expect(before.rules.products.$pid[".validate"]).toBeUndefined();   // input untouched
  });
  it("is idempotent, and refuses a different live .validate there", () => {
    const once = patchProductTypeRule(live());
    expect(patchProductTypeRule(once)).toEqual(once);
    const l = live(); l.rules.products.$pid[".validate"] = "true";
    expect(() => patchProductTypeRule(l)).toThrow(/refusing to guess/);
    expect(() => patchProductTypeRule({ rules: {} })).toThrow(/no \/products\/\$pid/);
  });
});
