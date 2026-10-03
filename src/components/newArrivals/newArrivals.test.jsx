// New Arrivals card — the words it shows and the buttons it offers, against
// item shapes as RTDB actually returns them (empty arrays/objects ABSENT).
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import NewArrivalsScreen from "./NewArrivalsScreen";
import {
  shopifyNameLine,
  priceText, sizesText, statusLine, rejectionText, destinationLines, actionsFor, chainProgress, MAX_ATTEMPTS,
  needsStockPrice,
} from "./newArrivalsView";
import * as view from "./newArrivalsView";

const NOW = Date.UTC(2026, 9, 2, 8, 0); // 10:00 SAST
const ready = (over = {}) => ({
  pid: "p1789999990000", status: "ready", enqueuedAt: NOW, statusAt: NOW, name: "Nike AF1 Black",
  generatedUrl: "https://x/gen.jpg", originalUrl: "https://x/orig.jpg", suggestedName: "Low-top sneaker in black",
  // The groups are priced at the STOCK price (owner, 3 Oct); retail is Shopify's.
  product: { name: "Nike AF1 Black", stockPrice: 550, retailPrice: 650, sizes: ["6", "7"] }, ...over,
});

describe("view helpers", () => {
  it("price and sizes", () => {
    expect(priceText(650)).toBe("R650");
    expect(priceText(null)).toBe("No price");
    expect(sizesText(["6", "7"])).toBe("6 · 7");
    // RTDB returns a sparse array as an index-keyed object.
    expect(sizesText({ 0: "6", 2: "8" })).toBe("6 · 8");
    expect(sizesText(undefined)).toBe("No sizes");
  });

  it("Ready does not need the name: 'naming pending' and Approve still offered", () => {
    const pending = ready({ suggestedName: undefined, naming: { status: "pending", since: 1 } });
    expect(shopifyNameLine(pending)).toBe("Shopify name: naming pending");
    expect(shopifyNameLine({ suggestedName: "A", chain: { name: { name: "Applied" } } })).toBe("Shopify name: Applied");
    expect(actionsFor(pending).approve).toBe(true);
    const approved = { status: "approved", approvedAt: 1, naming: { status: "pending" } };
    expect(destinationLines(approved)).toEqual(["Shopify — waiting for its name (the groups don't wait)", "WhatsApp — next posting window"]);
    expect(destinationLines({ status: "rejected", approvedAt: 1, naming: { status: "failed", reason: "duplicate name — needs a distinct name" } })[0])
      .toBe("Shopify — not published: duplicate name — needs a distinct name");
    expect(destinationLines({ status: "approved", approvedAt: 1, naming: { status: "failed" } })[0]).toBe("Shopify — not published: could not be named");
  });

  it("Approve only with a generated photo — never on an original", () => {
    expect(actionsFor(ready()).approve).toBe(true);
    expect(statusLine(ready())).toBe("Photo checked — waiting for your Approve");
    // A failed generation is not retried: the card says so and waits for a tap.
    const failedNew = { status: "new", lastAttempt: { failed: true, reason: "the photo service was busy — tap Generate again" } };
    expect(statusLine(failedNew)).toBe("Last photo failed: the photo service was busy — tap Generate again");
    expect(statusLine({ ...failedNew, generateRequest: 5 })).toMatch(/^Generate requested/);
    expect(actionsFor(ready()).approveEnabled).toBe(true);
    expect(actionsFor(ready({ generatedUrl: undefined })).approveEnabled).toBe(false);
    // No stock price → Approve still SHOWN on Ready, but disabled; the status line says what to do.
    const noPrice = ready({ product: { name: "x", sizes: ["6"] } });
    expect(actionsFor(noPrice).approve).toBe(true);
    expect(actionsFor(noPrice).approveEnabled).toBe(false);
    expect(statusLine(noPrice)).toBe("Photo checked — needs a stock price before approving");
    expect(actionsFor({ status: "rejected" })).toMatchObject({ approve: false, approveAnyway: false, regenerate: true, skip: true, reject: false });
    expect(actionsFor({ status: "new" })).toMatchObject({ approve: false, generate: true, skip: true, regenerate: false });
    expect(actionsFor({ status: "new", generateRequest: { at: 1 } }).generate).toBe(false);
    expect(actionsFor({ status: "skipped" })).toMatchObject({ approve: false, skip: false, generate: false, regenerate: false });
    expect("restore" in actionsFor({ status: "skipped" })).toBe(false); // no Skipped tab: Undo is the toast
  });

  it("the stock price gates Approve; the retail price is irrelevant", () => {
    const noRetail = ready({ product: { name: "x", stockPrice: 550, retailPrice: null, sizes: ["6"] } });
    expect(actionsFor(noRetail).approveEnabled).toBe(true);
    expect(statusLine(noRetail)).toBe("Photo checked — waiting for your Approve");
    const retailOnly = ready({ product: { name: "x", stockPrice: 0, retailPrice: 650, sizes: ["6"] } });
    expect(actionsFor(retailOnly).approveEnabled).toBe(false);
    expect(statusLine(retailOnly)).toMatch(/needs a stock price/);
    expect(actionsFor(ready({ product: { stockPrice: "550" } })).approveEnabled).toBe(true);
    expect(actionsFor(ready({ product: { stockPrice: -5 } })).approveEnabled).toBe(false);
  });

  it("needsStockPrice: absent, empty, zero, negative or junk → needs one", () => {
    for (const v of [undefined, null, "", 0, "0", -1, "abc"]) expect(needsStockPrice({ stockPrice: v })).toBe(true);
    expect(needsStockPrice(undefined)).toBe(true);
    expect(needsStockPrice({ stockPrice: 550 })).toBe(false);
    expect(needsStockPrice({ stockPrice: "550" })).toBe(false);
    expect(view.missingPricesOf).toBeUndefined();
  });

  it("rejection text: nothing regenerates by itself; Junid's own reason is shown", () => {
    const r = { status: "rejected", rejection: { code: "checker", reason: "The box print changed" } };
    expect(rejectionText({ ...r, attemptsSinceRetry: 1 })).toBe("The box print changed — tap Regenerate for a fresh attempt");
    expect(MAX_ATTEMPTS).toBe(3);
    expect(rejectionText({ status: "rejected", rejection: { code: "junid", reason: "box wrong" } })).toBe("You rejected it: box wrong");
    expect(rejectionText({ status: "rejected", rejection: { code: "source", reason: "retake photo" } })).toBe("retake photo");
    expect(rejectionText({ status: "rejected", rejection: { code: "name", reason: "duplicate name — needs a distinct name" } }))
      .toBe("duplicate name — needs a distinct name");
  });

  it("chain progress and destinations tolerate absent children", () => {
    expect(chainProgress({ chain: { photo: { at: 1 }, name: { at: 2 } } })).toMatch(/^photo set · name accepted — next: condition Excellent/);
    expect(chainProgress({})).toBe("Publishing…");
    expect(statusLine({ status: "chaining" })).toBe("Publishing…");
    // destinations.groups written as [] comes back absent.
    const lines = destinationLines({ status: "done", destinations: { shopify: { at: NOW, title: "Low-top sneaker in black" } } });
    expect(lines[0]).toMatch(/^Shopify — live .* as “Low-top sneaker in black”/);
    expect(lines.length).toBe(1); // not approved here, so no WhatsApp line
    expect(destinationLines({ status: "done", soldOutBeforePosting: { at: NOW, window: "10:00" }, destinations: { shopify: { at: NOW } } })[1])
      .toBe("WhatsApp groups — not posted: sold out before the 10:00 window");
    expect(destinationLines({ status: "done" })).toEqual([]);
  });
});

