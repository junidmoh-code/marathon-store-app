// ─── PER-STORE ORDER NUMBERS — THE KEY SHAPES, IN ONE PLACE ──────────────────
//
// The order number is the /orders KEY, it is written on a shoebox and read off
// a TV. Until sections there was one daily 001–999 sequence for the whole
// network (/orderCounter) and one for refill carts (/refillCounter, "R###").
//
// Marathon PE and Trophy keep exactly that: same counters, same paths, same
// keys. A store with a numberPrefix in the registry (Pine "P", Concrete "C")
// gets its OWN daily sequence, starting at 001, under its own counter path,
// and its keys carry the prefix so they can never collide with the shared one:
//
//                     shared (PE, Trophy)     Pine            Concrete
//   customer order    001 … 999               P001 … P999     C001 … C999
//   refill cart line  R001-1 …                RP001-1 …       RC001-1 …
//   order counter     /orderCounter           /orderCounter_byStore/marathon-pine
//   refill counter    /refillCounter          /refillCounter_byStore/marathon-pine
//
// A refill key always starts with "R" and always has a "-"; a customer key
// never has either property together. That is why a store prefix may not
// start with "R": "R001" would sit inside a refill-shaped range and a TV board
// ranged on "R…" would download every refill cart. assertUsablePrefix refuses
// it loudly rather than fall back to the shared sequence.
//
// Pure: no firebase, no clock. utils/orderCounter.js runs the transactions.
import { numberPrefixFor, resolveLocationId, storesOf } from "./networkRegistry";
import { TV_ORDER_KEY_START, TV_ORDER_KEY_END } from "./tvOrdersRange";

export const ORDER_COUNTER_PATH = "orderCounter";
export const REFILL_COUNTER_PATH = "refillCounter";
export const ORDER_COUNTER_BY_STORE_PATH = "orderCounter_byStore";
export const REFILL_COUNTER_BY_STORE_PATH = "refillCounter_byStore";

function assertUsablePrefix(prefix) {
  if (prefix && prefix[0] === "R") {
    throw new Error(`Order number prefix "${prefix}" starts with R, which is reserved for refill carts. Change it on the Network card.`);
  }
  return prefix || null;
}

// The store's prefix, or null for the shared sequence (PE, Trophy, no shop,
// a shop the registry does not know).
export function orderPrefixFor(network, shop) {
  return assertUsablePrefix(shop ? numberPrefixFor(network, shop) : null);
}

function counterPath(shared, byStore, network, shop) {
  const prefix = orderPrefixFor(network, shop);
  return prefix ? `${byStore}/${resolveLocationId(network, shop)}` : shared;
}

export function orderCounterPath(network, shop) {
  return counterPath(ORDER_COUNTER_PATH, ORDER_COUNTER_BY_STORE_PATH, network, shop);
}

export function refillCounterPath(network, shop) {
  return counterPath(REFILL_COUNTER_PATH, REFILL_COUNTER_BY_STORE_PATH, network, shop);
}

// The transaction body both counters have always run, unchanged: a new SA day
// starts at 1, 999 wraps to 1.
export function nextCounterValue(current, todayKey) {
  if (!current || current.day !== todayKey) return { day: todayKey, counter: 1 };
  const next = current.counter >= 999 ? 1 : current.counter + 1;
  return { day: todayKey, counter: next };
}

const pad3 = (n) => String(n).padStart(3, "0");

export function formatOrderKey(prefix, counter) {
  return `${assertUsablePrefix(prefix) || ""}${pad3(counter)}`;
}

// The refill CART number; line keys are `${cart}-${i}`.
export function formatRefillNumber(prefix, counter) {
  return `R${assertUsablePrefix(prefix) || ""}${pad3(counter)}`;
}

// Any /orders key → what it is. Unknown shapes (legacy "items", push ids)
// answer kind null.
//   "001"     → { kind: "order",  prefix: "",  number: 1 }
//   "P012"    → { kind: "order",  prefix: "P", number: 12 }
//   "R001-3"  → { kind: "refill", prefix: "",  number: 1, line: "3" }
//   "RP001-3" → { kind: "refill", prefix: "P", number: 1, line: "3" }
export function parseOrderKey(key) {
  const k = String(key ?? "");
  let m = /^R([A-Z]{0,3})(\d{1,3})-(.+)$/.exec(k);
  if (m) return { kind: "refill", prefix: m[1], number: Number(m[2]), line: m[3] };
  m = /^([A-Z]{0,3})(\d{1,3})$/.exec(k);
  if (m && m[1][0] !== "R") return { kind: "order", prefix: m[1], number: Number(m[2]) };
  return { kind: null, prefix: null, number: null };
}

// Is this a customer order on the SHARED sequence (Marathon PE / Trophy)? The
// gap/duplicate audit digit-strips ids; a "P001" stripped to 1 would read as a
// duplicate of Section 2's "001".
export function isSharedSequenceOrderKey(key) {
  const p = parseOrderKey(key);
  return p.kind === "order" && p.prefix === "";
}

// What a person types into "find my order" → the key to look for.
// "7" → "007"; "#012" → "012"; "p7" → "P007"; anything else, trimmed.
export function orderKeyFromInput(input) {
  const clean = String(input ?? "").trim().replace(/^#/, "");
  const m = /^([A-Za-z]{0,3})(\d{1,3})$/.exec(clean);
  if (!m) return clean;
  return `${m[1].toUpperCase()}${pad3(m[2])}`;
}

// ─── THE TV BOARD'S KEY RANGES ───────────────────────────────────────────────
// The board reads /orders by KEY RANGE so refill carts never come down the
// wire. Section 2's board — and a board that names no section, which is every
// board running today — keeps the one range it has always had, IMPORTED from
// tvOrdersRange.js (its upper bound ends in an invisible ; never retype).
// A Section 1 board reads one range per prefixed store in that section, each
// built the same way: prefix + the shared bounds.
export function tvOrderKeyRanges(network, section) {
  if (Number(section) !== 1) return [{ start: TV_ORDER_KEY_START, end: TV_ORDER_KEY_END }];
  const out = [];
  for (const s of storesOf(network, { section: 1 })) {
    const prefix = orderPrefixFor(network, s.id);
    if (prefix) out.push({ start: `${prefix}${TV_ORDER_KEY_START}`, end: `${prefix}${TV_ORDER_KEY_END}` });
  }
  return out;
}

// The same comparison the server query makes, for the mirrored copy.
export function keyInOrderRanges(key, ranges) {
  const k = String(key);
  return (ranges || []).some((r) => k >= r.start && k <= r.end);
}

// "?section=1" on the TV kiosk URL → 1; anything else → null (today's board).
export function tvSectionFromSearch(search) {
  try {
    const v = new URLSearchParams(search || "").get("section");
    return v === "1" ? 1 : v === "2" ? 2 : null;
  } catch {
    return null;
  }
}
