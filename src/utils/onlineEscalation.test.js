import { describe, it, expect } from "vitest";
import {
  ESC_PHASE, STEP, nextDeliveryAt, planFor, homeOf, startEscalation, stepEscalation, pendingAction,
  requestOutcome, requestKey, describeEscalation,
} from "./onlineEscalation.js";

const T0 = Date.parse("2026-10-21T10:00:00Z"); // Wed 12:00 SAST
const H = 3600e3;
const sast = (ms) => new Date(ms + 2 * H).toISOString().slice(0, 16).replace("T", " ");

const shirt = { pid: "TEE", size: "M", qty: 1, isFootwear: false, source: { locationId: "marathon-pe", status: "not_found" } };
const shoe = { pid: "SNK", size: "8", qty: 1, isFootwear: true, source: { locationId: "hub1", status: "not_found" } };

// Drive the machine the way the poller does: perform whatever it asks.
function run(esc, script, t = T0) {
  let e = esc;
  for (const ev of script) e = stepEscalation(e, ev, { nowMs: ev.at ?? t });
  return e;
}
const raised = (key = "k") => ({ type: "raised", request: { key } });
const rejected = { type: "request", outcome: "rejected" };
const fulfilled = (at = T0) => ({ type: "request", outcome: "fulfilled", at });
const handed = { type: "line", outcome: "handed" };
const failed = { type: "line", outcome: "failed" };

describe("nextDeliveryAt — 11:00 SAST the next working day", () => {
  it("Wednesday afternoon → Thursday 11:00", () => {
    expect(sast(nextDeliveryAt(T0))).toBe("2026-10-22 11:00");
  });
  it("Saturday → Monday (Sunday is not a working day)", () => {
    expect(sast(nextDeliveryAt(Date.parse("2026-10-24T12:00:00Z")))).toBe("2026-10-26 11:00");
  });
  it("Sunday → Monday", () => {
    expect(sast(nextDeliveryAt(Date.parse("2026-10-25T08:00:00Z")))).toBe("2026-10-26 11:00");
  });
  it("Friday 23:30 SAST → Saturday 11:00 (the SA calendar day, not UTC's)", () => {
    expect(sast(nextDeliveryAt(Date.parse("2026-10-23T21:30:00Z")))).toBe("2026-10-24 11:00");
  });
  it("Saturday 00:30 SAST (Friday in UTC) → Monday", () => {
    expect(sast(nextDeliveryAt(Date.parse("2026-10-23T22:30:00Z")))).toBe("2026-10-26 11:00");
  });
});

describe("plans", () => {
  it("non-footwear at a shop: Hub 2 → shop, Central → Hub 2; round 2 starts with the shop checking properly", () => {
    expect(planFor({ footwear: false, home: "trophy", round: 1 })).toEqual([
      { step: STEP.STORE_ORDER, from: "hub2", to: "trophy" },
      { step: STEP.REFILL, from: "central", to: "hub2" },
    ]);
    expect(planFor({ footwear: false, home: "trophy", round: 2 })[0]).toEqual({ step: STEP.RECHECK, at: "trophy" });
  });
  it("footwear: Central → the hub; round 2 depends on how round 1 ended", () => {
    expect(planFor({ footwear: true, home: "hub2", round: 1 })).toEqual([{ step: STEP.REFILL, from: "central", to: "hub2" }]);
    expect(planFor({ footwear: true, home: "hub2", round: 2, centralRejected: false })).toEqual([{ step: STEP.REFILL, from: "central", to: "hub2" }]);
    expect(planFor({ footwear: true, home: "hub2", round: 2, centralRejected: true })).toEqual([{ step: STEP.RECHECK, at: "hub2" }]);
  });
  it("home: shop for a shop line, the failing hub for footwear, Hub 2 otherwise", () => {
    expect(homeOf(shirt)).toBe("marathon-pe");
    expect(homeOf({ ...shirt, source: { locationId: "hub2", status: "not_found" } })).toBe("hub2");
    expect(homeOf({ ...shirt, source: { status: "no_stock" } })).toBe("hub2");
    expect(homeOf({ ...shoe, source: { locationId: "hub2", status: "not_found" } })).toBe("hub2");
    expect(homeOf({ ...shoe, source: { status: "no_stock" } })).toBe("hub1");
  });
});

