// BF Candidates card (Junid, 23 Nov 2026): the list, ONE sale price, the ≥-stock-price warning
// before anything is saved, Extend, Not for sale + the Removed undo.
import React from "react";
import { describe, it, expect, vi } from "vitest";
import TestRenderer, { act } from "react-test-renderer";
import BfCandidatesScreen, { locsLine, readPrice } from "./BfCandidatesScreen";
import { openSaleList } from "../../push/useForegroundPush";

const row = (over = {}) => ({ ownPhoto: "https://x/a.jpg", pid: "a", name: "Tee A", tab: "clothing", qty: 40, since: "never sold", stockPrice: 200, retailPrice: 350, locs: { "marathon-pe": 30, central: 10 }, photo: "https://x/a.jpg", sale: null, posted: null, ...over });
const answer = (rows, over = {}) => ({ rows, counts: { clothing: rows.length, sneakers: 3, onSale: rows.filter((r) => r.sale).length, removed: 2 }, total: rows.length, more: false, windowDays: 30, windows: [14, 30, 60, 90], defaultEndDay: "2026-11-30", defaultUntil: "Mon 30 Nov", today: "2026-11-23", locNames: { "marathon-pe": "Marathon PE", central: "Central" }, meta: { builtAt: 1 }, ...over });
function fakeApi(rows, over = {}) {
  return {
    thumb: (u) => u,
    list: vi.fn(async () => answer(rows)),
    sale: vi.fn(async (pids) => ({ ok: true, done: pids, refused: [], until: "Mon 30 Nov" })),
    extend: vi.fn(async (pids) => ({ ok: true, done: pids, until: "Mon 7 Dec" })),
    extendAll: vi.fn(async () => ({ ok: true, done: ["a"], until: "Mon 7 Dec" })),
    end: vi.fn(async (pids) => ({ ok: true, done: pids })),
    remove: vi.fn(async (pids) => ({ ok: true, done: pids })),
    restore: vi.fn(async (pids) => ({ ok: true, done: pids })),
    removed: vi.fn(async () => ({ ok: true, removed: [{ pid: "z", name: "Old Tee" }] })),
    ...over,
  };
}


const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const text = (node) => (typeof node === "string" ? node : (node.children || []).map(text).join(""));
async function mount(api) { let r; await act(async () => { r = TestRenderer.create(<BfCandidatesScreen api={api} onExit={() => {}} />); }); await flush(); return r; }
const all = (r) => text(r.root);
const buttons = (scope, label) => scope.findAll((n) => n.type === "button" && text(n) === label);
const dialog = (r) => r.root.find((n) => n.props && n.props.role === "dialog");
const field = (r, label) => r.root.find((n) => n.props && n.props["aria-label"] === label);
const press = async (node) => { await act(async () => { node.props.onClick({ stopPropagation() {} }); }); await flush(); };
const type = async (node, value) => { await act(async () => { node.props.onChange({ target: { value } }); }); };

