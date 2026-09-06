// ─── A TAPPED NOTIFICATION LANDS ON THE RIGHT QUEUE ──────────────────────────
// The deep link works by writing the two localStorage keys the app already
// seeds its navigation from. These tests pin that contract, because if either
// key name drifts the link silently lands on whatever screen was last open —
// which looks like the notification simply did nothing.
import { describe, it, expect, beforeEach } from "vitest";
import { applyPushDeepLink } from "./deepLink";

function fakeIo(search) {
  const store = new Map();
  const replaced = [];
  return {
    store,
    replaced,
    io: {
      window: {
        location: { search, href: `https://marathon-club.web.app/${search}`, pathname: "/", hash: "" },
        history: { replaceState: (_s, _t, url) => replaced.push(url) },
      },
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, v),
      },
    },
  };
}

describe("applyPushDeepLink", () => {
  it("sends a Hub 1 alert to the Source workspace, Hub 1 Refill tab", () => {
    const f = fakeIo("?push=refill&hub=hub1&tab=hub1refill");
    expect(applyPushDeepLink(f.io)).toEqual({ role: "source", tab: "hub1refill", hub: "hub1" });
    expect(f.store.get("marathon_role")).toBe("source");
    expect(f.store.get("tabState:source")).toBe("hub1refill");
  });

  it("sends every other destination to the Hub 2 / clothing queue", () => {
    const f = fakeIo("?push=refill&hub=marathon-pe&tab=clothing");
    applyPushDeepLink(f.io);
    expect(f.store.get("tabState:source")).toBe("clothing");
  });

  it("strips the query so a refresh does not re-route someone who has moved on", () => {
    const f = fakeIo("?push=refill&hub=hub1&tab=hub1refill");
    applyPushDeepLink(f.io);
    expect(f.replaced).toEqual(["/"]);
  });

  it("ignores a URL that is not a push link, and touches nothing", () => {
    const f = fakeIo("?utm_source=whatever");
    expect(applyPushDeepLink(f.io)).toBe(null);
    expect(f.store.size).toBe(0);
    expect(f.replaced).toEqual([]);
  });

  it("refuses an unknown tab rather than persisting one the Source view cannot render", () => {
    const f = fakeIo("?push=refill&hub=hub1&tab=../../evil");
    expect(applyPushDeepLink(f.io).tab).toBe("hub1refill");
    expect(f.store.get("tabState:source")).toBe("hub1refill");
  });

  it("does not throw with no window at all (node / SSR)", () => {
    expect(() => applyPushDeepLink({ window: null })).not.toThrow();
  });
});
