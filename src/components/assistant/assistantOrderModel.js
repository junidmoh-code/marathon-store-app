// ─── ASSISTANT ORDER MODEL — the desktop order screen's derived state ────────
//
// Lifted out of App.jsx's AssistantDesktop (2026-10-19) so the sneaker photo
// wall and the classic three-pane layout read the SAME cart grouping, the same
// size gate and the same render cap. Nothing here owns state that matters: the
// cart, the search, the shop and the place-order path all stay in
// AssistantView, exactly where they were. This module only derives.
//
// Pure functions first (testable without React), then one hook that the
// layouts call with AssistantView's props.

import { useEffect, useMemo, useState } from "react";
import { orderSizeOut } from "../../utils/deactivation";
import { orderSizesForDisplay } from "../../utils/sizeDisplayOrder";
import { formatSize } from "../../utils/sizeLabel";

// How many product cards the desktop workspace builds at once. The till is a
// Celeron J4125 with UHD 600 graphics: ~2.4k clothing cards (each with a photo,
// a blurred glass background and an animated price) is several seconds of work,
// which is what made typing in the search box lag. A screenful is ~12-20 cards.
export const AD_PAGE = 60;

export const fmtR = (n) => "R" + Number(n).toLocaleString("en-ZA", { maximumFractionDigits: 0 });

// Numeric runs in ascending order (orderSizesForDisplay) — stored order put
// a shoe's 10 before its 6 (2026-10-03).
export function sizesOf(p) {
  const s = orderSizesForDisplay((Array.isArray(p.sizes) ? p.sizes : []).filter(x => x && String(x).trim() && x !== "_"));
  return s.length ? s : ["Free Size"];
}

// Cart → grouped by product+size for the drawer (the cart is one line per unit).
export function groupOrderLines(cart) {
  const m = new Map();
  (cart || []).forEach(l => {
    if (l.intent === "refill") return;                 // desktop = customer orders
    const dp = !!l.requestDisplayPartner;
    // A display-pair PULL groups apart from a classic partner line — mixing
    // them let "+" mint an unflagged twin and "−" strip the flagged one.
    const pull = l.displayPairRequest === true;
    const key = `${l.product?.id}__${l.size}__${dp ? "dp" : ""}${pull ? "pull" : ""}`;
    if (!m.has(key)) m.set(key, { key, product: l.product, size: l.size, dp, pull, qty: 0 });
    m.get(key).qty++;
  });
  return [...m.values()];
}

// Refill cart (intent:"refill") — each line carries its own qty; sum per size.
export function groupRefillLines(cart) {
  const m = new Map();
  (cart || []).forEach(l => {
    if (l.intent !== "refill") return;
    const key = `${l.product?.id}__${l.size}`;
    if (!m.has(key)) m.set(key, { key, product: l.product, size: l.size, qty: 0 });
    m.get(key).qty += (l.qty || 1);
  });
  return [...m.values()];
}

// The running value of the order lines — what the wall's order pill shows. A
// Display Partner line carries no price (the drawer prints "—" for it), and an
// unpriced product counts as R0 rather than poisoning the sum with NaN.
export function orderLinesTotal(grouped) {
  return (grouped || []).reduce((s, g) => {
    if (g.dp) return s;
    const price = g.product?.retailPrice;
    return s + (typeof price === "number" && price > 0 ? price * g.qty : 0);
  }, 0);
}

