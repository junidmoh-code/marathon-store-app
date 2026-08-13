// ─── SPECIALS — PURE CORE & THE NODE CONTRACT ────────────────────────────────
// A special is a temporary retail price. While it runs, the product's
// products/{id}/retailPrice IS the special price — so the POS (which strikes
// retailPrice in cents at add-to-cart) charges it with NO POS change — and the
// pre-special price is parked, exactly, at /specials/{id}/wasPrice. Ending the
// special writes wasPrice back. Both transitions are one atomic audited price
// batch (special_start / special_end) through priceStore.
//
// ── THE NODE (cross-app contract — TV + sale screen read this) ───────────────
//   /specials/{productId} = {
//     name,                    // display copy — read-only for consumers
//     photoUrl,                // "" when the product has no photo
//     price,                   // the special retail price, rands
//     wasPrice,                // pre-special retailPrice, rands — null if the
//                              //   product had no retail price (flagged in the
//                              //   preview); restored verbatim at end
//     startedAt, startedBy, startedByEmail,
//     plannedEndAt,            // ISO date or null — ADVISORY ONLY, see below
//     batchId,                 // the special_start batch that created this
//   }
// Small on purpose: one compact record per ACTIVE special, deleted at end —
// the always-on TV subscribes to /specials whole, so its size IS the
// bandwidth bill (measured in specials.test.js). History lives in
// /price_history, not here. No PII — the TV session is anonymous.
// Consumers: sort by startedAt desc; render price and wasPrice as rands;
// treat unknown extra fields as ignorable.
//
// ── HOW A SPECIAL ENDS: EXPLICIT REMOVAL ONLY ────────────────────────────────
// Ending a special WRITES money state (retailPrice = wasPrice), and a write
// needs an actor and an audit line. An enforced end DATE would need either a
// Cloud Function (out of scope for this batch — functions changes are a
// stop-and-report) or every reader sweeping the node client-side, which
// restores nothing and leaves the till charging the special forever. So the
// operator ends specials on the card; plannedEndAt is an advisory label the
// card sorts by and flags as OVERDUE — the reminder, not the mechanism.

import { asStoredPrice } from "./priceBatch";
import { roundPrice } from "./bulkPricing";

/**
 * Plan to START specials: `mode` is "percent" (ONE % off, e.g. 20 ⇒ -20% on
 * the current retail, whole-rand rounded) or "absolute" (ONE sale price for
 * every selected product). Returns { ok, error? } or
 * { ok, rows, lines, aux, entries, skippedOnSpecial, missingPrice, noop, count }.
 * rows feed BulkPricePreview; lines+aux feed applyPriceBatch verbatim.
 */
export function buildSpecialStartPlan({ products = [], specials = {}, selectedIds = [],
                                        mode = "percent", percentDraft = "", priceDraft = "",
                                        plannedEndAt = null,
                                        startedAt, startedBy = null, startedByEmail = null }) {
  let pct = null, abs = null;
  if (mode === "percent") {
    const n = Number(String(percentDraft ?? "").trim());
    if (!Number.isFinite(n) || n <= 0 || n >= 100) return { ok: false, error: "Enter a discount between 0 and 100 (e.g. 20 for 20% off)." };
    pct = n;
  } else if (mode === "absolute") {
    const n = Number(String(priceDraft ?? "").trim());
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "Enter a special price greater than 0." };
    abs = n;
  } else {
    return { ok: false, error: `Unknown mode "${mode}".` };
  }
  if (typeof startedAt !== "string" || !startedAt) return { ok: false, error: "Missing start stamp." };

  const byId = new Map(products.filter((p) => p && p.id).map((p) => [p.id, p]));
  const lines = {};
  const aux = [];
  const entries = {};
  const rows = [];
  const skippedOnSpecial = [];
  const missingPrice = [];
  const noop = [];
  const aboveRetail = [];
  for (const pid of selectedIds) {
    const p = byId.get(pid);
    if (!p) continue;
    if (specials[pid]) { skippedOnSpecial.push({ pid, name: p.name || pid }); continue; }
    const cur = asStoredPrice(p.retailPrice);
    let sale;
    if (pct !== null) {
      if (cur === null) { missingPrice.push({ pid, name: p.name || pid }); continue; }
      sale = roundPrice(cur * (1 - pct / 100));
    } else {
      sale = abs;
      // A "special" must never RAISE the shelf price (CodeRabbit, PR #355) —
      // one absolute price across a mixed selection can land above a cheaper
      // product's retail. Skip that product and say so in the preview.
      if (cur !== null && sale > cur) { aboveRetail.push({ pid, name: p.name || pid, cur, sale }); continue; }
    }
    if (sale === cur) { noop.push({ pid, name: p.name || pid }); continue; }
    const entry = {
      name: p.name || "", photoUrl: p.photoUrl || "",
      price: sale, wasPrice: cur,
      startedAt, startedBy, startedByEmail,
      plannedEndAt: plannedEndAt || null,
      batchId: null, // stamped by the store once the batchId is minted
    };
    lines[pid] = { name: p.name || "", from: { retailPrice: cur }, to: { retailPrice: sale } };
    aux.push({ path: `specials/${pid}`, from: null, to: entry });
    entries[pid] = entry;
    rows.push({ pid, name: p.name || pid, photoUrl: p.photoUrl || "", fromRetail: cur, toRetail: sale, ...(cur === null ? { badge: "no old price to restore" } : {}) });
  }
  return { ok: true, lines, aux, entries, rows, skippedOnSpecial, missingPrice, noop, aboveRetail, count: rows.length };
}

/**
 * Plan to END specials: retailPrice returns to the parked wasPrice, the
 * /specials entry is deleted. `from` records the LIVE retail price (should be
 * the special price; recorded honestly even if something bypassed the app).
 */
export function buildSpecialEndPlan({ products = [], specials = {}, selectedIds = [] }) {
  const byId = new Map(products.filter((p) => p && p.id).map((p) => [p.id, p]));
  const lines = {};
  const aux = [];
  const rows = [];
  const notOnSpecial = [];
  for (const pid of selectedIds) {
    const entry = specials[pid];
    if (!entry) { notOnSpecial.push({ pid }); continue; }
    const p = byId.get(pid);
    const cur = p ? asStoredPrice(p.retailPrice) : (typeof entry.price === "number" ? entry.price : null);
    const back = typeof entry.wasPrice === "number" && entry.wasPrice > 0 ? entry.wasPrice : null;
    lines[pid] = { name: entry.name || p?.name || "", from: { retailPrice: cur }, to: { retailPrice: back } };
    aux.push({ path: `specials/${pid}`, from: entry, to: null });
    rows.push({ pid, name: entry.name || p?.name || pid, photoUrl: entry.photoUrl || "", fromRetail: cur, toRetail: back });
  }
  if (rows.length === 0) return { ok: false, error: "Nothing selected is on special." };
  return { ok: true, lines, aux, rows, notOnSpecial, count: rows.length };
}

/** Bytes a subscriber downloads for the whole node — the TV's bill per load. */
export const specialsNodeBytes = (specialsNode) =>
  new TextEncoder().encode(JSON.stringify(specialsNode ?? {})).length;
