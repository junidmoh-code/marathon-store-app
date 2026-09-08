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

// ── READ SHOPIFY'S SIDE, AND READ IT FIRST ───────────────────────────────────
// Split out of setAvailable on purpose, because WHEN this read happens is the
// whole correctness argument — see the block on setAvailable below. Callers
// must take it BEFORE they snapshot /stock.
// → Map(inventoryItemId → available quantity). An id Shopify does not know is
//   absent from the map rather than defaulted to 0: "unknown" and "zero" are
//   different facts and the caller has to be able to tell them apart.
export async function readAvailable(graphql, locationId, inventoryItemIds) {
  const out = new Map();
  if (!inventoryItemIds.length) return out;
  const data = await graphql(
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
    { ids: inventoryItemIds, loc: locationId }
  );
  for (const n of data.nodes ?? []) {
    if (!n?.id) continue;
    out.set(n.id, n.inventoryLevel?.quantities?.find((x) => x.name === "available")?.quantity ?? 0);
  }
  return out;
}

// Thrown when Shopify's quantity moved between the caller's baseline read and
// this write. It is its own class because the CALLER must be able to tell it
// apart from a transport failure: a transport failure means "try again", this
// means "something sold and your number is stale" — a different sentence in a
// log and a different decision.
export class InventoryMovedError extends Error {
  constructor(message, { pid = null, details = [] } = {}) {
    super(message);
    this.name = "InventoryMovedError";
    this.inventoryMoved = true;
    this.pid = pid;
    this.details = details;
  }
}

// Set absolute available quantities at the single location.
// items: [{ inventoryItemId, quantity }]. Absolute set (not delta), so a
// re-run converges instead of double-counting.
//
// ── THE BASELINE IS A PARAMETER, AND THAT IS THE POINT ───────────────────────
// The 2026-07 API makes this a compare-and-set: `changeFromQuantity` must be
// supplied and the mutation fails if Shopify no longer holds that value. Used
// correctly, that is what stops a concurrent sale being silently overwritten.
//
// IT WAS NOT USED CORRECTLY. This function used to read the current quantities
// ITSELF, immediately before mutating, and use that as the compare value. The
// window it guarded was therefore its own read → its own write: microseconds,
// and never the window that mattered. The caller had computed `quantity` from
// a /stock snapshot taken EARLIER; a sale landing between that snapshot and
// this read moved Shopify's value, the fresh read picked the moved value up as
// the baseline, the compare-and-set passed, and the sale was overwritten with
// a number that predated it. The guarantee the comment claimed — "a concurrent
// change makes the mutation error rather than silently clobber" — was the
// exact opposite of what the code did. A reviewer reproduced it: quantity 5
// written with changeFromQuantity 4 while the true remaining stock was 4.
//
// So the baseline is now passed IN, and it is REQUIRED. A caller has to have
// read Shopify before it snapshotted stock, which makes the compare-and-set
// span the whole operation — every sale from the baseline read to this write
// fails it. There is no default and no internal re-read, because either would
// let a caller opt back into the bug without saying so.
//
// WHAT THIS DOES NOT FIX, stated plainly so nobody reads it as more than it
// is: /stock never learns about an online sale (there is no order webhook), so
// the number computed from it is systematically high by whatever has sold
// online. This makes that collision VISIBLE and refuses the write; it does not
// make the app's count right. See scripts/shopify/README.md.
export async function setAvailable(graphql, locationId, items, baseline) {
  if (!items.length) return { set: 0 };
  if (!(baseline instanceof Map)) {
    throw new TypeError(
      "setAvailable requires a baseline Map read BEFORE the /stock snapshot — " +
        "see readAvailable(). Passing none would silently restore the overwrite bug."
    );
  }
  const unknown = items.filter((i) => !baseline.has(i.inventoryItemId));
  if (unknown.length) {
    throw new Error(
      `setAvailable: ${unknown.length} inventory item(s) are absent from the baseline ` +
        `(${unknown.map((i) => i.inventoryItemId).join(", ")}) — the caller must drop ` +
        `ids Shopify does not know before writing, not let them default to zero.`
    );
  }
  // 2026-07 requires @idempotent on this mutation. The key is minted once per
  // call, so the client's own retry of the same request replays, not doubles.
  const { randomUUID } = await import("crypto");
  const data = await graphql(
    `mutation ($input: InventorySetQuantitiesInput!, $key: String!) {
      inventorySetQuantities(input: $input) @idempotent(key: $key) {
        inventoryAdjustmentGroup { reason }
        userErrors { field message code }
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
          changeFromQuantity: baseline.get(inventoryItemId),
        })),
      },
    },
    { mutation: true }
  );
  const errs = data.inventorySetQuantities.userErrors;
  if (errs?.length) {
    // A compare-and-set rejection is not a bug in this program — it is the
    // guard doing its job, and it means a sale landed mid-push. Named, so the
    // caller reports "stock moved" instead of "Shopify errored".
    //
    // CLASSIFIED BY `code`, NOT BY WORDING. InventorySetQuantitiesUserError
    // carries CHANGE_FROM_QUANTITY_STALE for exactly this case. Matching the
    // message text instead would misread an unrelated validation error as a
    // sale — turning a real refusal into "harmless, retry" — and would break
    // silently the day Shopify rephrases it. The regex survives only as the
    // fallback for an error that arrives without a code. (CodeRabbit, #589.)
    const moved = errs.some((e) => (
      e?.code
        ? e.code === "CHANGE_FROM_QUANTITY_STALE"
        : /changeFromQuantity|compare|stale|does not match/i.test(String(e?.message))
    ));
    if (moved) {
      throw new InventoryMovedError(
        `Shopify's quantity moved between the baseline read and the write — a sale ` +
          `landed mid-push. Nothing was written; the next run recomputes. ` +
          `(${errs.map((e) => e.message).join("; ")})`,
        { details: errs }
      );
    }
    throw new Error(`inventorySetQuantities userErrors: ${JSON.stringify(errs)}`);
  }
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
