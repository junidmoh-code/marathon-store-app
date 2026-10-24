// ─── SALE ROWS NEVER ASK PAST THE POLICY (incident 2026-10-24) ───────────────
// A sale-driven row's quantity is a COUNT OF EVENTS, not a count of pairs that
// left the shelf: today's rows count /restock_log entries, a past day's rows
// count "ready" order events (insights.restockCountsFromLog). One customer
// order placed and marked ready three times on 23 Oct — the same ten pairs —
// therefore asked Central for ×3 of every size, while a single POS sale took
// one pair of each. Overnight those stragglers surfaced as "Air Jordan 1 ×3 on
// sizes 7–11, waiting since 00:00" (past-day rows are dated at the SA day
// start), and four of them were sent ×3 before anyone noticed.
//
// THE RULE. For a FOOTWEAR line at a hub where Junid's per-size policy
// resolves a keep, the sale rows of one cell may together ask for no more than
//
//     room = max(0, keep − on hand at the hub − open requests for the cell)
//
// — the same "target − on hand − in transit" the engine plans with. Rows are
// served oldest first (the order they would be picked in); what is left over
// is trimmed. A row the room cannot reach at all is moved to `covered`, shown
// as "already covered" with its evidence, never silently dropped.
//
// WHAT IT NEVER DOES. It never RAISES a quantity, never touches a clothing
// line, and never caps a cell whose keep does not resolve to a positive number
// (no policy, a garbled entry, a product the catalogue cannot place). Those
// rows pass through byte-identical — the conservative direction is the old
// behaviour, not a guess. Units already sent on a row are never taken back:
// the cap applies to what is still to send.
//
// THE KEEP IS THE ENGINE'S. seatingCore.resolveTarget is the browser twin of
// refill-engine.cjs resolveTarget (differential-fuzzed), so an explicit
// /stock_targets row wins over the footwear-all group exactly as it does in
// the engine. One deliberate difference, stated: the dead-size rule (a size
// with zero units anywhere resolves keep 0) is answered as "units exist",
// because a sale row exists only because a pair of that size just left this
// hub. Without that, a hub cell sold to zero would read as a dead size, the
// keep would resolve 0, and the cap would switch itself off exactly when the
// row matters most. An explicit row of 0 still caps to 0 — that is a decision.
//
// ═══ THE SCAN OWNS A POLICY CELL (Junid, 24 Oct 2026) ═══════════════════════
// "A refill request is raised ONLY by the scan comparing what is on hand
// against policy." With `scanOnly`, a footwear cell whose keep resolves is the
// hourly scan's: its sale rows are never pickable work, whatever the room —
// they move to `covered` (evidence `scan: true`), and the scan asks for the
// size when on hand falls to the policy's ask-at point. The room arithmetic
// above stays as the backstop for callers that do not pass `scanOnly`.
import { resolveTarget, engineSizeKey } from "./seatingCore";
import { productIsFootwear, sizeLooksLikeShoe } from "../../utils/footwearLine";

const SOLD_MARK = "__sale_row__";

// The footwear-all group's eight members. footwearLine's cross-app list is the
// seven POS keys; designer-shoes is the eighth member of Junid's group, so it
// is named here rather than widening the shared contract.
const isPolicyFootwearLine = (product, size) =>
  sizeLooksLikeShoe(size) && (productIsFootwear(product) || product?.categoryKey === "designer-shoes");

/**
 * The keep for one (dest, product, size) under the live policy, or null when
 * none resolves.
 *
 * @param ctx { config, productsById: Map, destCells: decoded {pid:{size:cell}},
 *              explicitRows: { pid: { sizeKey: row } } | null }
 */
