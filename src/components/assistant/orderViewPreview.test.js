import { describe, it, expect, vi } from "vitest";
import { isWallPreviewOn, canTogglePreview, setWallPreview, ORDER_VIEW_KEY } from "./orderViewPreview";

const mem = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m };
};

describe("isWallPreviewOn", () => {
  it("is off by default", () => {
    expect(isWallPreviewOn({ search: "", storage: mem() })).toBe(false);
  });
  it("?view=wall turns it on", () => {
    expect(isWallPreviewOn({ search: "?view=wall", storage: mem() })).toBe(true);
    expect(isWallPreviewOn({ search: "?a=1&view=wall", storage: mem() })).toBe(true);
    expect(isWallPreviewOn({ search: "?view=grid", storage: mem() })).toBe(false);
  });
  it("localStorage mc.orderView === \"wall\" turns it on", () => {
    expect(ORDER_VIEW_KEY).toBe("mc.orderView");
    expect(isWallPreviewOn({ search: "", storage: mem({ "mc.orderView": "wall" }) })).toBe(true);
    expect(isWallPreviewOn({ search: "", storage: mem({ "mc.orderView": "classic" }) })).toBe(false);
  });
  it("blocked storage means classic, never a throw", () => {
    const bad = { getItem() { throw new Error("SecurityError"); } };
    expect(isWallPreviewOn({ search: "", storage: bad })).toBe(false);
    expect(isWallPreviewOn({ search: "", storage: null })).toBe(false);
  });
});

describe("canTogglePreview", () => {
  it("Junid's owner email and MC only", () => {
    expect(canTogglePreview("gunidmoh@gmail.com")).toBe(true);
    expect(canTogglePreview("GunidMoh@gmail.com ")).toBe(true);
    expect(canTogglePreview("mc@marathon.internal")).toBe(true);
    for (const e of ["", null, undefined, "junidmoh@gmail.com", "yasmin@marathon.internal", "mc2@marathon.internal"])
      expect(canTogglePreview(e)).toBe(false);
  });
});

describe("setWallPreview", () => {
  it("on: writes the key and reloads", () => {
    const storage = mem(); const location = { search: "", pathname: "/", hash: "", reload: vi.fn(), replace: vi.fn() };
    setWallPreview(true, { storage, location });
    expect(storage.getItem("mc.orderView")).toBe("wall");
    expect(location.reload).toHaveBeenCalledOnce();
  });
  it("off: removes the key and drops ?view=wall so the reload lands on the classic view", () => {
    const storage = mem({ "mc.orderView": "wall" });
    const location = { search: "?view=wall&x=1", pathname: "/", hash: "#assistant", reload: vi.fn(), replace: vi.fn() };
    setWallPreview(false, { storage, location });
    expect(storage.getItem("mc.orderView")).toBeNull();
    expect(location.replace).toHaveBeenCalledWith("/?x=1#assistant");
    expect(location.reload).not.toHaveBeenCalled();
  });
});
