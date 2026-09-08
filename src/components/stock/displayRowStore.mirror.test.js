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

let DB = {};                        // path -> value (coarse keys, walked by readPath)

// Resolve "a/b/c" against DB whether it was seeded flat ("a/b" -> {c:…}) or
// deeper. Mirrors how RTDB answers any path in the tree.
const readPath = (path) => {
  if (DB[path] !== undefined) return DB[path];
  const parts = String(path).split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const head = parts.slice(0, i).join("/");
    if (DB[head] !== undefined) {
      let n = DB[head];
      for (const k of parts.slice(i)) { if (n == null || typeof n !== "object") return undefined; n = n[k]; }
      return n;
    }
  }
  return undefined;
};
let GET_THROWS = null;              // Error -> every get() throws
let GET_THROWS_AFTER = null;        // Error -> get() throws from the Nth call on
let GET_CALLS = 0;
const updates = [];
const slotCalls = [];
const clearCalls = [];

vi.mock("firebase/database", () => ({
  ref: (_db, path) => path,
  // Path-aware, because the code reads BOTH a collection path
  // ("settings/displayRows/{store}/{pid}") and a single row beneath it. A flat
  // key lookup answered null for the deeper path and made a real read look like
  // a missing row.
  get: async (path) => {
    GET_CALLS += 1;
    if (GET_THROWS) throw GET_THROWS;
    if (GET_THROWS_AFTER && GET_CALLS >= GET_THROWS_AFTER.from) throw GET_THROWS_AFTER.err;
    return { val: () => (readPath(path) === undefined ? null : readPath(path)) };
  },
  update: async (_ref, obj) => { updates.push(obj); for (const [k, v] of Object.entries(obj)) DB[k] = v; },
  // The real thing: `undefined` ABORTS and hands back the current value.
  runTransaction: async (path, fn) => {
    const parts = String(path).split("/");
    const leaf = parts.pop();
    const parent = parts.join("/");
    const cur = (DB[parent] || {})[leaf];
    const next = fn(cur === undefined ? null : cur);
    if (next === undefined) return { committed: false, snapshot: { val: () => (cur === undefined ? null : cur) } };
    DB[parent] = { ...(DB[parent] || {}), [leaf]: next };
    return { committed: true, snapshot: { val: () => next } };
  },
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

beforeEach(() => { DB = {}; GET_THROWS = null; GET_THROWS_AFTER = null; GET_CALLS = 0; updates.length = 0; slotCalls.length = 0; clearCalls.length = 0; });

describe("closing one of several re-points the slot at the survivor", () => {
  it("a survivor with NO `size` mirrors its sizeKey — never the string 'undefined'", async () => {
    const gone = row({ rowId: "a" });
    const keep = row({ rowId: "b", sizeKey: "10", openedAt: "2026-09-02T00:00:00.000Z" });
    delete keep.size;                                   // open, valid, and sizeless
    DB[ROWS] = { a: gone, b: keep };
    await closeDisplayRow({ rows: { trophy: { p1: { a: gone, b: keep } } }, row: gone, reason: "corrected" });
    expect(slotCalls).toHaveLength(1);
    expect(slotCalls[0].size).toBe("10");
    expect(slotCalls[0].size).not.toBe("undefined");
  });

  it("the ordinary case still mirrors the survivor's own size", async () => {
    const gone = row({ rowId: "a" });
    const keep = row({ rowId: "b", size: "10", sizeKey: "10", openedAt: "2026-09-02T00:00:00.000Z" });
    DB[ROWS] = { a: gone, b: keep };
    await closeDisplayRow({ rows: {}, row: gone, reason: "corrected" });
    expect(slotCalls[0].size).toBe("10");
  });

  it("the survivor's own provenance is carried, not a blanket registration", async () => {
    const gone = row({ rowId: "a" });
    const keep = row({ rowId: "b", size: "10", sizeKey: "10", openedAt: "2026-09-02T00:00:00.000Z",
                       openedVia: "send", requestOrderId: "417" });
    DB[ROWS] = { a: gone, b: keep };
    await closeDisplayRow({ rows: {}, row: gone, reason: "corrected" });
    expect(slotCalls[0].source).toBe("display_refill");
    expect(slotCalls[0].orderId).toBe("417");
  });

  it("a wall-walk survivor reads as a registration with no order", async () => {
    const gone = row({ rowId: "a" });
    const keep = row({ rowId: "b", size: "10", sizeKey: "10", openedAt: "2026-09-02T00:00:00.000Z",
                       openedVia: "wall_walk", requestOrderId: null });
    DB[ROWS] = { a: gone, b: keep };
    await closeDisplayRow({ rows: {}, row: gone, reason: "corrected" });
    expect(slotCalls[0].source).toBe("registration");
    expect(slotCalls[0].orderId).toBe(null);
  });

  it("the LAST open row going tombstones the slot instead of re-pointing it", async () => {
    const gone = row({ rowId: "a" });
    DB[ROWS] = { a: gone };
    await closeDisplayRow({ rows: {}, row: gone, reason: "sold" });
    expect(clearCalls).toHaveLength(1);
    expect(slotCalls).toHaveLength(0);
  });

  it("closing never moves stock, and says so on the result", async () => {
    const gone = row({ rowId: "a" });
    DB[ROWS] = { a: gone };
    const res = await closeDisplayRow({ rows: {}, row: gone, reason: "returned" });
    expect(res.ok).toBe(true);
    expect(res.stockMoved).toBe(false);
  });

  it("the survivors are re-read AFTER the close, not taken from the caller's snapshot", async () => {
    // The caller's map still shows `b` open; the database says it has since
    // closed. Deciding from the stale map would re-point at a closed row.
    const gone = row({ rowId: "a" });
    const stale = row({ rowId: "b", size: "10", sizeKey: "10" });
    DB[ROWS] = { a: gone, b: { ...stale, status: "closed" } };
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

  it("closeDisplayRow REFUSES when it cannot read the row it is about to close", async () => {
    // Stronger than it used to be, and deliberately. The close now reads the
    // row before its transaction (to prime the cache against RTDB's null-first
    // behaviour), so an unreadable ledger is caught BEFORE anything is written
    // — a refusal, with nothing changed, instead of a blind write.
    const gone = row({ rowId: "a" });
    DB[ROWS] = { a: gone };
    GET_THROWS = new Error("permission_denied");
    const res = await closeDisplayRow({ rows: {}, row: gone, reason: "corrected" });
    expect(res.ok).toBe(false);
    expect(DB[ROWS].a.status).toBe("open");     // untouched
    expect(slotCalls).toHaveLength(0);
    expect(clearCalls).toHaveLength(0);
  });

  it("but once the row IS closed, a failed SURVIVOR read only warns", async () => {
    // The asymmetry, pinned: the close has landed, so this can no longer be a
    // refusal — it can only leave the mirror unsynced, and the operator must be
    // told rather than shown a clean success.
    const gone = row({ rowId: "a" });
    DB[ROWS] = { a: gone };
    GET_THROWS_AFTER = { from: 2, err: new Error("permission_denied") };   // 1st read ok, 2nd throws
    const res = await closeDisplayRow({ rows: {}, row: gone, reason: "corrected" });
    expect(res.ok).toBe(true);
    expect(DB[ROWS].a.status).toBe("closed");   // the close DID land
    expect(res.warning).toMatch(/could not be checked/);
    expect(slotCalls).toHaveLength(0);
    expect(clearCalls).toHaveLength(0);
  });

  it("a row that has vanished between the tab loading and the tap is refused", async () => {
    const gone = row({ rowId: "a" });
    DB[ROWS] = {};                              // nothing there any more
    const res = await closeDisplayRow({ rows: {}, row: gone, reason: "corrected" });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/no longer exists/);
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

describe("the mirrored size is the one a person wrote on a box", () => {
  it("a sizeless HALF-size survivor mirrors 9.5, not the raw key 9_5", async () => {
    // `?? keep.sizeKey` wrote the RTDB-safe key into the slot's HUMAN `size`
    // field. A 9.5 display then became a slot reading "9_5", permanently, on
    // every screen that shows a slot size. Swapping "undefined" for "9_5" is a
    // better bug, not a fixed one. (Adversarial review of PR #585.)
    const gone = row({ rowId: "a" });
    const half = row({ rowId: "b", sizeKey: "9_5", openedAt: "2026-09-02T00:00:00.000Z" });
    delete half.size;
    DB[ROWS] = { a: gone, b: half };
    await closeDisplayRow({ rows: {}, row: gone, reason: "corrected" });
    expect(slotCalls[0].size).toBe("9.5");
  });

  it("a survivor that HAS its size is untouched by the decode", async () => {
    const gone = row({ rowId: "a" });
    const keep = row({ rowId: "b", size: "9.5", sizeKey: "9_5", openedAt: "2026-09-02T00:00:00.000Z" });
    DB[ROWS] = { a: gone, b: keep };
    await closeDisplayRow({ rows: {}, row: gone, reason: "corrected" });
    expect(slotCalls[0].size).toBe("9.5");
  });
});

// ─── A CLOSE IS A COMPARE-AND-SET ───────────────────────────────────────────
//
// The manual close wrote its fields unconditionally from the caller's row
// object, with no freshness check on the row itself. The till trigger has
// always used a CAS (`claimClose` only commits on an open row); the client did
// not — and the two are in a genuine race by design, one firing off a till and
// the other off a tap.
//
// The row ends closed either way, so no stock and no duplicate follows. What
// was lost is the AUDIT, which on this feature is the product: a ledger that
// cannot say whether a pair SOLD or was CORRECTED off the record is not a
// ledger. (CodeRabbit.)
describe("a close never overwrites a close that got there first", () => {
  it("a row the till already closed keeps the sale's reason, ref and author", async () => {
    const stale = row({ rowId: "a" });                     // the caller still thinks it is open
    DB[ROWS] = { a: {
      ...stale, status: "closed", closedAt: "2026-09-08T11:59:00.000Z",
      closedBy: "system:pos_sale", closedReason: "sold", closedVia: "pos_sale",
      closedRef: "mv-123",
    } };
    const res = await closeDisplayRow({ rows: {}, row: stale, reason: "corrected" });
    const after = DB[ROWS].a;
    expect(after.closedReason).toBe("sold");
    expect(after.closedVia).toBe("pos_sale");
    expect(after.closedRef).toBe("mv-123");
    expect(after.closedBy).toBe("system:pos_sale");
    expect(after.closedAt).toBe("2026-09-08T11:59:00.000Z");
    // and the operator is told, rather than shown a success that did nothing
    expect(res.ok).toBe(true);
    expect(res.alreadyClosed).toBe(true);
    expect(res.warning).toMatch(/already been closed/);
    expect(res.warning).toMatch(/sold/i);
  });

  it("losing the race does not re-point or tombstone the slot either", async () => {
    const stale = row({ rowId: "a" });
    DB[ROWS] = { a: { ...stale, status: "closed", closedReason: "sold", closedVia: "pos_sale" } };
    await closeDisplayRow({ rows: {}, row: stale, reason: "corrected" });
    expect(slotCalls).toHaveLength(0);
    expect(clearCalls).toHaveLength(0);
  });

  it("an OPEN row still closes normally, with the operator's reason", async () => {
    const open = row({ rowId: "a" });
    DB[ROWS] = { a: open };
    const res = await closeDisplayRow({ rows: {}, row: open, reason: "returned" });
    expect(DB[ROWS].a.status).toBe("closed");
    expect(DB[ROWS].a.closedReason).toBe("returned");
    expect(res.alreadyClosed).toBeUndefined();
    expect(clearCalls).toHaveLength(1);          // last row gone -> tombstone
  });

  it("the close is a TRANSACTION, not a blind multi-path write", async () => {
    const open = row({ rowId: "a" });
    DB[ROWS] = { a: open };
    await closeDisplayRow({ rows: {}, row: open, reason: "corrected" });
    // A blind write would have gone through update() as `.../a/status` paths.
    const blind = updates.some((u) => Object.keys(u).some((k) => k.includes("/a/status")));
    expect(blind).toBe(false);
  });

  it("a row id that cannot be an RTDB key is refused, not written to a wrong path", async () => {
    const bad = row({ rowId: "a", productId: "p/1" });
    const res = await closeDisplayRow({ rows: {}, row: bad, reason: "corrected" });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/cannot be stored as a path|cannot be an RTDB key/);
  });
});
