import { describe, it, expect, vi } from "vitest";
import {
  isOnConcrete, isConcreteProduct, buildConcreteUpdate, buildBrandConfirmUpdate, setOnConcrete, setConcreteProduct,
  needsBrandCheck, createdAtFromId, CONCRETE_SHIP_AT, CONCRETE_PUBLISH_PATH, CONCRETE_INDEX_PATH,
} from "./concreteListing.js";

const NOW = CONCRETE_SHIP_AT + 60_000;

describe("isOnConcrete", () => {
  it("is true only for literal true", () => {
    expect(isOnConcrete({ listOnConcrete: true })).toBe(true);
    for (const v of [false, "true", 1, null, undefined]) expect(isOnConcrete({ listOnConcrete: v })).toBe(false);
    expect(isOnConcrete(null)).toBe(false);
  });
});

describe("isConcreteProduct", () => {
  it("concreteProduct wins; legacy listOnConcrete counts only when concreteProduct is absent", () => {
    expect(isConcreteProduct({ concreteProduct: true })).toBe(true);
    expect(isConcreteProduct({ concreteProduct: false, listOnConcrete: true })).toBe(false);
    expect(isConcreteProduct({ listOnConcrete: true })).toBe(true);
    expect(isConcreteProduct({ concreteProduct: "true" })).toBe(false);
    expect(isConcreteProduct({})).toBe(false);
    expect(isConcreteProduct(undefined)).toBe(false);
    expect(isOnConcrete).toBe(isConcreteProduct);
  });
});

describe("buildConcreteUpdate", () => {
  it("marks every product with who and when, mirrors the legacy field and the index, nothing else", () => {
    const u = buildConcreteUpdate({ productIds: ["p1", "p2", "p1"], on: true, uid: "u1", nowMs: NOW });
    expect(u).toEqual({
      "products/p1/concreteProduct": true, "products/p1/concreteProductSetBy": "u1", "products/p1/concreteProductSetAt": NOW,
      "products/p1/listOnConcrete": true, "products/p1/listOnConcreteSetBy": "u1", "products/p1/listOnConcreteSetAt": NOW,
      [`${CONCRETE_INDEX_PATH}/p1`]: true,
      "products/p2/concreteProduct": true, "products/p2/concreteProductSetBy": "u1", "products/p2/concreteProductSetAt": NOW,
      "products/p2/listOnConcrete": true, "products/p2/listOnConcreteSetBy": "u1", "products/p2/listOnConcreteSetAt": NOW,
      [`${CONCRETE_INDEX_PATH}/p2`]: true,
    });
  });
  it("unmarking deletes the index entry (null) and writes an explicit false", () => {
    const u = buildConcreteUpdate({ productIds: ["p1"], on: false, uid: "u1", nowMs: NOW });
    expect(u["products/p1/concreteProduct"]).toBe(false);
    expect(u[`${CONCRETE_INDEX_PATH}/p1`]).toBeNull();
  });
  it("verify:true stamps the brand check in the same write", () => {
    const u = buildConcreteUpdate({ productIds: ["p1"], on: true, uid: "u1", nowMs: NOW, verify: true });
    expect(u["products/p1/brandVerifiedAt"]).toBe(NOW);
    expect(u["products/p1/brandVerifiedBy"]).toBe("u1");
  });
  it("unmarking a LIVE product turns its Concrete listing off and never touches Marathon", () => {
    const u = buildConcreteUpdate({ productIds: ["p1", "p2"], on: false, uid: "u1", nowMs: NOW, liveOnConcrete: new Set(["p1"]) });
    expect(u[`${CONCRETE_PUBLISH_PATH}/p1/desiredState`]).toBe("off");
    expect(u[`${CONCRETE_PUBLISH_PATH}/p2/desiredState`]).toBeUndefined();
    expect(Object.keys(u).some((k) => k.startsWith("shopify_publish/"))).toBe(false);
  });
  it("marking never writes a publish row", () => {
    const u = buildConcreteUpdate({ productIds: ["p1"], on: true, uid: "u1", nowMs: NOW, liveOnConcrete: ["p1"] });
    expect(Object.keys(u).some((k) => k.startsWith(CONCRETE_PUBLISH_PATH))).toBe(false);
  });
  it("refuses a bad call loudly", () => {
    expect(() => buildConcreteUpdate({ productIds: ["p1"], on: "yes", uid: "u", nowMs: NOW })).toThrow();
    expect(() => buildConcreteUpdate({ productIds: ["p1"], on: true, uid: "", nowMs: NOW })).toThrow();
    expect(() => buildConcreteUpdate({ productIds: ["p1"], on: true, uid: "u", nowMs: 0 })).toThrow();
    expect(() => buildConcreteUpdate({ productIds: ["a/b"], on: true, uid: "u", nowMs: NOW })).toThrow();
  });
});

describe("buildBrandConfirmUpdate", () => {
  it("confirm without a flip writes only the brand stamp", () => {
    expect(buildBrandConfirmUpdate({ productId: "p1", on: true, wasOn: true, uid: "u", nowMs: NOW })).toEqual({
      "products/p1/brandVerifiedAt": NOW, "products/p1/brandVerifiedBy": "u",
    });
  });
  it("flip-then-confirm is one write carrying both", () => {
    const u = buildBrandConfirmUpdate({ productId: "p1", on: true, wasOn: false, uid: "u", nowMs: NOW });
    expect(u["products/p1/concreteProduct"]).toBe(true);
    expect(u["products/p1/brandVerifiedAt"]).toBe(NOW);
  });
});

describe("needsBrandCheck", () => {
  const newId = `p${CONCRETE_SHIP_AT + 1000}`;
  const oldId = `p${CONCRETE_SHIP_AT - 1000}`;
  it("reads the creation time from the id", () => {
    expect(createdAtFromId(newId)).toBe(CONCRETE_SHIP_AT + 1000);
    expect(createdAtFromId("weird")).toBe(0);
  });
  it("new products wait until verified; old untouched ones never appear", () => {
    expect(needsBrandCheck({}, newId)).toBe(true);
    expect(needsBrandCheck({ brandVerifiedAt: NOW }, newId)).toBe(false);
    expect(needsBrandCheck({}, oldId)).toBe(false);
  });
  it("a flip after the last verification re-opens it", () => {
    expect(needsBrandCheck({ listOnConcreteSetAt: NOW, brandVerifiedAt: NOW - 1 }, oldId)).toBe(true);
    expect(needsBrandCheck({ listOnConcreteSetAt: NOW, brandVerifiedAt: NOW }, oldId)).toBe(false);
    expect(needsBrandCheck({ concreteProductSetAt: NOW, brandVerifiedAt: NOW - 1 }, oldId)).toBe(true);
  });
});

describe("setOnConcrete", () => {
  it("applies one root update and counts products", async () => {
    const apply = vi.fn(async () => {});
    const r = await setOnConcrete(apply, { productIds: ["p1", "p2"], on: true, uid: "u", nowMs: NOW });
    expect(r).toEqual({ ok: true, count: 2 });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(setOnConcrete).toBe(setConcreteProduct);
  });
  it("turns a permission error into words", async () => {
    const r = await setOnConcrete(async () => { throw new Error("PERMISSION_DENIED"); }, { productIds: ["p1"], on: true, uid: "u", nowMs: NOW });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/rules/);
  });
});
