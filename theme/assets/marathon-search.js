/* ─── MARATHON SEARCH ─────────────────────────────────────────────────────────
 * The storefront's search box must not use Shopify's search.
 *
 * Every brand, sub-label and silhouette term is stripped from a product before
 * it is pushed, so the words a shopper types are exactly the words the Shopify
 * catalogue does not contain. Measured on the live shop, 2026-08-17:
 *
 *     "gripshot"  →  Shopify: "No results"        ours: 12 correct products
 *     "adidas"    →  Shopify: unrelated sneakers  ours: 34 correct products
 *     "adizero"   →  Shopify: nothing useful      ours: 3 of 3
 *
 * This replaces the results on /search with the answer from the app's own
 * index, which matches on the TRUE product names and returns Shopify handles.
 *
 * WRITTEN AGAINST THE REAL MARKUP of the live theme (a Dawn derivative,
 * "Feather"): #ProductGridContainer, #product-grid, .template-search__results.
 * Every hook is looked up defensively and the script does nothing at all if the
 * page is not a search page — a theme update that renames a container degrades
 * to Shopify's own results rather than an empty screen.
 *
 * THE QUERY IS NEVER PRINTED BACK. No "results for X" heading is rendered, and
 * any the theme already produced is removed. (Owner spec.)
 */
