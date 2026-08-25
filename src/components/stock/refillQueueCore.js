// ─── UNIFIED REFILL QUEUE — the pure core (owner spec 2026-08-08) ────────────
// ONE LIST, ONE DESIGN. Every ask a hub can act on is an ordinary request line:
// engine requests, Missing Sneakers requests, former customer holds (now just
// /refill_requests rows — nothing marks them), and the sale-driven restock
// cells ("today's requests" and the past-day stragglers). All of them render
// through the same row component with the same actions (Fulfil / Out of
// Stock) and ALL of them queue behind the same release windows — no category
// and no origin is exempt.
//
// This module is the React-free half: turning the sale-driven feeds into rows
// that are shape-compatible with /refill_requests rows (createdAt drives the
// release-window gate), plus the one-line status text the queue shows instead
// of the old stack of banners. Testable without a browser.

import { sourceGroupKey } from "../../utils/insights";
import { sourceMovementIdSeed } from "./sourceMovementDedupe";
import { encodeSizeKey } from "../../utils/sizeKey";

/**
 * Earliest sale timestamp per (groupKey, size) from restock_log entries.
 * The release-window gate needs a "raised at" instant for a sale-driven cell;
 * the EARLIEST sale is the honest one — released stays released (a later sale
 * adding a unit to an already-visible row must never re-hide it, mirroring the
 * monotonic rule in releaseWindows.js).
 */
export function earliestSaleTs(entries) {
  const out = {};
  (entries || []).forEach((e) => {
    if (!e || !e.size) return;
    const ms = Date.parse(e.timestamp || "");
    if (!Number.isFinite(ms)) return;
    const key = sourceGroupKey(e.productId, e.productName || "Unknown");
    if (!out[key]) out[key] = {};
    const cur = out[key][e.size];
    if (cur == null || ms < cur) out[key][e.size] = ms;
  });
  return out;
}

/**
 * Flatten a rawCounts group map (computeRestockCounts / restockCountsFromLog
 * shape) into pending sale rows the unified queue can render next to request
 * rows. Responded cells drop out (dual-read: pid key first, legacy name key
 * for pre-cutover responses). `tsBySize` dates today's cells for the window
 * gate; absent (past days) falls back to `fallbackMs` — the day itself, which
 * always predates the last release, so stragglers are always released.
 */
export function pendingSaleRows({ counts, responses, progress, date, tsBySize = null, fallbackMs, cellFilter = null }) {
  const rows = [];
  Object.entries(counts || {}).forEach(([key, product]) => {
    const legacyKey = product.nameKey && product.nameKey !== key ? product.nameKey : null;
    Object.entries(product.sizes || {}).forEach(([size, count]) => {
      const n = typeof count === "number" ? count : 1;
      if (responses?.[key]?.[size] || (legacyKey && responses?.[legacyKey]?.[size])) return;
      if (cellFilter && !cellFilter(key, product, size)) return;
      const sent = Math.max(
        progress?.[key]?.[size]?.fulfilledQty || 0,
        legacyKey ? (progress?.[legacyKey]?.[size]?.fulfilledQty || 0) : 0,
      );
      const createdMs = tsBySize?.[key]?.[size] ?? fallbackMs;
      rows.push({
        origin: "sale",
        rowKey: `sale:${date}:${key}:${size}`,
        date, key, legacyKey,
        productId: product.productId || null,
        productName: product.productName,
        photo: product.photo || "",
        photoUrl: product.photoUrl || null,
        size: String(size),
        qty: n,
        sent,
        createdMs,
        // The release-window gate (releaseWindows.isReleased) reads createdAt.
        createdAt: new Date(createdMs).toISOString(),
        // Idempotent movement identity — same seeds the Source fulfil panel has
        // always used, so a partial send survives this redesign untouched.
        movementIdSeed: sourceMovementIdSeed(date, key, encodeSizeKey(size)),
        legacyMovementIdSeed: legacyKey ? sourceMovementIdSeed(date, legacyKey, encodeSizeKey(size)) : null,
      });
    });
  });
  return rows;
}

/**
 * The ONE status line (owner spec 2026-08-08: the page's job is "here is what
 * to pick, or here is when the next batch lands" — nothing else competes).
 * Everything the old chrome said — release times, waiting backlog, covered
 * requests — compresses into this sentence.
 */
// UNITS travel with the line counts (owner ask 2026-08-25): "what's coming"
// must say the total QUANTITY across individual sizes, not just how many
// lines — "12 waiting · 29 units" is 29 pairs to shelve, whatever the split.
export function queueStatusLine({ pickCount, pickUnits = null, waitingCount, waitingUnits = null, coveredCount, windowsDisabled, nextLabel }) {
  const withUnits = (count, noun, units) =>
    typeof units === "number" ? `${count} ${noun} (${units} unit${units === 1 ? "" : "s"})` : `${count} ${noun}`;
  const bits = [];
  if (pickCount > 0) {
    bits.push(withUnits(pickCount, "to pick", pickUnits));
    if (!windowsDisabled) bits.push(`next batch ${nextLabel}`);
  } else if (!windowsDisabled) {
    bits.push(`Nothing to pick — next batch lands ${nextLabel}`);
  } else {
    bits.push("Nothing to pick");
  }
  if (!windowsDisabled && waitingCount > 0) bits.push(withUnits(waitingCount, "waiting", waitingUnits));
  if (coveredCount > 0) bits.push(`${coveredCount} already covered by stock`);
  return bits.join(" · ");
}

/** Oldest first — the longest-waiting ask belongs at the top of the screen. */
export function sortQueueRows(rows) {
  return [...rows].sort((a, b) => {
    const am = Number.isFinite(a.createdMs) ? a.createdMs : Date.parse(a.createdAt || "") || Infinity;
    const bm = Number.isFinite(b.createdMs) ? b.createdMs : Date.parse(b.createdAt || "") || Infinity;
    return am - bm;
  });
}

/**
 * Group queue rows by PRODUCT for a compact card — "one product, its sizes as
 * lines" (owner ask 2026-08-25: the 06:00 waiting preview reads "6 ×2 · 7 ×2"
 * under one photo, the same shape the pick list already renders). Pure and
 * order-preserving: groups keep the order rows arrived in; each group carries
 * the OLDEST raise for the age pill, exactly like the pick-card grouping.
 */
export function groupRowsByProduct(rows) {
  const byKey = new Map();
  for (const row of rows || []) {
    const k = row.productId || `name:${row.productName}`;
    if (!byKey.has(k)) {
      byKey.set(k, { key: k, productName: row.productName, photoUrl: row.photoUrl || null, photo: row.photo || "",
                     rows: [], oldestMs: Infinity, oldestIso: null });
    }
    const g = byKey.get(k);
    g.rows.push(row);
    if (!g.photoUrl && row.photoUrl) g.photoUrl = row.photoUrl;
    const m = Number.isFinite(row.createdMs) ? row.createdMs : Date.parse(row.createdAt || "");
    if (Number.isFinite(m) && m < g.oldestMs) { g.oldestMs = m; g.oldestIso = row.createdAt; }
  }
  return [...byKey.values()];
}