describe("non-footwear chain", () => {
  it("every rejection → both rounds → unavailable, each step asked of the right place", () => {
    let e = startEscalation(shirt, { nowMs: T0, reason: "not_found" });
    const asked = [];
    for (let n = 0; n < 20 && e.phase !== ESC_PHASE.UNAVAILABLE; n++) {
      const a = pendingAction(e, { nowMs: T0 });
      if (a.kind === "recheck") { asked.push(`recheck@${a.at}`); e = run(e, [raised(), { type: "delivered" }, failed]); continue; }
      asked.push(`${a.kind}:${a.from}->${a.to}`);
      e = run(e, [raised(), rejected]);
    }
    expect(asked).toEqual([
      "store_order:hub2->marathon-pe",
      "refill:central->hub2",
      "recheck@marathon-pe",
      "store_order:hub2->marathon-pe",
      "refill:central->hub2",
    ]);
    expect(e.phase).toBe(ESC_PHASE.UNAVAILABLE);
    expect(e.round).toBe(2);
    expect(pendingAction(e, { nowMs: T0 })).toBeNull();
  });

  it("Hub 2 sends it → waits for the box → back on the shop's display list → handed = done", () => {
    let e = startEscalation(shirt, { nowMs: T0, reason: "not_found" });
    e = run(e, [raised("R001-1"), fulfilled()]);
    expect(e.phase).toBe(ESC_PHASE.WAIT);
    expect(e.deliverAt).toBe("marathon-pe");
    expect(sast(e.waitUntil)).toBe("2026-10-22 11:00");
    // Before 11:00 the next day nothing moves.
    expect(pendingAction(e, { nowMs: e.waitUntil - 1 })).toBeNull();
    expect(stepEscalation(e, { type: "tick" }, { nowMs: e.waitUntil - 1 })).toBe(e);
    e = stepEscalation(e, { type: "tick" }, { nowMs: e.waitUntil });
    expect(pendingAction(e, { nowMs: e.waitUntil })).toEqual({ kind: "deliver", at: "marathon-pe", checkProperly: false });
    e = run(e, [{ type: "delivered" }, handed]);
    expect(e.phase).toBe(ESC_PHASE.DONE);
  });

  it("Central sends to Hub 2 → the line becomes a Hub 2 pick the next day", () => {
    let e = startEscalation(shirt, { nowMs: T0, reason: "not_found" });
    e = run(e, [raised(), rejected, raised(), fulfilled()]);
    expect(e).toMatchObject({ phase: ESC_PHASE.WAIT, deliverAt: "hub2" });
  });

  it("a delivered line that is not found again moves on to the next step", () => {
    let e = startEscalation(shirt, { nowMs: T0, reason: "not_found" });
    e = run(e, [raised(), fulfilled()]);
    e = stepEscalation(e, { type: "tick" }, { nowMs: e.waitUntil });
    e = run(e, [{ type: "delivered" }, failed]);
    expect(pendingAction(e, { nowMs: T0 })).toEqual({ kind: STEP.REFILL, from: "central", to: "hub2" });
  });

  it("round 2's re-check carries CHECK PROPERLY", () => {
    let e = startEscalation(shirt, { nowMs: T0, reason: "not_found" });
    e = run(e, [raised(), rejected, raised(), rejected, raised()]);
    expect(e).toMatchObject({ round: 2, phase: ESC_PHASE.DELIVER, checkProperly: true, deliverAt: "marathon-pe" });
    expect(pendingAction(e, { nowMs: T0 })).toEqual({ kind: "deliver", at: "marathon-pe", checkProperly: true });
  });

  it("home Hub 2: Central → Hub 2, then Hub 2 checks properly, then Central once more", () => {
    let e = startEscalation({ ...shirt, source: { locationId: "hub2", status: "not_found" } }, { nowMs: T0, reason: "not_found" });
    const asked = [];
    for (let n = 0; n < 10 && e.phase !== ESC_PHASE.UNAVAILABLE; n++) {
      const a = pendingAction(e, { nowMs: T0 });
      if (a.kind === "recheck") { asked.push(`recheck@${a.at}`); e = run(e, [raised(), { type: "delivered" }, failed]); continue; }
      asked.push(`${a.kind}:${a.from}->${a.to}`);
      e = run(e, [raised(), rejected]);
    }
    expect(asked).toEqual(["refill:central->hub2", "recheck@hub2", "refill:central->hub2"]);
  });
});

