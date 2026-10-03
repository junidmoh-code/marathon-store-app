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
    expect(actionsFor({ status: "rejected" })).toEqual({ approve: false, retry: true });
    expect(actionsFor({ status: "new" })).toEqual({ approve: false, retry: false });
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

  it("rejection text says whether a fresh attempt is coming or it stays", () => {
    const r = { status: "rejected", rejection: { code: "checker", reason: "The box print changed" } };
    expect(rejectionText({ ...r, attemptsSinceRetry: 1 })).toMatch(/fresh attempt runs automatically \(1 of 3/);
    expect(rejectionText({ ...r, attemptsSinceRetry: MAX_ATTEMPTS })).toMatch(/stays here until you tap Retry/);
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

  it("Rejected offers Retry and no Approve", async () => {
    const rej = { pid: "p1789999990001", status: "rejected", rejection: { code: "source", reason: "retake photo" }, product: {} };
    const api = fakeApi([], { list: vi.fn(async () => ({ items: [rej], tabCounts: {} })) });
    const tree = await render(api, "rejected");
    expect(text(tree)).toContain("retake photo");
    expect(button(tree, "Retry — fresh generation")).toBeTruthy();
    await act(async () => { button(tree, "Retry — fresh generation").props.onClick(); });
    expect(api.retry).toHaveBeenCalledWith("p1789999990001");
    expect(button(tree, "Approve")).toBeUndefined();
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
