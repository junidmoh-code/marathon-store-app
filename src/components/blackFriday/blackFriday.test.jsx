// Black Friday card — what it shows and the taps it makes, against the view
// shape bfCampaignList returns (functions/blackFriday/core.cjs viewCampaign).
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import BlackFridayScreen, { actionsFor, itemActions, itemMatches } from "./BlackFridayScreen";

const item = (pid, n, over = {}) => ({ pid, n, name: `Item ${pid}`, sizes: "M-XL", qty: 13 + n, photo: `https://x/${pid}.jpg`, shown: `https://x/${pid}.jpg`, na: false,
  excluded: false, use: "current", generatedUrl: null, genId: null, generations: 0, generating: false, approved: false, changedSinceApproval: false, ...over });
const grp = (key, status, over = {}) => ({ key, label: key.split("-")[0], price: Number(key.slice(1).split("-")[0]), division: key.includes("sneakers") ? "sneakers" : "clothing", part: 1, parts: 1,
  count: 2, included: 2, approvedCount: status === "waiting" ? 0 : 2, status, approvedAt: status === "waiting" ? null : 5, dueAt: null,
  caption: `BLACK FRIDAY 🔥 ${key.split("-")[0]} EACH\n1. Item a — sizes M-XL\nMessage us to order.`,
  items: status === "waiting" ? [item("a", 1), item("b", 2)] : [item("a", 1, { approved: true }), item("b", 2, { approved: true })], post: null, ...over });
const view = (over = {}) => ({
  groups: [
    grp("R300-clothing", "waiting", { items: [item("a", 1), item("b", 2, { use: "generated", generations: 1, genId: "g1", generatedUrl: "https://x/b-g1.png", shown: "https://x/b-g1.png" })] }),
    grp("R300-sneakers", "approved", { dueAt: Date.parse("2026-11-20T09:00:00+02:00"), items: [item("c", 1, { approved: true }), item("d", 2, { approved: true })] }),
  ],
  counts: { waiting: 1, approved: 1 },
  totals: { products: 4, photos: 4, groups: 2, aiPhotos: 1, approved: 2, waiting: 2, spentZar: 12.5 },
  schedule: null, postingPaused: false,
  meta: { builtAt: 1, eligible: 3, newArrivals: 1, groupCount: 2, noPhotoCount: 1, noPhoto: [{ pid: "z", name: "No pic", qty: 20 }] },
  ...over,
});
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const text = (node) => (typeof node === "string" ? node : (node.children || []).map(text).join(""));
const byId = (r, id) => r.root.find((n) => n.props && n.props["data-testid"] === id && typeof n.type === "string");
const has = (r, id) => r.root.findAll((n) => n.props && n.props["data-testid"] === id).length > 0;

function fakeApi(over = {}) {
  return {
    list: vi.fn(async () => view()),
    approve: vi.fn(async (key) => ({ ok: true, key, group: grp(key, "approved") })),
    approveItem: vi.fn(async (key) => ({ ok: true, key, group: grp(key, "approved") })),
    approveAll: vi.fn(async (keys) => ({ ok: true, results: keys.map((k) => ({ ok: true, key: k, group: grp(k, "approved") })) })),
    unapprove: vi.fn(async (key) => ({ ok: true, key, group: grp(key, "waiting") })),
    tick: vi.fn(async (key) => ({ ok: true, key, group: grp(key, "waiting") })),
    use: vi.fn(async (key) => ({ ok: true, key, group: grp(key, "waiting") })),
    schedule: vi.fn(async (s, { confirm }) => ({ ok: true, preview: !confirm, schedule: s, queued: 1, plan: { "R300-sneakers": Date.parse("2026-11-20T09:00:00+02:00") } })),
    clearSchedule: vi.fn(async () => ({ ok: true, cleared: true })),
    generate: vi.fn(async (key, pid, { onEvent }) => { onEvent({ type: "status", text: "Reading the original photo…" }); return { ok: true, pid, genId: "g2" }; }),
    ...over,
  };
}
async function mount(api) {
  let r;
  await act(async () => { r = TestRenderer.create(<BlackFridayScreen api={api} onExit={() => {}} />); });
  await flush();
  return r;
}

