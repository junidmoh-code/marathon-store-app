// ─── MISSING PRODUCTS — "NOT LISTED" (pure, no firebase, no React) ────────────
// Junid, 23 Nov 2026: "Nothing disappears silently."
//
//   A product with stock at Central that no shop or hub of a division holds
//   is either on that division's list, or visibly accounted for.
//
// This module answers, for one division, from data the screen ALREADY holds
// (the whole /stock node, the catalogue, the open request records, the hidden
// map) — nothing is read here and nothing is written:
//
//   strandedAtCentral()  the products that rule is about: units at Central,
//                        and zero units at every shop and every hub of the
//                        division (a row at 0 is zero — that is the point);
//   coreReason()         why the two "missing" cores made no card for one;
//   notListedRows()      every such product that is not a card on the list,
//                        each with ONE reason of a few words.
//
// The reasons a card was built and then dropped (no policy, nothing free, at
// both shops…) are decided where the row is decided — missingListCore's
// decideProductRow / decideSneakerRow — and handed in as `whyByPid`. This
// module never second-guesses them.
//
// NOTHING HERE DECIDES A QUANTITY, A TARGET, A SEAT OR A REQUEST. It explains.
import { isDeactivated } from "../../utils/deactivation.js";
import { admitsMissingProduct, isClothing } from "./missingProductsCore";
import { isFootwearProduct } from "./missingFootwearCore";
import { isSneakerOrSlide } from "./firstBatchCore";
import { divisionMarkOf } from "./divisionMark";

// ── THE REASONS ───────────────────────────────────────────────────────────────
// code → { text, group }. `group` is how the census reports them:
//   chosen   Junid (or staff) chose it: hidden, marked for the other division,
//            a finished line;
//   rule     a rule working as written that keeps real work off the list;
//   data     the record itself stops it (no product record, no category).
export const REASONS = Object.freeze({
  hidden:       { text: "Hidden", group: "chosen" },
  markedConcrete: { text: "Marked Concrete", group: "chosen" },
  markedMarathon: { text: "Marked Marathon", group: "chosen" },
  finished:     { text: "Finished line", group: "chosen" },
  requested:    { text: "Requested — waiting at Central", group: "rule" },
  emptyRows:    { text: "Empty rows at a shop, no request", group: "rule" },
  bothShops:    { text: "At both Pine and Concrete", group: "rule" },
  noPolicy:     { text: "No policy", group: "rule" },
  allPromised:  { text: "All promised to open requests", group: "rule" },
  noSize:       { text: "Central has none of the sizes it needs", group: "rule" },
  undeclaredSize: { text: "Central's size is not on the product", group: "data" },
  paused:       { text: "Shop paused, empty rows", group: "rule" },
  noShop:       { text: "No shop can take it", group: "rule" },
  otherHub:     { text: "Its hubs refuse it", group: "rule" },
  heldAtHub:    { text: "On its way to a hub", group: "rule" },
  notLive:      { text: "List not live", group: "rule" },
  noView:       { text: "Category in neither list", group: "data" },
  noRecord:     { text: "No product record", group: "data" },
  unknown:      { text: "Not worked out yet", group: "rule" },
});
export const reasonText = (code) => (REASONS[code] || REASONS.unknown).text;

const units = (cells) => Object.entries(cells || {}).reduce((t, [k, c]) => (k === "_meta" ? t : t + Math.max(Number(c?.qty) || 0, 0)), 0);
const hasRows = (cells) => Object.keys(cells || {}).some((k) => k !== "_meta");

/**
 * The products the rule is about, for one division: units at Central, and
 * not one unit at any of `locations` (the division's shops AND hubs).
 * → [{ pid, centralUnits }], most units first.
 */
export function strandedAtCentral({ allStock, locations = [], central = "central" }) {
  const out = [];
  for (const [pid, cells] of Object.entries(allStock?.[central] || {})) {
    if (pid === "_meta") continue;
    const centralUnits = units(cells);
    if (centralUnits <= 0) continue;
    if (locations.some((l) => units(allStock?.[l]?.[pid]) > 0)) continue;
    out.push({ pid, centralUnits });
  }
  return out.sort((a, b) => b.centralUnits - a.centralUnits || String(a.pid).localeCompare(String(b.pid)));
}

