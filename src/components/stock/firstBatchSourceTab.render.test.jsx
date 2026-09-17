// ─── Source › Trophy / Marathon: the shop's Central request through the real queue ─
// The same RefillQueue, mounted with dest = the shop. The claim under test is
// that the EXISTING fulfil path serves it unchanged: Central → shop, rrf_ id,
// partial tranche, human rejection shape. Plus the SourceView wiring gate.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";

const NOW = Date.parse("2026-09-17T10:00:00.000Z");
const paths = {};
const gets = {};
const updateMock = vi.fn(() => Promise.resolve());
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  onValue: (r, cb) => { cb({ val: () => paths[r.path] ?? null }); return () => {}; },
  update: (...a) => updateMock(...a),
  get: (r) => Promise.resolve({ val: () => gets[r.path] ?? null }),
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
const perm = { permRecord: { stockRole: "warehouse" }, isSuperAdmin: false };
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ ...perm }) }));
const applyMovementMock = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock("./applyMovement", () => ({ applyMovement: (...a) => applyMovementMock(...a) }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => new Date(NOW).toISOString(), serverNowMs: () => NOW }));

const { default: RefillQueue } = await import("./RefillQueue.jsx");

const RAISED = "2026-09-17T03:00:00.000Z";   // before the 06:00 release → released
const PRODUCTS = [
  { id: "tee1", name: "Essentials Tee Olive", photoUrl: null },
  { id: "tee2", name: "Essentials Tee Olive", photoUrl: null },   // duplicate-name twin
];
const textOf = (n) => {
  if (n == null || n === false) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  return textOf(n.children) + textOf(n.props?.children);
};
const rowLineOf = (tree, rowKey) => tree.root.findAll((n) => n.props && n.props["data-row"] === rowKey)[0];
const lineButton = (line, label) => line.findAll((n) => n.type === "button").find((n) => textOf(n.props.children).trim() === label);
const confirmOf = (tree) => tree.root.findAll((n) => n.type === "button").find((n) => textOf(n.props.children).includes("Transfer & Fulfil"));
function renderQueue(dest) {
  let tree;
  act(() => { tree = TestRenderer.create(<RefillQueue products={PRODUCTS} dest={dest} />); });
  return tree;
}
const fb = (pid, size, qty, store, over = {}) => ({
  productId: pid, size, qty, requestingLocation: store, status: "open", createdAt: RAISED,
  createdFrom: { firstBatch: true, solveId: `fb_${pid}_x`, source: "central", store, hub: "hub2" }, ...over,
});

beforeEach(() => {
  for (const k of Object.keys(paths)) delete paths[k];
  for (const k of Object.keys(gets)) delete gets[k];
  updateMock.mockClear(); applyMovementMock.mockClear();
  paths["refill_requests"] = {
    tro1: fb("tee1", "M", 2, "trophy"),
    tro2: fb("tee2", "M", 1, "trophy"),
    pe1: fb("tee1", "S", 2, "marathon-pe"),
    hub: { productId: "tee1", size: "M", qty: 3, requestingLocation: "hub2", status: "open", createdAt: RAISED, createdFrom: { engine: true, source: "central" } },
    // THE INCIDENT ROW (2026-09-17): the ENGINE's ordinary hub2→trophy request
    // for a product Hub 2 stocks. Hub 2's work — never Central's list.
    eng: { productId: "tee1", size: "L", qty: 2, requestingLocation: "trophy", status: "open", createdAt: "2026-09-15T03:00:00.000Z", createdFrom: { engine: true, source: "hub2" } },
    engPe: { productId: "tee2", size: "L", qty: 1, requestingLocation: "marathon-pe", status: "open", createdAt: "2026-09-15T03:00:00.000Z", createdFrom: { engine: true, source: "hub2" } },
    // a legacy human shop request with no createdFrom at all — also not Central's
    legacy: { productId: "tee1", size: "XL", qty: 1, requestingLocation: "trophy", status: "open", createdAt: RAISED },
  };
  paths["stock/trophy"] = null; paths["stock/marathon-pe"] = null;
  paths["refill_engine/open"] = null;
  paths["config/refillEngine"] = null;
  for (const id of ["tro1", "tro2", "pe1"]) gets[`refill_requests/${id}`] = paths["refill_requests"][id];
  gets["stock/central/tee1/M"] = { qty: 4 };
  gets["stock/central/tee2/M"] = { qty: 1 };
  gets["stock/central/tee1/S"] = { qty: 4 };
});

