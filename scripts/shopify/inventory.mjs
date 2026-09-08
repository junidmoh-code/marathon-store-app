// ── Inventory for the Shopify push — ONE location, ONE sellable pool ─────────
// Shopify has exactly ONE location, deliberately (owner decision, slice 1):
// inventory is the network total available per size — every /stock location
// that COUNTS TOWARD ONLINE AVAILABILITY summed, negative cells clamped to 0
// (the app's own convention: negatives are bookkeeping artefacts, never
// sellable). Never create locations mirroring PE / Pine / Trophy / the hubs.
//
// "Every location" was literally true until 2026-09-08; it is not any more.
// ONLINE_EXCLUDED_LOCATIONS below is the pool, and the block comment on it is
// the reason. The one-Shopify-location decision is UNCHANGED — the shop still
// has exactly one pool; what narrowed is which of our shelves feed it.
//
// networkTotals is pure (unit-tested against a /stock-shaped tree);
// requireSingleLocation and setAvailable do the I/O.
import { stockSizeKey } from "../../src/utils/sizeKey.js";

// ── WHICH LOCATIONS MAY BE SOLD TO A WEB CUSTOMER ────────────────────────────
// Two separate reasons a location's units must not reach the storefront. They
// are kept as two sets because they are two different facts about the world,
// and one of them will change back one day while the other never will.
//
// UNSELLABLE — the stock is not sellable BY NATURE. /stock/in_transit holds
// boxes that left their source and have not landed (count-integrity holds
// included); src/components/stock/locations.js marks it kind "transit",
// sellable false. Pushing it as available would let the storefront sell stock
// nobody can pick. This set is a property of the system and is not a policy.
//
// UNTRUSTED — the stock may well be sellable, but the COUNT is not believed.
// Hub 3 and Pine keep their own /stock cells, get refilled, get counted and
// get reported exactly as before; what changed (owner decision, 2026-09-08) is
// that their numbers are no longer accurate enough to promise a stranger on
// the internet. The owner's framing is the specification: "I'd rather a
// product show as unavailable than sell something I can't fulfil." So a
// A location enters this set when its count stops being trustworthy and leaves
// it when the count is trusted again. That is NOT a one-line edit, and this
// comment said it was: the list is mirrored into two Cloud Functions and named
// by three test files, and the change needs a mini pull, three named function
// deploys, a full inventory correction and a search-index rebuild. The whole
// sequence is written down under "Trusting a location again" in
// scripts/shopify/README.md; measure it first with
// scripts/shopify/census-online-locations.mjs.
//
// Measured at the time of the decision, across 1,203 live products:
//   marathon-pine  1,668 units on 268 live products (10.5% of the pool)
//   hub3               4 units on   3 live products ( 0.0%)
// and 43 live products — 3.6% of the live catalogue — fall to zero and go
// unavailable. Hub 3 alone takes NOTHING to zero; Pine is the whole cost.
//
// ONLINE_EXCLUDED_LOCATIONS is the union, and it is the only one anything
// reads.
//
// ── IMMUTABLE FOR REAL, NOT BY Object.freeze ─────────────────────────────────
// This set is shared BY REFERENCE with the reconciler, the tracking backfill,
// the continuous sweep and (mirrored) two Cloud Functions. A line that mutated
// it would change what the shop sells, globally and silently — so it must not
// be mutable.
//
// `Object.freeze(new Set([...]))` DOES NOT DO THAT, and the first version of
// this file claimed it did. Freezing seals a Set's own properties; the entries
// live in internal slots, so `.add()`, `.delete()` and `.clear()` all still
// work and `Object.isFrozen()` still answers true. A reviewer reproduced it:
// deleting marathon-pine from the frozen set succeeded and the network total
// went from 2 back to 14. The safeguard was decorative, and the test that
// asserted `Object.isFrozen` certified the decoration.
//
// So the mutators are shadowed with throwers. WHAT THAT DOES AND DOES NOT
// STOP, stated exactly, because the whole point of this block is that a
// confident comment is not a guarantee:
//
//   STOPS   set.add("x") / set.delete("x") / set.clear() — every ordinary
//           way a line of code in this repo would change it, deliberately or
//           by accident. That is the failure being defended against.
//   DOES NOT STOP  Set.prototype.add.call(set, "x"), which reaches the
//           internal slots without touching the instance's own properties.
//           Reproduced: it appends and does not throw. Closing it needs a
//           Proxy, and a Proxy would have to re-bind every method on every
//           `get` — including the `.has()` this trigger calls on every stock
//           movement, the busiest write path in the database. Not worth it
//           for a bypass nobody reaches by accident. It is named here rather
//           than left for the next reviewer to find.
function sealedSet(ids) {
  const set = new Set(ids);
  for (const method of ["add", "delete", "clear"]) {
    Object.defineProperty(set, method, {
      value: () => {
        throw new TypeError(
          `ONLINE_EXCLUDED_LOCATIONS is immutable — ${method}() would change what the shop sells`
        );
      },
    });
  }
  return Object.freeze(set);
}

export const UNSELLABLE_LOCATIONS = sealedSet(["in_transit"]);
export const UNTRUSTED_LOCATIONS = sealedSet(["hub3", "marathon-pine"]);
export const ONLINE_EXCLUDED_LOCATIONS = sealedSet([
  ...UNSELLABLE_LOCATIONS, ...UNTRUSTED_LOCATIONS,
]);

