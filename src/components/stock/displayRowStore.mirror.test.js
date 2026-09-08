// ─── THE CLIENT'S SLOT MIRROR — the half that had no test at all ────────────
//
// `displayRowStore.js` writes the rows AND re-points `/settings/displaySlots`,
// and until now nothing exercised the second half: the two tab render tests
// MOCK this module out entirely, so every assertion about the mirror was really
// an assertion about a `vi.fn()`.
//
// That gap hid a real defect. `rowIsOpen` requires a good `sizeKey` and says
// NOTHING about `size`, so a hand-fixed row, an older shape or a partial write
// can be open, be the survivor, and carry no size. `String(keep.size)` is then
// the NON-EMPTY string "undefined", which `setDisplaySlot` accepts and encodes
// into `sizeKey: "undefined"` — while the ledger row still says "10". The
// mirror represents no row at all, and every reader built on the slot reads a
// size that does not exist.
//
// The trigger's version of the same bug THREW, which is loud and stops the
// write. This one is silent, which is worse. (CodeRabbit.)
import { describe, it, expect, vi, beforeEach } from "vitest";

let DB = {};                        // path -> value
const updates = [];
const slotCalls = [];
const clearCalls = [];

vi.mock("firebase/database", () => ({
  ref: (_db, path) => path,
  get: async (path) => ({ val: () => (DB[path] === undefined ? null : DB[path]) }),
  update: async (_ref, obj) => { updates.push(obj); for (const [k, v] of Object.entries(obj)) DB[k] = v; },
}));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => "2026-09-08T12:00:00.000Z" }));
vi.mock("./displaySlots", () => ({
  setDisplaySlot: async (a) => { slotCalls.push(a); return { ok: true }; },
  clearDisplaySlot: async (a) => { clearCalls.push(a); return { ok: true }; },
}));

const { closeDisplayRow } = await import("./displayRowStore");

const row = (o = {}) => ({
  rowId: "r1", store: "trophy", productId: "p1", productName: "AF1",
  size: "9", sizeKey: "9", bookedHub: "hub1", status: "open",
  openedAt: "2026-09-01T00:00:00.000Z", openedVia: "send", requestOrderId: "417",
  events: {}, ...o,
});
const ROWS = "settings/displayRows/trophy/p1";

beforeEach(() => { DB = {}; updates.length = 0; slotCalls.length = 0; clearCalls.length = 0; });

describe("closing one of several re-points the slot at the survivor", () => {
  it("a survivor with NO `size` mirrors its sizeKey — never the string 'undefined'", async () => {
    const gone = row({ rowId: "a" });
    const keep = row({ rowId: "b", sizeKey: "10", openedAt: "2026-09-02T00:00:00.000Z" });
    delete keep.size;                                   // open, valid, and sizeless
    DB[ROWS] = { a: { ...gone, status: "closed" }, b: keep };
    await closeDisplayRow({ rows: { trophy: { p1: { a: gone, b: keep } } }, row: gone, reason: "corrected" });
    expect(slotCalls).toHaveLength(1);
    expect(slotCalls[0].size).toBe("10");
    expect(slotCalls[0].size).not.toBe("undefined");
  });

  it("the ordinary case still mirrors the survivor's own size", async () => {
    const gone = row({ rowId: "a" });
    const keep = row({ rowId: "b", size: "10", sizeKey: "10", openedAt: "2026-09-02T00:00:00.000Z" });
    DB[ROWS] = { a: { ...gone, status: "closed" }, b: keep };
    await closeDisplayRow({ rows: {}, row: gone, reason: "corrected" });
    expect(slotCalls[0].size).toBe("10");
  });

  it("the survivor's own provenance is carried, not a blanket registration", async () => {
    const gone = row({ rowId: "a" });
    const keep = row({ rowId: "b", size: "10", sizeKey: "10", openedAt: "2026-09-02T00:00:00.000Z",
                       openedVia: "send", requestOrderId: "417" });
    DB[ROWS] = { a: { ...gone, status: "closed" }, b: keep };
    await closeDisplayRow({ rows: {}, row: gone, reason: "corrected" });
    expect(slotCalls[0].source).toBe("display_refill");
    expect(slotCalls[0].orderId).toBe("417");
  });

  it("a wall-walk survivor reads as a registration with no order", async () => {
    const gone = row({ rowId: "a" });
    const keep = row({ rowId: "b", size: "10", sizeKey: "10", openedAt: "2026-09-02T00:00:00.000Z",
                       openedVia: "wall_walk", requestOrderId: null });
    DB[ROWS] = { a: { ...gone, status: "closed" }, b: keep };
    await closeDisplayRow({ rows: {}, row: gone, reason: "corrected" });
    expect(slotCalls[0].source).toBe("registration");
    expect(slotCalls[0].orderId).toBe(null);
  });

  it("the LAST open row going tombstones the slot instead of re-pointing it", async () => {
    const gone = row({ rowId: "a" });
    DB[ROWS] = { a: { ...gone, status: "closed" } };
    await closeDisplayRow({ rows: {}, row: gone, reason: "sold" });
    expect(clearCalls).toHaveLength(1);
    expect(slotCalls).toHaveLength(0);
  });

  it("closing never moves stock, and says so on the result", async () => {
    const gone = row({ rowId: "a" });
    DB[ROWS] = { a: { ...gone, status: "closed" } };
    const res = await closeDisplayRow({ rows: {}, row: gone, reason: "returned" });
    expect(res.ok).toBe(true);
    expect(res.stockMoved).toBe(false);
  });

  it("the survivors are re-read AFTER the close, not taken from the caller's snapshot", async () => {
    // The caller's map still shows `b` open; the database says it has since
    // closed. Deciding from the stale map would re-point at a closed row.
    const gone = row({ rowId: "a" });
    const stale = row({ rowId: "b", size: "10", sizeKey: "10" });
    DB[ROWS] = { a: { ...gone, status: "closed" }, b: { ...stale, status: "closed" } };
    await closeDisplayRow({ rows: { trophy: { p1: { a: gone, b: stale } } }, row: gone, reason: "corrected" });
    expect(clearCalls).toHaveLength(1);
    expect(slotCalls).toHaveLength(0);
  });
});