const fakeApi = (items = [ready()], over = {}) => ({
  select: vi.fn(async () => ({ ok: true })),
  list: vi.fn(async (tab) => ({ tab, items: tab === "ready" ? items : [], tabCounts: { new: 2, ready: items.length, rejected: 0, done: 5 } })),
  approve: vi.fn(async (pids) => ({ approved: pids, skipped: [] })),
  approveAll: vi.fn(async () => ({ approved: items.map((i) => i.pid), skipped: [] })),
  retry: vi.fn(async () => ({ ok: true })),
  generate: vi.fn(async (pids) => ({ requested: pids, skipped: [] })),
  skip: vi.fn(async (pids) => ({ skippedPids: pids, skipped: [] })),
  restore: vi.fn(async (pids) => ({ restored: pids, skipped: [] })),
  reject: vi.fn(async () => ({ ok: true })),
  ...over,
});
const text = (tree) => {
  const walk = (n) => (n == null || n === false ? "" : Array.isArray(n) ? n.map(walk).join("") : typeof n === "object" ? walk(n.children) : String(n));
  return walk(tree.toJSON());
};
// A device's localStorage, in memory (throwOn: its accessor throws, as in private mode).
const memStorage = (init = {}, { throwOn = false } = {}) => {
  const m = new Map(Object.entries(init));
  return {
    getItem: vi.fn((k) => { if (throwOn) throw new Error("denied"); return m.has(k) ? m.get(k) : null; }),
    setItem: vi.fn((k, v) => { if (throwOn) throw new Error("denied"); m.set(k, String(v)); }),
    map: m,
  };
};
const render = async (api, initialTab = "ready", storage = memStorage()) => {
  let tree;
  await act(async () => { tree = TestRenderer.create(<NewArrivalsScreen api={api} onExit={() => {}} initialTab={initialTab} storage={storage} />); });
  return tree;
};
// Exact label match: "Approve" must not find "Approve all 1".
const label = (n) => [].concat(n.props.children).filter((c) => typeof c === "string" || typeof c === "number").join("");
const button = (tree, l) => tree.root.findAll((n) => n.type === "button").find((b) => label(b) === l);

describe("NewArrivalsScreen", () => {
  it("Ready shows original + generated, price, sizes, suggested name and Approve", async () => {
    const tree = await render(fakeApi());
    const t = text(tree);
    expect(t).toContain("Original");
    expect(t).toContain("Generated");
    // The groups' price is the STOCK price — the retail price is never shown.
    expect(t).toContain("R550 for the groups · Sizes 6 · 7");
    expect(t).not.toContain("R650");
    expect(t).toContain("Shopify name: Low-top sneaker in black");
    expect(t).toContain("Approve all 1");
    expect(t).not.toContain("priced");
    expect(tree.root.findAll((n) => n.props && n.props["data-testid"] === "unpriced-flag")).toHaveLength(0);
    expect(tree.root.findAll((n) => n.props && n.props["data-testid"] === "approve-note")).toHaveLength(0);
    const imgs = tree.root.findAll((n) => n.type === "img").map((i) => i.props.src);
    expect(imgs).toEqual(["https://x/orig.jpg", "https://x/gen.jpg"]);
  });

  it("Approve calls the callable with exactly that pid and reloads", async () => {
    const api = fakeApi();
    const tree = await render(api);
    await act(async () => { button(tree, "Approve").props.onClick(); });
    expect(api.approve).toHaveBeenCalledWith(["p1789999990000"]);
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(text(tree)).toContain("publishing has started");
  });

  it("Approve all asks first and does nothing if Junid cancels", async () => {
    const api = fakeApi();
    const tree = await render(api);
    const confirm = vi.fn(() => false);
    globalThis.window = { confirm };
    await act(async () => { button(tree, "Approve all 1").props.onClick(); });
    expect(api.approve).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await act(async () => { button(tree, "Approve all 1").props.onClick(); });
    expect(api.approve).toHaveBeenCalledWith(["p1789999990000"]);
    expect(api.approveAll).not.toHaveBeenCalled();
    expect(confirm.mock.calls[0][0]).toMatch(/Approve all 1 items shown/);
    delete globalThis.window;
  });

  it("a skipped approve is reported, not hidden", async () => {
    const api = fakeApi([ready()], { approve: vi.fn(async () => ({ approved: [], skipped: [{ pid: "p1789999990000", why: "it is approved, not ready" }] })) });
    const tree = await render(api);
    await act(async () => { button(tree, "Approve").props.onClick(); });
    expect(text(tree)).toContain("1 not approved (it is approved, not ready)");
  });

  it("a slow response for a tab no longer shown is dropped", async () => {
    let resolveReady;
    const api = fakeApi([], { list: vi.fn((tab) => tab === "ready"
      ? new Promise((r) => { resolveReady = r; })
      : Promise.resolve({ items: [{ pid: "p1789999990009", status: "rejected", rejection: { code: "source", reason: "retake photo" }, product: {} }], tabCounts: {} })) });
    const tree = await render(api);
    await act(async () => { tree.root.findAll((n) => n.props?.role === "tab")[2].props.onClick(); });
    await act(async () => { resolveReady({ items: [ready()], tabCounts: {} }); });
    expect(text(tree)).toContain("retake photo");
    expect(text(tree)).not.toContain("Shopify name: Low-top sneaker in black");
  });

  it("a load failure is shown in words", async () => {
    const api = fakeApi([], { list: vi.fn(async () => { throw new Error("permission-denied"); }) });
    const tree = await render(api);
    expect(text(tree)).toContain("Couldn't load: permission-denied");
  });

  it("Rejected offers Regenerate and Skip, no Approve (no photo → no Approve anyway)", async () => {
    const rej = { pid: "p1789999990001", status: "rejected", rejection: { code: "source", reason: "retake photo" }, product: {} };
    const api = fakeApi([], { list: vi.fn(async () => ({ items: [rej], tabCounts: {} })) });
    const tree = await render(api, "rejected");
    expect(text(tree)).toContain("retake photo");
    await act(async () => { button(tree, "Regenerate").props.onClick(); });
    expect(api.generate).toHaveBeenCalledWith(["p1789999990001"], { regenerate: true });
    expect(button(tree, "Approve")).toBeUndefined();
    expect(button(tree, "Approve anyway")).toBeUndefined();
    expect(button(tree, "Skip — don't advertise")).toBeTruthy();
  });
});

