// Black Friday card v3 — one row per product, two tabs, reject persists,
// Approve all 30+, under-13 switch, schedule behind "Schedule posting".
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import BlackFridayScreen, { rowActions } from "./BlackFridayScreen";

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
    approve: vi.fn(async (pid) => ({ ok: true, pid, row: row(pid, 45, { tab: "approved" }) })),
    reject: vi.fn(async (pid) => ({ ok: true, pid, rejected: true, row: null })),
    reset: vi.fn(async (pid) => ({ ok: true, pid, row: row(pid, 45) })),
    use: vi.fn(async (pid) => ({ ok: true, pid, row: row(pid, 45) })),
    approveBig: vi.fn(async () => ({ ok: true, approved: 2 })),
    approveStyle: vi.fn(async () => ({ ok: true })),
    schedule: vi.fn(async (s, { confirm }) => ({ ok: true, preview: !confirm, plan: [{ album: "R300-clothing-1", label: "R300 Clothing", due: Date.parse("2026-11-20T09:00:00+02:00"), count: 2 }], albums: 1 })),
    clearSchedule: vi.fn(async () => ({ ok: true })),
    generate: vi.fn(async () => ({ ok: true })),
    ...over,
  };
}
async function mount(api) { let r; await act(async () => { r = TestRenderer.create(<BlackFridayScreen api={api} onExit={() => {}} />); }); await flush(); return r; }

describe("Black Friday card v3", () => {
  it("row buttons: Approve never greyed out on a generated photo; a new kind defaults to Use current photo but still allows Generate", () => {
    const g = row("a", 40, { use: "generated", generations: 1, genId: "g1", generatedUrl: "u" });
    expect(rowActions(g)).toMatchObject({ approve: true, approveDisabled: false, useCurrent: true, regenerate: true });
    expect(rowActions({ ...g, generating: true }).approveDisabled).toBe(true);
    const cap = row("c", 20, { kind: "headwear", styleApproved: false });
    expect(rowActions(cap)).toMatchObject({ useCurrent: true, useCurrentPrimary: true, generate: true, approveLook: false });
    expect(rowActions({ ...cap, generations: 1, use: "generated", generatedUrl: "u" }).approveLook).toBe(true);
    expect(rowActions(row("d", 15, { tab: "approved" }))).toMatchObject({ approve: false, backToReview: true, reject: true });
  });

  it("short totals; two tabs with counts; 30+ block first with Approve all 30+, then 13–29; no badges, no chips, no schedule on the main view", async () => {
    const r = await mount(fakeApi());
    expect(text(byId(r, "totals"))).toBe("To review 4605 · Approved 1 · AI spend R12.50");
    expect(text(byId(r, "tab-review"))).toBe("To review (3)");
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
    expect(api.approve).toHaveBeenCalledWith("a", "main");
    await act(async () => { byId(r, "reject-b").props.onClick(); });
    expect(api.reject).toHaveBeenCalledWith("b", "main");
    await act(async () => { byId(r, "approve-big").props.onClick(); });
    expect(api.approveBig).toHaveBeenCalled();
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

  it("the schedule only appears behind Schedule posting on the Approved tab; the plan shows before confirming", async () => {
    const api = fakeApi();
    const r = await mount(api);
    await act(async () => { byId(r, "tab-approved").props.onClick(); });
    expect(text(byId(r, "no-schedule"))).toContain("Nothing posts");
    await act(async () => { byId(r, "schedule-posting").props.onClick(); });
    await act(async () => { byId(r, "show-plan").props.onClick(); });
    await flush();
    expect(api.schedule).toHaveBeenCalledWith(expect.objectContaining({ mode: "spread" }), { confirm: false });
    expect(text(byId(r, "plan"))).toContain("R300 Clothing");
    await act(async () => { byId(r, "confirm-schedule").props.onClick(); });
    expect(api.schedule).toHaveBeenLastCalledWith(expect.anything(), { confirm: true });
  });

  it("a new kind's AI look can be approved from a product that has one", async () => {
    const api = fakeApi({ list: vi.fn(async () => view({ review: [row("c", 20, { kind: "headwear", styleApproved: false, generations: 1, use: "generated", generatedUrl: "u" })] })) });
    const r = await mount(api);
    await act(async () => { byId(r, "look-c").props.onClick(); });
    expect(api.approveStyle).toHaveBeenCalledWith("headwear");
  });

  it("a failed tap shows the error and re-reads", async () => {
    const api = fakeApi({ approve: vi.fn(async () => { throw new Error("internal"); }) });
    const r = await mount(api);
    await act(async () => { byId(r, "approve-a").props.onClick(); });
    await flush();
    expect(text(byId(r, "note"))).toContain("internal");
    expect(api.list.mock.calls.filter((c) => c[0] === "main").length).toBe(2);
  });
});
