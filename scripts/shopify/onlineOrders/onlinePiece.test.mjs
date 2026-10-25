// Junid, 25 Oct 09:52 — only the online order's piece of a request is ever released.
import { describe, it, expect } from "vitest";
import { planRelease, applyPlan, RELEASE } from "./onlinePiece.mjs";

const OURS = { via: "online_escalation", orderKey: "9001", lineIndex: 0 };
const refill = (over = {}) => ({ status: "open", qty: 1, createdFrom: OURS, ...over });
const card = (over = {}) => ({ status: "incoming", clothingRefillStatus: null, qty: 1, onlineEscalationKey: "K", ...over });
const plan = (kind, record, piece = 1) => planRelease({ kind, record, orderId: "9001", lineIndex: 0, escKey: "K", piece });

describe("refill request", () => {
  it("raised for this line, exactly the piece → withdrawn whole", () => {
    expect(plan("refill", refill())).toMatchObject({ action: RELEASE.CANCEL, before: 1, after: 0 });
  });
  it("Junid's example: 3 = 1 online + 2 genuine → reduced by exactly 1", () => {
    const p = plan("refill", refill({ qty: 3 }));
    expect(p).toMatchObject({ action: RELEASE.REDUCE, before: 3, after: 2 });
    expect(applyPlan("refill", refill({ qty: 3 }), p, { nowMs: 5, ref: "#1" })).toMatchObject({ status: "open", qty: 2, onlineReleased: { qty: 1, before: 3, after: 2 } });
  });
  it("a genuine refill (no tag, or another line's tag) is never changed — can't tell", () => {
    expect(plan("refill", refill({ createdFrom: { source: "scan" } })).action).toBe(RELEASE.UNCLEAR);
    expect(plan("refill", refill({ createdFrom: { ...OURS, lineIndex: 1 } })).action).toBe(RELEASE.UNCLEAR);
    expect(plan("refill", refill({ createdFrom: { ...OURS, orderKey: "9002" } })).action).toBe(RELEASE.UNCLEAR);
    expect(applyPlan("refill", refill(), { action: RELEASE.UNCLEAR }, { nowMs: 5 })).toBeUndefined();
  });
  it("less than the piece, or unreadable quantities → can't tell", () => {
    expect(plan("refill", refill({ qty: 1 }), 2).action).toBe(RELEASE.UNCLEAR);
    expect(plan("refill", refill({ qty: "x" })).action).toBe(RELEASE.UNCLEAR);
  });
  it("being picked, part-sent or answered → left to the people doing it", () => {
    expect(plan("refill", refill({ picking: { by: "a" } })).action).toBe(RELEASE.BUSY);
    expect(plan("refill", refill({ qty: 3, sentQty: 1 })).action).toBe(RELEASE.BUSY);
    expect(plan("refill", refill({ status: "fulfilled" })).action).toBe(RELEASE.BUSY);
  });
  it("absent, or already withdrawn as no longer needed → gone (nothing to do)", () => {
    expect(plan("refill", null).action).toBe(RELEASE.GONE);
    expect(plan("refill", refill({ status: "cancelled", cancelReason: "no_longer_needed" })).action).toBe(RELEASE.GONE);
  });
});

describe("Shop Refill card", () => {
  it("this line's card: exactly the piece → removed; more → reduced by the piece", () => {
    expect(plan("store_order", card())).toMatchObject({ action: RELEASE.CANCEL, before: 1, after: 0 });
    expect(applyPlan("store_order", card(), plan("store_order", card()), { nowMs: 5 })).toBeNull();
    expect(plan("store_order", card({ qty: 2 }))).toMatchObject({ action: RELEASE.REDUCE, before: 2, after: 1 });
  });
  it("another order's card, or an untagged one → can't tell; answered by Hub 2 → busy", () => {
    expect(plan("store_order", card({ onlineEscalationKey: "OTHER" })).action).toBe(RELEASE.UNCLEAR);
    expect(plan("store_order", card({ onlineEscalationKey: undefined })).action).toBe(RELEASE.UNCLEAR);
    expect(plan("store_order", card({ clothingRefillStatus: "available" })).action).toBe(RELEASE.BUSY);
  });
});