describe("PRICES: Stock price (R) + Retail price (R), pre-filled, one Save — the admin price save", () => {
  const priced = () => ready();
  const unpriced = (o = {}) => ({ ...ready(), pid: "p1789999990001", product: { ...ready().product, stockPrice: null }, ...o });
  const testid = (tree, id) => tree.root.findAll((n) => n.props && n.props["data-testid"] === id && typeof n.type === "string");
  const field = (tree, l) => tree.root.findAll((n) => n.type === "input" && n.props["aria-label"] === l)[0];
  const type = async (tree, l, v) => act(async () => { field(tree, l).props.onChange({ target: { value: v } }); });

  it("both fields on every Ready card, pre-filled with the current prices", async () => {
    const tree = await render(fakeApi([priced()], { savePrices: vi.fn() }));
    expect(field(tree, "Stock price (R)").props.value).toBe("550");
    expect(field(tree, "Retail price (R)").props.value).toBe("650");
    expect(text(tree)).toContain("Stock price posts to the WhatsApp groups");
    // Nothing changed yet: Save is off.
    expect(button(tree, "Save").props.disabled).toBe(true);
  });

  it("no stock price: Approve is SHOWN but disabled, with 'add stock price first' by the fields — never hidden", async () => {
    const tree = await render(fakeApi([unpriced()], { savePrices: vi.fn() }));
    expect(field(tree, "Stock price (R)").props.value).toBe("");
    expect(field(tree, "Retail price (R)").props.value).toBe("650");
    const approve = button(tree, "Approve");
    expect(approve).toBeTruthy();
    expect(approve.props.disabled).toBe(true);
    expect(testid(tree, "approve-note")).toHaveLength(1);
    expect(text(tree)).toContain("add stock price first");
    expect(testid(tree, "price-fields")[0].findAll((n) => n.props?.["data-testid"] === "approve-note")).toHaveLength(1);
    expect(text(tree)).toContain("1 item has no stock price — add it on the card to approve.");
    expect(text(tree)).not.toContain("Approve all");
  });

  it("a priced item: Approve enabled, no note", async () => {
    const tree = await render(fakeApi([priced()], { savePrices: vi.fn() }));
    expect(button(tree, "Approve").props.disabled).toBe(false);
    expect(testid(tree, "approve-note")).toHaveLength(0);
  });

  it("ONE Save sends BOTH changes (changing an existing price, too) to the admin save, then reloads", async () => {
    const savePrices = vi.fn(async () => ({ ok: true, count: 1 }));
    const api = fakeApi([priced()], { savePrices });
    const tree = await render(api);
    await type(tree, "Stock price (R)", "500");
    await type(tree, "Retail price (R)", "799");
    await act(async () => { button(tree, "Save").props.onClick(); });
    expect(savePrices).toHaveBeenCalledTimes(1);
    expect(savePrices.mock.calls[0]).toEqual(["p1789999990000", expect.objectContaining({ stockPrice: 550, retailPrice: 650 }), { stockPrice: "500", retailPrice: "799" }]);
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(text(tree)).toContain("Prices saved.");
  });

  it("only the field changed is sent", async () => {
    const savePrices = vi.fn(async () => ({ ok: true, count: 1 }));
    const tree = await render(fakeApi([unpriced()], { savePrices }));
    await type(tree, "Stock price (R)", "400");
    await act(async () => { button(tree, "Save").props.onClick(); });
    expect(savePrices.mock.calls[0][2]).toEqual({ stockPrice: "400" });
  });

  it("New and Rejected cards carry the fields too; Done does not", async () => {
    const rej = { ...priced(), status: "rejected", rejection: { code: "junid", reason: "framing" } };
    let tree = await render(pagedApi([newItem(0)], { savePrices: vi.fn() }), "new");
    expect(testid(tree, "price-fields")).toHaveLength(1);
    tree = await render(fakeApi([], { savePrices: vi.fn(), list: vi.fn(async () => ({ items: [rej], tabCounts: {} })) }), "rejected");
    expect(testid(tree, "price-fields")).toHaveLength(1);
    tree = await render(fakeApi([], { savePrices: vi.fn(), list: vi.fn(async () => ({ items: [{ ...priced(), status: "done" }], tabCounts: {} })) }), "done");
    expect(testid(tree, "price-fields")).toHaveLength(0);
  });

  it("Approve all excludes the unpriced item", async () => {
    const api = fakeApi([priced(), unpriced(), unpriced({ pid: "p1789999990002" })], { savePrices: vi.fn() });
    const tree = await render(api);
    expect(tree.root.findAll((n) => n.type === "button" && label(n) === "Approve")).toHaveLength(3);
    expect(text(tree)).toContain("2 items have no stock price");
    globalThis.window = { confirm: vi.fn(() => true) };
    await act(async () => { button(tree, "Approve all 1").props.onClick(); });
    expect(api.approve).toHaveBeenCalledWith(["p1789999990000"]);
    delete globalThis.window;
  });

  it("retail below cost: asks (the admin editor's question), and retries with { confirmed: true }", async () => {
    const savePrices = vi.fn()
      .mockResolvedValueOnce({ ok: false, needsConfirm: true, error: "Retail Price (R650) is lower than Stock Price (R700). Continue?" })
      .mockResolvedValueOnce({ ok: true, count: 1 });
    const tree = await render(fakeApi([unpriced()], { savePrices }));
    await type(tree, "Stock price (R)", "700");
    const confirm = vi.fn(() => true);
    globalThis.window = { confirm };
    await act(async () => { button(tree, "Save").props.onClick(); });
    delete globalThis.window;
    expect(confirm).toHaveBeenCalledWith("Retail Price (R650) is lower than Stock Price (R700). Continue?");
    expect(savePrices.mock.calls[1]).toEqual(["p1789999990001", expect.any(Object), { stockPrice: "700" }, { confirmed: true }]);
    expect(text(tree)).toContain("Prices saved.");
  });

  it("a refused save says why and reloads nothing", async () => {
    const api = fakeApi([unpriced()], { savePrices: vi.fn(async () => ({ ok: false, error: "Stock price must be a number above 0 (or empty to clear)." })) });
    const tree = await render(api);
    await type(tree, "Stock price (R)", "0");
    await act(async () => { button(tree, "Save").props.onClick(); });
    expect(text(tree)).toContain("Prices not saved: Stock price must be a number above 0");
    expect(api.list).toHaveBeenCalledTimes(1);
  });
});

