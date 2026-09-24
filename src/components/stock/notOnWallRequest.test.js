// ─── "NOT ON THE WALL" AND THE SEND, AGAINST A FAKE RTDB THAT BEHAVES ───────
//
// Owner spec 2026-09-24, commit 3. Everything here runs the REAL writers —
// displayRequestStore, displayRowStore, displaySlots, orderCounter — through a
// fake database, never a vi.fn() standing in for the thing under test.
//
// THE FAKE IS HONEST ABOUT THREE THINGS the real RTDB does and a naive map
// does not:
//   1. an empty array (or an object whose children are all empty) is DELETED
//      and reads back null — "Real RTDB deletes empty-array children";
//   2. `update()` is a multi-path merge; `null` deletes;
//   3. `runTransaction` returning `undefined` ABORTS, and every transaction on
//      one path is serialised — which is what makes a double tap a race worth
//      testing at all. Each await yields, so two taps genuinely interleave.
import { describe, it, expect, vi, beforeEach } from "vitest";

let TREE = {};
let NOW = Date.parse("2026-09-24T10:00:00.000Z");
let AUTO_TICK = 0;                           // ms the clock advances on every read of it
const tick = () => new Promise((r) => setTimeout(r, 0));

const segs = (p) => String(p || "").split("/").filter(Boolean);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// (1) the real coercion on the way in
const coerce = (v) => {
  if (Array.isArray(v)) {
    const out = {};
    v.forEach((x, i) => { const c = coerce(x); if (c != null) out[String(i)] = c; });
    return Object.keys(out).length ? out : null;
  }
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) { const c = coerce(x); if (c != null) out[k] = c; }
    return Object.keys(out).length ? out : null;
  }
  return v === undefined ? null : v;
};
const read = (path) => {
  let n = TREE;
  for (const s of segs(path)) { if (n == null || typeof n !== "object" || !(s in n)) return null; n = n[s]; }
  return clone(n);
};
const prune = (node) => {
  if (!node || typeof node !== "object") return node;
  for (const k of Object.keys(node)) {
    node[k] = prune(node[k]);
    if (node[k] == null) delete node[k];
  }
  return Object.keys(node).length ? node : null;
};
const write = (path, value) => {
  const s = segs(path);
  const c = coerce(clone(value));
  if (!s.length) { TREE = c || {}; return; }
  let n = TREE;
  for (const k of s.slice(0, -1)) { if (!n[k] || typeof n[k] !== "object") n[k] = {}; n = n[k]; }
  if (c == null) delete n[s[s.length - 1]]; else n[s[s.length - 1]] = c;
  TREE = prune(TREE) || {};
};
const locks = new Map();                     // path -> tail promise (serialise txns)

vi.mock("firebase/database", () => ({
  ref: (_db, path = "") => path,
  child: (base, path) => [base, path].filter(Boolean).join("/"),
  get: async (path) => { await tick(); const v = read(path); return { val: () => v, exists: () => v != null }; },
  set: async (path, value) => { await tick(); write(path, value); },
  update: async (path, patch) => {
    await tick();
    for (const [k, v] of Object.entries(patch)) write([path, k].filter(Boolean).join("/"), v);
  },
  runTransaction: async (path, fn) => {
    const prev = locks.get(path) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    locks.set(path, prev.then(() => mine));
    await prev;
    try {
      await tick();
      const cur = read(path);
      const next = fn(cur);
      if (next === undefined) return { committed: false, snapshot: { val: () => cur } };
      write(path, next);
      const after = read(path);
      return { committed: true, snapshot: { val: () => after } };
    } finally { release(); }
  },
}));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "junid", email: "junid@marathon.internal" } } }));
vi.mock("../../utils/serverTime", () => ({
  serverNowMs: () => { NOW += AUTO_TICK; return NOW; },
  serverNowIso: () => { NOW += AUTO_TICK; return new Date(NOW).toISOString(); },
  saTodayKey: () => "2026-09-24",
}));
vi.mock("../../offline/pendingWrites", () => ({ notePendingUpdate: () => {} }));

