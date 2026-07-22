// ─── DISPLAY CHECKS — SESSION SINGLETON GUARD ────────────────────────────────
// Pins the one behaviour a shared iPad depends on: a user change WIPES the
// persisted UI state, so user A's tab / search / selection / scroll / feed-cache
// can never leak to user B on the same device. This is the logout→login hole a
// reviewer caught during #260 — the fix was manual, so this test exists to stop
// it silently regressing on the very devices (shared store iPads) where it bites.

import { beforeEach, describe, expect, it } from "vitest";
import { dcSession, bindDcSession } from "./session";

// Seed the singleton as if user A had been using the module: a non-default tab, a
// live search + selection, some scroll, and a cached feed for a store.
function seedAsUserA(uid = "userA") {
  bindDcSession(uid);
  dcSession.activeTab = "availability";
  dcSession.search = "nike hoodie";
  dcSession.selectedId = "p123";
  dcSession.scroll = { today: 420, availability: 88 };
  dcSession.feedByStore = { "marathon-pe": { activeItems: [{ key: "x" }], completedItems: [], saDate: "2026-07-21" } };
}

describe("dcSession user-change guard (bindDcSession)", () => {
  beforeEach(() => {
    // Fresh baseline each test — reset via a throwaway uid, then to null.
    bindDcSession("__reset__");
    bindDcSession(null);
  });

  it("wipes ALL prior-user state when the uid changes (logout A → login B)", () => {
    seedAsUserA("userA");

    bindDcSession("userB"); // B logs in on the same device

    expect(dcSession.uid).toBe("userB");
    expect(dcSession.activeTab).toBe("today");     // back to default tab
    expect(dcSession.search).toBe("");             // A's search gone
    expect(dcSession.selectedId).toBeNull();       // A's selection gone
    expect(dcSession.scroll).toEqual({});          // A's scroll gone
    expect(dcSession.feedByStore).toEqual({});     // A's cached checks gone
  });

  it("also wipes on logout to a signed-out state (uid → null)", () => {
    seedAsUserA("userA");

    bindDcSession(null); // signed out

    expect(dcSession.uid).toBeNull();
    expect(dcSession.activeTab).toBe("today");
    expect(dcSession.search).toBe("");
    expect(dcSession.selectedId).toBeNull();
    expect(dcSession.scroll).toEqual({});
    expect(dcSession.feedByStore).toEqual({});
  });

  it("treats undefined uid as null (no crash, still a clean signed-out state)", () => {
    seedAsUserA("userA");

    bindDcSession(undefined);

    expect(dcSession.uid).toBeNull();
    expect(dcSession.search).toBe("");
  });

  it("is a no-op for the SAME user — persisted state survives a remount", () => {
    seedAsUserA("userA");

    bindDcSession("userA"); // same user, module just remounted (tab switch / rotation / return)

    expect(dcSession.uid).toBe("userA");
    expect(dcSession.activeTab).toBe("availability"); // preserved
    expect(dcSession.search).toBe("nike hoodie");     // preserved
    expect(dcSession.selectedId).toBe("p123");        // preserved
    expect(dcSession.scroll).toEqual({ today: 420, availability: 88 });
    expect(dcSession.feedByStore["marathon-pe"]).toBeTruthy();
  });

  it("gives each new user a FRESH object identity for scroll/feed (no shared mutable ref)", () => {
    seedAsUserA("userA");
    const aScroll = dcSession.scroll;
    const aFeed = dcSession.feedByStore;

    bindDcSession("userB");

    // B must not be handed A's mutable containers.
    expect(dcSession.scroll).not.toBe(aScroll);
    expect(dcSession.feedByStore).not.toBe(aFeed);
  });
});
