// ─── QUEUED AT CENTRAL → THE CARD LEAVES THAT DIVISION'S LIST ────────────────
// Junid, 22 Nov 2026. Once a Request from Missing Products is queued at
// Central the card leaves that division's list at once, stays gone on reload
// and on every device, and returns only if the request is cancelled or
// rejected before stock moves. Per division. Display only.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { isQueuedFromHere, queuedAtHubs, partitionQueued } from "./missingScreenCore";

const req = (over = {}) => ({ productId: "shoeA", size: "8", qty: 2, requestingLocation: "hub1", status: "open", requestSource: "solve", createdFrom: { manual: true, source: "central", via: "missing_sneakers" }, ...over });
const CARDS = [{ pid: "shoeA", name: "A" }, { pid: "shoeB", name: "B" }];
const MARATHON = ["hub1", "hub2"];
const CONCRETE = ["hub3"];

describe("isQueuedFromHere — which request records take a card off the list", () => {
  it("an open request raised from this screen does", () => {
    expect(isQueuedFromHere(req())).toBe(true);
    expect(isQueuedFromHere(req({ createdFrom: { via: "hub3_solve" } }))).toBe(true);
  });
  it("cancelled, rejected, fulfilled or shadow does not", () => {
    for (const status of ["cancelled", "rejected", "fulfilled", "closed", undefined]) expect(isQueuedFromHere(req({ status }))).toBe(false);
    expect(isQueuedFromHere(req({ shadow: true }))).toBe(false);
  });
  it("a scan row, a first-batch row and junk do not", () => {
    expect(isQueuedFromHere(req({ requestSource: "scan", createdFrom: { engine: true } }))).toBe(false);
    expect(isQueuedFromHere(req({ createdFrom: { firstBatch: true } }))).toBe(false);
    expect(isQueuedFromHere(null)).toBe(false);
    expect(isQueuedFromHere({ status: "open" })).toBe(false);
  });
});

describe("partitionQueued — per division", () => {
  it("a request into Hub 1 takes the card off Marathon and leaves it on Concrete", () => {
    const requests = [req()];
    expect(partitionQueued(CARDS, requests, MARATHON).todo.map((c) => c.pid)).toEqual(["shoeB"]);
    expect(partitionQueued(CARDS, requests, CONCRETE).todo.map((c) => c.pid)).toEqual(["shoeA", "shoeB"]);
  });
  it("…and the reverse: Hub 3 takes it off Concrete and leaves it on Marathon", () => {
    const requests = [req({ requestingLocation: "hub3" })];
    expect(partitionQueued(CARDS, requests, CONCRETE).todo.map((c) => c.pid)).toEqual(["shoeB"]);
    expect(partitionQueued(CARDS, requests, MARATHON).todo.map((c) => c.pid)).toEqual(["shoeA", "shoeB"]);
  });
  it("a pair (Hub 2 + Hub 3) takes it off both", () => {
    const requests = [req({ requestingLocation: "hub2" }), req({ requestingLocation: "hub3" })];
    expect(partitionQueued(CARDS, requests, MARATHON).todo.map((c) => c.pid)).toEqual(["shoeB"]);
    expect(partitionQueued(CARDS, requests, CONCRETE).todo.map((c) => c.pid)).toEqual(["shoeB"]);
  });
  it("cancel or reject brings it back; one of two sizes still open keeps it away", () => {
    expect(partitionQueued(CARDS, [req({ status: "cancelled" })], MARATHON).todo.map((c) => c.pid)).toEqual(["shoeA", "shoeB"]);
    expect(partitionQueued(CARDS, [req({ status: "rejected" })], MARATHON).todo.map((c) => c.pid)).toEqual(["shoeA", "shoeB"]);
    expect(partitionQueued(CARDS, [req({ status: "cancelled" }), req({ size: "9" })], MARATHON).todo.map((c) => c.pid)).toEqual(["shoeB"]);
  });
  it("says what is waiting, takes a map as well as a list, and never changes a card", () => {
    const frozen = CARDS.map((c) => Object.freeze({ ...c }));
    const { todo, waiting } = partitionQueued(frozen, { r1: req(), r2: req({ size: "9", qty: 3 }) }, MARATHON);
    expect(todo).toEqual([frozen[1]]);
    expect(waiting).toEqual([{ card: frozen[0], queue: { hubs: ["hub1"], units: 5, sizes: [{ hub: "hub1", size: "8", qty: 2 }, { hub: "hub1", size: "9", qty: 3 }] } }]);
    expect(queuedAtHubs(null, MARATHON).size).toBe(0);
  });
  it("a card this device has just queued leaves before the echo", () => {
    expect(partitionQueued(CARDS, [], MARATHON, { shoeB: true }).todo.map((c) => c.pid)).toEqual(["shoeA"]);
  });
  it("creates nothing: the requests handed in are the requests handed back", () => {
    const requests = [req(), req({ status: "cancelled" })];
    const before = JSON.stringify(requests);
    partitionQueued(CARDS, requests, MARATHON);
    expect(JSON.stringify(requests)).toBe(before);
  });
});

// ── on the screen ────────────────────────────────────────────────────────────
const NOW = Date.parse("2026-11-22T10:00:00.000Z");
const paths = {};
const gets = {};
const listeners = {};
const emit = (path, value) => { paths[path] = value; for (const cb of listeners[path] || []) cb({ val: () => value }); };
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path ?? "" }),
  onValue: (r, cb) => { (listeners[r.path] ||= []).push(cb); cb({ val: () => paths[r.path] ?? null }); return () => { listeners[r.path] = (listeners[r.path] || []).filter((x) => x !== cb); }; },
  update: vi.fn(() => Promise.resolve()),
  push: (() => { let n = 0; return () => ({ key: `req${++n}` }); })(),
  get: (r) => Promise.resolve({ val: () => gets[r.path] ?? null }),
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: { ok: true } }) }));
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ permRecord: { stockRole: "warehouse" }, isSuperAdmin: false }) }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => new Date(NOW).toISOString(), serverNowMs: () => NOW }));

