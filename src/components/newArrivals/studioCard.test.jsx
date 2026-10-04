// The photo studio card: Generate is live on the card, and every other tap
// changes the screen AT ONCE — the write runs behind it, and a failed write
// puts the card back and says why. No tap reloads the list.
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import NewArrivalsScreen from "./NewArrivalsScreen";
import * as view from "./newArrivalsView";
import { REJECT_CHIPS } from "./newArrivalsView";
import { AMBER, RED } from "../stock/ui";
import { streamCallable, sseSplit } from "./studioStream";

const P = (i) => `p17899999${String(i).padStart(5, "0")}`;
const GEN = (id, at, over = {}) => ({ url: `https://x/${id}.jpg`, path: `p/${id}.jpg`, at, code: `G-00${at}`, costZar: 2.5, method: "full", ...over });
const bare = (i, over = {}) => ({
  pid: P(i), status: "new", enqueuedAt: i, name: `Item ${i}`, originalUrl: `https://x/o${i}.jpg`,
  product: { name: `Item ${i}`, stockPrice: 300, retailPrice: 400, sizes: ["7", "8"] }, ...over,
});
const withPhoto = (i, over = {}) => bare(i, {
  status: "ready", currentGen: "g2", generatedUrl: "https://x/g2.jpg",
  generations: { g1: GEN("g1", 1), g2: GEN("g2", 2) }, ...over,
});

// A promise the test settles by hand: the write is "still running" until then.
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

