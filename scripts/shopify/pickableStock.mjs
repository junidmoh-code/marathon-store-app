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
// THE OLD SINGLE PIECE WITH NOTHING BEHIND IT (Junid's rule, 24 Nov 2026 — it
// REPLACES the 14-day Marathon PE "lone stale piece" rule PR #980 shipped, which
// took 249 sizes off sale in Black Friday week). A size stops being sold on the
// website only when ALL of these hold:
//   1. every place that holds it shows a SINGLE piece;
//   2. each of those pieces has been untouched for `days` or more (60);
//   3. there is no refill pipeline behind it: nothing at Central, at a hub, in
//      a stockroom or in transit. (An open refill request with nothing behind
//      it has nothing to send, and one already sent shows as stock in transit
//      or as a movement on the shelf — which ends rule 2 by itself — so the
//      request list is not read; that keeps this module out of request data.)
// A place is "a shop" when it is in SHOP_LOCATIONS; any other location holding
// a piece is the pipeline. Measured (docs/audits/web-unavailable-2026-11-24,
// "Single pieces by time untouched"): a lone piece fails 12% of the time when
// it moved in the last 14 days and about 40% from 14 days on, with no further
// rise at 60 or 90 — so 60 days is not a sharper line than 14; what makes this
// rule narrow is conditions 1 and 3, which leave the piece on sale whenever
// any other piece or any refill could still serve the order.
// It comes back by itself the moment a shelf is touched or stock arrives.
// Such a piece is not COUNTED for the website; routing still sends to it (a
// doubtful shelf is asked last, routing.mjs).
//   /config/onlineOrders/pickable/oldSingle = { off?: true, days?: 60 }
//
// PURE. The readers are at the bottom; a failed read never stops a push or a
// route (the hold is then not applied — today's behaviour — and it is logged).

export const CELL_HOLDS_PATH = "online_cell_holds";
export const PICKABLE_CONFIG_PATH = "config/onlineOrders/pickable";
export const HOLD_KINDS = Object.freeze(["hub_out_of_stock", "shop_not_found", "shelf_check"]);

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
export const OLD_SINGLE_DEFAULT = Object.freeze({ days: 60 });
/** The places a customer-facing piece sits on a floor. Anything else holding a piece is the refill pipeline. */
export const SHOP_LOCATIONS = Object.freeze(["marathon-pe", "trophy", "concrete", "marathon-pine"]);

export function rulesFrom(config) {
  const c = config && typeof config === "object" ? config : {};
  const os = c.oldSingle && typeof c.oldSingle === "object" ? c.oldSingle : {};
  const days = Number(os.days);
  return {
    holds: c.holdsOff !== true,
    // Retired 24 Nov 2026 (see the header). The key stays so an old caller reads "no such rule".
    staleSingle: null,
    oldSingle: os.off === true ? null : { days: Number.isFinite(days) && days >= 1 ? days : OLD_SINGLE_DEFAULT.days },
  };
}

/**
 * The sizes of one product that are old single pieces with nothing behind them. PURE.
 *   tree  { [locationId]: { [pid]: { [sizeKey]: cell } } }
 * → Map(sizeKey → [{ loc, at }])  the shop cells to leave out, per size
 * A cell with no `updatedAt` gives no evidence of its age: its size is not caught.
 */
export function oldSingleSizes(tree, pid, rule, nowMs) {
  const out = new Map();
  if (!rule || !tree || !Number.isFinite(nowMs)) return out;
  const bySize = new Map();
  for (const [loc, perProduct] of Object.entries(tree)) {
    const cells = perProduct?.[pid];
    if (!cells || typeof cells !== "object") continue;
    for (const [sizeKey, cell] of Object.entries(cells)) {
      const qty = cellQty(cell);
      if (qty <= 0) continue;
      if (!bySize.has(sizeKey)) bySize.set(sizeKey, []);
      bySize.get(sizeKey).push({ loc, qty, at: cellStampMs(cell) });
    }
  }
  for (const [sizeKey, holders] of bySize) {
    const caught = holders.every((h) => SHOP_LOCATIONS.includes(h.loc) && h.qty === 1 && h.at != null && nowMs - h.at >= rule.days * 864e5);
    if (caught) out.set(sizeKey, holders.map((h) => ({ loc: h.loc, at: h.at })));
  }
  return out;
}

/**
 * One product's stock tree with the unpickable cells emptied.
 *   tree       { [locationId]: { [pid]: { [sizeKey]: cell } } } — what networkTotals takes
 *   holdsNode  /online_cell_holds/{pid}
 * → { tree, hidden: [{ loc, sizeKey, qty, why, at }] }. `tree` is a new object
 * (the input is not mutated) and is the input itself when nothing is hidden.
 */
