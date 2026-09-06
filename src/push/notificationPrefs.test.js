// ─── DEFAULT ON, EXPLICIT WINS, DIRTY DATA NEVER CRASHES ─────────────────────
// The property that matters most here is the one that is easiest to lose in a
// refactor: NO RECORD MEANS ON for a picker. An opt-in that starts off fails
// silently and permanently, which is worse than a notification nobody wanted.
import { describe, it, expect } from "vitest";
import { resolvePushSubscription, prefPayload } from "./notificationPrefs";

describe("a user with no preferences record at all", () => {
  it("is ON for a warehouse picker — the switch does not have to be found", () => {
    const r = resolvePushSubscription({ permRecord: { stockRole: "warehouse" }, prefs: null });
    expect(r.on).toBe(true);
    expect(r.reason).toBe("role_default_on");
  });

  it("is ON for an admin", () => {
    expect(resolvePushSubscription({ permRecord: { stockRole: "admin" }, prefs: null }).on).toBe(true);
  });

  it("is ON for the super-admin, whose stockRole is never stored", () => {
    const r = resolvePushSubscription({ permRecord: { permissions: [] }, prefs: null, isSuperAdmin: true });
    expect(r.on).toBe(true);
    expect(r.buckets).toEqual(["all"]);
  });

  it("is OFF for a POS cashier — the default is scoped to the roles that pick", () => {
    const r = resolvePushSubscription({ permRecord: { stockRole: "pos" }, prefs: null });
    expect(r.on).toBe(false);
    expect(r.buckets).toEqual([]);
  });

  it("is OFF for a store user", () => {
    expect(resolvePushSubscription({ permRecord: { stockRole: "store" }, prefs: null }).on).toBe(false);
  });
});

describe("an explicit setting beats the role default in BOTH directions", () => {
  it("a warehouse picker who switched it off stays off", () => {
    const r = resolvePushSubscription({
      permRecord: { stockRole: "warehouse" },
      prefs: { refillRequests: false },
    });
    expect(r.on).toBe(false);
    expect(r.reason).toBe("explicit_off");
    expect(r.buckets).toEqual([]);
  });

  it("a cashier who switched it on stays on", () => {
    const r = resolvePushSubscription({
      permRecord: { stockRole: "pos", destShop: "hub2" },
      prefs: { refillRequests: true },
    });
    expect(r.on).toBe(true);
    expect(r.reason).toBe("explicit_on");
    expect(r.buckets).toEqual(["hub2"]);
  });
});

describe("dirty accounts resolve safely instead of crashing the fan-out", () => {
  it("no stockRole and no prefs: off, with an empty bucket list", () => {
    const r = resolvePushSubscription({ permRecord: {}, prefs: null });
    expect(r).toEqual({ on: false, buckets: [], reason: "role_default_off" });
  });

  it("a null permRecord (a failed /users read) does not throw", () => {
    expect(() => resolvePushSubscription({ permRecord: null, prefs: null })).not.toThrow();
    expect(resolvePushSubscription({ permRecord: null, prefs: null }).on).toBe(false);
  });

  it("no arguments at all does not throw", () => {
    expect(() => resolvePushSubscription()).not.toThrow();
    expect(resolvePushSubscription().on).toBe(false);
  });

  it("no stockRole but an explicit yes falls back to the wildcard, never to no buckets", () => {
    const r = resolvePushSubscription({ permRecord: { destShop: null }, prefs: { refillRequests: true } });
    expect(r.on).toBe(true);
    // Subscribed-to-nothing would look exactly like working, and tell nobody.
    expect(r.buckets).toEqual(["all"]);
  });

  it("an unrecognised destShop falls back to the wildcard rather than an unreadable bucket", () => {
    const r = resolvePushSubscription({
      permRecord: { stockRole: "store", destShop: "some-old-shop" },
      prefs: { refillRequests: true },
    });
    expect(r.buckets).toEqual(["all"]);
  });

  it("a whitespace-only stockRole is not a role", () => {
    expect(resolvePushSubscription({ permRecord: { stockRole: "   " }, prefs: null }).on).toBe(false);
  });

  it("a malformed prefs value is 'never set', not 'off'", () => {
    // A stray string must not be able to silence a picker.
    for (const bad of [{ refillRequests: "true" }, { refillRequests: 1 }, { refillRequests: null }, {}]) {
      expect(resolvePushSubscription({ permRecord: { stockRole: "warehouse" }, prefs: bad }).on).toBe(true);
    }
  });

  it("always returns an array of buckets, whatever the input", () => {
    for (const permRecord of [null, {}, { stockRole: "warehouse" }, { destShop: "hub1" }]) {
      for (const prefs of [null, { refillRequests: true }, { refillRequests: false }]) {
        expect(Array.isArray(resolvePushSubscription({ permRecord, prefs }).buckets)).toBe(true);
      }
    }
  });
});

describe("bucket scoping", () => {
  it("warehouse and admin hear about every destination, not just their own shop", () => {
    const r = resolvePushSubscription({ permRecord: { stockRole: "warehouse", destShop: "hub1" }, prefs: null });
    expect(r.buckets).toEqual(["all"]);
  });

  it("a scoped user who opts in hears only their own shop", () => {
    const r = resolvePushSubscription({
      permRecord: { stockRole: "store", destShop: "marathon-pe" },
      prefs: { refillRequests: true },
    });
    expect(r.buckets).toEqual(["marathon-pe"]);
  });
});

describe("prefPayload", () => {
  it("writes the boolean the resolver reads, plus when it changed", () => {
    expect(prefPayload(true, 1234)).toEqual({ refillRequests: true, updatedAt: 1234 });
    expect(prefPayload(0, 9).refillRequests).toBe(false);
  });
});
