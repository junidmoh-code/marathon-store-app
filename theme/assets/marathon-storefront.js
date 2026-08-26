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

  // BOTH sections that use this file emit their own <script src> tag, and both
  // declare presets — so the theme editor happily allows the photo grid on the
  // home page, or either section twice on one template. Two <script> elements
  // with the same src BOTH execute (the resource is cached; the element still
  // runs), which would give two click listeners, two popstate listeners and two
  // independent `openCard`: one tap would write history twice and one close
  // would fire two history.back() calls, walking the shopper out of the shop.
  if (window.__marathonStorefront) return;
  window.__marathonStorefront = true;

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
  // The URL travels IN the history state, not just in the address bar, so a
  // history entry can be turned back into an open panel. Without it, Back then
  // Forward lands on the product URL with the grid showing and nothing open —
  // the address bar claiming a product the shopper is not looking at, which is
  // the exact failure the history discipline above exists to prevent.
  function setUrl(url, title, replace) {
    try {
      history[replace ? "replaceState" : "pushState"]({ mc: true, url: url, title: title }, "", url);
      if (title) document.title = title;
    } catch (e) { /* history is a nicety; never let it break open/close */ }
  }

  function close(useHistory) {
    if (!openCard) return;
    // No drift correction is needed any more, and that is the point: the modal
    // never touched the gallery, so there is nothing to put back. The earlier
    // version expanded the tile into a full row and had to measure and undo the
    // ~130px shift that caused.
    var card = openCard;
    var panel = $("[data-mc-panel]", card);
    if (panel) panel.hidden = true;
    var sheet = panel && $("[data-mc-sheet]", panel);
    if (sheet) { sheet.style.transform = ""; sheet.classList.remove("is-dragging"); }
    card.classList.remove(OPEN_CLASS);
    openCard = null;
    unlockScroll();
    if (!useHistory) return;
    document.title = listTitle;
    try {
      // Ours to pop? Then pop it, so the stack returns to exactly where it was.
      if (history.state && history.state.mc) history.back();
      else history.replaceState({ mc: false }, "", listUrl);
    } catch (e) { /* as above */ }
  }

  // `silent` reopens a card because HISTORY said so (Forward, or a restored
  // entry). It must not write history back, or the entry it is restoring would
  // be rewritten by the act of restoring it.
  function open(card, silent) {
    if (!silent && openCard === card) { close(true); return; }
    var replacing = openCard !== null;   // moving between cards rewrites, never stacks
    close(false);
    var panel = $("[data-mc-panel]", card);
    if (!panel) return;
    panel.hidden = false;
    card.classList.add(OPEN_CLASS);
    openCard = card;

    // "Added to cart." from a previous visit to this card would otherwise still
    // be sitting there, telling the shopper they have done something they have
    // not done yet.
    var status = $("[data-mc-status]", panel);
    if (status) { status.textContent = ""; status.className = "mc-panel__status"; }

    var url = card.getAttribute("data-mc-url");
    if (url && !silent) setUrl(url, card.getAttribute("data-mc-title"), replacing);
    if (silent) {
      var t = card.getAttribute("data-mc-title");
      if (t) document.title = t;
    }

    // NO scrollIntoView. The panel is a modal centred in the viewport, so there
    // is nothing to scroll TO — and scrolling the gallery behind an overlay is
    // exactly how a shopper loses their place. The page does not move.
    lockScroll();
    var closeBtn = $("[data-mc-close]", panel);
    if (closeBtn) closeBtn.focus({ preventScroll: true });
  }

  // ── scroll lock ────────────────────────────────────────────────────────────
  // The gallery must not scroll behind the modal — on a phone that is how the
  // shopper's place gets lost. Position-fixing the body would itself jump the
  // page, so the scroll offset is captured, the body pinned at that offset, and
  // the offset restored on close.
  var lockedAt = 0;
  function lockScroll() {
    lockedAt = window.scrollY;
    document.body.style.position = "fixed";
    document.body.style.top = -lockedAt + "px";
    document.body.style.width = "100%";
  }
  function unlockScroll() {
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.width = "";
    window.scrollTo(0, lockedAt);
  }

  // ── swipe down to close ────────────────────────────────────────────────────
  // The gesture people already know from a photo library. Only a drag that
  // starts at the TOP of the sheet's own scroll counts, so dragging down while
  // reading a long size list scrolls the sheet instead of dismissing it.
  var dragY = null, dragSheet = null;
  document.addEventListener("touchstart", function (ev) {
    var sheet = ev.target.closest && ev.target.closest("[data-mc-sheet]");
    if (!sheet || sheet.scrollTop > 0) return;
    dragSheet = sheet;
    dragY = ev.touches[0].clientY;
  }, { passive: true });

  document.addEventListener("touchmove", function (ev) {
    if (!dragSheet || dragY === null) return;
    var dy = ev.touches[0].clientY - dragY;
    if (dy <= 0) return;
    dragSheet.classList.add("is-dragging");
    dragSheet.style.transform = "translateY(" + dy + "px)";
  }, { passive: true });

  document.addEventListener("touchend", function (ev) {
    if (!dragSheet) return;
    var dy = 0;
    var m = /translateY\((\d+(?:\.\d+)?)px\)/.exec(dragSheet.style.transform || "");
    if (m) dy = parseFloat(m[1]);
    dragSheet.classList.remove("is-dragging");
    if (dy > 90) {            // far enough to mean it
      close(true);
    } else {
      dragSheet.style.transform = "";   // springs back
    }
    dragSheet = null; dragY = null;
  }, { passive: true });

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

    // TAPPING THE BACKDROP CLOSES. The panel element IS the backdrop and the
    // content sits in a child sheet, so "outside" is a click that landed on the
    // panel but not inside the sheet.
    if (openCard) {
      var inPanel = target.closest && target.closest("[data-mc-panel]");
      if (inPanel && !(target.closest && target.closest("[data-mc-sheet]"))) { close(true); return; }
      if (!inPanel && !(target.closest && target.closest("[data-mc-card]"))) close(true);
    }
  });

  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && openCard) close(true);
  });

  // Back/forward: the panel state IS the history state, so honour it in both
  // directions. An entry we wrote reopens its card; anything else closes.
  window.addEventListener("popstate", function () {
    var st = history.state;
    if (st && st.mc && st.url) {
      var card = document.querySelector('[data-mc-card][data-mc-url="' + cssEscape(st.url) + '"]');
      if (card) { open(card, true); return; }
      // The card is not on this page — a different pagination page, say. Leave
      // the panel closed rather than pretending; the URL is a real product page
      // and reloading it works.
    }
    close(false);
    document.title = listTitle;
  });

  // Attribute-selector escaping for a product path. Handles are lowercase
  // alnum and hyphens (compliance.mjs buildHandle), so this only ever has to
  // survive the quote and backslash cases, but it is cheap to be exact.
  function cssEscape(v) {
    return String(v).replace(/(["\\])/g, "\\$1");
  }

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

  // Shopify prefixes every storefront path with the locale root on a
  // multi-locale shop ("/en-za/"). One helper so the cart call and the section
  // re-render can never disagree about it.
  function shopRoot() {
    return (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
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

    fetch(shopRoot() + "cart/add.js", {
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
    fetch(shopRoot() + "?sections=cart-icon-bubble")
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

  // ── density ────────────────────────────────────────────────────────────────
  // Two, three or four across. The choice is a per-browser convenience, so it
  // lives in localStorage — and every access is wrapped, because a private
  // window can THROW on the accessor rather than return null, which would take
  // the whole script down with it.
  var DENSITY_KEY = "mc-cols";

  function readDensity() {
    try {
      var v = parseInt(window.localStorage.getItem(DENSITY_KEY), 10);
      return v >= 2 && v <= 4 ? v : null;
    } catch (e) { return null; }
  }
  function writeDensity(n) {
    try { window.localStorage.setItem(DENSITY_KEY, String(n)); } catch (e) { /* fine */ }
  }

  function applyDensity(n) {
    $$("[data-mc-grid]").forEach(function (g) { g.style.setProperty("--mc-cols", String(n)); });
    $$("[data-mc-density] [data-mc-cols]").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-mc-cols") === String(n) ? "true" : "false");
    });
  }

  var saved = readDensity();
  if (saved) applyDensity(saved);

  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest && ev.target.closest("[data-mc-cols]");
    if (!btn) return;
    ev.preventDefault();
    var n = parseInt(btn.getAttribute("data-mc-cols"), 10);
    if (!(n >= 2 && n <= 4)) return;
    applyDensity(n);
    writeDensity(n);
  });

  // ── infinite scroll ────────────────────────────────────────────────────────
  // The server renders one page; this fetches the next as the shopper nears the
  // bottom and appends its cards. Images keep `loading="lazy"` exactly as the
  // server wrote them, so appending markup does not download anything until it
  // is nearly on screen.
  //
  // SCROLL POSITION IS THE WHOLE POINT. Being thrown back to the top after
  // looking at something is what makes people leave, so there are three
  // separate defences:
  //
  //   1. The quick view never navigates. Opening and closing a product is
  //      pushState only, so the page does not move at all — the panel opens
  //      where the shopper already is.
  //   2. `history.scrollRestoration = "manual"`. Browsers try to restore scroll
  //      on a back-navigation BEFORE the appended pages exist, land at a
  //      position that is now near the top of a much shorter document, and the
  //      shopper is thrown to the start. Taking it over is the only way to
  //      restore after the pages are back.
  //   3. Depth and offset are saved per URL. Coming back to a grid — from a
  //      product page, or via bfcache-less back — re-fetches the pages that were
  //      loaded, then restores the exact offset.
  var SCROLL_KEY = "mc-scroll";

  function gridState() {
    var grid = $("[data-mc-grid]");
    if (!grid) return null;
    return { grid: grid, key: window.location.pathname + window.location.search };
  }

  function saveScroll() {
    var st = gridState();
    if (!st) return;
    try {
      window.sessionStorage.setItem(SCROLL_KEY, JSON.stringify({
        key: st.key,
        y: window.scrollY,
        pages: pagesLoaded,
        at: Date.now(),
      }));
    } catch (e) { /* private window — the grid still works, it just forgets */ }
  }

  function readScroll() {
    try {
      var raw = window.sessionStorage.getItem(SCROLL_KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      // Ten minutes. Older than that and the shopper is starting a new visit,
      // not resuming one; dropping them mid-grid would be the confusing answer.
      if (!v || Date.now() - v.at > 600000) return null;
      return v;
    } catch (e) { return null; }
  }

  var pagesLoaded = 1;
  var loading = false;

  function moreEl() { return $("[data-mc-more]"); }

  /** Fetch the next page and append its cards. Resolves false when there is no more. */
  function loadNext() {
    var more = moreEl();
    if (!more || loading) return Promise.resolve(false);
    var link = $("[data-mc-next]", more);
    if (!link) return Promise.resolve(false);
    loading = true;
    more.classList.add("is-loading");
    return fetch(link.href, { headers: { "X-Requested-With": "fetch" } })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var grid = $("[data-mc-grid]");
        var incoming = doc.querySelector("[data-mc-grid]");
        if (!grid || !incoming) throw new Error("next page had no grid");
        // Move the cards across as-is. `loading="lazy"` came from the server and
        // is preserved, so nothing downloads until it is nearly in view.
        while (incoming.firstElementChild) grid.appendChild(incoming.firstElementChild);
        pagesLoaded++;

        // Swap in the next sentinel, or the end marker.
        var nextMore = doc.querySelector("[data-mc-more]");
        var end = doc.querySelector("[data-mc-end]");
        if (nextMore) more.replaceWith(nextMore);
        else if (end) more.replaceWith(end);
        else more.remove();
        return true;
      })
      .catch(function () {
        // Leave the link visible and clickable — a failed fetch degrades to the
        // ordinary "next page" anchor rather than a dead end.
        more.classList.remove("is-auto");
        return false;
      })
      .then(function (ok) {
        loading = false;
        var m = moreEl();
        if (m) m.classList.remove("is-loading");
        observe();
        return ok;
      });
  }

  // TWO TRIGGERS, NOT ONE. IntersectionObserver is the efficient one, but it is
  // not universally reliable — it did not fire at all for this sentinel inside a
  // framed viewport during testing, and a shopper whose browser does the same
  // would hit an infinite scroll that never loads. So a throttled scroll check
  // runs alongside it. Both call the same guarded loadNext(), which no-ops while
  // a fetch is in flight, so a double trigger costs nothing.
  var observer = null;
  var NEAR = 800;                            // start a screen early, so it feels seamless

  function nearBottom() {
    var more = moreEl();
    if (!more) return false;
    return more.getBoundingClientRect().top - window.innerHeight < NEAR;
  }

  function observe() {
    var more = moreEl();
    if (!more) return;                       // end of collection — nothing to watch
    more.classList.add("is-auto");           // hide the link; scrolling drives now
    if ("IntersectionObserver" in window) {
      if (observer) observer.disconnect();
      observer = new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; })) loadNext();
      }, { rootMargin: NEAR + "px 0px" });
      observer.observe(more);
    }
    // The belt: check once now in case the sentinel is already in range on a
    // short first page, and on every throttled scroll thereafter.
    if (nearBottom()) loadNext();
  }

  // A TIME THROTTLE, NOT requestAnimationFrame. rAF is the usual choice and it
  // is the wrong one here: it is throttled hard or suspended outright in
  // backgrounded and framed contexts, and during testing the scroll trigger
  // simply stopped firing after the first page because the callback never ran.
  // A timestamp cannot be suspended.
  var lastScrollCheck = 0;
  function onScroll() {
    var now = Date.now();
    if (now - lastScrollCheck < 150) return;
    lastScrollCheck = now;
    if (nearBottom()) loadNext();
  }

  // Restore depth and offset when returning to a grid we have seen.
  function restoreScroll() {
    var st = gridState();
    var saved = readScroll();
    if (!st || !saved || saved.key !== st.key || saved.pages <= 1) return;
    var want = Math.min(saved.pages, 20);    // bounded: 20 pages is far past any real scroll
    (function step() {
      if (pagesLoaded >= want) {
        window.scrollTo(0, saved.y);
        return;
      }
      loadNext().then(function (ok) { if (ok) step(); else window.scrollTo(0, saved.y); });
    })();
  }

  if ($("[data-mc-grid]")) {
    try { if ("scrollRestoration" in history) history.scrollRestoration = "manual"; } catch (e) {}
    observe();
    restoreScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    window.addEventListener("pagehide", saveScroll);
    window.addEventListener("beforeunload", saveScroll);
    // Also on every quick-view open: that is the moment before a shopper might
    // tap "View full details" and leave the grid entirely.
    document.addEventListener("click", function (ev) {
      if (ev.target.closest && ev.target.closest("[data-mc-open], .mc-panel__link")) saveScroll();
    }, true);
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