// ─── CALIBRATION: paging, filters, skip/restore, generate, reject, header ────
const P = (i) => `p17899999${String(i).padStart(5, "0")}`;
const newItem = (i, over = {}) => ({
  pid: P(i), status: "new", enqueuedAt: NOW, statusAt: NOW, name: `Item ${i}`, originalUrl: `https://x/o${i}.jpg`,
  availableSizes: ["7"], totalUnits: 2, stockKnown: true,
  product: { name: `Item ${i}`, stockPrice: 500, sizes: ["7", "8"] }, ...over,
});
// A paged fake server over `all`: 30 a page, cursor = last pid, by group
// (an item's `grp`, default sneakers) — as the callable pages within a group.
const grpOf = (i) => i.grp || "sneakers";
const pagedApi = (all, over = {}) => fakeApi([], {
  list: vi.fn(async (tab, { cursor = null, limit = 30, group = null } = {}) => {
    const pool = group ? all.filter((i) => grpOf(i) === group) : all;
    const from = cursor ? pool.findIndex((i) => i.pid === cursor) + 1 : 0;
    const page = pool.slice(from, from + limit);
    const more = from + limit < pool.length;
    const groupCounts = group ? { sneakers: all.filter((i) => grpOf(i) === "sneakers").length, clothing: all.filter((i) => grpOf(i) === "clothing").length } : null;
    return { tab, items: page, total: pool.length, nextCursor: more ? page[page.length - 1].pid : null,
      tabCounts: { new: all.length }, groupCounts, stats: null, modes: {}, matchingPids: pool.map((i) => i.pid) };
  }),
  ...over,
});
const testid = (tree, id) => tree.root.findAll((n) => n.props && n.props["data-testid"] === id && typeof n.type === "string");

describe("paging", () => {
  it("New shows 30 of 75, Load more fetches the next page by cursor, to the end", async () => {
    const all = Array.from({ length: 75 }, (_, i) => newItem(i));
    const api = pagedApi(all);
    const tree = await render(api, "new");
    expect(text(tree)).toContain("Showing 30 of 75");
    expect(api.list).toHaveBeenCalledWith("new", { cursor: null, limit: 30, group: "sneakers" });
    await act(async () => { button(tree, "Load more (30 of 75 loaded)").props.onClick(); });
    expect(api.list).toHaveBeenLastCalledWith("new", { cursor: P(29), limit: 30, group: "sneakers" });
    expect(text(tree)).toContain("Showing 60 of 75");
    await act(async () => { button(tree, "Load more (60 of 75 loaded)").props.onClick(); });
    expect(text(tree)).toContain("Showing 75 of 75");
    expect(tree.root.findAll((n) => n.type === "button" && /^Load more/.test(label(n)))).toHaveLength(0);
    expect(tree.root.findAll((n) => n.props?.["data-pid"] && n.type === "div")).toHaveLength(75);
  });

  it("an action reloads every item already on screen, not just the first page", async () => {
    const all = Array.from({ length: 45 }, (_, i) => newItem(i));
    const api = pagedApi(all);
    const tree = await render(api, "new");
    await act(async () => { button(tree, "Load more (30 of 45 loaded)").props.onClick(); });
    await act(async () => { tree.root.findAll((n) => n.type === "button" && label(n) === "Generate")[0].props.onClick(); });
    expect(api.generate).toHaveBeenCalledWith([P(0)]);
    expect(api.list).toHaveBeenLastCalledWith("new", { cursor: null, limit: 45, group: "sneakers" });
    expect(text(tree)).toContain("Showing 45 of 45");
  });
});

