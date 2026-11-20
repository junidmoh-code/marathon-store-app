// Black Friday card v3 — one row per product, two tabs, reject persists,
// Approve all 30+, under-13 switch, the posting brain's plan on the Approved tab.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import BlackFridayScreen, { rowActions, shownId } from "./BlackFridayScreen";
import { isUpdateBusy } from "../../update/updateChecker";

const row = (pid, qty, over = {}) => ({ pid, name: `Item ${pid}`, price: 300, qty, sizes: "M-XL", kind: "clothing", big: qty >= 30, na: false, photo: `https://x/${pid}.jpg`, shown: `https://x/${pid}.jpg`,
  use: "current", genId: null, generatedUrl: null, generations: 0, generating: false, styleApproved: true, tab: "review", changedSinceApproval: false, posted: null, ...over });
const view = (over = {}) => ({
  section: "main",
  review: [row("a", 45), row("b", 31), row("c", 20, { kind: "headwear", styleApproved: false })],
  approved: [row("d", 15, { tab: "approved" })],
  totals: { review: 4605, approved: 1, rejected: 1, spentZar: 12.5 },
  rejected: [{ pid: "r", name: "Rejected thing" }],
  styles: {}, schedule: null, plan: [], postingPaused: false,
  meta: { main: 1111, big: 299, under: 3493, paperBags: 53 },
  ...over,
});
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const text = (node) => (typeof node === "string" ? node : (node.children || []).map(text).join(""));
const byId = (r, id) => r.root.find((n) => n.props && n.props["data-testid"] === id && typeof n.type === "string");
const has = (r, id) => r.root.findAll((n) => n.props && n.props["data-testid"] === id).length > 0;

function fakeApi(over = {}) {
  return {
    list: vi.fn(async (section) => (section === "under" ? view({ section: "under", review: [row("u", 4)], approved: [], rejected: [] }) : view())),
    approve: vi.fn(async (pid) => ({ ok: true, pid, row: row(pid, 45, { tab: "approved" }), undo: { [pid]: { prev: null, expectAt: 1 } } })),
    reject: vi.fn(async (pid) => ({ ok: true, pid, rejected: true, row: null, undo: { [pid]: { prev: { state: "approved", sig: "current", at: 0 }, expectAt: 2 } } })),
    reset: vi.fn(async (pid) => ({ ok: true, pid, row: row(pid, 45) })),
    use: vi.fn(async (pid) => ({ ok: true, pid, row: row(pid, 45) })),
    approveBig: vi.fn(async () => ({ ok: true, approved: 2, pids: ["a", "b"], undo: { a: { prev: null, expectAt: 9 }, b: { prev: null, expectAt: 9 } } })),
    approveStyle: vi.fn(async () => ({ ok: true })),
    approveMany: vi.fn(async (sigs) => ({ ok: true, done: Object.keys(sigs), refused: [], undo: Object.fromEntries(Object.keys(sigs).map((p) => [p, { prev: null, expectAt: 1 }])) })),
    rejectMany: vi.fn(async (pids) => ({ ok: true, done: pids, refused: [], undo: Object.fromEntries(pids.map((p) => [p, { prev: null, expectAt: 1 }])) })),
    undo: vi.fn(async (items) => ({ ok: true, done: Object.keys(items), refused: [] })),
    resetMany: vi.fn(async (pids) => ({ ok: true, done: pids, refused: [] })),
    schedule: vi.fn(async (s, { confirm }) => ({ ok: true, preview: !confirm, plan: [{ album: "R300-clothing-1", label: "R300 Clothing", due: Date.parse("2026-11-20T09:00:00+02:00"), count: 2 }], albums: 1 })),
    clearSchedule: vi.fn(async () => ({ ok: true })),
    generate: vi.fn(async () => ({ ok: true })),
    ...over,
  };
}
async function mount(api) { let r; await act(async () => { r = TestRenderer.create(<BlackFridayScreen api={api} onExit={() => {}} />); }); await flush(); return r; }

