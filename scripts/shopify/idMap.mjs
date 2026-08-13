// ── The /shopify_sync ID map: RTDB product → Shopify IDs ─────────────────────
// One node per synced product, in a DEDICATED path (owner decision 2026-08-13):
//
//   /shopify_sync/{productId} = {
//     shopifyProductId: "gid://shopify/Product/…",
//     variants: {
//       {encodedSizeKey}: {
//         shopifyVariantId:       "gid://shopify/ProductVariant/…",
//         shopifyInventoryItemId: "gid://shopify/InventoryItem/…",
//       },
//     },
//   }
//
// NOT on the product record: /products is client-writable under live rules and
// the app saves whole records with set() — a lost mapping would silently cause
// duplicate product creation in Shopify. /shopify_sync is Admin-SDK-only (rule
// block in the PR description; console-managed, never in database.rules.json).
//
// Size keys use the app's one true RTDB encoding — encodeSizeKey from
// src/utils/sizeKey.js ("5.5" → "5_5", "_" sentinel passes through), the same
// cross-app contract /stock and /inventory are keyed with. Full gid:// strings
// are stored, never bare numeric IDs.
//
// The writer is IDEMPOTENT and never clobbers:
//   • no existing node                     → create
//   • existing node identical              → no-op
//   • same product, strictly NEW size keys → merge the new keys in
//   • same size key with different IDs, or a different shopifyProductId
//                                          → REFUSE loudly (human decision)
import { encodeSizeKey, assertSafeSegment } from "../../src/utils/sizeKey.js";

// rows: [{ size, variantId, inventoryItemId }] with the ORIGINAL catalogue
// size token ("5.5", "M", "_") — never a Shopify display value like "One Size".
export function buildMapping(shopifyProductId, rows) {
  if (!shopifyProductId?.startsWith("gid://shopify/Product/")) {
    throw new Error(`shopifyProductId must be a Product gid, got: ${shopifyProductId}`);
  }
  const variants = {};
  for (const { size, variantId, inventoryItemId } of rows) {
    const key = assertSafeSegment(encodeSizeKey(size), "size key");
    if (variants[key]) throw new Error(`duplicate size key ${key} in variant rows`);
    if (!variantId?.startsWith("gid://shopify/ProductVariant/")) {
      throw new Error(`variantId must be a ProductVariant gid, got: ${variantId}`);
    }
    if (!inventoryItemId?.startsWith("gid://shopify/InventoryItem/")) {
      throw new Error(`inventoryItemId must be an InventoryItem gid, got: ${inventoryItemId}`);
    }
    variants[key] = { shopifyVariantId: variantId, shopifyInventoryItemId: inventoryItemId };
  }
  if (!Object.keys(variants).length) throw new Error("mapping has no variants");
  return { shopifyProductId, variants };
}

// Pure decision: what a write against `existing` must do. Kept separate from
// the Admin SDK so idempotency is unit-testable without an emulator.
//   → { action: "create" | "noop" | "merge", newKeys? }   or throws.
export function planIdMapWrite(existing, mapping) {
  if (existing == null) return { action: "create" };
  if (existing.shopifyProductId !== mapping.shopifyProductId) {
    throw new Error(
      `refusing to overwrite: node already maps to ${existing.shopifyProductId}, ` +
        `new mapping says ${mapping.shopifyProductId}. Two Shopify products for one ` +
        `record needs a human — delete the stale Shopify product or the stale node first.`
    );
  }
  const oldVars = existing.variants || {};
  const newKeys = [];
  for (const [key, v] of Object.entries(mapping.variants)) {
    const prev = oldVars[key];
    if (!prev) {
      newKeys.push(key);
    } else if (
      prev.shopifyVariantId !== v.shopifyVariantId ||
      prev.shopifyInventoryItemId !== v.shopifyInventoryItemId
    ) {
      throw new Error(
        `refusing to overwrite variant ${key}: existing IDs differ from the new ones ` +
          `(${prev.shopifyVariantId} vs ${v.shopifyVariantId}). Re-mapping a size needs a human.`
      );
    }
  }
  return newKeys.length ? { action: "merge", newKeys } : { action: "noop" };
}

// db = admin.database(). Returns the plan it executed.
//
// Runs as an RTDB TRANSACTION, not read-then-write: two concurrent writers
// (or a writer racing a partial earlier run) each get planIdMapWrite re-run
// against the CURRENT server value, so a conflicting mapping aborts instead
// of silently replacing what the other writer just committed. The update
// function may be invoked more than once (first against the local cache) —
// plan and conflict are recomputed every invocation and only the final,
// committed invocation's plan is returned.
export async function writeIdMap(db, productId, mapping) {
  const ref = db.ref(`shopify_sync/${assertSafeSegment(productId, "productId")}`);
  let plan = null;
  let conflict = null;
  const result = await ref.transaction((existing) => {
    conflict = null;
    try {
      plan = planIdMapWrite(existing, mapping);
    } catch (e) {
      conflict = e;
      return undefined; // abort the transaction, existing data untouched
    }
    if (plan.action === "noop") return existing;
    if (plan.action === "create") return mapping;
    const merged = { ...existing, variants: { ...(existing.variants || {}) } };
    for (const key of plan.newKeys) merged.variants[key] = mapping.variants[key];
    return merged;
  });
  if (conflict) throw conflict;
  if (!result.committed) throw new Error("ID-map transaction did not commit");
  return plan;
}