describe("New tab: the group switcher, multi-select, Generate, Skip", () => {
  const mixed = () => [0, 1, 2, 3, 4].map((i) => newItem(i, { grp: i % 2 ? "clothing" : "sneakers" }));
  const sw = (tree) => testid(tree, "group-switcher")[0];
  const swName = (tree) => text({ toJSON: () => testid(tree, "group-name")[0].children });
  const arrow = (tree, l) => tree.root.findAll((n) => n.type === "button" && n.props["aria-label"] === l)[0];

  it("no filter chips: ONE switcher bar, default Sneakers with its count", async () => {
    const api = pagedApi(mixed());
    const tree = await render(api, "new");
    expect(testid(tree, "filters")).toHaveLength(0);
    for (const l of ["1 size only", "No stock price", "Slides", "Two-piece"]) expect(button(tree, l)).toBeUndefined();
    expect(testid(tree, "group-switcher")).toHaveLength(1);
    expect(swName(tree)).toBe("Sneakers · 3");
    expect(api.list).toHaveBeenLastCalledWith("new", { cursor: null, limit: 30, group: "sneakers" });
    expect(text(tree)).toContain("Showing 3 of 3");
  });

  it("arrows flip groups; the arrow with nowhere further to go is dimmed and disabled; the group is remembered", async () => {
    const storage = memStorage();
    const api = pagedApi(mixed());
    const tree = await render(api, "new", storage);
    expect(arrow(tree, "Previous group").props.disabled).toBe(true);
    expect(arrow(tree, "Previous group").props.style.opacity).toBeLessThan(1);
    expect(arrow(tree, "Next group").props.disabled).toBe(false);
    expect(arrow(tree, "Next group").props.style.opacity).toBe(1);
    await act(async () => { arrow(tree, "Next group").props.onClick(); });
    expect(api.list).toHaveBeenLastCalledWith("new", { cursor: null, limit: 30, group: "clothing" });
    expect(swName(tree)).toBe("Clothing · 2");
    expect(storage.map.get("newArrivals.group")).toBe("clothing");
    expect(arrow(tree, "Next group").props.disabled).toBe(true);
    expect(arrow(tree, "Previous group").props.disabled).toBe(false);
    const calls = api.list.mock.calls.length;
    await act(async () => { arrow(tree, "Next group").props.onClick(); }); // at the end: nothing
    expect(api.list.mock.calls.length).toBe(calls);
    await act(async () => { arrow(tree, "Previous group").props.onClick(); });
    expect(swName(tree)).toBe("Sneakers · 3");
    expect(storage.map.get("newArrivals.group")).toBe("sneakers");
  });

  it("a horizontal swipe on the bar flips: left → next, right → previous; a short drag does nothing", async () => {
    const api = pagedApi(mixed());
    const tree = await render(api, "new");
    const swipe = async (x0, x1) => act(async () => {
      sw(tree).props.onTouchStart({ touches: [{ clientX: x0 }] });
      sw(tree).props.onTouchEnd({ changedTouches: [{ clientX: x1 }] });
    });
    await swipe(200, 180);
    expect(swName(tree)).toBe("Sneakers · 3");
    await swipe(200, 100);
    expect(swName(tree)).toBe("Clothing · 2");
    await swipe(100, 200);
    expect(swName(tree)).toBe("Sneakers · 3");
    await swipe(100, 200); // already first: stays
    expect(swName(tree)).toBe("Sneakers · 3");
  });

  it("the remembered group opens; junk or a throwing storage falls back to Sneakers", async () => {
    let tree = await render(pagedApi(mixed()), "new", memStorage({ "newArrivals.group": "clothing" }));
    expect(swName(tree)).toBe("Clothing · 2");
    tree = await render(pagedApi(mixed()), "new", memStorage({ "newArrivals.group": "slides" }));
    expect(swName(tree)).toBe("Sneakers · 3");
    const broken = memStorage({}, { throwOn: true });
    tree = await render(pagedApi(mixed()), "new", broken);
    expect(swName(tree)).toBe("Sneakers · 3");
    await act(async () => { tree.root.findAll((n) => n.type === "button" && n.props["aria-label"] === "Next group")[0].props.onClick(); });
    expect(swName(tree)).toBe("Clothing · 2"); // flips even though it cannot be remembered
    expect(view.rememberedGroup(null)).toBe("sneakers");
    expect(view.stepGroup("sneakers", -1)).toBeNull();
    expect(view.stepGroup("sneakers", 1)).toBe("clothing");
    expect(view.GROUPS.map((g) => g.label)).toEqual(["Sneakers", "Clothing"]);
  });

  it("pages 30 at a time WITHIN the group; Select all + Skip selected act on the whole group only", async () => {
    const all = Array.from({ length: 80 }, (_, i) => newItem(i, { grp: i < 45 ? "sneakers" : "clothing" }));
    const api = pagedApi(all);
    const tree = await render(api, "new");
    expect(swName(tree)).toBe("Sneakers · 45");
    expect(text(tree)).toContain("Showing 30 of 45");
    await act(async () => { button(tree, "Load more (30 of 45 loaded)").props.onClick(); });
    expect(api.list).toHaveBeenLastCalledWith("new", { cursor: P(29), limit: 30, group: "sneakers" });
    expect(text(tree)).toContain("Showing 45 of 45");
    await act(async () => { button(tree, "Select all 45").props.onClick(); });
    await act(async () => { button(tree, "Skip selected (45)").props.onClick(); });
    expect(api.skip).toHaveBeenCalledTimes(1);
    expect(api.skip.mock.calls[0][0]).toEqual(all.slice(0, 45).map((i) => i.pid));
  });

  it("Ready and Rejected are grouped too; Done is not", async () => {
    const api = pagedApi([ready()]);
    let tree = await render(api, "ready");
    expect(testid(tree, "group-switcher")).toHaveLength(1);
    expect(api.list).toHaveBeenLastCalledWith("ready", { cursor: null, limit: 30, group: "sneakers" });
    tree = await render(api, "rejected");
    expect(testid(tree, "group-switcher")).toHaveLength(1);
    tree = await render(api, "done");
    expect(testid(tree, "group-switcher")).toHaveLength(0);
    expect(api.list).toHaveBeenLastCalledWith("done", { cursor: null, limit: 30, group: null });
  });

  it("Select all is selection-aware: a checked item + Generate selected", async () => {
    const api = pagedApi([newItem(0), newItem(1)]);
    const tree = await render(api, "new");
    const box = tree.root.findAll((n) => n.type === "input" && n.props.type === "checkbox")[1];
    await act(async () => { box.props.onChange(); });
    expect(text(tree)).toContain("1 selected");
    await act(async () => { button(tree, "Generate selected (1)").props.onClick(); });
    expect(api.generate).toHaveBeenCalledWith([P(1)]);
  });

  it("each New item shows sizes in stock + units, Generate and Skip, and no reject chips", async () => {
    const api = pagedApi([newItem(0, { availableSizes: ["7", "9"], totalUnits: 5 }), newItem(1, { stockKnown: false, totalUnits: 0, availableSizes: [] })]);
    const tree = await render(api, "new");
    const t = text(tree);
    expect(t).toContain("In stock: 7 · 9 — 5 units");
    expect(t).toContain("No stock recorded");
    expect(t).toContain("Waiting — tap Generate");
    await act(async () => { tree.root.findAll((n) => n.type === "button" && label(n) === "Skip — don't advertise")[0].props.onClick(); });
    expect(api.skip).toHaveBeenCalledWith([P(0)]);
    expect(testid(tree, "reject-chips")).toHaveLength(0);
  });
});

const GEN = (id, at, over = {}) => ({ url: `https://x/${id}.jpg`, at, model: "m", promptVersion: "v3", plate: "footwear-plate.png", kind: "footwear",
  costUsd: 0.04, costZar: 0.75, verdict: { pass: true, failed: [] }, reason: "requested", ...over });

