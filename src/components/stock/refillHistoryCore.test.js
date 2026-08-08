// Tests for the refill-history core — date ranges, outcome classification, and
// the two-source row build.
//
// The two things most worth pinning:
//  1. RANGES ARE SA CALENDAR DAYS. "Yesterday" must mean the trading day the
//     staff worked, not a UTC window that slices it at 02:00 and drops the last
//     two hours of business into the wrong bucket.
//  2. A CANCELLED REQUEST WITH NO cancelReason IS A HUMAN REJECTION. That
//     absence is load-bearing across this codebase (Hub2RefillQueue's ✕
//     deliberately omits the field and the engine reads that shape as a human
//     "no"). 976 live rows depend on it; defaulting it would relabel every one
//     of them as an engine withdrawal.
import { describe, it, expect } from "vitest";
import {
  saDayOf, saDayStartMs, resolveRange, classifyRequest, eventMsOf,
  requestRows, movementRows, mergeRows, totalsFor, movementKind, REQUESTS_INDEXED,
} from "./refillHistoryCore.js";

// 2026-08-07 09:00 SA = 07:00 UTC
const NOW = Date.parse("2026-08-07T07:00:00.000Z");

describe("SA calendar days", () => {
  it("dates an instant by SA time, not UTC", () => {
    // 23:30 SA on the 6th is 21:30Z on the 6th — same day either way.
    expect(saDayOf(Date.parse("2026-08-06T21:30:00.000Z"))).toBe("2026-08-06");
    // 01:00 SA on the 7th is 23:00Z on the SIXTH. UTC would file it under the
    // 6th; the shop worked it on the 7th.
    expect(saDayOf(Date.parse("2026-08-06T23:00:00.000Z"))).toBe("2026-08-07");
  });
  it("starts an SA day at 22:00Z the day before", () => {
    expect(new Date(saDayStartMs("2026-08-07")).toISOString()).toBe("2026-08-06T22:00:00.000Z");
  });
});

describe("resolveRange", () => {
  it("today is one SA day, half-open", () => {
    const r = resolveRange("today", NOW);
    expect(r.fromDay).toBe("2026-08-07");
    expect(r.toDay).toBe("2026-08-07");
    expect(r.days).toBe(1);
    expect(r.fromIso).toBe("2026-08-06T22:00:00.000Z");
    expect(r.toIso).toBe("2026-08-07T22:00:00.000Z");
  });
  it("yesterday is the previous SA day only", () => {
    const r = resolveRange("yesterday", NOW);
    expect([r.fromDay, r.toDay, r.days]).toEqual(["2026-08-06", "2026-08-06", 1]);
  });
  it("last 7 days INCLUDES today — 7 days, not 8", () => {
    const r = resolveRange("last7", NOW);
    expect([r.fromDay, r.toDay, r.days]).toEqual(["2026-08-01", "2026-08-07", 7]);
  });
  it("this month runs from the 1st to today", () => {
    const r = resolveRange("month", NOW);
    expect([r.fromDay, r.toDay, r.days]).toEqual(["2026-08-01", "2026-08-07", 7]);
  });
  it("this month works on the 1st itself", () => {
    const r = resolveRange("month", Date.parse("2026-08-01T07:00:00.000Z"));
    expect([r.fromDay, r.toDay, r.days]).toEqual(["2026-08-01", "2026-08-01", 1]);
  });
  it("steps back across a month boundary correctly", () => {
    const r = resolveRange("last7", Date.parse("2026-09-02T07:00:00.000Z"));
    expect([r.fromDay, r.toDay, r.days]).toEqual(["2026-08-27", "2026-09-02", 7]);
  });
  it("custom honours both ends inclusively", () => {
    const r = resolveRange("custom", NOW, { from: "2026-07-01", to: "2026-07-03" });
    expect(r.days).toBe(3);
    expect(r.toIso).toBe("2026-07-03T22:00:00.000Z");   // start of the 4th, SA
  });
  it("a backwards custom range is swapped, not left empty", () => {
    const r = resolveRange("custom", NOW, { from: "2026-07-05", to: "2026-07-01" });
    expect([r.fromDay, r.toDay]).toEqual(["2026-07-01", "2026-07-05"]);
  });
  it("the window is half-open — the last instant of the day is IN, the next day's first is OUT", () => {
    const r = resolveRange("yesterday", NOW);
    expect(Date.parse("2026-08-06T21:59:59.999Z")).toBeLessThan(r.toMs);
    expect(Date.parse("2026-08-06T22:00:00.000Z")).toBe(r.toMs);
  });
});

