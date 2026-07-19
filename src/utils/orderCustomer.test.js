// Tests for the order-time customer identity flow (placeOrders).
// A fake in-memory RTDB backs the mocked firebase/database layer; transactions
// are serialised per path so the concurrency case exercises the real race:
// two near-simultaneous orders for the same phone must mint ONE customer and
// ONE code, and both orders must carry that same code.

import { describe, it, expect, vi, beforeEach } from "vitest";

let db;
const pathGet = (p) => p.split("/").reduce((a, k) => a?.[k], db);
const pathSet = (p, v) => {
  const ks = p.split("/");
  let n = db;
  for (const k of ks.slice(0, -1)) n = (n[k] ??= {});
  n[ks.at(-1)] = v;
};

const getMock = vi.fn(async (r) => ({ val: () => pathGet(r.path) ?? null }));
const updateMock = vi.fn(async (r, patch) => {
  pathSet(r.path, { ...(pathGet(r.path) || {}), ...patch });
});
const setMock = vi.fn();
// Per-path serialised transactions: updateFn sees the value left by the
// previous committed transaction on that path, never an interleaved one.
const txQueues = new Map();
const runTransactionMock = vi.fn((r, fn) => {
  const prev = txQueues.get(r.path) || Promise.resolve();
  const run = prev.then(() => {
    const cur = pathGet(r.path) ?? null;
    const next = fn(cur);
    if (next === undefined) return { committed: false, snapshot: { val: () => cur } };
    pathSet(r.path, next);
    return { committed: true, snapshot: { val: () => next } };
  });
  txQueues.set(r.path, run.catch(() => {}));
  return run;
});

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  get: (...a) => getMock(...a),
  update: (...a) => updateMock(...a),
  set: (...a) => setMock(...a),
  runTransaction: (...a) => runTransactionMock(...a),
}));
vi.mock("../firebase.js", () => ({ database: {} }));

const { ensureOrderCustomer, resolveOrderCustomer } = await import("./orderCustomer.js");

beforeEach(() => {
  db = {};
  txQueues.clear();
  getMock.mockClear().mockImplementation(async (r) => ({ val: () => pathGet(r.path) ?? null }));
  updateMock.mockClear();
  setMock.mockClear();
  runTransactionMock.mockClear();
});

const PHONE = "+27656996104"; // what placeOrders stores on the order
const KEY = "0656996104";     // the canonical local key it must mint/resolve

describe("ensureOrderCustomer — order-time identity", () => {
  it("NEW customer: record minted at the 0… key WITH a C-number; identity returned for the order", async () => {
    const res = await ensureOrderCustomer(PHONE, "Sthe Dlamini", "2026-07-19T08:00:00Z", true);

    expect(res).toEqual({ customerId: KEY, customerCode: "C-1001" });
    const rec = db.customers[KEY];
    expect(rec.code).toBe("C-1001");
    expect(rec.phone).toBe(PHONE);            // order's own format kept on a fresh record
    expect(rec.name).toBe("Sthe Dlamini");
    expect(rec.orderCount).toBe(1);
    expect(rec.optedIn).toBe(true);
    expect(rec.firstOrderAt).toBe("2026-07-19T08:00:00Z");
    expect(db.customers_meta.lastCode).toBe(1001);
    // No 27-form twin was minted anywhere.
    expect(db.customers["27656996104"]).toBeUndefined();
  });

  it("EXISTING customer WITH a code: same code returned, NO new code minted, counter untouched", async () => {
    pathSet(`customers/${KEY}`, { phone: "0656996104", name: "Sthe", code: "C-1042", orderCount: 3, firstOrderAt: "2026-07-01" });
    const res = await ensureOrderCustomer(PHONE, "Sthe Dlamini", "2026-07-19T08:00:00Z", false);

    expect(res).toEqual({ customerId: KEY, customerCode: "C-1042" });
    expect(db.customers_meta?.lastCode).toBeUndefined(); // counter transaction never ran
    expect(db.customers[KEY].orderCount).toBe(4);        // bookkeeping still upserted
    expect(db.customers[KEY].optedIn).toBeUndefined();   // optedIn=false never reverts/writes
  });

  it("EXISTING customer with NO code (pre-PR store-app record): gets a code now, at its existing key", async () => {
    pathSet("customers/27656996104", { phone: "+27656996104", name: "Legacy", orderCount: 2 }); // 27-keyed, no code
    const res = await ensureOrderCustomer(PHONE, "Legacy", "2026-07-19T08:00:00Z", false);

    expect(res).toEqual({ customerId: "27656996104", customerCode: "C-1001" }); // resolved in place
    expect(db.customers["27656996104"].code).toBe("C-1001");
    expect(db.customers["27656996104"].orderCount).toBe(3);
    expect(db.customers["0656996104"]).toBeUndefined(); // no 0-form twin minted
    expect(db.customers_meta.lastCode).toBe(1001);
  });

  it("existing record with a MALFORMED code gets a real one (treated as no code)", async () => {
    pathSet(`customers/${KEY}`, { phone: "0656996104", name: "X", code: "not-a-code", orderCount: 1 });
    const res = await ensureOrderCustomer(PHONE, "X", "2026-07-19T08:00:00Z", false);
    expect(res.customerCode).toBe("C-1001");
    expect(db.customers[KEY].code).toBe("C-1001");
  });

  it("no usable phone digits → null (caller treats like refill, no customer fields)", async () => {
    expect(await ensureOrderCustomer("", "X", "t", false)).toBe(null);
    expect(db.customers).toBeUndefined();
  });
});

