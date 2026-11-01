/* PostHog events from the theme's OWN product page (Dawn's main-product).
 *
 * The product page does not run through marathon-storefront.js; its size
 * picker and Add to cart are Dawn's product-info.js and product-form.js, and
 * both announce what they did on the theme's pub/sub bus (pubsub.js +
 * constants.js, loaded earlier in <head>). Listening there means these events
 * fire from the real code path and only on success:
 *
 *   size_selected  PUB_SUB_EVENTS.variantChange — published by product-info.js
 *                  after the shopper picks an option and the variant resolves.
 *   add_to_cart    PUB_SUB_EVENTS.cartUpdate with source "product-form" —
 *                  published by product-form.js only when /cart/add returned
 *                  a line item (an error publishes cartError instead). Other
 *                  cartUpdate sources (quantity changes on /cart) are ignored.
 *
 * product_viewed for this page is sent from snippets/posthog.liquid, where the
 * Liquid product object is available. Everything goes through
 * window.MarathonAnalytics, which does not exist when PostHog was skipped, so
 * this file is a no-op then. */
(function () {
  if (typeof subscribe !== "function" || typeof PUB_SUB_EVENTS === "undefined") return;

  function ma() { return window.MarathonAnalytics; }

  subscribe(PUB_SUB_EVENTS.variantChange, function (event) {
    var a = ma();
    var data = event && event.data;
    var v = data && data.variant;
    if (!a || !v) return;
    var handle = null;
    var m = /\/products\/([^/?#]+)/.exec(location.pathname);
    if (m) handle = decodeURIComponent(m[1]);
    a.track("size_selected", {
      handle: handle,
      variant: v.title || null,
      variant_id: v.id || null,
      size: v.option1 || v.title || null,
      available: !!v.available,
      price: v.price != null ? v.price / 100 : null,
      source: "product_page",
    });
  });

  subscribe(PUB_SUB_EVENTS.cartUpdate, function (event) {
    var a = ma();
    if (!a || !event || event.source !== "product-form" || !event.cartData) return;
    // /cart/add with a single form returns the added line item itself.
    var item = event.cartData.items ? event.cartData.items[0] : event.cartData;
    if (!item || !item.variant_id) return;
    a.track("add_to_cart", a.cartItem(item, "product_page"));
  });
})();
