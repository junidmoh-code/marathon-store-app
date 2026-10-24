// ─── THE ONE LIST, RENDERED FOR REAL (owner spec 2026-08-08) ─────────────────
// refillQueueCore.test.js pins the pure bridge; this renders the actual
// component, because every directive here is a WIRING claim:
//
//   1. A former hold is an ORDINARY request line — no badge, no order number,
//      no customer name, nothing marking it. The worked example is built
//      verbatim: Adidas Adi 2000 White Grey, size 5 from a sale and size 7
//      from a hold, two identical lines in one list.
//   2. Every row has the SAME actions with the SAME wording — Fulfil and
//      Out of Stock — whatever raised it. The old "Transfer N units to Hub"
//      button is gone.
//   3. Release windows gate EVERYTHING: a clothing sale cell waits for the
//      next window exactly like a sneaker request. No category, no origin
//      exempt. The admin early-release override survives, requests only.
//   4. The page is quiet: ONE status line, and none of the old chrome.
//
// Fixed clock: serverNowMs = 2026-08-07T10:00:00Z = 12:00 SA. Default windows
// 06:00/14:00 SA → last release 04:00Z, next 14:00 SA.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const NOW = Date.parse("2026-08-07T10:00:00.000Z");

const paths = {};   // onValue subscriptions
const gets = {};    // one-shot get() reads
const rejects = new Set();   // paths whose get() fails (offline simulation)
const updateMock = vi.fn(() => Promise.resolve());
// runTransaction, modelled on the real client: the FIRST pass sees the cold
// local cache (null); a null answer is a probe that fails the server's
// compare, so the body re-runs against the true node. undefined = abort.
const txnWrites = [];
const txnMock = vi.fn(async (r, fn) => {
  const id = r.path.split("/")[1];
  const server = paths["refill_requests"]?.[id] ?? null;
  let next = fn(null);
  if (next === null && server !== null) next = fn(JSON.parse(JSON.stringify(server)));
  if (next === undefined) return { committed: false, snapshot: { val: () => server } };
  txnWrites.push({ path: r.path, value: next });
  return { committed: true, snapshot: { val: () => next } };
});
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  onValue: (r, cb) => { cb({ val: () => paths[r.path] ?? null }); return () => {}; },
  update: (...a) => updateMock(...a),
  runTransaction: (...a) => txnMock(...a),
  serverTimestamp: () => ({ ".sv": "timestamp" }),
  get: (r) => rejects.has(r.path) ? Promise.reject(new Error("offline")) : Promise.resolve({ val: () => gets[r.path] ?? null }),
  // The per-device reject log (src/device/rejectCount.js).
  push: (...a) => pushMock(...a),
  set: () => Promise.resolve(),
  increment: (n) => ({ increment: n }),
}));
const pushMock = vi.fn(() => Promise.resolve());
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
const perm = { permRecord: { stockRole: "warehouse" }, isSuperAdmin: false };
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ ...perm }) }));
const applyMovementMock = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock("./applyMovement", () => ({ applyMovement: (...a) => applyMovementMock(...a) }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => new Date(NOW).toISOString(), serverNowMs: () => NOW }));
// LIVE SETTING: no switch mock — config/saleRaisedRequests.js as shipped (OFF).

const { default: RefillQueue } = await import("./RefillQueue.jsx");
const { pendingSaleRows } = await import("./refillQueueCore.js");
const { setDeviceGatesForTest } = await import("../../device/deviceGatesSwitch.js");
const { setDeviceIdentity } = await import("../../device/enrolment.js");

// 05:00 SA — before the 06:00 release → pickable. 07:00+ SA — waiting for 14:00.
const RELEASED_AT = "2026-08-07T03:00:00.000Z";
const WAITING_AT = "2026-08-07T05:00:00.000Z";

const PRODUCTS = [
  { id: "adi", name: "Adidas Adi 2000 White Grey", photoUrl: null },
  { id: "boot", name: "Timberland Premium 6-Inch Wheat", photoUrl: null },
  { id: "cap", name: "New Era 9Forty Navy", photoUrl: null },
  { id: "tee", name: "Essentials Tee Olive", photoUrl: null },
];

const fulfilCtx = {
  canTransfer: true, actorRole: "warehouse", locationsReg: undefined,
  knownLoc: () => true,
  resolveId: (p) => p.productId || null,
};