describe("classifyRequest", () => {
  const R = (o) => classifyRequest(o);
  it("open is requested", () => expect(R({ status: "open" })).toBe("requested"));
  it("fulfilled is fulfilled", () => expect(R({ status: "fulfilled" })).toBe("fulfilled"));
  it("cancelled with NO cancelReason is a HUMAN rejection", () => {
    expect(R({ status: "cancelled" })).toBe("rejected");
    expect(R({ status: "cancelled", rejectedBy: "warehouse" })).toBe("rejected");
  });
  it("engine self-withdrawals are withdrawn, not rejected", () => {
    for (const reason of ["no_longer_needed", "unfillable", "order_lost", "already_in_stock"]) {
      expect(R({ status: "cancelled", cancelReason: reason })).toBe("withdrawn");
    }
  });
  it("awaiting_upstream is parked — it comes back on its own", () => {
    expect(R({ status: "cancelled", cancelReason: "awaiting_upstream" })).toBe("parked");
  });
  it("an unrecognised reason folds into the one engine-closed bucket, reason carried on the row", () => {
    // The redo (2026-08-08): "Withdrawn" and "Cancelled" were two tiles over
    // one stored value. Any cancelReason that is not a park is the engine
    // closing its own request; the raw reason still renders per-row.
    expect(R({ status: "cancelled", cancelReason: "something_new" })).toBe("withdrawn");
  });
  it("the new already_in_stock withdrawal is classified", () => {
    // The Part A fix writes this reason; history must name it, not show
    // "cancelled" and leave staff wondering who cancelled their request.
    expect(R({ status: "cancelled", cancelReason: "already_in_stock" })).toBe("withdrawn");
  });
});

describe("eventMsOf", () => {
  it("dates an open request by when it was raised", () => {
    expect(eventMsOf({ status: "open", createdAt: "2026-08-06T10:00:00.000Z" }))
      .toBe(Date.parse("2026-08-06T10:00:00.000Z"));
  });
  it("dates a resolved request by its outcome", () => {
    expect(eventMsOf({ status: "fulfilled", createdAt: "2026-08-05T10:00:00.000Z", resolvedAt: "2026-08-06T14:00:00.000Z" }))
      .toBe(Date.parse("2026-08-06T14:00:00.000Z"));
  });
});

// ── rows ─────────────────────────────────────────────────────────────────────

const range = resolveRange("yesterday", NOW);   // 2026-08-06 SA
const rr = (o = {}) => ({
  id: "r1", productId: "boot", size: "7", qty: 2,
  requestingLocation: "hub1", status: "fulfilled",
  createdAt: "2026-08-06T08:00:00.000Z", resolvedAt: "2026-08-06T12:00:00.000Z",
  createdFrom: { source: "central", via: "missing_sneakers" }, ...o,
});

