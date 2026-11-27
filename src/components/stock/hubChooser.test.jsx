// ─── THE SNEAKER HUB CHOOSER — Hub 1 and Hub 2 switch, Hub 3 toggles ──────────
// Junid, 22 Nov 2026: "with Hub 1 selected, tapping Hub 2 does nothing, and the
// reverse." The pills are a switch now, and the Confirm writes exactly what is lit.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { switchHubPick } from "./hubChooser";

describe("switchHubPick — the selection after a tap", () => {
  it("Hub 1 then Hub 2 gives Hub 2 only", () => {
    expect(switchHubPick(["hub1"], "hub2")).toEqual(["hub2"]);
  });
  it("Hub 2 then Hub 1 gives Hub 1 only", () => {
    expect(switchHubPick(["hub2"], "hub1")).toEqual(["hub1"]);
  });
  it("Hub 1 + Hub 3 then Hub 2 gives Hub 2 + Hub 3 — Hub 3 keeps its state", () => {
    expect([...switchHubPick(["hub1", "hub3"], "hub2")].sort()).toEqual(["hub2", "hub3"]);
    expect([...switchHubPick(["hub3", "hub1"], "hub2")].sort()).toEqual(["hub2", "hub3"]);
  });
  it("Hub 3 toggles on and off without touching Hub 1 or Hub 2", () => {
    expect(switchHubPick(["hub1"], "hub3")).toEqual(["hub1", "hub3"]);
    expect(switchHubPick(["hub1", "hub3"], "hub3")).toEqual(["hub1"]);
    expect(switchHubPick(["hub2", "hub3"], "hub3")).toEqual(["hub2"]);
  });
  it("a lit pill goes off — an empty selection is allowed, never a dead tap", () => {
    expect(switchHubPick(["hub1"], "hub1")).toEqual([]);
    expect(switchHubPick([], "hub2")).toEqual(["hub2"]);
  });
  it("Hub 1 and Hub 2 are never both lit, whatever is tapped in whatever order", () => {
    const taps = ["hub1", "hub2", "hub3"];
    // every tap sequence up to length 6, from every start
    const walk = (sel, depth) => {
      expect(sel.includes("hub1") && sel.includes("hub2")).toBe(false);
      expect(new Set(sel).size).toBe(sel.length);
      if (depth === 0) return;
      for (const t of taps) {
        const next = switchHubPick(sel, t);
        expect(next).not.toEqual(sel);   // no tap is ever a no-op
        walk(next, depth - 1);
      }
    };
    walk([], 6);
  });
  it("tolerates a missing selection", () => {
    expect(switchHubPick(undefined, "hub1")).toEqual(["hub1"]);
    expect(switchHubPick(null, "hub3")).toEqual(["hub3"]);
  });
});

// ── on the screen ────────────────────────────────────────────────────────────
const NOW = Date.parse("2026-11-22T10:00:00.000Z");
const paths = {};
const gets = {};
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path ?? "" }),
  onValue: (r, cb) => { cb({ val: () => paths[r.path] ?? null }); return () => {}; },
  update: vi.fn(() => Promise.resolve()),
  push: (() => { let n = 0; return () => ({ key: `req${++n}` }); })(),
  get: (r) => Promise.resolve({ val: () => gets[r.path] ?? null }),
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: { currentUser: { uid: "u1" } } }));
const seatCalls = [];
vi.mock("firebase/functions", () => ({ httpsCallable: () => async (arg) => { seatCalls.push(arg); return { data: { ok: true } }; } }));
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ permRecord: { stockRole: "warehouse" }, isSuperAdmin: false }) }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => new Date(NOW).toISOString(), serverNowMs: () => NOW }));

const { default: MissingFootwear } = await import("./MissingFootwear.jsx");
const { update } = await import("firebase/database");

const PRODUCTS = [{ id: "shoeA", name: "Air Zoom Alpha", category: "Footwear", sizes: ["8", "9"] }];
const cell = (qty) => ({ qty, v: 1, mv: "m1", state: "live" });
const buttonsOf = (tree) => tree.root.findAll((n) => n.type === "button");
const text = (b) => (b.children || []).filter((c) => typeof c === "string").join("");
const pills = (tree) => buttonsOf(tree).filter((b) => b.props.role === "checkbox");
const pill = (tree, name) => pills(tree).find((b) => text(b).startsWith(name));
const lit = (tree) => pills(tree).filter((b) => b.props["aria-checked"]).map((b) => text(b).replace(/ · .*/, "")).sort();
const tap = async (tree, name) => { await act(async () => { pill(tree, name).props.onClick(); }); };
const openChooser = async (tree) => {
  const open = buttonsOf(tree).find((b) => b.props["data-action"] === "open-request");
  await act(async () => { open.props.onClick(); });
};
const confirmButton = (tree) => buttonsOf(tree).find((b) => b.props["data-action"] === "confirm-request");
// Every string on the screen, joined — JSX splits a sentence into pieces.
const allText = (tree) => tree.root.findAll((n) => typeof n.type === "string").flatMap((n) => (n.children || []).filter((c) => typeof c === "string")).join("");
const mount = () => { let tree; act(() => { tree = TestRenderer.create(<MissingFootwear products={PRODUCTS} />); }); return tree; };