describe("Ready / Rejected: every generation, verdict label, chips, Approve anyway", () => {
  const withGens = (over = {}) => ready({
    generatedUrl: "https://x/g2.jpg", currentGen: "g2",
    generations: { g1: GEN("g1", NOW - 1000, { costZar: 0.5, verdict: { pass: false, failed: ["fidelity:colour"], label: "colour off" } }), g2: GEN("g2", NOW) },
    verdict: { pass: false, failed: ["background"], label: "background" }, ...over,
  });

  it("shows the latest big and the earlier one, each with its cost; the verdict is a label only", async () => {
    const tree = await render(fakeApi([withGens()]));
    const imgs = tree.root.findAll((n) => n.type === "img").map((i) => i.props.src);
    expect(imgs).toEqual(["https://x/orig.jpg", "https://x/g2.jpg", "https://x/g1.jpg"]);
    const t = text(tree);
    expect(t).toContain("Generated · Main photo · R0.75");
    expect(t).toContain("R0.50 · failed");
    expect(t).toContain("2 generations · R1.25 total");
    expect(t).toContain("Checker: failed — background");
    expect(button(tree, "Approve")).toBeTruthy(); // the failed verdict never blocks
  });

  it("Reject is one tap on a chip — exactly the contract's strings", async () => {
    const api = fakeApi([withGens()]);
    const tree = await render(api);
    const chips = testid(tree, "reject-chips")[0].findAll((n) => n.type === "button").map(label);
    expect(chips).toEqual(["background wrong", "colour off", "detail changed", "looks fake/CGI", "framing", "box wrong", "blurry"]);
    await act(async () => { button(tree, "looks fake/CGI").props.onClick(); });
    expect(api.reject).toHaveBeenCalledWith("p1789999990000", "looks fake/CGI");
    expect(text(tree)).toContain("Rejected: looks fake/CGI.");
  });

  it("Regenerate on Ready asks for a fresh attempt", async () => {
    const api = fakeApi([withGens()]);
    const tree = await render(api);
    await act(async () => { button(tree, "Regenerate").props.onClick(); });
    expect(api.generate).toHaveBeenCalledWith(["p1789999990000"], { regenerate: true });
  });

  it("Rejected shows every generation and Approve anyway (anyway: true)", async () => {
    const rej = withGens({ status: "rejected", rejection: { code: "junid", reason: "framing", at: NOW } });
    const api = fakeApi([], { list: vi.fn(async () => ({ items: [rej], tabCounts: {} })) });
    const tree = await render(api, "rejected");
    expect(tree.root.findAll((n) => n.type === "img")).toHaveLength(3);
    expect(text(tree)).toContain("You rejected it: framing");
    const anyway = tree.root.findAll((n) => n.type === "button" && label(n) === "Approve anyway");
    // One per earlier generation (g1) + the main one.
    expect(anyway).toHaveLength(2);
    await act(async () => { anyway[anyway.length - 1].props.onClick(); });
    expect(api.approve).toHaveBeenCalledWith(["p1789999990000"], { anyway: true });
    await act(async () => { anyway[0].props.onClick(); });
    expect(api.approve).toHaveBeenLastCalledWith(["p1789999990000"], { anyway: true, genId: "g1" });
  });

  it("Rejected with no stock price: Approve anyway is SHOWN but disabled, with 'add stock price first'", async () => {
    const rej = withGens({ status: "rejected", rejection: { code: "generation", reason: "x", at: NOW } });
    rej.product = { ...rej.product, stockPrice: null };
    const api = fakeApi([], { savePrices: vi.fn(), list: vi.fn(async () => ({ items: [rej], tabCounts: {} })) });
    const tree = await render(api, "rejected");
    const anyway = tree.root.findAll((n) => n.type === "button" && label(n) === "Approve anyway");
    expect(anyway).toHaveLength(2);
    for (const b of anyway) expect(b.props.disabled).toBe(true);
    expect(text(tree)).toContain("add stock price first");
  });

  it("Done shows every generation too", async () => {
    const done = withGens({ status: "done" });
    const api = fakeApi([], { list: vi.fn(async () => ({ items: [done], tabCounts: {} })) });
    const tree = await render(api, "done");
    expect(tree.root.findAll((n) => n.type === "img")).toHaveLength(3);
  });
});

