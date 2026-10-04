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
  // A checked photo on a ready card passed the checker.
  verdict: { pass: true, failed: [], label: "✓ passed" },
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
    expect(statusLine(ready())).toBe("Photo ready — approve");
    // A failed generation is not retried: the card says so and waits for a tap.
    const failedNew = { status: "new", lastAttempt: { failed: true, reason: "the photo service was busy — tap Generate again" } };
    expect(statusLine(failedNew)).toBe("Last photo failed: the photo service was busy — tap Generate again");
    expect(statusLine({ ...failedNew, generateRequest: 5 })).toBe("Generating…");
    expect(statusLine({ status: "generating" })).toBe("Generating…");
    expect(statusLine({ status: "new" })).toBe("Waiting — tap Generate when you want its photo");
    expect(actionsFor(ready()).approveEnabled).toBe(true);
    expect(actionsFor(ready({ generatedUrl: undefined })).approve).toBe(false);
    expect(actionsFor(ready({ generatedUrl: undefined })).approveEnabled).toBe(false);
    // No stock price → Approve still SHOWN, but disabled, with why.
    const noPrice = ready({ product: { name: "x", sizes: ["6"] } });
    expect(actionsFor(noPrice).approve).toBe(true);
    expect(actionsFor(noPrice).approveEnabled).toBe(false);
    expect(actionsFor(noPrice).approveWhy).toBe("add stock price first");
    expect(statusLine(noPrice)).toBe("Photo ready — approve");
    // By PHOTO PRESENCE, never by lane: a rejected item without a photo offers Generate (regenerate flag).
    expect(actionsFor({ status: "rejected" })).toMatchObject({ approve: false, generate: true, generateRegenerate: true, regenerate: false, skip: true, reject: false });
    expect(actionsFor(ready({ status: "rejected" }))).toMatchObject({ approve: true, approveEnabled: true, regenerate: true, reject: true, skip: true });
    expect(actionsFor(ready({ status: "new" }))).toMatchObject({ approve: true, approveEnabled: true, regenerate: true, generate: false });
    expect(actionsFor({ status: "new" })).toMatchObject({ approve: false, generate: true, generateRegenerate: false, skip: true, regenerate: false });
    expect(actionsFor({ status: "new", generateRequest: { at: Date.now() } }).generate).toBe(false);
    expect(actionsFor({ status: "skipped" })).toMatchObject({ approve: false, skip: false, generate: false, regenerate: false });
    expect("restore" in actionsFor({ status: "skipped" })).toBe(false); // no Skipped tab: Undo is the toast
  });

  it("the stock price gates Approve; the retail price is irrelevant", () => {
    const noRetail = ready({ product: { name: "x", stockPrice: 550, retailPrice: null, sizes: ["6"] } });
    expect(actionsFor(noRetail).approveEnabled).toBe(true);
    expect(actionsFor(noRetail).approveWhy).toBeNull();
    const retailOnly = ready({ product: { name: "x", stockPrice: 0, retailPrice: 650, sizes: ["6"] } });
    expect(actionsFor(retailOnly).approveEnabled).toBe(false);
    expect(actionsFor(retailOnly).approveWhy).toBe("add stock price first");
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
  list: vi.fn(async (tab) => ({ tab, items: tab === "new" ? items : [], tabCounts: { new: items.length, done: 5 } })),
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
const render = async (api, initialTab = "new", storage = memStorage()) => {
  let tree;
  await act(async () => { tree = TestRenderer.create(<NewArrivalsScreen api={api} onExit={() => {}} initialTab={initialTab} storage={storage} />); });
  return tree;
};
// Exact label match: "Approve" must not find "Approve all 1".
const label = (n) => [].concat(n.props.children).filter((c) => typeof c === "string" || typeof c === "number").join("");
const button = (tree, l) => tree.root.findAll((n) => n.type === "button").find((b) => label(b) === l);

describe("status for an approved item still being named (CodeRabbit)", () => {
  it("says the Shopify name is being made — before the generic approved line", () => {
    expect(statusLine({ status: "approved", naming: { status: "pending" } })).toBe("Approved — the Shopify name is being made");
    expect(statusLine({ status: "approved", naming: { status: "done" } })).toBe("Approved — publishing will start in a minute");
    expect(statusLine({ status: "chaining", chain: { stuck: { step: "shopify", reason: "duplicate name" } } })).toBe('Approved — waiting at "shopify": duplicate name');
  });
});

describe("NewArrivalsScreen", () => {

  it("a load failure is shown in words", async () => {
    const api = fakeApi([], { list: vi.fn(async () => { throw new Error("permission-denied"); }) });
    const tree = await render(api);
    expect(text(tree)).toContain("Couldn't load: permission-denied");
  });

});

// EVERYTHING IS MANUAL (4 Oct): none of these lines may ever render on the card or header.
// ("agreement" is only the header's wrapper testid now — its text is checked below.)
const NO_CHECKER_LINES = ["verdict", "rejection", "reject-rate"];
const expectNoCheckerLines = (tree) => {
  for (const id of NO_CHECKER_LINES) expect(testid(tree, id)).toHaveLength(0);
  expect(text(tree)).not.toMatch(/Agreement with you|Rejected \d+%|Checker:/);
};

describe("PRICES: Stock price (R) + Retail price (R), pre-filled, one Save — the admin price save", () => {
  const priced = () => ready();
  const unpriced = (o = {}) => ({ ...ready(), pid: "p1789999990001", product: { ...ready().product, stockPrice: null }, ...o });
  const testid = (tree, id) => tree.root.findAll((n) => n.props && n.props["data-testid"] === id && typeof n.type === "string");
  const field = (tree, l) => tree.root.findAll((n) => n.type === "input" && n.props["aria-label"] === l)[0];
  const type = async (tree, l, v) => act(async () => { field(tree, l).props.onChange({ target: { value: v } }); });

  it("both fields on every card with a photo, pre-filled with the current prices", async () => {
    const tree = await render(fakeApi([priced()], { savePrices: vi.fn() }));
    expect(field(tree, "Stock price (R)").props.value).toBe("550");
    expect(field(tree, "Retail price (R)").props.value).toBe("650");
    expect(text(tree)).toContain("Stock price posts to the WhatsApp groups");
    // Nothing changed yet: Save is off.
    expect(button(tree, "Save").props.disabled).toBe(true);
  });

  it("a priced item: Approve enabled, no note", async () => {
    const tree = await render(fakeApi([priced()], { savePrices: vi.fn() }));
    expect(button(tree, "Approve").props.disabled).toBe(false);
    expect(testid(tree, "approve-note")).toHaveLength(0);
  });

  it("only the field changed is sent", async () => {
    const savePrices = vi.fn(async () => ({ ok: true, count: 1 }));
    const tree = await render(fakeApi([unpriced()], { savePrices }));
    await type(tree, "Stock price (R)", "400");
    await act(async () => { button(tree, "Save").props.onClick(); });
    expect(savePrices.mock.calls[0][2]).toEqual({ stockPrice: "400" });
  });

  it("every New card carries the fields (no photo yet, rejected too); Done does not", async () => {
    const rej = { ...priced(), status: "rejected", rejection: { code: "junid", reason: "framing" } };
    let tree = await render(pagedApi([newItem(0)], { savePrices: vi.fn() }), "new");
    expect(testid(tree, "price-fields")).toHaveLength(1);
    tree = await render(fakeApi([], { savePrices: vi.fn(), list: vi.fn(async () => ({ items: [rej], tabCounts: {} })) }), "new");
    expect(testid(tree, "price-fields")).toHaveLength(1);
    tree = await render(fakeApi([], { savePrices: vi.fn(), list: vi.fn(async () => ({ items: [{ ...priced(), status: "done" }], tabCounts: {} })) }), "done");
    expect(testid(tree, "price-fields")).toHaveLength(0);
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


describe("New tab: the group switcher, multi-select, Generate, Skip", () => {
  const mixed = () => [0, 1, 2, 3, 4].map((i) => newItem(i, { grp: i % 2 ? "clothing" : "sneakers" }));
  const sw = (tree) => testid(tree, "group-switcher")[0];
  const swName = (tree) => text({ toJSON: () => testid(tree, "group-name")[0].children });
  const arrow = (tree, l) => tree.root.findAll((n) => n.type === "button" && n.props["aria-label"] === l)[0];

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

});

const GEN = (id, at, over = {}) => ({ url: `https://x/${id}.jpg`, at, model: "m", promptVersion: "v3", plate: "footwear-plate.png", kind: "footwear",
  costUsd: 0.04, costZar: 0.75, verdict: { pass: true, failed: [] }, reason: "requested", ...over });

describe("ONE card on New: every generation, chips, ONE Approve (no checker lines)", () => {
  const withGens = (over = {}) => ready({
    generatedUrl: "https://x/g2.jpg", currentGen: "g2",
    generations: { g1: GEN("g1", NOW - 1000, { costZar: 0.5, verdict: { pass: false, failed: ["fidelity:colour"], label: "colour off" } }), g2: GEN("g2", NOW) },
    verdict: { pass: false, failed: ["background"], label: "background" }, ...over,
  });

  it("no stock price: the ONE Approve is SHOWN but disabled, with 'add stock price first'", async () => {
    const rej = withGens({ status: "rejected", rejection: { code: "generation", reason: "x", at: NOW } });
    rej.product = { ...rej.product, stockPrice: null };
    const api = fakeApi([rej], { savePrices: vi.fn() });
    const tree = await render(api, "new");
    const approves = tree.root.findAll((n) => n.type === "button" && label(n) === "Approve");
    expect(approves).toHaveLength(1);
    expect(approves[0].props.disabled).toBe(true);
    // The reason is in words on the card (a phone shows no tooltip).
    expect(tree.root.findAll((n) => n.props && n.props["data-testid"] === "approve-note" && typeof n.type === "string")).toHaveLength(1);
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
    expect(tree.root.findAll((n) => n.props?.role === "tab").map((t) => label(t).replace(/[\d\s]+$/, ""))).toEqual(["New", "Done"]);
    expect(view.TABS.map((t) => t.key)).not.toContain("skipped");
    expect(view.UNDO_MS).toBe(8000);
  });

});

describe("header: spend line only", () => {
  it("no agreement %, no reject rate — even when stats carry them; auto mode is not marked", async () => {
    const stats = { agreement: { footwear: { pct: 83.4, n: 30, window: 30 } }, rejectRate: { pct: 20, n: 25, byReason: {} }, totalSpentZar: 5 };
    const api = fakeApi([ready()], { list: vi.fn(async () => ({ items: [ready()], tabCounts: {}, stats, modes: { footwear: "auto" } })) });
    const tree = await render(api);
    expectNoCheckerLines(tree);
    expect(text(tree)).not.toMatch(/Agreement with you|Rejected \d+%|\(auto\)/);
    expect(text({ toJSON: () => testid(tree, "spent")[0].children })).toBe("Spent so far R5.00");
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
    expect(view.costText({ costZar: 0.21, derivedFrom: "g1" })).toBe("adjusted copy · R0.21");
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
    expect(view.costText({ costZar: 0.19, derivedFrom: "g1" })).toBe("adjusted copy · R0.19");
    expect(view.costText({ costZar: 0.2, derivedFrom: "g1", costEstimated: true })).toBe("adjusted copy · ~R0.20 (estimated)");
    expect(view.costText({ derivedFrom: "g1" })).toBe("adjusted copy · ~R2.41 (estimated)");
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
    const header = text({ toJSON: () => testid(tree, "spent")[0].children });
    expect(header).toBe("Spent so far R41.20 (incl. ~R12.05 estimated)");
    expect(text(tree)).not.toContain("Rejected 20% of 25");
    expect(text(tree)).not.toContain("Agreement with you");
    expectNoCheckerLines(tree);
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

});

describe("ONE PLACE TO GENERATE AND APPROVE (3 Oct night)", () => {
  const gens = (over = {}) => ready({
    generatedUrl: "https://x/g2.jpg", currentGen: "g2",
    generations: {
      g1: GEN("g1", NOW - 2000, { code: "G-0001", verdict: { pass: false, failed: ["fidelity:colour"], label: "colour off" } }),
      g2: GEN("g2", NOW - 1000, { code: "G-0002" }),
    }, ...over,
  });
  const btns = (tree, l) => tree.root.findAll((n) => n.type === "button" && label(n) === l);

  it("tabs are New and Done; old 'ready'/'rejected' links open New", () => {
    expect(view.TABS.map((t) => t.key)).toEqual(["new", "done"]);
    expect(view.normalizeTab("ready")).toBe("new");
    expect(view.normalizeTab("rejected")).toBe("new");
    expect(view.normalizeTab("done")).toBe("done");
    expect(view.normalizeTab(undefined)).toBe("new");
    expect(view.GROUP_TABS).toEqual(["new"]);
  });

  it("disabled without a stock price, with 'add stock price first' (any lane with a photo)", async () => {
    for (const status of ["new", "ready", "rejected"]) {
      const it0 = gens({ status, product: { name: "x", stockPrice: null, sizes: ["6"] } });
      const tree = await render(fakeApi([it0], { savePrices: vi.fn() }), "new");
      const [a] = btns(tree, "Approve");
      expect(a.props.disabled).toBe(true);
      expect(tree.root.findAll((n) => n.props && n.props["data-testid"] === "approve-note" && typeof n.type === "string").length).toBeGreaterThan(0);
      expect(testid(tree, "approve-note")).toHaveLength(1);
    }
  });

  it("the verdict is a label only — a failed verdict never hides Approve; buckets by photo presence", () => {
    const failed = gens({ status: "ready", verdict: { pass: false, failed: ["framing"] } });
    expect(view.actionsFor(failed).approveEnabled).toBe(true);
    expect(view.photoBucket(failed)).toBe("photo");
    expect(view.photoBucket({ status: "new", generateRequest: { at: Date.now() }, generatedUrl: "u" })).toBe("generating");
    expect(view.photoBucket({ status: "generating" })).toBe("generating");
    expect(view.photoBucket({ status: "rejected" })).toBe("none");
    expect(view.photoBucket({ status: "new" })).toBe("none");
  });

});

describe("How Gemini did it + the per-item method (3 Oct)", () => {
  const THOUGHTS = "First I isolated the shoe.\n\n  Then I kept the laces exactly.";
  const HOW = { code: "G-0042", method: "split", thoughts: THOUGHTS, thoughtsLabel: "Gemini's own account — not proof",
    drafts: [{ url: "https://x/d1.jpg" }, { url: "https://x/d2.jpg" }], model: "gemini-3-pro-image" };
  const coded = (over = {}) => ready({
    status: "ready", generatedUrl: "https://x/g2.jpg", currentGen: "g2",
    generations: {
      g1: GEN("g1", NOW - 2000, { code: "G-0041" }), // older: nothing recorded
      g2: GEN("g2", NOW - 1000, { code: "G-0042", how: { code: "G-0042", draftCount: 2 }, method: "split" }),
      g3: GEN("g3", NOW, {}), // no code → no toggle
    }, ...over,
  });
  const howApi = (item = coded(), over = {}) => fakeApi([item], {
    how: vi.fn(async (pid, genId) => (genId === "g2" ? HOW : { code: "G-0041", none: true })),
    method: vi.fn(async (pid, method) => ({ ok: true, method })), ...over,
  });
  const toggles = (tree) => testid(tree, "how-toggle");

  it("a toggle under every coded generation (main and thumbnails); nothing loads until opened", async () => {
    const api = howApi();
    const tree = await render(api);
    expect(toggles(tree)).toHaveLength(2); // g2 (main), g1 — g3 has no code
    expect(api.how).not.toHaveBeenCalled();
    expect(testid(tree, "how-panel")).toHaveLength(0);
  });

  it("opening loads ONCE per generation; the label is prominent, the thoughts verbatim (pre-wrap, scrollable), drafts link to full size", async () => {
    const api = howApi();
    const tree = await render(api);
    await act(async () => { toggles(tree)[0].props.onClick(); });
    expect(api.how).toHaveBeenCalledTimes(1);
    expect(api.how).toHaveBeenCalledWith("p1789999990000", "g2");
    expect(text({ toJSON: () => testid(tree, "how-label")[0].children })).toBe("Gemini's own account — not proof");
    const th = testid(tree, "how-thoughts")[0];
    expect(th.props.children).toBe(THOUGHTS);
    expect(th.props.style).toMatchObject({ whiteSpace: "pre-wrap", overflowY: "auto" });
    expect(th.props.style.maxHeight).toBeGreaterThan(0);
    const links = testid(tree, "how-drafts")[0].findAll((n) => n.type === "a").map((a) => a.props.href);
    expect(links).toEqual(["https://x/d1.jpg", "https://x/d2.jpg"]);
    const imgs = testid(tree, "how-drafts")[0].findAll((n) => n.type === "img").map((a) => a.props.src);
    expect(imgs).toEqual(["https://x/d1.jpg", "https://x/d2.jpg"]);
    // Close and reopen: no second call (cached per generation); a 30s refresh keeps it too.
    await act(async () => { toggles(tree)[0].props.onClick(); });
    expect(testid(tree, "how-panel")).toHaveLength(0);
    await act(async () => { toggles(tree)[0].props.onClick(); });
    expect(api.how).toHaveBeenCalledTimes(1);
    expect(testid(tree, "how-thoughts")).toHaveLength(1);
  });

  it("an older generation says 'Nothing was recorded for this photo.'", async () => {
    const api = howApi();
    const tree = await render(api);
    await act(async () => { toggles(tree)[1].props.onClick(); });
    expect(api.how).toHaveBeenCalledWith("p1789999990000", "g1");
    expect(text({ toJSON: () => testid(tree, "how-none")[0].children })).toBe("Nothing was recorded for this photo.");
    expect(testid(tree, "how-label")).toHaveLength(0);
  });

  it("a failed load says so and is retried on reopen", async () => {
    let n = 0;
    const api = howApi(coded(), { how: vi.fn(async () => { n += 1; if (n === 1) throw new Error("offline"); return HOW; }) });
    const tree = await render(api);
    await act(async () => { toggles(tree)[0].props.onClick(); });
    expect(text(tree)).toContain("Couldn't load: offline");
    await act(async () => { toggles(tree)[0].props.onClick(); });
    await act(async () => { toggles(tree)[0].props.onClick(); });
    expect(api.how).toHaveBeenCalledTimes(2);
    expect(testid(tree, "how-thoughts")).toHaveLength(1);
  });

});