(function () {
  "use strict";

  var ENDPOINT = "https://europe-west1-marathon-club.cloudfunctions.net/storefrontSearch";
  var LIMIT = 48;

  function q() {
    var m = /[?&]q=([^&]*)/.exec(window.location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, " ")).trim() : "";
  }
  function onSearchPage() {
    return /^\/search\b/.test(window.location.pathname);
  }
  function money(cents, currency) {
    var v = (Number(cents) || 0) / 100;
    try {
      return new Intl.NumberFormat(document.documentElement.lang || "en-ZA",
        { style: "currency", currency: currency || "ZAR" }).format(v);
    } catch (e) { return "R " + v.toFixed(2); }
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // One result card. Dawn's own class names, so it inherits the theme's grid,
  // typography and hover treatment rather than looking bolted on.
  function card(r) {
    var sizes = (r.sizes || []).filter(function (s) { return s.available; })
      .map(function (s) { return s.size; });
    var soldOut = !r.inStock;
    return '' +
      '<li class="grid__item">' +
        '<div class="card-wrapper product-card-wrapper underline-links-hover">' +
          '<div class="card card--standard card--media">' +
            '<div class="card__inner color-background-2 gradient ratio" style="--ratio-percent:125%;">' +
              '<div class="card__media">' +
                '<div class="media media--transparent media--hover-effect">' +
                  (r.image
                    ? '<img src="' + esc(r.image) + '" alt="" loading="lazy" class="motion-reduce" ' +
                      'style="width:100%;height:100%;object-fit:cover;">'
                    : '<div style="width:100%;height:100%;"></div>') +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div class="card__content">' +
              '<div class="card__information">' +
                '<h3 class="card__heading h5">' +
                  '<a href="/products/' + esc(r.handle) + '" class="full-unstyled-link">' + esc(r.title) + '</a>' +
                '</h3>' +
                '<div class="card-information">' +
                  '<span class="price"><span class="price-item price-item--regular">' +
                    money(r.price, r.currency) +
                  '</span></span>' +
                  (soldOut
                    ? '<span class="ms-soldout">Sold out</span>'
                    : (sizes.length ? '<span class="ms-sizes">' + esc(sizes.join(" · ")) + '</span>' : '')) +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</li>';
  }

  // The theme prints its own count and, on some templates, the search term.
  // Remove anything that echoes the query — the spec is that the term never
  // appears on screen.
  //
  // SCOPED TO #MainContent, NOT the grid container. Tested on the live
  // storefront: the empty-state sentence ("No results found for “gripshot”…")
  // is a sibling of the grid container, so scoping to the container missed it
  // entirely and the term stayed on screen. (2026-08-17.)
  function stripQueryEcho(root, term) {
    if (!term) return;
    var needle = term.toLowerCase();
    var nodes = root.querySelectorAll("h1,h2,h3,p,span,div");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.children.length) continue;              // leaf text only
      var t = (el.textContent || "").toLowerCase();
      if (!t) continue;
      if (t.indexOf(needle) !== -1 && /result|search|found|match/.test(t)) {
        el.textContent = "";
      }
    }
  }

  function grid() {
    return document.getElementById("product-grid") ||
      document.querySelector("#ProductGridContainer ul") ||
      document.querySelector(".template-search__results ul");
  }

  // The EMPTY-STATE template ships the <ul> without the grid classes, because
  // it never expects to hold anything. Dropping 12 cards into it rendered a
  // 5,000px single column of unstyled items — they were there, and unusable.
  // Re-applying the theme's own grid classes is what makes our results look
  // like the theme's. (Found by testing on the live storefront, 2026-08-17.)
  var GRID_CLASSES = ["grid", "product-grid", "grid--2-col-tablet-down", "grid--4-col-desktop"];
  function ensureGridLayout(ul) {
    for (var i = 0; i < GRID_CLASSES.length; i++) ul.classList.add(GRID_CLASSES[i]);
    var wrap = ul.closest(".template-search__results") || ul.parentNode;
    if (wrap && !wrap.classList.contains("page-width")) wrap.classList.add("page-width");
  }

  function render(results, term) {
    var ul = grid();
    if (!ul) return false;
    // The echo lives OUTSIDE the grid container — scope the strip to the whole
    // content area or it is missed.
    var scope = document.getElementById("MainContent") || document.body;
    // Anything we added on a previous run (the modal re-renders in place).
    var old = document.querySelectorAll(".ms-count, .ms-empty");
    for (var k = 0; k < old.length; k++) old[k].parentNode.removeChild(old[k]);

    if (!results.length) {
      ul.innerHTML = "";
      var empty = document.createElement("p");
      empty.className = "ms-empty";
      // Deliberately does not repeat what was typed.
      empty.textContent = "Nothing matched that. Try a brand, a model or a colour.";
      ul.parentNode.insertBefore(empty, ul);
    } else {
      ul.innerHTML = results.map(card).join("");
      ensureGridLayout(ul);
    }
    stripQueryEcho(scope, term);
    // THE TAB TITLE ECHOES IT TOO. Shopify renders
    // `Search: 0 results found for "gripshot"` server-side, so it survives
    // everything done to the DOM and shows in the tab, in history, and in a
    // shared link. Caught by testing, not by reading the template.
    if (/results? found for|search:/i.test(document.title)) document.title = "Search results";
    // The count is safe — it names no term.
    var count = document.createElement("p");
    count.className = "ms-count";
    count.textContent = results.length
      ? results.length + (results.length === 1 ? " product" : " products")
      : "";
    if (results.length) ul.parentNode.insertBefore(count, ul);
    return true;
  }

  function styles() {
    if (document.getElementById("ms-style")) return;
    var s = document.createElement("style");
    s.id = "ms-style";
    s.textContent =
      ".ms-sizes{display:block;font-size:.78rem;opacity:.65;margin-top:.25rem;letter-spacing:.02em}" +
      ".ms-soldout{display:block;font-size:.78rem;opacity:.6;margin-top:.25rem;text-transform:uppercase;letter-spacing:.06em}" +
      ".ms-count{font-size:.85rem;opacity:.6;margin:0 0 1rem}" +
      ".ms-empty{margin:2rem 0;opacity:.75}" +
      ".ms-loading{opacity:.5}";
    document.head.appendChild(s);
  }

  function run() {
    if (!onSearchPage()) return;
    var term = q();
    if (!term) return;
    styles();
    var ul = grid();
    if (ul) ul.classList.add("ms-loading");

    fetch(ENDPOINT + "?q=" + encodeURIComponent(term) + "&limit=" + LIMIT, {
      headers: { Accept: "application/json" },
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (ul) ul.classList.remove("ms-loading");
        render(data.results || [], term);
      })
      .catch(function (err) {
        // FAIL SOFT. If our endpoint is unreachable the shopper keeps whatever
        // Shopify rendered — worse results, but a working page. Never a blank
        // screen because a Cloud Function had a cold start.
        if (ul) ul.classList.remove("ms-loading");
        if (window.console) console.warn("[marathon-search] falling back to the theme's own results:", err.message);
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
  // The theme's search modal and its filter controls swap the grid via fetch.
  // Re-run after any of those so our results are not replaced by Shopify's.
  document.addEventListener("shopify:section:load", run);
  window.addEventListener("popstate", run);
})();