describe("Black Friday card v3", () => {
  it("row buttons: Approve never greyed out on a generated photo; Generate on EVERY row, every kind, every tab (no category-look gate, Junid 20 Nov)", () => {
    const g = row("a", 40, { use: "generated", generations: 1, genId: "g1", sig: "g1", aiGenId: "g1", generatedUrl: "u" });
    expect(rowActions(g)).toMatchObject({ approve: true, approveDisabled: false, useCurrent: true, regenerate: true, replace: true, findOnline: true });
    expect(rowActions({ ...g, generating: true }).approveDisabled).toBe(true);
    const cap = row("c", 20, { kind: "headwear", styleApproved: false });
    expect(rowActions(cap)).toMatchObject({ generate: true, replace: true, findOnline: true });
    expect(rowActions(cap).approveLook).toBeFalsy();
    expect(rowActions(row("d", 15, { tab: "approved" }))).toMatchObject({ approve: false, backToReview: true, reject: true, generate: true, replace: true, findOnline: true });
    expect(rowActions(row("d", 15, { tab: "approved", src: "na" }))).toMatchObject({ generate: true, replace: true, findOnline: true, backToReview: true });
    expect(rowActions(row("n", 4, { tab: "newArrivals", kind: "perfume", canGenerate: true }))).toMatchObject({ generate: true });
  });

  it("short totals; two tabs with counts; 30+ block first with Approve all 30+, then 13–29; no badges, no chips, no schedule on the main view", async () => {
    const r = await mount(fakeApi());
    expect(text(byId(r, "totals"))).toBe("To review 4605 · Approved 1 · AI spend R12.50");
    expect(text(byId(r, "tab-review"))).toBe("To review (4605)");
    expect(text(byId(r, "tab-approved"))).toBe("Approved (1)");
    expect(text(byId(r, "block-big"))).toContain("30+ on hand (2)");
    expect(text(byId(r, "approve-big"))).toBe("Approve all 30+ (2)");
    expect(text(byId(r, "block-mid"))).toContain("13–29 on hand (1)");
    expect(has(r, "schedule") || has(r, "schedule-posting")).toBe(false);
    const json = JSON.stringify(r.toJSON());
    expect(json.includes("50+")).toBe(false);
    expect(json.toLowerCase().includes("retail")).toBe(false);
  });

  it("Approve moves a row to Approved; Reject removes it; Approve all 30+", async () => {
    const api = fakeApi();
    const r = await mount(api);
    await act(async () => { byId(r, "approve-a").props.onClick(); });
    expect(api.approve).toHaveBeenCalledWith("a", "main", "current");
    await act(async () => { byId(r, "reject-b").props.onClick(); });
    expect(api.reject).toHaveBeenCalledWith("b", "main");
    await act(async () => { byId(r, "approve-big").props.onClick(); });
    expect(api.approveBig).toHaveBeenCalledWith({ a: "current", b: "current" });
  });

  it("Rejected (n) is a small link at the bottom with undo", async () => {
    const api = fakeApi();
    const r = await mount(api);
    expect(text(byId(r, "rejected-link"))).toBe("Rejected (1)");
    await act(async () => { byId(r, "rejected-link").props.onClick(); });
    await act(async () => { byId(r, "undo-r").props.onClick(); });
    expect(api.reset).toHaveBeenCalledWith("r");
  });

  it("Show under 13 loads that section only when switched on", async () => {
    const api = fakeApi();
    const r = await mount(api);
    expect(api.list).toHaveBeenCalledWith("main");
    expect(api.list).not.toHaveBeenCalledWith("under");
    await act(async () => { byId(r, "show-under").props.onChange({ target: { checked: true } }); });
    await flush();
    expect(api.list).toHaveBeenCalledWith("under");
    expect(text(byId(r, "block-under"))).toContain("Under 13 (1)");
  });

  it("the ongoing daily plan: renamed plan line, today against 120, no Held for Friday", async () => {
    const brain = {
      plan: "daily", target: 120, rotating: false, paused: false, approved: 633, posted: 125, remaining: 508, reserved: 0, newArrivals: 15, todayPhotos: 30, todaySent: 156, cap: 400, overrides: {},
      days: { "2026-11-20": [{ day: "2026-11-20", i: 2, at: "16:15", size: 30, byKind: { clothing: 10, sneakers: 11, perfume: 7, accessories: 2 }, why: "set for today", status: "planned" }] }, hours: [],
    };
    const api = fakeApi({ list: vi.fn(async () => view({ brain })) });
    const r = await mount(api);
    await act(async () => { byId(r, "tab-approved").props.onClick(); });
    expect(text(byId(r, "brain-plan"))).toContain("120 photos a day, 08:00–20:00, ongoing until Pause");
    expect(text(byId(r, "brain-counts"))).toContain("Today 30/120 photos (safety ceiling 400)");
    expect(text(byId(r, "brain-counts"))).not.toContain("Friday");
  });

  it("the posting brain's plan on the Approved tab: slots per kind, counts, Best times chart, Pause, a slot moved", async () => {
    const brain = {
      paused: false, approved: 632, posted: 80, remaining: 552, reserved: 94, newArrivals: 15, todayPhotos: 80, cap: 400, overrides: {},
      days: { "2026-11-20": [{ day: "2026-11-20", i: 0, at: "08:00", size: 26, byKind: { clothing: 7, sneakers: 15 }, why: "test day: -60 min from 09:00", status: "planned" }] },
      hours: [{ hour: 20, albums: 3, r15: 0.2, r60: 0.5, medianMin: 40, answersPer100: 1.2, score: 0.4 }],
    };
    const api = fakeApi({ list: vi.fn(async () => view({ brain })), brainPause: vi.fn(async () => ({ ok: true })), brainSlot: vi.fn(async () => ({ ok: true })) });
    const r = await mount(api);
    expect(has(r, "brain")).toBe(false);
    await act(async () => { byId(r, "tab-approved").props.onClick(); });
    expect(text(byId(r, "brain-counts"))).toContain("Posted 80");
    expect(text(byId(r, "brain-day-2026-11-20"))).toContain("Clothing 7");
    expect(text(byId(r, "brain-counts"))).toContain("Held for Friday 94"); // an old (Friday) view still reads as before
    expect(text(byId(r, "best-times"))).toContain("50% in 1 h");
    await act(async () => { byId(r, "brain-pause").props.onClick(); });
    expect(api.brainPause).toHaveBeenCalledWith(true);
    await act(async () => { byId(r, "slot-2026-11-20|0").props.onClick(); });
    await act(async () => { byId(r, "slot-time-2026-11-20|0").props.onBlur({ target: { value: "09:30" } }); });
    expect(api.brainSlot).toHaveBeenCalledWith("2026-11-20", 0, "09:30");
  });

  it("no 'Approve the AI look' gate any more: a cap shows Generate straight away", async () => {
    const api = fakeApi({ list: vi.fn(async () => view({ review: [row("c", 20, { kind: "headwear", styleApproved: false })] })) });
    const r = await mount(api);
    expect(has(r, "look-c")).toBe(false);
    expect(text(byId(r, "generate-c"))).toBe("Generate");
    await act(async () => { byId(r, "generate-c").props.onClick(); });
    await flush();
    expect(api.generate).toHaveBeenCalledWith("c", "main", expect.anything());
  });

  it("a failed tap shows the error and re-reads", async () => {
    const api = fakeApi({ approve: vi.fn(async () => { throw new Error("internal"); }) });
    const r = await mount(api);
    await act(async () => { byId(r, "approve-a").props.onClick(); });
    await flush();
    expect(text(byId(r, "note"))).toContain("internal");
    expect(api.list.mock.calls.filter((c) => c[0] === "main").length).toBe(2);
  });

  it("Select: tapping rows ticks them; the bar shows n selected with Approve, Generate, Reject, Clear; Approve has an Undo toast", async () => {
    const api = fakeApi();
    const r = await mount(api);
    expect(has(r, "select-bar")).toBe(false);
    await act(async () => { byId(r, "select-toggle").props.onClick(); });
    await act(async () => { byId(r, "row-a").props.onClick(); });
    await act(async () => { byId(r, "row-c").props.onClick(); });
    expect(text(byId(r, "select-count"))).toBe("2 selected");
    expect(byId(r, "sel-a").props["aria-checked"]).toBe(true);
    await act(async () => { byId(r, "bulk-approve").props.onClick(); });
    await flush();
    expect(api.approveMany).toHaveBeenCalledWith({ a: "current", c: "current" });
    expect(text(byId(r, "toast"))).toContain("Approved 2");
    await act(async () => { byId(r, "toast-undo").props.onClick(); });
    await flush();
    expect(api.undo).toHaveBeenCalledWith({ a: { prev: null, expectAt: 1 }, c: { prev: null, expectAt: 1 } });
  });

  it("bulk Reject and Clear; bulk Generate queues one generation per selected product", async () => {
    const api = fakeApi();
    const r = await mount(api);
    await act(async () => { byId(r, "select-toggle").props.onClick(); });
    await act(async () => { byId(r, "row-a").props.onClick(); });
    await act(async () => { byId(r, "row-b").props.onClick(); });
    await act(async () => { byId(r, "bulk-clear").props.onClick(); });
    expect(has(r, "select-bar")).toBe(false);
    await act(async () => { byId(r, "row-b").props.onClick(); });
    await act(async () => { byId(r, "bulk-reject").props.onClick(); });
    await flush();
    expect(api.rejectMany).toHaveBeenCalledWith(["b"]);
    expect(text(byId(r, "toast"))).toContain("Rejected 1");
    await act(async () => { byId(r, "row-a").props.onClick(); });
    await act(async () => { byId(r, "row-c").props.onClick(); });
    await act(async () => { byId(r, "bulk-generate").props.onClick(); });
    await flush(); await flush();
    expect(api.generate.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "c"]);
  });

  it("long-press (or the phone's context menu) opens the quick popup with Generate and Approve; the image menu is suppressed", async () => {
    const api = fakeApi();
    const r = await mount(api);
    const ev = { preventDefault: vi.fn() };
    await act(async () => { byId(r, "row-a").props.onContextMenu(ev); });
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(has(r, "quick")).toBe(true);
    await act(async () => { byId(r, "quick-approve").props.onClick(); });
    await flush();
    expect(api.approve).toHaveBeenCalledWith("a", "main", "current");
    expect(text(byId(r, "toast"))).toContain("Approved");
    const img = r.root.findAll((n) => n.type === "img")[0];
    expect(img.props.draggable).toBe(false);
    expect(img.props.style.WebkitTouchCallout).toBe("none");
    await act(async () => { byId(r, "row-c").props.onContextMenu({ preventDefault() {} }); });
    await act(async () => { byId(r, "quick-generate").props.onClick(); });
    await flush();
    expect(api.generate).toHaveBeenCalledWith("c", "main", expect.any(Object));
  });

  it("Approve and Reject each offer Undo; Approve all 30+ undoes exactly the products it approved; the toast clears after 6 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeApi();
    const r = await mount(api);
    await act(async () => { byId(r, "reject-a").props.onClick(); });
    await flush();
    expect(text(byId(r, "toast"))).toContain("Rejected Item a");
    await act(async () => { byId(r, "approve-big").props.onClick(); });
    await flush();
    await act(async () => { byId(r, "toast-undo").props.onClick(); });
    expect(api.undo).toHaveBeenCalledWith({ a: { prev: null, expectAt: 9 }, b: { prev: null, expectAt: 9 } });
    await act(async () => { byId(r, "approve-c").props.onClick(); });
    await flush();
    expect(has(r, "toast")).toBe(true);
    await act(async () => { vi.advanceTimersByTime(6100); });
    expect(has(r, "toast")).toBe(false);
    vi.useRealTimers();
  });

  it("the bar and the toast never cover the last row: the page keeps room for both", async () => {
    const r = await mount(fakeApi());
    const page = r.root.findAll((n) => n.type === "div" && n.props.style && typeof n.props.style.padding === "string" && n.props.style.minHeight === "100vh")[0];
    const bottom = Number(page.props.style.padding.split(" ")[2].replace("px", ""));
    expect(bottom).toBeGreaterThanOrEqual(64 + 64);
    expect(page.props.style.paddingBottom).toContain("safe-area-inset-bottom");
  });

  it("a long-press that starts on a button is that button's tap, never the popup; the click after a long-press is swallowed", async () => {
    const api = fakeApi();
    const r = await mount(api);
    const onButton = { preventDefault() {}, target: { closest: (sel) => (sel === "button" ? {} : null) } };
    await act(async () => { byId(r, "row-a").props.onContextMenu(onButton); });
    expect(has(r, "quick")).toBe(false);
    await act(async () => { byId(r, "select-toggle").props.onClick(); });
    await act(async () => { byId(r, "row-c").props.onContextMenu({ preventDefault() {}, target: { closest: () => null } }); });
    await act(async () => { byId(r, "row-c").props.onClick(); });
    expect(has(r, "select-bar")).toBe(false, "the click that followed the long-press did not tick the row");
  });

  it("the selection clears on a tab switch; bulk Generate never queues the same product twice", async () => {
    const api = fakeApi();
    const r = await mount(api);
    await act(async () => { byId(r, "select-toggle").props.onClick(); });
    await act(async () => { byId(r, "row-a").props.onClick(); });
    await act(async () => { byId(r, "tab-approved").props.onClick(); });
    expect(has(r, "select-bar")).toBe(false);
  });

  it("a failed generation says 'Failed, tap to retry', and the tap generates again", async () => {
    const api = fakeApi({ list: vi.fn(async () => view({ review: [row("a", 45, { failed: { at: 1, reason: "echo" } })] })) });
    const r = await mount(api);
    expect(text(byId(r, "failed-a"))).toBe("Failed, tap to retry");
    await act(async () => { byId(r, "failed-a").props.onClick({ stopPropagation() {} }); });
    await flush();
    expect(api.generate).toHaveBeenCalledWith("a", "main", expect.any(Object));
  });
});

