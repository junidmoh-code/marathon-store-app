// ─── SETTINGS → ONLINE ORDERS — the gate, the switch write, Resolve ──────────
// Run: npx vitest run src/components/admin/OnlineOrdersSettingsCard.gate.test.jsx
//   1. A non-owner reads NOTHING (asserted on the firebase calls).
//   2. The owner's reads are the switch SCALAR and ONE indexed attentionOpen
//      query — never the /online_orders node.
//   3. The switch writes the /config/transit shape; Resolve writes attention.js.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const onValueMock = vi.fn(() => () => {});
vi.mock("../../firebase", () => ({ database: {} }));
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  update: vi.fn(async () => {}),
  onValue: (...a) => onValueMock(...a),
  query: (r, ...c) => ({ ...r, constraints: c }),
  orderByChild: (f) => ({ orderByChild: f }),
  equalTo: (v) => ({ equalTo: v }),
}));
vi.mock("../PermissionsContext", () => ({ ADMIN_EMAIL: "gunidmoh@gmail.com" }));

const { default: Card, switchUpdate } = await import("./OnlineOrdersSettingsCard.jsx");
const ADMIN = { uid: "admin-uid", email: "gunidmoh@gmail.com" };

async function render(authUser, write = vi.fn(async () => {})) {
  let tree;
  await act(async () => { tree = TestRenderer.create(<Card authUser={authUser} onExit={() => {}} write={write} now={() => 777} />); });
  return tree;
}
const text = (tree) => JSON.stringify(tree.toJSON());
const strings = (c) => (c == null || typeof c === "boolean" ? "" : Array.isArray(c) ? c.map(strings).join("") : typeof c === "object" ? strings(c.props?.children) : String(c));
const button = (tree, re) => tree.root.findAll((n) => n.type === "button" && re.test(`${strings(n.props.children)} ${n.props["aria-label"] || ""}`))[0];

beforeEach(() => { onValueMock.mockReset().mockImplementation(() => () => {}); });

describe("OnlineOrdersSettingsCard", () => {
  it("a non-owner gets nothing and reads nothing", async () => {
    const tree = await render({ uid: "s", email: "rashid@marathon.internal" });
    expect(text(tree)).toMatch(/Junid only/);
    expect(onValueMock).not.toHaveBeenCalled();
  });

  it("the owner reads the switch scalar and ONE indexed attentionOpen query, never the node", async () => {
    await render(ADMIN);
    const targets = onValueMock.mock.calls.map(([r]) => r);
    expect(targets.map((r) => r.path).sort()).toEqual(["config/onlineOrders/enabled", "online_orders"]);
    const q = targets.find((r) => r.path === "online_orders");
    expect(q.constraints).toEqual([{ orderByChild: "attentionOpen" }, { equalTo: true }]);
  });

  it("switchUpdate is the /config/transit shape", () => {
    expect(switchUpdate(true, "u", 9)).toEqual({ "config/onlineOrders": { enabled: true, updatedAt: 9, updatedBy: "u" } });
    expect(switchUpdate("yes", null, 9)).toEqual({ "config/onlineOrders": { enabled: false, updatedAt: 9, updatedBy: null } });
  });

  it("turning it on takes a second tap, then writes the switch once", async () => {
    onValueMock.mockImplementation((r, cb) => { if (r.path === "config/onlineOrders/enabled") cb({ val: () => null }); else cb({ val: () => null }); return () => {}; });
    const write = vi.fn(async () => {});
    const tree = await render(ADMIN, write);
    await act(async () => { button(tree, /Toggle online orders/).props.onClick(); });
    expect(write).not.toHaveBeenCalled();
    await act(async () => { await button(tree, /Turn on/).props.onClick(); });
    expect(write).toHaveBeenCalledWith({ "config/onlineOrders": { enabled: true, updatedAt: 777, updatedBy: "admin-uid" } });
  });

  it("lists an attention row (ref, customer, reason) and Resolve writes the attention.js update", async () => {
    const order = { ref: "WEB-1042", customer: { name: "Thandi M" }, attentionOpen: true, status: "needs_attention",
      attention: { kind: "not_found", reason: "Not found at Marathon PE (Boss Tee size M)", at: 1790000000000 },
      lines: [{ source: { status: "not_found" } }] };
    onValueMock.mockImplementation((r, cb) => { cb({ val: () => (r.path === "online_orders" ? { 5550001: order } : true) }); return () => {}; });
    const write = vi.fn(async () => {});
    const tree = await render(ADMIN, write);
    expect(text(tree)).toMatch(/WEB-1042/);
    expect(text(tree)).toMatch(/Thandi M/);
    expect(text(tree)).toMatch(/Not found at Marathon PE/);
    await act(async () => { await button(tree, /Re-route/).props.onClick(); });
    expect(write).toHaveBeenCalledWith({
      "online_orders/5550001/attention": null, "online_orders/5550001/attentionOpen": null,
      "online_orders/5550001/status": "new", "online_orders/5550001/lines/0/source/status": "reroute",
    });
  });
});
