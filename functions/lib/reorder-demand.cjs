// Marathon Club — Reorder DEMAND-DRIVEN reasoner (pure, no Firebase / no Anthropic).
//
// PHASE 3 — analyzeReorderNeeds becomes a PURE REASONER.
// ─────────────────────────────────────────────────────────────────────────────
// Before this, the function discovered demand INTERNALLY (aggregatePerProduct):
// it re-read /insights_log, re-derived sold/oos, capped the catalog at
// REORDER_TOP_N = 50, projected over a hardcoded 45-day cycle, and never counted
// out-of-stock events in the reorder quantity. Result: the planner saw ~31% of
// true demand — a plan suggesting 781 units when history showed ~4,865 sales +
// ~2,691 OOS.
//
// The fix (option b, locked in docs/PHASE3-REORDER-FUNCTION-SPEC.md in the
// marathon-ai repo): demand is computed ONCE, client-side, by the shared demand
// engine (marathon-ai/src/lib/demand.js → computeDemand), slimmed by
// buildReorderPayload (marathon-ai/src/lib/reorderPayload.js), and PASSED IN to
// this function under request.data.demand. This module reasons over those
// aggregates and produces the reorder plan. It NEVER re-aggregates sales, never
// caps the catalog, and counts OOS in every quantity.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE AGGREGATE INPUT CONTRACT (client → function)
// ─────────────────────────────────────────────────────────────────────────────
// request.data.demand, produced by buildReorderPayload(computeDemand(...)):
//
//   {
//     schemaVersion: 1,        // bump = breaking shape change; branch on it
//     window:     "all",       // demand window label ("all" | "30" | "60" | …)
//     windowDays: null,        // number | null  (null = all-time)
//     recentDays: 30,          // width of the recent-slice for recentSold/recentOos
//     nowMs:      1749…,       // client clock when computed (ms epoch)
//     cycleDays:  35,          // REORDER HORIZON — span earliest-sale → now,
//                              //   i.e. the REAL catalog window (NOT a hardcoded 45)
//     coverage:   { catalogTotal, salesEvents, oosEvents, requestEvents,
//                   matchedEvents, unmatchedEvents, matchedOosEvents,
//                   matchedProducts, unmatchedProducts, unmatchedNameCount,
//                   nameCollisions, coveragePct, productIdOnEvents:false },
//     totals:     { sold, oos, placed, returns, trueDemand },  // attributable
//     rows: [ {                // ONE ENTRY PER CATALOG PRODUCT — UNCAPPED
//       id, name,
//       sold, oos, placed,     // window-scoped RAW EVENT COUNTS
//       trueDemand,            //   = sold + oos (authoritative)
//       velocityPerWeek,       // sold per 7d (age-aware denominator)
//       trueDemandPerWeek,     //   (sold + oos) per 7d — projection signal
//       recentSold, recentOos, // last `recentDays` slice — momentum
//       bySize: { [size]: { sold, oos, placed, trueDemand } }, // PER-SIZE true demand
//       ageDays, sizes:[…], stores:[…], lastSaleDate, depleted, retailPrice
//     }, … ]
//   }
//
// UNITS: sold/oos/placed/trueDemand are raw counts; trueDemand === sold + oos at
// BOTH product and per-size level. bySize keys are the size string exactly as it
// appears in insights_log ("9", "10", "S"). suggestedQuantity MUST be built from
// bySize[size].trueDemand — never from sold alone, never by splitting a product
// total across sizes.
//
// This module is pure (only depends on its inputs) so it runs identically in the
// Cloud Function and under `node --test` (see reorder-demand.test.cjs).

"use strict";

// Bump in lockstep with REORDER_PAYLOAD_SCHEMA_VERSION on the client. The
// function branches on request.data.demand.schemaVersion; an unrecognised
// version falls back to the legacy internal-discovery path.
const REORDER_DEMAND_SCHEMA_VERSION = 1;

// How many product rows go into a single Claude call. The catalog is analysed in
// full (no TOP_N) by chunking into batches and merging — output token budget, not
// catalog size, is the binding constraint, so we bound per-call output instead of
// dropping the long tail. ~60 recommendations/batch sits well under the per-call
// max_tokens with margin for reasoning strings.
const DEMAND_BATCH_SIZE = 60;