const { raiseDisplayRequest } = await import("./displayRequestStore");
const { sendDisplayRow, registerDisplayRow } = await import("./displayRowStore");
const { REQUEST_LOCK_MS, WALL_WALK_STATUS } = await import("./displayRequestCore");
const { isOpenDisplayRequest, openRowsFor } = await import("./displayRowCore");

const PID = "p1790000000001";
const product = { id: PID, name: "Diesel Big D Green Orange", hubs: ["hub1"], category: "Footwear", productType: "sneaker" };
const hubData = (h1, h2) => ({
  hub1: { ready: true, promised: {}, cells: h1 ? { [PID]: h1 } : {} },
  hub2: { ready: true, promised: {}, cells: h2 ? { [PID]: h2 } : {} },
});
const ordersNow = () => Object.values(read("orders") || {});
const wallRequests = () => ordersNow().filter((o) => o.productId === PID && o.requestDisplayPartner === true);
const openRows = (store = "trophy") => openRowsFor(read("settings/displayRows"), store, PID);

beforeEach(() => {
  TREE = { orderCounter: { day: "2026-09-24", counter: 41 } };
  NOW = Date.parse("2026-09-24T10:00:00.000Z");
  AUTO_TICK = 0;
  locks.clear();
});

describe("Not on the wall — one request, on the Display Refill card", () => {
  it("creates exactly one request, in the fifteen-minute path's scheduled shape, at the tagged hub", async () => {
    const res = await raiseDisplayRequest({ orders: [], store: "trophy", product, hubData: hubData({ 8: { qty: 2 } }, { 9: { qty: 1 } }) });
    expect(res.ok).toBe(true);
    const all = wallRequests();
    expect(all).toHaveLength(1);
    const o = all[0];
    expect(o.id).toBe("042");
    expect(o.hub).toBe("hub1");
    expect(o.status).toBe(WALL_WALK_STATUS);
    expect(o.destShop).toBe("trophy");
    expect(o.displayRefillScheduledAt).toBe("2026-09-24T10:00:00.000Z");
    expect(o.displayRefillHub).toBe("hub1");
    expect(o.size ?? null).toBeNull();                      // never a size
    expect(o.raisedBy).toBe("junid");
    expect(o.raisedByEmail).toBe("junid@marathon.internal");
    expect(o.raisedAt).toBe("2026-09-24T10:00:00.000Z");
    expect(isOpenDisplayRequest(o)).toBe(true);
  });

  it("falls to the other hub when the tagged hub cannot give a pair out", async () => {
    const res = await raiseDisplayRequest({ orders: [], store: "marathon-pe", product, hubData: hubData({ 8: { qty: 0 } }, { 9: { qty: 1 } }) });
    expect(res.ok).toBe(true);
    expect(res.hub).toBe("hub2");
    expect(wallRequests()[0].displayRefillHub).toBe("hub2");
  });

  it("a ready-promise that takes the tagged hub's last pair sends it to the other hub", async () => {
    const d = hubData({ 8: { qty: 1 } }, { 9: { qty: 1 } });
    d.hub1.promised = { [`${PID}::8`]: 1 };
    const res = await raiseDisplayRequest({ orders: [], store: "trophy", product, hubData: d });
    expect(res.hub).toBe("hub2");
  });

  it("with no stock anywhere, nothing is created and the answer says so", async () => {
    const res = await raiseDisplayRequest({ orders: [], store: "trophy", product, hubData: hubData({ 8: { qty: 0 } }, null) });
    expect(res.ok).toBe(false);
    expect(res.noStock).toBe(true);
    expect(res.message).toMatch(/none in any warehouse/i);
    expect(wallRequests()).toHaveLength(0);
    expect(read("orderCounter/counter")).toBe(41);          // no number drawn
  });

  it("an unread hub is not 'none in any warehouse'", async () => {
    const d = hubData(null, null);
    d.hub1.ready = false;
    const res = await raiseDisplayRequest({ orders: [], store: "trophy", product, hubData: d });
    expect(res.noStock).toBeUndefined();
    expect(wallRequests()).toHaveLength(0);
  });

  it("a double tap makes ONE request (both taps in flight at once)", async () => {
    const args = { orders: [], store: "trophy", product, hubData: hubData({ 8: { qty: 3 } }, null) };
    const [a, b] = await Promise.all([raiseDisplayRequest(args), raiseDisplayRequest(args)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect([a, b].find((r) => !r.ok).already).toBe(true);
    expect(wallRequests()).toHaveLength(1);
  });

  it("a second tap from a device whose /orders has not caught up is still refused", async () => {
    const args = { orders: [], store: "trophy", product, hubData: hubData({ 8: { qty: 3 } }, null) };
    expect((await raiseDisplayRequest(args)).ok).toBe(true);
    NOW += 30 * 1000;                                         // inside the fence
    expect((await raiseDisplayRequest(args)).already).toBe(true);
    NOW += REQUEST_LOCK_MS;                                   // fence expired: the claimed order answers
    const late = await raiseDisplayRequest(args);
    expect(late.already).toBe(true);
    expect(late.orderId).toBe("042");
    expect(wallRequests()).toHaveLength(1);
  });

  it("an open request from the fifteen-minute path blocks a new one", async () => {
    const auto = {
      id: "017", productId: PID, destShop: "trophy", requestDisplayPartner: true, status: "collected",
      displayRefillScheduledAt: "2026-09-24T09:00:00.000Z", displayRefillHub: "hub1", displayRefillStatus: null,
      createdAt: "2026-09-24T08:50:00.000Z",
    };
    TREE.orders = { "017": auto };
    const res = await raiseDisplayRequest({ orders: [auto], store: "trophy", product, hubData: hubData({ 8: { qty: 3 } }, null) });
    expect(res.already).toBe(true);
    expect(res.orderId).toBe("017");
    expect(wallRequests()).toHaveLength(1);
  });

  it("once the request is sent, the wall can be asked again", async () => {
    const args = { orders: [], store: "trophy", product, hubData: hubData({ 8: { qty: 3 } }, null) };
    await raiseDisplayRequest(args);
    write("orders/042/displayRefillStatus", "refilled");
    NOW += REQUEST_LOCK_MS + 1;
    const again = await raiseDisplayRequest({ ...args, orders: ordersNow() });
    expect(again.ok).toBe(true);
    expect(wallRequests().filter(isOpenDisplayRequest)).toHaveLength(1);
  });

  it("clears the wall's display record first — every open row and the slot", async () => {
    await registerDisplayRow({ rows: {}, store: "trophy", productId: PID, productName: product.name, size: "8", bookedHub: "hub1" });
    expect(openRows()).toHaveLength(1);
    NOW += 60 * 1000;
    const res = await raiseDisplayRequest({ orders: [], store: "trophy", product, hubData: hubData({ 8: { qty: 3 } }, null) });
    expect(res.ok).toBe(true);
    expect(openRows()).toHaveLength(0);
    expect(read(`settings/displaySlots/trophy/${PID}/sizeKey`)).toBeNull();
    const closed = Object.values(read(`settings/displayRows/trophy/${PID}`));
    expect(closed[0].closedReason).toBe("corrected");
  });

  it("a slot with no ledger row behind it is cleared too (the marker reads the slot)", async () => {
    write(`settings/displaySlots/trophy/${PID}`, { store: "trophy", productId: PID, size: "8", sizeKey: "8", at: "2026-09-20T10:00:00.000Z" });
    await raiseDisplayRequest({ orders: [], store: "trophy", product, hubData: hubData({ 8: { qty: 3 } }, null) });
    expect(read(`settings/displaySlots/trophy/${PID}/sizeKey`)).toBeNull();
  });
});

describe("a write that reports failure", () => {
  it("but landed is a success, and the fence names the order", async () => {
    const { set: realSet } = await import("firebase/database");
    const mod = await import("firebase/database");
    const spy = vi.spyOn(mod, "set").mockImplementationOnce(async (path, value) => { await realSet(path, value); throw new Error("timeout"); });
    const res = await raiseDisplayRequest({ orders: [], store: "trophy", product, hubData: hubData({ 8: { qty: 3 } }, null) });
    spy.mockRestore();
    expect(res.ok).toBe(true);
    expect(read(`settings/displayRows_meta/requestLocks/trophy/${PID}/orderId`)).toBe("042");
  });

  it("and did NOT land releases the fence", async () => {
    const mod = await import("firebase/database");
    const spy = vi.spyOn(mod, "set").mockImplementationOnce(async () => { throw new Error("denied"); });
    const res = await raiseDisplayRequest({ orders: [], store: "trophy", product, hubData: hubData({ 8: { qty: 3 } }, null) });
    spy.mockRestore();
    expect(res.ok).toBe(false);
    expect(read(`settings/displayRows_meta/requestLocks/trophy/${PID}`)).toBeNull();
    expect(wallRequests()).toHaveLength(0);
  });
});

describe("CodeRabbit regressions", () => {
  it("a claim a moment in the FUTURE (another device's clock) is still held", async () => {
    // Another device, its clock 5 s ahead, has claimed and not yet written its order.
    write(`settings/displayRows_meta/requestLocks/trophy/${PID}`, { claimAt: NOW + 5000, by: "other" });
    const res = await raiseDisplayRequest({ orders: [], store: "trophy", product, hubData: hubData({ 8: { qty: 3 } }, null) });
    expect(res.already).toBe(true);
    expect(wallRequests()).toHaveLength(0);
    expect(read(`settings/displayRows_meta/requestLocks/trophy/${PID}/by`)).toBe("other");
  });

  it("an unread TAGGED hub gives no answer — it never falls through to the other hub", async () => {
    const d = hubData(null, { 9: { qty: 4 } });
    d.hub1.ready = false;
    const res = await raiseDisplayRequest({ orders: [], store: "trophy", product, hubData: d });
    expect(res.ok).toBe(false);
    expect(res.noStock).toBeUndefined();
    expect(wallRequests()).toHaveLength(0);
  });

  it("a slot that will not clear is a refusal, and nothing is requested", async () => {
    write(`settings/displaySlots/trophy/${PID}`, { store: "trophy", productId: PID, size: "8", sizeKey: "8", at: "2026-09-20T10:00:00.000Z" });
    const mod = await import("firebase/database");
    const real = mod.runTransaction;
    const spy = vi.spyOn(mod, "runTransaction").mockImplementation(async (path, fn) => {
      if (String(path).startsWith("settings/displaySlots")) throw new Error("denied");
      return real(path, fn);
    });
    const res = await raiseDisplayRequest({ orders: [], store: "trophy", product, hubData: hubData({ 8: { qty: 3 } }, null) });
    spy.mockRestore();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/slot could not be cleared/);
    expect(wallRequests()).toHaveLength(0);
  });

  it("an open request outranks a NEWER resolved one for the same wall", async () => {
    const { wallRequestState } = await import("./displayRequestCore");
    const base = { productId: PID, destShop: "trophy", requestDisplayPartner: true, displayRefillHub: "hub1" };
    const st = wallRequestState([
      { ...base, id: "010", createdAt: "2026-09-24T08:00:00.000Z", displayRefillScheduledAt: "2026-09-24T08:00:00.000Z", displayRefillStatus: null, status: "collected" },
      { ...base, id: "020", createdAt: "2026-09-24T09:00:00.000Z", displayRefillScheduledAt: "2026-09-24T09:00:00.000Z", displayRefillStatus: "stockDepleted" },
    ], { store: "trophy", productId: PID });
    expect(st.state).toBe("requested");
    expect(st.order.id).toBe("010");
  });

  it("a failed confirmation READ keeps the fence (outcome unknown)", async () => {
    const mod = await import("firebase/database");
    const realGet = mod.get;
    let failNextOrderRead = false;
    const setSpy = vi.spyOn(mod, "set").mockImplementationOnce(async () => { failNextOrderRead = true; throw new Error("timeout"); });
    const getSpy = vi.spyOn(mod, "get").mockImplementation(async (path) => {
      if (failNextOrderRead && String(path).startsWith("orders/")) throw new Error("offline");
      return realGet(path);
    });
    const res = await raiseDisplayRequest({ orders: [], store: "trophy", product, hubData: hubData({ 8: { qty: 3 } }, null) });
    setSpy.mockRestore(); getSpy.mockRestore();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/may or may not have been saved/);
    expect(read(`settings/displayRows_meta/requestLocks/trophy/${PID}/claimAt`)).not.toBeNull();
  });
});

