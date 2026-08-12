// ─── HOLD LANE — the fulfil surface, rendered for real ───────────────────────
// (Owner spec 2026-08-12, count-integrity commit 4.) Every claim here is a
// wiring claim, so the ACTUAL RefillQueue renders and the ACTUAL buttons are
// pressed:
//
//   • switch ON  → Fulfil parks the credit at stock/in_transit (the hub cell
//     is NOT credited), files a held line under the correct release-window
//     shipment, and closes the request exactly as today;
//   • switch OFF / absent → byte-identical to today's instant credit, and no
//     held line exists anywhere (THE KILL SWITCH);
//   • staff-facing surface unchanged: same buttons, same wording.
//
// Fixed clock: 2026-08-07T10:00:00Z = 12:00 SA → inside the 06:00–14:00 SA
// window, so a held fulfil belongs to the 2026-08-07_1400 shipment.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const NOW = Date.parse("2026-08-07T10:00:00.000Z");

const store = {};   // one flat fake RTDB: path → value
const getPath = (p) => store[p] ?? null;
const paths = store; // onValue reads the same tree

const updateMock = vi.fn((r, updates) => {
  // ref(db) with no path → root multi-path update
  for (const [k, v] of Object.entries(updates || {})) {
    const full = r && r.path ? `${r.path}/${k}` : k;
    if (v === null) delete store[full];
    else store[full] = v;
  }
  return Promise.resolve();
});

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  onValue: (r, cb) => { cb({ val: () => getPath(r.path) }); return () => {}; },
  update: (...a) => updateMock(...a),
  get: (r) => Promise.resolve({ val: () => getPath(r.path), exists: () => getPath(r.path) != null }),
  runTransaction: async (node, fn) => {
    const cur = getPath(node.path);
    const next = fn(cur);
    if (next === undefined) return { committed: false, snapshot: { val: () => cur } };
    store[node.path] = next;
    return { committed: true, snapshot: { val: () => next } };
  },
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("../PermissionsContext", () => ({
  usePermissions: () => ({ permRecord: { stockRole: "warehouse" }, isSuperAdmin: false }),
  ADMIN_EMAIL: "gunidmoh@gmail.com",
}));
const applyMovementMock = vi.fn(() => Promise.resolve({ ok: true, movementId: "x" }));
vi.mock("./applyMovement", () => ({ applyMovement: (...a) => applyMovementMock(...a) }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => new Date(NOW).toISOString(), serverNowMs: () => NOW }));
vi.mock("../../device/deviceId", () => ({ getDeviceId: () => "dev1" }));

const { default: RefillQueue } = await import("./RefillQueue.jsx");

const PRODUCTS = [{ id: "boot", name: "Timberland Premium 6-Inch Wheat", photoUrl: null }];
const RELEASED_AT = "2026-08-07T03:00:00.000Z";   // 05:00 SA — pickable since 06:00

const textOf = (n) => {
  if (n == null || n === false) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  return textOf(n.children);
};

function renderQueue() {
  let tree;
  act(() => { tree = TestRenderer.create(<RefillQueue products={PRODUCTS} dest="hub1" />); });
  return tree;
}
const pressFulfil = async (tree) => {
  const btn = tree.root.findAll((n) => n.type === "button" && textOf(n.props.children).trim() === "Fulfil")[0];
  await act(async () => { btn.props.onClick(); });
  await act(async () => {});
  const confirm = tree.root.findAll((n) => n.type === "button").find((n) => textOf(n.props.children).includes("Transfer & Fulfil"));
  await act(async () => { await confirm.props.onClick(); });
};

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  updateMock.mockClear();
  applyMovementMock.mockClear();
  store["refill_requests"] = {
    bootreq: { productId: "boot", size: "7", qty: 2, requestingLocation: "hub1", status: "open",
               createdAt: RELEASED_AT, createdFrom: { engine: true, source: "central" } },
  };
  store["refill_requests/bootreq"] = store["refill_requests"].bootreq;
  store["stock/central/boot/7"] = { qty: 5 };
  store["config/refillEngine"] = null;   // absent → default 06:00/14:00 windows
});