const fakeApi = (items, over = {}) => ({
  list: vi.fn(async (tab) => ({ tab, items: tab === "new" ? items : [], total: items.length, tabCounts: { new: items.length, done: 5 }, groupCounts: { sneakers: items.length, clothing: 4 }, defaultMethod: "full" })),
  approve: vi.fn(async (pids) => ({ approved: pids, skipped: [] })),
  skip: vi.fn(async (pids) => ({ skippedPids: pids, skipped: [] })),
  restore: vi.fn(async (pids) => ({ restored: pids, skipped: [] })),
  select: vi.fn(async () => ({ ok: true })),
  love: vi.fn(async () => ({ ok: true })),
  method: vi.fn(async () => ({ ok: true })),
  reject: vi.fn(async () => ({ ok: true })),
  how: vi.fn(async () => ({ none: true })),
  savePrices: vi.fn(async () => ({ ok: true, count: 1 })),
  generate: vi.fn(async (pid) => ({ ok: true, pid, seconds: 42, costZar: 2.75, item: {} })),
  ...over,
});
const render = async (api, tab = "new") => {
  let tree;
  await act(async () => { tree = TestRenderer.create(<NewArrivalsScreen api={api} onExit={() => {}} initialTab={tab} storage={null} />); });
  return tree;
};
const text = (tree) => {
  const walk = (n) => (n == null || n === false ? "" : Array.isArray(n) ? n.map(walk).join("") : typeof n === "object" ? walk(n.children) : String(n));
  return walk(tree.toJSON());
};
const label = (n) => [].concat(n.props.children).filter((c) => typeof c === "string" || typeof c === "number").join("");
const card = (tree, pid) => tree.root.findAll((n) => n.props && n.props["data-pid"] === pid && typeof n.type === "string")[0];
const cards = (tree) => tree.root.findAll((n) => n.props && n.props["data-pid"] && typeof n.type === "string").map((n) => n.props["data-pid"]);
const btn = (node, l) => node.findAll((n) => n.type === "button").find((b) => label(b) === l);
const byId = (node, id) => node.findAll((n) => n.props && n.props["data-testid"] === id && typeof n.type === "string");
const tap = async (b) => { await act(async () => { b.props.onClick(); }); };
const settle = async (fn) => { await act(async () => { fn(); await Promise.resolve(); await Promise.resolve(); }); };
const tabLabels = (tree) => tree.root.findAll((n) => n.props && n.props.role === "tab").map((n) => [].concat(n.props.children).join(""));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("the card: clean, one screen", () => {
  it("tabs New and Done only; the switcher pill reads 'Sneakers · N'; original beside the current photo; no bulk bar", async () => {
    const tree = await render(fakeApi([withPhoto(1), bare(2)]));
    expect(tabLabels(tree)).toEqual(["New 2", "Done 5"]);
    expect(label(byId(tree.root, "group-name")[0])).toBe("Sneakers · 2");
    const c = card(tree, P(1));
    expect(c.findAll((n) => n.type === "img").map((i) => i.props.src).slice(0, 2)).toEqual(["https://x/o1.jpg", "https://x/g2.jpg"]);
    expect(text(tree)).not.toMatch(/Approve all|Select all|Generate selected/);
    expect(tree.root.findAll((n) => n.type === "input" && n.props.type === "checkbox")).toHaveLength(0);
    // Generate / Regenerate, Approve, Skip — in that order.
    expect(byId(c, "actions")[0].findAll((n) => n.type === "button").map(label)).toEqual(["Regenerate", "Approve", "Skip"]);
    expect(byId(card(tree, P(2)), "actions")[0].findAll((n) => n.type === "button").map(label)).toEqual(["Generate", "Skip"]);
  });

  it("no checker text and nothing red or yellow — even when the data still carries a verdict, a rejection or a failed attempt", async () => {
    const tree = await render(fakeApi([
      withPhoto(1, { status: "rejected", verdict: { pass: false, failed: ["framing"], label: "✗ framing off" }, rejection: { code: "checker", reason: "background ≠ plate" }, framingFlag: true }),
      bare(2, { lastAttempt: { failed: true, reason: "the photo service is busy — tap Generate again" }, product: { name: "x" } }),
    ]));
    const t = text(tree);
    expect(t).not.toMatch(/checker|framing off|background ≠ plate|verdict|Rejected/i);
    const colours = tree.root.findAll((n) => typeof n.type === "string" && n.props.style).flatMap((n) => [n.props.style.color, n.props.style.borderColor]);
    expect(colours).not.toContain(AMBER);
    expect(colours).not.toContain(RED);
    // A failed attempt is still said, in plain grey words.
    expect(t).toContain("Last photo failed: the photo service is busy — tap Generate again");
  });

  it("Approve is shown on every item with a photo; with no stock price it is disabled, with 'add stock price first'", async () => {
    const tree = await render(fakeApi([withPhoto(1, { product: { name: "x", sizes: ["7"] } })]));
    const c = card(tree, P(1));
    expect(btn(c, "Approve").props.disabled).toBe(true);
    expect(label(byId(c, "approve-note")[0])).toBe("add stock price first");
  });

  it("every earlier generation in the strip has its G-code, ❤, Use this one and How Gemini did it", async () => {
    const tree = await render(fakeApi([withPhoto(1)]));
    const strip = byId(card(tree, P(1)), "earlier-generations")[0];
    expect(byId(strip, "gen-code").map(label)).toEqual(["G-001"]);
    expect(byId(strip, "love")).toHaveLength(1);
    expect(btn(strip, "Use this one")).toBeTruthy();
    expect(btn(strip, "How Gemini did it")).toBeTruthy();
    // The current photo carries its own code and ❤ too.
    expect(byId(byId(card(tree, P(1)), "main-meta")[0], "gen-code").map(label)).toEqual(["G-002"]);
  });

  it("Done shows the history: no price fields, no actions, ❤ still there", async () => {
    const done = withPhoto(1, { status: "done", approvedAt: 5, destinations: { shopify: { at: 5, title: "T" } } });
    const tree = await render(fakeApi([], { list: vi.fn(async (tab) => ({ tab, items: tab === "done" ? [done] : [], tabCounts: { new: 0, done: 1 } })) }), "done");
    const c = card(tree, P(1));
    expect(byId(c, "price-fields")).toHaveLength(0);
    expect(byId(c, "actions")).toHaveLength(0);
    expect(byId(tree.root, "group-switcher")).toHaveLength(0);
    expect(byId(c, "love").length).toBeGreaterThan(0);
    expect(btn(c, "Use this one")).toBeUndefined();
    expect(text(tree)).toContain("Shopify — live");
  });
});