describe("requestRows", () => {
  it("returns the right rows for a chosen range", () => {
    const rows = requestRows([
      rr({ id: "in" }),
      rr({ id: "out", createdAt: "2026-08-01T08:00:00.000Z", resolvedAt: "2026-08-01T09:00:00.000Z" }),
    ], range, ["hub1", "hub2"]);
    expect(rows.map((r) => r.refillId)).toEqual(["in"]);
  });

  it("INCLUDES REJECTED rows, with the reason and the person", () => {
    const rows = requestRows([rr({
      id: "no", status: "cancelled", rejectedBy: "warehouse",
      resolvedBy: "vWfHqbLEPvRMItXhH0B9NvYW0LG3",
    })], range, ["hub1"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("rejected");
    expect(rows[0].actorRole).toBe("warehouse");
    expect(rows[0].actorUid).toBe("vWfHqbLEPvRMItXhH0B9NvYW0LG3");
  });

  it("keeps a request whose OUTCOME landed in range even though it was raised earlier", () => {
    const rows = requestRows([rr({ createdAt: "2026-07-20T08:00:00.000Z" })], range, ["hub1"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].ts).toBe(Date.parse("2026-08-06T12:00:00.000Z"));
  });

  it("dates a spanning request by the event that fell IN the range", () => {
    // Raised yesterday 20:50, picked today 12:31. Under "yesterday" the row must
    // read yesterday — dating every row by its outcome put tomorrow's
    // timestamps at the top of yesterday's list on live data.
    const rows = requestRows([rr({
      createdAt: "2026-08-06T18:50:00.000Z",      // 20:50 SA on the 6th
      resolvedAt: "2026-08-07T10:31:00.000Z",     // 12:31 SA on the 7th
    })], range, ["hub1"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].ts).toBe(Date.parse("2026-08-06T18:50:00.000Z"));
    expect(saDayOf(rows[0].ts)).toBe("2026-08-06");
    // the outcome is still carried, so the row can say when it was finally done
    expect(rows[0].resolvedMs).toBe(Date.parse("2026-08-07T10:31:00.000Z"));
  });

  it("keeps a request RAISED in range but still open", () => {
    const rows = requestRows([rr({ status: "open", resolvedAt: null })], range, ["hub1"]);
    expect(rows[0].status).toBe("requested");
  });

  it("keeps an OPEN request whatever the range — the backlog is a present fact", () => {
    // The bug this pins: the Open tile read 0 against ~150 genuinely open
    // requests, because an open row has no resolvedAt to land in any window
    // and its createdAt was before the window. Open rows are included whatever
    // the range, dated by when they were raised.
    const rows = requestRows([rr({
      status: "open", resolvedAt: null, createdAt: "2026-07-20T08:00:00.000Z",
    })], range, ["hub1"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("requested");
    expect(rows[0].ts).toBe(Date.parse("2026-07-20T08:00:00.000Z"));   // dated by raise
  });

  it("a CLOSED request outside the range stays out — only opens ignore the window", () => {
    const rows = requestRows([rr({
      status: "cancelled", createdAt: "2026-07-20T08:00:00.000Z", resolvedAt: "2026-07-20T09:00:00.000Z",
    })], range, ["hub1"]);
    expect(rows).toEqual([]);
  });

  it("filters by hub", () => {
    const rows = requestRows([rr({ id: "a", requestingLocation: "hub1" }), rr({ id: "b", requestingLocation: "hub2" })], range, ["hub2"]);
    expect(rows.map((r) => r.refillId)).toEqual(["b"]);
  });

  it("excludes locations that are not selected", () => {
    const rows = requestRows([rr({ requestingLocation: "marathon-pe" })], range, ["hub1", "hub2"]);
    expect(rows).toEqual([]);
  });

  it("INCLUDES shop-leg requests when the shop is selected", () => {
    // Shop requests are real rows in the same node. Silently dropping them was
    // half of why "open network-wide" and this screen could never agree.
    const rows = requestRows([rr({ requestingLocation: "marathon-pe" })], range, ["marathon-pe"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].dest).toBe("marathon-pe");
  });

  it("excludes shadow previews", () => {
    expect(requestRows([rr({ shadow: true })], range, ["hub1"])).toEqual([]);
  });

  it("carries the source location", () => {
    expect(requestRows([rr()], range, ["hub1"])[0].source).toBe("central");
  });

  // ── WHO RESOLVED IT vs WHO RAISED IT ───────────────────────────────────────
  // createdFrom.engine says the engine RAISED the request. It says nothing about
  // who answered it. Conflating the two credited a machine for a person's work
  // on the one screen built to answer "who did this".
  it("an ENGINE-RAISED request fulfilled by staff credits the STAFF, not the engine", () => {
    const rows = requestRows([rr({
      status: "fulfilled",
      createdFrom: { engine: true, source: "central" },
      resolvedBy: "vWfHqbLEPvRMItXhH0B9NvYW0LG3",
    })], range, ["hub1"]);
    expect(rows[0].actorUid).toBe("vWfHqbLEPvRMItXhH0B9NvYW0LG3");
    expect(rows[0].actorRole).toBeNull();      // no role claimed on a fulfil
    expect(rows[0].byEngine).toBe(false);      // a person did this
    expect(rows[0].auto).toBe(true);           // the ORIGIN is still recorded
  });

  it("an engine-raised request rejected by a human credits the human", () => {
    const rows = requestRows([rr({
      status: "cancelled", createdFrom: { engine: true, source: "central" },
      rejectedBy: "warehouse", resolvedBy: "vWfHqbLEPvRMItXhH0B9NvYW0LG3",
    })], range, ["hub1"]);
    expect(rows[0].actorRole).toBe("warehouse");
    expect(rows[0].byEngine).toBe(false);
  });

  it("an engine SELF-WITHDRAWAL is the one case that names the engine", () => {
    // The server stamps a cancelReason and no human actor — that shape, and only
    // that shape, is genuinely the engine's own doing.
    const rows = requestRows([rr({
      status: "cancelled", cancelReason: "already_in_stock",
      createdFrom: { engine: true, source: "central" },
    })], range, ["hub1"]);
    expect(rows[0].byEngine).toBe(true);
    expect(rows[0].actorUid).toBeNull();
    expect(rows[0].actorRole).toBeNull();
  });

  it("an OPEN engine-raised request names nobody — nothing has been done to it yet", () => {
    const rows = requestRows([rr({ status: "open", resolvedAt: null, createdFrom: { engine: true, source: "central" } })], range, ["hub1"]);
    expect(rows[0].byEngine).toBe(false);
    expect(rows[0].actorRole).toBeNull();
    expect(rows[0].auto).toBe(true);
  });

  it("a manual request withdrawn by the engine still names the engine", () => {
    const rows = requestRows([rr({
      status: "cancelled", cancelReason: "already_in_stock",
      createdFrom: { manual: true, source: "central", via: "missing_sneakers" },
    })], range, ["hub1"]);
    expect(rows[0].byEngine).toBe(true);
    expect(rows[0].auto).toBe(false);
  });

  it("does not mistake a short role string for a uid", () => {
    // resolvedBy held free-text actor names before uids ("zombie-cleanup-…").
    // A uid is 28 chars; anything shorter must not be rendered as one.
    const rows = requestRows([rr({ status: "cancelled", resolvedBy: "warehouse" })], range, ["hub1"]);
    expect(rows[0].actorUid).toBeNull();
  });
});

const mv = (o = {}) => ({
  id: "rrf_r1", productId: "boot", size: "7", qty: 2, type: "transfer_out",
  from: "central", to: "hub1", ts: "2026-08-06T12:00:00.000Z",
  actor: "vWfHqbLEPvRMItXhH0B9NvYW0LG3", link: { refillId: "r1" }, ...o,
});

describe("movementKind", () => {
  it("recognises the three refill families by their id prefix", () => {
    expect(movementKind({ id: "rrf_-Oabc" })).toBe("refill");
    expect(movementKind({ id: "dispreg_hub1_p1_7" })).toBe("display_in");
    expect(movementKind({ id: "disp_164_2026-07-09T12_22_17_880Z" })).toBe("display_out");
  });
  it("recognises a reason-tagged refill that carries a plain push id", () => {
    expect(movementKind({ id: "-Oabc", reason: "hub1_auto_refill" })).toBe("refill");
    expect(movementKind({ id: "-Oabc", reason: "hub2_refill_uncounted" })).toBe("refill");
  });
  it("ignores ordinary stock movements", () => {
    expect(movementKind({ id: "-Oabc", reason: "clothing_order" })).toBeNull();
    expect(movementKind({ id: "sold:-Oabc:hub1:p1:7" })).toBeNull();
    expect(movementKind({ id: "-OzQ4L7BrRds21dcNgkB:p1:7" })).toBeNull();
  });
});

describe("movementRows", () => {
  it("includes display refills and names the source location", () => {
    const rows = movementRows([
      mv({ id: "disp_164_x", from: "hub1", to: "marathon-pe", link: { orderId: "164" } }),
      mv({ id: "dispreg_hub1_p1_7", type: "received", from: null, to: "hub1", link: null }),
    ], range, ["hub1"]);
    expect(rows.map((r) => r.kind).sort()).toEqual(["display_in", "display_out"]);
    const out = rows.find((r) => r.kind === "display_out");
    expect([out.source, out.dest]).toEqual(["hub1", "marathon-pe"]);
  });

  it("includes a movement whose SOURCE is the hub, not only its destination", () => {
    // A display leaving Hub 1 is Hub 1 activity. Filtering on `to` alone would
    // lose every outbound row.
    const rows = movementRows([mv({ id: "disp_1_x", from: "hub1", to: "trophy" })], range, ["hub1"]);
    expect(rows).toHaveLength(1);
  });

  it("respects the range", () => {
    expect(movementRows([mv({ ts: "2026-08-01T12:00:00.000Z" })], range, ["hub1"])).toEqual([]);
  });

  it("ignores non-refill movements entirely", () => {
    expect(movementRows([mv({ id: "sold:-Ox:hub1:boot:7", link: null })], range, ["hub1"])).toEqual([]);
  });
});

describe("mergeRows", () => {
  it("folds a fulfilled request and its own rrf_ movement into ONE row", () => {
    const rows = mergeRows(requestRows([rr()], range, ["hub1"]), movementRows([mv()], range, ["hub1"]));
    expect(rows).toHaveLength(1);
    expect(rows[0].refillId).toBe("r1");
    expect(rows[0].movementId).toBe("rrf_r1");
    expect(rows[0].actorUid).toBe("vWfHqbLEPvRMItXhH0B9NvYW0LG3");
  });

  it("lets the ledger correct the source location", () => {
    // The request says central; the pick actually came off hub2. The ledger wins
    // — that is the whole point of showing where it came from.
    const rows = mergeRows(
      requestRows([rr()], range, ["hub1"]),
      movementRows([mv({ from: "hub2" })], range, ["hub1"]));
    expect(rows[0].source).toBe("hub2");
  });

  it("keeps a movement with no matching request as its own row", () => {
    const rows = mergeRows([], movementRows([mv({ id: "disp_9_x", from: "hub1", to: "trophy", link: { orderId: "9" } })], range, ["hub1"]));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("display_out");
  });

  it("sorts newest first", () => {
    const rows = mergeRows(requestRows([
      rr({ id: "early", resolvedAt: "2026-08-06T08:00:00.000Z" }),
      rr({ id: "late", resolvedAt: "2026-08-06T16:00:00.000Z" }),
    ], range, ["hub1"]), []);
    expect(rows.map((r) => r.refillId)).toEqual(["late", "early"]);
  });

  it("ACCUMULATES several movements for one request instead of keeping only the last", () => {
    // A request answered by more than one pick is a real shape here: the Source
    // fulfil panel writes `${seed}_${alreadySent}` per partial send, several
    // movements under one link.refillId. Overwriting would report only the LAST
    // pick's quantity — and the totals are the number people act on.
    const rows = mergeRows(
      requestRows([rr({ qty: 5 })], range, ["hub1"]),
      movementRows([
        mv({ id: "rrf_r1", qty: 2, ts: "2026-08-06T10:00:00.000Z" }),
        mv({ id: "rrf_r1_2", qty: 3, ts: "2026-08-06T12:00:00.000Z" }),
      ], range, ["hub1"]));
    expect(rows).toHaveLength(1);
    expect(rows[0].movedQty).toBe(5);
    expect(rows[0].movementIds).toEqual(["rrf_r1", "rrf_r1_2"]);
    expect(rows[0].movementId).toBe("rrf_r1");        // stable single-id display
    expect(totalsFor(rows).fulfilled).toEqual({ rows: 1, units: 5 });
  });

  it("a single movement still reports its own quantity, not a sum of one", () => {
    const rows = mergeRows(requestRows([rr({ qty: 2 })], range, ["hub1"]), movementRows([mv({ qty: 2 })], range, ["hub1"]));
    expect(rows[0].movedQty).toBe(2);
    expect(rows[0].movementIds).toEqual(["rrf_r1"]);
  });

  it("does not mutate its inputs — the same input twice gives the same output", () => {
    const req = requestRows([rr()], range, ["hub1"]);
    const mvs = movementRows([mv({ from: "hub2" })], range, ["hub1"]);
    const first = mergeRows(req, mvs);
    const second = mergeRows(req, mvs);
    expect(second).toEqual(first);
    expect(req[0].source).toBe("central");   // untouched
  });
});

describe("totalsFor", () => {
  it("counts rows and units per status", () => {
    const rows = mergeRows(requestRows([
      rr({ id: "a", status: "fulfilled", qty: 2 }),
      rr({ id: "b", status: "cancelled", qty: 3 }),
      rr({ id: "c", status: "cancelled", cancelReason: "awaiting_upstream", qty: 1 }),
      rr({ id: "d", status: "open", resolvedAt: null, qty: 4 }),
    ], range, ["hub1"]), []);
    const t = totalsFor(rows);
    expect(t.fulfilled).toEqual({ rows: 1, units: 2 });
    expect(t.rejected).toEqual({ rows: 1, units: 3 });
    expect(t.parked).toEqual({ rows: 1, units: 1 });
    expect(t.requested).toEqual({ rows: 1, units: 4 });
    expect(t.withdrawn).toEqual({ rows: 0, units: 0 });
  });

  it("folds every engine close — known or novel reason — into the one withdrawn bucket", () => {
    const rows = mergeRows(requestRows([
      rr({ id: "a", status: "cancelled", cancelReason: "no_longer_needed", qty: 2 }),
      rr({ id: "b", status: "cancelled", cancelReason: "some_future_reason", qty: 1 }),
    ], range, ["hub1"]), []);
    expect(totalsFor(rows).withdrawn).toEqual({ rows: 2, units: 3 });
  });

  it("counts a merged row ONCE, using what actually moved", () => {
    // The request asked for 2 and 1 was picked. Counting both rows would report
    // 3 units against a single pair of shoes.
    const rows = mergeRows(requestRows([rr({ qty: 2 })], range, ["hub1"]), movementRows([mv({ qty: 1 })], range, ["hub1"]));
    expect(totalsFor(rows).fulfilled).toEqual({ rows: 1, units: 1 });
  });

  it("keeps display rows in their own buckets", () => {
    const rows = movementRows([
      mv({ id: "disp_1_x", from: "hub1", to: "trophy", qty: 1, link: {} }),
      mv({ id: "dispreg_hub1_p1_7", to: "hub1", qty: 3, link: null }),
    ], range, ["hub1"]);
    const t = totalsFor(rows);
    expect(t.display_out).toEqual({ rows: 1, units: 1 });
    expect(t.display_in).toEqual({ rows: 1, units: 3 });
  });
});

describe("bandwidth guard", () => {
  it("uses the INDEX-BACKED range query for /refill_requests", () => {
    // The index went live in the console on 2026-08-07:
    //     "refill_requests": { ".indexOn": ["createdAt", "resolvedAt"], ... }
    // Verified before flipping: a ranged REST query on createdAt returned 125
    // rows and on resolvedAt 175, while the same query on an unindexed field
    // (productId) failed with HTTP 400 "Index not defined" — so the check really
    // does distinguish an indexed field from an unindexed one.
    //
    // Flipping this back to false without ALSO removing the index would silently
    // restore a full read of ~11,800 records per mount. The queries themselves
    // are asserted in RefillHistory.render.test.jsx, which is what actually
    // fails if this is reverted; this line states the intent.
    expect(REQUESTS_INDEXED).toBe(true);
  });
});
