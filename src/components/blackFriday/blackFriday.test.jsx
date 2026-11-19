// Black Friday card — what it shows and the taps it makes, against the view
// shape bfCampaignList returns (functions/blackFriday/core.cjs viewCampaign).
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import BlackFridayScreen, { actionsFor } from "./BlackFridayScreen";

const item = (pid, n, over = {}) => ({ pid, n, name: `Item ${pid}`, sizes: "M-XL", qty: 13 + n, photo: `https://x/${pid}.jpg`, excluded: false, newSinceApproval: false, ...over });
const grp = (key, status, over = {}) => ({ key, label: key, price: Number(key.slice(1).split("-")[0]), part: 1, parts: 1, count: 2, included: 2, status, approvedAt: status === "waiting" ? null : 5, newSinceApproval: 0,
  caption: `BLACK FRIDAY 🔥 ${key} EACH\n1. Item a — sizes M-XL\n2. Item b — sizes M-XL\nMessage us to order.`, items: [item("a", 1), item("b", 2)], post: null, ...over });
const view = () => ({ groups: [grp("R300", "waiting"), grp("R650", "approved"), grp("R700", "partly sold out", { post: { at: 1, status: "posted", posted: 1, dropped: [{ pid: "b", name: "Item b", why: "sold out" }] } })],
  counts: { waiting: 1, approved: 1, "partly sold out": 1 }, meta: { builtAt: 1, eligible: 6, groupCount: 3, noPhotoCount: 1, noPhoto: [{ pid: "z", name: "No pic", qty: 20 }] } });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const text = (node) => (typeof node === "string" ? node : (node.children || []).map(text).join(""));
const byId = (r, id) => r.root.find((n) => n.props && n.props["data-testid"] === id);
const has = (r, id) => r.root.findAll((n) => n.props && n.props["data-testid"] === id).length > 0;

function fakeApi(over = {}) {
  return {
    list: vi.fn(async () => view()),
    approve: vi.fn(async (key) => ({ ok: true, key, group: grp(key, "approved") })),
    approveAll: vi.fn(async (keys) => ({ ok: true, results: keys.map((k) => ({ ok: true, key: k, group: grp(k, "approved") })) })),
    unapprove: vi.fn(async (key) => ({ ok: true, key, group: grp(key, "waiting") })),
    tick: vi.fn(async (key, pid, include) => ({ ok: true, key, group: grp(key, "waiting", { included: include ? 2 : 1, items: [item("a", 1, { excluded: !include }), item("b", 2)] }) })),
    ...over,
  };
}

describe("Black Friday card", () => {
  it("buttons per status", () => {
    expect(actionsFor({ status: "waiting" })).toMatchObject({ approve: true, undo: false, canTick: true });
    expect(actionsFor({ status: "approved", newSinceApproval: 0 })).toMatchObject({ approve: false, undo: true, canTick: true });
    expect(actionsFor({ status: "approved", newSinceApproval: 2 }).approve).toBe(true);
    expect(actionsFor({ status: "posted" })).toMatchObject({ approveAgain: true, canTick: false, undo: false });
  });

  it("one row per price group with its status, caption and the no-photo list; stock price only", async () => {
    let r;
    await act(async () => { r = TestRenderer.create(<BlackFridayScreen api={fakeApi()} onExit={() => {}} />); });
    await flush();
    expect(text(byId(r, "status-R300"))).toBe("Waiting for you");
    expect(text(byId(r, "status-R650"))).toBe("Approved — queued");
    expect(text(byId(r, "status-R700"))).toBe("Posted — partly sold out");
    expect(text(byId(r, "dropped-R700"))).toContain("Item b (sold out)");
    expect(text(byId(r, "caption-R300"))).toContain("BLACK FRIDAY 🔥 R300 EACH");
    expect(text(byId(r, "no-photo"))).toContain("No pic — 20 on hand");
    expect(JSON.stringify(r.toJSON()).toLowerCase()).not.toContain("retail");
    expect(has(r, "undo-R650")).toBe(true);
    expect(has(r, "approve-R650")).toBe(false);
  });

  it("Approve, Approve All (waiting groups only), untick", async () => {
    const api = fakeApi();
    let r;
    await act(async () => { r = TestRenderer.create(<BlackFridayScreen api={api} onExit={() => {}} />); });
    await flush();
    await act(async () => { byId(r, "item-R300-a").props.onClick(); });
    expect(api.tick).toHaveBeenCalledWith("R300", "a", false);
    await act(async () => { byId(r, "approve-all").props.onClick(); });
    expect(api.approveAll).toHaveBeenCalledWith(["R300"]);
    expect(text(byId(r, "status-R300"))).toBe("Approved — queued");
    expect(has(r, "approve-all")).toBe(false);
  });

  it("a refusal is shown, not swallowed", async () => {
    const api = fakeApi({ approve: vi.fn(async (key) => ({ ok: false, key, refusal: "every item is unticked — tick at least one" })) });
    let r;
    await act(async () => { r = TestRenderer.create(<BlackFridayScreen api={api} onExit={() => {}} />); });
    await flush();
    await act(async () => { byId(r, "approve-R300").props.onClick(); });
    expect(text(byId(r, "note"))).toContain("every item is unticked");
  });

  it("a failed tap shows the error AND re-reads (part of Approve All may have gone through); Refresh re-reads", async () => {
    const api = fakeApi({ approveAll: vi.fn(async () => { throw new Error("R650: internal"); }) });
    let r;
    await act(async () => { r = TestRenderer.create(<BlackFridayScreen api={api} onExit={() => {}} />); });
    await flush();
    expect(api.list).toHaveBeenCalledTimes(1);
    api.list.mockImplementationOnce(async () => ({ ...view(), groups: [grp("R300", "approved"), ...view().groups.slice(1)] }));
    await act(async () => { byId(r, "approve-all").props.onClick(); });
    await flush();
    expect(text(byId(r, "note"))).toContain("R650: internal");
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(text(byId(r, "status-R300"))).toBe("Approved — queued");
    await act(async () => { byId(r, "refresh").props.onClick(); });
    await flush();
    expect(api.list).toHaveBeenCalledTimes(3);
  });

  it("thumbnails keep the browser focus ring (no all:unset)", async () => {
    let r;
    await act(async () => { r = TestRenderer.create(<BlackFridayScreen api={fakeApi()} onExit={() => {}} />); });
    await flush();
    expect(byId(r, "item-R300-a").props.style.all).toBeUndefined();
  });
});
