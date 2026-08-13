// ── Inventory for the Shopify push — ONE location, ONE sellable pool ─────────
// Shopify has exactly ONE location, deliberately (owner decision, slice 1):
// inventory is the NETWORK total available per size — every /stock location
// summed, negative cells clamped to 0 (the app's own convention: negatives
// are bookkeeping artefacts, never sellable). Never create locations
// mirroring PE / Pine / Trophy / the hubs.
//
// networkTotals is pure (unit-tested against a /stock-shaped tree);
// requireSingleLocation and setAvailable do the I/O.
import { stockSizeKey } from "../../src/utils/sizeKey.js";

// stockTree = the whole /stock value: { location: { productId: { sizeKey: cell } } }
// where a cell is the movement-stamped object { qty, lastType, mv, … } the
// applyMovement pipeline writes (a bare number is tolerated for old data).
// → { [sizeKey]: networkQty } for this product's sizes (encoded keys).
export function networkTotals(stockTree, productId, sizes) {
  const totals = {};
  for (const size of sizes) totals[stockSizeKey(size)] = 0;
  for (const perProduct of Object.values(stockTree || {})) {
    const cells = perProduct?.[productId];
    if (!cells) continue;
    for (const [key, cell] of Object.entries(cells)) {
      if (!(key in totals)) continue; // sizes not in the record don't ship
      const qty = cell !== null && typeof cell === "object" ? cell.qty : cell;
      totals[key] += Math.max(0, Number(qty) || 0);
    }
  }
  return totals;
}

// The shop's single location — REFUSES if there is more than one, because a
// second location means someone broke the one-pool decision and quantities
// would land in the wrong pool silently.
export async function requireSingleLocation(graphql) {
  const data = await graphql(
    `query { locations(first: 2) { nodes { id name } } }`
  );
  const nodes = data.locations?.nodes ?? [];
  if (nodes.length !== 1) {
    throw new Error(
      `expected exactly ONE Shopify location, found ${nodes.length}` +
        (nodes.length ? ` (${nodes.map((n) => n.name).join(", ")})` : "") +
        ` — the one-sellable-pool decision is broken; fix the shop before pushing inventory.`
    );
  }
  return nodes[0].id;
}

// Set absolute available quantities at the single location.
// items: [{ inventoryItemId, quantity }]. Absolute set (not delta), so a
// re-run converges instead of double-counting.
export async function setAvailable(graphql, locationId, items) {
  if (!items.length) return { set: 0 };
  const data = await graphql(
    `mutation ($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup { reason }
        userErrors { field message }
      }
    }`,
    {
      input: {
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        quantities: items.map(({ inventoryItemId, quantity }) => ({
          inventoryItemId,
          locationId,
          quantity,
        })),
      },
    },
    { mutation: true }
  );
  const errs = data.inventorySetQuantities.userErrors;
  if (errs?.length) throw new Error(`inventorySetQuantities userErrors: ${JSON.stringify(errs)}`);
  return { set: items.length };
}
