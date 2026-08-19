// The gap census's two decisions, pinned. Run: npx vitest run scripts/lib/holdNotifyGap.test.mjs
import { describe, it, expect } from "vitest";
import { isInGap, resolveContact, gapRow } from "./holdNotifyGap.mjs";

const REMOVED_AT = "2026-08-08T19:31:25.000Z";
const req = (over = {}) => ({
  status: "fulfilled",
  productId: "p1", size: "9", qty: 1, requestingLocation: "hub1",
  createdAt: "2026-08-14T06:00:00.000Z",
  resolvedAt: "2026-08-15T07:38:00.000Z",
  createdFrom: { via: "on_hold", orderId: "077", orderDate: "2026-08-14" },
  ...over,
});
const event = (over = {}) => ({
  action: "tomorrow", refillRequestId: "onhold_2026-08-14_077",
  customerName: "Ibro", customerPhone: "+27670116867",
  orderNumber: "077", productName: "adidas Adizero", ...over,
});

describe("isInGap — who was owed a message and never got one", () => {
  it("a FULFILLED hold with nothing on record is in the gap", () => {
    expect(isInGap(req())).toBe(true);
  });

  it("cancelled rows owed nothing — the stock never reached the hub", () => {
    for (const status of ["cancelled", "open"]) expect(isInGap(req({ status }))).toBe(false);
  });

  it("a row the notifier told, or whose number it refused, leaves the gap", () => {
    expect(isInGap(req({ holdLink: { notifiedAt: "2026-08-19T08:00:00.000Z" } }))).toBe(false);
    expect(isInGap(req({ holdLink: { notifyFailedAt: "2026-08-19T08:00:00.000Z" } }))).toBe(false);
  });

  it("an UNRESOLVED claim STAYS in the gap — nobody can say the message went out", () => {
    // The notifier never takes a claim over, so a claim with no outcome is
    // precisely the customer a human has to decide about.
    expect(isInGap(req({ holdLink: { notifyClaimedAt: "2026-08-19T08:00:00.000Z" } }))).toBe(true);
  });
});

describe("resolveContact — holdLink first, the log as fallback", () => {
  it("prefers the contact stored ON the request", () => {
    const r = req({ holdLink: { customerName: "Ibro", customerPhone: "+27670116867", notifyOnFulfil: true } });
    expect(resolveContact(r, event({ customerPhone: "+27000000000", customerName: "Stale" })))
      .toEqual({ customerName: "Ibro", customerPhone: "+27670116867", contactSource: "holdLink" });
  });

  it("falls back to the hold event for the pre-re-link era", () => {
    expect(resolveContact(req(), event()))
      .toEqual({ customerName: "Ibro", customerPhone: "+27670116867", contactSource: "insights_log" });
  });

  it("a holdLink row with NO matching insight event is still contactable", () => {
    // The "tomorrow" insight is a SEPARATE write from request creation, so a
    // failed log write must not report NO-CONTACT for a number sitting right
    // there on the row. (CodeRabbit #385.)
    const r = req({ holdLink: { customerName: "Ibro", customerPhone: "+27670116867", notifyClaimedAt: "x" } });
    const row = gapRow("onhold_2026-08-14_077", r, undefined, REMOVED_AT);
    expect(row.customerPhone).toBe("+27670116867");
    expect(row.customerResolved).toBe(true);
    expect(row.unresolvedClaim).toBe(true);
    expect(row.contactSource).toBe("holdLink");
  });

  it("reports nobody when neither source has a number", () => {
    const row = gapRow("x", req(), undefined, REMOVED_AT);
    expect(row.customerPhone).toBeNull();
    expect(row.customerResolved).toBe(false);
    expect(row.contactSource).toBeNull();
  });
});

describe("gapRow — the report line", () => {
  it("carries the order reference from whichever source has it", () => {
    expect(gapRow("id", req(), event(), REMOVED_AT).orderNumber).toBe("077");
    const noCreatedFrom = req({ createdFrom: undefined, holdLink: { orderId: "077", orderDate: "2026-08-14" } });
    const row = gapRow("id", noCreatedFrom, undefined, REMOVED_AT);
    expect(row.orderNumber).toBe("077");
    expect(row.saDate).toBe("2026-08-14");
  });

  it("flags a row raised before the removal commit rather than dropping it", () => {
    expect(gapRow("id", req({ createdAt: "2026-08-08T19:00:00.000Z" }), event(), REMOVED_AT).beforeRemovalCommit).toBe(true);
    expect(gapRow("id", req(), event(), REMOVED_AT).beforeRemovalCommit).toBe(false);
  });
});