describe("ensureOrderCustomer — concurrency (two near-simultaneous orders, same phone)", () => {
  it("mints ONE customer and ONE code; BOTH callers carry the same code", async () => {
    const [r1, r2] = await Promise.all([
      ensureOrderCustomer(PHONE, "A", "t1", false),
      ensureOrderCustomer(PHONE, "A", "t2", false),
    ]);

    expect(r1.customerId).toBe(KEY);
    expect(r2.customerId).toBe(KEY);
    expect(r1.customerCode).toBe(r2.customerCode);   // both orders carry the winner
    const keys = Object.keys(db.customers);
    expect(keys).toEqual([KEY]);                     // exactly one record
    expect(db.customers[KEY].code).toBe(r1.customerCode);
    // orderCount bookkeeping is a non-transactional read-modify-write (as it
    // was before this PR): both callers resolved before either wrote, so both
    // patches write count 1. The identity guarantee — one record, one code —
    // is what the claim transaction protects.
    expect(db.customers[KEY].orderCount).toBe(1);
    // Both reserved a counter value but only one claim committed — one code
    // is gapped (accepted trade-off, same as the POS).
    expect(db.customers_meta.lastCode).toBe(1002);
    expect(r1.customerCode).toBe("C-1001");
  });
});

describe("resolveOrderCustomer — the never-blocking wrapper", () => {
  it("resolution failure → { customerPending: true }, no crash, NO half-written customer", async () => {
    getMock.mockRejectedValueOnce(new Error("permission denied"));
    const res = await resolveOrderCustomer(PHONE, "A", "t", false);

    expect(res).toEqual({ customerPending: true });
    expect(db.customers).toBeUndefined();      // nothing written at all
    expect(db.customers_meta).toBeUndefined(); // counter untouched
  });

  it("success passes through the identity; no-phone passes through null", async () => {
    expect(await resolveOrderCustomer(PHONE, "A", "t", false)).toEqual({ customerId: KEY, customerCode: "C-1001" });
    expect(await resolveOrderCustomer("", "A", "t", false)).toBe(null);
  });

  it("a HANGING resolve (flaky RTDB, never rejects) times out to pending instead of stalling checkout", async () => {
    vi.useFakeTimers();
    try {
      getMock.mockImplementationOnce(() => new Promise(() => {})); // never settles
      const p = resolveOrderCustomer(PHONE, "A", "t", false);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(p).resolves.toEqual({ customerPending: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a successful resolve does NOT log a spurious timeout warning afterwards", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const p = resolveOrderCustomer(PHONE, "A", "t", false);
      await expect(p).resolves.toEqual({ customerId: KEY, customerCode: "C-1001" });
      await vi.advanceTimersByTimeAsync(6000); // would fire the timeout if it weren't cleared
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bookkeeping update failure AFTER a committed code claim still returns the claimed identity", async () => {
    updateMock.mockRejectedValueOnce(new Error("network blip"));
    const res = await resolveOrderCustomer(PHONE, "A", "t", false);

    // The code was claimed, so the order carries the real identity — not pending.
    expect(res).toEqual({ customerId: KEY, customerCode: "C-1001" });
    expect(db.customers[KEY].code).toBe("C-1001"); // claim landed; bookkeeping can self-heal next order
  });
});
