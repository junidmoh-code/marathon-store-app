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

describe("saveMissingPrice — costOnly (the New Arrivals card: the stock price only)", () => {
  it("writes ONLY the stock price; a missing retail is not demanded and never written", async () => {
    const apply = vi.fn(async () => ({ ok: true, count: 1 }));
    const r = await saveMissingPrice(P, "400", "", { apply, costOnly: true, label: "New Arrivals: x" });
    expect(r).toEqual({ ok: true, count: 1 });
    const line = apply.mock.calls[0][0].lines.p1;
    expect(line.to).toEqual({ stockPrice: 400 });
    expect(line.from).toEqual({ stockPrice: null });
  });
  it("a retail draft passed anyway is ignored under costOnly", async () => {
    const apply = vi.fn(async () => ({ ok: true, count: 1 }));
    await saveMissingPrice(P, "400", "650", { apply, costOnly: true });
    expect(apply.mock.calls[0][0].lines.p1.to).toEqual({ stockPrice: 400 });
  });
  it("still demands a valid stock price", async () => {
    const apply = vi.fn();
    expect((await saveMissingPrice(P, "", "", { apply, costOnly: true })).error).toMatch(/Stock Price/);
    expect((await saveMissingPrice(P, "0", "", { apply, costOnly: true })).error).toMatch(/Stock Price/);
    expect(apply).not.toHaveBeenCalled();
  });
  it("a stock price that already exists is never overwritten (nothing to write)", async () => {
    const apply = vi.fn();
    expect(await saveMissingPrice({ ...P, stockPrice: 300 }, "400", "", { apply, costOnly: true })).toEqual({ ok: true, count: 0 });
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("costOnly keeps the existing-retail check (CodeRabbit)", () => {
  it("a new stock price above an EXISTING retail price asks first", async () => {
    const apply = vi.fn(async () => ({ ok: true, count: 1 }));
    const r = await saveMissingPrice({ id: "p1", name: "x", stockPrice: null, retailPrice: 500 }, "650", "", { apply, costOnly: true });
    expect(r).toMatchObject({ ok: false, needsConfirm: true });
    expect(apply).not.toHaveBeenCalled();
    const ok = await saveMissingPrice({ id: "p1", name: "x", stockPrice: null, retailPrice: 500 }, "650", "", { apply, costOnly: true, confirmed: true });
    expect(ok.ok).toBe(true);
    expect(apply.mock.calls[0][0].lines.p1.to).toEqual({ stockPrice: 650 });
  });
});