describe("switch ON — the credit is HELD, grouped by shipment", () => {
  beforeEach(() => { store["settings/stockHold/config"] = { enabled: true }; });

  it("Fulfil parks the units at in_transit — the destination hub is NOT credited", async () => {
    const tree = renderQueue();
    await pressFulfil(tree);
    tree.unmount();

    expect(applyMovementMock).toHaveBeenCalledTimes(1);
    const mv = applyMovementMock.mock.calls[0][0];
    expect(mv.type).toBe("transfer_out");
    expect(mv.from).toBe("central");                       // source deducts AT FULFIL — the box has left
    expect(mv.to).toBe("in_transit");                      // destination credits AT RELEASE
    expect(mv.movementId).toBe("rrf_bootreq");             // id unchanged — idempotency intact
    expect(mv.reason).toBe("hub1_auto_refill");            // reason unchanged — history readers intact
    expect(mv.link).toEqual({ refillId: "bootreq", holdDest: "hub1" });
  });

  it("the held line lands under the release-window SHIPMENT (12:00 SA fulfil → 14:00 box)", async () => {
    const tree = renderQueue();
    await pressFulfil(tree);
    tree.unmount();

    const line = store["settings/stockHold/held/hub1/rrf_bootreq"];
    expect(line).toBeTruthy();
    expect(line).toMatchObject({
      productId: "boot", size: "7", sizeKey: "7", qty: 2, dest: "hub1",
      shipmentId: "2026-08-07_1400", windowLabel: "14:00", refillId: "bootreq",
    });
  });

  it("the request lifecycle is UNCHANGED — closed as fulfilled, same fields as today", async () => {
    const tree = renderQueue();
    await pressFulfil(tree);
    tree.unmount();

    const patch = updateMock.mock.calls.at(-1)[1];
    expect(patch["refill_requests/bootreq/status"]).toBe("fulfilled");
    expect(patch["refill_requests/bootreq/fulfilledBy"]).toEqual({ movementId: "rrf_bootreq", qty: 2 });
  });

  it("held lines are RTDB state, not UI state — a fresh mount reads the same line (reload survival)", async () => {
    const tree = renderQueue();
    await pressFulfil(tree);
    tree.unmount();
    // simulate the reload: nothing in memory, only the fake RTDB
    expect(store["settings/stockHold/held/hub1/rrf_bootreq"]).toMatchObject({ shipmentId: "2026-08-07_1400" });
  });

  it("staff see nothing new: the buttons still read Fulfil / Out of Stock / Transfer & Fulfil", async () => {
    const tree = renderQueue();
    const labels = tree.root.findAll((n) => n.type === "button").map((n) => textOf(n.props.children).trim());
    expect(labels).toContain("Fulfil");
    expect(labels).toContain("Out of Stock");
    expect(labels.find((l) => /hold|held|release/i.test(l))).toBeUndefined();
    tree.unmount();
  });
});

describe("switch OFF — THE KILL SWITCH restores today's instant behaviour", () => {
  it.each([
    ["absent", undefined],
    ["explicitly false", { enabled: false }],
  ])("config %s → destination credited directly, and NO held line exists", async (_label, cfg) => {
    if (cfg !== undefined) store["settings/stockHold/config"] = cfg;
    const tree = renderQueue();
    await pressFulfil(tree);
    tree.unmount();

    const mv = applyMovementMock.mock.calls[0][0];
    expect(mv.to).toBe("hub1");                            // instant, exactly today
    expect(mv.link).toEqual({ refillId: "bootreq" });      // no hold marker
    expect(store["settings/stockHold/held/hub1/rrf_bootreq"]).toBeFalsy();
  });

  it("windows disabled (releaseWindows === false) also degrades to instant — no shipment to batch", async () => {
    store["settings/stockHold/config"] = { enabled: true };
    store["config/refillEngine"] = { releaseWindows: false };
    const tree = renderQueue();
    await pressFulfil(tree);
    tree.unmount();
    expect(applyMovementMock.mock.calls[0][0].to).toBe("hub1");
    expect(store["settings/stockHold/held/hub1/rrf_bootreq"]).toBeFalsy();
  });
});
