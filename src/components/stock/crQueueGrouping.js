// ─── CR ORDERS — GROUP OPEN REQUESTS BY PRODUCT (owner spec 2026-08-09) ──────
// The SHOP → HUB clothing refill list runs CONTINUOUSLY (no release-window
// batching on this leg), so the same product kept appearing as a new card every
// time another size sold: the grouping key was (product, shop, createdAt) and
// each later request carries a later createdAt. This module merges the OPEN
// queue's cards down to ONE per (product, destination shop), sizes inside.
//
// PRESENTATION ONLY — hard guarantees, each pinned by crQueueGrouping.test.js:
//   • Item records pass through BY REFERENCE, untouched. Nothing is written,
//     merged, or rewritten at the request level; every size line keeps its own
//     orderId, status, timestamps and rejection state, and its own actions.
//   • Every fulfil/undo movement id stays BYTE-IDENTICAL to what the ungrouped
//     queue would have produced: ids embed the order line's own createdAt
//     (crLineCreatedAt), which the per-request cards used to supply as
//     batch.createdAt. A retry of a pre-deploy partial still dedupes.
//   • Shadow previews (engine shadow mode) are never merged with actionable
//     requests — a read-only line inside a live card would blur what's
//     actionable. They keep their own per-request cards.
//   • History / completed cards are NOT grouped here: they are resolution
//     records, one per request, and merging them would blend distinct
//     resolvedAt stamps and re-surface long-resolved lines in fresh cards.
import { sizeRank } from "./hubSizeRank";

// IDEMPOTENCY (moved verbatim from App.jsx so the test imports the REAL id
// builder): both fulfil directions are keyed on the order line + its CREATION
// DATE + fulfil generation. order.id is only a DAILY counter (001–999, reused
// every day), so createdAt MUST be threaded in — otherwise two same-numbered
// Shop-Refill orders on different days collide and the later transfer is
// silently swallowed as idempotent. Same scrub as the dispatch path (RTDB keys
// can't hold . # $ [ ] / : space).
export const crMovementId = (prefix, orderId, createdAt, gen) =>
  `${prefix}_${orderId}_${createdAt || ""}_g${gen}`.replace(/[.#$[\]/\s:]/g, "_");

// The createdAt a movement id must embed for one line: the line's OWN request
// date. Merged cards hold lines from several requests, so batch.createdAt (the
// oldest ask, kept for display/sort) is no longer every line's date. Items
// built before this field existed fall back to batch.createdAt — for a
// per-request card the two are the same value.
export const crLineCreatedAt = (item, batch) => item?.createdAt || batch?.createdAt;

// Units still waiting on a card — the header total. Resolved lines don't
// count, and an EXPLICIT qty of 0 (an engine-resized-to-nothing line) counts
// as 0 — the 1-fallback is only for absent/invalid quantities (CodeRabbit,
// PR #339).
export const pendingUnits = (items) =>
  (items || []).filter((it) => !it.status).reduce((s, it) => {
    const qty = Number(it.qty ?? 1);
    return s + (Number.isFinite(qty) ? qty : 1);
  }, 0);

// Merge the OPEN (active) per-request batches into one card per
// (productId, destShop). Input batches and their item records are never
// mutated; output items are the same references, re-sorted into size run
// order (letters S→4XL first, then footwear/waist numerically — hubSizeRank).
export function mergeActiveCRBatches(active) {
  const merged = new Map();
  const out = [];
  for (const b of active || []) {
    // Shadow previews stay per-request cards — never merged with live work.
    if (b.shadow) { out.push(b); continue; }
    const key = `${b.productId}__${b.destShop || ""}`;
    let m = merged.get(key);
    if (!m) {
      m = {
        ...b,
        batchKey: key,
        items: [...b.items],
        // The AUTO chip means "no human placed this"; on a mixed card a human
        // DID place part of it, so the chip shows only when every request is
        // engine-raised.
        autoRefill: !!b.autoRefill,
      };
      merged.set(key, m);
      out.push(m);
      continue;
    }
    m.items.push(...b.items);
    // A card's age is its OLDEST ask (ISO strings compare lexicographically).
    if (String(b.createdAt || "") < String(m.createdAt || "")) m.createdAt = b.createdAt;
    m.autoRefill = m.autoRefill && !!b.autoRefill;
    if (!m.destShop && b.destShop) m.destShop = b.destShop;
    if (!m.productPhotoUrl && b.productPhotoUrl) m.productPhotoUrl = b.productPhotoUrl;
    if (!m.productPhoto && b.productPhoto) m.productPhoto = b.productPhoto;
  }
  for (const m of out) {
    if (!m.shadow) m.items.sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
  }
  return out;
}