// stockTree = the whole /stock value: { location: { productId: { sizeKey: cell } } }
// where a cell is the movement-stamped object { qty, lastType, mv, … } the
// applyMovement pipeline writes (a bare number is tolerated for old data).
// → { [sizeKey]: networkQty } for this product's sizes (encoded keys).

// `excluded` is the pool to leave out, and it defaults to the one in force.
// It is a PARAMETER rather than a hard reference for one reason: a tool that
// has to compare policies — "what does the storefront show today, and what
// would it show if Pine stopped counting?" — must be able to ask both
// questions of the SAME arithmetic. Without it the census could only ever run
// the current policy against itself and would report every change as costing
// nothing, which is exactly the wrong answer to be confident about. Nothing in
// the push path passes it; the default is the policy.
export function networkTotals(stockTree, productId, sizes, excluded = ONLINE_EXCLUDED_LOCATIONS) {
  const totals = {};
  for (const size of sizes) totals[stockSizeKey(size)] = 0;
  for (const [loc, perProduct] of Object.entries(stockTree || {})) {
    if (excluded.has(loc)) continue;
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

// ── TRACKING — the field that decides whether any of the above matters ────────
// Shopify only honours a variant's quantities when its inventory item is
// TRACKED. Untracked, the storefront treats every size as infinitely available:
// nothing ever shows sold out, the shop can sell stock it does not have, and
// Shopify's own ABC / sell-through reports stay empty.
//
// WHY IT WAS OFF (measured on the live shop, 2026-08-16). The reconciler creates
// products with `productSet`, and `ProductVariantSetInput.inventoryItem` was
// never populated. `tracked` defaults to FALSE on that path — unlike the admin
// UI and unlike `productVariantsBulkCreate`, which default it on. The evidence
// is unambiguous:
//
//   products created 2025-08 (by hand / an earlier tool)   tracked = true
//   every product this program created from 2026-08-13 on  tracked = false
//
// 389 of 389 live variants were untracked. `inventoryPolicy` was already DENY
// everywhere (that one DOES default correctly), so tracking was the whole
// defect. The quantities themselves were correct all along — setAvailable had
// been writing them faithfully, and Shopify was storing and ignoring them.
//
// TRACKED_VARIANT is what every push must carry. `inventoryItem` deliberately
// carries ONLY `tracked`: the same input accepts `cost`, and cost is
// `stockPrice`, which is internal and must never reach Shopify.
// FROZEN, both levels. This object is spread into every variant input on every
// path ({ id, ...TRACKED_VARIANT }), which shares the SAME inner inventoryItem
// by reference across the reconciler, round-trip and the backfill. A future
// line that mutated it — adding a `cost`, say — would leak globally and
// silently. Freezing makes that a thrown error in strict mode instead.
export const TRACKED_VARIANT = Object.freeze({
  inventoryPolicy: "DENY",                          // never sell past zero
  inventoryItem: Object.freeze({ tracked: true }),  // and count what is there
});

/** Variants whose tracking/policy is not what we require. Pure — unit-tested.
 *  rows: [{ variantId, tracked, inventoryPolicy }] from a Shopify read-back. */
export function untrackedVariants(rows) {
  return (rows || []).filter(
    (r) => r.tracked !== true || r.inventoryPolicy !== "DENY"
  );
}

/**
 * Make every listed variant tracked and DENY. Idempotent and cheap: the caller
 * passes only the variants that a read-back showed were wrong, so a correct
 * product costs ZERO mutations.
 * Throws on userErrors — the caller must refuse rather than publish a product
 * that can oversell.
 */
export async function enforceTracking(graphql, productId, variantIds) {
  if (!variantIds.length) return { fixed: 0 };
  const data = await graphql(
    `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id inventoryPolicy inventoryItem { tracked } }
        userErrors { field message }
      }
    }`,
    { productId, variants: variantIds.map((id) => ({ id, ...TRACKED_VARIANT })) },
    { mutation: true }
  );
  const errs = data.productVariantsBulkUpdate.userErrors;
  if (errs?.length) throw new Error(`inventory tracking update userErrors: ${JSON.stringify(errs)}`);
  // Read the mutation's OWN echo rather than trusting the absence of errors:
  // this is the gate between a listing and overselling, so "it said nothing"
  // is not good enough.
  //
  // TWO checks, because either alone has a blind spot. Scanning the returned
  // variants catches one that came back still untracked; but a variant DROPPED
  // from the response entirely — no entry, no userError, which bulk mutations
  // can do under concurrent modification — is invisible to that scan and would
  // pass. So the returned id set must also COVER every id requested.
  const echoed = (data.productVariantsBulkUpdate.productVariants || []).map((v) => ({
    variantId: v.id, tracked: v.inventoryItem?.tracked, inventoryPolicy: v.inventoryPolicy,
  }));
  const missing = variantIds.filter((id) => !echoed.some((v) => v.variantId === id));
  if (missing.length) {
    throw new Error(
      `inventory tracking response did not mention ${missing.length} requested variant(s): ` +
        missing.join(", ") + " — treating as not applied"
    );
  }
  const still = untrackedVariants(echoed);
  if (still.length) {
    throw new Error(
      `inventory tracking did not take on ${still.length} variant(s): ` +
        still.map((v) => v.variantId).join(", ")
    );
  }
  return { fixed: echoed.length };
}
