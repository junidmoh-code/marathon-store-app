// Runs theme/posthog-pixel.js — the exact text pasted into Shopify's Customer
// Events — inside a vm sandbox shaped like Shopify's: `analytics.subscribe`,
// `browser.cookie.get`, and a `window`/`document`. posthog-js itself is faked
// by pre-setting window.posthog with __SV=1, which makes PostHog's official
// loader stand down (it only installs its stub when __SV is unset), so the
// test sees exactly what the pixel passes to init() and capture().
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("./posthog-pixel.js", import.meta.url), "utf8");
const KEY = "phc_AF6N3oHUSnSVfKqKxKDVvYgZKkmd3cY244Ww6qo334hP";

function load({ cookie, cookieThrows = false, store = new Map(), storageThrows = false, captureThrows = false } = {}) {
  const handlers = {};
  const calls = { init: [], capture: [], cookieNames: [] };
  const posthog = {
    __SV: 1,
    init(key, cfg) { calls.init.push({ key, cfg }); },
    capture(name, props) { if (captureThrows) throw new Error("posthog not loaded"); calls.capture.push({ name, props }); },
  };
  const window = { posthog };
  const ctx = {
    window,
    document: { createElement() { throw new Error("loader must not inject when __SV is set"); } },
    analytics: { subscribe(name, fn) { handlers[name] = fn; } },
    browser: {
      cookie: {
        async get(name) {
          calls.cookieNames.push(name);
          if (cookieThrows) throw new Error("no cookie access");
          return cookie;
        },
      },
      localStorage: {
        async getItem(k) { if (storageThrows) throw new Error("no storage"); return store.has(k) ? store.get(k) : null; },
        async setItem(k, v) { if (storageThrows) throw new Error("no storage"); store.set(k, String(v)); },
      },
    },
  };
  ctx.posthog = posthog;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { handlers, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

function storefrontCookie(did, sid) {
  return encodeURIComponent(JSON.stringify({ distinct_id: did, $device_id: did, $sesid: [1730000000000, sid, 1730000000000], $user_state: "anonymous" }));
}

const CHECKOUT = {
  id: "evt-1",
  context: { document: { location: { href: "https://marathonclub.co.za/checkouts/cn/abc/information?key=secret#x", pathname: "/checkouts/cn/abc/information", host: "marathonclub.co.za" } } },
  data: {
    checkout: {
      token: "tok-1",
      currencyCode: "ZAR",
      totalPrice: { amount: 1099, currencyCode: "ZAR" },
      subtotalPrice: { amount: 1000, currencyCode: "ZAR" },
      shippingLine: { price: { amount: 99, currencyCode: "ZAR" } },
      order: { id: "gid://shopify/Order/123" },
      email: "shopper@example.com",
      lineItems: [
        { quantity: 2, variant: { product: { url: "/products/red-tab-denim-high-top" } } },
        { quantity: 1, variant: { product: { url: "/products/acid-wash-tee?variant=1" } } },
      ],
    },
  },
};

describe("posthog-pixel.js (Shopify custom pixel)", () => {
  it("subscribes to exactly the six checkout events", () => {
    const { handlers } = load();
    expect(Object.keys(handlers).sort()).toEqual([
      "checkout_address_info_submitted",
      "checkout_completed",
      "checkout_contact_info_submitted",
      "checkout_shipping_info_submitted",
      "checkout_started",
      "payment_info_submitted",
    ]);
  });

  it("shares the storefront distinct_id and session id via the ph_<key>_posthog cookie", async () => {
    const { handlers, calls } = load({ cookie: storefrontCookie("did-abc", "sid-xyz") });
    handlers.checkout_started(CHECKOUT);
    await flush();
    expect(calls.cookieNames).toEqual([`ph_${KEY}_posthog`]);
    expect(calls.init).toHaveLength(1);
    const { key, cfg } = calls.init[0];
    expect(key).toBe(KEY);
    expect(cfg.api_host).toBe("https://us.i.posthog.com");
    expect(cfg.bootstrap).toEqual({ distinctID: "did-abc", sessionID: "sid-xyz" });
    expect(cfg.persistence).toBe("memory");
    expect(cfg.disable_session_recording).toBe(true);
    expect(cfg.capture_pageview).toBe(false);
    expect(cfg.autocapture).toBe(false);
  });

  it("initialises once however many events arrive", async () => {
    const { handlers, calls } = load({ cookie: storefrontCookie("d", "s") });
    handlers.checkout_started(CHECKOUT);
    handlers.checkout_contact_info_submitted(CHECKOUT);
    handlers.payment_info_submitted(CHECKOUT);
    await flush();
    expect(calls.init).toHaveLength(1);
    expect(calls.capture.map((c) => c.name)).toEqual(["checkout_started", "checkout_contact_info_submitted", "payment_info_submitted"]);
  });

  it("checkout_completed carries order total, currency and order id — and nothing personal", async () => {
    const { handlers, calls } = load({ cookie: storefrontCookie("d", "s") });
    handlers.checkout_completed(CHECKOUT);
    await flush();
    const p = calls.capture[0].props;
    expect(calls.capture[0].name).toBe("checkout_completed");
    expect(p.total).toBe(1099);
    expect(p.revenue).toBe(1099);
    expect(p.currency).toBe("ZAR");
    expect(p.subtotal).toBe(1000);
    expect(p.shipping).toBe(99);
    expect(p.order_id).toBe("gid://shopify/Order/123");
    expect(p.item_count).toBe(3);
    expect(p.handles).toEqual(["red-tab-denim-high-top", "acid-wash-tee"]);
    expect(p.$current_url).toBe("https://marathonclub.co.za/checkouts/cn/abc/information");
    expect(JSON.stringify(p)).not.toContain("shopper@example.com");
  });

  it("no cookie, a malformed cookie, or no cookie access → empty bootstrap, event still sent", async () => {
    for (const opts of [{ cookie: null }, { cookie: "%7Bnot-json" }, { cookieThrows: true }]) {
      const { handlers, calls } = load(opts);
      handlers.checkout_started(CHECKOUT);
      await flush();
      expect(calls.init[0].cfg.bootstrap).toEqual({});
      expect(calls.capture).toHaveLength(1);
    }
  });

  it("checkout_completed is sent once per order, even across a reload (new sandbox, same storage)", async () => {
    const store = new Map();
    const first = load({ cookie: storefrontCookie("d", "s"), store });
    first.handlers.checkout_completed(CHECKOUT);
    first.handlers.checkout_completed(CHECKOUT);
    await flush();
    const reload = load({ cookie: storefrontCookie("d", "s"), store });
    reload.handlers.checkout_completed(CHECKOUT);
    await flush();
    expect(first.calls.capture.filter((c) => c.name === "checkout_completed")).toHaveLength(1);
    expect(reload.calls.capture).toHaveLength(0);
    const other = { ...CHECKOUT, data: { checkout: { ...CHECKOUT.data.checkout, order: { id: "gid://shopify/Order/456" } } } };
    reload.handlers.checkout_completed(other);
    await flush();
    expect(reload.calls.capture).toHaveLength(1);
  });

  it("checkout_completed without an order id dedupes on the checkout token", async () => {
    const store = new Map();
    const noOrder = { ...CHECKOUT, data: { checkout: { ...CHECKOUT.data.checkout, order: null } } };
    const a = load({ store });
    a.handlers.checkout_completed(noOrder);
    await flush();
    const b = load({ store });
    b.handlers.checkout_completed(noOrder);
    await flush();
    expect(a.calls.capture).toHaveLength(1);
    expect(b.calls.capture).toHaveLength(0);
    expect([...store.keys()]).toEqual(["ph_checkout_completed_tok-1"]);
  });

  it("the persistent marker is written only after capture() succeeds — a failed send stays sendable", async () => {
    const store = new Map();
    const broken = load({ store, captureThrows: true });
    broken.handlers.checkout_completed(CHECKOUT);
    await flush();
    expect(store.size).toBe(0);
    const retry = load({ store });
    retry.handlers.checkout_completed(CHECKOUT);
    await flush();
    expect(retry.calls.capture).toHaveLength(1);
    expect(store.get("ph_checkout_completed_gid://shopify/Order/123")).toBe("1");
  });

  it("checkout_completed is still sent when storage is unavailable", async () => {
    const { handlers, calls } = load({ cookie: storefrontCookie("d", "s"), storageThrows: true });
    handlers.checkout_completed(CHECKOUT);
    await flush();
    expect(calls.capture).toHaveLength(1);
  });

  it("an event with no checkout payload does not throw", async () => {
    const { handlers, calls } = load();
    handlers.checkout_started({});
    await flush();
    expect(calls.capture[0].props.total).toBe(null);
    expect(calls.capture[0].props.item_count).toBe(0);
  });
});
