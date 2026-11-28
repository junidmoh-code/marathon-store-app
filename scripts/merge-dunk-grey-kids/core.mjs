// ─── MERGE ONE DUPLICATE KIDS' DUNK INTO ITS ORIGINAL (Junid, 28 Nov 2026) ───
// A new box of "Nike SB dunk low grey small" (845013-100) was added as a new
// product, "Nike dunk low  grey and white" (double space, no style code). This
// module is the PURE half of the three scripts beside it (investigate → plan →
// apply). It holds no merge logic of its own: the merge itself is the app's
// existing server-side merge, functions/lib/product-merge.cjs (performMerge),
// used UNCHANGED. What lives here:
//
//   • the size map (same labels → 1:1; anything else is left unmapped, never
//     guessed);
//   • the dry-run plan, built with the merge's own disposition rule
//     (merge-disposition.cjs planMerge), so the plan cannot disagree with what
//     the merge will do — and the check that the combined total is unchanged;
//   • the blockers: every open reference that must be dealt with before the
//     duplicate can be merged away;
//   • narrowDb: a wrapper that keeps performMerge off whole-node reads. It
//     reads /barcodes and /style_code_index WHOLE to find the loser's rows; the
//     wrapper answers those two reads with only the loser's rows, read by key
//     (/barcodes/{code} for each code on the loser) and by the indexed
//     productId query. Every other read and the one atomic update pass
//     straight through, except that each merge movement gains a `note` naming
//     this merge. The movement's `reason` stays "product_merge" — other code
//     matches that exact string (scripts/repair-fulfil-credit-gap.mjs).
//
// KNOWN LIMITS of narrowDb, both accepted for THIS pair (Sonnet review, #1029):
//   • /barcodes has no productId index, so a /barcodes row owned by the
//     duplicate but absent from its own `barcodes` map would be missed. Its
//     12 rows (00040275–00040286) all match its map, read one by one.
//   • style_code_index sibling entries naming the duplicate are not found by
//     the productId query. The duplicate has no style code (sameProductProblems
//     refuses one), and siblings are only added between products that share a
//     code, so there is none to miss.

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { planMerge } = require("../../functions/lib/merge-disposition.cjs");

export const KEEP_ID = "p1795103464793";       // "Nike SB dunk low grey small", 845013-100
export const REMOVE_ID = "p1795600675612";     // "Nike dunk low  grey and white", no code
export const KEEP_STYLE_NORMALISED = "845013100";
export const KEEP_NAME = "Nike SB dunk low grey small";
export const REMOVE_NAME = "Nike dunk low  grey and white";
export const MERGE_NOTE = "Merge duplicate: 'Nike dunk low grey and white' into 845013-100";

const asQty = (c) => (c && typeof c.qty === "number" ? c.qty : 0);

/** A stock node's size cells ("_meta" and non-objects are bookkeeping). */
export function sizeCells(node) {
  const out = {};
  if (!node || typeof node !== "object") return out;
  for (const [k, v] of Object.entries(node)) if (k !== "_meta" && v && typeof v === "object") out[k] = v;
  return out;
}

/**
 * Size map. Identical labels map 1:1. A label on the duplicate that the
 * original does not carry is UNMAPPED — no C/EU/TD/PS conversion is attempted,
 * because none is certain from labels alone. RTDB drops an empty array, so a
 * missing `sizes` reads as [].
 */
export function mapSizes(removeSizes, keepSizes) {
  const keep = new Set((Array.isArray(keepSizes) ? keepSizes : []).map(String));
  const pairs = [];
  const unmapped = [];
  for (const s of (Array.isArray(removeSizes) ? removeSizes : []).map(String)) {
    if (keep.has(s)) pairs.push({ from: s, to: s }); else unmapped.push(s);
  }
  return { pairs, unmapped };
}

/** Is this the same shoe, by the facts on the two records? Reasons it is not. */
export function sameProductProblems(keep, remove) {
  const out = [];
  if (!keep) out.push("The original no longer exists.");
  if (!remove) out.push("The duplicate no longer exists.");
  if (!keep || !remove) return out;
  if (keep.mergedInto) out.push("The original was itself merged away.");
  if (remove.mergedInto) out.push("The duplicate was already merged away.");
  if (keep.styleCodeNormalised !== KEEP_STYLE_NORMALISED) out.push(`The original's style code is ${keep.styleCodeNormalised || "missing"}, not ${KEEP_STYLE_NORMALISED}.`);
  if (remove.styleCodeNormalised) out.push(`The duplicate carries a style code (${remove.styleCodeNormalised}) — it may be a different shoe.`);
  if (keep.categoryKey !== remove.categoryKey) out.push(`Different categories: ${keep.categoryKey} vs ${remove.categoryKey}.`);
  if (keep.brand !== remove.brand) out.push(`Different brands: ${keep.brand} vs ${remove.brand}.`);
  return out;
}

/**
 * The dry run, per location and size, using the merge's own rule.
 * `keepStock` / `removeStock`: { loc: rawNode }. `countedByLoc`: { loc: Set }.
 */
