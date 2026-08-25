// ─── HUB 1 SINGLE PATH — engine-only requesting + parked needs in the queue ──
// (Owner order 2026-08-25.) Two contracts, one file:
//
//   CHANGE 1: hub1 raises NO reactive lines — not from a "Coming Tomorrow"
//   hold, not from Missing Sneakers, not from sale-driven rows. Hub 2 keeps
//   every lane byte-for-byte. reactiveRefillHubs.js is the one list.
//
//   CHANGE 2: needs the source gate parks (no line Central can fill) render
//   in the SAME refill queue as a read-only state — every leg alike — via
//   parkedNeedRows over /stock_exceptions/latest.
//
// Mutation-proofed by scripts/mutation-proof-hub1-single-path.mjs.

import { describe, it, expect } from "vitest";
import { REACTIVE_REFILL_HUBS, isReactiveRefillHub } from "./reactiveRefillHubs.js";
import { onHoldRefillPlan } from "./onHoldRefill.js";
import { parkedNeedRows, parkedOverflow } from "./refillQueueCore.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, p), "utf8");

describe("the one reactive-hub list", () => {
  it("hub1 is NOT reactive; hub2 is", () => {
    expect(isReactiveRefillHub("hub1")).toBe(false);
    expect(isReactiveRefillHub("hub2")).toBe(true);
    expect(REACTIVE_REFILL_HUBS).toEqual(["hub2"]);
  });
});

describe("CHANGE 1 — every reactive writer is off at hub1, untouched at hub2", () => {
  const CTX = { nowIso: "2026-08-25T10:00:00.000Z", saDate: "2026-08-25" };
  it("on-hold: hub1 refuses, hub2 plans exactly as before", () => {
    const hub1 = onHoldRefillPlan({ id: "042", productId: "p1", size: "9", qty: 1, placedAtHub: "hub1" }, CTX);
    expect(hub1).toEqual({ ok: false, reason: "unroutable_hub_hub1" });
    const hub2 = onHoldRefillPlan({ id: "042", productId: "p1", size: "9", qty: 1, placedAtHub: "hub2" }, CTX);
    expect(hub2.ok).toBe(true);
    expect(hub2.record.requestingLocation).toBe("hub2");
  });
  it("Missing Sneakers offers ONLY reactive hubs as destinations (source pins)", () => {
    const mf = src("./MissingFootwear.jsx");
    expect(mf).toContain("REQUESTABLE_HUBS = REACTIVE_REFILL_HUBS.filter");
    expect(mf.split("dests[card.pid] || REQUESTABLE_HUBS[0]").length - 1).toBe(2);
    expect(mf).toContain("solveHub[card.pid] || REQUESTABLE_HUBS[0]");
    expect(mf.split("{REQUESTABLE_HUBS.map((h) => (").length - 1).toBe(2);
    // Detection and Central-reservation math still span BOTH hubs.
    expect(mf).toContain('hubs: HUBS');
    expect(mf).toContain("HUBS.includes(r.requestingLocation)");
  });
  it("sale-driven rows and badges iterate REACTIVE hubs only (source pins)", () => {
    const app = src("../../App.jsx");
    expect(app.split("REACTIVE_REFILL_HUBS.forEach").length - 1).toBe(3);
    expect(app).toContain("activeHub && isReactiveRefillHub(activeHub) ? saleRowsFor(activeHub, activeCellFilter) : []");
    expect(app).toContain("activeHub && isReactiveRefillHub(activeHub) ? completedSaleFor(activeHub, activeCellFilter) : []");
    // The open-request badge still counts hub1 — those rows render in the tab.
    expect(app).toContain('(r.requestingLocation === "hub1" || r.requestingLocation === "hub2")');
  });
});

describe("CHANGE 2 — parked needs ride the same queue, every leg", () => {
  const EXC = {
    awaitingSupplier: {
      count: 3,
      items: [
        { loc: "hub1", pid: "p1", size: "8", deficit: 3, source: "central", note: "upstream chain empty — supplier reorder or excess return needed" },
        { loc: "hub2", pid: "p2", size: "M", deficit: 2, source: "central", note: "upstream chain empty" },
        { loc: "marathon-pe", pid: "p3", size: "L", deficit: 1, source: "hub2", note: "x" },
      ],
    },
    awaitingUpstream: {
      count: 1,
      items: [{ loc: "hub1", pid: "p4", size: "9", deficit: 2, source: "central", note: "waiting for central to receive stock" }],
    },
  };
  const byId = new Map([["p1", { id: "p1", name: "Alpha Runner", photoUrl: "u1" }], ["p4", { id: "p4", name: "Zed Boot" }]]);

  it("builds read-only rows for THIS destination only, both park states, sorted", () => {
    const rows = parkedNeedRows({ exceptions: EXC, dest: "hub1", byId });
    expect(rows.map((r) => [r.productId, r.state, r.qty])).toEqual([
      ["p1", "supplier", 3],
      ["p4", "upstream", 2],
    ]);
    expect(rows[0].productName).toBe("Alpha Runner");
    expect(rows[0].photoUrl).toBe("u1");
    expect(rows[0].note).toMatch(/supplier reorder/);
  });
  it("hub2 clothing gets the identical treatment — the fix is once for every leg", () => {
    const rows = parkedNeedRows({ exceptions: EXC, dest: "hub2", byId });
    expect(rows.map((r) => r.productId)).toEqual(["p2"]);
  });
  it("respects the hub2 line filter, degrades to empty without the node", () => {
    const rows = parkedNeedRows({ exceptions: EXC, dest: "hub2", byId, lineFilter: () => false });
    expect(rows).toEqual([]);
    expect(parkedNeedRows({ exceptions: null, dest: "hub1", byId })).toEqual([]);
  });
  it("the 900-cap overflow is carried honestly", () => {
    expect(parkedOverflow(EXC)).toBe(0);
    expect(parkedOverflow({ awaitingSupplier: { count: 950, items: EXC.awaitingSupplier.items } })).toBe(947);
  });
  it("RefillQueue renders the parked state in its detail (source pins)", () => {
    const rq = src("./RefillQueue.jsx");
    expect(rq).toContain("parkedNeedRows({ exceptions, dest: DEST_LOC, byId, lineFilter })");
    expect(rq).toContain("WAITING FOR SUPPLIER");
    expect(rq).toContain("AWAITING TRANSFER");
    expect(rq).toContain("waiting for stock upstream");
  });
});
