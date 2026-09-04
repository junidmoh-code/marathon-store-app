/* ── ESCAPING THE IN-APP BROWSER ──────────────────────────────────────────────
 * 99% of paid-ad spend on this store reaches a phone, and an ad tapped inside
 * Facebook or Instagram opens in THEIR in-app browser, not in Safari or
 * Chrome. That browser starts with no cookies, no saved logins and no
 * autofill, and it has to survive a round trip to payment.payfast.io and back
 * — the store's only payment method is an off-site redirect. One real order
 * already recorded `https://payment.payfast.io/` as its own REFERRING SITE,
 * which is what a lost session looks like from the outside.
 *
 * Between add_payment_info and purchase this store loses 79–88% of people on
 * its GOOD days. This file is the cheapest available lever on that number: it
 * offers the shopper a way into their real browser before they get to the
 * payment hand-off.
 *
 * ── WHAT IT CAN AND CANNOT DO, HONESTLY ─────────────────────────────────────
 * ANDROID: it can actually move them. An `intent://` URL hands the page to
 * Chrome, and Facebook's WebView honours it. This is a working button.
 *
 * iOS: it CANNOT. A WKWebView has no API to hand a page to Safari, and the
 * `x-safari-` scheme Apple once tolerated is blocked. On iOS this is an
 * INSTRUCTION plus a copy-link button, nothing more. Any claim that a button
 * "opens Safari" on iOS is false, and the copy on the panel says so.
 *
 * ── WHY THE DETECTION LIVES IN ITS OWN FILE ─────────────────────────────────
 * So it can be tested as the artifact that actually ships, rather than as a
 * copy of it in a test file that can drift. marathon-inapp.test.mjs reads THIS
 * file and evaluates it.
 */