export function pickableTree(tree, pid, holdsNode, rules = rulesFrom(null), nowMs = Date.now(), pipeline = null) {
  const hidden = [];
  const holds = rules?.holds && holdsNode && typeof holdsNode === "object" ? holdsNode : null;
  // `pipeline`: the cells the website never counts (in transit, a stockroom) — read only to answer "is anything
  // behind this size?". They are judged with the tree and never returned in it.
  const old = pipeline === PIPELINE_UNKNOWN ? new Map() : oldSingleSizes(pipeline ? { ...pipeline, ...tree } : tree, pid, rules?.oldSingle || null, nowMs);
  if (!tree || (!holds && !old.size)) return { tree, hidden };
  const out = {};
  for (const [loc, perProduct] of Object.entries(tree)) {
    const cells = perProduct?.[pid];
    if (!cells || typeof cells !== "object") { out[loc] = perProduct; continue; }
    let next = cells;
    for (const [sizeKey, cell] of Object.entries(cells)) {
      const hold = holds?.[sizeKey]?.[loc];
      const held = !!hold && holdStands(hold, cell);
      const lone = !held && (old.get(sizeKey) || []).some((h) => h.loc === loc);
      if (!held && !lone) continue;
      if (next === cells) next = { ...cells };
      next[sizeKey] = typeof cell === "object" ? { ...cell, qty: 0 } : 0;
      hidden.push(held
        ? { loc, sizeKey, qty: cellQty(cell), why: hold.kind || "rejected", at: Number(hold.at) }
        : { loc, sizeKey, qty: 1, why: "old_single", at: cellStampMs(cell) });
    }
    out[loc] = next === cells ? perProduct : { ...perProduct, [pid]: next };
  }
  return hidden.length ? { tree: out, hidden } : { tree, hidden };
}

/** Where the daily shelf check looks for lone pieces: the shop floors and the hubs (functions/webShelf/lib.cjs). */
export const CHECK_SINGLE_LOCATIONS = Object.freeze([...SHOP_LOCATIONS, "hub1", "hub2", "hub3"]);

/**
 * The lone pieces of one product, for the daily shelf-check list. PURE.
 * → [{ loc, sizeKey, at }] — a shop or hub cell showing exactly one piece of a size the listing carries, with a stamp.
 */
export function loneCells(tree, pid, sizes) {
  const out = [];
  const listed = new Set(sizes || []);
  for (const loc of CHECK_SINGLE_LOCATIONS) {
    const cells = tree?.[loc]?.[pid];
    if (!cells || typeof cells !== "object") continue;
    for (const [sizeKey, cell] of Object.entries(cells)) {
      const at = cellStampMs(cell);
      if (cellQty(cell) === 1 && at != null && listed.has(sizeKey)) out.push({ loc, sizeKey, at });
    }
  }
  return out;
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

/** The places the website never counts but that ARE a refill pipeline (inventory.mjs UNSELLABLE_LOCATIONS). */
export const PIPELINE_ONLY_LOCATIONS = Object.freeze(["in_transit", "concrete-stockroom"]);

/**
 * { [loc]: { [pid]: cells } } for the pipeline-only places: two exact reads per product, only while the old-single
 * rule is on. A failed read counts as "something is behind it" for every size (the rule then hides nothing).
 */
export async function readPipeline(get, pid, rules) {
  if (!rules?.oldSingle) return null;
  const out = {};
  for (const loc of PIPELINE_ONLY_LOCATIONS) {
    try { const cells = await get(`stock/${loc}/${pid}`); if (cells) out[loc] = { [pid]: cells }; }
    catch (e) { console.error(`  ⚠ ${pid}: ${loc} unreadable (${String(e?.message || e)}) — the old-single rule is not applied to it`); return PIPELINE_UNKNOWN; }
  }
  return out;
}
/** Passed as `pipeline` when it could not be read: pickableTree then leaves the old-single rule off for the product. */
export const PIPELINE_UNKNOWN = Object.freeze({ unknown: true });

/** /online_cell_holds/{pid}; null when there are none or the read failed (logged). */
export async function readCellHolds(get, pid) {
  try {
    return (await get(`${CELL_HOLDS_PATH}/${pid}`)) || null;
  } catch (e) {
    console.error(`  ⚠ ${pid}: shelf holds unreadable (${String(e?.message || e)}) — counted without them`);
    return null;
  }
}