export function buildPlan({ keepStock, removeStock, countedByLoc, sizeMap }) {
  const mapped = new Set(sizeMap.pairs.map((p) => p.from));
  const removeCells = {};
  for (const [loc, node] of Object.entries(removeStock || {})) removeCells[loc] = sizeCells(node);
  const disposition = planMerge({ loserId: REMOVE_ID, survivorId: KEEP_ID, loserCells: removeCells, countedByLoc: countedByLoc || {} });
  const removedKeys = new Set();
  for (const row of disposition) for (const c of row.remove) removedKeys.add(`${row.loc}/${c.sizeKey}`);

  const rows = [];
  const unmappedHeld = [];
  for (const [loc, cells] of Object.entries(removeCells)) {
    for (const [sizeKey, cell] of Object.entries(cells)) {
      const q = asQty(cell);
      const keepCell = sizeCells(keepStock?.[loc])[sizeKey] || null;
      const keepBefore = asQty(keepCell);
      if (!mapped.has(sizeKey) && q !== 0) unmappedHeld.push({ loc, size: sizeKey, qty: q });
      let action;
      if (q === 0) action = "empty-cell-dropped";
      else if (removedKeys.has(`${loc}/${sizeKey}`)) action = "counted-removal";
      else action = "transfer";
      rows.push({
        loc, size: sizeKey, duplicateQty: q, originalBefore: keepBefore,
        originalAfter: action === "transfer" ? keepBefore + q : keepBefore, action,
      });
    }
  }
  const sum = (stock) => Object.values(stock || {}).reduce((t, n) => t + Object.values(sizeCells(n)).reduce((a, c) => a + asQty(c), 0), 0);
  const keepTotal = sum(keepStock);
  const removeTotal = sum(removeStock);
  const keepAfter = keepTotal + rows.filter((r) => r.action === "transfer").reduce((a, r) => a + r.duplicateQty, 0);
  const negatives = rows.filter((r) => r.duplicateQty < 0);
  return {
    rows, unmappedHeld, negatives,
    countedRemovals: rows.filter((r) => r.action === "counted-removal"),
    totals: { keepBefore: keepTotal, removeBefore: removeTotal, combinedBefore: keepTotal + removeTotal, keepAfter, removeAfter: 0, combinedAfter: keepAfter },
    totalsUnchanged: keepTotal + removeTotal === keepAfter,
  };
}

/**
 * What stops the merge. Open references the merge does not carry over
 * itself (it carries barcodes, style-code claims and the duplicate-pair row)
 * must be resolved first, or the merge would leave live work pointing at a
 * hidden record. Each blocker is a sentence for the report.
 */
export function blockers({ problems, plan, refs }) {
  const out = [...(problems || [])];
  if (plan.unmappedHeld.length) out.push(`Sizes on the duplicate with no certain match on the original: ${plan.unmappedHeld.map((u) => `${u.loc} ${u.size}×${u.qty}`).join(", ")}.`);
  if (plan.countedRemovals.length) out.push(`The merge would write off ${plan.countedRemovals.length} cell(s) as already counted under the original, so the combined total would drop.`);
  if (plan.negatives.length) out.push(`The duplicate has negative cells: ${plan.negatives.map((n) => `${n.loc} ${n.size}=${n.duplicateQty}`).join(", ")}.`);
  if (!plan.totalsUnchanged) out.push("The combined total of the two products would change.");
  const r = refs || {};
  if (r.openRequests?.length) out.push(`${r.openRequests.length} open refill request(s) name the duplicate. The Refill Queue sends with the request's own product id, so after the merge each would try to send from the duplicate's Central cell, which the merge deletes. Re-pointing or cancelling them is a refill-request change: Junid decides (CLAUDE.md).`);
  if (r.displayRegister?.length) out.push(`${r.displayRegister.length} display-register slot(s) name the duplicate.`);
  if (r.countedRecords?.length) out.push(`${r.countedRecords.length} hub-count record(s) name the duplicate.`);
  if (r.shopifyPublish) out.push("The duplicate has a Shopify publish record.");
  if (r.attention?.length) out.push(`The duplicate is on Attention list(s): ${r.attention.join(", ")}.`);
  if (r.cellHolds) out.push("The duplicate has online shelf holds.");
  if (r.targets?.length) out.push(`The duplicate has stock targets at: ${r.targets.join(", ")} (policy rows — Junid decides).`);
  if (r.openDuplicatePairsOther?.length) out.push(`Other open duplicate pairs name the duplicate: ${r.openDuplicatePairsOther.join(", ")}.`);
  return out;
}

/**
 * Keep performMerge off whole-node reads, and put the note on its movements.
 * `barcodeCodes`: the codes on the duplicate's own `barcodes` map — the rows
 * performMerge would find by scanning /barcodes. A row in /barcodes for the
 * duplicate that is NOT on its map would be missed, so the caller reads each
 * mapped row first and the investigation states the gap.
 */
export function narrowDb(db, { loserId, barcodeCodes, note }) {
  const snap = (v) => ({ val: () => (v === undefined ? null : v), exists: () => v != null });
  const once = async (q) => (typeof q.get === "function" ? q.get() : q.once("value"));
  return {
    ref(path = "") {
      const p = String(path || "").replace(/^\/+|\/+$/g, "");
      if (p === "barcodes") {
        return { async get() {
          const out = {};
          for (const code of barcodeCodes) {
            const row = (await once(db.ref(`barcodes/${code}`))).val();
            if (row) out[code] = row;
          }
          return snap(Object.keys(out).length ? out : null);
        } };
      }
      if (p === "style_code_index") {
        return { async get() {
          return snap((await db.ref("style_code_index").orderByChild("productId").equalTo(loserId).once("value")).val());
        } };
      }
      const real = db.ref(p);
      if (p !== "") return real;
      return {
        ...real,
        async update(updates) {
          const withNote = { ...updates };
          for (const [k, v] of Object.entries(updates)) {
            if (k.startsWith("stock_movements/merge_") && v && typeof v === "object") withNote[k] = { ...v, note };
          }
          return real.update(withNote);
        },
      };
    },
  };
}
