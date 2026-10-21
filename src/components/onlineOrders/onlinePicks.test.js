// ─── WEBSITE ORDERS — the hub's "Handed over" write and the queue rows ───────
// Run: npx vitest run src/components/onlineOrders/onlinePicks.test.js
//
// "Handed over" is ONE multi-path update that flips the pick AND the order
// line together (docs/ONLINE-ORDERS.md). Pinned here key by key, because a
// write that drifted to a different path would leave the POS waiting on a
// line the hub thinks it has handed over — and nothing would say so.
import { describe, it, expect, vi } from "vitest";

const updateMock = vi.fn(async () => {});
vi.mock("../../firebase", () => ({ database: { db: true }, auth: { currentUser: { uid: "u-hub" } } }));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {} }));
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  update: (...a) => updateMock(...a),
  onValue: () => () => {}, query: (r) => r, orderByChild: () => ({}), equalTo: () => ({}),
}));

const { handedOverUpdates, pickQueueRows, pickLocStatus, handOverPick } = await import("./onlinePicks.js");
const { ONLINE_PICKS_PATH, ONLINE_ORDERS_PATH } = await import("../../utils/onlineOrders.js");

const pick = (over = {}) => ({
  key: "5550001_0", kind: "online_pick", orderId: "5550001", ref: "WEB-1042", lineIndex: 0,
  locationId: "hub1", locStatus: "hub1|open", productId: "p1", size: "9", qty: 1, title: "AF1 White",
  status: "open", createdAt: 1000, ...over,
});

describe("handedOverUpdates — the one Handed over write", () => {
  it("flips the pick and the order line to handed in ONE update, nothing else", () => {
    const u = handedOverUpdates(pick(), { hub: "hub1", uid: "u1", nowMs: 1790000000000 });
    expect(u).toEqual({
      "online_picks/5550001_0/status": "handed",
      "online_picks/5550001_0/locStatus": "hub1|handed",
      "online_picks/5550001_0/handedAt": 1790000000000,
      "online_picks/5550001_0/handedBy": "u1",
      "online_orders/5550001/lines/0/source/status": "handed",
      "online_orders/5550001/lines/0/source/handedAt": 1790000000000,
      "online_orders/5550001/lines/0/source/handedBy": "u1",
    });
    // No stock, movement, transfer or /orders path — the one rule of the contract.
    expect(Object.keys(u).every((k) => k.startsWith(`${ONLINE_PICKS_PATH}/`) || k.startsWith(`${ONLINE_ORDERS_PATH}/`))).toBe(true);
  });

  it("the handed locStatus takes the pick OUT of the hub's open query", () => {
    const u = handedOverUpdates(pick(), { hub: "hub1", uid: "u1", nowMs: 1 });
    expect(u["online_picks/5550001_0/locStatus"]).not.toBe(pickLocStatus("hub1", "open"));
  });

  it("a device with no signed-in user cannot hand over (the rules accept only handedBy === auth.uid)", () => {
    expect(() => handedOverUpdates(pick(), { hub: "hub2", uid: null, nowMs: 5 })).toThrow(/sign in/);
    const u = handedOverUpdates(pick(), { hub: "hub2", uid: "u9", nowMs: 5 });
    expect(Object.values(u).every((v) => v !== undefined && v !== null)).toBe(true);
  });

  it("refuses a pick that cannot name its order line (never a guessed write)", () => {
    const bad = [pick({ key: "" }), pick({ orderId: undefined }), pick({ orderId: "a/b" }), pick({ lineIndex: "x" }), pick({ lineIndex: -1 }), pick({ key: "a.b" })];
    for (const p of bad) expect(() => handedOverUpdates(p, { hub: "hub1", uid: "u", nowMs: 1 })).toThrow();
    expect(() => handedOverUpdates(pick(), { hub: "", uid: "u", nowMs: 1 })).toThrow();
    expect(() => handedOverUpdates(pick(), { hub: "hub1", uid: "u", nowMs: NaN })).toThrow();
  });

  it("handOverPick sends exactly that update to the ROOT ref", async () => {
    updateMock.mockClear();
    await handOverPick(pick(), "hub1");
    expect(updateMock).toHaveBeenCalledTimes(1);
    const [r, u] = updateMock.mock.calls[0];
    expect(r.path).toBe("");
    expect(u["online_orders/5550001/lines/0/source/status"]).toBe("handed");
    expect(u["online_picks/5550001_0/handedBy"]).toBe("u-hub");
  });
});

describe("pickQueueRows — picks in the Warehouse queue", () => {
  it("open picks for THIS hub become Incoming rows stamped now, keyed by the pick (not the shared ref)", () => {
    const rows = pickQueueRows([
      pick({ key: "o_1", lineIndex: 1, createdAt: 30 }),
      pick({ key: "o_0", createdAt: 10 }),
      pick({ key: "h2", locationId: "hub2", locStatus: "hub2|open" }),
      pick({ key: "done", status: "handed", locStatus: "hub1|handed" }),
      null,
    ], { hub: "hub1", incomingStatus: "incoming", nowIso: "2026-10-21T10:00:00.000Z" });
    expect(rows.map((r) => r.id)).toEqual(["web:o_0", "web:o_1"]);
    expect(rows.every((r) => r.status === "incoming" && r.isOnlinePick && r.createdAt === "2026-10-21T10:00:00.000Z")).toBe(true);
    expect(rows[0]._pick.key).toBe("o_0");
  });
});
