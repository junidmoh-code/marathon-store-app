// Junid, 24 Nov 2026: the daily shelf checks, Central's website strip inside
// Source, and "website orders stand out" (the strip, the hub banner, the wait).
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} };
globalThis.window.addEventListener ||= () => {};
globalThis.window.removeEventListener ||= () => {};
globalThis.document = globalThis.document || { addEventListener() {}, removeEventListener() {}, activeElement: null };

const calls = [];
let listAnswer = null;
let answerAnswer = null;
vi.mock("../../firebase", () => ({ functions: {} }));
vi.mock("firebase/functions", () => ({ httpsCallable: (_f, name) => async (data) => {
  calls.push([name, data]);
  if (name === "webShelfList") { if (listAnswer instanceof Error) throw listAnswer; return { data: listAnswer }; }
  if (name === "webShelfAnswer") return { data: answerAnswer };
  return { data: { ok: true } };
} }));
vi.mock("firebase/database", () => ({ getDatabase: () => ({}), ref: (_d, p) => ({ path: p }), get: async () => ({ val: () => null }) }));

const { default: ShelfChecksPanel, whyText, countChoices, scanBuffer } = await import("./ShelfChecksPanel.jsx");
const { default: WebsiteOrdersStrip } = await import("../../pages/DisplayChecks/WebsiteOrdersStrip.jsx");
const { WebOrderBanner, HubWebPicksSummary } = await import("./WebOrderBadge.jsx");
const { progressRow } = await import("./ShelfProgressCard.jsx");
const { webWaiting } = await import("../../utils/onlineOrders.js");

const all = (tree) => JSON.stringify(tree.toJSON());
const byTestId = (tree, id) => tree.root.findAll((n) => n.props?.["data-testid"] === id && typeof n.type === "string");
const NOW = Date.now();
const DAY = 864e5;
const single = { id: "a__M", pid: "a", sizeKey: "M", size: "M", shown: 1, why: "old_single", lastMoved: NOW - 63 * DAY, name: "Club Tee", photoUrl: null, barcode: "6001234567890" };
const several = { id: "w__L", pid: "w", sizeKey: "L", size: "L", shown: 3, why: "wrong_by_more", lastMoved: NOW - 9 * DAY, name: "Boss Hoodie", photoUrl: null, barcode: "6009999999999" };
const list = (over = {}) => ({ ok: true, loc: "trophy", webRows: [], checks: [single, several], today: { found: 2, notFound: 1, counted: 0, corrected: 0, listed: 20 }, left: 2, ...over });

beforeEach(() => { calls.length = 0; listAnswer = list(); answerAnswer = list({ checks: [several] }); });
const mount = async (loc = "trophy") => { let tree; await act(async () => { tree = TestRenderer.create(<ShelfChecksPanel loc={loc} />); }); return tree; };

