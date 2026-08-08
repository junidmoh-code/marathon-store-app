// On-hold → refill request: the routing must come from the ORDER's own
// dispatch field and FAIL CLOSED on every uncertainty. A request against a
// guessed hub moves real stock to the wrong building — the failure mode this
// whole module exists to prevent.
import { describe, it, expect } from "vitest";
import { onHoldRefillPlan } from "./onHoldRefill.js";

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
import { heldCardVisible, holdReleaseUpdate } from "./onHoldRefill.js";

describe("heldCardVisible — the queue and the held list never both (or neither) show an ask", () => {
  const statuses = (o) => new Map(Object.entries(o));

  it("a hold that never raised a request is always a held card", () => {
    expect(heldCardVisible(null, statuses({}), true)).toBe(true);
    expect(heldCardVisible(undefined, statuses({}), false)).toBe(true);
  });

  it("an OPEN request suppresses the held card — the queue owns it", () => {
    expect(heldCardVisible("onhold_x", statuses({ onhold_x: "open" }), true)).toBe(false);
  });

  it("a REJECTED request hands the ask BACK to the held card — it must not vanish", () => {
    // The reviewed bug: unconditional suppression left a rejected ask visible
    // nowhere while the customer order sat coming_tomorrow forever.
    expect(heldCardVisible("onhold_x", statuses({ onhold_x: "cancelled" }), true)).toBe(true);
  });

  it("a FULFILLED request also returns the card (stock arrived — send it on)", () => {
    expect(heldCardVisible("onhold_x", statuses({ onhold_x: "fulfilled" }), true)).toBe(true);
  });

  it("a DELETED request row falls back to the held card, never to nowhere", () => {
    expect(heldCardVisible("onhold_gone", statuses({}), true)).toBe(true);
  });

  it("while requests are still loading the card stays hidden (no duplicate flash)", () => {
    expect(heldCardVisible("onhold_x", statuses({}), false)).toBe(false);
  });
});

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
