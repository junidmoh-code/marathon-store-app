// ─── ENGINE POLICY — "Concrete — clothing kept in the shop" ──────────────────
// The owner's one number (N per size, from Central — centralFed.js) is set on
// the Engine Policy card, through setCategoryPolicy's setCentralFed action,
// and shows in the policy history with a revert. No build to change it.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || {
  addEventListener() {}, removeEventListener() {}, location: { hash: "" }, scrollY: 0, scrollTo() {},
  confirm: () => true, requestAnimationFrame(fn) { fn(); },
};
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => fn());

let census = { categories: [], destinations: [], history: [], cap: 75, centralFedStores: ["concrete"], centralFedClothing: { concrete: 4 } };
const callableMock = vi.fn(async (d) => (d.action === "census" ? { data: census } : { data: { ok: true } }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => (...a) => callableMock(...a) }));
vi.mock("../../firebase", () => ({ database: { fake: true }, functions: { fake: true } }));

const { default: EnginePolicyCard, CentralFedPanel } = await import("./EnginePolicyCard.jsx");
const OWNER = { email: "gunidmoh@gmail.com" };
const flat = (n) => (n == null || n === false ? "" : typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(flat).join("") : flat(n.children));

const mount = async () => {
  let tree;
  await act(async () => { tree = TestRenderer.create(<EnginePolicyCard viewer={OWNER} onExit={() => {}} />); });
  await act(async () => {});
  return tree;
};

beforeEach(() => {
  callableMock.mockClear();
  census = { categories: [], destinations: [], history: [], cap: 75, centralFedStores: ["concrete"], centralFedClothing: { concrete: 4 } };
});

describe("the panel on the card", () => {
  it("shows Concrete's number from the census", async () => {
    const tree = await mount();
    const panel = tree.root.find((n) => n.props && n.props["data-central-fed-panel"] === "concrete");
    expect(flat(panel.children)).toMatch(/Concrete — clothing kept in the shop/);
    expect(flat(panel.children)).toMatch(/4 of every size, refilled straight from Central/);
  });

  it("saving a new number calls setCentralFed with the live value as the expectation", async () => {
    const tree = await mount();
    const input = tree.root.find((n) => n.type === "input" && n.props["aria-label"] === "Concrete clothing per size");
    await act(async () => { input.props.onChange({ target: { value: "6" } }); });
    const save = tree.root.findAll((n) => n.type === "button").find((b) => flat(b.children) === "Save");
    await act(async () => { await save.props.onClick(); });
    expect(callableMock).toHaveBeenCalledWith({ action: "setCentralFed", location: "concrete", perSize: 6, expectedBefore: 4 });
  });

  it("switching off sends null", async () => {
    const tree = await mount();
    const off = tree.root.findAll((n) => n.type === "button").find((b) => flat(b.children) === "Switch off");
    await act(async () => { await off.props.onClick(); });
    expect(callableMock).toHaveBeenCalledWith({ action: "setCentralFed", location: "concrete", perSize: null, expectedBefore: 4 });
  });

  it("no panel when the census names no store it may be set for", async () => {
    census = { ...census, centralFedStores: [] };
    const tree = await mount();
    expect(tree.root.findAll((n) => n.props && n.props["data-central-fed-panel"])).toHaveLength(0);
  });

  it("the panel alone: Save is disabled for an invalid or unchanged number", () => {
    let tree;
    act(() => { tree = TestRenderer.create(<CentralFedPanel location="concrete" perSize={4} busy="" onSave={() => {}} />); });
    const save = () => tree.root.findAll((n) => n.type === "button").find((b) => flat(b.children) === "Save");
    expect(save().props.disabled).toBe(true);   // unchanged
    const input = tree.root.find((n) => n.type === "input");
    act(() => { input.props.onChange({ target: { value: "0" } }); });
    expect(save().props.disabled).toBe(true);   // 0 is not allowed
  });
});

describe("history and revert", () => {
  it("a centralFed history entry reverts to its 'before'", async () => {
    census = { ...census, history: [{ id: "h1", kind: "centralFed", location: "concrete", before: 4, after: 6, at: 1, by: "gunidmoh@gmail.com", status: "applied" }], centralFedClothing: { concrete: 6 } };
    const tree = await mount();
    expect(flat(tree.toJSON())).toMatch(/clothing per size/);
    const revert = tree.root.findAll((n) => n.type === "button").find((b) => /Revert|Put back/i.test(flat(b.children)));
    expect(revert).toBeTruthy();
    await act(async () => { await revert.props.onClick(); });
    expect(callableMock).toHaveBeenCalledWith({ action: "setCentralFed", location: "concrete", perSize: 4, expectedBefore: 6 });
  });
});