describe("the Trophy tab shows Trophy's Central requests only, one card per productId", () => {
  it("lists tro1 and tro2 (twins on separate cards), not Marathon's nor Hub 2's rows", () => {
    const tree = renderQueue("trophy");
    expect(rowLineOf(tree, "req:tro1")).toBeTruthy();
    expect(rowLineOf(tree, "req:tro2")).toBeTruthy();
    expect(rowLineOf(tree, "req:pe1")).toBeUndefined();
    expect(rowLineOf(tree, "req:hub")).toBeUndefined();
    // THE INCIDENT: an engine hub2→trophy row and a legacy human row are NOT Central's
    expect(rowLineOf(tree, "req:eng")).toBeUndefined();
    expect(rowLineOf(tree, "req:legacy")).toBeUndefined();
    const text = textOf(tree.toJSON());
    expect(text.match(/Essentials Tee Olive/g)).toHaveLength(2);   // twins never merge by name
    expect(text).toMatch(/2 to pick \(3 units\)/);
  });
  it("the Marathon tab shows Marathon's row and nothing else", () => {
    const tree = renderQueue("marathon-pe");
    expect(rowLineOf(tree, "req:pe1")).toBeTruthy();
    expect(rowLineOf(tree, "req:tro1")).toBeUndefined();
    expect(rowLineOf(tree, "req:engPe")).toBeUndefined();
    expect(textOf(tree.toJSON())).toMatch(/1 to pick \(2 units\)/);
  });
  it("with no first-batch rows at all (live 2026-09-17: 225 engine rows, 0 first-batch) both shop tabs are EMPTY — nothing to pick, no Fulfil button", () => {
    delete paths["refill_requests"].tro1; delete paths["refill_requests"].tro2; delete paths["refill_requests"].pe1;
    for (const dest of ["trophy", "marathon-pe"]) {
      const tree = renderQueue(dest);
      expect(tree.root.findAll((n) => n.props && typeof n.props["data-row"] === "string")).toHaveLength(0);
      expect(tree.root.findAll((n) => n.type === "button" && textOf(n.props.children).trim() === "Fulfil")).toHaveLength(0);
      expect(textOf(tree.toJSON())).toMatch(/Nothing to pick/);
      expect(textOf(tree.toJSON())).not.toMatch(/\d+ to pick/);
    }
  });
  it("the Hub 2 tab is untouched: it still lists the engine's hub2 row", () => {
    paths["stock/hub2"] = null;
    const tree = renderQueue("hub2");
    expect(rowLineOf(tree, "req:hub")).toBeTruthy();
  });
});

