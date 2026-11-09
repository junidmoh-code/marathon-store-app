// ─── PINE AND CONCRETE SHARE THEIR ORDERS (Junid, 9 Nov 2026) ────────────────
//
// Either shop can see, track and collect the other's orders. A shop-bound
// account's /orders read is limited by the database rule to its own destShop,
// so the sibling's orders come down a second query that the rule must allow.
// Until it does, that query is refused and the screen is exactly what it was.
//
// Marathon PE and Trophy have no sibling: every answer here is the input back.
// Pure: no firebase, no clock, no React.
import { locationOf, storesOf, sectionOf } from "./networkRegistry";
import { TV_ORDER_KEY_START, TV_ORDER_KEY_END } from "./tvOrdersRange";

// The other Section 1 store, or null. One, because a hook count cannot follow
// the registry and Section 1 has two stores (the same limit as
// SECTION_SNEAKER_HUB_SLOTS).
export function siblingOrderShop(network, shop) {
  const s = locationOf(network, shop);
  if (!s || s.type !== "store" || s.section !== 1) return null;
  return storesOf(network, { section: 1 }).find((o) => o.id !== s.id)?.id || null;
}

const createdMs = (o) => Date.parse(o?.createdAt ?? "") || 0;

// Own feed + sibling feed, newest first. `settled` and `error` stay the OWN
// feed's: a sibling query the rule refuses must not make a shop's own orders
// read as unsettled. No sibling rows hands back the same array.
export function mergeSharedOrders(own, sibling) {
  if (!Array.isArray(sibling) || !sibling.length) return own;
  const byId = new Map();
  for (const o of [...sibling, ...(own || [])]) if (o) byId.set(o.id, o);
  const merged = [...byId.values()].sort((a, b) => createdMs(b) - createdMs(a));
  merged.settled = own?.settled === true;
  if (own?.error) merged.error = true;
  return merged;
}

// A Section 1 kiosk also reads the unprefixed range: per-store numbering needs
// a rule that is not published, so Pine's and Concrete's orders carry plain
// keys today (utils/orderCounter.js falls back). boardShowsOrder then keeps
// Section 2's orders off it.
export function withSharedRange(ranges, section) {
  return Number(section) === 1 ? [...ranges, { start: TV_ORDER_KEY_START, end: TV_ORDER_KEY_END }] : ranges;
}

// The section a shop's in-app TV shows layby pulls for: Pine's and Concrete's
// own division. null (every pull, as ever) for anyone else.
export function tvSectionForShop(network, shop) {
  return sectionOf(network, shop) === 1 ? 1 : null;
}

export function boardShowsOrder(network, section, order) {
  return Number(section) === 1 ? sectionOf(network, order?.destShop) === 1 : true;
}
