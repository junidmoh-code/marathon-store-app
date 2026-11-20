// Black Friday card — FAST OPEN (Junid, 21 Nov 2026): the card opens on the server's precomputed list
// (counts + the first page of each tab), loads the rest in pages, reopens from the phone's copy at once,
// re-reads no rows when nothing changed, and never loses a tick.
import { describe, it, expect, vi, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import BlackFridayScreen, { addPages, fromHead, isComplete, moveCounts, countKeys } from "./BlackFridayScreen";
import { saveListIdb, loadListIdb } from "./cardState";

const row = (pid, qty, over = {}) => ({ pid, name: `Item ${pid}`, price: 300, qty, sizes: "M-XL", kind: "clothing", big: qty >= 30, na: false, photo: `https://x/${pid}.jpg`, shown: `https://x/${pid}.jpg`,
  use: "current", genId: null, generatedUrl: null, generations: 0, generating: false, styleApproved: true, tab: "review", changedSinceApproval: false, posted: null, ...over });
const PAGE = 25;
const review = Array.from({ length: 60 }, (_, i) => row(`p${String(i).padStart(2, "0")}`, 100 - i)); // 60 rows, 30+ first
const approved = [row("ap", 15, { tab: "approved" })];
function makeServer(at = 1000) {
  const st = { at, review: [...review], approved: [...approved] };
  const counts = () => ({ newArrivals: 0, review: st.review.length, approved: st.approved.length, big: st.review.filter((r) => r.big).length, mid: st.review.filter((r) => !r.big).length, apprNoPrice: 0, apprNa: 0, apprNormal: st.approved.length });
  const page = (list, i) => ({ at: st.at, rows: list.slice(i * PAGE, (i + 1) * PAGE) });
  return {
    st,
    head: vi.fn(async () => ({ at: st.at, pageSize: PAGE, counts: counts(), first: { newArrivals: [], review: st.review.slice(0, PAGE), approved: st.approved.slice(0, PAGE) },
      totals: { review: st.review.length, approved: st.approved.length, spentZar: 0 }, rejected: [], styles: {}, schedule: null, plan: [], postingPaused: false, meta: {}, selection: st.selection || null, brain: null, dirty: false })),
    pages: vi.fn(async (tab, from, n) => {
      const list = st[tab] || [];
      const pages = [];
      for (let i = from; i < from + n && i * PAGE < list.length; i++) pages.push(page(list, i));
      return { tab, from, at: pages.length ? st.at : null, pages };
    }),
  };
}
function fakeApi(server, over = {}) {
  return {
    head: server.head, pages: server.pages,
    list: vi.fn(async () => ({ section: "main", newArrivals: [], review: server.st.review, approved: server.st.approved, totals: { review: server.st.review.length, approved: server.st.approved.length }, rejected: [], styles: {}, schedule: null, plan: [], postingPaused: false, meta: {} })),
    approve: vi.fn(async (pid) => ({ ok: true, pid, row: row(pid, 45, { tab: "approved" }), undo: { [pid]: { prev: null, expectAt: 1 } } })),
    approveBig: vi.fn(async (sigs) => ({ ok: true, pids: Object.keys(sigs), undo: {} })),
    selSave: vi.fn(async () => ({ ok: true })),
    ...over,
  };
}
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const text = (node) => (typeof node === "string" ? node : (node.children || []).map(text).join(""));
const byId = (r, id) => r.root.find((n) => n.props && n.props["data-testid"] === id && typeof n.type === "string");
const has = (r, id) => r.root.findAll((n) => n.props && n.props["data-testid"] === id && typeof n.type === "string").length > 0;
async function mount(api) { let r; await act(async () => { r = TestRenderer.create(<BlackFridayScreen api={api} onExit={() => {}} />); }); await flush(); return r; }
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; };

beforeEach(async () => {
  globalThis.indexedDB = new (await import("fake-indexeddb")).IDBFactory();
  delete globalThis.localStorage; delete globalThis.sessionStorage;
});