describe("Black Friday card", () => {
  it("APPROVE IS NEVER GREYED OUT ON A GENERATED PHOTO", () => {
    const gen = item("b", 1, { use: "generated", generations: 1, genId: "g1", generatedUrl: "u" });
    expect(itemActions(gen, true).approve).toBe(true);
    expect(itemActions(gen, true).approveDisabled).toBe(false);
    expect(itemActions({ ...gen, changedSinceApproval: true }, true).approve).toBe(true);
    expect(itemActions({ ...gen, approved: true }, true).approve).toBe(false);
    expect(itemActions({ ...gen, generating: true }, true).approveDisabled).toBe(true);
  });

  it("item buttons: Use current photo / Generate / Regenerate", () => {
    expect(itemActions(item("a", 1), true)).toMatchObject({ generate: true, regenerate: false, useCurrent: false, useGenerated: false });
    expect(itemActions(item("a", 1, { generations: 1, use: "generated", generatedUrl: "u" }), true)).toMatchObject({ generate: false, regenerate: true, useCurrent: true });
    expect(itemActions(item("a", 1, { generations: 1, use: "current", generatedUrl: "u" }), true)).toMatchObject({ useGenerated: true, useCurrent: false });
    expect(itemActions(item("a", 1), false)).toMatchObject({ approve: false, generate: false, tick: false });
  });

  it("filter chips", () => {
    const g = item("a", 1, { generations: 1 }), ng = item("b", 1), ap = item("c", 1, { approved: true }), ex = item("d", 1, { excluded: true });
    expect([g, ng, ap, ex].filter((x) => itemMatches(x, "generated")).map((x) => x.pid)).toEqual(["a"]);
    expect([g, ng, ap, ex].filter((x) => itemMatches(x, "notGenerated")).map((x) => x.pid)).toEqual(["b", "c", "d"]);
    expect([g, ng, ap, ex].filter((x) => itemMatches(x, "approved")).map((x) => x.pid)).toEqual(["c"]);
    expect([g, ng, ap, ex].filter((x) => itemMatches(x, "waiting")).map((x) => x.pid)).toEqual(["a", "b"]);
  });

  it("group buttons per status", () => {
    expect(actionsFor(grp("R300-clothing", "waiting"))).toMatchObject({ approveAll: true, undo: false, canEdit: true });
    expect(actionsFor(grp("R300-clothing", "approved"))).toMatchObject({ approveAll: false, undo: true });
    expect(actionsFor(grp("R300-clothing", "posted"))).toMatchObject({ approveAgain: true, canEdit: false });
  });

  it("totals at the top; no schedule says nothing will post; clothing and sneakers are separate rows", async () => {
    const r = await mount(fakeApi());
    expect(text(byId(r, "total-Products"))).toContain("4");
    expect(text(byId(r, "total-AI photos"))).toContain("1");
    expect(text(byId(r, "total-AI spend"))).toContain("R12.50");
    expect(text(byId(r, "no-schedule"))).toContain("nothing will post");
    expect(has(r, "group-R300-clothing") && has(r, "group-R300-sneakers")).toBe(true);
    expect(text(byId(r, "due-R300-sneakers"))).toContain("posts");
    expect(JSON.stringify(r.toJSON()).toLowerCase().includes("retail")).toBe(false);
  });

  it("taps: approve an item, approve all in a group, untick, use current photo, generate", async () => {
    const api = fakeApi();
    const r = await mount(api);
    await act(async () => { byId(r, "approve-item-b").props.onClick(); });
    expect(api.approveItem).toHaveBeenCalledWith("R300-clothing", "b");
    await flush();
    await act(async () => { byId(r, "approve-R300-clothing").props.onClick(); });
    expect(api.approve).toHaveBeenCalledWith("R300-clothing");
    await flush();
    await act(async () => { byId(r, "use-current-b").props.onClick(); });
    expect(api.use).toHaveBeenCalledWith("R300-clothing", "b", "current", null);
    await flush();
    await act(async () => { byId(r, "generate-a").props.onClick(); });
    await flush();
    expect(api.generate).toHaveBeenCalledWith("R300-clothing", "a", expect.any(Object));
    await act(async () => { byId(r, "tick-a").props.onClick(); });
    expect(api.tick).toHaveBeenCalledWith("R300-clothing", "a", false);
  });

  it("the chip hides groups with nothing matching", async () => {
    const r = await mount(fakeApi());
    await act(async () => { byId(r, "filter-generated").props.onClick(); });
    expect(has(r, "group-R300-clothing")).toBe(true);
    expect(has(r, "group-R300-sneakers")).toBe(false);
  });

  it("schedule: the plan is shown BEFORE confirming; confirm saves it", async () => {
    const api = fakeApi();
    const r = await mount(api);
    await act(async () => { byId(r, "mode-gap").props.onClick(); });
    await act(async () => { byId(r, "show-plan").props.onClick(); });
    await flush();
    expect(api.schedule).toHaveBeenCalledWith(expect.objectContaining({ mode: "gap", from: "08:00", to: "20:00", gapMin: 60 }), { confirm: false });
    expect(text(byId(r, "plan"))).toContain("R300");
    expect(api.schedule).toHaveBeenCalledTimes(1);
    await act(async () => { byId(r, "confirm-schedule").props.onClick(); });
    expect(api.schedule).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "gap" }), { confirm: true });
  });

  it("a confirmed schedule shows its summary and can be stopped; the posting pause is said plainly", async () => {
    const api = fakeApi({ list: vi.fn(async () => view({ postingPaused: true, schedule: { mode: "gap", start: Date.parse("2026-11-20T09:00:00+02:00"), from: "08:00", to: "20:00", gapMin: 45, confirmedAt: 1 } })) });
    const r = await mount(api);
    expect(text(byId(r, "schedule-summary"))).toContain("every 45 min");
    expect(text(byId(r, "paused"))).toContain("paused");
    await act(async () => { byId(r, "stop-schedule").props.onClick(); });
    expect(api.clearSchedule).toHaveBeenCalled();
  });

  it("a failed tap shows the error AND re-reads", async () => {
    const api = fakeApi({ approveAll: vi.fn(async () => { throw new Error("R650: internal"); }) });
    const r = await mount(api);
    await act(async () => { byId(r, "approve-all").props.onClick(); });
    await flush();
    expect(text(byId(r, "note"))).toContain("R650: internal");
    expect(api.list).toHaveBeenCalledTimes(2);
  });
});
