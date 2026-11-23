// BF Candidates card (Junid, 23 Nov 2026): the list, ONE sale price, the ≥-stock-price warning
// before anything is saved, Extend, Not for sale + the Removed undo.
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import TestRenderer, { act } from "react-test-renderer";
import BfCandidatesScreen, { locsLine, readPrice, photoError, forgetKept } from "./BfCandidatesScreen";
import { openSaleList } from "../../push/useForegroundPush";

const row = (over = {}) => ({ ownPhoto: "https://x/a.jpg", pid: "a", name: "Tee A", tab: "clothing", qty: 40, arrivedOn: "10 Jul 2026", received: 40, sold: 0, stockPrice: 200, retailPrice: 350, locs: { "marathon-pe": 30, central: 10 }, photo: "https://x/a.jpg", sale: null, posted: null, ...over });
const answer = (rows, over = {}) => ({ rows, counts: { clothing: rows.length, sneakers: 3, onSale: rows.filter((r) => r.sale).length, removed: 2 }, total: rows.length, more: false, cutoff: "july", cutoffs: [{ key: "may", label: "May" }, { key: "june", label: "June" }, { key: "july", label: "July" }, { key: "august", label: "August" }], saleEnds: null, defaultEndDay: "2026-11-30", defaultUntil: "Mon 30 Nov", today: "2026-11-23", locNames: { "marathon-pe": "Marathon PE", central: "Central" }, meta: { builtAt: 1 }, ...over });
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
  beforeEach(() => forgetKept());

  it("shows quantity, arrival date, units received and sold, both prices and the locations; tabs carry counts", async () => {
    const api = fakeApi([row(), row({ pid: "b", name: "Tee B", qty: 12, arrivedOn: "20 Jun 2026", received: 100, sold: 6 })]);
    const r = await mount(api);
    const t = all(r);
    for (const want of ["Tee A", "Clothing (2)", "Sneakers (3)", "On sale (0)", "40 on hand · arrived 10 Jul 2026 · received 40 · sold 0", "12 on hand · arrived 20 Jun 2026 · received 100 · sold 6", "Stock R200 · Retail R350", "Marathon PE 30 · Central 10"]) expect(t).toContain(want);
    expect(api.list).toHaveBeenCalledWith("clothing", "july", 0);
    expect(field(r, "In store since").props.value).toBe("july");
    expect(field(r, "In store since").findAll((n) => n.type === "option").map(text)).toEqual(["May", "June", "July", "August"]);
    await act(async () => { field(r, "In store since").props.onChange({ target: { value: "august" } }); });
    await flush();
    expect(api.list).toHaveBeenLastCalledWith("clothing", "august", 0);
  });

  it("every row has a price box; Put on sale is disabled until a price is typed, then sends ONE price", async () => {
    const api = fakeApi([row()]);
    const r = await mount(api);
    const put = () => buttons(r.root, "Put on sale")[0];
    expect(put().props.disabled).toBe(true);
    await type(field(r, "Sale price for Tee A"), "abc");
    expect(put().props.disabled).toBe(true);
    await type(field(r, "Sale price for Tee A"), "150");
    expect(put().props.disabled).toBe(false);
    await press(put());
    expect(api.sale).toHaveBeenCalledWith(["a"], 150, { confirmAbove: null });
    expect(all(r)).toContain("1 on sale at R150 until Mon 30 Nov");
    expect(field(r, "Sale price for Tee A").props.value).toBe("");
  });

  it("warns before saving when the sale price is at or above the stock price; saves only on the second tap", async () => {
    const sale = vi.fn(async (pids, price, { confirmAbove }) => (confirmAbove ? { ok: true, done: pids, refused: [], until: "Mon 30 Nov" } : { ok: false, needConfirm: [{ pid: "a", name: "Tee A", stockPrice: 200 }] }));
    const r = await mount(fakeApi([row()], { sale }));
    await type(field(r, "Sale price for Tee A"), "220");
    await press(buttons(r.root, "Put on sale")[0]);
    const t = all(r);
    expect(t).toContain("This price is not lower than the stock price");
    expect(t).toContain("Tee A (stock price R200)");
    expect(t).toContain("Nothing has been saved yet");
    expect(sale).toHaveBeenCalledTimes(1);
    await press(buttons(r.root, "Save at R220 anyway")[0]);
    expect(sale).toHaveBeenLastCalledWith(["a"], 220, { confirmAbove: ["a"] });
  });

  it("the sale's end date and Extend are at the top of the card; Extend there extends every sale", async () => {
    const none = await mount(fakeApi([row()]));
    expect(all(none)).toContain("Sale ends Mon 30 Nov 23:59");
    expect(buttons(none.root, "Extend")[0].props.disabled).toBe(true);
    const api = fakeApi([row({ sale: { price: 150, until: "Mon 30 Nov" } })]);
    api.list.mockImplementation(async () => answer([row({ sale: { price: 150, until: "Mon 30 Nov" } })], { saleEnds: { same: true, firstLabel: "Mon 30 Nov", lastLabel: "Mon 30 Nov" } }));
    const r = await mount(api);
    expect(all(r)).toContain("Sale ends Mon 30 Nov 23:59");
    await press(buttons(r.root, "Extend")[0]);
    await type(field(r, "New end date"), "2026-12-07");
    await press(buttons(dialog(r), "Extend")[0]);
    expect(api.extendAll).toHaveBeenCalledWith("2026-12-07");
  });

  it("the On sale tab lists what is on sale with its price, Edit price and Remove from sale", async () => {
    const onSale = row({ sale: { price: 150, until: "Mon 30 Nov" } });
    const api = fakeApi([onSale]);
    api.list.mockImplementation(async (tab) => answer(tab === "onsale" ? [onSale] : [row()], { counts: { clothing: 1, sneakers: 0, onSale: 1, removed: 0 } }));
    const r = await mount(api);
    await press(buttons(r.root, "On sale (1)")[0]);
    expect(api.list).toHaveBeenLastCalledWith("onsale", "july", 0);
    expect(all(r)).toContain("R150 · On sale until Mon 30 Nov");
    expect(all(r)).toContain("Queued to post");
    expect(buttons(r.root, "Edit price")[0].props.disabled).toBe(true);
    await type(field(r, "Sale price for Tee A"), "120");
    await press(buttons(r.root, "Edit price")[0]);
    expect(api.sale).toHaveBeenCalledWith(["a"], 120, { confirmAbove: null });
    await press(buttons(r.root, "Remove from sale")[0]);
    expect(api.end).toHaveBeenCalledWith(["a"]);
    await press(buttons(r.root, "Extend")[1]);
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

  it("multi-select: one price for every ticked item, then Put on sale (disabled until both)", async () => {
    const api = fakeApi([row(), row({ pid: "b", name: "Tee B" })]);
    const r = await mount(api);
    await press(buttons(r.root, "Select")[0]);
    const put = () => r.root.findAll((n) => n.type === "button" && /^Put \d* ?on sale$/.test(text(n)))[0];
    expect(put().props.disabled).toBe(true);
    await act(async () => { field(r, "Select Tee A").props.onChange(); field(r, "Select Tee B").props.onChange(); });
    expect(put().props.disabled).toBe(true);
    await type(field(r, "Sale price for every ticked item"), "99,50");
    expect(put().props.disabled).toBe(false);
    await press(put());
    expect(api.sale).toHaveBeenCalledWith(["a", "b"], 99.5, { confirmAbove: null });
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

  it("opens at once with the last list kept on this device, then shows the fresh one (Junid: the card took long to load)", async () => {
    const first = fakeApi([row()]);
    await mount(first);
    let land;
    const slow = fakeApi([], { list: vi.fn(() => new Promise((res) => { land = () => res(answer([row({ name: "Tee A, fresh" })])); })) });
    let r; await act(async () => { r = TestRenderer.create(<BfCandidatesScreen api={slow} onExit={() => {}} />); });
    expect(all(r)).toContain("Tee A");
    expect(all(r)).toContain("Showing the last list; checking for changes");
    await act(async () => { land(); }); await flush();
    expect(all(r)).toContain("Tee A, fresh");
    expect(all(r)).not.toContain("Showing the last list");
  });

  it("once the default end has passed, a new sale needs the end date picked at the top", async () => {
    const api = fakeApi([row()]);
    api.list.mockImplementation(async () => answer([row()], { endPassed: true }));
    const r = await mount(api);
    await type(field(r, "Sale price for Tee A"), "150");
    await press(buttons(r.root, "Put on sale")[0]);
    expect(api.sale).not.toHaveBeenCalled();
    expect(all(r)).toContain("Pick a new end date at the top");
    await type(field(r, "End date for new sales"), "2026-12-07");
    await press(buttons(r.root, "Put on sale")[0]);
    expect(api.sale).toHaveBeenCalledWith(["a"], 150, { confirmAbove: null, endDay: "2026-12-07" });
  });

  it("small pure parts", () => {
    expect(photoError(new Error("That product is not in the campaign."))).toMatch(/not on the Black Friday list yet/);
    expect(photoError(new Error("Paused — generation is switched off on the New Arrivals card."))).toMatch(/Paused/);
    expect(locsLine({ a: 2, b: 9, c: 0 }, { b: "Hub 2" })).toBe("Hub 2 9 · a 2");
    expect(readPrice("R 250")).toEqual({ price: 250 });
    expect(readPrice("").error).toBeTruthy();
    const win = { location: { hash: "" } };
    expect(openSaleList("/#bf-sale-list/hub2", win)).toBe(true);
    expect(win.location.hash).toBe("#bf-sale-list/hub2");
    expect(openSaleList("/?push=order", win)).toBe(false);
  });
});