describe("fast open: pure helpers", () => {
  it("fromHead + addPages: pages append in order, a late or duplicate answer is ignored, a rebuilt list asks for a refresh", () => {
    const d = fromHead({ at: 7, pageSize: 2, counts: { review: 5, approved: 0, newArrivals: 0 }, first: { review: [{ pid: "a" }, { pid: "b" }] } });
    expect(d.indexAt).toBe(7);
    expect(isComplete(d, "review")).toBe(false);
    expect(isComplete(d, "approved")).toBe(true);
    const d2 = addPages(d, { tab: "review", from: 1, at: 7, n: 2, pages: [{ at: 7, rows: [{ pid: "c" }, { pid: "d" }] }, { at: 7, rows: [{ pid: "e" }] }] });
    expect(d2.review.map((r) => r.pid)).toEqual(["a", "b", "c", "d", "e"]);
    expect(isComplete(d2, "review")).toBe(true);
    expect(addPages(d2, { tab: "review", from: 1, at: 7, n: 2, pages: [{ at: 7, rows: [{ pid: "c" }] }] })).toBe(d2); // late duplicate
    expect(addPages(d, { tab: "review", from: 1, at: 8, n: 1, pages: [{ at: 8, rows: [{ pid: "x" }] }] })).toBe(null); // rebuilt
    // Fewer pages than asked: that tab ended (a patched count can never make it load forever).
    const d3 = addPages({ ...d, counts: { review: 9 } }, { tab: "review", from: 1, at: 7, n: 4, pages: [{ at: 7, rows: [{ pid: "c" }] }] });
    expect(isComplete(d3, "review")).toBe(true);
  });
  it("a tap moves the counts with the row (tab and block)", () => {
    expect(countKeys(row("a", 45))).toEqual(["review", "big"]);
    expect(countKeys(row("a", 45, { tab: "approved", na: true }))).toEqual(["approved", "apprNa"]);
    expect(moveCounts({ review: 3, big: 2, approved: 0, apprNormal: 0 }, row("a", 45), row("a", 45, { tab: "approved" }))).toEqual({ review: 2, big: 1, approved: 1, apprNormal: 1 });
    expect(moveCounts({ review: 3, big: 2 }, row("a", 45), null)).toEqual({ review: 2, big: 1 });
  });
});