// ── Row partitioning ─────────────────────────────────────────────────────────
// Every catalog row lands in exactly one bucket:
//   active  — has demand (sold or oos > 0): reorder / review / skip reasoning.
//   dormant — no demand but still listed (offered sizes): slow-mover candidate.
//   ignored — no demand AND no listed sizes: nothing actionable to say. Counted
//             in dataQualityNotes (transparency), omitted from recommendations.
function classifyDemandRow(row) {
  if (!row) return "ignored";
  const sold = Number(row.sold) || 0;
  const oos  = Number(row.oos) || 0;
  if (sold > 0 || oos > 0) return "active";
  const sizes = Array.isArray(row.sizes) ? row.sizes : [];
  if (sizes.length > 0) return "dormant";
  return "ignored";
}

function partitionDemandRows(rows) {
  const active = [];
  const dormant = [];
  const ignored = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const kind = classifyDemandRow(row);
    if (kind === "active") active.push(row);
    else if (kind === "dormant") dormant.push(row);
    else ignored.push(row);
  }
  return { active, dormant, ignored };
}

// ── Slim rows for the prompt ─────────────────────────────────────────────────
// Carry only what the model needs to reason; keep OOS visible at product and
// per-size level so it cannot be dropped from quantities.
function slimBySize(bySize) {
  const out = {};
  for (const [size, s] of Object.entries(bySize || {})) {
    if (!s) continue;
    out[size] = {
      sold: Number(s.sold) || 0,
      oos: Number(s.oos) || 0,
      trueDemand: Number(s.trueDemand) || ((Number(s.sold) || 0) + (Number(s.oos) || 0)),
    };
  }
  return out;
}

function slimActiveRow(row) {
  return {
    type: "active",
    productId: row.id,
    productName: row.name,
    sold: Number(row.sold) || 0,
    oos: Number(row.oos) || 0,
    placed: Number(row.placed) || 0,
    trueDemand: Number(row.trueDemand) || ((Number(row.sold) || 0) + (Number(row.oos) || 0)),
    velocityPerWeek: Number(row.velocityPerWeek) || 0,
    trueDemandPerWeek: Number(row.trueDemandPerWeek) || 0,
    recentSold: Number(row.recentSold) || 0,
    recentOos: Number(row.recentOos) || 0,
    bySize: slimBySize(row.bySize),
    ageDays: row.ageDays ?? null,
    sizes: Array.isArray(row.sizes) ? row.sizes : [],
    stores: Array.isArray(row.stores) ? row.stores : [],
    lastSaleDate: row.lastSaleDate || null,
    depleted: !!row.depleted,
    retailPrice: row.retailPrice ?? null,
  };
}

function slimDormantRow(row) {
  return {
    type: "dormant",
    productId: row.id,
    productName: row.name,
    sizes: Array.isArray(row.sizes) ? row.sizes : [],
    stores: Array.isArray(row.stores) ? row.stores : [],
    ageDays: row.ageDays ?? null,
    lastSaleDate: row.lastSaleDate || null,
    depleted: !!row.depleted,
    retailPrice: row.retailPrice ?? null,
  };
}

