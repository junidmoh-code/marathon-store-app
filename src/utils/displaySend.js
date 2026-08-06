// ─── DISPLAY SEND — the size-at-send rule ────────────────────────────────────
// A display pair request may be placed WITHOUT a size ("send a pair for the
// display") — the requester is not holding the shoe. The PICKER is. So the size
// is captured at SEND time, from the person taking the actual pair off the
// shelf, and nowhere else. That captured size (`sentSize`) is what tells the
// POS which size the display is when it sells, and what any deduction keys on.
//
// THE RULE IS UNCONDITIONAL for footwear display requests: the send is blocked
// until the picker names the size — even when the order already carries one.
// The order's size is what the requester ASKED for; sentSize is what physically
// LEFT. When the shelf has size 7 but the request said 6, the picker sends what
// exists, and the books must record the truth, not the wish. (The order's size
// pre-selects in the UI so the common case stays one tap.)
//
// Pure and side-effect free so the mutation test can prove "a display cannot be
// sent without a size" against the actual rule the send button consults.

import { productIsFootwear } from "./footwearLine.js";

/** Is this order a display pair request for footwear — the kind the rule covers? */
export function isDisplayPairSend(order, product) {
  return !!(order && order.requestDisplayPartner && productIsFootwear(product));
}

/**
 * May this order be marked Sent with this size?
 * Returns { ok: true, sentSize } or { ok: false, reason }.
 */
export function validateDisplaySend(order, product, chosenSize) {
  if (!isDisplayPairSend(order, product)) return { ok: true, sentSize: chosenSize ?? null };
  const s = chosenSize == null ? "" : String(chosenSize).trim();
  if (!s || s === "_") {
    return { ok: false, reason: "size_required", message: "Pick the size you are actually sending — the till needs it when the display sells." };
  }
  return { ok: true, sentSize: s };
}

/** Does the send UI need to demand a size before offering "Mark as Sent"? */
export function displaySendNeedsSize(order, product) {
  return isDisplayPairSend(order, product) && !order.sentSize;
}
