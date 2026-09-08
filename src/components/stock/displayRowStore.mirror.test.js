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
let GET_THROWS = null;              // set to an Error to make the ledger re-read fail
const updates = [];
const slotCalls = [];
const clearCalls = [];

vi.mock("firebase/database", () => ({
  ref: (_db, path) => path,
  get: async (path) => { if (GET_THROWS) throw GET_THROWS; return { val: () => (DB[path] === undefined ? null : DB[path]) }; },
  update: async (_ref, obj) => { updates.push(obj); for (const [k, v] of Object.entries(obj)) DB[k] = v; },
}));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => "2026-09-08T12:00:00.000Z" }));
vi.mock("./displaySlots", () => ({
  setDisplaySlot: async (a) => { slotCalls.push(a); return { ok: true }; },
  clearDisplaySlot: async (a) => { clearCalls.push(a); return { ok: true }; },
}));

const { closeDisplayRow, sendDisplayRow, registerDisplayRow } = await import("./displayRowStore");

const row = (o = {}) => ({
  rowId: "r1", store: "trophy", productId: "p1", productName: "AF1",
  size: "9", sizeKey: "9", bookedHub: "hub1", status: "open",
  openedAt: "2026-09-01T00:00:00.000Z", openedVia: "send", requestOrderId: "417",
  events: {}, ...o,
});
const ROWS = "settings/displayRows/trophy/p1";

beforeEach(() => { DB = {}; GET_THROWS = null; updates.length = 0; slotCalls.length = 0; clearCalls.length = 0; });

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

// ─── FAIL CLOSED, AND PIN IT ────────────────────────────────────────────────
//
// Every writer here re-reads the ledger before planning, because the caller's
// snapshot can be stale and a stale snapshot is how a send opens a second row
// beside one it could not see. That re-read used to be `.catch(() => rows)` —
// fail OPEN, silently, straight back to the snapshot the re-read exists to
// remove, with the operator shown success. It was fixed to fail closed and
// nothing pinned it, so the regression was one `.catch` away from returning
// unnoticed.
//
// Same class as the sizeless survivor above: a value reaching a sink by a path
// nobody tested. (Peer review, marathon-store-app-display-f8.)
describe("a ledger re-read that fails is a REFUSAL, never a fallback to the caller's snapshot", () => {
  const stale = { trophy: { p1: { a: row({ rowId: "a" }) } } };

  it("sendDisplayRow refuses and writes NOTHING", async () => {
    GET_THROWS = new Error("permission_denied");
    const res = await sendDisplayRow({
      rows: stale, store: "trophy", productId: "p1", productName: "AF1",
      size: "10", bookedHub: "hub1", orderId: "417",
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/could not be read/);
    expect(updates).toHaveLength(0);          // no rows written
    expect(slotCalls).toHaveLength(0);        // and no mirror either
  });

  it("registerDisplayRow refuses and writes NOTHING", async () => {
    GET_THROWS = new Error("permission_denied");
    const res = await registerDisplayRow({
      rows: stale, store: "trophy", productId: "p1", productName: "AF1",
      size: "10", bookedHub: "hub1",
    });
    expect(res.ok).toBe(false);
    expect(updates).toHaveLength(0);
    expect(slotCalls).toHaveLength(0);
  });

  it("closeDisplayRow has ALREADY closed the row, so it warns instead of refusing", async () => {
    // The asymmetry is deliberate and worth pinning as itself: the close is
    // applied BEFORE the survivors are read, so a failed read here cannot be a
    // refusal — the row IS closed. It can only leave the mirror unsynced, and
    // the operator has to be told rather than shown a clean success.
    const gone = row({ rowId: "a" });
    DB[ROWS] = { a: { ...gone, status: "closed" } };
    GET_THROWS = new Error("permission_denied");
    const res = await closeDisplayRow({ rows: {}, row: gone, reason: "corrected" });
    expect(res.ok).toBe(true);
    expect(res.warning).toMatch(/could not be checked/);
    expect(slotCalls).toHaveLength(0);
    expect(clearCalls).toHaveLength(0);
  });

  it("a keepOpen registration needs no re-read, so it is unaffected", async () => {
    // The Duplicate tab's "the size on the wall is not listed" path closes
    // nothing, so it has nothing to be stale about.
    GET_THROWS = new Error("permission_denied");
    const res = await registerDisplayRow({
      rows: {}, store: "trophy", productId: "p1", productName: "AF1",
      size: "10", bookedHub: "hub1", keepOpen: true,
    });
    expect(res.ok).toBe(true);
    expect(updates.length).toBeGreaterThan(0);
  });
});
