// ─── A TAPPED NOTIFICATION LANDS ON THE ORDER IT WAS ABOUT ───────────────────
// The deep link works by writing the localStorage keys the app already seeds
// its navigation from, plus a one-shot focus marker naming the card to ring.
// These tests pin that contract, because if a key name drifts the link silently
// lands on whatever screen was last open — which looks like the notification
// simply did nothing.
import { describe, it, expect } from "vitest";
import {
  applyPushDeepLink, takeFocusOrder, orderCardKey, FOCUS_ORDER_KEY, FOCUS_ORDER_TTL_MS,
} from "./deepLink";

const NOW = 1_757_000_000_000;
const AT = "2026-09-06T07:07:41.633Z";

function fakeIo(search, nowMs = NOW) {
  const store = new Map();
  const replaced = [];
  return {
    store,
    replaced,
    io: {
      nowMs,
      window: {
        location: { search, href: `https://marathon-club.web.app/${search}`, pathname: "/", hash: "" },
        history: { replaceState: (_s, _t, url) => replaced.push(url) },
      },
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, v),
        removeItem: (k) => store.delete(k),
      },
    },
  };
}

const fakeStore = (initial = {}) => {
  const store = new Map(Object.entries(initial));
  return {
    store,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
  };
};

describe("applyPushDeepLink — an order", () => {
  it("opens the warehouse, on the hub that picks it, on the tab it is listed on", () => {
    const f = fakeIo(`?push=order&hub=hub1&tab=queue&order=005&at=${encodeURIComponent(AT)}`);
    expect(applyPushDeepLink(f.io)).toEqual({ role: "warehouse", hub: "hub1", tab: "queue", order: "005" });
    expect(f.store.get("marathon_role")).toBe("warehouse");
    expect(f.store.get("warehouseHub")).toBe("hub1");
    expect(f.store.get("tabState:warehouse")).toBe("queue");
  });

  it("a CR refill lands on the clothing tab of its CR hub", () => {
    const f = fakeIo("?push=order&hub=hub2&tab=clothing&order=R041-2&at=" + encodeURIComponent(AT));
    applyPushDeepLink(f.io);
    expect(f.store.get("warehouseHub")).toBe("hub2");
    expect(f.store.get("tabState:warehouse")).toBe("clothing");
  });

  it("leaves a focus marker carrying id AND createdAt — the id alone is recycled daily", () => {
    const f = fakeIo(`?push=order&hub=hub1&tab=queue&order=005&at=${encodeURIComponent(AT)}`);
    applyPushDeepLink(f.io);
    const marker = JSON.parse(f.store.get(FOCUS_ORDER_KEY));
    expect(marker.id).toBe("005");
    expect(marker.createdAt).toBe(AT);
    // Two different days at the same order number must not share a card key.
    expect(orderCardKey("005", AT)).not.toBe(orderCardKey("005", "2026-09-07T07:07:41.633Z"));
  });

  it("a BURST link carries no order, so nothing is focused and the queue simply opens", () => {
    const f = fakeIo("?push=order&hub=hub2&tab=queue");
    expect(applyPushDeepLink(f.io).order).toBe(null);
    expect(f.store.has(FOCUS_ORDER_KEY)).toBe(false);
    expect(f.store.get("warehouseHub")).toBe("hub2");
  });

  it("refuses a hub the warehouse selector cannot render, rather than persisting a blank screen", () => {
    const f = fakeIo("?push=order&hub=../../evil&tab=queue&order=005");
    expect(applyPushDeepLink(f.io).hub).toBe(null);
    expect(f.store.has("warehouseHub")).toBe(false);
    // The workspace still opens — the reader lands on the hub they last used,
    // which is a real screen, instead of on nothing.
    expect(f.store.get("marathon_role")).toBe("warehouse");
  });

  it("refuses an unknown tab rather than persisting one the warehouse cannot render", () => {
    const f = fakeIo("?push=order&hub=hub1&tab=../../evil&order=005");
    expect(applyPushDeepLink(f.io).tab).toBe("queue");
    expect(f.store.get("tabState:warehouse")).toBe("queue");
  });

  it("strips the query so a refresh does not re-route someone who has moved on", () => {
    const f = fakeIo("?push=order&hub=hub1&tab=queue&order=005");
    applyPushDeepLink(f.io);
    expect(f.replaced).toEqual(["/"]);
  });

  it("ignores a URL that is not a push link, and touches nothing", () => {
    const f = fakeIo("?utm_source=whatever");
    expect(applyPushDeepLink(f.io)).toBe(null);
    expect(f.store.size).toBe(0);
    expect(f.replaced).toEqual([]);
  });

  it("does not throw with no window at all (node / SSR)", () => {
    expect(() => applyPushDeepLink({ window: null })).not.toThrow();
  });
});

describe("applyPushDeepLink — the old refill link still works", () => {
  it("a notification sent before this build shipped still opens its Source queue", () => {
    // One sitting on a lock screen right now must not become a link that does
    // nothing, which is indistinguishable from an app that is broken.
    const f = fakeIo("?push=refill&hub=hub1&tab=hub1refill");
    expect(applyPushDeepLink(f.io)).toEqual({ role: "source", tab: "hub1refill", hub: "hub1" });
    expect(f.store.get("marathon_role")).toBe("source");
    expect(f.store.get("tabState:source")).toBe("hub1refill");
  });
});

describe("takeFocusOrder", () => {
  it("returns the marker once and removes it — a tap rings one card, not every later visit", () => {
    const f = fakeStore({
      [FOCUS_ORDER_KEY]: JSON.stringify({ id: "005", createdAt: AT, writtenAt: NOW }),
    });
    expect(takeFocusOrder({ localStorage: f.localStorage, nowMs: NOW + 1000 }))
      .toEqual({ id: "005", createdAt: AT });
    expect(f.store.has(FOCUS_ORDER_KEY)).toBe(false);
    expect(takeFocusOrder({ localStorage: f.localStorage, nowMs: NOW + 1000 })).toBe(null);
  });

  it("EXPIRES — yesterday's untapped marker does not ring a card today", () => {
    const f = fakeStore({
      [FOCUS_ORDER_KEY]: JSON.stringify({ id: "005", createdAt: AT, writtenAt: NOW }),
    });
    expect(takeFocusOrder({ localStorage: f.localStorage, nowMs: NOW + FOCUS_ORDER_TTL_MS + 1 })).toBe(null);
    expect(f.store.has(FOCUS_ORDER_KEY)).toBe(false, "and it is cleared rather than retried forever");
  });

  it("a malformed marker is dropped, never thrown — this runs on a screen a picker is using", () => {
    for (const bad of ["not json", "null", "42", JSON.stringify({ id: 5 }), JSON.stringify({ id: "005" })]) {
      const f = fakeStore({ [FOCUS_ORDER_KEY]: bad });
      expect(takeFocusOrder({ localStorage: f.localStorage, nowMs: NOW })).toBe(null);
      expect(f.store.has(FOCUS_ORDER_KEY)).toBe(false);
    }
  });

  it("no storage at all is null, not a crash", () => {
    expect(takeFocusOrder({ localStorage: null })).toBe(null);
  });
});