describe("the daily shelf checks", () => {
  it("asks for this place's list and shows what to check, why, and how many are done", async () => {
    const tree = await mount();
    expect(calls[0]).toEqual(["webShelfList", { loc: "trophy" }]);
    const t = all(tree);
    for (const s of ["Shelf check — today", "2 to check", "Club Tee", "One piece, not touched for 63 days. Is it there?", "Boss Hoodie", "It could not be found for a website order, but the app shows 3. Count the shelf."]) expect(t).toContain(s);
    expect(t).toContain("3"); // done today: 2 found + 1 not found
    expect(byTestId(tree, "shelf-row")).toHaveLength(2);
  });

  it("a single piece: Found is one tap; Not found takes two; nothing is typed (there is no input anywhere)", async () => {
    const tree = await mount();
    expect(tree.root.findAllByType("input")).toHaveLength(0);
    expect(tree.root.findAllByType("textarea")).toHaveLength(0);
    await act(async () => { byTestId(tree, "shelf-notfound")[0].props.onClick(); });
    expect(calls.filter(([n]) => n === "webShelfAnswer")).toHaveLength(0);
    expect(all(tree)).toContain("Tap again: not found");
    await act(async () => { byTestId(tree, "shelf-notfound")[0].props.onClick(); });
    expect(calls.at(-1)).toEqual(["webShelfAnswer", { loc: "trophy", id: "a__M", result: "not_found" }]);
    expect(byTestId(tree, "shelf-row")).toHaveLength(1); // the answer's own list replaces the screen
  });

  it("Found → webShelfAnswer(found)", async () => {
    const tree = await mount();
    await act(async () => { byTestId(tree, "shelf-found")[0].props.onClick(); });
    expect(calls.at(-1)).toEqual(["webShelfAnswer", { loc: "trophy", id: "a__M", result: "found" }]);
  });

  it("a shelf showing several: the real number is tapped from a small picker, sent as a number", async () => {
    const tree = await mount();
    expect(byTestId(tree, "shelf-count")).toHaveLength(1);
    expect(countChoices(3)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(countChoices(2)).toEqual([0, 1, 2, 3, 4]);
    expect(countChoices(29)).toHaveLength(31);            // never past what the server takes
    expect(countChoices(2, true).at(-1)).toBe(30);        // "More" offers every number the server takes
    await act(async () => { byTestId(tree, "shelf-count-more")[0].props.onClick(); });
    expect(byTestId(tree, "shelf-count-8")).toHaveLength(1);
    await act(async () => { byTestId(tree, "shelf-count-1")[0].props.onClick(); });
    expect(calls.at(-1)).toEqual(["webShelfAnswer", { loc: "trophy", id: "w__L", result: "count", count: 1 }]);
    await act(async () => { byTestId(tree, "shelf-count-0")[0].props.onClick(); });
    expect(calls.at(-1)[1].count).toBe(0); // zero is sent as 0, never dropped
  });

  it("a shelf that changed since the morning says so and is gone", async () => {
    answerAnswer = { ...list({ checks: [several] }), ok: false, reason: "stale" };
    const tree = await mount();
    await act(async () => { byTestId(tree, "shelf-found")[0].props.onClick(); });
    expect(all(tree)).toContain("That shelf has changed since this morning");
  });

  it("no permission for this place → nothing at all; nothing to check and nothing done → nothing at all", async () => {
    listAnswer = Object.assign(new Error("no"), { code: "functions/permission-denied" });
    expect((await mount()).toJSON()).toBeNull();
    listAnswer = list({ checks: [], today: {} });
    expect((await mount()).toJSON()).toBeNull();
  });

  it("the words for why a shelf is listed", () => {
    expect(whyText({ why: "old_single", lastMoved: NOW - 100 * DAY, shown: 1 }, NOW)).toBe("One piece, not touched for 100 days. Is it there?");
    expect(whyText({ why: "old_single", lastMoved: null, shown: 1 }, NOW)).toBe("One piece. Is it there?");
    expect(whyText({ why: "wrong_by_more", shown: 4 }, NOW)).toMatch(/app shows 4\. Count the shelf/);
  });

  it("a scanner (fast keys, then Enter) gives its code; a person typing does not", () => {
    const feed = scanBuffer();
    let out = null, t = 1000;
    for (const ch of "6001234567890") out = feed(ch, (t += 10));
    expect(out).toBeNull();
    expect(feed("Enter", t + 10)).toBe("6001234567890");
    const slow = scanBuffer();
    t = 1000;
    for (const ch of "600123") slow(ch, (t += 300));
    expect(slow("Enter", t + 300)).toBeNull();
    expect(feed("Enter", t)).toBeNull(); // nothing buffered
    expect(feed("Shift", t)).toBeNull();
  });
});

describe("Central's website strip inside Source", () => {
  const WEB = { key: "online__9__0", checkId: "C1", kind: "online_pick", productId: "p9", productName: "Lacoste golf t shirt", size: "XL", qty: 1, orderNumber: 2301, createdAt: NOW - 75 * 60e3 };
  it("shows the lines that reached Central, with Found / Not found and the morning-run words; Found → completeDisplayCheck for store central, then re-reads", async () => {
    listAnswer = list({ loc: "central", webRows: [WEB], checks: [] });
    const tree = await mount("central");
    const t = all(tree);
    for (const s of ["Website orders — pull these first", "Lacoste golf t shirt", "#", "2301", "Pull and put it on the morning stock run to Marathon PE", "waiting 1 h 15 min"]) expect(t).toContain(s);
    expect(t).not.toContain("Handed over");
    const before = calls.filter(([n]) => n === "webShelfList").length;
    await act(async () => { byTestId(tree, "web-handed")[0].props.onClick(); });
    expect(calls.find(([n]) => n === "completeDisplayCheck")[1]).toEqual({ store: "central", key: "online__9__0", checkId: "C1", result: "handed", override: false });
    expect(calls.filter(([n]) => n === "webShelfList").length).toBe(before + 1);
  });
  it("a shop never gets another place's website rows through this panel", async () => {
    listAnswer = list({ webRows: [WEB], checks: [single] });
    expect(byTestId(await mount("trophy"), "web-strip")).toHaveLength(0);
  });
});

describe("website orders stand out", () => {
  const row = (key, min) => ({ key, checkId: key, kind: "online_pick", productId: "p", productName: `Item ${key}`, size: "M", qty: 1, orderNumber: 1, createdAt: NOW - min * 60e3 });
  it("the strip is headed in red, counts its rows, and puts the longest-waiting row first", async () => {
    let tree;
    await act(async () => { tree = TestRenderer.create(<WebsiteOrdersStrip store="trophy" rows={[row("new", 5), row("old", 95), row("mid", 40)]} />); });
    const rows = byTestId(tree, "web-row").map((r) => JSON.stringify(TestRenderer.create(<div>{r.props.children}</div>).toJSON()));
    expect(rows[0]).toContain("Item old");
    expect(rows[2]).toContain("Item new");
    expect(byTestId(tree, "web-wait").map((n) => n.props["data-level"])).toEqual(["overdue", "late", "fresh"]);
    expect(all(tree)).toContain("Handed over");
  });
  it("how long it has waited, and when that turns amber and red", () => {
    const at = (min) => webWaiting(NOW - min * 60e3, NOW);
    expect(at(0)).toEqual({ text: "just in", level: "fresh" });
    expect(at(29)).toEqual({ text: "waiting 29 min", level: "fresh" });
    expect(at(30)).toEqual({ text: "waiting 30 min", level: "late" });
    expect(at(60)).toEqual({ text: "waiting 1 h", level: "overdue" });
    expect(at(80)).toEqual({ text: "waiting 1 h 20 min", level: "overdue" });
    expect(at(3 * 1440)).toEqual({ text: "waiting 3 days", level: "overdue" });
    expect(webWaiting("2026-11-24T08:00:00.000Z", Date.parse("2026-11-24T08:45:00.000Z")).text).toBe("waiting 45 min");
    expect(webWaiting(null, NOW)).toBeNull();
    expect(webWaiting("nonsense", NOW)).toBeNull();
  });
  it("a hub's queue is topped by its website picks, longest-waiting first; the card carries the banner", async () => {
    let tree;
    const picks = [{ id: "KQZ", productName: "Air Runner", size: "8", createdAt: new Date(NOW - 10 * 60e3).toISOString() }, { id: "ABD", productName: "Shox TL", size: "7", createdAt: new Date(NOW - 90 * 60e3).toISOString() }];
    await act(async () => { tree = TestRenderer.create(<HubWebPicksSummary orders={picks} />); });
    const t = all(tree);
    expect(t.indexOf("ABD")).toBeLessThan(t.indexOf("KQZ"));
    expect(t).toContain("WEBSITE ORDERS — PULL THESE FIRST");
    expect(t).toContain("waiting 1 h 30 min");
    await act(async () => { tree = TestRenderer.create(<HubWebPicksSummary orders={[]} />); });
    expect(tree.toJSON()).toBeNull();
    await act(async () => { tree = TestRenderer.create(<WebOrderBanner since={new Date(NOW - 5 * 60e3).toISOString()} />); });
    expect(all(tree)).toContain("WEBSITE ORDER");
    expect(all(tree)).toContain("waiting 5 min");
  });
});

describe("Junid's progress view", () => {
  it("one row per place: today, what is waiting, and how often the shelf was wrong", () => {
    const pe = { loc: "marathon-pe", open: 12, wrongByMoreOpen: 3, checked14: 40, wrong14: 10, days: [{ day: "2026-11-24", listed: 20, checked: 8 }] };
    // Yesterday's record is never shown as today's.
    expect(progressRow(pe, "2026-11-25").today).toBe("—");
    expect(progressRow(pe, "2026-11-24"))
      .toEqual({ place: "Marathon PE", open: 12, wrongByMoreOpen: 3, today: "8 of 20", checked14: 40, wrong14: 10, wrongPct: 25 });
    expect(progressRow({ loc: "hub3", open: 0, checked14: 0, wrong14: 0, days: [] }, "2026-11-24")).toMatchObject({ place: "Hub 3", today: "—", wrongPct: null });
  });
});