describe("footwear chain", () => {
  it("Central sends → next-day re-raise at the hub → rejected again → Central once more → rejected → unavailable", () => {
    let e = startEscalation(shoe, { nowMs: T0, reason: "not_found" });
    expect(pendingAction(e, { nowMs: T0 })).toEqual({ kind: STEP.REFILL, from: "central", to: "hub1" });
    e = run(e, [raised(), fulfilled()]);
    expect(sast(e.waitUntil)).toBe("2026-10-22 11:00");
    e = stepEscalation(e, { type: "tick" }, { nowMs: e.waitUntil });
    expect(pendingAction(e, { nowMs: e.waitUntil })).toEqual({ kind: "deliver", at: "hub1", checkProperly: false });
    e = run(e, [{ type: "delivered" }, failed]);
    expect(e.round).toBe(2);
    expect(pendingAction(e, { nowMs: T0 })).toEqual({ kind: STEP.REFILL, from: "central", to: "hub1" });
    e = run(e, [raised(), rejected]);
    expect(e.phase).toBe(ESC_PHASE.UNAVAILABLE);
  });

  it("round 2 Central sends again (same wait) → the hub rejects a second time → unavailable", () => {
    let e = startEscalation(shoe, { nowMs: T0, reason: "not_found" });
    e = run(e, [raised(), fulfilled()]);
    e = stepEscalation(e, { type: "tick" }, { nowMs: e.waitUntil });
    e = run(e, [{ type: "delivered" }, failed, raised(), fulfilled(T0 + 48 * H)]);
    expect(e.phase).toBe(ESC_PHASE.WAIT);
    expect(sast(e.waitUntil)).toBe("2026-10-24 11:00");
    e = stepEscalation(e, { type: "tick" }, { nowMs: e.waitUntil });
    e = run(e, [{ type: "delivered" }, failed]);
    expect(e.phase).toBe(ESC_PHASE.UNAVAILABLE);
  });

  it("Central rejects → round 2 is the hub once more (CHECK PROPERLY) → rejected → unavailable", () => {
    let e = startEscalation(shoe, { nowMs: T0, reason: "not_found" });
    e = run(e, [raised(), rejected]);
    expect(e).toMatchObject({ round: 2, centralRejected: true });
    expect(pendingAction(e, { nowMs: T0 })).toEqual({ kind: "recheck", at: "hub1" });
    e = run(e, [raised(), { type: "delivered" }]);
    expect(e).toMatchObject({ deliverAt: "hub1", checkProperly: true });
    e = stepEscalation(e, failed, { nowMs: T0 });
    expect(e.phase).toBe(ESC_PHASE.UNAVAILABLE);
  });

  it("the round-2 hub re-check that is found ends the escalation", () => {
    let e = startEscalation(shoe, { nowMs: T0, reason: "not_found" });
    e = run(e, [raised(), rejected, raised(), { type: "delivered" }, handed]);
    expect(e.phase).toBe(ESC_PHASE.DONE);
  });
});

describe("restart safety — a repeated observation is a no-op", () => {
  it("the same answer twice moves the machine once", () => {
    let e = startEscalation(shirt, { nowMs: T0, reason: "not_found" });
    e = run(e, [raised()]);
    const once = stepEscalation(e, rejected, { nowMs: T0 });
    const twice = stepEscalation(once, rejected, { nowMs: T0 });
    // The second "rejected" lands on a RAISE phase, where it means nothing.
    expect(twice).toBe(once);
    expect(stepEscalation(once, { type: "delivered" }, { nowMs: T0 })).toBe(once);
  });
  it("a second 'raised' does not skip a step", () => {
    let e = startEscalation(shirt, { nowMs: T0, reason: "not_found" });
    e = run(e, [raised("a")]);
    expect(stepEscalation(e, raised("b"), { nowMs: T0 })).toBe(e);
  });
  it("delivered twice records once", () => {
    let e = startEscalation(shoe, { nowMs: T0, reason: "not_found" });
    e = run(e, [raised(), rejected, raised(), { type: "delivered" }]);
    expect(stepEscalation(e, { type: "delivered" }, { nowMs: T0 })).toBe(e);
  });
  it("request keys are deterministic per round and step", () => {
    const e = startEscalation(shirt, { nowMs: T0, reason: "not_found" });
    expect(requestKey("9001", 2, e)).toBe("web_9001_2_r1s0");
    expect(requestKey("9001", 2, run(e, [raised(), rejected]))).toBe("web_9001_2_r1s1");
  });
  it("never mutates its input", () => {
    const e = Object.freeze(startEscalation(shirt, { nowMs: T0, reason: "not_found" }));
    expect(() => stepEscalation(e, raised(), { nowMs: T0 })).not.toThrow();
  });
});

