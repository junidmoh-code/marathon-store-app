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
        // Newly-appended cards need their hearts marked (the click handler is
        // delegated and needs nothing, but the FILLED state is per-card).
        applyLoved(grid);

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

  // ─── BACK (snippets/marathon-back.liquid) ───────────────────────────────────
  // The control's `href` is always a real, working link — a collection page
  // or `routes.root_url`, rendered by Liquid — so it never dead-ends even
  // with JavaScript off. When JS IS on and the referrer that got the shopper
  // to THIS page was this same site, `history.back()` is the better answer:
  // it returns to the exact scroll position and any filters/sort the shopper
  // had set, which a plain link to a fresh collection page cannot. A
  // cross-site or empty referrer (arrived via a shared link, a new tab, a
  // search engine) falls through to the plain link instead — there is
  // nothing of ours on the stack to go back TO.
  document.addEventListener("click", function (ev) {
    var back = ev.target.closest && ev.target.closest("[data-mc-back]");
    if (!back) return;
    var ref = document.referrer;
    if (!ref) return; // no same-site history — let the fallback link work
    try {
      if (new URL(ref).origin === location.origin) {
        ev.preventDefault();
        history.back();
      }
    } catch (e) { /* malformed referrer — fall through to the link */ }
  });

  // ─── LOVED (owner order 2026-08-26) ─────────────────────────────────────────
  // Tap the heart to keep a product in mind; decide later. Loved products
  // SURFACE AT THE TOP of the grid on the next page view — deliberately not
  // the instant of the tap, because a card that jumps out from under a thumb
  // mid-browse reads as a glitch, not a feature.
  //
  // Per-browser localStorage, same discipline as the density preference: every
  // read and write guarded, because a private window can THROW on the accessor
  // rather than return null. No account, no endpoint — a cleared browser
  // forgets, and that is the honest cost of zero-friction loving.
  var LOVE_KEY = "mc-loved";
  // A SECOND KEY, ALONGSIDE THE IDS: photo, price, url and (when the product
  // has only one variant) its cart-ready variant id, captured from the card's
  // OWN DOM at the moment of the tap. Nothing is fetched for this — the same
  // "no endpoint" rule as the ID list — so the wishlist panel can render a
  // photo and a price for a product loved on a completely different page
  // without a network call. The cost is that a price change or a restock
  // after the tap is not reflected until the shopper re-loves the item; that
  // is an acceptable staleness for a save-for-later list, not a checkout.
  var META_KEY = "mc-loved-meta";
  function readLoved() {
    try {
      var v = JSON.parse(localStorage.getItem(LOVE_KEY) || "[]");
      return Array.isArray(v) ? v.map(String) : [];
    } catch (e) { return []; }
  }
  function writeLoved(ids) {
    try { localStorage.setItem(LOVE_KEY, JSON.stringify(ids)); } catch (e) { /* private window */ }
  }
  function readMeta() {
    try {
      var v = JSON.parse(localStorage.getItem(META_KEY) || "{}");
      return v && typeof v === "object" ? v : {};
    } catch (e) { return {}; }
  }
  function writeMeta(map) {
    try { localStorage.setItem(META_KEY, JSON.stringify(map)); } catch (e) { /* private window */ }
  }
  // Reads everything the wishlist panel needs off the CARD that was just
  // hearted — the same card the tap happened on, whether that is a grid tile
  // or (later) a product-page equivalent, as long as it carries these same
  // data attributes and classes.
  function captureCardMeta(card) {
    var img = $(".mc-card__media img", card);
    var priceEl = $(".mc-card__price", card);
    var singleInput = $("[data-mc-single]", card);
    // EVERY SIZE, CAPTURED OFF THE SAME HIDDEN PANEL THE QUICK-VIEW USES
    // (see marathon-card.liquid's `.mc-sizes [data-mc-size]` buttons) — so the
    // wishlist can offer its OWN size picker without a network call, the same
    // "no endpoint" rule as everything else here. Sold-out sizes are captured
    // too (available: false) so the wishlist's picker can grey them out the
    // same way the card's own panel does.
    var variants = $$("[data-mc-size]", card).map(function (btn) {
      return {
        id: btn.getAttribute("data-variant-id"),
        title: btn.textContent.replace(/\s*—\s*sold out\s*$/i, "").trim(),
        available: !btn.disabled,
      };
    });
    return {
      url: card.getAttribute("data-mc-url") || "",
      title: card.getAttribute("data-mc-title") || "",
      image: img ? img.currentSrc || img.src : "",
      price: priceEl ? priceEl.textContent.trim() : "",
      variantId: singleInput ? singleInput.value : null,
      // `.mc-card__sold` no longer exists — sold-out is now the price footer
      // showing "Sold out" text (see marathon-card.liquid) — so this reads
      // the card's own `data-mc-sold-out` attribute instead of a dead class.
      // (Fixed 2026-08-27: found live, mid-verification, by a sold-out item's
      // wishlist row wrongly getting a size picker and an enabled-looking
      // Add to cart — `soldOut` was silently always false.)
      soldOut: card.getAttribute("data-mc-sold-out") === "true",
      variants: variants,
    };
  }
  // Mark every heart in `scope` from the stored set. Called at load and after
  // each infinite-scroll append (the click handler below is delegated and
  // needs no re-wiring; only the FILLED state is per-card).
  function applyLoved(scope) {
    var loved = readLoved();
    $$("[data-mc-love]", scope || document).forEach(function (b) {
      var on = loved.indexOf(String(b.getAttribute("data-product-id"))) !== -1;
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  // Loved cards move to the FRONT of the collection grid, keeping their
  // relative order. First page only — cards arriving by infinite scroll keep
  // their place until the next visit (reordering under an active scroll is
  // the jump-glitch again).
  function surgeLoved() {
    var grid = $("[data-mc-grid]");
    if (!grid) return;
    var loved = readLoved();
    if (!loved.length) return;
    var lovedCards = $$("[data-mc-card]", grid).filter(function (c) {
      var b = $("[data-mc-love]", c);
      return b && loved.indexOf(String(b.getAttribute("data-product-id"))) !== -1;
    });
    for (var i = lovedCards.length - 1; i >= 0; i--) {
      grid.insertBefore(lovedCards[i], grid.firstElementChild);
    }
  }
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-mc-love]");
    if (!b) return;
    ev.preventDefault();
    ev.stopPropagation();
    var id = String(b.getAttribute("data-product-id"));
    var loved = readLoved();
    var i = loved.indexOf(id);
    var meta = readMeta();
    if (i === -1) {
      loved.push(id);
      var card = b.closest("[data-mc-card]");
      if (card) meta[id] = captureCardMeta(card);
    } else {
      loved.splice(i, 1);
      delete meta[id];
    }
    writeLoved(loved);
    writeMeta(meta);
    b.setAttribute("aria-pressed", i === -1 ? "true" : "false");
  });
  applyLoved(document);
  surgeLoved();

  // ─── THE WISHLIST PANEL ──────────────────────────────────────────────────────
  // Opened from the header heart (sections/header.liquid), rendered once,
  // globally, by snippets/marathon-wishlist.liquid. Reuses `.mc-panel`'s own
  // fixed-overlay CSS and this file's own history-free open/close pair — this
  // one never touches the address bar, unlike the product quick-view panel,
  // because "loved products" is not a page a shopper would ever share a link
  // to or expect Back to return them from.
  // ANY NUMBER OF WISHLIST CONTAINERS ON ONE PAGE. Used to be exactly one (the
  // global modal); the dedicated Loved page (owner order 2026-08-27) adds a
  // second, and the modal itself may or may not still be in the DOM depending
  // on the theme's current markup — this loop makes neither assumption. Every
  // `[data-mc-wishlist-list]` on the page is found, paired with the nearest
  // `[data-mc-wishlist-empty]` in the SAME sheet/page wrapper (never a
  // different container's empty state), and kept in sync together.
  var wishlistLists = $$("[data-mc-wishlist-list]");
  if (wishlistLists.length) {
    function scopeFor(listEl) {
      return listEl.closest(".mc-wishlist__sheet, .mc-loved-page") || listEl.parentElement || document;
    }

    // Extracted from the old inline add-to-cart click handler (owner order
    // 2026-08-27, redesign pass) so BOTH a direct single-variant tap on
    // "Add to cart" and a size picked from the pop-out below fire the exact
    // same fetch — a shopper on a sized product no longer has to click
    // "Add to cart" a second time after choosing a size.
    function performWishlistAdd(variantId, btnEl) {
      btnEl.classList.add("is-busy");
      btnEl.disabled = true;
      var originalText = btnEl.textContent;
      btnEl.textContent = "Adding…";
      fetch(shopRoot() + "cart/add.js", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ items: [{ id: Number(variantId), quantity: 1 }] }),
      })
        .then(function (res) {
          return res.json().then(function (body) { return { ok: res.ok, body: body }; });
        })
        .then(function (r) {
          if (!r.ok) {
            throw new Error((r.body && (r.body.description || r.body.message)) || "Could not add that.");
          }
          btnEl.textContent = "Added";
          refreshCartCount();
        })
        .catch(function () {
          btnEl.textContent = originalText;
        })
        .then(function () {
          btnEl.classList.remove("is-busy");
          btnEl.disabled = false;
        });
    }

    function renderWishlistRow(id, meta) {
      var row = document.createElement("div");
      row.className = "mc-wishlist__item";
      row.setAttribute("data-mc-wishlist-item", id);

      // THE THUMB IS A WRAPPER NOW, NOT THE LINK ITSELF (redesign, owner
      // order 2026-08-27) — "Remove" moves onto the photo as a plain × in
      // the top-left corner, and a button can't nest inside the `<a>` it
      // would otherwise sit on top of without either stealing the link's
      // click or needing stopPropagation gymnastics. A sibling button
      // positioned over a sibling link has neither problem.
      var thumb = document.createElement("div");
      thumb.className = "mc-wishlist__thumb";

      var link = document.createElement("a");
      link.className = "mc-wishlist__thumb-link";
      link.href = meta.url || "#";
      if (meta.image) {
        var img = document.createElement("img");
        img.src = meta.image;
        img.alt = meta.title || "";
        img.loading = "lazy";
        link.appendChild(img);
      }
      thumb.appendChild(link);

      // NO SEPARATE "Remove" TEXT LINK (owner order 2026-08-27): the photo
      // IS the "view product" link now — tapping it is how a shopper views
      // the product, so a redundant "View product" link is gone — and
      // removing is a plain × badge, not a row of text competing with it.
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "mc-wishlist__remove";
      remove.setAttribute("aria-label", "Remove from loved");
      remove.setAttribute("data-mc-wishlist-remove", id);
      remove.textContent = "×";
      thumb.appendChild(remove);

      row.appendChild(thumb);

      var body = document.createElement("div");
      body.className = "mc-wishlist__body";

      // NAME, THEN PRICE (redesign, owner order 2026-08-27) — the grid tile
      // deliberately has no name (the photograph is the identity there), but
      // this is a saved-for-later LIST, where a shopper is scanning several
      // rows and needs the title to tell them apart at a glance, same as a
      // cart line item does. `.h4` is Dawn's own type-scale utility class,
      // not a bespoke one — the sitewide heading rule in
      // marathon-storefront.css already targets it, so this renders in
      // EXACTLY the same face as the cart's own product name with zero new
      // CSS, rather than a close approximation that could drift from it.
      var name = document.createElement("p");
      name.className = "mc-wishlist__name h4";
      name.textContent = meta.title || "";
      body.appendChild(name);

      var price = document.createElement("p");
      price.className = "mc-card__price mc-wishlist__price";
      price.textContent = meta.soldOut ? "Sold out" : meta.price || "";
      body.appendChild(price);

      var variants = meta.variants || [];
      var actions = document.createElement("div");
      actions.className = "mc-wishlist__actions";
      var sizepop = null;

      // "Add to cart" ON EVERY LOVED PRODUCT (owner order 2026-08-27), sold
      // out excepted. A true single-variant product (bags, fragrance) has
      // its buyable id already and adds on the first tap, same as before. A
      // sized product's button carries NO variant id until one is chosen —
      // tapping it with none set opens the size pop-out below instead of
      // trying to add nothing.
      if (!meta.soldOut) {
        var add = document.createElement("button");
        add.type = "button";
        add.className = "mc-add mc-wishlist__add";
        add.textContent = "Add to cart";
        if (meta.variantId && variants.length <= 1) {
          add.setAttribute("data-mc-wishlist-variant", meta.variantId);
        }
        actions.appendChild(add);

        // A SIZE PICKER THAT POPS OUT OF "Add to cart", NOT ONE SITTING
        // OPEN IN THE ROW BY DEFAULT (redesign, owner order 2026-08-27) —
        // same `.mc-sizes`/`.mc-size` buttons the quick-view panel uses
        // (sold-out struck through and disabled), just hidden until the add
        // button is tapped. Picking a size adds immediately — see the click
        // handler below — so this never needs a second confirm.
        if (variants.length > 1) {
          sizepop = document.createElement("div");
          sizepop.className = "mc-wishlist__sizepop";
          sizepop.hidden = true;
          sizepop.setAttribute("data-mc-wishlist-sizepop", "");

          var legend = document.createElement("p");
          legend.className = "mc-sizes__legend";
          legend.textContent = "Size";
          sizepop.appendChild(legend);

          var sizes = document.createElement("div");
          sizes.className = "mc-sizes mc-wishlist__sizes";
          sizes.setAttribute("role", "group");
          variants.forEach(function (v) {
            var sBtn = document.createElement("button");
            sBtn.type = "button";
            sBtn.className = "mc-size";
            sBtn.setAttribute("data-mc-wishlist-size", v.id);
            sBtn.setAttribute("aria-pressed", "false");
            if (!v.available) {
              sBtn.disabled = true;
              sBtn.setAttribute("aria-disabled", "true");
            }
            sBtn.textContent = v.title;
            sizes.appendChild(sBtn);
          });
          sizepop.appendChild(sizes);
        }
      }

      // "Add to cart" LAST, AT THE BOTTOM OF THE STACK (redesign, owner
      // order 2026-08-27) — name and price read top-down like a receipt,
      // and the one actionable control sits at the foot of that, not
      // wedged in the middle. The size pop-out, when it opens, appears
      // ABOVE the button it opened from rather than pushing it further
      // down — DOM order here controls that: sizepop first, actions last.
      if (sizepop) body.appendChild(sizepop);
      body.appendChild(actions);
      row.appendChild(body);
      return row;
    }

    // RE-READS STATE EVERY TIME, not once at load — a card loved or unloved
    // elsewhere since this last ran must never show stale here. Called on
    // script init (the Loved page has no "open" event to hang this off) and
    // again after every remove/add so every container stays in sync.
    function renderAllWishlists() {
      var loved = readLoved();
      var meta = readMeta();
      wishlistLists.forEach(function (listEl) {
        var scope = scopeFor(listEl);
        var emptyEl = $("[data-mc-wishlist-empty]", scope);
        listEl.innerHTML = "";
        var shown = 0;
        loved.forEach(function (id) {
          var m = meta[id];
          if (!m) return; // meta can only be missing if storage was hand-edited
          listEl.appendChild(renderWishlistRow(id, m));
          shown++;
        });
        if (emptyEl) emptyEl.hidden = shown > 0;
        listEl.hidden = shown === 0;
      });
    }
    renderAllWishlists();

    var wishlistPanel = $("[data-mc-wishlist-panel]");
    function closeWishlist() {
      if (wishlistPanel) wishlistPanel.hidden = true;
    }

    document.addEventListener("click", function (ev) {
      if (wishlistPanel && ev.target.closest("[data-mc-wishlist-close]")) {
        closeWishlist();
        return;
      }
      // Backdrop click (the panel's own padding, not the sheet) closes —
      // same split as the quick-view panel. Harmless no-op on the Loved page,
      // which has no such backdrop element.
      if (wishlistPanel && ev.target === wishlistPanel) {
        closeWishlist();
        return;
      }
      // PICKING A SIZE ADDS IMMEDIATELY (redesign, owner order 2026-08-27) —
      // no second tap on "Add to cart" needed once a size is chosen.
      var sizeBtn = ev.target.closest("[data-mc-wishlist-size]");
      if (sizeBtn) {
        var row = sizeBtn.closest("[data-mc-wishlist-item]");
        $$("[data-mc-wishlist-size]", row).forEach(function (b) {
          b.setAttribute("aria-pressed", b === sizeBtn ? "true" : "false");
        });
        var rowAdd = $(".mc-wishlist__add", row);
        var variantId = sizeBtn.getAttribute("data-mc-wishlist-size");
        if (rowAdd) {
          rowAdd.setAttribute("data-mc-wishlist-variant", variantId);
          performWishlistAdd(variantId, rowAdd);
        }
        var pop = $("[data-mc-wishlist-sizepop]", row);
        if (pop) pop.hidden = true;
        return;
      }
      var removeBtn = ev.target.closest("[data-mc-wishlist-remove]");
      if (removeBtn) {
        var id = removeBtn.getAttribute("data-mc-wishlist-remove");
        var loved = readLoved();
        var i = loved.indexOf(id);
        if (i !== -1) loved.splice(i, 1);
        writeLoved(loved);
        var meta = readMeta();
        delete meta[id];
        writeMeta(meta);
        applyLoved(document); // keeps a still-visible grid card's heart in sync
        renderAllWishlists();
        return;
      }
      // "Add to cart" WITH A RESOLVED VARIANT ADDS DIRECTLY (single-variant
      // products); WITHOUT ONE, IT OPENS THE SIZE POP-OUT INSTEAD (owner
      // order 2026-08-27) — the same button does both, distinguished only
      // by whether a variant id has been resolved onto it yet.
      var addBtn = ev.target.closest(".mc-wishlist__add");
      if (addBtn) {
        var addVariantId = addBtn.getAttribute("data-mc-wishlist-variant");
        if (addVariantId) {
          performWishlistAdd(addVariantId, addBtn);
        } else {
          var addRow = addBtn.closest("[data-mc-wishlist-item]");
          var addPop = addRow && $("[data-mc-wishlist-sizepop]", addRow);
          if (addPop) addPop.hidden = !addPop.hidden;
        }
      }
    });

    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && wishlistPanel && !wishlistPanel.hidden) closeWishlist();
    });
  }
})();
