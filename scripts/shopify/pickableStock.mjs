// ─── WHAT THE WEBSITE MAY COUNT: pieces a shop or hub can actually pick ──────
//
// Junid, 24 Nov 2026 (docs/audits/web-unavailable-2026-11-24/REPORT.md). Since
// order #1768, 231 of 1,285 website lines were rejected at least once, and 46
// of the failures were the SAME size sold again from a shelf that had already
// said "not here": a hub's Out of Stock or a shop's Not found on a website pick
// changed nothing, so the app went on showing the piece and the website went
// on selling it.
//
// THE RULE. When a place rejects a website pick, the pieces the app shows at
// that one cell (product, size, place) are NOT counted for the website and are
// NOT routed to, until something touches the cell again: a sale, a delivery, a
// transfer, a count. Any of those means a person handled that shelf after the
// rejection, and the count is trusted again. Nothing here changes a count:
// stock still leaves a location only through a sale. The hold is a note beside
// the stock, read by the two things that promise a piece to a web customer
// (the website quantity and the order router).
//
//   /online_cell_holds/{pid}/{sizeKey}/{locationId} =
//       { at, kind: "hub_out_of_stock" | "shop_not_found", orderId, line, qty?, by? }
//
// `at` is server time. The hold STANDS while the cell still shows a piece and
// its own `updatedAt` stamp (written by every stock movement) is not later
// than `at`. It needs no clean-up to stop applying: the next movement on the
// cell ends it by itself. cell-holds.mjs --prune removes the dead rows.
//
// Kill switch: /config/onlineOrders/pickable/holdsOff = true (read by every
// tick; a long-running process picks it up within a minute).
//
// THE LONE STALE PIECE (same report, section 3). The one clearly defined class
// that fails more often than it succeeds: a cell at Marathon PE showing exactly
// ONE piece whose count has not moved for more than 14 days — 54 website lines
// were sent to such a cell and 31 (57%) were rejected. Junid's bar for hiding a
// class is at least 10 lines with at least half unavailable; no other place
// reaches it (Hub 1 42%, Trophy 37%, Hub 2 34%), so only Marathon PE is listed.
// Such a piece is not COUNTED for the website. It is still routed to: when it
// is the only one on the route, a pick that works 43% of the time is better
// than a line that waits for nothing. It comes back by itself the moment the
// cell moves (a sale, a delivery, a count).
//   /config/onlineOrders/pickable/staleSingle = { off?: true, days?: 14, locations?: ["marathon-pe"] }
//
// PURE. The readers are at the bottom; a failed read never stops a push or a
// route (the hold is then not applied — today's behaviour — and it is logged).

export const CELL_HOLDS_PATH = "online_cell_holds";
export const PICKABLE_CONFIG_PATH = "config/onlineOrders/pickable";
export const HOLD_KINDS = Object.freeze(["hub_out_of_stock", "shop_not_found"]);

/** Units a stock cell shows (a bare number is tolerated for old data). */
export const cellQty = (cell) => Math.max(0, Number(cell !== null && typeof cell === "object" ? cell.qty : cell) || 0);

