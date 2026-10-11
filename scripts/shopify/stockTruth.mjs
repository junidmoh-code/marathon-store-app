// ─── STOCK TRUTH — the arithmetic of "is Shopify selling what we hold?" ──────
//
// Pure functions behind stock-truth-sweep.mjs (the nightly drift sweep and the
// one-off correction of 2026-10-11) so the numbers in its report, its refusal
// guard and its rollback file are unit-tested without Shopify or RTDB.
// docs/SHOPIFY-STOCK-TRUTH.md is the story.

// If a correction would take more than this share of the units Shopify is
// offering off sale, the sweep refuses to commit. Junid's brief: zeroing more
// than a quarter of the live units is a sign the QUANTITY DEFINITION is wrong,
// not the website.
export const MAX_ZERO_SHARE = 0.25;

/**
 * How oversellable one product's listing is, from a syncProduct (or
 * zeroUnmanagedListing) dry-run result.
 *
 *   units              tracked sizes where Shopify offers more than the app holds
 *   unlimitedVariants  sizes Shopify is not limiting at all (tracking off, or
 *                      CONTINUE) — any quantity can be sold
 *   removedUnits       units the correction takes off sale (for the guard)
 */
export function oversell(result) {
  const untrackedItems = new Set((result?.untracked || []).map((u) => u.inventoryItemId));
  let units = 0, removedUnits = 0;
  for (const d of result?.drift || []) {
    const over = Math.max(0, (Number(d.shopify) || 0) - (Number(d.quantity) || 0));
    removedUnits += over;
    if (!untrackedItems.has(d.inventoryItemId)) units += over;
  }
  return { units, unlimitedVariants: untrackedItems.size, removedUnits };
}

/** Summarise a sweep's dry-run results into the report the watchdog reads. */
export function summarize(results) {
  let checked = 0, drifted = 0, units = 0, unlimitedVariants = 0, removedUnits = 0;
  let shopifyUnits = 0, appUnits = 0, gone = 0, failed = 0, unmanaged = 0;
  const offenders = [];
  for (const r of results || []) {
    if (r?.productGone) { gone++; continue; }
    if (r?.ok !== true) { failed++; continue; }
    checked++;
    if (r.unmanaged) unmanaged++;
    shopifyUnits += Number(r.shopifyUnits) || 0;
    appUnits += Number(r.appUnits) || 0;
    const o = oversell(r);
    units += o.units;
    unlimitedVariants += o.unlimitedVariants;
    removedUnits += o.removedUnits;
    if ((r.drift?.length || 0) + (r.untracked?.length || 0) > 0) drifted++;
    if (o.units || o.unlimitedVariants) {
      offenders.push({
        pid: r.pid ?? null, gid: r.gid ?? null,
        units: o.units, unlimitedVariants: o.unlimitedVariants,
        sizes: [
          ...(r.untracked || []).map((u) => `${u.sizeKey}: unlimited (app ${u.app})`),
          ...(r.drift || []).filter((d) => d.shopify > d.quantity && !(r.untracked || []).some((u) => u.inventoryItemId === d.inventoryItemId))
            .map((d) => `${d.sizeKey}: Shopify ${d.shopify} vs app ${d.quantity}`),
        ].slice(0, 12),
      });
    }
  }
  // Unlimited sizes first — any number of them can be sold — then by units.
  offenders.sort((a, b) => b.unlimitedVariants - a.unlimitedVariants || b.units - a.units);
  return {
    checked, drifted, gone, failed, unmanaged,
    oversellableUnits: units, unlimitedVariants, removedUnits,
    shopifyUnits, appUnits,
    zeroShare: shopifyUnits > 0 ? removedUnits / shopifyUnits : 0,
    worst: offenders.slice(0, 20),
    offenders: offenders.length,
  };
}

/** True when committing this correction would trip Junid's 25% guard. */
export function exceedsZeroGuard(summary, max = MAX_ZERO_SHARE) {
  return summary.zeroShare > max;
}

/**
 * The rollback file's entries: what Shopify held before the correction, per
 * inventory item, so every number and tracking flag can be put back.
 */
export function rollbackEntries(results) {
  const out = [];
  for (const r of results || []) {
    if (r?.ok !== true) continue;
    const byItem = new Map();
    for (const d of r.drift || []) {
      byItem.set(d.inventoryItemId, { pid: r.pid ?? null, gid: r.gid ?? null, sizeKey: d.sizeKey, inventoryItemId: d.inventoryItemId, before: d.shopify, after: d.quantity });
    }
    for (const u of r.untracked || []) {
      const e = byItem.get(u.inventoryItemId) || { pid: r.pid ?? null, gid: r.gid ?? null, sizeKey: u.sizeKey, inventoryItemId: u.inventoryItemId, before: u.shopify, after: u.shopify };
      byItem.set(u.inventoryItemId, { ...e, variantId: u.variantId, trackedBefore: u.tracked, policyBefore: u.inventoryPolicy });
    }
    out.push(...byItem.values());
  }
  return out;
}