export function policyKeepFor(ctx, dest, pid, size) {
  const product = ctx.productsById?.get(pid);
  if (!product || !isPolicyFootwearLine(product, size)) return null;
  const k = engineSizeKey(size);
  // A sale row also proves the hub CARRIES the product: if its cells have not
  // loaded (or hold no row for it yet), seat one empty cell so the carriedOnly
  // gate does not switch the cap off while the screen is still loading.
  const destCells = ctx.destCells?.[pid] ? ctx.destCells : { ...(ctx.destCells || {}), [pid]: { [k]: { qty: 0 } } };
  const stock = {
    [dest]: destCells,
    // The dead-size answer — see the header. One unit of exactly this size,
    // at a location no policy names.
    [SOLD_MARK]: { [pid]: { [k]: { qty: 1 } } },
  };
  const t = resolveTarget({
    targets: ctx.explicitRows?.[pid] ? { [dest]: { [pid]: ctx.explicitRows[pid] } } : {},
    config: ctx.config || {},
    products: { [pid]: product },
    stock,
  }, dest, pid, size);
  if (!t || typeof t.target !== "number" || !Number.isFinite(t.target)) return null;
  if (t.source === "explicit") return Math.max(0, t.target);
  if (t.source !== "category_policy" && t.source !== "footwear_default") return null;
  return t.target > 0 ? t.target : null;
}

const onHandAt = (destCells, pid, size) => {
  const want = engineSizeKey(size);
  for (const [k, cell] of Object.entries(destCells?.[pid] || {})) {
    if (k === "_meta") continue;
    if (engineSizeKey(k) === want) return Math.max(Number(cell?.qty) || 0, 0);
  }
  return 0;
};

/**
 * Cap sale rows to the policy room of their cell.
 *
 * @param saleRows  pendingSaleRows output (qty = asked, sent = already sent)
 * @param requests  open request rows for the same destination ({productId, size, qty});
 *                  qty is the REMAINDER still to come (sent units already left it)
 * @param keepFor   (pid, size) → number | null  (policyKeepFor bound to a ctx)
 * @param destCells decoded hub cells
 * @param scanOnly  true → a cell whose keep resolves asks NOTHING here (the scan owns it)
 * @returns { rows, covered } — `rows` keeps the input order; a trimmed row
 *          carries `policyCap: { asked, keep, onHand, inbound }`. Every input
 *          row lands in exactly one of the two lists.
 */
export function capSaleRowsToPolicy(saleRows = [], { requests = [], keepFor, destCells = {}, scanOnly = false } = {}) {
  const inboundByCell = new Map();
  for (const r of requests || []) {
    if (!r || !r.productId || r.size == null) continue;
    const key = `${r.productId}|${engineSizeKey(r.size)}`;
    // A REQUEST row's qty is already the remainder (a partial send lowers qty
    // and raises sentQty), unlike a sale row's qty, which is the total asked.
    const left = Math.max(Number(r.qty) || 1, 0);
    inboundByCell.set(key, (inboundByCell.get(key) || 0) + left);
  }
  const decision = new Map();       // rowKey → { give, ev } for capped cells
  const byCell = new Map();
  for (const row of saleRows || []) {
    if (!row || !row.productId || row.size == null) continue;
    const key = `${row.productId}|${engineSizeKey(row.size)}`;
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(row);
  }
  for (const [key, rows] of byCell) {
    const { productId, size } = rows[0];
    const keep = keepFor ? keepFor(productId, size) : null;
    if (typeof keep !== "number" || !Number.isFinite(keep) || keep < 0) continue;
    const onHand = onHandAt(destCells, productId, size);
    const inbound = inboundByCell.get(key) || 0;
    let room = scanOnly ? 0 : Math.max(0, keep - onHand - inbound);
    const ordered = [...rows].sort((a, b) => (a.createdMs - b.createdMs) || String(a.rowKey).localeCompare(String(b.rowKey)));
    for (const row of ordered) {
      const remaining = Math.max((Number(row.qty) || 1) - (Number(row.sent) || 0), 0);
      const give = Math.min(remaining, room);
      room -= give;
      if (give < remaining || scanOnly) decision.set(row.rowKey, { give, ev: { asked: Number(row.qty) || 1, keep, onHand, inbound, ...(scanOnly ? { scan: true } : {}) } });
    }
  }
  const out = [];
  const covered = [];
  for (const row of saleRows || []) {
    const d = row && decision.get(row.rowKey);
    if (!d) { out.push(row); continue; }
    if (d.give === 0 || scanOnly) covered.push({ ...row, policyCap: d.ev });
    else out.push({ ...row, qty: (Number(row.sent) || 0) + d.give, policyCap: d.ev });
  }
  return { rows: out, covered };
}