/** When the cell last moved, in ms; null when it carries no stamp. */
export function cellStampMs(cell) {
  const t = cell !== null && typeof cell === "object" ? Date.parse(cell.updatedAt) : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * Does this hold still take the cell's pieces off the website?
 * Not when the cell is empty (nothing to hide) or has moved since the rejection.
 * A cell with no stamp at all has never been moved by the ledger: the hold stands.
 */
export function holdStands(hold, cell) {
  const at = Number(hold?.at);
  if (!Number.isFinite(at) || at <= 0) return false;
  if (cellQty(cell) <= 0) return false;
  const stamp = cellStampMs(cell);
  return stamp == null || stamp <= at;
}

/** /config/onlineOrders/pickable → the rules in force. Absent = the defaults. */
export const STALE_SINGLE_DEFAULT = Object.freeze({ days: 14, locations: Object.freeze(["marathon-pe"]) });

export function rulesFrom(config) {
  const c = config && typeof config === "object" ? config : {};
  const st = c.staleSingle && typeof c.staleSingle === "object" ? c.staleSingle : {};
  const days = Number(st.days);
  const locations = Array.isArray(st.locations) ? st.locations.filter((l) => typeof l === "string" && l) : null;
  return {
    holds: c.holdsOff !== true,
    staleSingle: st.off === true ? null : {
      days: Number.isFinite(days) && days >= 1 ? days : STALE_SINGLE_DEFAULT.days,
      locations: locations && locations.length ? locations : [...STALE_SINGLE_DEFAULT.locations],
    },
  };
}

/**
 * Is this cell a lone piece nobody has touched for longer than the rule allows?
 * Needs a real stamp: a cell with no `updatedAt` gives no evidence of its age and is counted.
 */
export function isStaleSingle(cell, loc, rule, nowMs) {
  if (!rule || !rule.locations.includes(loc) || cellQty(cell) !== 1) return false;
  const stamp = cellStampMs(cell);
  return stamp != null && Number.isFinite(nowMs) && nowMs - stamp > rule.days * 864e5;
}

/**
 * One product's stock tree with the unpickable cells emptied.
 *   tree       { [locationId]: { [pid]: { [sizeKey]: cell } } } — what networkTotals takes
 *   holdsNode  /online_cell_holds/{pid}
 * → { tree, hidden: [{ loc, sizeKey, qty, why, at }] }. `tree` is a new object
 * (the input is not mutated) and is the input itself when nothing is hidden.
 */
export function pickableTree(tree, pid, holdsNode, rules = rulesFrom(null), nowMs = Date.now()) {
  const hidden = [];
  const holds = rules?.holds && holdsNode && typeof holdsNode === "object" ? holdsNode : null;
  const stale = rules?.staleSingle || null;
  if (!tree || (!holds && !stale)) return { tree, hidden };
  const out = {};
  for (const [loc, perProduct] of Object.entries(tree)) {
    const cells = perProduct?.[pid];
    if (!cells || typeof cells !== "object") { out[loc] = perProduct; continue; }
    let next = cells;
    for (const [sizeKey, cell] of Object.entries(cells)) {
      const hold = holds?.[sizeKey]?.[loc];
      const held = !!hold && holdStands(hold, cell);
      if (!held && !isStaleSingle(cell, loc, stale, nowMs)) continue;
      if (next === cells) next = { ...cells };
      next[sizeKey] = typeof cell === "object" ? { ...cell, qty: 0 } : 0;
      hidden.push(held
        ? { loc, sizeKey, qty: cellQty(cell), why: hold.kind || "rejected", at: Number(hold.at) }
        : { loc, sizeKey, qty: 1, why: "stale_single", at: cellStampMs(cell) });
    }
    out[loc] = next === cells ? perProduct : { ...perProduct, [pid]: next };
  }
  return hidden.length ? { tree: out, hidden } : { tree, hidden };
}

/** Is one cell under a standing hold? (the router's question, one size at a time) */
export function cellHeld(holdsForSize, loc, cell, rules = rulesFrom(null)) {
  if (!rules?.holds) return false;
  const hold = holdsForSize && typeof holdsForSize === "object" ? holdsForSize[loc] : null;
  return !!hold && holdStands(hold, cell);
}

const keyOk = (k) => typeof k === "string" && k !== "" && !/[.#$[\]/]/.test(k);

/** The row a rejection writes, or null when it cannot be keyed. */
export function holdRow({ pid, sizeKey, loc, at, kind, orderId, line, qty = null, by = null }) {
  if (!keyOk(pid) || !keyOk(sizeKey) || !keyOk(loc) || !HOLD_KINDS.includes(kind)) return null;
  const t = Number(at);
  if (!Number.isFinite(t) || t <= 0) return null;
  const value = { at: t, kind, orderId: String(orderId ?? ""), line: Number(line) || 0 };
  if (Number.isFinite(Number(qty)) && qty != null) value.qty = Number(qty);
  if (by) value.by = String(by);
  return { path: `${CELL_HOLDS_PATH}/${pid}/${sizeKey}/${loc}`, value };
}

// ── Readers (exact paths, tiny nodes) ────────────────────────────────────────
let rulesCache = null; // { at, rules } — the config is read at most once a minute per process

/** The rules in force, read from the config node (cached for a minute). */
export async function readPickableRules(get, nowMs = Date.now()) {
  if (rulesCache && nowMs - rulesCache.at < 60e3) return rulesCache.rules;
  let rules;
  try {
    rules = rulesFrom(await get(PICKABLE_CONFIG_PATH));
  } catch (e) {
    console.error(`  ⚠ ${PICKABLE_CONFIG_PATH} unreadable (${String(e?.message || e)}) — the default rules apply`);
    rules = rulesFrom(null);
  }
  rulesCache = { at: nowMs, rules };
  return rules;
}

/** Test seam: forget the cached rules. */
export function forgetPickableRules() { rulesCache = null; }

/** /online_cell_holds/{pid}; null when there are none or the read failed (logged). */
export async function readCellHolds(get, pid) {
  try {
    return (await get(`${CELL_HOLDS_PATH}/${pid}`)) || null;
  } catch (e) {
    console.error(`  ⚠ ${pid}: shelf holds unreadable (${String(e?.message || e)}) — counted without them`);
    return null;
  }
}