// The ✕-note text for a sneaker size — WHY the serving hub can't give it out.
// Three ✕ causes that looked identical and read as "this size doesn't exist"
// (owner report 2026-09-01, Lacoste Powercourt size 8): the cell truly has
// nothing; the cell has stock but every unit is reserved for a ready-but-
// uncollected order; or this cart already holds everything the hub can give.
// `w` is sneakerOutWhy's { booked, promised, available, pullOnly, hubLabel }.
// hubLabel is the hub that actually refused (Hub 1 or, since 2026-09-05, Hub
// 2): naming the wrong shelf sends staff to the wrong building. It defaults to
// "Hub 1" only when there is no split at all, which is the pre-2026-09-05
// wording verbatim.
export function sneakerBlockNoteText(size, w) {
  const sz = formatSize(size);
  const hub = w?.hubLabel || "Hub 1";
  // "another customer's order", not "awaiting collection": the promised
  // scalar merges ready promises WITH pending display-pair pulls, and the
  // note must not name a reason it cannot distinguish (adversarial review).
  // The hold is SHORT (20-minute collection deadline, owner directive
  // 2026-09-01) and the note says so — staff should retry, not give up.
  // EXCEPT a block explained only by a display-pair pull claim (w.pullOnly):
  // that lane holds for up to 48h, and calling it a 20-minute hold would be
  // false (CodeRabbit, #546).
  // BOTH GATED HUBS CHECKED, BOTH EMPTY (2026-09-06). Since sourcing became
  // stock-aware, an ✕ on a size neither Hub 1 nor Hub 2 holds is a genuinely
  // different fact from "the hub this shoe is tagged to hasn't got it" — and
  // the old wording said the second while meaning the first, which is the
  // shape of the report that started this work: staff read a hub-named ✕ as
  // "this size doesn't exist" and stopped looking. Say what was actually
  // checked. Only when the resolver really did read both (w.checkedBoth);
  // an unsettled alternate keeps the single-hub wording verbatim.
  if (!w || w.booked <= 0) return w?.checkedBoth
    ? `Size ${sz} isn't at Hub 1 or Hub 2 right now — it can't be ordered.`
    : `Size ${sz} isn't available at ${hub} right now — it can't be ordered.`;
  if (w.available <= 0) {
    if (w.pullOnly)
      return `Size ${sz} at ${hub} is claimed by a pending display-pair request — it can't be ordered.`;
    return w.booked === 1
      ? `${hub}'s only size ${sz} is reserved for another customer's order (20-minute hold) — try again shortly.`
      : `All ${w.booked} of size ${sz} at ${hub} are reserved for other customers' orders (20-minute hold) — try again shortly.`;
  }
  return `Your cart already has all ${w.available} of size ${sz} that ${hub} can give out.`;
}

// ONE size gate for every quick-add surface (the hover grid and the wall).
// Clothing: a size the serving hub has zero of is out. Sneakers (Hub 1 and
// Hub 2): out from the shared availability resolver (sneakerOut), composed
// with the deactivation/clothing rule (#445).
//   out        — the size cannot be added from a quick-add chip
//   tappable   — an out SNEAKER chip the hover grid lets you tap to open the
//                quick-view's why-note (clothing/deactivated never are)
//   dInfo      — the informational "on a display" glyph; never on an out or
//                deactivated tile (the ✕ is authoritative — the drift rule)
//   title      — the hover text naming the real reason
export function quickAddSizeState(p, sz, { clothingOrder, hubQty, sneakerOut, sneakerOutWhy, sneakerDisplayInfo, deadForOrder, hubLabelFor }) {
  const dead = deadForOrder(p);
  const snk = !clothingOrder && !!sneakerOut?.(p, sz);
  const out = orderSizeOut(p, { clothingOrder, hubQty: hubQty(p.id, sz), deactivated: deadForOrder(p) }) || snk;
  const dInfo = !clothingOrder && !out && !dead ? sneakerDisplayInfo?.(p, sz) : null;
  const tappable = out && !clothingOrder && !dead && snk;
  const title = out ? (dead ? "Deactivated — finished line"
      : clothingOrder ? `Not available at ${hubLabelFor(p.id)}`
      // Sneaker ✕: name the real reason — a cell whose stock is reserved for
      // an uncollected order must not read as "doesn't exist".
      : sneakerBlockNoteText(sz, sneakerOutWhy?.(p, sz)))
    : dInfo ? "This size is on a display" : undefined;
  return { out, tappable, dInfo, title };
}

// The layouts' shared derived state. `shown` is the list the screen renders
// before the cap; `resetKeys` are the inputs whose change sends the cap back
// to one page (a new query, a new filter, a new mode).
export function useAssistantOrderModel({ cart, shown, resetKeys }) {
  const grouped = useMemo(() => groupOrderLines(cart), [cart]);
  const groupedRefill = useMemo(() => groupRefillLines(cart), [cart]);
  const units = grouped.reduce((s, g) => s + g.qty, 0);
  const refillUnits = groupedRefill.reduce((s, g) => s + g.qty, 0);
  const total = useMemo(() => orderLinesTotal(grouped), [grouped]);

  // Render cap — a query like "a" matches thousands of products, and building
  // that many cards is what made the till crawl. Cards are cheap to add on
  // demand, so show a screenful and grow on scroll/click.
  const [renderCap, setRenderCap] = useState(AD_PAGE);
  useEffect(() => { setRenderCap(AD_PAGE); }, resetKeys);
  const visible = useMemo(() => shown.slice(0, renderCap), [shown, renderCap]);
  const showMore = () => setRenderCap(c => c + AD_PAGE);

  return { grouped, groupedRefill, units, refillUnits, total, visible, showMore };
}
