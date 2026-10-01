// The device stamp: who, on which device, when — on every stock movement (via
// the REAL single writer, applyMovement) and every order / request record.
import { describe, it, expect, beforeEach, vi } from "vitest";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

// ── a fake database, deletes like the real one ──────────────────────────────
let store = {};
let pushN = 0;
function getPath(path) {
  let node = store;
  for (const part of String(path).split("/")) {
    if (node == null || typeof node !== "object") return null;
    node = node[part];
  }
  return node === undefined ? null : node;
}
function setPath(path, value) {
  const parts = String(path).split("/");
  const walk = (node, depth) => {
    const key = parts[depth];
    if (depth === parts.length - 1) { if (value === null) delete node[key]; else node[key] = value; }
    else {
      if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
      walk(node[key], depth + 1);
      if (Object.keys(node[key]).length === 0) delete node[key];
    }
  };
  walk(store, 0);
}
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: async (node) => ({ val: () => getPath(node.path), exists: () => getPath(node.path) != null }),
  update: async (node, updates) => { for (const [k, v] of Object.entries(updates)) setPath(node.path ? `${node.path}/${k}` : k, v); },
  push: () => ({ key: `mv${++pushN}` }),
}));
vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "mc-uid" } } }));

const { deviceStamp, stampKey, stampPatch, stampRecord, stampTxn, stampAt, orderActionName } = await import("../deviceStamp.js");
const { setDeviceIdentity, pickDeviceClaims } = await import("../enrolment.js");
const { setServerTimeOffsetMs } = await import("../../utils/serverTime.js");
const { applyMovement } = await import("../../components/stock/applyMovement.js");
const { stockCellPath } = await import("../../utils/sizeKey.js");

const DEV = "aaaaaaaa-1111-4111-8111-111111111111";
const enrolAs = (name) => setDeviceIdentity({
  claims: pickDeviceClaims({ deviceId: DEV, eid: "e1", personName: name, personId: "p1" }),
  permRecord: { username: "mc", deviceCodeRequired: true, deviceGate: { [DEV]: "e1" } },
  user: { email: "mc@marathon.internal" },
});

beforeEach(() => { store = {}; pushN = 0; mem.clear(); setServerTimeOffsetMs(0); });

describe("deviceStamp", () => {
  it("names the enrolled PERSON on MC's shared login, not MC", () => {
    enrolAs("Sipho");
    const s = deviceStamp("fulfil");
    expect(s).toMatchObject({ deviceId: DEV, personName: "Sipho", action: "fulfil" });
  });

  it("uses the server clock, not the device's", () => {
    enrolAs("Sipho");
    setServerTimeOffsetMs(24 * 3600e3);            // this till's date is a day behind
    const before = Date.now();
    const s = deviceStamp();
    expect(s.atMs).toBeGreaterThanOrEqual(before + 24 * 3600e3);
    expect(s.atMs).toBeLessThan(before + 24 * 3600e3 + 5000);
  });

  it("a login without codes stamps its own account name and the browser's id", () => {
    setDeviceIdentity({ claims: pickDeviceClaims({}), permRecord: { displayName: "Mike" }, user: {} });
    const s = deviceStamp();
    expect(s.personName).toBe("Mike");
    expect(typeof s.deviceId).toBe("string");
  });

  it("keys are RTDB-safe and one per action", () => {
    expect(stampKey({ atMs: 1790000000000, deviceId: DEV })).toBe("1790000000000_aaaaaaaa");
    expect(stampKey({ atMs: 5, deviceId: "a.b/c#d$e[f]" })).toBe("5_abcdef");
    expect(stampKey({})).toBe("0_nodevice");
  });

  it("stampPatch/stampAt add one history entry; stampRecord keeps the earlier ones", () => {
    enrolAs("Sipho");
    const p = stampPatch({ status: "ready" }, "ready");
    const keys = Object.keys(p).filter((k) => k.startsWith("stamps/"));
    expect(keys).toHaveLength(1);
    expect(p.status).toBe("ready");
    const at = stampAt("orders/042", "fulfil");
    expect(Object.keys(at)[0]).toMatch(/^orders\/042\/stamps\/\d+_aaaaaaaa$/);
    const rec = stampRecord({ id: "x", stamps: { old: { personName: "Thandi" } } }, "reject");
    expect(Object.keys(rec.stamps)).toHaveLength(2);
    expect(rec.stamps.old.personName).toBe("Thandi");
  });

  it("stampTxn stamps only a committed record — never a probe or an abort", () => {
    enrolAs("Sipho");
    const t = stampTxn((cur) => (cur === null ? null : cur.status === "open" ? { ...cur, status: "cancelled" } : undefined), "reject");
    expect(t(null)).toBe(null);
    expect(t({ status: "fulfilled" })).toBe(undefined);
    const next = t({ status: "open" });
    expect(next.status).toBe("cancelled");
    expect(Object.values(next.stamps)[0]).toMatchObject({ personName: "Sipho", action: "reject" });
  });

  it("orderActionName", () => {
    expect(orderActionName({ status: "out_of_stock", outOfStockAt: "x" })).toBe("out_of_stock");
    expect(orderActionName({ clothingRefillStatus: "rejected", clothingOutOfStockAt: "x", updatedAt: "y" })).toBe("clothingRefillStatus");
    expect(orderActionName({ updatedAt: "y" })).toBe("update");
    expect(orderActionName(null)).toBe("update");
  });
});

describe("every stock movement carries it — through the real single writer", () => {
  it("a transfer records deviceId, personName and the server time; the link names the device too", async () => {
    enrolAs("Sipho");
    setPath(stockCellPath("central", "p1", "M"), { qty: 3, v: 1, mv: "m0", lastType: "received" });
    const res = await applyMovement({ type: "transfer_out", productId: "p1", size: "M", qty: 1, from: "central", to: "hub2", reason: "manual" }, { maxRetries: 1 });
    expect(res.ok).toBe(true);
    const mv = Object.values(getPath("stock_movements"))[0];
    expect(mv.by).toMatchObject({ deviceId: DEV, personName: "Sipho" });
    expect(mv.by.action).toBeUndefined();
    expect(typeof mv.by.atMs).toBe("number");
    expect(mv.link.deviceId).toBe(DEV);
    expect(mv.actor).toBe("mc-uid");
  });

  it("a caller's own link.deviceId is kept", async () => {
    enrolAs("Sipho");
    setPath(stockCellPath("hub1", "p1", "9"), { qty: 1, v: 1, mv: "m0", lastType: "received" });
    await applyMovement({ type: "adjustment", productId: "p1", size: "9", qty: 1, from: "hub1", reason: "count", link: { deviceId: "counted-on-this" } }, { maxRetries: 1 });
    const mv = Object.values(getPath("stock_movements"))[0];
    expect(mv.link.deviceId).toBe("counted-on-this");
    expect(mv.by.deviceId).toBe(DEV);
  });
});