describe("fast open: the card", () => {
  it("opens on the head: the counts and the first 25 rows, without computing the whole list; the rest comes in pages", async () => {
    const server = makeServer();
    const api = fakeApi(server);
    const r = await mount(api);
    expect(server.head).toHaveBeenCalledTimes(1);
    expect(api.list).not.toHaveBeenCalled();
    expect(text(byId(r, "tab-review"))).toBe("To review (60)");
    expect(text(byId(r, "tab-approved"))).toBe("Approved (1)");
    expect(text(byId(r, "block-big"))).toContain("30+ on hand (60)"); // 25 rows drawn, the server's count shown
    expect(has(r, "more")).toBe(true);
    expect(text(byId(r, "more"))).toContain("25 of 60");
  });

  it("Approve all 30+ first loads every row of To review, then approves every 30+ product", async () => {
    const server = makeServer();
    const api = fakeApi(server);
    const r = await mount(api);
    expect(text(byId(r, "approve-big"))).toBe(`Approve all 30+ (${review.filter((x) => x.big).length})`);
    await act(async () => { await byId(r, "approve-big").props.onClick(); });
    await flush();
    expect(server.pages).toHaveBeenCalled();
    const sigs = api.approveBig.mock.calls[0][0];
    expect(Object.keys(sigs).sort()).toEqual(review.filter((x) => x.big).map((x) => x.pid).sort());
  });

  it("reopening the app draws the phone's copy at once (IndexedDB), before the server answers", async () => {
    const server = makeServer();
    const cachedModel = { ...fromHead(await server.head()), review: review.slice(0, 50), pages: { newArrivals: 1, review: 2, approved: 1 } };
    await saveListIdb(cachedModel);
    expect((await loadListIdb()).review.length).toBe(50);
    const api = fakeApi(server, { head: vi.fn(() => new Promise(() => {})) }); // the server never answers
    const r = await mount(api);
    await flush();
    expect(text(byId(r, "tab-review"))).toBe("To review (60)");
    expect(has(r, `row-${review[0].pid}`)).toBe(true);
  });

  it("a refresh when the server's list has not changed reads no rows; when it changed, the loaded pages swap in", async () => {
    const server = makeServer();
    const cachedModel = { ...fromHead(await server.head()), review: review.slice(0, 50), pages: { newArrivals: 1, review: 2, approved: 1 } };
    await saveListIdb(cachedModel);
    const later = (f) => vi.fn(() => new Promise((ok) => setTimeout(() => ok(f()), 40)));
    const api = fakeApi(server, { head: later(server.head) });
    await mount(api);
    await act(async () => { await new Promise((ok) => setTimeout(ok, 60)); });
    await flush();
    expect(server.pages).not.toHaveBeenCalled(); // same version: nothing re-read
    // The server rebuilt its list (one product approved elsewhere): the same 2 pages come back.
    const server2 = makeServer(2000);
    server2.st.review = review.filter((x) => x.pid !== "p03");
    const api2 = fakeApi(server2, { head: later(server2.head) });
    await saveListIdb(cachedModel);
    const r2 = await mount(api2);
    await act(async () => { await new Promise((ok) => setTimeout(ok, 60)); });
    await flush();
    expect(server2.pages).toHaveBeenCalledWith("review", 1, 1);
    expect(has(r2, "row-p03")).toBe(false);
  });

  it("a tap patches the row and the counts in place; no rows are re-read", async () => {
    const server = makeServer();
    const api = fakeApi(server);
    const r = await mount(api);
    await act(async () => { byId(r, "approve-p00").props.onClick(); });
    await flush();
    expect(text(byId(r, "tab-review"))).toBe("To review (60)"); // the totals line is the server's until it answers…
    expect(text(byId(r, "tab-approved"))).toBe("Approved (2)"); // …the tab count moves at once
    expect(server.pages).not.toHaveBeenCalled();
  });

  it("ticks: each is saved to the server; after an iOS kill the device's ticks come back at once, and the server's newer copy wins when it answers", async () => {
    globalThis.localStorage = mem(); globalThis.sessionStorage = mem();
    const server = makeServer();
    server.st.selection = { at: Date.now() + 60_000, sigs: { p01: "current", p02: "current" } };
    const cachedModel = fromHead(await server.head());
    globalThis.sessionStorage.setItem("bf.card.list", JSON.stringify(cachedModel));
    globalThis.localStorage.setItem("bf.card.ui", JSON.stringify({ at: Date.now(), tab: "review", selectMode: true, scrollY: 0, sel: { at: Date.now() - 1000, sigs: { p00: "current" } } }));
    let answer;
    const api = fakeApi(server, { head: vi.fn(() => new Promise((ok) => { answer = ok; })) });
    const r = await mount(api);
    expect(byId(r, "sel-p00").props["aria-checked"]).toBe(true); // the device's ticks, before the server answers
    await act(async () => { answer(await server.head()); });
    await flush();
    expect(byId(r, "sel-p01").props["aria-checked"]).toBe(true); // the server's newer copy
    expect(byId(r, "sel-p00").props["aria-checked"]).toBe(false);
    // A tick goes to the server.
    await act(async () => { byId(r, "row-p05").props.onClick(); });
    await act(async () => { await new Promise((ok) => setTimeout(ok, 450)); });
    const last = api.selSave.mock.calls.at(-1)[0];
    expect(Object.keys(last).sort()).toEqual(["p01", "p02", "p05"]);
  });

  it("when the precomputed list cannot be read, the card falls back to the whole list", async () => {
    const server = makeServer();
    const api = fakeApi(server, { head: vi.fn(async () => { throw new Error("boom"); }) });
    const r = await mount(api);
    expect(api.list).toHaveBeenCalled();
    expect(text(byId(r, "tab-review"))).toBe("To review (60)");
    expect(has(r, "more")).toBe(false);
  });
});