describe("overrides (Junid)", () => {
  it("mark unavailable now — from any open phase", () => {
    let e = run(startEscalation(shirt, { nowMs: T0, reason: "not_found" }), [raised()]);
    e = stepEscalation(e, { type: "override", kind: "unavailable", by: "u1" }, { nowMs: T0 });
    expect(e.phase).toBe(ESC_PHASE.UNAVAILABLE);
    expect(e.attempts.at(-1)).toMatchObject({ action: "override", result: "marked_unavailable", by: "u1" });
  });
  it("resolved by hand — also closes an unavailable line, and nothing reopens it", () => {
    let e = stepEscalation(startEscalation(shirt, { nowMs: T0, reason: "not_found" }), { type: "override", kind: "unavailable" }, { nowMs: T0 });
    e = stepEscalation(e, { type: "override", kind: "resolved" }, { nowMs: T0 });
    expect(e.phase).toBe(ESC_PHASE.RESOLVED);
    expect(stepEscalation(e, { type: "override", kind: "unavailable" }, { nowMs: T0 })).toBe(e);
  });
});

describe("requestOutcome", () => {
  it("Shop Refill card", () => {
    expect(requestOutcome(STEP.STORE_ORDER, { clothingRefillStatus: null })).toBeNull();
    expect(requestOutcome(STEP.STORE_ORDER, { clothingRefillStatus: "available", clothingRefilledAt: "2026-10-21T11:00:00.000Z" })).toEqual({ outcome: "fulfilled", at: Date.parse("2026-10-21T11:00:00Z") });
    expect(requestOutcome(STEP.STORE_ORDER, { clothingRefillStatus: "rejected" })).toEqual({ outcome: "rejected" });
    expect(requestOutcome(STEP.STORE_ORDER, { clothingRefillStatus: "outOfStock" })).toEqual({ outcome: "rejected" });
    expect(requestOutcome(STEP.STORE_ORDER, null)).toEqual({ outcome: "withdrawn" });
  });
  it("refill row: a person's Out of Stock is a rejection; a system withdrawal is not", () => {
    expect(requestOutcome(STEP.REFILL, { status: "open" })).toBeNull();
    expect(requestOutcome(STEP.REFILL, { status: "open", sentQty: 1 })).toBeNull();
    expect(requestOutcome(STEP.REFILL, { status: "fulfilled", resolvedAt: "2026-10-21T11:00:00.000Z" }).outcome).toBe("fulfilled");
    expect(requestOutcome(STEP.REFILL, { status: "cancelled" })).toEqual({ outcome: "rejected" });
    expect(requestOutcome(STEP.REFILL, { status: "cancelled", cancelReason: "already_in_stock" })).toEqual({ outcome: "withdrawn" });
  });
});

describe("describeEscalation", () => {
  it("names where the line is and what happens next", () => {
    let e = startEscalation(shirt, { nowMs: T0, reason: "not_found" });
    expect(describeEscalation(e, { nowMs: T0 }).where).toBe("round 1: Hub 2 → Marathon PE");
    e = run(e, [raised(), fulfilled()]);
    const d = describeEscalation(e);
    expect(d.where).toBe("round 1: sent to Marathon PE");
    expect(d.next).toBe("Back on the display list at Marathon PE");
    expect(d.nextAt).toBe(e.waitUntil);
  });
});