const { default: MissingFootwear } = await import("./MissingFootwear.jsx");
const { update } = await import("firebase/database");

const PRODUCTS = [
  { id: "shoeA", name: "Air Zoom Alpha", category: "Footwear", sizes: ["8", "9"] },
  { id: "shoeB", name: "Air Zoom Beta", category: "Footwear", sizes: ["8", "9"] },
];
const cell = (qty) => ({ qty, v: 1, mv: "m1", state: "live" });
const buttonsOf = (tree) => tree.root.findAll((n) => n.type === "button");
const text = (b) => (b.children || []).filter((c) => typeof c === "string").join("");
const allText = (tree) => tree.root.findAll((n) => typeof n.type === "string").flatMap((n) => (n.children || []).filter((c) => typeof c === "string")).join("");
const names = (tree) => PRODUCTS.map((p) => p.name).filter((n) => tree.root.findAll((x) => x.props && x.props["data-card"] && x.props["data-card-name"] === n).length > 0);
const mount = () => { let tree; act(() => { tree = TestRenderer.create(<MissingFootwear products={PRODUCTS} />); }); return tree; };
const division = async (tree, label) => { await act(async () => { buttonsOf(tree).find((b) => text(b).includes(label)).props.onClick(); }); };

beforeEach(() => {
  update.mockClear();
  for (const k of Object.keys(paths)) delete paths[k];
  for (const k of Object.keys(gets)) delete gets[k];
  paths["stock"] = { central: { shoeA: { 8: cell(9), 9: cell(9) }, shoeB: { 8: cell(9), 9: cell(9) } } };
  paths["refill_requests"] = null;
  gets["config/refillEngine/footwearRunByLocation"] = { hub1: { 8: 2, 9: 2 }, hub2: { 8: 2, 9: 2 } };
  gets["config/refillEngine/policyGroups/footwear-all/policy/hub3"] = { target: 3, minQty: 2, reorderPoint: 1, carriedOnly: true };
});

describe("a queued sneaker card on the list", () => {
  it("leaves Marathon the moment the request is confirmed, and writes nothing but that request", async () => {
    const tree = mount();
    await act(async () => {});
    expect(names(tree)).toEqual(["Air Zoom Alpha", "Air Zoom Beta"]);
    await act(async () => { buttonsOf(tree).find((b) => b.props["data-action"] === "open-request").props.onClick(); });
    await act(async () => { await buttonsOf(tree).find((b) => b.props["data-action"] === "confirm-request").props.onClick(); });
    expect(update).toHaveBeenCalledTimes(1);
    expect(Object.keys(update.mock.calls[0][1]).every((k) => k.startsWith("refill_requests/"))).toBe(true);
    expect(names(tree)).toEqual(["Air Zoom Beta"]);
    expect(allText(tree)).toMatch(/1 queued at Central/);
    expect(allText(tree)).toMatch(/Air Zoom Alpha/);          // …and says what was queued
  });

  it("stays gone on reload and on another device: the open request alone hides it", async () => {
    paths["refill_requests"] = { r1: req() };
    const tree = mount();
    await act(async () => {});
    expect(names(tree)).toEqual(["Air Zoom Beta"]);
    expect(update).not.toHaveBeenCalled();
  });

  it("the other division keeps the card", async () => {
    paths["refill_requests"] = { r1: req() };                 // queued into Hub 1 (Marathon)
    const tree = mount();
    await act(async () => {});
    await division(tree, "Concrete");
    expect(names(tree)).toEqual(["Air Zoom Alpha", "Air Zoom Beta"]);
    await division(tree, "Marathon");
    expect(names(tree)).toEqual(["Air Zoom Beta"]);
  });

  it("…and the reverse: queued into Hub 3 it leaves Concrete and stays on Marathon", async () => {
    paths["refill_requests"] = { r1: req({ requestingLocation: "hub3", createdFrom: { via: "missing_sneakers", divisionSolve: true } }) };
    const tree = mount();
    await act(async () => {});
    expect(names(tree)).toEqual(["Air Zoom Alpha", "Air Zoom Beta"]);
    await division(tree, "Concrete");
    expect(names(tree)).toEqual(["Air Zoom Beta"]);
  });

  it("cancel brings it back; so does a rejection", async () => {
    paths["refill_requests"] = { r1: req() };
    const tree = mount();
    await act(async () => {});
    expect(names(tree)).toEqual(["Air Zoom Beta"]);
    await act(async () => { emit("refill_requests", { r1: req({ status: "cancelled" }) }); });
    expect(names(tree)).toEqual(["Air Zoom Alpha", "Air Zoom Beta"]);
    await act(async () => { emit("refill_requests", { r1: req() }); });
    expect(names(tree)).toEqual(["Air Zoom Beta"]);
    await act(async () => { emit("refill_requests", { r1: req({ status: "rejected" }) }); });
    expect(names(tree)).toEqual(["Air Zoom Alpha", "Air Zoom Beta"]);
  });

  it("stock landing at the hub keeps it off the list after the request closes", async () => {
    paths["refill_requests"] = { r1: req({ status: "fulfilled" }) };
    paths["stock"].hub1 = { shoeA: { 8: cell(2) } };
    const tree = mount();
    await act(async () => {});
    expect(names(tree)).toEqual(["Air Zoom Beta"]);
  });
});
