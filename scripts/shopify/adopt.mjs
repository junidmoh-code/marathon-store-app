// ── ADOPTING A SHOPIFY PRODUCT THAT ALREADY OWNS THE HANDLE WE WANT ──────────
// Handles are unique per shop, and the reconciler builds them deterministically
// from the listing name — so the first thing a create hits is sometimes a
// product that is already sitting on the address it wants. Until now that
// ALWAYS refused, and the refusal named a script for a human to go and run.
// Two things were wrong with that:
//
//   · An orphan from our OWN crashed run (productSet applied, the /shopify_sync
//     claim never written) is not a hazard. It is litter, it will never be
//     cleaned up by anything else, and it blocks the product for ever — the
//     block outlives the very name that caused it, because a refusal consumes
//     the intent and only a fresh Publish clears it.
//   · A refusal naming a script is not a remedy for the person reading it.
//
// So: adopt what is safely adoptable, refuse the rest by name, and in EITHER
// refusing case get a new listing name moving without anyone having to ask.
//
// ── WHAT THIS WILL NOT TOUCH, AND WHY ────────────────────────────────────────
// It fails CLOSED. Adoption rewrites the product in place — title, handle,
// description, media, price, inventory, collections — so adopting the wrong
// one would overwrite a REAL listing that is trading. Three independent locks:
//
//   1. NOT MAPPED. A gid that any /shopify_sync record already claims belongs
//      to that record. This module reports it; the claim itself is enforced
//      atomically by claimShopifyProduct (a transaction over /shopify_sync),
//      which is the lock that actually holds under a race — the check here is
//      the cheap early answer, not the guarantee.
//   2. ZERO INVENTORY. Stock on a product is evidence somebody set it up for
//      sale. Anything above zero, on any variant, is refused.
//   3. ON NO SALES CHANNEL AT ALL. Not "not on OUR channel", and not "not on a
//      channel while ACTIVE" — ANY channel, ANY status. Two reviews walked this
//      one back in stages (2026-08-28): first it checked only the Online Store
//      publication, so a zero-stock ACTIVE product on POS, the Shop app or a
//      marketplace looked like litter; then it still allowed a DRAFT product
//      attached to a channel — and Shopify's status and publications are
//      independent, so such a product becomes VISIBLE on that channel the moment
//      its status flips, which is exactly what adopting it does. A product
//      somebody put on a channel is a product somebody set up.
//
// Any one failing refuses. Anything the API cannot answer refuses — an unknown
// is not a yes.
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { serverNowMs } from "./publishNode.mjs";

/**
 * May we adopt this Shopify product? → { ok, why }
 *
 * `why` is a SENTENCE for a person, on both branches: on a refusal it goes
 * into the row's blocked reason, so it must say what is in the way in words
 * the shop owner can act on.
 */
export async function adoptionVerdict(graphql, gid, onlineStorePublicationId) {
  let data;
  try {
    data = await graphql(
      `query ($id: ID!, $pub: ID!) {
        product(id: $id) {
          id title handle status totalInventory
          publishedOnPublication(publicationId: $pub)
          resourcePublicationsCount(onlyPublished: true) { count }
          variants(first: 100) { pageInfo { hasNextPage } nodes { inventoryQuantity } }
        }
      }`,
      { id: gid, pub: onlineStorePublicationId }
    );
  } catch (e) {
    return { ok: false, why: `the shop could not be asked about it (${String(e?.message || e)})` };
  }
  const p = data.product;
  if (!p) {
    // The handle probe found it a moment ago and now it is gone. Something is
    // moving underneath this run; refuse and let the next tick see a settled
    // shop rather than adopt on a reading we cannot repeat.
    return { ok: false, why: "it disappeared from the shop while this run was looking at it" };
  }
  // UNPAGINATED VARIANTS ARE AN UNKNOWN, and an unknown is a refusal: the
  // quantity that matters could be on page two.
  if (p.variants?.pageInfo?.hasNextPage) {
    return { ok: false, why: "it has more than 100 sizes and this run cannot see all their stock" };
  }
  const onOurChannel = p.publishedOnPublication === true;
  // EVERY channel, not just ours. A count the API declines to give is an
  // unknown, and an unknown is a refusal — so an absent field falls back to the
  // our-channel answer being the whole truth ONLY when it says yes; a missing
  // count with no channel of ours is treated as unknown and refused.
  const channelCount = Number(p.resourcePublicationsCount?.count);
  const anyChannel = Number.isFinite(channelCount) ? channelCount > 0 : null;
  if (anyChannel === null && !onOurChannel) {
    return { ok: false, why: "the shop would not say which sales channels it is on" };
  }
  // ANY CHANNEL AT ALL, WHATEVER THE STATUS. Not "any channel while ACTIVE":
  // Shopify's status and its publications are independent, and a DRAFT product
  // that is already attached to a channel becomes visible on that channel the
  // instant its status changes — which is precisely what adopting it does, since
  // the reconciler sets ACTIVE at the end of a publish. Adoption would therefore
  // have put our product in front of customers on a channel nobody chose for it
  // (CodeRabbit review, 2026-08-28, with the Shopify docs to match).
  //
  // This also makes the code say what the header always claimed: on NO sales
  // channel at all.
  const published = anyChannel === true || onOurChannel;
  if (published) {
    return {
      ok: false,
      why: onOurChannel
        ? (p.status === "ACTIVE" ? "it is on sale on the storefront right now"
                                 : "it is already set up on the storefront")
        : "it is set up on another sales channel",
    };
  }
  const total = Number(p.totalInventory);
  const variantUnits = (p.variants?.nodes ?? [])
    .reduce((n, v) => n + Math.max(0, Number(v.inventoryQuantity) || 0), 0);
  // BOTH counters, and the larger wins. totalInventory only counts variants
  // whose inventory is tracked, and an UNTRACKED variant is the one that sells
  // for ever — exactly the shape this repo has already had to repair once
  // (inventory.mjs, TRACKED_VARIANT). Reading only the summary would let a
  // stocked product look empty.
  const units = Math.max(Number.isFinite(total) ? total : 0, variantUnits);
  if (units > 0) {
    return { ok: false, why: `it holds ${units} unit${units === 1 ? "" : "s"} of stock` };
  }
  // Only one branch survives now: anything on a channel refused above.
  return {
    ok: true,
    why: `${String(p.status || "unknown").toLowerCase()} product with no stock, on no sales channel`,
  };
}

/**
 * Ask for a fresh listing name for this product, automatically.
 *
 * A refused handle collision has exactly one cure — a different name — and
 * leaving a person to notice that and go and ask for one is the manual step
 * this codebase does not accept. The request is a marker on the node;
 * vision-name.mjs serves markers FIRST on its next run, proposes a new name
 * from the product's photo, and clears the marker.
 *
 * It does NOT rename anything. The proposal still lands in the review lane for
 * a human decision, exactly like every other proposal — the automation here is
 * the asking, not the deciding.
 *
 * Best-effort by construction: a failure to record the request must never turn
 * a refusal (which is already written) into a crash that abandons the run.
 */
export async function requestFreshName(db, productId, why) {
  assertSafeSegment(productId, "productId");
  try {
    await db.ref(`shopify_publish/${productId}`).update({
      nameRerunRequestedAt: await serverNowMs(db),
      nameRerunReason: String(why ?? "").slice(0, 300),
    });
  } catch (e) {
    console.error(`  ⚠ ${productId}: could not record the new-name request (${String(e?.message || e)})`);
  }
}
