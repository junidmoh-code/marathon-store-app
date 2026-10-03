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
    expect(actionsFor(ready({ generatedUrl: undefined })).approve).toBe(false);
    // No stock price → no Approve; the status line says what to do.
    const noPrice = ready({ product: { name: "x", sizes: ["6"] } });
    expect(actionsFor(noPrice).approve).toBe(false);
    expect(statusLine(noPrice)).toBe("Photo checked — needs a stock price before approving");
    expect(actionsFor({ status: "rejected" })).toMatchObject({ approve: false, approveAnyway: false, regenerate: true, skip: true, reject: false });
    expect(actionsFor({ status: "new" })).toMatchObject({ approve: false, generate: true, skip: true, regenerate: false });
    expect(actionsFor({ status: "new", generateRequest: { at: 1 } }).generate).toBe(false);
    expect(actionsFor({ status: "skipped" })).toMatchObject({ restore: true, skip: false, generate: false });
  });

  it("the stock price gates Approve; the retail price is irrelevant", () => {
    const noRetail = ready({ product: { name: "x", stockPrice: 550, retailPrice: null, sizes: ["6"] } });
    expect(actionsFor(noRetail).approve).toBe(true);
    expect(statusLine(noRetail)).toBe("Photo checked — waiting for your Approve");
    const retailOnly = ready({ product: { name: "x", stockPrice: 0, retailPrice: 650, sizes: ["6"] } });
    expect(actionsFor(retailOnly).approve).toBe(false);
    expect(statusLine(retailOnly)).toMatch(/needs a stock price/);
    expect(actionsFor(ready({ product: { stockPrice: "550" } })).approve).toBe(true);
    expect(actionsFor(ready({ product: { stockPrice: -5 } })).approve).toBe(false);
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
const render = async (api, initialTab = "ready") => {
  let tree;
  await act(async () => { tree = TestRenderer.create(<NewArrivalsScreen api={api} onExit={() => {}} initialTab={initialTab} />); });
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
    expect(tree.root.findAll((n) => n.props && n.props["data-testid"] === "price-entry")).toHaveLength(0);
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

describe("Ready: a missing STOCK price is set on the card, through the Missing prices save", () => {
  const priced = () => ready();
  const unpriced = (o = {}) => ({ ...ready(), pid: "p1789999990001", product: { ...ready().product, stockPrice: null }, ...o });
  const testid = (tree, id) => tree.root.findAll((n) => n.props && n.props["data-testid"] === id);
  const inputs = (tree) => tree.root.findAll((n) => n.type === "input").map((i) => i.props["aria-label"]);

  it("an item without a stock price shows ONLY a Stock price input, no Approve, and the flag", async () => {
    const tree = await render(fakeApi([unpriced()], { savePrice: vi.fn() }));
    expect(testid(tree, "price-entry")).toHaveLength(1);
    expect(inputs(tree)).toEqual(["Stock price"]);
    expect(button(tree, "Approve")).toBeUndefined();
    expect(text(tree)).toContain("No stock price · Sizes 6 · 7");
    expect(text(tree)).not.toContain("R650"); // retail is never shown for the groups
    expect(text(tree)).toContain("needs a stock price before approving");
    expect(testid(tree, "unpriced-flag").filter((n) => n.type === "div")).toHaveLength(1);
    expect(text(tree)).toContain("1 item has no stock price — enter it on the card to approve.");
    expect(text(tree)).not.toContain("Approve all");
  });

  it("a missing retail price is not asked for — stock price set → Approve, no price entry", async () => {
    const noRetail = ready({ product: { ...ready().product, retailPrice: null } });
    const tree = await render(fakeApi([noRetail], { savePrice: vi.fn() }));
    expect(testid(tree, "price-entry")).toHaveLength(0);
    expect(inputs(tree)).toEqual([]);
    expect(button(tree, "Approve")).toBeTruthy();
    expect(testid(tree, "unpriced-flag")).toHaveLength(0);
  });

  it("Approve all excludes the unpriced item; the flag counts it", async () => {
    const api = fakeApi([priced(), unpriced(), unpriced({ pid: "p1789999990002" })], { savePrice: vi.fn() });
    const tree = await render(api);
    expect(testid(tree, "price-entry")).toHaveLength(2);
    expect(tree.root.findAll((n) => n.type === "button" && label(n) === "Approve")).toHaveLength(1);
    expect(text(tree)).toContain("2 items have no stock price — enter it on the card to approve.");
    globalThis.window = { confirm: vi.fn(() => true) };
    await act(async () => { button(tree, "Approve all 1").props.onClick(); });
    expect(api.approve).toHaveBeenCalledWith(["p1789999990000"]);
    delete globalThis.window;
  });

  it("Save price calls api.savePrice(pid, product, cost) — stock price only — then reloads", async () => {
    const savePrice = vi.fn(async () => ({ ok: true, count: 1 }));
    const api = fakeApi([unpriced()], { savePrice });
    const tree = await render(api);
    const [cost] = tree.root.findAll((n) => n.type === "input" && n.props["aria-label"] === "Stock price");
    await act(async () => { cost.props.onChange({ target: { value: "400" } }); });
    await act(async () => { button(tree, "Save price").props.onClick(); });
    expect(savePrice).toHaveBeenCalledTimes(1);
    expect(savePrice.mock.calls[0]).toEqual(["p1789999990001", expect.objectContaining({ stockPrice: null }), "400"]);
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(text(tree)).toContain("Stock price saved — Approve is now open.");
  });

  it("retail below the new cost: asks, and retries with { confirmed: true }", async () => {
    const savePrice = vi.fn()
      .mockResolvedValueOnce({ ok: false, needsConfirm: true, error: "Retail is below cost. Save anyway?" })
      .mockResolvedValueOnce({ ok: true, count: 1 });
    const api = fakeApi([unpriced()], { savePrice });
    const tree = await render(api);
    const [cost] = tree.root.findAll((n) => n.type === "input" && n.props["aria-label"] === "Stock price");
    await act(async () => { cost.props.onChange({ target: { value: "700" } }); });
    const confirm = vi.fn(() => true);
    globalThis.window = { confirm };
    await act(async () => { button(tree, "Save price").props.onClick(); });
    delete globalThis.window;
    expect(confirm).toHaveBeenCalledWith("Retail is below cost. Save anyway?");
    expect(savePrice.mock.calls[1]).toEqual(["p1789999990001", expect.any(Object), "700", { confirmed: true }]);
    expect(text(tree)).toContain("Stock price saved");
  });

  it("a refused save says why and changes nothing", async () => {
    const api = fakeApi([unpriced()], { savePrice: vi.fn(async () => ({ ok: false, error: "Enter a valid Stock Price greater than 0." })) });
    const tree = await render(api);
    await act(async () => { button(tree, "Save price").props.onClick(); });
    expect(text(tree)).toContain("Price not saved: Enter a valid Stock Price");
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
// A paged fake server over `all`: 30 a page, cursor = last pid, filter echoed.
const pagedApi = (all, over = {}) => fakeApi([], {
  list: vi.fn(async (tab, { cursor = null, limit = 30, filter = null } = {}) => {
    const pool = filter?.oneSize ? all.filter((i) => i.availableSizes.length === 1) : all;
    const from = cursor ? pool.findIndex((i) => i.pid === cursor) + 1 : 0;
    const page = pool.slice(from, from + limit);
    const more = from + limit < pool.length;
    return { tab, items: page, total: pool.length, nextCursor: more ? page[page.length - 1].pid : null,
      tabCounts: { new: all.length }, stats: null, modes: {}, matchingPids: pool.map((i) => i.pid) };
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
    expect(api.list).toHaveBeenCalledWith("new", { cursor: null, limit: 30, filter: null });
    await act(async () => { button(tree, "Load more (30 of 75 loaded)").props.onClick(); });
    expect(api.list).toHaveBeenLastCalledWith("new", { cursor: P(29), limit: 30, filter: null });
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
    expect(api.list).toHaveBeenLastCalledWith("new", { cursor: null, limit: 45, filter: null });
    expect(text(tree)).toContain("Showing 45 of 45");
  });
});

describe("New tab: filters, multi-select, Generate, Skip", () => {
  it("'1 size only' sends the filter; Select all picks every match across pages; Skip selected sends them all", async () => {
    const all = Array.from({ length: 40 }, (_, i) => newItem(i, { availableSizes: i % 2 ? ["7", "8"] : ["7"] }));
    const api = pagedApi(all);
    const tree = await render(api, "new");
    await act(async () => { button(tree, "1 size only").props.onClick(); });
    expect(api.list).toHaveBeenLastCalledWith("new", { cursor: null, limit: 30, filter: { oneSize: true } });
    expect(text(tree)).toContain("Showing 20 of 20");
    await act(async () => { button(tree, "Select all 20").props.onClick(); });
    await act(async () => { button(tree, "Skip selected (20)").props.onClick(); });
    expect(api.skip).toHaveBeenCalledTimes(1);
    expect(api.skip.mock.calls[0][0]).toHaveLength(20);
    expect(api.skip.mock.calls[0][0].every((p) => Number(p.slice(-5)) % 2 === 0)).toBe(true);
    expect(text(tree)).toContain("20 skipped");
  });

  it("category chips are exclusive; no stock price combines", async () => {
    const api = pagedApi([newItem(0)]);
    const tree = await render(api, "new");
    await act(async () => { button(tree, "Slides").props.onClick(); });
    await act(async () => { button(tree, "Two-piece").props.onClick(); });
    await act(async () => { button(tree, "No stock price").props.onClick(); });
    expect(api.list).toHaveBeenLastCalledWith("new", { cursor: null, limit: 30, filter: { cls: "twopiece", noStockPrice: true } });
    expect(view.toggleFilter({ cls: "sneakers" }, "sneakers")).toEqual({});
    expect(view.FILTER_CHIPS.map((c) => c.label)).toEqual(["1 size only", "Sneakers", "Slides", "Clothing", "Two-piece", "No stock price"]);
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
    expect(t).toContain("Generated · R0.75");
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
    await act(async () => { button(tree, "Approve anyway").props.onClick(); });
    expect(api.approve).toHaveBeenCalledWith(["p1789999990000"], { anyway: true });
  });

  it("Done shows every generation too", async () => {
    const done = withGens({ status: "done" });
    const api = fakeApi([], { list: vi.fn(async () => ({ items: [done], tabCounts: {} })) });
    const tree = await render(api, "done");
    expect(tree.root.findAll((n) => n.type === "img")).toHaveLength(3);
  });
});

describe("Skipped tab", () => {
  it("lists skipped items with Restore to New; Select all + Restore selected", async () => {
    const sk = [0, 1, 2].map((i) => newItem(i, { status: "skipped", skippedAt: NOW }));
    const api = pagedApi(sk);
    const tree = await render(api, "skipped");
    expect(text(tree)).toContain("Skipped — not advertised");
    expect(text(tree)).toContain("Showing 3 of 3");
    await act(async () => { tree.root.findAll((n) => n.type === "button" && label(n) === "Restore to New")[0].props.onClick(); });
    expect(api.restore).toHaveBeenCalledWith([P(0)]);
    await act(async () => { button(tree, "Select all 3").props.onClick(); });
    await act(async () => { button(tree, "Restore selected (3)").props.onClick(); });
    expect(api.restore).toHaveBeenLastCalledWith([P(0), P(1), P(2)]);
    expect(tree.root.findAll((n) => n.props?.role === "tab").map((t) => label(t).trim())).toContain("Skipped");
  });
});

describe("header agreement %", () => {
  it("per class from stats; absent → —; auto mode marked", async () => {
    const stats = { agreement: { footwear: { pct: 83.4, n: 30, window: 30 }, single: { pct: null, n: 2 } } };
    const api = fakeApi([ready()], { list: vi.fn(async () => ({ items: [ready()], tabCounts: {}, stats, modes: { footwear: "auto" } })) });
    const tree = await render(api);
    expect(testid(tree, "agreement").map((n) => text({ toJSON: () => n.children }))[0])
      .toBe("Agreement with you: Footwear 83% (auto) · Clothing — · Two-piece —");
    expect(view.agreementText(null, "footwear")).toBe("—");
  });
});

describe("view helpers for calibration", () => {
  it("generationsOf sorts newest first; costs and verdicts", () => {
    const item = { generations: { g1: GEN("g1", 1), g3: GEN("g3", 3), g2: GEN("g2", 2) } };
    expect(view.generationsOf(item).map((g) => g.genId)).toEqual(["g3", "g2", "g1"]);
    expect(view.generationsOf({})).toEqual([]);
    expect(view.costText({ costUsd: 0.04 })).toBe("$0.04");
    expect(view.costText({})).toBe("cost unknown");
    expect(view.verdictText({ pass: true })).toBe("Checker: pass");
    expect(view.verdictText({ pass: false, failed: ["framing", "quality"] })).toBe("Checker: failed — framing, quality");
    expect(view.verdictText(null)).toBeNull();
    expect(view.stockText({ stockKnown: true, availableSizes: ["8"], totalUnits: 1 })).toBe("In stock: 8 — 1 unit");
    expect(view.REJECT_CHIPS).toHaveLength(7);
  });
});