describe("Fulfil moves Central → the shop through the existing path", () => {
  it("full fulfil: transfer_out central→trophy, rrf_ id, request marked fulfilled — the trigger's cue", async () => {
    const tree = renderQueue("trophy");
    await act(async () => { lineButton(rowLineOf(tree, "req:tro1"), "Fulfil").props.onClick(); });
    await act(async () => {});
    await act(async () => { await confirmOf(tree).props.onClick(); });
    expect(applyMovementMock).toHaveBeenCalledTimes(1);
    expect(applyMovementMock.mock.calls[0][0]).toEqual({
      type: "transfer_out", productId: "tee1", size: "M", qty: 2,
      from: "central", to: "trophy", actorRole: "warehouse",
      reason: "trophy_auto_refill", movementId: "rrf_tro1", link: { refillId: "tro1" },
    });
    const patch = updateMock.mock.calls.at(-1)[1];
    expect(patch["refill_requests/tro1/status"]).toBe("fulfilled");
    expect(patch["refill_requests/tro1/cancelReason"]).toBe(null);
  });
  it("partial send: sentQty accumulates and the row stays open — the second cue the trigger reads", async () => {
    const tree = renderQueue("trophy");
    await act(async () => { lineButton(rowLineOf(tree, "req:tro1"), "Fulfil").props.onClick(); });
    await act(async () => {});
    const minus = tree.root.findAll((n) => n.type === "button" && textOf(n.props.children) === "−")[0];
    await act(async () => { minus.props.onClick(); });
    await act(async () => { await confirmOf(tree).props.onClick(); });
    expect(applyMovementMock.mock.calls[0][0]).toMatchObject({ qty: 1, to: "trophy", movementId: "rrf_tro1" });
    const patch = updateMock.mock.calls.at(-1)[1];
    expect(patch).toEqual({ "refill_requests/tro1/qty": 1, "refill_requests/tro1/sentQty": 1 });
  });
  it("Out of Stock on the SHOP's batch: cancelled WITH first_batch_central_declined, in the same write — the third cue, never a shop-level rejection", async () => {
    const tree = renderQueue("trophy");
    await act(async () => { lineButton(rowLineOf(tree, "req:tro2"), "Out of Stock").props.onClick(); });
    const patch = updateMock.mock.calls.at(-1)[1];
    expect(patch["refill_requests/tro2/status"]).toBe("cancelled");
    expect(patch["refill_requests/tro2/cancelReason"]).toBe("first_batch_central_declined");
    expect(applyMovementMock).not.toHaveBeenCalled();
  });
  it("Out of Stock on Hub 2's own leg (also tagged firstBatch) keeps the human shape: NO cancelReason", async () => {
    paths["refill_requests"].hub.createdFrom = { firstBatch: true, solveId: "fb_tee1_x", source: "central", shopRequestId: "tro1" };
    paths["stock/hub2"] = null;
    const tree = renderQueue("hub2");
    await act(async () => { lineButton(rowLineOf(tree, "req:hub"), "Out of Stock").props.onClick(); });
    const patch = updateMock.mock.calls.at(-1)[1];
    expect(patch["refill_requests/hub/cancelReason"]).toBe(null);
  });
});

describe("SourceView wiring (source gate on App.jsx)", () => {
  const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");
  it("the tab list carries Trophy and Marathon, mapped to the shop location ids", () => {
    expect(APP).toMatch(/const SOURCE_SHOP_TABS = \[\["trophy","Trophy","trophy"\],\["marathonpe","Marathon","marathon-pe"\]\];/);
    expect(APP).toMatch(/const SOURCE_TABS = \[\["hub1refill","Hub 1 Refill"\],\["clothing","Hub 2 Refill"\],\.\.\.SOURCE_SHOP_TABS/);
  });
  it("a shop tab mounts the SAME RefillQueue with dest = the shop and no sale rows", () => {
    expect(APP).toMatch(/\{SOURCE_SHOP_BY_TAB\[tab\] && <RefillQueue products=\{products\} dest=\{SOURCE_SHOP_BY_TAB\[tab\]\} fulfilCtx=\{fulfilCtx\} \/>\}/);
  });
  it("the badges count a shop's FIRST-BATCH legs only (never the engine's hub2→shop rows), and the total includes them", () => {
    expect(APP).toMatch(/const counts = \{ hub1: 0, hub2: 0, trophy: 0, "marathon-pe": 0 \};/);
    expect(APP).toMatch(/Object\.prototype\.hasOwnProperty\.call\(counts, r\.requestingLocation\) &&\s*\(SOURCE_SHOP_LOCS\.has\(r\.requestingLocation\) \? isFirstBatchShopLeg\(r\) : true\)/);
    expect(APP).toMatch(/const SOURCE_SHOP_LOCS = new Set\(SOURCE_SHOP_TABS\.map\(\(\[, , loc\]\) => loc\)\);/);
    expect(APP).toMatch(/import \{ isFirstBatchShopLeg \} from "\.\/components\/stock\/firstBatchCore";/);
    expect(APP).toMatch(/const totalPending = Object\.values\(hubBadges\)\.reduce/);
  });
});
