// ─── Marathon Club — PostHog checkout pixel ─────────────────────────────────
// Paste this WHOLE file into Shopify admin → Settings → Customer events →
// Add custom pixel. Steps and troubleshooting: theme/POSTHOG-SETUP.md.
//
// WHY A PIXEL: checkout pages are Shopify's, not the theme's. theme.liquid
// never renders there, so the storefront snippet cannot see checkout. Shopify's
// Customer Events run this code in a sandbox on every checkout step and hand it
// the standard checkout events, which are forwarded to the SAME PostHog project
// the storefront uses (us.i.posthog.com, public key below — send-only).
//
// ONE PERSON, ONE SESSION ACROSS STOREFRONT AND CHECKOUT: the storefront's
// posthog-js keeps its identity in the first-party cookie
// `ph_<key>_posthog` = encodeURIComponent(JSON) with `distinct_id` and
// `$sesid` = [lastActivityTs, sessionId, sessionStartTs]. Checkout is on the
// same domain, and the sandbox can read that cookie through the Web Pixels API
// (`browser.cookie.get`). posthog-js here is bootstrapped with that
// distinct_id and session id and kept in memory only, so the sandbox never
// mints a second visitor and checkout events land in the shopper's existing
// funnel and session replay. No cookie (blocked, first visit straight into
// checkout) → posthog-js makes its own anonymous id; the event still counts.
//
// NO SHOPPER DETAILS IN THE PROPERTIES: no email, name, phone or address —
// only amounts, currency, item counts, product handles and the order id. The
// page URL is sent without its query string or hash (order-status links carry
// a ?key=). PostHog itself still sees the request IP, as for any page view.
//
// checkout_completed IS SENT ONCE PER ORDER: Shopify can fire it again on a
// thank-you reload. The order id is remembered in the sandbox's
// browser.localStorage (Web Pixels API) and a repeat is dropped.

const POSTHOG_KEY = "phc_AF6N3oHUSnSVfKqKxKDVvYgZKkmd3cY244Ww6qo334hP";
const POSTHOG_HOST = "https://us.i.posthog.com";
const COOKIE = "ph_" + POSTHOG_KEY + "_posthog";

// PostHog's official loader, unmodified.
!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],Object.defineProperty(u,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e}}),Object.defineProperty(u.people,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(){return u.toString(1)+".people (stub)"}}),o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

// ── identity from the storefront cookie ──────────────────────────────────────
function readStorefrontIdentity(raw) {
  if (!raw) return {};
  try {
    const ph = JSON.parse(decodeURIComponent(raw));
    const out = {};
    if (ph && typeof ph.distinct_id === "string" && ph.distinct_id) out.distinctID = ph.distinct_id;
    if (ph && Array.isArray(ph.$sesid) && typeof ph.$sesid[1] === "string" && ph.$sesid[1]) out.sessionID = ph.$sesid[1];
    return out;
  } catch (e) {
    return {};
  }
}

let ready = null;
function boot() {
  if (ready) return ready;
  ready = (async () => {
    let raw = null;
    try { raw = await browser.cookie.get(COOKIE); } catch (e) { /* sandbox without cookie access */ }
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      defaults: "2026-08-30",
      person_profiles: "identified_only",
      persistence: "memory",
      bootstrap: readStorefrontIdentity(raw),
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
    });
    return posthog;
  })();
  return ready;
}

// ── event properties ─────────────────────────────────────────────────────────
function money(m) {
  if (!m || m.amount == null) return null;
  const n = Number(m.amount);
  return isNaN(n) ? null : n;
}
function handleOf(url) {
  const m = /\/products\/([^/?#]+)/.exec(url || "");
  return m ? decodeURIComponent(m[1]) : null;
}
function checkoutProps(event) {
  const c = (event && event.data && event.data.checkout) || {};
  const lines = Array.isArray(c.lineItems) ? c.lineItems : [];
  const loc = event && event.context && event.context.document && event.context.document.location;
  const props = {
    checkout_token: c.token || null,
    total: money(c.totalPrice),
    subtotal: money(c.subtotalPrice),
    shipping: c.shippingLine ? money(c.shippingLine.price) : null,
    currency: (c.totalPrice && c.totalPrice.currencyCode) || c.currencyCode || null,
    item_count: lines.reduce(function (n, l) { return n + (l.quantity || 0); }, 0),
    line_count: lines.length,
    handles: lines.map(function (l) {
      return l && l.variant && l.variant.product ? handleOf(l.variant.product.url) : null;
    }),
    shopify_event_id: (event && event.id) || null,
    source: "checkout_pixel",
  };
  // The sandbox's own URL is meaningless; report the checkout page the shopper
  // is on — origin + path only.
  if (loc && loc.href) {
    props.$current_url = String(loc.href).split(/[?#]/)[0];
    props.$pathname = loc.pathname || null;
    props.$host = loc.host || null;
  }
  return props;
}

// Shopify standard event name → PostHog event name (same names, on purpose).
const EVENTS = [
  "checkout_started",
  "checkout_contact_info_submitted",
  "checkout_address_info_submitted",
  "checkout_shipping_info_submitted",
  "payment_info_submitted",
  "checkout_completed",
];

// In-memory first (synchronous): two deliveries in the same sandbox would
// otherwise both read "not seen" before either write lands. Storage then
// covers a reload, which is a fresh sandbox.
const sentOrders = new Set();
async function firstTimeForOrder(orderId) {
  if (!orderId) return true;
  if (sentOrders.has(orderId)) return false;
  sentOrders.add(orderId);
  const key = "ph_checkout_completed_" + orderId;
  try {
    if (await browser.localStorage.getItem(key)) return false;
    await browser.localStorage.setItem(key, "1");
  } catch (e) { /* no storage: send rather than lose the order */ }
  return true;
}

EVENTS.forEach(function (name) {
  analytics.subscribe(name, function (event) {
    const props = checkoutProps(event);
    let gate = Promise.resolve(true);
    if (name === "checkout_completed") {
      const c = (event && event.data && event.data.checkout) || {};
      props.order_id = (c.order && c.order.id) || null;
      props.revenue = props.total;
      gate = firstTimeForOrder(props.order_id);
    }
    gate
      .then(function (send) { return send ? boot().then(function (ph) { ph.capture(name, props); }) : null; })
      .catch(function () { /* never break checkout */ });
  });
});
