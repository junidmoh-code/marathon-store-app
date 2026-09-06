// ─── RINGING THE CARD THE NOTIFICATION WAS ABOUT ─────────────────────────────
// A notification that opens the right SCREEN still leaves the reader hunting
// down a queue that is dozens of cards deep. This closes that last step: the
// card named by the notification is scrolled into view and outlined for a few
// seconds, then it is an ordinary card again.
//
// ── WHY IT LOOKS FOR THE ELEMENT INSTEAD OF FILTERING THE LIST ──────────────
// Pinning the order to the top, or filtering the queue down to it, would change
// what the picker sees — and this screen's ordering is load-bearing (day
// grouping, status tabs, the on-hold lane). A find-and-ring touches none of it:
// if the card is on screen the reader is taken to it, and if it is not (wrong
// tab, wrong hub, already collected) NOTHING happens, which is exactly the same
// screen they would have got from a link with no focus at all.
//
// ── ONE CARD CAN BE SEVERAL ORDERS ──────────────────────────────────────────
// The order queue stamps one key per card. The CR Orders tab does not: it
// groups a whole request into one card per (product, store), so that card is
// several order lines at once — and a shop refill or an engine leg is ALWAYS on
// that tab, which is most of the orders this feature notifies about. Stamping
// only per-order cards would have meant the ring worked for customer orders and
// silently did nothing for everything else.
//
// So the attribute holds a SPACE-SEPARATED list of the keys a card covers, and
// the lookup uses `~=`, CSS's own "one of a whitespace-separated list" operator.
// One card, one attribute, however many orders are on it.
//
// The marker is consumed on read (see takeFocusOrder), so this fires once per
// notification tap and never re-rings on a later render.

import { useEffect, useState } from "react";
import { orderCardKey, takeFocusOrder } from "./deepLink";

// How long the ring stays. Long enough to be seen after a scroll settles,
// short enough that it does not become a permanent-looking state on a card
// somebody has walked away from.
export const FOCUS_RING_MS = 6000;
// The list is rendered by the same paint that runs this effect; one frame's
// grace lets the cards exist before we look for one.
const FIND_RETRY_MS = 120;
const FIND_ATTEMPTS = 12;

/**
 * @param {boolean} ready  false while the screen has nothing to search (no hub
 *        picked, orders not yet settled) — the marker is left for the render
 *        that can actually use it.
 * @returns {string|null} the card key to ring, or null.
 */
export function useFocusOrder(ready) {
  const [focusKey, setFocusKey] = useState(null);

  useEffect(() => {
    // ── THE TEARDOWN OWNS THE RING, NOT THE TIMER ────────────────────────────
    // The clear lives in the cleanup below and NOWHERE else, so it cannot be
    // missed by whichever branch happens to leave the effect. That matters
    // because the marker is CONSUMED on its first successful read: an effect
    // that re-runs (the hub selector reopened and a hub picked again inside the
    // few seconds the ring lasts) finds nothing and returns early, so if the
    // ring were only ever cleared by the timer the re-run cancelled, it would
    // have nothing left to take it off — a permanently ringed card, on a screen
    // a picker is working from.
    if (!ready) return undefined;
    const marker = takeFocusOrder();
    if (!marker) return undefined;
    const key = orderCardKey(marker.id, marker.createdAt);
    setFocusKey(key);

    let attempts = 0;
    let findTimer = null;
    const clearTimer = setTimeout(() => setFocusKey(null), FOCUS_RING_MS);

    const find = () => {
      let el = null;
      try {
        el = document.querySelector(`[data-order-card~="${CSS.escape(key)}"]`);
      } catch {
        // CSS.escape is absent on some older WebViews; a failed lookup only
        // costs the scroll, never the ring.
        el = null;
      }
      if (el) {
        try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch { /* ignored */ }
        return;
      }
      attempts += 1;
      if (attempts < FIND_ATTEMPTS) findTimer = setTimeout(find, FIND_RETRY_MS);
    };
    findTimer = setTimeout(find, 0);

    return () => {
      clearTimeout(clearTimer);
      if (findTimer) clearTimeout(findTimer);
      // THE one clear. The timer that would otherwise have done it is being
      // cancelled on the line above.
      setFocusKey(null);
    };
  }, [ready]);

  return focusKey;
}