describe("Skip — one tap, an 8-second Undo, no Skipped tab", () => {
  it("there is no Skipped tab", async () => {
    const tree = await render(pagedApi([newItem(0)]), "new");
    expect(tree.root.findAll((n) => n.props?.role === "tab").map((t) => label(t).replace(/[\d\s]+$/, ""))).toEqual(["New", "Ready", "Rejected", "Done"]);
    expect(view.TABS.map((t) => t.key)).not.toContain("skipped");
    expect(view.UNDO_MS).toBe(8000);
  });

  it("Skip shows a toast with Undo; Undo calls Restore with that pid and reloads", async () => {
    const api = pagedApi([newItem(0), newItem(1)]);
    const tree = await render(api, "new");
    await act(async () => { tree.root.findAll((n) => n.type === "button" && label(n) === "Skip — don't advertise")[0].props.onClick(); });
    expect(api.skip).toHaveBeenCalledWith([P(0)]);
    expect(testid(tree, "undo-toast")).toHaveLength(1);
    expect(text(tree)).toContain("1 skipped — not advertised.");
    const calls = api.list.mock.calls.length;
    await act(async () => { button(tree, "Undo").props.onClick(); });
    expect(api.restore).toHaveBeenCalledWith([P(0)]);
    expect(api.list.mock.calls.length).toBe(calls + 1);
    expect(testid(tree, "undo-toast")).toHaveLength(0);
    expect(text(tree)).toContain("Skip undone — 1 back.");
  });

  it("a second Skip within 8 s ADDS to the open toast — Undo restores both", async () => {
    const api = pagedApi([newItem(0), newItem(1)]);
    const tree = await render(api, "new");
    const skips = () => tree.root.findAll((n) => n.type === "button" && label(n) === "Skip — don't advertise");
    await act(async () => { skips()[0].props.onClick(); });
    await act(async () => { skips()[skips().length - 1].props.onClick(); });
    expect(testid(tree, "undo-toast")).toHaveLength(1);
    expect(text(tree)).toContain("2 skipped — not advertised.");
    await act(async () => { button(tree, "Undo").props.onClick(); });
    const restored = api.restore.mock.calls.flatMap((c) => c[0]);
    expect(restored.length).toBe(2);
  });

  it("the toast goes after 8 seconds and the skip stands", async () => {
    vi.useFakeTimers();
    try {
      const api = pagedApi([newItem(0)]);
      const tree = await render(api, "new");
      await act(async () => { tree.root.findAll((n) => n.type === "button" && label(n) === "Skip — don't advertise")[0].props.onClick(); });
      await act(async () => { vi.advanceTimersByTime(7900); });
      expect(testid(tree, "undo-toast")).toHaveLength(1);
      await act(async () => { vi.advanceTimersByTime(200); });
      expect(testid(tree, "undo-toast")).toHaveLength(0);
      expect(api.restore).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("Skip selected: ONE toast, and Undo restores them all", async () => {
    const api = pagedApi([0, 1, 2].map((i) => newItem(i)));
    const tree = await render(api, "new");
    await act(async () => { button(tree, "Select all 3").props.onClick(); });
    await act(async () => { button(tree, "Skip selected (3)").props.onClick(); });
    expect(testid(tree, "undo-toast")).toHaveLength(1);
    expect(text(tree)).toContain("3 skipped — not advertised.");
    await act(async () => { button(tree, "Undo").props.onClick(); });
    expect(api.restore).toHaveBeenCalledTimes(1);
    expect(api.restore).toHaveBeenCalledWith([P(0), P(1), P(2)]);
  });

  it("Skip on a Rejected item gets the toast too; a refused skip is reported", async () => {
    const rej = { ...newItem(0), status: "rejected", rejection: { code: "junid", reason: "framing" } };
    const api = fakeApi([], {
      list: vi.fn(async () => ({ items: [rej], tabCounts: {} })),
      skip: vi.fn(async () => ({ skippedPids: [], skipped: [{ pid: P(0), why: "it is ready, not new or rejected" }] })),
    });
    const tree = await render(api, "rejected");
    await act(async () => { button(tree, "Skip — don't advertise").props.onClick(); });
    expect(testid(tree, "undo-toast")).toHaveLength(0);
    expect(text(tree)).toContain("1 not skipped (it is ready, not new or rejected)");
  });
});

describe("header agreement %", () => {
  it("per class from stats; absent → —; auto mode marked", async () => {
    const stats = { agreement: { footwear: { pct: 83.4, n: 30, window: 30 }, single: { pct: null, n: 2 } } };
    const api = fakeApi([ready()], { list: vi.fn(async () => ({ items: [ready()], tabCounts: {}, stats, modes: { footwear: "auto" } })) });
    const tree = await render(api);
    expect(testid(tree, "agreement").map((n) => text({ toJSON: () => n.children }))[0])
      .toMatch(/^Agreement with you: Footwear 83% \(auto\) · Clothing — · Two-piece —/);
    expect(view.agreementText(null, "footwear")).toBe("—");
  });
});

describe("view helpers for calibration", () => {
  it("generationsOf sorts newest first; costs and verdicts", () => {
    const item = { generations: { g1: GEN("g1", 1), g3: GEN("g3", 3), g2: GEN("g2", 2) } };
    expect(view.generationsOf(item).map((g) => g.genId)).toEqual(["g3", "g2", "g1"]);
    expect(view.generationsOf({})).toEqual([]);
    expect(view.costText({ costUsd: 0.04, usdZar: 18 })).toBe("R0.72");
    expect(view.costText({})).toBe("~R2.41 (estimated)");
    expect(view.verdictText({ pass: true })).toBe("Checker: pass");
    expect(view.verdictText({ pass: false, failed: ["framing", "quality"] })).toBe("Checker: failed — framing, quality");
    expect(view.verdictText(null)).toBeNull();
    expect(view.stockText({ stockKnown: true, availableSizes: ["8"], totalUnits: 1 })).toBe("In stock: 8 — 1 unit");
    expect(view.REJECT_CHIPS).toHaveLength(7);
  });
});

import { rejectRateText } from "./newArrivalsView";
describe("header: reject rate and cost per finished photo", () => {
  it("shows Junid's reject rate, top reasons and cost — or dashes before any data", () => {
    expect(rejectRateText(null)).toBe("Rejected — · cost per finished photo —");
    expect(rejectRateText({ rejectRate: { pct: 20, n: 25, byReason: { blurry: 3, framing: 2 } }, costPerFinishedZar: 4.5 }))
      .toBe("Rejected 20% of 25 (target under 15%) — blurry 3, framing 2 · R4.50 per finished photo");
  });
});

describe("a re-check is never shown as a generation's cost", () => {
  it("labels a derived (re-checked) photo", () => {
    expect(view.costText({ costZar: 0.21, derivedFrom: "g1" })).toBe("re-check, no new generation · R0.21");
    expect(view.costText({ costZar: 2.41 })).toBe("R2.41");
  });
});

describe("pick any generation — Use this one", () => {
  const gens = (over = {}) => ready({
    generatedUrl: "https://x/g2.jpg", currentGen: "g2",
    generations: {
      g1: GEN("g1", NOW - 2000, { costZar: 2.38, verdict: { pass: false, failed: ["fidelity:colour"], label: "colour off" } }),
      g2: GEN("g2", NOW - 1000, { costZar: undefined, costUsd: undefined }),
      g3: GEN("g3", NOW, { costZar: 0.19, derivedFrom: "g1", verdict: { pass: false, failed: ["framing"] } }),
    }, ...over,
  });
  const useButtons = (tree) => tree.root.findAll((n) => n.type === "button" && label(n) === "Use this one");

  it("every earlier generation (failed ones and re-checks too) has Use this one; the current one does not and is marked Main photo", async () => {
    const api = fakeApi([gens()]);
    const tree = await render(api);
    expect(useButtons(tree)).toHaveLength(2);
    const t = text(tree);
    expect(t).toContain("Generated · Main photo · ~R2.41 (estimated)");
    expect(t).toContain("re-check, no new generation · R0.19 · failed");
    expect(t).toContain("R2.38 · failed");
    expect(t).not.toContain("unknown");
    // Newest first: g3 (re-check) then g1.
    await act(async () => { useButtons(tree)[1].props.onClick(); });
    expect(api.select).toHaveBeenCalledWith("p1789999990000", "g1");
    expect(api.list.mock.calls.length).toBeGreaterThan(1); // reloaded
    expect(text(tree)).toContain("Main photo changed — Approve uses this one.");
    await act(async () => { useButtons(tree)[0].props.onClick(); });
    expect(api.select).toHaveBeenLastCalledWith("p1789999990000", "g3");
  });

  it("on Rejected too; never on Done", async () => {
    const rej = gens({ status: "rejected", rejection: { code: "junid", reason: "framing", at: NOW } });
    const api = fakeApi([], { list: vi.fn(async () => ({ items: [rej], tabCounts: {} })) });
    const tree = await render(api, "rejected");
    expect(useButtons(tree)).toHaveLength(2);
    const done = gens({ status: "done" });
    const tree2 = await render(fakeApi([], { list: vi.fn(async () => ({ items: [done], tabCounts: {} })) }), "done");
    expect(useButtons(tree2)).toHaveLength(0);
    expect(view.canPick({ status: "approved", currentGen: "g2", generations: { g1: { url: "u" } } }, { genId: "g1", url: "u" })).toBe(false);
    expect(view.canPick({ status: "ready", currentGen: "g2" }, { genId: "g1" })).toBe(false); // no url
  });

  it("the card total includes every generation and re-check, estimates marked ~", async () => {
    const tree = await render(fakeApi([gens()], { list: vi.fn(async () => ({ items: [gens()], tabCounts: {}, stats: { estimatePerGenerationZar: 2.5 } })) }));
    // 2.38 + 2.50 (estimated) + 0.19 re-check
    expect(text(tree)).toContain("3 generations · ~R5.07 total");
    expect(text(tree)).toContain("Generated · Main photo · ~R2.50 (estimated)");
  });
});

describe("costs — never unknown", () => {
  it("costText variants", () => {
    expect(view.costText({ costZar: 2.38 })).toBe("R2.38");
    expect(view.costText({ costZar: 2.41, costEstimated: true })).toBe("~R2.41 (estimated)");
    expect(view.costText({}, { estimatePerGenerationZar: 2.6 })).toBe("~R2.60 (estimated)");
    expect(view.costText({}, {})).toBe("~R2.41 (estimated)");
    expect(view.costText(null)).toBe("~R2.41 (estimated)");
    expect(view.costText({ costZar: null })).toBe("~R2.41 (estimated)");
    expect(view.costText({ costUsd: 0.1 }, { usdZar: 18.5 })).toBe("~R1.85 (estimated)");
    expect(view.costText({ costUsd: 0.1 })).toBe("~R2.41 (estimated)");
    expect(view.costText({ costZar: 0.19, derivedFrom: "g1" })).toBe("re-check, no new generation · R0.19");
    expect(view.costText({ costZar: 0.2, derivedFrom: "g1", costEstimated: true })).toBe("re-check, no new generation · ~R0.20 (estimated)");
    expect(view.costText({ derivedFrom: "g1" })).toBe("re-check, no new generation · ~R2.41 (estimated)");
    for (const g of [{}, null, { costUsd: "x" }, { costZar: "" }]) expect(view.costText(g)).not.toMatch(/unknown|\$/);
  });

  it("totals include re-checks and estimates", () => {
    const item = { generations: { a: { at: 1, costZar: 2.38 }, b: { at: 2, costZar: 0.19, derivedFrom: "a" } } };
    expect(view.totalCostText(item)).toBe("R2.57 total");
    expect(view.totalCostZar(item)).toBeCloseTo(2.57);
    item.generations.c = { at: 3 };
    expect(view.totalCostText(item)).toBe("~R4.98 total");
    expect(view.totalCostText(item, { estimatePerGenerationZar: 3 })).toBe("~R5.57 total");
    expect(view.totalCostText({})).toBeNull();
  });

  it("header spend line from stats", async () => {
    expect(view.spentText(null)).toBe("Spent so far —");
    expect(view.spentText({ totalSpentZar: 41.2, estimatedPartZar: 12.05 })).toBe("Spent so far R41.20 (incl. ~R12.05 estimated)");
    expect(view.spentText({ totalSpentZar: 9 })).toBe("Spent so far R9.00");
    const stats = { totalSpentZar: 41.2, estimatedPartZar: 12.05, rejectRate: { pct: 20, n: 25, byReason: {} }, costPerFinishedZar: 4.5 };
    const tree = await render(fakeApi([ready()], { list: vi.fn(async () => ({ items: [ready()], tabCounts: {}, stats })) }));
    const header = text({ toJSON: () => testid(tree, "agreement")[0].children });
    expect(header).toContain("Spent so far R41.20 (incl. ~R12.05 estimated)");
    expect(header).toContain("Rejected 20% of 25");
    expect(header).toContain("Agreement with you:");
    const tree2 = await render(fakeApi());
    expect(text({ toJSON: () => testid(tree2, "spent")[0].children })).toBe("Spent so far —");
  });
});

describe("learning log — codes under every generation, ❤ Love", () => {
  const coded = (over = {}) => ready({
    generatedUrl: "https://x/g2.jpg", currentGen: "g2",
    generations: {
      g1: GEN("g1", NOW - 2000, { code: "G-0041", loved: true, lovedAt: NOW - 100 }),
      g2: GEN("g2", NOW - 1000, { code: "G-0042" }),
      g3: GEN("g3", NOW, {}), // no code yet
    }, ...over,
  });
  const loves = (tree) => testid(tree, "love");
  const codes = (tree) => testid(tree, "gen-code").map((n) => text({ toJSON: () => n.children }));
  const listOf = (item) => vi.fn(async () => ({ items: [item], tabCounts: {} }));

  it("prints the code under the main photo and every thumbnail; no code → nothing (no placeholder)", async () => {
    for (const [tab, status] of [["ready", "ready"], ["rejected", "rejected"], ["done", "done"]]) {
      const tree = await render(fakeApi([], { love: vi.fn(), list: listOf(coded({ status })) }), tab);
      expect(codes(tree)).toEqual(["G-0042", "G-0041"]); // main first, then earlier (newest first: g3 has none)
      const t = text(tree);
      expect(t).not.toMatch(/unknown|G-\?|undefined/);
    }
    expect(view.genCode({ code: " G-0007 " })).toBe("G-0007");
    expect(view.genCode({})).toBeNull();
    expect(view.genCode({ code: "" })).toBeNull();
    expect(view.genCode(null)).toBeNull();
  });

  it("❤ on every generation in Ready, Rejected and Done; loved shows filled; taps call the api with loved true/false", async () => {
    const api = fakeApi([coded()], { love: vi.fn(async () => ({ ok: true })) });
    const tree = await render(api);
    expect(loves(tree)).toHaveLength(3);
    const byLabel = (l) => loves(tree).filter((n) => n.props["aria-label"] === l);
    expect(byLabel("Unlove")).toHaveLength(1); // g1
    expect(text({ toJSON: () => byLabel("Unlove")[0].children })).toBe("❤");
    expect(byLabel("Unlove")[0].props["aria-pressed"]).toBe(true);
    expect(byLabel("Love")).toHaveLength(2);
    // Main photo (g2) — love it.
    await act(async () => { byLabel("Love")[0].props.onClick(); });
    expect(api.love).toHaveBeenLastCalledWith("p1789999990000", "g2", true);
    expect(text(tree)).toContain("Loved — remembered for the learning log.");
    // The loved one (g1) — un-love it.
    await act(async () => { byLabel("Unlove")[0].props.onClick(); });
    expect(api.love).toHaveBeenLastCalledWith("p1789999990000", "g1", false);
    expect(api.approve).not.toHaveBeenCalled();
    expect(api.select).not.toHaveBeenCalled();

    for (const [tab, status] of [["rejected", "rejected"], ["done", "done"]]) {
      const t2 = await render(fakeApi([], { love: vi.fn(), list: listOf(coded({ status })) }), tab);
      expect(loves(t2)).toHaveLength(3);
    }
    expect(view.canLove("new", { url: "u" })).toBe(false);
    expect(view.canLove("ready", { url: null })).toBe(false);
    expect(view.isLoved({ loved: "true" })).toBe(false);
  });
});
