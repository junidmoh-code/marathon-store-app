// ─── TRANSFER SCREEN: A PERSON MAY SEND ANYWHERE (owner, 31 Oct 2026) ────────
// Renders the real Transfer screen. With the default network, a cart at Hub 2
// opens a destination sheet that offers EVERY other location — Concrete, Pine
// and Hub 3 included (the section wall used to hide them) — and Confirm hands
// the writer a movement flagged `manual: true`, the one flag that makes
// applyMovement judge it with manualTransferAllowed instead of the wall.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const updateMock = vi.fn(() => Promise.resolve());
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path ?? "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: () => Promise.resolve({ val: () => null, exists: () => false }),
  update: (...a) => updateMock(...a),
  push: () => ({ key: "t1" }),
}));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
const applyMovement = vi.fn(() => Promise.resolve({ ok: true, movementId: "m1" }));
vi.mock("./applyMovement", () => ({ applyMovement: (...a) => applyMovement(...a) }));
const PID = "p1";
const cell = (qty) => ({ qty, v: 1 });
vi.mock("./useStock", () => ({
  useStockCells: (loc) => (loc === "hub2" ? { p1: { M: cell(5) } } : {}),
  useTransitConfig: () => null,
}));
let draft = null;
vi.mock("./transferDraft", () => ({
  loadDraft: () => draft,
  saveDraft: () => {},
  clearDraft: () => {},
  transferMovementId: (t, p, s) => `${t}_${p}_${s}`,
}));
vi.mock("./barcodeListener", () => ({ installBarcodeListener: () => () => {}, subscribeBarcode: () => () => {} }));
vi.mock("../../update/updateChecker", () => ({ setUpdateBusy: () => {} }));
vi.mock("../../device/deviceStamp", () => ({ stampAt: () => ({}) }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => "2026-10-31T09:00:00.000Z", serverNowMs: () => 0 }));

const { default: Transfer } = await import("./Transfer.jsx");
const { __resetNetworkForTests } = await import("../../utils/networkStore.js");
const { DEFAULT_LOCATIONS, labelFor } = await import("./locations.js");

const REGISTRY = Object.fromEntries(DEFAULT_LOCATIONS.map((l) => [l.id, l]));
const PRODUCTS = [{ id: PID, name: "Tee", category: "Tees", sizes: ["M"] }];

const text = (node) => node.children.map((c) => (typeof c === "string" ? c : text(c))).join("");
const buttons = (tree) => tree.root.findAll((n) => n.type === "button");
const button = (tree, label) => buttons(tree).find((b) => text(b) === label);

// A cart of 1 unit at `from`, restored from a draft, with the destination sheet open.
async function openSheet(from) {
  draft = { from, to: "", refillId: null, transferId: null, lineResults: {},
    basket: { [`${PID}__M`]: { productId: PID, productName: "Tee", size: "M", qty: 1 } } };
  let tree;
  await act(async () => { tree = TestRenderer.create(<Transfer products={PRODUCTS} registry={REGISTRY} actorRole="warehouse" />); });
  await act(async () => { button(tree, "Restore cart").props.onClick(); });
  await act(async () => { button(tree, "Destination →").props.onClick(); });
  return tree;
}

// Destination chips: every button between the sheet header and Back.
function destinations(tree) {
  const all = buttons(tree).map(text);
  const i = all.indexOf("Destination →");
  const j = all.indexOf("Back");
  return all.slice(i + 1, j);
}

beforeEach(() => { __resetNetworkForTests(); applyMovement.mockClear(); updateMock.mockClear(); });

describe("the destination sheet offers every location", () => {
  it("from Hub 2: Concrete, Pine, Hub 3, Marathon PE, Trophy, Hub 1 and Central", async () => {
    const tree = await openSheet("hub2");
    const want = ["concrete", "marathon-pine", "hub3", "marathon-pe", "trophy", "hub1", "central"].map((id) => labelFor(id, REGISTRY));
    const got = destinations(tree);
    expect([...got].sort()).toEqual([...want].sort());
    expect(got).not.toContain(labelFor("hub2", REGISTRY));
    expect(got).not.toContain("In Transit");
  });

  it("from Concrete: the whole Marathon division and Central", async () => {
    const got = destinations(await openSheet("concrete"));
    for (const id of ["hub2", "hub1", "marathon-pe", "trophy", "central", "hub3", "marathon-pine"]) expect(got).toContain(labelFor(id, REGISTRY));
    expect(got).not.toContain(labelFor("concrete", REGISTRY));
  });

});