// ── Chunking + bounded concurrency ───────────────────────────────────────────
function chunk(arr, size) {
  const n = Math.max(1, size | 0);
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Run async `fn` over `items` with at most `limit` in flight. Preserves order.
// Used to fan batches out to Claude without tripping provider rate limits.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const lim = Math.max(1, limit | 0);
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(lim, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// ── Deterministic plan fields (computed straight from the aggregates) ─────────
// topSellers / sleepers / summary / dataQualityNotes don't need the model — we
// already hold the authoritative numbers. Computing them here keeps the model's
// only job per-product recommendation reasoning, and guarantees these headline
// figures never drift from the supplied true demand.
function buildTopSellers(activeRows, n = 10) {
  return [...activeRows]
    .sort((a, b) => (Number(b.sold) || 0) - (Number(a.sold) || 0))
    .slice(0, n)
    .map(r => ({ productName: r.name, totalSales: Number(r.sold) || 0 }));
}

// Sleepers: products that sold historically but have gone quiet (no sales in the
// recent slice). High all-time sold + zero recent sold = "forgotten winner".
function buildSleepers(activeRows, recentDays, n = 10) {
  return [...activeRows]
    .filter(r => (Number(r.sold) || 0) > 0 && (Number(r.recentSold) || 0) === 0)
    .sort((a, b) => (Number(b.sold) || 0) - (Number(a.sold) || 0))
    .slice(0, n)
    .map(r => ({
      productName: r.name,
      lastSaleDate: r.lastSaleDate || null,
      totalSales: Number(r.sold) || 0,
      note: `No sales in the last ${recentDays}d (sold ${Number(r.sold) || 0} all-time).`,
    }));
}

function buildSummary({ totals, coverage, cycleDays, activeCount, dormantCount }) {
  const t = totals || {};
  const c = coverage || {};
  const sold = Number(t.sold) || 0;
  const oos = Number(t.oos) || 0;
  const trueDemand = Number(t.trueDemand) || (sold + oos);
  return (
    `Reorder plan over a ${cycleDays}-day cycle, built from supplied TRUE DEMAND ` +
    `(sold + out-of-stock). Attributable true demand is ${trueDemand} units ` +
    `(${sold} sold + ${oos} unmet/OOS) across ${activeCount} products with demand; ` +
    `${dormantCount} listed products are dormant. Name-match coverage ` +
    `${c.coveragePct != null ? c.coveragePct + "%" : "n/a"} — figures reflect ` +
    `attributable demand only (insights_log has no productId).`
  );
}

function buildDataQualityNotes({ coverage, ignoredCount, unanalyzedProductIds, window }) {
  const c = coverage || {};
  const notes = [];
  notes.push(
    `Demand supplied by the client demand engine (schema v${REORDER_DEMAND_SCHEMA_VERSION}); ` +
    `the function reasoned over it and did NOT re-aggregate sales.`
  );
  if (window != null) {
    notes.push(`Demand window: ${window === "all" || window == null ? "all-time" : window + " days"}.`);
  }
  if (c.coveragePct != null) {
    notes.push(
      `Name-match coverage ${c.coveragePct}%: ${c.matchedProducts ?? "?"}/${c.catalogTotal ?? "?"} ` +
      `products are attributable. insights_log carries no productId, so ` +
      `${c.unmatchedEvents ?? "some"} sale events could not be tied to a product — ` +
      `true demand is a floor, not a ceiling.`
    );
  }
  if (c.nameCollisions) {
    notes.push(`${c.nameCollisions} product-name collisions: demand for those names can't be attributed uniquely.`);
  }
  if (ignoredCount) {
    notes.push(`${ignoredCount} catalog products had no demand and no listed sizes — omitted from recommendations.`);
  }
  if (unanalyzedProductIds && unanalyzedProductIds.length) {
    notes.push(
      `${unanalyzedProductIds.length} products could not be analysed (model batch error) and were left out ` +
      `of recommendations — re-run to include them. NOTE: not a silent truncation; counted here.`
    );
  }
  return notes;
}

// ── Recommendation normalization ─────────────────────────────────────────────
// Trust the supplied true demand, not the model's arithmetic: recompute
// totalSuggested from the per-size quantities so it is always internally
// consistent, and clamp action/priority to the allowed enums. suggestedQuantity
// values are coerced to non-negative integers.
const ALLOWED_ACTIONS = new Set(["reorder", "review", "skip", "slow_mover"]);
const ALLOWED_PRIORITIES = new Set(["high", "medium", "low"]);

function normalizeRecommendation(rec) {
  if (!rec || typeof rec !== "object" || !rec.productId) return null;
  const action = ALLOWED_ACTIONS.has(rec.action) ? rec.action : "skip";
  const priority = ALLOWED_PRIORITIES.has(rec.priority) ? rec.priority : "low";

  const sq = {};
  let total = 0;
  if (rec.suggestedQuantity && typeof rec.suggestedQuantity === "object") {
    for (const [size, qty] of Object.entries(rec.suggestedQuantity)) {
      const q = Math.max(0, Math.round(Number(qty) || 0));
      if (q > 0) { sq[size] = q; total += q; }
    }
  }
  return {
    productId: String(rec.productId),
    productName: rec.productName ? String(rec.productName) : "",
    action,
    priority,
    suggestedQuantity: sq,
    totalSuggested: total,            // recomputed — never trust the model's sum
    reasoning: rec.reasoning ? String(rec.reasoning) : "",
  };
}

// Merge per-batch recommendation arrays into one, normalised, de-duped by
// productId (first occurrence wins — batches are disjoint, so collisions only
// happen if the model echoes a product twice).
function mergeRecommendations(batchResults) {
  const seen = new Set();
  const out = [];
  for (const batch of batchResults) {
    const recs = batch && Array.isArray(batch.recommendations) ? batch.recommendations : [];
    for (const raw of recs) {
      const rec = normalizeRecommendation(raw);
      if (!rec || seen.has(rec.productId)) continue;
      seen.add(rec.productId);
      out.push(rec);
    }
  }
  return out;
}

// ── Prompts ──────────────────────────────────────────────────────────────────
// One system prompt covers both active and dormant rows (a given batch is
// homogeneous, but the rules for both live here). The model returns ONLY a
// recommendations array per batch; all global fields are computed deterministically.
function demandSystemPrompt({ businessContext, cycleDays, recentDays, window }) {
  const ctxBlock = businessContext
    ? `\n\nOWNER-PROVIDED BUSINESS CONTEXT:\n${JSON.stringify(businessContext, null, 2)}\n`
    : "";
  const windowLabel = window === "all" || window == null ? "the product's full lifetime" : `${window} days`;
  return `CRITICAL OUTPUT CONTRACT — read this before anything else:
Your ENTIRE response must be one single JSON object and nothing else. First character {, last character }. No preamble, no markdown code fences (no \`\`\`json), no commentary outside the JSON, no multiple objects, no trailing commas. If you can't fit everything, truncate the recommendations array but keep the JSON syntactically valid. Violations cause the whole response to be discarded.

You are the AI Reorder Planner for Marathon Club, a sneaker and clothing store in South Africa. You are given PRE-COMPUTED TRUE DEMAND for a batch of products and must recommend what to reorder for the upcoming ${cycleDays}-day cycle. Suppliers ship in ~45–60 days, so the owner reorders roughly every cycle.

DEMAND IS ALREADY COMPUTED — DO NOT RE-DERIVE IT. Every number you need is supplied:
- TRUE DEMAND = sold + oos (out-of-stock). An OOS event is a customer who wanted a size we didn't have: a real, lost sale. It MUST count toward reorder quantity. Never plan on sold alone.
- Per product: sold, oos, placed, trueDemand (= sold + oos), velocityPerWeek (sold/7d), trueDemandPerWeek ((sold+oos)/7d), recentSold, recentOos (last ${recentDays}d).
- Per size: bySize[size] = { sold, oos, trueDemand }. This is the ONLY correct source for per-size quantities — do not split a product total across sizes yourself.
- Demand window for these counts: ${windowLabel}. cycleDays = ${cycleDays} is the horizon to project the next order over; it equals the real catalog window, so the realised true demand is a strong baseline for next cycle.

SIZING THE REORDER (active products):
1. For each size with demand, base suggestedQuantity[size] on bySize[size].trueDemand — the realised sold+OOS over the last cycle is the floor for the next cycle of equal length.
2. Scale UP a size when recent momentum is strong (recentOos high, recentSold rising) or OOS is a large share of its true demand (suppressed demand we keep missing).
3. Scale DOWN, or prefer action "review" over "reorder", when the all-time count is tiny / history is short (low confidence) — recommend conservatively and say why.
4. totalSuggested is the sum of the per-size quantities. Round every quantity to a whole number. Only include sizes you actually want to reorder.

ACTIONS:
- type:"active" products → exactly one of: "reorder" (clear demand, restock), "review" (promising but uncertain — let the owner decide), or "skip" (negligible / not worth reordering). Use bySize true demand for quantities; skip/review may use an empty suggestedQuantity {}.
- type:"dormant" products → "slow_mover" ONLY. These have ZERO demand but are still listed. totalSuggested 0, suggestedQuantity {}. priority reflects how confidently they look inactive (depleted flag, many listed sizes, old/absent lastSaleDate). reasoning suggests a next action (review price, transfer between stores, discount, or delist). Do NOT invent stock numbers.
Do NOT emit reorder/review/skip for dormant rows, and do NOT emit slow_mover for active rows.

OUTPUT (STRICT JSON, this exact shape):
{
  "recommendations": [
    {
      "productId": "string (use the supplied productId verbatim)",
      "productName": "string",
      "action": "reorder" | "review" | "skip" | "slow_mover",
      "priority": "high" | "medium" | "low",
      "suggestedQuantity": { "<size>": <integer>, ... },
      "totalSuggested": <integer>,
      "reasoning": "string — 1-2 sentences"
    }
  ]
}
Emit one entry per product in the batch.${ctxBlock}

FINAL REMINDER: output starts with { and ends with }. Nothing else. The parser is strict.`;
}

function buildBatchUserPayload({ cycleDays, recentDays, window, batchIndex, batchCount, rows }) {
  return JSON.stringify({
    cycleDays,
    recentDays,
    window,
    batchIndex,
    batchCount,
    productCount: rows.length,
    products: rows,
  });
}

module.exports = {
  REORDER_DEMAND_SCHEMA_VERSION,
  DEMAND_BATCH_SIZE,
  classifyDemandRow,
  partitionDemandRows,
  slimBySize,
  slimActiveRow,
  slimDormantRow,
  chunk,
  mapWithConcurrency,
  buildTopSellers,
  buildSleepers,
  buildSummary,
  buildDataQualityNotes,
  normalizeRecommendation,
  mergeRecommendations,
  demandSystemPrompt,
  buildBatchUserPayload,
};