describe("Black Friday card: the selection is never lost", () => {
  const many = (n) => Array.from({ length: n }, (_, i) => row(`p${i}`, 20));
  it("every tick is saved; a saved selection comes back ticked on load", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeApi({ selSave: vi.fn(async () => ({ ok: true })) });
    const r = await mount(api);
    await act(async () => { byId(r, "select-toggle").props.onClick(); });
    await act(async () => { byId(r, "row-a").props.onClick(); });
    await act(async () => { vi.advanceTimersByTime(1000); });
    await flush();
    expect(api.selSave).toHaveBeenLastCalledWith({ a: "current" }, null);
    vi.useRealTimers();
    const api2 = fakeApi({ selSave: vi.fn(async () => ({ ok: true })), list: vi.fn(async () => ({ ...view(), selection: { at: 1, sigs: { a: "current", b: "current" } } })) });
    const r2 = await mount(api2);
    expect(text(byId(r2, "select-count"))).toContain("2 selected");
    expect(byId(r2, "sel-b").props["aria-checked"]).toBe(true);
    expect(isUpdateBusy(), "no auto-reload onto a new deploy while anything is ticked").toBe(true);
    await act(async () => { byId(r2, "bulk-clear").props.onClick(); });
    expect(isUpdateBusy()).toBe(false);
  });

  it("a Recovered selection shows on its own, all ticked, with one Approve all", async () => {
    const api = fakeApi({ selSave: vi.fn(async () => ({ ok: true })), list: vi.fn(async () => ({ ...view(), selection: { at: 1, label: "Recovered selection", sigs: { a: "current", c: "current" } } })) });
    const r = await mount(api);
    expect(text(byId(r, "recovered"))).toContain("Recovered selection (2)");
    expect(has(r, "row-b")).toBe(false);
    expect(text(byId(r, "bulk-approve"))).toBe("Approve all");
    await act(async () => { byId(r, "row-c").props.onClick(); }); // untick a mistake
    await act(async () => { byId(r, "bulk-approve").props.onClick(); });
    await flush();
    expect(api.approveMany).toHaveBeenCalledWith({ a: "current" });
  });

  it("574 go in chunks with progress; a failure keeps the rest selected and says what failed; Undo covers every chunk", async () => {
    let calls = 0;
    const approveMany = vi.fn(async (sigs) => {
      calls += 1;
      if (calls === 3) throw new Error("network lost");
      return { ok: true, done: Object.keys(sigs), refused: [], undo: Object.fromEntries(Object.keys(sigs).map((p) => [p, { prev: null, expectAt: 1 }])) };
    });
    const rows = many(574);
    const api = fakeApi({ approveMany, list: vi.fn(async () => ({ ...view({ review: rows }), selection: { at: 1, sigs: Object.fromEntries(rows.map((x) => [x.pid, "current"])) } })) });
    const r = await mount(api);
    expect(text(byId(r, "select-count"))).toContain("574 selected");
    await act(async () => { byId(r, "bulk-approve").props.onClick(); });
    await flush();
    expect(approveMany).toHaveBeenCalledTimes(3);
    expect(Object.keys(approveMany.mock.calls[0][0]).length).toBe(100);
    expect(text(byId(r, "select-count"))).toContain("374 selected");
    expect(text(byId(r, "bulk-note"))).toContain("Approved 200 of 574, then it stopped: network lost");
    await act(async () => { byId(r, "toast-undo").props.onClick(); });
    await flush();
    expect(Object.keys(api.undo.mock.calls[0][0]).length).toBe(200);
  });
});

