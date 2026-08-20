// On-hold → refill request: the routing must come from the ORDER's own
// dispatch field and FAIL CLOSED on every uncertainty. A request against a
// guessed hub moves real stock to the wrong building — the failure mode this
// whole module exists to prevent.
import { describe, it, expect } from "vitest";
import { onHoldRefillPlan, holdCustomerLink } from "./onHoldRefill.js";

const CTX = { nowIso: "2026-08-08T10:00:00.000Z", saDate: "2026-08-08" };
const ORDER = { id: "042", productId: "p1778841820730", size: "9", qty: 1, placedAtHub: "hub1", hub: "hub1" };

describe("onHoldRefillPlan — routes by the order's own hub", () => {
  it("raises against placedAtHub (the dispatch routing field)", () => {
    const plan = onHoldRefillPlan(ORDER, CTX);
    expect(plan.ok).toBe(true);
    expect(plan.hub).toBe("hub1");
    expect(plan.record.requestingLocation).toBe("hub1");
    expect(plan.record.status).toBe("open");
    expect(plan.record.createdFrom).toMatchObject({ manual: true, via: "on_hold", orderId: "042", orderDate: "2026-08-08" });
  });

  it("placedAtHub WINS over the legacy hub field — never a hardcoded map", () => {
    const plan = onHoldRefillPlan({ ...ORDER, placedAtHub: "hub2", hub: "hub1" }, CTX);
    expect(plan.hub).toBe("hub2");
  });

  it("falls back to the legacy hub field when placedAtHub is absent", () => {
    const plan = onHoldRefillPlan({ ...ORDER, placedAtHub: null }, CTX);
    expect(plan.ok).toBe(true);
    expect(plan.hub).toBe("hub1");
  });

  it("the id is deterministic per (day, order) — a re-tap cannot mint a second ask", () => {
    const a = onHoldRefillPlan(ORDER, CTX);
    const b = onHoldRefillPlan(ORDER, CTX);
    expect(a.requestId).toBe(b.requestId);
    expect(a.requestId).toBe("onhold_2026-08-08_042");
  });

  it("strips RTDB-illegal characters from the id", () => {
    const plan = onHoldRefillPlan({ ...ORDER, id: "04.2#x" }, CTX);
    expect(plan.requestId).not.toMatch(/[.#$/[\]\s:]/);
  });
});

describe("onHoldRefillPlan — FAILS CLOSED, never guesses", () => {
  it("refuses an unroutable hub (hubC, hub3, junk) rather than picking one", () => {
    for (const bad of ["hubC", "hub3", "central", "marathon-pe", "x"]) {
      const plan = onHoldRefillPlan({ ...ORDER, placedAtHub: bad, hub: bad }, CTX);
      expect(plan.ok, `hub ${bad} must fail closed`).toBe(false);
      expect(plan.reason).toContain(bad);
    }
  });

  it("refuses when no hub is recorded at all", () => {
    expect(onHoldRefillPlan({ ...ORDER, placedAtHub: null, hub: null }, CTX)).toMatchObject({ ok: false, reason: "no_hub" });
  });

  it("refuses without a productId — a nameless ask cannot enter the queue", () => {
    expect(onHoldRefillPlan({ ...ORDER, productId: null }, CTX)).toMatchObject({ ok: false, reason: "no_product_id" });
  });

  it("refuses without a size — this is a SIZE refill request", () => {
    expect(onHoldRefillPlan({ ...ORDER, size: null }, CTX).ok).toBe(false);
    expect(onHoldRefillPlan({ ...ORDER, size: "" }, CTX).ok).toBe(false);
    expect(onHoldRefillPlan({ ...ORDER, size: "  " }, CTX).ok).toBe(false);
  });

  it("keeps the size as a raw-space VALUE (5.5 stays 5.5 — it is a field, not a key)", () => {
    const plan = onHoldRefillPlan({ ...ORDER, size: "5.5" }, CTX);
    expect(plan.ok).toBe(true);
    expect(plan.record.size).toBe("5.5");
  });

  it("defaults qty to 1 and floors junk", () => {
    expect(onHoldRefillPlan({ ...ORDER, qty: undefined }, CTX).record.qty).toBe(1);
    expect(onHoldRefillPlan({ ...ORDER, qty: 3 }, CTX).record.qty).toBe(3);
  });
});

// ── the lifecycle half (Kimi review, PR #335): one surface at every moment ──
import { holdReleaseUpdate } from "./onHoldRefill.js";

// heldCardVisible is GONE (owner spec 2026-08-08): there are no held cards or
// exception rows anywhere on the refill surface any more — a hold that raised
// a request is an ordinary queue row, and one that could not raise a request
// exists only as a warehouse On Hold order.

describe("holdReleaseUpdate — leaving on-hold withdraws the still-open ask", () => {
  const CTX2 = { nowIso: "2026-08-08T12:00:00.000Z", uid: "vWfHqbLEPvRMItXhH0B9NvYW0LG3" };
  const HELD = { id: "042", onHoldRefillRequestId: "onhold_2026-08-08_042" };

  it("marks the request cancelled with hold_released and the person", () => {
    const rel = holdReleaseUpdate(HELD, "ready", CTX2);
    expect(rel.requestId).toBe("onhold_2026-08-08_042");
    expect(rel.patch).toEqual({
      status: "cancelled", resolvedAt: CTX2.nowIso,
      cancelReason: "hold_released", resolvedBy: CTX2.uid,
    });
  });

  it("never defaults the human-reject shape — cancelReason is ALWAYS present here", () => {
    // cancelReason absence means human ✕ across the codebase; a release must
    // not masquerade as one.
    expect(holdReleaseUpdate(HELD, "collected", CTX2).patch.cancelReason).toBe("hold_released");
  });

  it("omits resolvedBy when nobody is signed in (omit-don't-copy)", () => {
    const rel = holdReleaseUpdate(HELD, "ready", { nowIso: CTX2.nowIso, uid: null });
    expect("resolvedBy" in rel.patch).toBe(false);
  });

  it("no-op when the order stays on hold or never raised a request", () => {
    expect(holdReleaseUpdate(HELD, "coming_tomorrow", CTX2)).toBeNull();
    expect(holdReleaseUpdate({ id: "042" }, "ready", CTX2)).toBeNull();
  });
});

// ─── THE RE-LINK (owner reinstatement 2026-08-19) ────────────────────────────
// The fulfil notification is sent hours or days after the hold, by a server
// trigger that cannot go looking for the order (daily-recycled numbers,
// ephemeral /orders). Everything it needs is on the request record or the
// customer is never told — so the shape of holdLink IS the promise.
describe("holdCustomerLink — the invisible re-link stored on the request", () => {
  const HELD_ORDER = {
    id: "042", productId: "p1", size: "9", qty: 1, placedAtHub: "hub1",
    customerId: "c0821234567", customerName: "Thandi", customerPhone: "0821234567",
  };

  it("carries customer id, name, phone and the order reference", () => {
    expect(holdCustomerLink(HELD_ORDER, "2026-08-19")).toEqual({
      orderId: "042",
      orderDate: "2026-08-19",
      customerId: "c0821234567",
      customerName: "Thandi",
      customerPhone: "0821234567",
      notifyOnFulfil: true,
    });
  });

  it("the plan stores it on the record — and nothing else about the customer", () => {
    const plan = onHoldRefillPlan(HELD_ORDER, CTX);
    expect(plan.record.holdLink.customerPhone).toBe("0821234567");
    expect(plan.record.holdLink.notifyOnFulfil).toBe(true);
    // The rest of the record is byte-identical to any other refill request:
    // nothing about the customer leaks into a field the queue reads.
    const { holdLink, ...rest } = plan.record;
    expect(JSON.stringify(rest)).not.toMatch(/Thandi|0821234567/);
  });

  it("NO PHONE disarms the send but still raises the refill row", () => {
    // The stock need is real and independent of the message. Arming a send with
    // nowhere to go is how a notifier ends up retrying forever.
    for (const phone of [undefined, null, "", "   ", {}, []]) {
      const link = holdCustomerLink({ ...HELD_ORDER, customerPhone: phone }, "2026-08-19");
      expect(link.customerPhone).toBeNull();
      expect(link.notifyOnFulfil).toBe(false);
    }
    const plan = onHoldRefillPlan({ ...HELD_ORDER, customerPhone: null }, CTX);
    expect(plan.ok).toBe(true);
    expect(plan.record.holdLink.notifyOnFulfil).toBe(false);
  });

  it("never emits undefined — an undefined leaf makes RTDB set() throw (PR #327)", () => {
    const link = holdCustomerLink({}, undefined);
    for (const [k, v] of Object.entries(link)) {
      expect(v, `${k} must not be undefined`).not.toBe(undefined);
    }
    expect(link.orderId).toBe("");
    expect(link.customerId).toBeNull();
    expect(link.orderDate).toBeNull();
  });

  it("a numeric phone survives as digits, not as \"undefined\" or NaN", () => {
    const link = holdCustomerLink({ ...HELD_ORDER, customerPhone: 27821234567 }, "2026-08-19");
    expect(link.customerPhone).toBe("27821234567");
    expect(link.notifyOnFulfil).toBe(true);
  });
});
