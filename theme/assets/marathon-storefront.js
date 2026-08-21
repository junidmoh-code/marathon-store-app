/* ─── MARATHON STOREFRONT — quick view, in the grid ────────────────────────────
 *
 * Tap a photograph: price, condition and sizes appear over it, and the address
 * bar becomes that product's real URL. Tap again: it closes and the address bar
 * goes back. Pick a size, add to cart, keep browsing — the page never navigates.
 *
 * ── THE ADDRESS BAR IS NOT DECORATION ────────────────────────────────────────
 * The URL pushed is `{{ product.url }}` as Liquid rendered it, and there is a
 * real, server-rendered product page at that address. So:
 *   • copying the URL out of the bar shares the product, not the grid;
 *   • pasting it back loads the full product page directly;
 *   • Back closes the panel instead of leaving the shop;
 *   • crawlers never see any of this — they follow the plain <a href> the panel
 *     is layered on top of, and index the real page.
 * If product pages stopped existing at their own URLs the shop would fall out
 * of search entirely, so the enhancement is built ON a working link rather than
 * in place of one.
 *
 * ── PROGRESSIVE ENHANCEMENT, MEANT LITERALLY ─────────────────────────────────
 * Every panel is already in the HTML, hidden, rendered by Liquid from
 * `product.variants`. This file only un-hides it. With JavaScript off, or
 * broken, or still loading, every card is a link to a product page and nothing
 * is lost but the convenience. Nothing here fetches product data — see
 * snippets/marathon-card.liquid for why that matters for sold-out sizes.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
 * It does not touch /search. marathon-search.js owns that page and must keep
 * working exactly as it does; the two files share no selectors.
 */