(function (global) {
  "use strict";

  // Tokens that identify an embedded WebView we want to offer an exit from.
  //   FBAN / FBAV / FB_IAB — Facebook's app family
  //   Instagram            — the Instagram app
  //   Line / MicroMessenger/ KAKAOTALK — other in-app browsers seen on ZA traffic
  // Deliberately NOT included: "wv" alone. Plenty of legitimate Android
  // browsers set it, and a false positive shows a confusing panel to somebody
  // who is already in Chrome.
  var IN_APP_TOKENS = [
    "FBAN",
    "FBAV",
    "FB_IAB",
    "FBIOS",
    "Instagram",
    "MicroMessenger",
    "Line/",
    "KAKAOTALK",
  ];

  /**
   * Is this user agent an in-app browser we can help?
   * Pure, so it is testable without a DOM.
   */
  function isInAppBrowser(ua) {
    if (!ua || typeof ua !== "string") return false;
    for (var i = 0; i < IN_APP_TOKENS.length; i++) {
      if (ua.indexOf(IN_APP_TOKENS[i]) !== -1) return true;
    }
    return false;
  }

  /** Which app, for the attribute we hang on the cart. */
  function inAppSource(ua) {
    if (!isInAppBrowser(ua)) return "standard";
    if (ua.indexOf("Instagram") !== -1) return "instagram";
    if (ua.indexOf("FBAN") !== -1 || ua.indexOf("FBAV") !== -1 || ua.indexOf("FB_IAB") !== -1 || ua.indexOf("FBIOS") !== -1) {
      return "facebook";
    }
    return "other-inapp";
  }

  /**
   * iOS cannot be handed to Safari; Android can be handed to Chrome.
   * Returns "ios" | "android" | "other".
   */
  function platform(ua) {
    if (!ua || typeof ua !== "string") return "other";
    if (/iPhone|iPad|iPod/.test(ua)) return "ios";
    if (/Android/.test(ua)) return "android";
    return "other";
  }

  /**
   * The Android hand-off URL. Chrome is named explicitly, because an
   * unqualified intent:// in a WebView often resolves back to the same
   * WebView and changes nothing.
   */
  function androidIntentUrl(href) {
    var stripped = String(href || "").replace(/^https?:\/\//, "");
    return (
      "intent://" +
      stripped +
      "#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=" +
      encodeURIComponent(href) +
      ";end"
    );
  }

  /**
   * A line a cart permalink cannot faithfully carry.
   *
   * A permalink is only <variantId>:<qty>. It cannot express line item
   * PROPERTIES (engraving, a gift note, a size chart choice) and it cannot
   * express a SELLING PLAN (subscription / try-before-you-buy). Handing over a
   * basket that silently drops either one is worse than not handing it over:
   * the shopper arrives with something that looks right, buys it, and gets the
   * wrong thing.
   */
  function lineIsPermalinkSafe(item) {
    if (!item) return false;
    if (item.selling_plan_allocation) return false;
    var p = item.properties;
    if (p && typeof p === "object" && Object.keys(p).length > 0) return false;
    return true;
  }

  /**
   * The hand-off URL: a CART PERMALINK carrying the attribution with it.
   *
   * Two things were proved by driving the live store before this was written:
   *   1. /cart/<id>:<qty> does NOT land on the cart page — Shopify forwards it
   *      straight to checkout. The destination browser therefore never runs
   *      this script, so anything worth recording has to travel IN the URL.
   *   2. ?attributes[k]=v on that permalink DOES attach to the destination
   *      cart and persists (read back from /cart.js afterwards, from a page
   *      that does not render the snippet).
   *
   * Without this the escaped shopper arrives with a new cookie, a new cart and
   * no attribution: their order comes back `unstamped` and the measurement
   * quietly reads zero.
   */
  function handoffUrl(origin, items, source) {
    var list = items || [];
    // Suppress the whole hand-off rather than move a basket we would corrupt.
    for (var n = 0; n < list.length; n++) {
      if (!lineIsPermalinkSafe(list[n])) return null;
    }
    var parts = list
      .filter(function (i) { return i && i.id && i.quantity; })
      .map(function (i) { return i.id + ":" + i.quantity; });
    if (!parts.length) return null;
    return (
      origin +
      "/cart/" +
      parts.join(",") +
      "?attributes[browser]=" + encodeURIComponent(source) +
      "&attributes[escaped]=" + encodeURIComponent("arrived-from-" + source)
    );
  }

  /**
   * An arrival stamp must never be overwritten by a later default stamp.
   * Observed live: loading /cart in the destination browser replaced
   * {browser: facebook, escaped: arrived-from-facebook} with
   * {browser: standard, escaped: no}, erasing the only evidence the hand-off
   * had worked.
   */
  function isArrivalStamp(escaped) {
    return typeof escaped === "string" && escaped.indexOf("arrived-from") === 0;
  }

  /**
   * Should the default `escaped: "no"` stamp be written at all?
   *
   * Only when nothing has been recorded yet. The first version guarded only
   * ARRIVALS, which meant a shopper who tapped "Open in Chrome"
   * (`tapped-android-chrome`) or copied the link (`copied-link`) and then came
   * back to /cart — a quantity change, a reload, the back button — had that
   * engagement overwritten with "no". Those are exactly the events the funnel
   * report counts, so the measurement would have erased its own signal.
   */
  function shouldWriteDefaultStamp(escaped) {
    return escaped === undefined || escaped === null || escaped === "";
  }

  var api = {
    isInAppBrowser: isInAppBrowser,
    inAppSource: inAppSource,
    platform: platform,
    androidIntentUrl: androidIntentUrl,
    handoffUrl: handoffUrl,
    isArrivalStamp: isArrivalStamp,
    shouldWriteDefaultStamp: shouldWriteDefaultStamp,
    lineIsPermalinkSafe: lineIsPermalinkSafe,
    IN_APP_TOKENS: IN_APP_TOKENS,
  };

  global.MarathonInApp = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