// The worked example's sale half + a WAITING clothing sale cell, built through
// the REAL bridge so the row shape can never drift from production.
function saleRowsFixture() {
  return pendingSaleRows({
    counts: {
      adi: { productName: "Adidas Adi 2000 White Grey", productId: "adi", nameKey: "adidas_adi_2000_white_grey", photo: "", photoUrl: null, sizes: { 5: 1 } },
      tee: { productName: "Essentials Tee Olive", productId: "tee", nameKey: "essentials_tee_olive", photo: "", photoUrl: null, sizes: { L: 1 } },
    },
    responses: {}, progress: {}, date: "2026-08-07",
    tsBySize: { adi: { 5: Date.parse(RELEASED_AT) }, tee: { L: Date.parse("2026-08-07T05:30:00.000Z") } },
    fallbackMs: Date.parse("2026-08-06T22:00:00.000Z"),
  });
}

const textOf = (n) => {
  if (n == null || n === false) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  return textOf(n.children);
};
const buttonsOf = (tree, label) =>
  tree.root.findAll((n) => n.type === "button" && textOf(n.props.children).trim() === label);
const sizeLineOf = (tree, size, origin) =>
  tree.root.findAll((n) => n.props && n.props["data-size"] === size && n.props["data-origin"] === origin)[0];
const rowLineOf = (tree, rowKey) =>
  tree.root.findAll((n) => n.props && n.props["data-row"] === rowKey)[0];
const lineButton = (line, label) =>
  line.findAll((n) => n.type === "button").find((n) => textOf(n.props.children).trim() === label);
function renderQueue(props = {}) {
  let tree;
  act(() => {
    tree = TestRenderer.create(
      <RefillQueue products={PRODUCTS} dest="hub1" fulfilCtx={fulfilCtx} saleRows={saleRowsFixture()} {...props} />
    );
  });
  return tree;
}
function renderText(props = {}) {
  const tree = renderQueue(props);
  const text = textOf(tree.toJSON());
  tree.unmount();
  return text;
}

beforeEach(() => {
  for (const k of Object.keys(paths)) delete paths[k];
  for (const k of Object.keys(gets)) delete gets[k];
  updateMock.mockClear(); txnMock.mockClear(); txnWrites.length = 0;
  applyMovementMock.mockClear();
  rejects.clear();
  perm.permRecord = { stockRole: "warehouse" };
  perm.isSuperAdmin = false;
  paths["refill_requests"] = {
    // The worked example's hold half: size 7 raised by a customer hold. The
    // stamp and order id are IN THE DATA — the row must show none of it.
    holdreq: { productId: "adi", size: "7", qty: 1, requestingLocation: "hub1", status: "open",
               createdAt: RELEASED_AT,
               createdFrom: { manual: true, source: "central", via: "on_hold", orderId: "042", orderDate: "2026-08-07" } },
    // An engine request, released.
    bootreq: { productId: "boot", size: "7", qty: 2, requestingLocation: "hub1", status: "open",
               createdAt: RELEASED_AT, createdFrom: { engine: true, source: "central" } },
    // A sneaker request raised AFTER the 06:00 release → waiting.
    capreq: { productId: "cap", size: "M", qty: 1, requestingLocation: "hub1", status: "open",
              createdAt: WAITING_AT, createdFrom: { manual: true, source: "central", via: "missing_sneakers" } },
  };
  paths["stock/hub1"] = null;
  paths["refill_engine/open"] = null;
  paths["config/refillEngine"] = null;   // absent → default 06:00/14:00
  gets["refill_requests/holdreq"] = paths["refill_requests"].holdreq;
  gets["refill_requests/bootreq"] = paths["refill_requests"].bootreq;
  gets["stock/central/adi/7"] = { qty: 3 };
  gets["stock/central/adi/5"] = { qty: 2 };
  gets["stock/central/boot/7"] = { qty: 5 };
});


describe("sale-raised requests OFF (Junid, 24 Oct) — the live setting", () => {
  it("no sale line is pickable work — not even a released one", () => {
    const tree = renderQueue({ dest: "hub2" });
    const saleLines = tree.root.findAll((n) => n.props && n.props["data-origin"] === "sale");
    expect(saleLines).toHaveLength(0);
  });
  it("the sale cells are still SHOWN, as information, under the status line's detail", () => {
    const tree = renderQueue({ dest: "hub2" });
    const status = tree.root.findAll((n) => n.type === "button" && /already covered/.test(textOf(n.props.children)))[0];
    expect(status).toBeTruthy();
    act(() => status.props.onClick());
    const covered = tree.root.findAll((n) => n.props && typeof n.props["data-policy-covered"] === "string");
    expect(covered.length).toBe(2);
    expect(covered.map((c) => textOf(c)).join(" ")).toMatch(/only the scan raises requests|hourly scan/);
  });
});