describe("Generate: live on the card", () => {
  it("the photo's place shows Gemini's status, thoughts and drafts as they arrive, then the finished photo — and the list is not reloaded", async () => {
    const d = deferred();
    let onEvent;
    const api = fakeApi([bare(1), bare(2)], { generate: vi.fn((pid, opts) => { onEvent = opts.onEvent; return d.promise; }) });
    const tree = await render(api);
    await tap(btn(card(tree, P(1)), "Generate"));
    expect(api.generate).toHaveBeenCalledWith(P(1), expect.objectContaining({ method: "full" }));
    let c = card(tree, P(1));
    expect(label(byId(c, "live-status")[0])).toBe("Starting…");
    expect(btn(c, "Generating…").props.disabled).toBe(true);
    // The other card is NOT locked while this one generates.
    expect(btn(card(tree, P(2)), "Generate").props.disabled).toBe(false);

    await act(async () => { onEvent({ type: "status", text: "Gemini is working…" }); });
    await act(async () => { onEvent({ type: "thought", text: "Hanging the hoodie " }); onEvent({ type: "thought", text: "on the fence." }); });
    c = card(tree, P(1));
    expect(text({ toJSON: () => byId(c, "live-thoughts")[0] && tree.toJSON() })).toContain("Hanging the hoodie on the fence.");
    await act(async () => { onEvent({ type: "draft", n: 1, url: "https://x/draft1.jpg" }); });
    c = card(tree, P(1));
    expect(byId(c, "live-tile")[0].findAll((n) => n.type === "img").map((i) => i.props.src)).toEqual(["https://x/draft1.jpg"]);
    expect(text(tree)).toContain("Draft 1 — Gemini is still working");

    const landed = { pid: P(1), status: "ready", enqueuedAt: 1, name: "Item 1", originalUrl: "https://x/o1.jpg", currentGen: "g9", generatedUrl: "https://x/g9.jpg", generations: { g9: GEN("g9", 9) } };
    await settle(() => d.resolve({ ok: true, pid: P(1), seconds: 41.6, costZar: 2.75, costEstimated: false, item: landed }));
    c = card(tree, P(1));
    expect(byId(c, "live-tile")).toHaveLength(0);
    expect(byId(c, "main-photo")[0].findAll((n) => n.type === "img")[0].props.src).toBe("https://x/g9.jpg");
    // The card keeps its product (prices) — the server's item carries none.
    expect(btn(c, "Approve").props.disabled).toBe(false);
    expect(label(byId(tree.root, "toast")[0])).toBe("Photo ready in 42s · R2.75.");
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it("two items can generate at once; a second tap on the same item does nothing", async () => {
    const api = fakeApi([bare(1), bare(2)], { generate: vi.fn(() => new Promise(() => {})) });
    const tree = await render(api);
    await tap(btn(card(tree, P(1)), "Generate"));
    await tap(btn(card(tree, P(2)), "Generate"));
    expect(api.generate).toHaveBeenCalledTimes(2);
    expect(byId(tree.root, "live-tile")).toHaveLength(2);
    await act(async () => { card(tree, P(1)).findAll((n) => n.type === "button").find((b) => label(b) === "Generating…").props.onClick(); });
    expect(api.generate).toHaveBeenCalledTimes(2);
  });

  it("a failed generation says why, in the server's words, and leaves the card as it was", async () => {
    const api = fakeApi([withPhoto(1)], { generate: vi.fn(async () => { throw new Error("No photo — the photo service is busy — tap Generate again."); }) });
    const tree = await render(api);
    await tap(btn(card(tree, P(1)), "Regenerate"));
    await settle(() => {});
    expect(label(byId(tree.root, "toast")[0])).toBe("No photo — the photo service is busy — tap Generate again.");
    const c = card(tree, P(1));
    expect(byId(c, "main-photo")[0].findAll((n) => n.type === "img")[0].props.src).toBe("https://x/g2.jpg");
    expect(btn(c, "Regenerate").props.disabled).toBe(false);
  });

  it("the method is chosen per item: Full Gemini by default, Split on a tap — and Generate uses it", async () => {
    const api = fakeApi([bare(1)], { generate: vi.fn(() => new Promise(() => {})) });
    const tree = await render(api);
    const radios = () => card(tree, P(1)).findAll((n) => n.props && n.props.role === "radio");
    expect(radios().map((r) => [label(r), r.props["aria-checked"]])).toEqual([["Split", false], ["Full Gemini", true]]);
    await tap(radios()[0]);
    expect(radios().map((r) => r.props["aria-checked"])).toEqual([true, false]);
    expect(api.method).toHaveBeenCalledWith(P(1), "split");
    await tap(btn(card(tree, P(1)), "Generate"));
    expect(api.generate).toHaveBeenCalledWith(P(1), expect.objectContaining({ method: "split" }));
  });

  it("choosing the default method clears the item's override on the server", async () => {
    const api = fakeApi([bare(1, { method: "split" })]);
    const tree = await render(api);
    await tap(card(tree, P(1)).findAll((n) => n.props && n.props.role === "radio")[1]);
    expect(api.method).toHaveBeenCalledWith(P(1), null);
  });
});

describe("instant taps: the screen changes at once, the write runs behind it", () => {
  it("Approve: the card leaves for Done BEFORE the write answers; the counts move with it; nothing reloads", async () => {
    const d = deferred();
    const api = fakeApi([withPhoto(1), withPhoto(2)], { approve: vi.fn(() => d.promise) });
    const tree = await render(api);
    await tap(btn(card(tree, P(1)), "Approve"));
    expect(cards(tree)).toEqual([P(2)]);
    expect(tabLabels(tree)).toEqual(["New 1", "Done 6"]);
    expect(label(byId(tree.root, "group-name")[0])).toBe("Sneakers · 1");
    expect(api.approve).toHaveBeenCalledWith([P(1)]);
    await settle(() => d.resolve({ approved: [P(1)], skipped: [] }));
    expect(cards(tree)).toEqual([P(2)]);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it("Approve refused: the card comes back in its place, the counts with it, and the reason is said", async () => {
    const api = fakeApi([withPhoto(1), withPhoto(2), withPhoto(3)], { approve: vi.fn(async () => ({ approved: [], skipped: [{ pid: P(2), why: "no stock price yet — enter it on the card, then approve" }] })) });
    const tree = await render(api);
    await tap(btn(card(tree, P(2)), "Approve"));
    await settle(() => {});
    expect(cards(tree)).toEqual([P(1), P(2), P(3)]);
    expect(tabLabels(tree)).toEqual(["New 3", "Done 5"]);
    expect(label(byId(tree.root, "toast")[0])).toBe("Not approved — no stock price yet — enter it on the card, then approve. It is back on the list.");
  });

  it("Approve does nothing without a stock price, or while that item is generating", async () => {
    const api = fakeApi([withPhoto(1, { product: { name: "x" } })]);
    const tree = await render(api);
    await tap(btn(card(tree, P(1)), "Approve"));
    expect(api.approve).not.toHaveBeenCalled();
    expect(cards(tree)).toEqual([P(1)]);
  });

  it("Skip: gone at once, with an 8-second Undo; Undo puts it back at once and restores it only after the skip has landed", async () => {
    const skipD = deferred();
    const order = [];
    const api = fakeApi([bare(1), bare(2)], {
      skip: vi.fn((pids) => { order.push("skip"); return skipD.promise.then(() => ({ skippedPids: pids, skipped: [] })); }),
      restore: vi.fn(async (pids) => { order.push("restore"); return { restored: pids, skipped: [] }; }),
    });
    const tree = await render(api);
    await tap(btn(card(tree, P(1)), "Skip"));
    expect(cards(tree)).toEqual([P(2)]);
    expect(tabLabels(tree)[0]).toBe("New 1");
    expect(text(tree)).toContain("1 skipped — not advertised.");
    await tap(btn(byId(tree.root, "undo-toast")[0], "Undo"));
    expect(cards(tree)).toEqual([P(1), P(2)]);
    expect(byId(tree.root, "undo-toast")).toHaveLength(0);
    expect(order).toEqual(["skip"]);
    await settle(() => skipD.resolve());
    await settle(() => {});
    expect(order).toEqual(["skip", "restore"]);
    expect(api.restore).toHaveBeenCalledWith([P(1)]);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it("a second Skip within 8 s adds to the one toast — Undo brings both back in their places", async () => {
    const api = fakeApi([bare(1), bare(2), bare(3)]);
    const tree = await render(api);
    await tap(btn(card(tree, P(1)), "Skip"));
    await tap(btn(card(tree, P(3)), "Skip"));
    expect(text(tree)).toContain("2 skipped — not advertised.");
    expect(cards(tree)).toEqual([P(2)]);
    await tap(btn(byId(tree.root, "undo-toast")[0], "Undo"));
    await settle(() => {});
    expect(cards(tree)).toEqual([P(1), P(2), P(3)]);
    expect(api.restore.mock.calls.map((c) => c[0][0]).sort()).toEqual([P(1), P(3)]);
  });

  it("the Undo toast goes after 8 seconds and the skip stands", async () => {
    vi.useFakeTimers();
    const api = fakeApi([bare(1)]);
    const tree = await render(api);
    await tap(btn(card(tree, P(1)), "Skip"));
    expect(byId(tree.root, "undo-toast")).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(view.UNDO_MS - 1); });
    expect(byId(tree.root, "undo-toast")).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(byId(tree.root, "undo-toast")).toHaveLength(0);
    expect(api.restore).not.toHaveBeenCalled();
    expect(cards(tree)).toEqual([]);
  });

  it("Skip refused: the card comes back, the Undo toast goes, the reason is said", async () => {
    const api = fakeApi([bare(1)], { skip: vi.fn(async () => { throw new Error("it is approved, not new or ready or rejected."); }) });
    const tree = await render(api);
    await tap(btn(card(tree, P(1)), "Skip"));
    await settle(() => {});
    expect(cards(tree)).toEqual([P(1)]);
    expect(byId(tree.root, "undo-toast")).toHaveLength(0);
    expect(label(byId(tree.root, "toast")[0])).toBe("Not skipped — it is approved, not new or ready or rejected. It is back on the list.");
  });

  it("Save price: the card shows the new prices (and Approve wakes) before the write answers; only the changed field is sent, through the admin save", async () => {
    const d = deferred();
    const item = withPhoto(1, { product: { name: "x", retailPrice: 400, sizes: ["7"] } });
    const api = fakeApi([item], { savePrices: vi.fn(() => d.promise) });
    const tree = await render(api);
    const input = (l) => card(tree, P(1)).findAll((n) => n.type === "input" && n.props["aria-label"] === l)[0];
    expect(btn(card(tree, P(1)), "Approve").props.disabled).toBe(true);
    await act(async () => { input("Stock price (R)").props.onChange({ target: { value: "350" } }); });
    await tap(btn(card(tree, P(1)), "Save"));
    expect(api.savePrices).toHaveBeenCalledWith(P(1), item.product, { stockPrice: "350" });
    expect(input("Stock price (R)").props.value).toBe("350");
    expect(btn(card(tree, P(1)), "Approve").props.disabled).toBe(false);
    expect(byId(card(tree, P(1)), "approve-note")).toHaveLength(0);
    await settle(() => d.resolve({ ok: true, count: 1 }));
    expect(label(byId(tree.root, "toast")[0])).toBe("Prices saved.");
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it("Save price refused: the old price is back on the card, with the reason", async () => {
    const api = fakeApi([withPhoto(1)], { savePrices: vi.fn(async () => ({ ok: false, error: "1 selected product is on special — end the special first, then reprice." })) });
    const tree = await render(api);
    const input = (l) => card(tree, P(1)).findAll((n) => n.type === "input" && n.props["aria-label"] === l)[0];
    await act(async () => { input("Retail price (R)").props.onChange({ target: { value: "450" } }); });
    await tap(btn(card(tree, P(1)), "Save"));
    await settle(() => {});
    expect(input("Retail price (R)").props.value).toBe("400");
    expect(label(byId(tree.root, "toast")[0])).toBe("Prices not saved — 1 selected product is on special — end the special first, then reprice. The card is back as it was.");
  });

  it("retail below the stock price: asks the admin editor's question; yes saves with { confirmed: true }, no puts the card back", async () => {
    const question = "Retail Price (R200) is lower than Stock Price (R300). Continue?";
    const save = vi.fn(async (pid, product, drafts, opts) => (opts?.confirmed ? { ok: true, count: 1 } : { ok: false, needsConfirm: true, error: question }));
    const confirm = vi.fn(() => true);
    vi.stubGlobal("window", { confirm });
    const api = fakeApi([withPhoto(1)], { savePrices: save });
    const tree = await render(api);
    const input = () => card(tree, P(1)).findAll((n) => n.type === "input" && n.props["aria-label"] === "Retail price (R)")[0];
    await act(async () => { input().props.onChange({ target: { value: "200" } }); });
    await tap(btn(card(tree, P(1)), "Save"));
    await settle(() => {});
    expect(confirm).toHaveBeenCalledWith(question);
    expect(save).toHaveBeenLastCalledWith(P(1), expect.anything(), { retailPrice: "200" }, { confirmed: true });
    expect(input().props.value).toBe("200");
    // Declined: nothing more is written and the old price is back.
    confirm.mockReturnValue(false);
    await act(async () => { input().props.onChange({ target: { value: "100" } }); });
    await tap(btn(card(tree, P(1)), "Save"));
    await settle(() => {});
    expect(save).toHaveBeenCalledTimes(3);
    expect(input().props.value).toBe("200");
  });

  it("Use this one: that photo is the current one at once; a refusal puts the old one back", async () => {
    const d = deferred();
    const api = fakeApi([withPhoto(1)], { select: vi.fn(() => d.promise) });
    const tree = await render(api);
    const mainSrc = () => byId(card(tree, P(1)), "main-photo")[0].findAll((n) => n.type === "img")[0].props.src;
    expect(mainSrc()).toBe("https://x/g2.jpg");
    await tap(btn(byId(card(tree, P(1)), "earlier-generations")[0], "Use this one"));
    expect(mainSrc()).toBe("https://x/g1.jpg");
    expect(api.select).toHaveBeenCalledWith(P(1), "g1");
    await settle(() => d.reject(new Error("Can't use that photo — a new photo is being generated — wait for it.")));
    expect(mainSrc()).toBe("https://x/g2.jpg");
    expect(label(byId(tree.root, "toast")[0])).toMatch(/^Main photo not changed — Can't use that photo/);
  });

  it("❤ fills at once and is sent with loved true / false", async () => {
    const api = fakeApi([withPhoto(1)]);
    const tree = await render(api);
    const heart = () => byId(byId(card(tree, P(1)), "main-meta")[0], "love")[0];
    expect(heart().props["aria-pressed"]).toBe(false);
    await tap(heart());
    expect(heart().props["aria-pressed"]).toBe(true);
    expect(api.love).toHaveBeenCalledWith(P(1), "g2", true);
    await settle(() => {});
    await tap(heart());
    expect(heart().props["aria-pressed"]).toBe(false);
    expect(api.love).toHaveBeenLastCalledWith(P(1), "g2", false);
  });

  it("'Not right?' opens the feedback chips — exactly the ledger's strings — and one tap notes it; the item stays", async () => {
    const api = fakeApi([withPhoto(1)]);
    const tree = await render(api);
    expect(byId(card(tree, P(1)), "reject-chips")).toHaveLength(0);
    await tap(byId(card(tree, P(1)), "feedback-toggle")[0]);
    const chips = byId(card(tree, P(1)), "reject-chips")[0].findAll((n) => n.type === "button");
    expect(chips.map(label)).toEqual(REJECT_CHIPS);
    await tap(chips[1]);
    expect(api.reject).toHaveBeenCalledWith(P(1), "colour off");
    expect(cards(tree)).toEqual([P(1)]);
    expect(label(byId(tree.root, "toast")[0])).toBe("Noted: colour off.");
  });
});

describe("paging and refresh", () => {
  const paged = (n) => {
    const all = Array.from({ length: n }, (_, i) => bare(i + 1));
    return fakeApi([], { list: vi.fn(async (tab, { cursor = null, limit = 30 } = {}) => {
      const from = cursor ? all.findIndex((i) => i.pid === cursor) + 1 : 0;
      const page = all.slice(from, from + limit);
      return { tab, items: page, total: n, nextCursor: from + limit < n ? page[page.length - 1].pid : null, tabCounts: { new: n, done: 0 }, groupCounts: { sneakers: n, clothing: 0 } };
    }) });
  };

  it("30 at a time through the list callable; Load more fetches the next page by cursor", async () => {
    const api = paged(75);
    const tree = await render(api);
    expect(cards(tree)).toHaveLength(30);
    expect(api.list).toHaveBeenLastCalledWith("new", { limit: 30, group: "sneakers" });
    await tap(btn(tree.root, "Load more (30 of 75 shown)"));
    expect(cards(tree)).toHaveLength(60);
    expect(api.list).toHaveBeenLastCalledWith("new", { cursor: P(30), limit: 30, group: "sneakers" });
    await tap(btn(tree.root, "Load more (60 of 75 shown)"));
    expect(cards(tree)).toHaveLength(75);
    expect(btn(tree.root, "Load more (75 of 75 shown)")).toBeUndefined();
  });

  it("the quiet refresh never paints over a tap made while it was on its way", async () => {
    vi.useFakeTimers();
    const slow = deferred();
    let calls = 0;
    const items = [bare(1), bare(2)];
    const api = fakeApi(items, { list: vi.fn(async (tab) => {
      calls += 1;
      const res = { tab, items, total: 2, tabCounts: { new: 2, done: 5 }, groupCounts: { sneakers: 2, clothing: 0 } };
      return calls === 1 ? res : slow.promise.then(() => res);
    }) });
    const tree = await render(api);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(api.list).toHaveBeenCalledTimes(2);
    await tap(btn(card(tree, P(1)), "Skip"));
    expect(cards(tree)).toEqual([P(2)]);
    await act(async () => { slow.resolve(); await Promise.resolve(); await Promise.resolve(); });
    // The refresh that started before the Skip is dropped: the skipped card does not reappear.
    expect(cards(tree)).toEqual([P(2)]);
  });

  it("a slow answer for a tab no longer shown is dropped", async () => {
    const slow = deferred();
    const api = fakeApi([bare(1)], { list: vi.fn((tab) => (tab === "new" ? slow.promise : Promise.resolve({ tab, items: [], tabCounts: { new: 1, done: 0 } }))) });
    const tree = await render(api);
    await tap(tree.root.findAll((n) => n.props && n.props.role === "tab")[1]);
    await settle(() => slow.resolve({ tab: "new", items: [bare(1)], tabCounts: { new: 1, done: 0 } }));
    expect(cards(tree)).toEqual([]);
    expect(text(tree)).toContain("Nothing here.");
  });
});

describe("the card's own state helpers", () => {
  it("foldLive folds status, thought text and drafts; a repeated draft is not shown twice", () => {
    let l = view.liveStart(5);
    l = view.foldLive(l, { type: "thought", text: "a" });
    l = view.foldLive(l, { type: "thought", text: "b" });
    l = view.foldLive(l, { type: "draft", url: "u1" });
    l = view.foldLive(l, { type: "draft", url: "u1" });
    l = view.foldLive(l, { type: "bogus" });
    expect(l).toEqual({ status: "Gemini is drawing…", thoughts: "ab", drafts: ["u1"], startedAt: 5 });
    expect(view.foldLive(l, { type: "status", text: "Finishing the photo…" }).status).toBe("Finishing the photo…");
  });

  it("afterPrices leaves an empty field alone (an empty field never clears a real price)", () => {
    const it0 = { product: { stockPrice: 300, retailPrice: 400 } };
    expect(view.afterPrices(it0, { stockPrice: "", retailPrice: "450" }).product).toEqual({ stockPrice: 300, retailPrice: 450 });
    expect(view.afterPrices(it0, { stockPrice: "abc" }).product).toEqual({ stockPrice: 300, retailPrice: 400 });
  });

  it("withoutItem / withItemBack are inverse on the list and its counts", () => {
    const data = { items: [bare(1), bare(2), bare(3)], total: 3, tabCounts: { new: 3, done: 5 }, groupCounts: { sneakers: 3, clothing: 1 } };
    const gone = view.withoutItem(data, P(2), { group: "sneakers", toTab: "done" });
    expect(gone.items.map((i) => i.pid)).toEqual([P(1), P(3)]);
    expect(gone.tabCounts).toEqual({ new: 2, done: 6 });
    expect(gone.groupCounts).toEqual({ sneakers: 2, clothing: 1 });
    expect(view.withItemBack(gone, { item: bare(2), index: 1, toTab: "done" }, { group: "sneakers" })).toEqual(data);
    // Removing what is not there, or restoring what is, changes nothing.
    expect(view.withoutItem(data, P(9), {})).toBe(data);
    expect(view.withItemBack(data, { item: bare(2), index: 0 }, {})).toBe(data);
  });

  it("a request older than 10 minutes is a run that died — the card stops saying Generating", () => {
    const now = 1_000_000_000;
    expect(view.isGenerating({ status: "ready", generateRequest: { at: now - 60_000 } }, now)).toBe(true);
    expect(view.isGenerating({ status: "ready", generateRequest: { at: now - view.REQUEST_STALE_MS - 1 } }, now)).toBe(false);
  });
});

describe("studioStream: the streaming callable over fetch", () => {
  const enc = new TextEncoder();
  const sse = (text, cut = 23) => {
    const bytes = enc.encode(text);
    let i = 0;
    return {
      status: 200, headers: { get: () => "text/event-stream" },
      body: { getReader: () => ({ read: async () => (i >= bytes.length ? { done: true } : { value: bytes.subarray(i, (i += cut)), done: false }) }) },
    };
  };
  const line = (o) => `data: ${JSON.stringify(o)}\n\n`;

  it("chunks reach onChunk in order, the result resolves, and the request is the callable protocol", async () => {
    const seen = [];
    const calls = [];
    const out = await streamCallable({
      url: "https://f/newArrivalsStudio", data: { pid: "p1" }, getToken: async () => "tok",
      fetchImpl: async (url, init) => { calls.push({ url, init }); return sse(line({ message: { type: "thought", text: "héllo — ok" } }) + line({ message: { type: "draft", url: "u" } }) + line({ result: { ok: true } })); },
      onChunk: (c) => seen.push(c),
    });
    expect(out).toEqual({ ok: true });
    expect(seen).toEqual([{ type: "thought", text: "héllo — ok" }, { type: "draft", url: "u" }]);
    expect(calls[0].init.headers).toEqual({ "Content-Type": "application/json", Accept: "text/event-stream", Authorization: "Bearer tok" });
    expect(JSON.parse(calls[0].init.body)).toEqual({ data: { pid: "p1" } });
  });

  it("a server error arrives as its own message", async () => {
    await expect(streamCallable({ url: "u", data: {}, getToken: async () => "t", fetchImpl: async () => sse(line({ error: { message: "No photo — busy.", status: "UNAVAILABLE" } })) }))
      .rejects.toMatchObject({ message: "No photo — busy.", code: "UNAVAILABLE" });
  });

  it("an SSE refusal labelled text/html (as the live function sends a signed-out refusal) is still read as the refusal", async () => {
    const res = { ...sse(line({ error: { message: "Sign in required.", status: "PERMISSION_DENIED" } })), headers: { get: () => "text/html" } };
    await expect(streamCallable({ url: "u", data: {}, getToken: async () => "t", fetchImpl: async () => res })).rejects.toMatchObject({ message: "Sign in required.", code: "PERMISSION_DENIED" });
  });

  it("a non-streamed answer (JSON) still works; a closed stream with no result is an error; no token, no call", async () => {
    const json = (body, status = 200) => ({ status, headers: { get: () => "application/json" }, text: async () => JSON.stringify(body), json: async () => body });
    await expect(streamCallable({ url: "u", data: {}, getToken: async () => "t", fetchImpl: async () => json({ result: 7 }) })).resolves.toBe(7);
    await expect(streamCallable({ url: "u", data: {}, getToken: async () => "t", fetchImpl: async () => json({ error: { message: "Sign in required.", status: "UNAUTHENTICATED" } }, 401) })).rejects.toThrow("Sign in required.");
    await expect(streamCallable({ url: "u", data: {}, getToken: async () => "t", fetchImpl: async () => sse(line({ message: 1 })) })).rejects.toThrow(/closed before the photo arrived/);
    const fetchImpl = vi.fn();
    await expect(streamCallable({ url: "u", data: {}, getToken: async () => null, fetchImpl })).rejects.toThrow("Sign in required.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sseSplit keeps the unfinished line", () => {
    expect(sseSplit("data: 1\n\ndata: {\"a\"")).toEqual({ payloads: ["1"], rest: "data: {\"a\"" });
  });
});
