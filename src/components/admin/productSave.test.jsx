// The product edit page's one save path: a failure is a message the page shows,
// a success is echoed into the offline copy, and the page reads the product the
// server holds rather than a (possibly frozen) offline copy.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

vi.mock("firebase/database", () => ({ ref: (_d, p) => ({ p }), update: vi.fn(), onValue: vi.fn() }));
vi.mock("../../firebase", () => ({ database: {} }));
vi.mock("../../offline/pendingWrites", () => ({ notePendingUpdate: vi.fn() }));
const { saveProductPatch, productPatchPaths, useLiveProduct, changeProductType } = await import("./productSave.js");

describe("saveProductPatch", () => {
  it("a success is echoed into the offline copy, path by path", async () => {
    const echo = vi.fn();
    const write = vi.fn(async () => {});
    const res = await saveProductPatch({ id: "p1", patch: { productType: "sneaker", hubs: ["hub1", "hub2"] }, write, echo });
    expect(res).toEqual({ ok: true });
    expect(write).toHaveBeenCalledWith({ productType: "sneaker", hubs: ["hub1", "hub2"] });
    expect(echo).toHaveBeenCalledWith({ "products/p1/productType": "sneaker", "products/p1/hubs": ["hub1", "hub2"] });
  });

  it("a refusal comes back as a message a person can read — never thrown, never silent, never echoed", async () => {
    const echo = vi.fn();
    const res = await saveProductPatch({ id: "p1", patch: { sizes: ["12"] }, label: "size 12", echo,
      write: async () => { throw new Error("PERMISSION_DENIED: Permission denied"); } });
    expect(res.ok).toBe(false);
    expect(res.message).toBe("Could not save size 12: the database refused it (permission denied). Nothing was changed — try again.");
    expect(echo).not.toHaveBeenCalled();
  });

  it("an empty patch writes nothing", async () => {
    const write = vi.fn();
    expect(await saveProductPatch({ id: "p1", patch: {}, write })).toEqual({ ok: true });
    expect(write).not.toHaveBeenCalled();
  });

  it("productPatchPaths", () => {
    expect(productPatchPaths("p9", { a: 1, b: null })).toEqual({ "products/p9/a": 1, "products/p9/b": null });
  });
});

describe("useLiveProduct", () => {
  function harness(listProduct, subscribe) {
    let seen = null;
    function C({ p }) { seen = useLiveProduct(p, { subscribe }); return null; }
    let r;
    act(() => { r = TestRenderer.create(<C p={listProduct} />); });
    return { get: () => seen, r };
  }

  it("shows the list copy until the server answers, then the server's product", () => {
    let push = null;
    const subscribe = vi.fn((path, cb) => { push = cb; return () => {}; });
    const frozen = { id: "p1", name: "Nike Air Force 1 White", productType: "clothing" };
    const h = harness(frozen, subscribe);
    expect(subscribe).toHaveBeenCalledWith("products/p1", expect.any(Function), expect.any(Function));
    expect(h.get().productType).toBe("clothing");
    act(() => push({ id: "p1", name: "Nike Air Force 1 White", productType: "sneaker" }));
    expect(h.get().productType).toBe("sneaker");
  });

  it("a failed read falls back to the list copy (what the page did before)", () => {
    let fail = null;
    const subscribe = (path, cb, onErr) => { fail = onErr; cb({ id: "p1", productType: "sneaker" }); return () => {}; };
    const h = harness({ id: "p1", productType: "clothing" }, subscribe);
    expect(h.get().productType).toBe("sneaker");
    act(() => fail(new Error("denied")));
    expect(h.get().productType).toBe("clothing");
  });
});

describe("changeProductType", () => {
  it("sends the product, the type and the device; echoes the server's patch", async () => {
    const echo = vi.fn();
    const call = vi.fn(async () => ({ data: { ok: true, productType: "sneaker", patch: { productType: "sneaker", hubs: ["hub1", "hub2"] } } }));
    const res = await changeProductType({ id: "p1", productType: "sneaker", deviceId: "dev-12345678", call, echo });
    expect(call).toHaveBeenCalledWith({ productId: "p1", productType: "sneaker", deviceId: "dev-12345678" });
    expect(res.ok).toBe(true);
    expect(echo).toHaveBeenCalledWith({ "products/p1/productType": "sneaker", "products/p1/hubs": ["hub1", "hub2"] });
  });
  it("the server's refusal is shown in its own words", async () => {
    const call = async () => { throw Object.assign(new Error("This product has stock or sales, so only Junid or MC can change its Type. Ask one of them."), { code: "functions/permission-denied" }); };
    const res = await changeProductType({ id: "p1", productType: "clothing", call, echo: vi.fn() });
    expect(res).toEqual({ ok: false, message: "Could not change the Type: This product has stock or sales, so only Junid or MC can change its Type. Ask one of them." });
  });
});
