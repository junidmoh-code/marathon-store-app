// ─── ACTIVE STORE LAYER — the modal and the banner ───────────────────────────
// Run: npx vitest run src/components/ActiveStoreLayer.test.jsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

vi.mock("../utils/serverTime", () => ({ saDateString: () => "2026-11-20", serverNowMs: () => 1 }));
const S = await import("../utils/activeStore.js");
const { default: ActiveStoreLayer } = await import("./ActiveStoreLayer.jsx");

const byId = (tree, id) => tree.root.findAll((n) => n.props?.["data-testid"] === id && typeof n.type === "string");
const text = (node) => {
  const walk = (n) => (typeof n === "string" ? n : (n.children || []).map(walk).join(""));
  return walk(node).replace(/\s+/g, " ").trim();
};

let log;
beforeEach(() => {
  S.__resetActiveStoreForTests();
  log = vi.fn(async () => ({}));
  const m = new Map();
  S.__setActiveStoreDepsForTests({ storage: { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }, log, today: () => "2026-11-20" });
  S.bindActiveStore({ uid: "u1", homeShop: "marathon-pe", signIn: "s" });
});

async function mount() {
  let tree;
  await act(async () => { tree = TestRenderer.create(<ActiveStoreLayer><div>screen</div></ActiveStoreLayer>); });
  return tree;
}

describe("switch confirmation modal", () => {
  it("shows the exact warning for MARATHON PE → CONCRETE", async () => {
    const tree = await mount();
    expect(byId(tree, "store-switch-modal")).toHaveLength(0);
    await act(async () => { S.requestSwitch("concrete"); });
    const modal = byId(tree, "store-switch-modal")[0];
    const t = text(modal);
    expect(t).toContain("Switching store");
    expect(t).toContain("You are leaving MARATHON PE and working in CONCRETE.");
    expect(t).toContain("Everything you pick, check, hand over or order will count for CONCRETE.");
    expect(text(byId(tree, "store-switch-confirm")[0])).toBe("Yes, switch to CONCRETE");
    expect(text(byId(tree, "store-switch-cancel")[0])).toBe("Cancel");
  });

  it("Cancel changes nothing", async () => {
    const tree = await mount();
    await act(async () => { S.requestSwitch("concrete"); });
    await act(async () => { byId(tree, "store-switch-cancel")[0].props.onClick(); });
    expect(byId(tree, "store-switch-modal")).toHaveLength(0);
    expect(S.getActiveStore().activeShop).toBe("marathon-pe");
    expect(byId(tree, "store-away-banner")).toHaveLength(0);
  });

  it("a tap on the backdrop changes nothing; a tap inside the card does not dismiss", async () => {
    const tree = await mount();
    await act(async () => { S.requestSwitch("trophy"); });
    const modal = byId(tree, "store-switch-modal")[0];
    const card = modal.children[0];
    let stopped = false;
    await act(async () => { card.props.onClick({ stopPropagation: () => { stopped = true; } }); });
    expect(stopped).toBe(true);
    expect(byId(tree, "store-switch-modal")).toHaveLength(1);
    await act(async () => { modal.props.onClick(); });
    expect(byId(tree, "store-switch-modal")).toHaveLength(0);
    expect(S.getActiveStore().activeShop).toBe("marathon-pe");
  });
});

describe("working-away banner", () => {
  it("appears after a confirmed switch and goes home in one tap", async () => {
    const tree = await mount();
    await act(async () => { S.requestSwitch("concrete"); });
    await act(async () => { byId(tree, "store-switch-confirm")[0].props.onClick(); });
    const banner = byId(tree, "store-away-banner")[0];
    expect(text(banner)).toContain("Working in CONCRETE (your store: MARATHON PE)");
    expect(text(byId(tree, "store-back-home")[0])).toBe("Back to MARATHON PE");
    await act(async () => { byId(tree, "store-back-home")[0].props.onClick(); });
    expect(byId(tree, "store-away-banner")).toHaveLength(0);
    expect(byId(tree, "store-switch-modal")).toHaveLength(0);
    expect(S.getActiveStore().activeShop).toBe("marathon-pe");
  });

  it("is not shown at home", async () => {
    const tree = await mount();
    expect(byId(tree, "store-away-banner")).toHaveLength(0);
  });
});