/** Is there an OPEN request for this product at any of `locations`? */
export function openRequestAt(requests, pid, locations) {
  const want = new Set(locations || []);
  for (const r of Array.isArray(requests) ? requests : Object.values(requests || {})) {
    if (r && r.productId === pid && r.status === "open" && !r.shadow && want.has(r.requestingLocation)) return true;
  }
  return false;
}
/** pid → true for every product with an open request at any of `locations` (one pass). */
export function openRequestPids(requests, locations) {
  const want = new Set(locations || []);
  const out = new Set();
  for (const r of Array.isArray(requests) ? requests : Object.values(requests || {})) {
    if (r && r.productId && r.status === "open" && !r.shadow && want.has(r.requestingLocation)) out.add(r.productId);
  }
  return out;
}

/** Which list a product falls in: "sneakers" | "clothing" | null (neither). */
export function viewOf(product) {
  if (!product) return null;
  if (isFootwearProduct(product) && !isClothing(product)) return "sneakers";
  if (admitsMissingProduct(product)) return isSneakerOrSlide(product) ? null : "clothing";
  // In the footwear group by its category key, but not category "Footwear":
  // the clothing list refuses it and the sneaker list never looks at it.
  return null;
}

/**
 * Why the two "missing" cores made NO card for a product that is stranded at
 * Central for this division (the gates, in the order the cores apply them).
 *   listKind   "marathon" | "concrete"
 *   locations  the division's shops and hubs
 *   openPids   openRequestPids(requests, locations)
 *   heldAt     (pid) → true when held lines put units on their way to a hub
 *   paused     (location) → true while the engine is paused there (a count)
 */
export function coreReason({ product, pid, listKind, allStock, locations = [], openPids = new Set(), heldAt = () => false, paused = () => false }) {
  if (!product) return "noRecord";
  const mark = divisionMarkOf(product);
  if (mark && mark !== listKind) return mark === "concrete" ? "markedConcrete" : "markedMarathon";
  if (isDeactivated(product)) return "finished";
  const view = viewOf(product);
  if (!view) return "noView";
  if (view === "sneakers") {
    if (heldAt(pid)) return "heldAtHub";
    // A sneaker card not drawn is one already requested from this screen
    // (missingScreenCore.partitionQueued).
    if (openPids.has(pid)) return "requested";
    return "unknown";
  }
  // Clothing: a shop or hub of the division has a row for it (at 0 — the
  // product is stranded, so no unit is there). The cores treat a row as
  // "carried": the scan's job, not a Solve's.
  const withRows = locations.filter((l) => hasRows(allStock?.[l]?.[pid]));
  if (withRows.length) return openPids.has(pid) ? "requested" : withRows.every(paused) ? "paused" : "emptyRows";
  if (openPids.has(pid)) return "requested";
  return "unknown";
}

/**
 * The "Not listed" rows for one division.
 *   stranded   strandedAtCentral(…)
 *   listedPids Set of pids that are a card on either of the division's lists
 *              (or are leaving it after a Solve on this screen)
 *   whyByPid   Map pid → reason code from the row decision (built, then dropped)
 *   hiddenMap  the Hide map ({ pid: … })
 *   byId       Map pid → product
 * → [{ pid, name, photo, centralUnits, reason, text, group }], most units first.
 */
export function notListedRows({ stranded = [], listedPids = new Set(), whyByPid = new Map(), hiddenMap = null, byId = new Map(), listKind, allStock, locations = [], openPids = new Set(), heldAt = () => false, paused = () => false }) {
  const out = [];
  for (const { pid, centralUnits } of stranded) {
    if (listedPids.has(pid)) continue;
    const product = byId.get(pid) || null;
    let reason;
    if (hiddenMap && hiddenMap[pid]) reason = "hidden";
    // A card the cores DID make, then dropped at the row: the row's own reason.
    else if (whyByPid.has(pid)) reason = whyByPid.get(pid);
    else reason = coreReason({ product, pid, listKind, allStock, locations, openPids, heldAt, paused });
    const r = REASONS[reason] || REASONS.unknown;
    out.push({ pid, name: product?.name || pid, photo: product?.photoUrl || null, centralUnits, reason, text: r.text, group: r.group });
  }
  return out;
}

/** Totals by reason: { code: { n, units } }. */
export function totalsByReason(rows) {
  const out = {};
  for (const r of rows || []) {
    const t = (out[r.reason] ||= { n: 0, units: 0 });
    t.n += 1; t.units += r.centralUnits;
  }
  return out;
}