beforeEach(() => {
  update.mockClear();
  seatCalls.length = 0;
  for (const k of Object.keys(paths)) delete paths[k];
  for (const k of Object.keys(gets)) delete gets[k];
  paths["stock"] = { central: { shoeA: { 8: cell(9), 9: cell(9) } } };
  paths["refill_requests"] = null;
  gets["config/refillEngine/footwearRunByLocation"] = { hub1: { 8: 2, 9: 2 }, hub2: { 8: 2, 9: 2 } };
  gets["config/refillEngine/policyGroups/footwear-all/policy/hub3"] = { target: 3, minQty: 2, reorderPoint: 1, carriedOnly: true };
});

describe("the chooser on a Missing Products sneaker card", () => {
  it("opens on Hub 1; tapping Hub 2 switches to Hub 2 only, and back again", async () => {
    const tree = mount();
    await act(async () => {});
    await openChooser(tree);
    expect(lit(tree)).toEqual(["Hub 1"]);
    await tap(tree, "Hub 2");
    expect(lit(tree)).toEqual(["Hub 2"]);
    await tap(tree, "Hub 1");
    expect(lit(tree)).toEqual(["Hub 1"]);
  });

  it("Hub 3 is not offered on Marathon's list (it is requested from the Concrete list)", async () => {
    const tree = mount();
    await act(async () => {});
    await openChooser(tree);
    expect(pills(tree).map((b) => b.props["data-dest"])).toEqual(["hub1", "hub2"]);
  });

  it("the Source line, the size grid and the piece count follow the selection", async () => {
    gets["config/refillEngine/footwearRunByLocation"] = { hub1: { 8: 2, 9: 2 }, hub2: { 8: 3, 9: 1 } };
    const tree = mount();
    await act(async () => {});
    await openChooser(tree);
    const flat = () => allText(tree);
    expect(flat()).toMatch(/Hub 1 Refill/);
    expect(flat()).toMatch(/4 pieces across 2 sizes/);
    expect(flat()).toMatch(/Request 4 for Hub 1/);
    await tap(tree, "Hub 2");
    expect(flat()).toMatch(/Hub 2 Refill/);
    expect(flat()).not.toMatch(/Hub 1 Refill/);
    expect(flat()).toMatch(/Request 4 for Hub 2/);
    const grid = tree.root.findAll((n) => n.type === "span").map((n) => (n.children || []).filter((c) => typeof c === "string").join("")).join("|");
    expect(grid).toMatch(/8\|3/);      // Hub 2's own numbers: 8×3, 9×1
    await tap(tree, "Hub 2");
    expect(flat()).not.toMatch(/Refill/);   // nothing lit: no line that names a hub
  });

  it("no pill is ever disabled, and turning the last one off asks for a hub instead of re-lighting it", async () => {
    const tree = mount();
    await act(async () => {});
    await openChooser(tree);
    for (const p of pills(tree)) expect(p.props.disabled).toBeFalsy();
    await tap(tree, "Hub 1");
    expect(lit(tree)).toEqual([]);
    expect(confirmButton(tree).props.disabled).toBe(true);
    expect(allText(tree)).toMatch(/Pick a hub first/);
  });

  it("Confirm writes exactly the visible selection: Hub 1 → Hub 2 raises for Hub 2 only", async () => {
    const tree = mount();
    await act(async () => {});
    await openChooser(tree);
    await tap(tree, "Hub 2");
    await act(async () => { await confirmButton(tree).props.onClick(); });
    expect(update).toHaveBeenCalledTimes(1);
    const reqs = Object.entries(update.mock.calls[0][1]).filter(([k]) => k.startsWith("refill_requests/")).map(([, v]) => v);
    expect(reqs.length).toBe(2);
    expect([...new Set(reqs.map((r) => r.requestingLocation))]).toEqual(["hub2"]);
  });

  it("Confirm writes exactly the visible selection: Hub 2 → Hub 1 raises for Hub 1 only, and never as a pair", async () => {
    const tree = mount();
    await act(async () => {});
    await openChooser(tree);
    await tap(tree, "Hub 2");
    await tap(tree, "Hub 1");
    await act(async () => { await confirmButton(tree).props.onClick(); });
    expect(update).toHaveBeenCalledTimes(1);
    const reqs = Object.entries(update.mock.calls[0][1]).filter(([k]) => k.startsWith("refill_requests/")).map(([, v]) => v);
    expect([...new Set(reqs.map((r) => r.requestingLocation))]).toEqual(["hub1"]);
    for (const r of reqs) expect(r.createdFrom.solveHubs).toBeUndefined();
    expect(seatCalls).toEqual([]);
  });

  it("the other Marathon hub already holding it does not kill the pill — the panel says why Confirm is off", async () => {
    paths["stock"].hub1 = { shoeA: { 8: cell(0) } };          // carried at Hub 1, empty → still listed
    paths["refill_requests"] = { r0: { productId: "shoeA", size: "8", qty: 2, requestingLocation: "hub1", status: "open", requestSource: "scan", createdFrom: { engine: true } } };
    const tree = mount();
    await act(async () => {});
    await openChooser(tree);
    await tap(tree, "Hub 2");
    expect(lit(tree)).toEqual(["Hub 2"]);
    expect(confirmButton(tree).props.disabled).toBe(true);
    expect(allText(tree)).toMatch(/seated at Hub 1/);
  });
});