describe("Black Friday card: New Arrivals tab, Approved split, Repost (Junid, 20 Nov)", () => {
  const UP = Date.parse("2026-11-18T10:00:00+02:00");
  const naRow = (pid, over = {}) => row(pid, 4, { tab: "newArrivals", na: true, src: "na", uploadedAt: UP, canGenerate: true, ...over });
  const naView = () => view({
    newArrivals: [naRow("n1", { naStudio: true }), naRow("n2", { kind: "headwear", naStudio: false }), naRow("n3", { use: "generated", generatedUrl: "https://x/g.jpg", genId: "g1795100000000", sig: "g1795100000000", generations: 1 })],
    approved: [row("d", 15, { tab: "approved", na: true, postedN: 2, postedLast: UP }), row("e", 40, { tab: "approved" })],
    totals: { review: 3, approved: 2, rejected: 0, spentZar: 0, newArrivals: 3, approvedNa: 1, approvedNormal: 1 },
  });
  const api = (over = {}) => fakeApi({ list: vi.fn(async () => naView()), generateNa: vi.fn(async () => ({ ok: true })), repost: vi.fn(async (pids) => ({ ok: true, done: pids, refused: [] })), selSave: vi.fn(async () => ({ ok: true })), ...over });

  it("opens on New Arrivals (three tabs with counts); each row shows its upload date; a new 13+ product is not in To review", async () => {
    const r = await mount(api());
    expect(text(byId(r, "tab-new"))).toBe("New Arrivals (3)");
    expect(byId(r, "tab-new").props["aria-pressed"]).toBe(true);
    expect(text(byId(r, "block-na"))).toContain("(3)");
    expect(text(byId(r, "uploaded-n1"))).toMatch(/^Uploaded 18 Nov/);
    expect(has(r, "block-big")).toBe(false);
  });

  it("New Arrivals controls: Approve, Use current photo (= approve with the app photo, with Undo), Generate through New Arrivals' studio; any other kind through Black Friday's Generate", async () => {
    const a = api();
    const r = await mount(a);
    await act(async () => { byId(r, "use-current-n1").props.onClick(); });
    await flush();
    expect(a.approve).toHaveBeenCalledWith("n1", "main", "current");
    expect(has(r, "toast-undo")).toBe(true);
    await act(async () => { byId(r, "approve-n3").props.onClick(); });
    expect(a.approve).toHaveBeenCalledWith("n3", "main", "g1795100000000");
    await act(async () => { byId(r, "generate-n1").props.onClick(); });
    await flush();
    expect(a.generateNa).toHaveBeenCalledWith("n1", expect.anything());
    expect(a.generate).not.toHaveBeenCalled();
    await act(async () => { byId(r, "generate-n2").props.onClick(); });
    await flush();
    expect(a.generate).toHaveBeenCalledWith("n2", "main", expect.anything());
    expect(rowActions(naRow("x"))).toMatchObject({ approve: true, useCurrent: true, useCurrentPrimary: true, backToReview: false });
  });

  it("Approved shows New Arrivals and Normal with counts; a posted product stays with 'Posted 2× · last'; multi-select Repost queues it", async () => {
    const a = api();
    const r = await mount(a);
    await act(async () => { byId(r, "tab-approved").props.onClick(); });
    expect(text(byId(r, "approved-split"))).toContain("New Arrivals 1 · Normal 1");
    expect(text(byId(r, "block-appr-na"))).toContain("New Arrivals (1)");
    expect(text(byId(r, "block-appr-normal"))).toContain("Normal (1)");
    expect(text(byId(r, "posted-d"))).toMatch(/^Posted 2× · last 18 Nov/);
    await act(async () => { byId(r, "select-toggle").props.onClick(); });
    await act(async () => { byId(r, "row-d").props.onClick(); });
    expect(has(r, "bulk-approve")).toBe(false);
    await act(async () => { byId(r, "bulk-repost").props.onClick(); });
    await flush();
    expect(a.repost).toHaveBeenCalledWith(["d"]);
  });
});

