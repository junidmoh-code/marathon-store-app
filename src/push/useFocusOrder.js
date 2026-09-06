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
// tab, wrong hub, already collected, an order whose surface is the CR batch
// view rather than a per-order card) NOTHING happens, which is exactly the same
// screen they would have got from a link with no focus at all.
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
        el = document.querySelector(`[data-order-card="${CSS.escape(key)}"]`);
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
    };
  }, [ready]);

  return focusKey;
}
