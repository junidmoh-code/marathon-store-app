// ─── TERMINAL SETTINGS ON THE CARD MACHINES PAGE ─────────────────────────────
// Renders the REAL screen and the REAL sheet with the callable faked, and pins:
// the gear is Junid's alone; an Email-only till has no camera; the store and
// till are picked from the POS list the callable returns (never typed); the
// TID is uppercased as typed; and each action sends exactly the payload the
// callable (functions/cardRecon/cardTerminalAdmin.js) reads.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const ESTATE = {
  "0000HP1X": { label: "Marathon Till 2", mid: "000000004977890", storeId: "pe", tillId: "till-2" },
  "67365901": { label: "Marathon Till 3", storeId: "pe", tillId: "till-3", capture: "email" },
  "67377843": { label: "Trophy Till 1", storeId: "trophy", tillId: "till-1", retiredAt: 5 },
};
const STORES = [
  { storeId: "pe", label: "Marathon PE", tills: [{ tillId: "till-1", name: "Till 1" }, { tillId: "till-2", name: "Till 2" }, { tillId: "till-3", name: "Till 3" }] },
  { storeId: "pine", label: "Marathon Pine", tills: [{ tillId: "till-1", name: "Till 1" }] },
  { storeId: "trophy", label: "Trophy", tills: [{ tillId: "till-1", name: "Till 1" }, { tillId: "till-2", name: "Till 2" }] },
];

const fake = vi.hoisted(() => ({ auth: { currentUser: null }, calls: [] }));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, storage: {}, auth: fake.auth }));
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  onValue: (r, cb) => { cb({ val: () => (String(r?.path).includes("cardTerminals") ? ESTATE : {}) }); return () => {}; },
  query: (r) => r, orderByChild: () => {}, limitToLast: () => {},
}));
vi.mock("firebase/functions", () => ({
  httpsCallable: (_f, name) => async (payload) => {
    fake.calls.push({ name, payload });
    if (name === "cardTerminalAdmin" && payload.action === "options") return { data: { ok: true, stores: STORES } };
    return { data: { ok: true } };
  },
}));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => Date.parse("2026-09-21T16:00:00Z"), saDateStringAt: () => "2026-09-21" }));
vi.mock("../shopify/imageDecode", () => ({ decodeImageFile: vi.fn(), isAcceptedImageFile: () => true, describePickedFile: () => "" }));

const CardReconScreen = (await import("./CardReconScreen")).default;

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const byText = (root, text) => root.find((n) => n.type === "button" && [].concat(n.props.children).join("") === text);
const allText = (root) => root.findAll((n) => typeof n.props?.children === "string").map((n) => n.props.children).join(" | ");

async function mount() {
  let tree;
  await act(async () => { tree = TestRenderer.create(<CardReconScreen onExit={() => {}} />); });
  return tree;
}
async function openSettings() {
  const tree = await mount();
  await act(async () => { tree.root.find((n) => n.props?.["aria-label"] === "Terminal settings").props.onClick(); });
  await flush();
  return tree;
}

beforeEach(() => { fake.calls.length = 0; fake.auth.currentUser = { email: "gunidmoh@gmail.com" }; });

describe("the gear", () => {
  it("is shown to Junid's account and to nobody else", async () => {
    const gear = (t) => t.root.findAll((n) => n.props?.["aria-label"] === "Terminal settings").length;
    expect(gear(await mount())).toBe(1);
    fake.auth.currentUser = { email: "junidmoh@gmail.com" };
    expect(gear(await mount())).toBe(0);
    fake.auth.currentUser = null;
    expect(gear(await mount())).toBe(0);
  });
});

describe("capture mode on the cards", () => {
  it("an Email-only till has no camera input; Photo/Both tills do", async () => {
    const tree = await mount();
    const inputs = tree.root.findAll((n) => n.type === "input" && n.props.type === "file");
    expect(inputs.length, "Till 2 (both) has one; Till 3 (email) none; Trophy 1 is retired").toBe(1);
    expect(allText(tree.root)).toContain("Marathon Till 3");
  });
});

