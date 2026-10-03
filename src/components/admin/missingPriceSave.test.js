import { describe, it, expect, vi } from "vitest";
vi.mock("./priceStore", () => ({ applyPriceBatch: vi.fn() }));
import { saveMissingPrice } from "./missingPriceSave";

const P = { id: "p1", name: "Wanchao wear 6925", retailPrice: null, stockPrice: null };
describe("saveMissingPrice — the one Missing-prices save", () => {
  it("writes only the missing fields, through applyPriceBatch, single_edit", async () => {
    const apply = vi.fn(async () => ({ ok: true, count: 2 }));
    const r = await saveMissingPrice(P, "400", "650", { apply, label: "New Arrivals: x" });
    expect(r).toEqual({ ok: true, count: 2 });
    const arg = apply.mock.calls[0][0];
    expect(arg.action).toBe("single_edit");
    expect(arg.label).toBe("New Arrivals: x");
    expect(arg.lines.p1.to).toEqual({ stockPrice: 400, retailPrice: 650 });
    expect(arg.lines.p1.from).toEqual({ stockPrice: null, retailPrice: null });
  });
  it("never overwrites a price that exists", async () => {
    const apply = vi.fn(async () => ({ ok: true, count: 1 }));
    await saveMissingPrice({ ...P, stockPrice: 300 }, "", "650", { apply });
    expect(apply.mock.calls[0][0].lines.p1.to).toEqual({ retailPrice: 650 });
  });
  it("validates like the Missing prices editor; retail below cost needs a yes", async () => {
    const apply = vi.fn(async () => ({ ok: true, count: 2 }));
    expect((await saveMissingPrice(P, "400", "", { apply })).error).toMatch(/Retail Price/);
    const low = await saveMissingPrice(P, "700", "650", { apply });
    expect(low).toMatchObject({ ok: false, needsConfirm: true });
    expect(apply).not.toHaveBeenCalled();
    expect((await saveMissingPrice(P, "700", "650", { apply, confirmed: true })).ok).toBe(true);
  });
  it("an existing cost still triggers the 'retail below cost' question (CodeRabbit)", async () => {
    const apply = vi.fn(async () => ({ ok: true, count: 1 }));
    expect(await saveMissingPrice({ ...P, stockPrice: 700 }, "", "650", { apply })).toMatchObject({ ok: false, needsConfirm: true });
    expect(apply).not.toHaveBeenCalled();
  });
  it("a refused batch (on special) is reported, not thrown", async () => {
    const apply = vi.fn(async () => ({ ok: false, message: "on special" }));
    expect(await saveMissingPrice(P, "400", "650", { apply })).toEqual({ ok: false, error: "on special" });
  });
});
