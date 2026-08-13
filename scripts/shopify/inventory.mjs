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
// stock/in_transit is NOT sellable (src/components/stock/locations.js marks it
// kind "transit", sellable false — boxes that left their source but haven't
// landed, incl. count-integrity holds). Pushing it as available would let the
// storefront sell stock nobody can pick.
const UNSELLABLE_LOCATIONS = new Set(["in_transit"]);

export function networkTotals(stockTree, productId, sizes) {
  const totals = {};
  for (const size of sizes) totals[stockSizeKey(size)] = 0;
  for (const [loc, perProduct] of Object.entries(stockTree || {})) {
    if (UNSELLABLE_LOCATIONS.has(loc)) continue;
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
// re-run converges instead of double-counting. The 2026-07 API makes the set
// a compare-and-set (changeFromQuantity is required), so the current
// quantities are read first; a concurrent change makes the mutation error
// rather than silently clobber — the caller re-runs.
export async function setAvailable(graphql, locationId, items) {
  if (!items.length) return { set: 0 };
  const current = await graphql(
    `query ($ids: [ID!]!, $loc: ID!) {
      nodes(ids: $ids) {
        ... on InventoryItem {
          id
          inventoryLevel(locationId: $loc) {
            quantities(names: ["available"]) { name quantity }
          }
        }
      }
    }`,
    { ids: items.map((i) => i.inventoryItemId), loc: locationId }
  );
  const currentById = new Map();
  for (const n of current.nodes ?? []) {
    if (!n?.id) continue;
    const q = n.inventoryLevel?.quantities?.find((x) => x.name === "available")?.quantity ?? 0;
    currentById.set(n.id, q);
  }
  // 2026-07 requires @idempotent on this mutation. The key is minted once per
  // call, so the client's own retry of the same request replays, not doubles.
  const { randomUUID } = await import("crypto");
  const data = await graphql(
    `mutation ($input: InventorySetQuantitiesInput!, $key: String!) {
      inventorySetQuantities(input: $input) @idempotent(key: $key) {
        inventoryAdjustmentGroup { reason }
        userErrors { field message }
      }
    }`,
    {
      key: randomUUID(),
      input: {
        name: "available",
        reason: "correction",
        quantities: items.map(({ inventoryItemId, quantity }) => ({
          inventoryItemId,
          locationId,
          quantity,
          changeFromQuantity: currentById.get(inventoryItemId) ?? 0,
        })),
      },
    },
    { mutation: true }
  );
  const errs = data.inventorySetQuantities.userErrors;
  if (errs?.length) throw new Error(`inventorySetQuantities userErrors: ${JSON.stringify(errs)}`);
  return { set: items.length };
}