describe("the settings sheet", () => {
  it("lists every terminal, retired ones included, with store by trading name", async () => {
    const tree = await openSettings();
    const text = allText(tree.root);
    expect(fake.calls[0]).toEqual({ name: "cardTerminalAdmin", payload: { action: "options" } });
    expect(tree.root.findAll((n) => n.type === "div" && /· Marathon PE ·/.test([].concat(n.props.children).join(""))).length).toBeGreaterThan(0);
    expect(text).toContain("Trophy Till 1");
  });

  it("add: store and till are pickers fed by the POS list, the TID uppercases, and the payload is exact", async () => {
    const tree = await openSettings();
    await act(async () => { byText(tree.root, "Add a terminal").props.onClick(); });
    const store = tree.root.find((n) => n.type === "select" && n.props.id === "ts-store");
    expect(store.findAll((n) => n.type === "option").map((o) => o.props.value)).toEqual(["", "pe", "pine", "trophy"]);
    await act(async () => { tree.root.find((n) => n.props.id === "ts-tid").props.onChange({ target: { value: "0000cd2e" } }); });
    expect(tree.root.find((n) => n.props.id === "ts-tid").props.value).toBe("0000CD2E");
    await act(async () => { store.props.onChange({ target: { value: "trophy" } }); });
    const till = tree.root.find((n) => n.type === "select" && n.props.id === "ts-till");
    expect(till.findAll((n) => n.type === "option").map((o) => o.props.value)).toEqual(["", "till-1", "till-2"]);
    await act(async () => { till.props.onChange({ target: { value: "till-2" } }); });
    await act(async () => { tree.root.find((n) => n.props.id === "ts-label").props.onChange({ target: { value: "Trophy Till 2" } }); });
    await act(async () => { tree.root.find((n) => n.props.role === "radio" && n.props.children === "Photo").props.onClick(); });
    await act(async () => { tree.root.find((n) => n.type === "form").props.onSubmit({ preventDefault() {} }); });
    await flush();
    expect(fake.calls.at(-1)).toEqual({ name: "cardTerminalAdmin", payload: {
      action: "add", terminal: { tid: "0000CD2E", storeId: "trophy", tillId: "till-2", label: "Trophy Till 2", mid: "", capture: "photo" } } });
  });

  it("edit: the TID and store are fixed; only the till is picked", async () => {
    const tree = await openSettings();
    const editBtns = tree.root.findAll((n) => n.type === "button" && n.props.children === "Edit");
    await act(async () => { editBtns[0].props.onClick(); });
    expect(tree.root.findAll((n) => n.props.id === "ts-tid")).toHaveLength(0);
    expect(tree.root.findAll((n) => n.props.id === "ts-store")).toHaveLength(0);
    await act(async () => { tree.root.find((n) => n.props.id === "ts-till").props.onChange({ target: { value: "till-3" } }); });
    await act(async () => { tree.root.find((n) => n.type === "form").props.onSubmit({ preventDefault() {} }); });
    await flush();
    expect(fake.calls.at(-1).payload).toEqual({ action: "edit", terminal: {
      tid: "0000HP1X", storeId: "pe", tillId: "till-3", label: "Marathon Till 2", mid: "000000004977890", capture: "both" } });
  });

  it("Replace TID: one action, old TID named, the new TID typed, store and till carried", async () => {
    const tree = await openSettings();
    await act(async () => { tree.root.findAll((n) => n.type === "button" && n.props.children === "Replace TID")[0].props.onClick(); });
    await act(async () => { tree.root.find((n) => n.props.id === "ts-tid").props.onChange({ target: { value: "0000ef3g" } }); });
    await act(async () => { tree.root.find((n) => n.type === "form").props.onSubmit({ preventDefault() {} }); });
    await flush();
    expect(fake.calls.at(-1).payload).toEqual({ action: "replace", oldTid: "0000HP1X",
      terminal: { tid: "0000EF3G", label: "Marathon Till 2", mid: "", capture: "both" } });
  });

  it("Retire asks inline first — no browser dialog — then sends retire", async () => {
    const tree = await openSettings();
    await act(async () => { tree.root.findAll((n) => n.type === "button" && n.props.children === "Retire")[0].props.onClick(); });
    expect(fake.calls.filter((c) => c.payload.action === "retire")).toHaveLength(0);
    const yes = tree.root.find((n) => n.type === "button" && /^Yes, retire/.test([].concat(n.props.children).join("")));
    await act(async () => { yes.props.onClick(); });
    await flush();
    expect(fake.calls.at(-1).payload).toEqual({ action: "retire", terminal: { tid: "0000HP1X" } });
  });
});
