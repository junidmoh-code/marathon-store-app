// ─── HUB 1 SINGLE PATH — engine-only requesting + parked needs in the queue ──
// (Owner order 2026-08-25.) Two contracts, one file:
//
//   CHANGE 1: hub1 raises NO reactive lines — not from a "Coming Tomorrow"
//   hold, not from Missing Sneakers, not from sale-driven rows. Hub 2 keeps
//   every lane byte-for-byte. reactiveRefillHubs.js is the one list.
//
//   (A CHANGE 2 briefly rendered parked source-gate needs inside the queue;
//   the owner removed it the same evening — the queue's waiting detail means
//   "what the next release hands you", and parked needs live on Health.)
//
// Mutation-proofed by scripts/mutation-proof-hub1-single-path.mjs.

import { describe, it, expect } from "vitest";
import { REACTIVE_REFILL_HUBS, isReactiveRefillHub } from "./reactiveRefillHubs.js";
import { onHoldRefillPlan } from "./onHoldRefill.js";
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

describe("the 06:00 waiting preview groups one product's sizes into one card", () => {
  it("groupRowsByProduct: same product folds, oldest raise wins the age pill, order preserved", async () => {
    const { groupRowsByProduct } = await import("./refillQueueCore.js");
    const rows = [
      { rowKey: "a", productId: "p1", productName: "AJ4", size: "4", qty: 1, createdMs: 200, createdAt: "B", photoUrl: "u" },
      { rowKey: "b", productId: "p2", productName: "Hoka", size: "3", qty: 2, createdMs: 150, createdAt: "C" },
      { rowKey: "c", productId: "p1", productName: "AJ4", size: "5", qty: 2, createdMs: 100, createdAt: "A" },
    ];
    const g = groupRowsByProduct(rows);
    expect(g.map((x) => x.key)).toEqual(["p1", "p2"]);
    expect(g[0].rows.map((r) => r.rowKey)).toEqual(["a", "c"]);
    expect(g[0].oldestMs).toBe(100);
    expect(g[0].oldestIso).toBe("A");
    expect(g[0].photoUrl).toBe("u");
  });
  it("RefillQueue renders the grouped waiting cards (source pin)", () => {
    const rq = src("./RefillQueue.jsx");
    expect(rq).toContain("groupRowsByProduct(waiting).map((g) => (");
    expect(rq).toContain("Release now stays PER LINE");
  });
});

describe("the status line says total units, counting individual sizes", () => {
  it("lines and units both appear; unit sums come from qty", async () => {
    const { queueStatusLine } = await import("./refillQueueCore.js");
    const s = queueStatusLine({ pickCount: 3, pickUnits: 7, waitingCount: 2, waitingUnits: 5, coveredCount: 0, windowsDisabled: false, nextLabel: "06:00" });
    expect(s).toBe("3 to pick (7 units) · next batch 06:00 · 2 waiting (5 units)");
    const legacy = queueStatusLine({ pickCount: 3, waitingCount: 2, coveredCount: 0, windowsDisabled: false, nextLabel: "06:00" });
    expect(legacy).toBe("3 to pick · next batch 06:00 · 2 waiting");
  });
  it("RefillQueue passes real unit sums (source pin)", () => {
    const rq = src("./RefillQueue.jsx");
    expect(rq).toContain("pickUnits: unitsOf(pick)");
    expect(rq).toContain("waitingUnits: unitsOf(waiting)");
  });
});