(function () {
  "use strict";

  var OPEN_CLASS = "is-open";
  var listUrl = window.location.pathname + window.location.search;
  var listTitle = document.title;
  var openCard = null;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // ── open / close ───────────────────────────────────────────────────────────
  // HISTORY DISCIPLINE. The stack must never end up holding a product URL with
  // nothing open, and must never grow one entry per tap. So there is at most
  // ONE of our entries on the stack at a time:
  //
  //   closed -> open        pushState(product)      one entry added
  //   open A -> open B      replaceState(product)   the entry is rewritten
  //   open   -> closed      history.back()          the entry is removed
  //
  // Without this, opening A then B then closing would land Back on A's URL with
  // no panel open — the address bar claiming a product the shopper is not
  // looking at — and Back out of the shop would take one press per photo tapped.
  function setUrl(url, title, replace) {
    try {
      history[replace ? "replaceState" : "pushState"]({ mc: true }, "", url);
      if (title) document.title = title;
    } catch (e) { /* history is a nicety; never let it break open/close */ }
  }

  function close(useHistory) {
    if (!openCard) return;
    var panel = $("[data-mc-panel]", openCard);
    if (panel) panel.hidden = true;
    openCard.classList.remove(OPEN_CLASS);
    openCard = null;
    if (!useHistory) return;
    document.title = listTitle;
    try {
      // Ours to pop? Then pop it, so the stack returns to exactly where it was.
      if (history.state && history.state.mc) history.back();
      else history.replaceState({ mc: false }, "", listUrl);
    } catch (e) { /* as above */ }
  }

  function open(card) {
    if (openCard === card) { close(true); return; }
    var replacing = openCard !== null;   // moving between cards rewrites, never stacks
    close(false);
    var panel = $("[data-mc-panel]", card);
    if (!panel) return;
    panel.hidden = false;
    card.classList.add(OPEN_CLASS);
    openCard = card;

    var url = card.getAttribute("data-mc-url");
    if (url) setUrl(url, card.getAttribute("data-mc-title"), replacing);

    // A panel the shopper never sees is a panel that did not open. A card can
    // be out of view VERTICALLY on the browsing grid and HORIZONTALLY in a home
    // rail, which is a sideways scroller — so both axes are checked.
    var rect = card.getBoundingClientRect();
    var offScreen =
      rect.top < 0 || rect.bottom > window.innerHeight ||
      rect.left < 0 || rect.right > window.innerWidth;
    if (offScreen) {
      card.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    }
    var closeBtn = $("[data-mc-close]", panel);
    if (closeBtn) closeBtn.focus({ preventScroll: true });
  }

  // ── clicks ─────────────────────────────────────────────────────────────────
  document.addEventListener("click", function (ev) {
    // A modified click is the shopper asking for a new tab. Never swallow it —
    // and never swallow anything but a plain left click.
    if (ev.defaultPrevented || ev.button !== 0) return;
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;

    var target = ev.target;

    var opener = target.closest && target.closest("[data-mc-open]");
    if (opener) {
      var card = opener.closest("[data-mc-card]");
      if (card) { ev.preventDefault(); open(card); return; }
    }

    if (target.closest && target.closest("[data-mc-close]")) {
      ev.preventDefault();
      close(true);
      return;
    }

    var size = target.closest && target.closest("[data-mc-size]");
    if (size) {
      ev.preventDefault();
      // A disabled button does not fire a click in most browsers, but a click
      // can still land on a child <span> inside one — so this is checked rather
      // than assumed. A sold-out size must never become selectable.
      if (size.hasAttribute("disabled")) return;
      selectSize(size);
      return;
    }

    var add = target.closest && target.closest("[data-mc-add]");
    if (add) { ev.preventDefault(); addToCart(add); return; }

    // A click anywhere outside an open card closes it.
    if (openCard && !(target.closest && target.closest("[data-mc-card]"))) close(true);
  });

  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && openCard) close(true);
  });

  // Back/forward: the panel state is the history state, so honour it.
  window.addEventListener("popstate", function () {
    close(false);
    document.title = listTitle;
  });

  // ── size selection ─────────────────────────────────────────────────────────
  function selectSize(btn) {
    var group = btn.parentNode;
    $$("[data-mc-size]", group).forEach(function (b) { b.setAttribute("aria-pressed", "false"); });
    btn.setAttribute("aria-pressed", "true");
    var panel = btn.closest("[data-mc-panel]");
    var status = $("[data-mc-status]", panel);
    if (status) { status.textContent = ""; status.className = "mc-panel__status"; }
  }

  function chosenVariantId(panel) {
    var single = $("[data-mc-single]", panel);
    if (single) return single.value;
    var picked = $('[data-mc-size][aria-pressed="true"]', panel);
    return picked ? picked.getAttribute("data-variant-id") : null;
  }

  // ── add to cart ────────────────────────────────────────────────────────────
  function addToCart(btn) {
    var panel = btn.closest("[data-mc-panel]");
    var status = $("[data-mc-status]", panel);
    var id = chosenVariantId(panel);

    function say(msg, isError) {
      if (!status) return;
      status.textContent = msg;
      status.className = "mc-panel__status" + (isError ? " mc-panel__status--error" : "");
    }

    if (!id) {
      // Not an error state — the shopper simply has not chosen yet.
      say("Pick a size first.", false);
      var first = $("[data-mc-size]:not([disabled])", panel);
      if (first) first.focus({ preventScroll: true });
      return;
    }

    btn.classList.add("is-busy");
    btn.disabled = true;
    say("Adding…", false);

    fetch(window.Shopify && window.Shopify.routes ? window.Shopify.routes.root + "cart/add.js" : "/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ items: [{ id: Number(id), quantity: 1 }] }),
    })
      .then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (r) {
        if (!r.ok) {
          // Shopify's own message is the useful one — it says "only 2 left"
          // rather than "failed", and a shopper can act on that.
          throw new Error((r.body && (r.body.description || r.body.message)) || "Could not add that.");
        }
        say("Added to cart.", false);
        refreshCartCount();
      })
      .catch(function (err) {
        say(String((err && err.message) || "Could not add that."), true);
      })
      .then(function () {
        btn.classList.remove("is-busy");
        btn.disabled = false;
      });
  }

  // The header's cart bubble is a Dawn section. Re-render just that section
  // rather than reloading the page — the whole point is not to leave the grid.
  // Entirely best-effort: a stale bubble is a cosmetic problem, and the item is
  // in the cart either way.
  function refreshCartCount() {
    fetch("/?sections=cart-icon-bubble")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var html = data && data["cart-icon-bubble"];
        if (!html) return;
        var host = document.getElementById("cart-icon-bubble");
        if (!host) return;
        var doc = new DOMParser().parseFromString(html, "text/html");
        var fresh = doc.getElementById("cart-icon-bubble");
        if (fresh) host.innerHTML = fresh.innerHTML;
      })
      .catch(function () { /* cosmetic only */ });
  }

  // ── category dropdowns ─────────────────────────────────────────────────────
  document.addEventListener("click", function (ev) {
    var toggle = ev.target.closest && ev.target.closest("[data-mc-navtoggle]");
    var openGroups = $$("[data-mc-navgroup].is-open");

    openGroups.forEach(function (g) {
      if (toggle && g.contains(toggle)) return;
      g.classList.remove("is-open");
      var p = $("[data-mc-navpanel]", g);
      if (p) p.hidden = true;
      var t = $("[data-mc-navtoggle]", g);
      if (t) t.setAttribute("aria-expanded", "false");
    });

    if (!toggle) return;
    ev.preventDefault();
    var group = toggle.closest("[data-mc-navgroup]");
    var panel = $("[data-mc-navpanel]", group);
    var nowOpen = !group.classList.contains("is-open");
    group.classList.toggle("is-open", nowOpen);
    if (panel) panel.hidden = !nowOpen;
    toggle.setAttribute("aria-expanded", nowOpen ? "true" : "false");
  });
})();