describe("Black Friday card: Junid's own photo, Find online, R0 guard (Junid, 20 Nov)", () => {
  const SRC = "g1795200000000", AI = "g1795100000000";
  const withSrc = (over = {}) => row("s", 20, { kind: "headwear", use: "generated", genId: SRC, sig: SRC, srcId: SRC, srcUrl: "https://x/src.jpg", shown: "https://x/src.jpg", shownFrom: "upload",
    gallery: [{ id: "app", url: "https://x/s.jpg", label: "App photo" }, { id: SRC, url: "https://x/src.jpg", label: "Your photo" }], ...over });
  const cand = { imageUrl: "https://shop.example/p.jpg", pageUrl: "https://shop.example/p", site: "shop.example", width: 1200, height: 1200, thumb: "data:image/jpeg;base64,AA" };
  const api = (rows, over = {}) => fakeApi({ list: vi.fn(async () => view({ review: rows })), selSave: vi.fn(async () => ({ ok: true })),
    photoUpload: vi.fn(async () => ({ ok: true, id: SRC })), findOnline: vi.fn(async () => ({ ok: true, query: "New Era cap", candidates: [cand], entryPoint: "<div>g</div>" })),
    pickOnline: vi.fn(async () => ({ ok: true, id: SRC })), ...over });

  it("R0: 'No price, set price first' instead of Approve; bulk/quick approve not offered for it", async () => {
    const a = api([row("z", 20, { price: 0, noPrice: true }), row("a", 20)]);
    const r = await mount(a);
    expect(has(r, "approve-z")).toBe(false);
    expect(text(byId(r, "noprice-z"))).toBe("No price, set price first");
    expect(has(r, "approve-a")).toBe(true);
    expect(rowActions(row("z", 1, { tab: "newArrivals", noPrice: true }))).toMatchObject({ approve: false, useCurrent: false, noPrice: true });
  });

  it("R0 approvals are listed on their own on the Approved tab, never among what posts", async () => {
    const a = fakeApi({ list: vi.fn(async () => view({ approved: [row("d", 15, { tab: "approved" }), row("z", 15, { tab: "approved", price: 0, noPrice: true })] })) });
    const r = await mount(a);
    await act(async () => { byId(r, "tab-approved").props.onClick(); });
    expect(text(byId(r, "block-noprice"))).toContain("(1)");
    expect(text(byId(r, "block-noprice"))).toContain("Item z");
    expect(text(byId(r, "block-appr-normal"))).not.toContain("Item z");
  });

  it("Replace photo opens the phone's picker and uploads the picked photo for that product", async () => {
    const a = api([row("a", 20)]);
    const r = await mount(a);
    const input = byId(r, "replace-input");
    expect(input.props.accept).toBe("image/*");
    expect(input.props.capture).toBeUndefined();
    await act(async () => { byId(r, "replace-a").props.onClick(); });
    const file = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
    await act(async () => { await input.props.onChange({ target: { files: [file] } }); });
    await flush();
    expect(a.photoUpload).toHaveBeenCalledWith("a", "/9j/");
    expect(a.list.mock.calls.length).toBeGreaterThan(1); // the card re-reads: the row shows his photo
  });

  it("with his photo: the badge says YOURS, Generate says 'from your photo', the photo viewer swipes app ↔ his photo and 'Use this photo' brings the app photo back", async () => {
    const a = api([withSrc()]);
    const r = await mount(a);
    expect(text(byId(r, "badge-s"))).toBe("YOURS");
    expect(text(byId(r, "generate-s"))).toBe("Generate from your photo");
    expect(has(r, "use-current-s")).toBe(false); // already showing his photo
    await act(async () => { byId(r, "thumb-s").props.onClick({ stopPropagation() {} }); });
    expect(text(byId(r, "viewer-label"))).toContain("Your photo");
    expect(text(byId(r, "viewer-label"))).toContain("showing");
    await act(async () => { byId(r, "viewer-prev").props.onClick(); });
    expect(text(byId(r, "viewer-label"))).toContain("App photo");
    await act(async () => { byId(r, "viewer-use").props.onClick(); });
    await flush();
    expect(a.use).toHaveBeenCalledWith("s", "current", null, "main", { app: true, approve: false });
  });

  it("after Generate from his photo: Use current photo (= his photo) switches back to it; Use AI photo is offered when his photo shows", async () => {
    const a = api([withSrc({ genId: AI, sig: AI, aiGenId: AI, generations: 1, shown: "https://x/ai.jpg", shownFrom: "ai" })]);
    const r = await mount(a);
    await act(async () => { byId(r, "use-current-s").props.onClick(); });
    await flush();
    expect(a.use).toHaveBeenCalledWith("s", "generated", SRC, "main");
    expect(rowActions(withSrc({ aiGenId: AI, generations: 1 }))).toMatchObject({ useAi: true, useCurrent: false, regenerate: true });
  });

  it("Find online: nothing is used until a candidate is tapped; the site shows under each; Google's suggestions are shown", async () => {
    const a = api([row("a", 20)]);
    const r = await mount(a);
    await act(async () => { byId(r, "find-a").props.onClick(); });
    await flush();
    expect(a.findOnline).toHaveBeenCalledWith("a");
    expect(a.pickOnline).not.toHaveBeenCalled();
    expect(text(byId(r, "cand-site-0"))).toBe("shop.example");
    expect(has(r, "find-google")).toBe(true);
    await act(async () => { byId(r, "cand-0").props.onClick(); });
    await flush();
    expect(a.pickOnline).toHaveBeenCalledWith("a", cand);
    expect(has(r, "find")).toBe(false);
  });

  it("Approved tab: 'Use this photo' in the viewer approves the picked photo in the same tap", async () => {
    const a = fakeApi({ list: vi.fn(async () => view({ approved: [withSrc({ tab: "approved", genId: AI, sig: AI, shownFrom: "ai", gallery: [{ id: "app", url: "u0", label: "App photo" }, { id: SRC, url: "u1", label: "Your photo" }, { id: AI, url: "u2", label: "AI" }] })] })) });
    const r = await mount(a);
    await act(async () => { byId(r, "tab-approved").props.onClick(); });
    await act(async () => { byId(r, "thumb-s").props.onClick({ stopPropagation() {} }); });
    await act(async () => { byId(r, "viewer-prev").props.onClick(); });
    expect(text(byId(r, "viewer-use"))).toBe("Use this photo (approves it)");
    await act(async () => { byId(r, "viewer-use").props.onClick(); });
    await flush();
    expect(a.use).toHaveBeenCalledWith("s", "generated", SRC, "main", { approve: true });
  });

  it("shownId names the photo a row shows", () => {
    expect(shownId(row("a", 1))).toBe("app");
    expect(shownId(withSrc())).toBe(SRC);
    expect(shownId(row("n", 1, { tab: "newArrivals", generatedUrl: "u" }))).toBe("na");
    expect(shownId(row("n", 1, { tab: "newArrivals", bfPhoto: true, use: "generated", sig: SRC }))).toBe(SRC);
  });
});