describe("Send registers the display — replaces, never adds", () => {
  const seedRow = (rowId, size, openedAt) => write(`settings/displayRows/trophy/${PID}/${rowId}`, {
    rowId, store: "trophy", productId: PID, productName: product.name, size, sizeKey: size,
    bookedHub: "hub1", status: "open", openedAt, openedVia: "send", events: [],     // [] → deleted, like RTDB
  });

  it("the old two-sizes case (6 and 8 both open) leaves exactly one row, at the sent size", async () => {
    seedRow("r1", "6", "2026-08-01T10:00:00.000Z");
    seedRow("r2", "8", "2026-08-02T10:00:00.000Z");
    expect(openRows()).toHaveLength(2);
    const res = await sendDisplayRow({ rows: {}, store: "trophy", productId: PID, productName: product.name,
                                       size: "9", bookedHub: "hub1", orderId: "042" });
    expect(res.ok).toBe(true);
    const open = openRows();
    expect(open).toHaveLength(1);
    expect(open[0].size).toBe("9");
    expect(read(`settings/displaySlots/trophy/${PID}/size`)).toBe("9");
    // Closed BY THE SEND'S OWN ATOMIC UPDATE (closedVia "send"), not tidied up
    // afterwards by the settle — the one write moves the whole wall.
    const replaced = Object.values(read(`settings/displayRows/trophy/${PID}`)).filter((r) => r.closedReason === "replaced");
    expect(replaced.map((r) => r.closedVia)).toEqual(["send", "send"]);
  });

  it("a send planned from a STALE snapshot still replaces what is really there", async () => {
    seedRow("r1", "6", "2026-08-01T10:00:00.000Z");
    await sendDisplayRow({ rows: {}, store: "trophy", productId: PID, size: "7", bookedHub: "hub1", orderId: "050" });
    expect(openRows().map((r) => r.size)).toEqual(["7"]);
  });

  it("two sends racing each other converge on ONE open row — the later send's", async () => {
    seedRow("r1", "6", "2026-08-01T10:00:00.000Z");
    AUTO_TICK = 1000;                        // each send stamps its own instant
    const a = sendDisplayRow({ rows: {}, store: "trophy", productId: PID, size: "8", bookedHub: "hub1", orderId: "060" });
    const b = sendDisplayRow({ rows: {}, store: "trophy", productId: PID, size: "9", bookedHub: "hub1", orderId: "061" });
    await Promise.all([a, b]);
    AUTO_TICK = 0;
    // Both planned from the same read, so both closed r1 and each opened its
    // own row: two open rows existed for a moment. The settle leaves one.
    const all = Object.values(read(`settings/displayRows/trophy/${PID}`));
    expect(all.filter((r) => r.openedVia === "send" && r.requestOrderId)).toHaveLength(2);
    expect(openRows().map((r) => r.size)).toEqual(["9"]);
  });

  it("the full loop: not on the wall → send → one display, the request resolved", async () => {
    seedRow("r1", "6", "2026-08-01T10:00:00.000Z");
    const req = await raiseDisplayRequest({ orders: [], store: "trophy", product, hubData: hubData({ 9: { qty: 1 } }, null) });
    expect(openRows()).toHaveLength(0);
    NOW += 16 * 60 * 1000;
    const patch = { displayRefillStatus: "refilled", displayRefilledAt: new Date(NOW).toISOString(), displayRefillSize: "9" };
    await sendDisplayRow({ rows: {}, store: "trophy", productId: PID, size: "9", bookedHub: "hub1", orderId: req.orderId,
      orderPatch: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`orders/${req.orderId}/${k}`, v])) });
    expect(openRows().map((r) => r.size)).toEqual(["9"]);
    expect(openRows()[0].requestOrderId).toBe(req.orderId);
    expect(isOpenDisplayRequest(read(`orders/${req.orderId}`))).toBe(false);
  });
});
