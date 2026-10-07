// ─── TRUSTED CELLS — the helper, and its three copies kept as one ────────────
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import * as esm from "./stockTrust";

const require = createRequire(import.meta.url);
const cjs = require("../../../functions/lib/stock-trust.cjs");

const BEGIN = "// ── BEGIN SHARED BODY";
const END = "// ── END SHARED BODY";
const body = (file) => { const t = readFileSync(join(process.cwd(), file), "utf8"); return t.slice(t.indexOf(BEGIN), t.indexOf("\n", t.indexOf(END)) + 1); };

// The POS repo's src/stock/stockTrust.parity.test.js pins the same constant.
export const TRUST_BODY_SHA256 = "e73cd75a5133345b32063faa8153d6d547b454d61d49fb7db7ac1dffc0b92022";

describe("three copies, one body", () => {
  it("the functions copy is byte for byte this one, and the hash is the POS copy's", () => {
    const a = body("src/components/stock/stockTrust.js");
    expect(a.length).toBeGreaterThan(800);
    expect(body("functions/lib/stock-trust.cjs")).toBe(a);
    expect(createHash("sha256").update(a).digest("hex")).toBe(TRUST_BODY_SHA256);
    expect(Object.keys(cjs).sort()).toEqual(Object.keys(esm).sort());
  });
});

describe("what trusts a cell", () => {
  it("only an explicit trusted:true", () => {
    expect(esm.cellTrusted({ qty: 3, trusted: true })).toBe(true);
    for (const c of [null, undefined, {}, { qty: 4 }, { trusted: "true" }, { trusted: 1 }, { state: "live" }]) expect(esm.cellTrusted(c)).toBe(false);
  });
  it("the stamp: three sources only", () => {
    expect(esm.trustStamp("solve", "T")).toEqual({ trusted: true, trustedVia: "solve", trustedAt: "T" });
    for (const v of ["refill", "count"]) expect(esm.trustStamp(v, "T").trustedVia).toBe(v);
    expect(() => esm.trustStamp("adjust", "T")).toThrow();
  });
  it("an inbound refill or order leg trusts; a hand transfer, an adjustment, a receipt typed in, a return or a sale never does", () => {
    expect(esm.arrivalTrust({ type: "transfer_out", from: "hub3", to: "marathon-pine", link: { refillId: "r1" } })).toBe("refill");
    expect(esm.arrivalTrust({ type: "transfer_out", from: "hub3", to: "marathon-pine", link: { orderId: "R001" } })).toBe("refill");
    expect(esm.arrivalTrust({ type: "received", to: "hub3", link: { refillId: "r1" } })).toBe("refill");
    expect(esm.arrivalTrust({ type: "transfer_in", from: "in_transit", to: "hub3", link: { refillId: "r1" } })).toBe("refill");
    expect(esm.arrivalTrust({ type: "transfer_out", from: "central", to: "hub3", link: { transferId: "t1" } })).toBeNull();
    expect(esm.arrivalTrust({ type: "adjustment", to: "marathon-pine", link: { refillId: "r1" } })).toBeNull();
    expect(esm.arrivalTrust({ type: "return", to: "marathon-pine", link: { orderId: "R1" } })).toBeNull();
    expect(esm.arrivalTrust({ type: "sold", from: "marathon-pine", link: { saleId: "s" } })).toBeNull();
    expect(esm.arrivalTrust({ type: "received", to: "hub3" })).toBeNull();
    expect(esm.arrivalTrust(null)).toBeNull();
  });
  it("a product is trusted at a location when any of its sizes is", () => {
    expect(esm.productTrustedAt({ M: { qty: 0, trusted: true }, L: { qty: 2 } })).toBe(true);
    expect(esm.productTrustedAt({ M: { qty: 5 } })).toBe(false);
    expect(esm.productTrustedAt(null)).toBe(false);
    expect(esm.trustedSizeKeys({ M: { trusted: true }, L: {}, S: { trusted: true } })).toEqual(["M", "S"]);
  });
});