describe("BF Candidates card", () => {
  it("shows quantity, days since the last sale, both prices and the locations; tabs carry counts", async () => {
    const r = await mount(fakeApi([row(), row({ pid: "b", name: "Tee B", qty: 12, since: "42 days" })]));
    const t = all(r);
    for (const want of ["Tee A", "Clothing (2)", "Sneakers (3)", "40 on hand · never sold", "12 on hand · last sale 42 days ago", "Stock R200 · Retail R350", "Marathon PE 30 · Central 10"]) expect(t).toContain(want);
  });

  it("Put on sale sends ONE price with the default end, Mon 30 Nov", async () => {
    const api = fakeApi([row()]);
    const r = await mount(api);
    await press(buttons(r.root, "Put on sale")[0]);
    await type(field(r, "Sale price"), "150");
    expect(field(r, "Sale end date").props.value).toBe("2026-11-30");
    await press(buttons(dialog(r), "Put on sale")[0]);
    expect(api.sale).toHaveBeenCalledWith(["a"], 150, "2026-11-30", { confirmAbove: null });
    expect(all(r)).toContain("1 on sale at R150 until Mon 30 Nov");
  });

  it("warns before saving when the sale price is at or above the stock price; saves only on the second tap", async () => {
    const sale = vi.fn(async (pids, price, endDay, { confirmAbove }) => (confirmAbove ? { ok: true, done: pids, refused: [], until: "Mon 30 Nov" } : { ok: false, needConfirm: [{ pid: "a", name: "Tee A", stockPrice: 200 }] }));
    const r = await mount(fakeApi([row()], { sale }));
    await press(buttons(r.root, "Put on sale")[0]);
    await type(field(r, "Sale price"), "220");
    await press(buttons(dialog(r), "Put on sale")[0]);
    const t = all(r);
    expect(t).toContain("This price is not lower than the stock price");
    expect(t).toContain("Tee A (stock price R200)");
    expect(t).toContain("Nothing has been saved yet");
    expect(sale).toHaveBeenCalledTimes(1);
    await press(buttons(r.root, "Save at R220 anyway")[0]);
    expect(sale).toHaveBeenLastCalledWith(["a"], 220, "2026-11-30", { confirmAbove: ["a"] });
  });

  it("a row on sale says until when, and offers Extend and End sale", async () => {
    const api = fakeApi([row({ sale: { price: 150, until: "Mon 30 Nov" } })]);
    const r = await mount(api);
    expect(all(r)).toContain("R150 · On sale until Mon 30 Nov");
    expect(all(r)).toContain("Queued to post");
    expect(buttons(r.root, "End sale").length).toBe(1);
    await press(buttons(r.root, "Extend")[0]);
    await type(field(r, "New end date"), "2026-12-07");
    await press(buttons(dialog(r), "Extend")[0]);
    expect(api.extend).toHaveBeenCalledWith(["a"], "2026-12-07");
  });

  it("Not for sale removes the row; Removed (n) lists it with Undo", async () => {
    const api = fakeApi([row(), row({ pid: "b", name: "Tee B" })]);
    api.list.mockImplementation(async () => answer(api.remove.mock.calls.length ? [row({ pid: "b", name: "Tee B" })] : [row(), row({ pid: "b", name: "Tee B" })]));
    const r = await mount(api);
    await press(buttons(r.root, "Not for sale")[0]);
    expect(api.remove).toHaveBeenCalledWith(["a"]);
    expect(all(r)).not.toContain("Tee A");
    await press(buttons(r.root, "Removed (2)")[0]);
    await press(buttons(r.root, "Undo")[0]);
    expect(api.restore).toHaveBeenCalledWith(["z"]);
  });

  it("multi-select: one price for every ticked product", async () => {
    const api = fakeApi([row(), row({ pid: "b", name: "Tee B" })]);
    const r = await mount(api);
    await press(buttons(r.root, "Select")[0]);
    await act(async () => { field(r, "Select Tee A").props.onChange(); field(r, "Select Tee B").props.onChange(); });
    await press(buttons(r.root, "Put on sale")[0]);
    await type(field(r, "Sale price"), "99,50");
    await press(buttons(dialog(r), "Put on sale")[0]);
    expect(api.sale).toHaveBeenCalledWith(["a", "b"], 99.5, "2026-11-30", { confirmAbove: null });
  });

  it("photos: Generate makes one with the shared generator and that photo is the one that posts; Use current photo takes it back", async () => {
    const api = fakeApi([row()], {
      generate: vi.fn(async () => ({ ok: true, genId: "g1795432000000", url: "https://x/ai.jpg" })),
      photoUpload: vi.fn(async () => ({ ok: true, id: "g1795432000001", url: "https://x/mine.jpg" })),
      photo: vi.fn(async (pid, use, genId) => ({ ok: true, pid, use, photo: use === "generated" ? (genId === "g1795432000000" ? "https://x/ai.jpg" : "https://x/mine.jpg") : "https://x/a.jpg" })),
    });
    const r = await mount(api);
    const img = () => r.root.find((n) => n.type === "img").props.src;
    expect(buttons(r.root, "Use current photo").length).toBe(0);
    await press(buttons(r.root, "Generate")[0]);
    expect(api.generate).toHaveBeenCalledWith("a", expect.anything());
    expect(api.photo).toHaveBeenCalledWith("a", "generated", "g1795432000000");
    expect(img()).toBe("https://x/ai.jpg");
    expect(buttons(r.root, "Regenerate").length).toBe(1);
    await press(buttons(r.root, "Use current photo")[0]);
    expect(api.photo).toHaveBeenLastCalledWith("a", "current");
    expect(img()).toBe("https://x/a.jpg");
    expect(buttons(r.root, "Replace photo").length).toBe(1);
  });

  it("small pure parts", () => {
    expect(locsLine({ a: 2, b: 9, c: 0 }, { b: "Hub 2" })).toBe("Hub 2 9 · a 2");
    expect(readPrice("R 250")).toEqual({ price: 250 });
    expect(readPrice("").error).toBeTruthy();
    const win = { location: { hash: "" } };
    expect(openSaleList("/#bf-sale-list/hub2", win)).toBe(true);
    expect(win.location.hash).toBe("#bf-sale-list/hub2");
    expect(openSaleList("/?push=order", win)).toBe(false);
  });
});
