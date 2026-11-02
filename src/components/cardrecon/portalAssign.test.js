import { describe, it, expect } from "vitest";
import { assignTidFromHash, consumeAssignHash, takeAssignRequest, unassignedRows, isAssigned, ASSIGN_STORE_KEY } from "./portalAssign";

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

describe("the POS's Assign link", () => {
  it("reads a TID and nothing else", () => {
    expect(assignTidFromHash("#card-assign=0000new1")).toBe("0000NEW1");
    expect(assignTidFromHash("#card-assign=../x")).toBe(null);
    expect(assignTidFromHash("#bt-pair=1234")).toBe(null);
  });
  it("opens Card machines once, and a stale request is dropped", () => {
    const storage = mem();
    const replaced = [];
    const tid = consumeAssignHash({ location: { hash: "#card-assign=0000NEW1", pathname: "/", search: "" }, history: { replaceState: (...a) => replaced.push(a) }, storage, nowMs: 1000 });
    expect(tid).toBe("0000NEW1");
    expect(storage.getItem("marathon_role")).toBe("card_recon");
    expect(replaced.length).toBe(1);
    expect(takeAssignRequest({ storage, nowMs: 2000 })).toBe("0000NEW1");
    expect(takeAssignRequest({ storage, nowMs: 2000 })).toBe(null);
    storage.setItem(ASSIGN_STORE_KEY, JSON.stringify({ tid: "0000NEW1", at: 0 }));
    expect(takeAssignRequest({ storage, nowMs: 11 * 60 * 1000 })).toBe(null);
  });
});

describe("the unassigned list", () => {
  it("newest first, with the last day's money; one assigned since (O/0 folded) drops out", () => {
    const rows = unassignedRows({
      NEW1: { tid: "0000NEW1", merchantNo: "0005377331", firstSeenAt: 1, lastSeenAt: 5, days: { "2026-11-03": { txns: 2, cents: 5000 }, "2026-11-04": { txns: 1, cents: 100 } } },
      F3Y: { tid: "0000OF3Y", lastSeenAt: 9, days: {} },
    });
    expect(rows.map((r) => r.tid)).toEqual(["0000OF3Y", "0000NEW1"]);
    expect(rows[1].lastDay).toBe("2026-11-04");
    expect(rows[1].lastDayCents).toBe(100);
    expect(isAssigned(rows[0], { "00000F3Y": {} })).toBe(true);
    expect(isAssigned(rows[1], { "00000F3Y": {} })).toBe(false);
  });
});
