// ─── the nightly list build (scripts/online/shelf-checks.mjs) and the last-sale cache (shelfLastOut.mjs) ──
import { describe, it, expect } from "vitest";
import { candidatesByPlace, auditSkipper } from "./shelf-checks.mjs";
import { outboundShelf, foldLastOut, notSelling, pruneLastOut } from "./shelfLastOut.mjs";

const NOW = Date.parse("2026-11-25T01:00:00.000Z");
const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString();
const cell = (qty, at, mv = "seed") => ({ qty, updatedAt: iso(at), mv });

describe("candidates per place", () => {
  it("each source becomes its own kind of item, tagged with where it came from", () => {
    const by = candidatesByPlace({
      writeDowns: [
        { pid: "w1", sizeKey: "M", loc: "marathon-pe", row: { mvId: "web_nf_1", kind: "shop_not_found", at: NOW - DAY, orderNumber: 2301 }, cell: cell(0, NOW - DAY, "web_nf_1") },
        { pid: "w2", sizeKey: "M", loc: "marathon-pe", row: { mvId: "web_nf_2", kind: "shop_not_found", at: NOW - DAY }, cell: cell(3, NOW, "refill") },          // moved since: not asked
        { pid: "w3", sizeKey: "M", loc: "hub2", row: { mvId: "web_nf_3", kind: "shelf_check_not_found", at: NOW - DAY }, cell: cell(0, NOW - DAY, "web_nf_3") },  // the check's own answer
      ],
      holds: [
        { pid: "h1", sizeKey: "L", loc: "hub2", hold: { at: NOW - DAY, kind: "refill_refused", orderId: "request -R1 for trophy" }, cell: cell(2, NOW - 9 * DAY) },
        { pid: "h2", sizeKey: "L", loc: "hub2", hold: { at: NOW - DAY, kind: "hub_out_of_stock", orderId: "5551" }, cell: cell(3, NOW - 9 * DAY) },
        { pid: "h3", sizeKey: "L", loc: "hub2", hold: { at: NOW - DAY, kind: "hub_out_of_stock", orderId: "5552" }, cell: cell(1, NOW - 9 * DAY) },
        { pid: "h4", sizeKey: "L", loc: "hub2", hold: { at: NOW - DAY, kind: "store_order_oos" }, cell: cell(2, NOW) },  // moved since: hold ended
      ],
      idle: [{ loc: "hub2", pid: "i1", sizeKey: "S", shown: 4, at: NOW - 40 * DAY }],
      singles: [{ loc: "hub2", pid: "s1", sizeKey: "S", at: NOW - 70 * DAY }, { loc: "central", pid: "s2", sizeKey: "S", at: NOW - 70 * DAY }],
    });
    expect(by["marathon-pe"]).toEqual([{ pid: "w1", sizeKey: "M", why: "web_reject", shown: 0, at: NOW - DAY, lastMoved: NOW - DAY, mvId: "web_nf_1", ref: "website order #2301", src: "shop_not_found" }]);
    const hub2 = Object.fromEntries(by.hub2.map((c) => [c.pid, c]));
    expect(Object.keys(hub2).sort()).toEqual(["h1", "h2", "h3", "i1", "s1"]);
    expect([hub2.h1.why, hub2.h1.src, hub2.h1.ref]).toEqual(["store_reject", "refill_refused", "request -R1 for trophy"]);
    expect(hub2.h2.why).toBe("wrong_by_more");
    expect(hub2.h3.why).toBe("web_reject");
    expect(hub2.h3.mvId).toBeUndefined();
    expect(hub2.i1.why).toBe("not_selling");
    expect(hub2.s1.why).toBe("old_single");
    expect(by.central).toEqual([]);
  });

  it("the stock audit card's batch and recent walks are never asked again here (one rotation)", () => {
    const skip = auditSkipper({ batch: { trophy: { at: NOW - 2 * DAY, pids: ["pA", "pB"] } }, rotation: { trophy: { pB: { at: NOW - DAY }, pC: { at: NOW - 5 * DAY }, pD: { at: NOW - 50 * DAY } } }, nowMs: NOW, days: 30 });
    expect(skip("trophy", "pA")).toBe(true);   // in the batch, not walked yet
    expect(skip("trophy", "pB")).toBe(true);   // walked for this batch, inside the window
    expect(skip("trophy", "pC")).toBe(true);   // walked 5 days ago
    expect(skip("trophy", "pD")).toBe(false);  // walked 50 days ago
    expect(skip("hub2", "pA")).toBe(false);
    const by = candidatesByPlace({ idle: [{ loc: "trophy", pid: "pA", sizeKey: "M", shown: 2, at: 1 }, { loc: "trophy", pid: "pD", sizeKey: "M", shown: 2, at: 1 }], auditSkip: skip });
    expect(by.trophy.map((c) => c.pid)).toEqual(["pD"]);
  });
});

describe("not selling", () => {
  it("a sale or sending stock on counts as selling; arrivals and counts do not", () => {
    expect(outboundShelf({ type: "sold", productId: "p", size: "5.5", from: "trophy" })).toBe("trophy|p|5_5");
    expect(outboundShelf({ type: "transfer_out", productId: "p", size: "M", from: "hub2", to: "trophy" })).toBe("hub2|p|M");
    expect(outboundShelf({ type: "adjustment", productId: "p", size: "M", from: "hub2" })).toBeNull();
    expect(outboundShelf({ type: "received", productId: "p", size: "M", to: "hub2" })).toBeNull();
    expect(outboundShelf({ type: "transfer_in", productId: "p", size: "M", from: "in_transit", to: "trophy" })).toBeNull();
  });

  it("shelves holding stock with no sale or outbound movement for 21 days, oldest first; a file too young to know proves nothing", () => {
    let st = { cursor: null, since: iso(NOW - 35 * DAY), last: {} };
    st = foldLastOut(st, { a: { type: "sold", productId: "p1", size: "M", from: "trophy", ts: iso(NOW - 3 * DAY) }, b: { type: "sold", productId: "p2", size: "M", from: "trophy", ts: iso(NOW - 25 * DAY) } }, NOW);
    expect(st.cursor).toBe(iso(NOW - 3 * DAY));
    const held = [{ loc: "trophy", pid: "p1", sizeKey: "M", qty: 2, at: 1 }, { loc: "trophy", pid: "p2", sizeKey: "M", qty: 1, at: 2 }, { loc: "trophy", pid: "p3", sizeKey: "M", qty: 5, at: 3 }, { loc: "trophy", pid: "p4", sizeKey: "M", qty: 0, at: 3 }];
    const idle = notSelling(held, st, { nowMs: NOW, idleDays: 21 });
    expect(idle.map((x) => [x.pid, x.at])).toEqual([["p3", NOW - 35 * DAY], ["p2", NOW - 25 * DAY]]);
    // A file that only sees back 10 days cannot call p3 idle.
    expect(notSelling(held, { ...st, since: iso(NOW - 10 * DAY) }, { nowMs: NOW, idleDays: 21 }).map((x) => x.pid)).toEqual(["p2"]);
    // Pruning keeps it small and moves "how far back it sees" with it.
    const pr = pruneLastOut({ ...st, since: iso(NOW - 200 * DAY), last: { ...st.last, "x|y|z": NOW - 150 * DAY } }, NOW, 120);
    expect(pr.last["x|y|z"]).toBeUndefined();
    expect(Date.parse(pr.since)).toBe(NOW - 120 * DAY);
  });
});
