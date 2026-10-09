// ─── ALTERNATIVES TELEMETRY — LOG ONLY ───────────────────────────────────────
//
// One row per alternatives-sheet open and one per alternative taken, appended
// to /alternatives_log for Junid's monthly review. NOTHING READS THIS BACK INTO
// THE RANKING: the neighbour build never opens the node, and neither does the
// sheet. It is a record of what happened, not an input.
//
// `sizeGateRemoved` (2026-10-01) is the number to watch: how many stored
// neighbours could sell SOME size but not the tapped one — the rows the sheet
// used to pad itself with before the size gate. It should fall after the
// neighbour build's size fit is applied, and stay low.
//
// Its own node, deliberately NOT /insights_log: that feed renders every row in
// the Insights "Recent activity" and "Order History" lists, and a sheet open is
// not an order event.
//
// `shownTiers` (2026-10-09) runs parallel to `shownIds`: which ranking tier each
// row came from — a same model family, b same brand and shape, c same colour,
// d anything else in the size. `pickedTier` is the tier of the row taken, and
// `inSize` how many shoes were sellable in that size at all. Recorded so
// Junid's review can see whether the tiers earn their order. STILL LOG ONLY.
//
// SHAPE NOTE: RTDB deletes an empty array, so `shownIds` and `shownTiers` are
// ABSENT (not []) on a sheet that showed nothing. Read them as
// `row.shownIds || []`; `shown` carries the count either way.

export const ALTERNATIVES_LOG_PATH = "alternatives_log";

/** The row written when the sheet answers for (product, size). */
export function shownEntry({ ts, shop, surface, product, size, result }) {
  if (!product?.id || !result) return null;
  return {
    ts, shop: shop || "", event: "shown", surface,
    productId: product.id, size: String(size ?? ""),
    candidates: result.candidates,
    shown: result.rows.length,
    sizeGateRemoved: result.sizeGateRemoved,
    ...(Number.isFinite(result.inSize) ? { inSize: result.inSize } : {}),
    shownIds: result.rows.map((r) => r.product.id),
    shownTiers: result.rows.map((r) => r.tier || ""),
  };
}

/** The row written when an alternative is tapped. */
export function pickedEntry({ ts, shop, surface, product, size, row }) {
  if (!product?.id || !row?.product?.id) return null;
  return {
    ts, shop: shop || "", event: "picked", surface,
    productId: product.id, size: String(size ?? ""),
    pickedId: row.product.id,
    pickedSize: String(row.matchedSize ?? ""),
    pickedTier: row.tier || "",
  };
}
