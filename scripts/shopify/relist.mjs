// ─── RELIST WHAT HAS STOCK — the pure half (Junid, 25 Oct 2026) ──────────────
// "The publisher unlists products with fewer than 4 in stock. That rule goes."
// relist-in-stock.mjs finds every product that exists on Shopify but is not on
// the Online Store (switched off, or a draft) while the app holds stock for it
// at the shops the website sells from, and puts it back EXACTLY as it is on
// Shopify: the intent it writes carries `relistKeep`, and the reconciler's
// "RELIST AS IT IS" branch then skips every title / description / photo push
// (reconcile.mjs). This file decides who qualifies and why not; it reads and
// writes nothing.
//
// MATCHED BY SHOPIFY PRODUCT ID, NEVER BY NAME. A Shopify product is tied to an
// app record only through /shopify_sync/_claims (numeric id → pid), the claim
// index the reconciler itself maintains. Twin products share names; a listing
// with no claim is legacy and is reported, never guessed.
//
// SKIPPED, EACH WITH A REASON A PERSON CAN ACT ON:
//   Birkenstock          — Junid: separate reconciliation.
//   archived on Shopify  — archived by hand in the admin; a person decides.
//   blocked              — the reconciler refused it; its reason is shown.
//   size with no variant — relisting would need a NEW variant (a variant-ID
//                          change), which a relist never does.
//   photos changed       — the app's photo list moved while it was off; once
//                          live, the media sync would push it to Shopify, and
//                          the catalogue's images are frozen until 28 Oct.
import { networkTotals } from "./inventory.mjs";
import { displaySizeName } from "./sizeOrder.mjs";
import { hasMediaModel, pushSigFor } from "./mediaSync.mjs";
import { CONDITIONS } from "./compliance.mjs";
import { normalizedState, isOnOrGoingOn } from "../../src/components/shopify/publishState.js";
import { isPriceRecord } from "../../src/utils/productCategory.js";
import { isDeactivated } from "../../src/utils/deactivation.js";

/** The bulk query: every product, its status, Online Store flag, media and variants. */
export function relistBulkQuery(onlinePublicationId) {
  return `{
    products {
      edges { node { id title handle status vendor
        publishedOnPublication(publicationId: "${onlinePublicationId}")
        media { edges { node { id } } }
        variants { edges { node { id title } } }
      } }
    }
  }`;
}

/** PURE: bulk JSONL → Map(gid → { id, title, handle, status, vendor, published, mediaIds, variants }). */
export function parseRelistSnapshot(jsonl) {
  const out = new Map();
  const children = [];
  for (const line of String(jsonl || "").split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.__parentId) children.push(o);
    else if (String(o.id).includes("/Product/")) {
      out.set(o.id, { id: o.id, title: o.title, handle: o.handle, status: o.status, vendor: o.vendor ?? null,
                      published: o.publishedOnPublication === true, mediaIds: [], variants: [] });
    }
  }
  for (const c of children) {
    const p = out.get(c.__parentId);
    if (!p) continue;
    if (String(c.id).includes("/ProductVariant/")) p.variants.push({ id: c.id, title: c.title });
    else p.mediaIds.push(c.id);
  }
  return out;
}

/** Listed = ACTIVE and on the Online Store. Anything else is "unlisted". */
export const isListed = (shop) => shop?.status === "ACTIVE" && shop?.published === true;

/** The numeric id the claim index is keyed by. */
export function numericIdOf(gid) {
  const m = /^gid:\/\/shopify\/Product\/(\d+)$/.exec(String(gid || ""));
  return m ? m[1] : null;
}

const BIRK = /birk(en)?stock/i;
/** Birkenstock by the app's name or brand, or by the Shopify title — any one is enough. */
export function isBirkenstock(product, shop) {
  return [product?.name, product?.brand, product?.cleanName, shop?.title, shop?.vendor]
    .some((v) => typeof v === "string" && BIRK.test(v));
}

/** Units at the website's locations, all sizes together (the pusher's own sum). */
export function onlineUnits(stockTree, pid, sizes) {
  if (!Array.isArray(sizes) || !sizes.length) return 0;
  return Object.values(networkTotals(stockTree, pid, sizes)).reduce((a, q) => a + q, 0);
}

/**
 * Should this unlisted Shopify product be relisted as it is?
 * → { relist: true } or { relist: false, code, why }.
 * `units` is onlineUnits; `shop` the snapshot entry; `node` /shopify_publish/{pid}.
 */
export function relistVerdict({ product, node, shop, units }) {
  const no = (code, why) => ({ relist: false, code, why });
  if (!product) return no("no-product", "no app product for this Shopify listing");
  if (product.mergedInto) return no("merged", `merged into ${product.mergedInto}`);
  if (isPriceRecord(product)) return no("not-merchandise", "a price record, not merchandise");
  if (isDeactivated(product)) return no("deactivated", "deactivated in the app");
  if (isBirkenstock(product, shop)) return no("birkenstock", "Birkenstock — separate reconciliation");
  if (!(units >= 1)) return no("no-stock", "no stock at the shops the website sells from");
  if (shop.status === "ARCHIVED") return no("archived", "archived by hand in the Shopify admin — a person decides");
  if (!node) return no("no-node", "no publishing record in the app");
  if (normalizedState(node) === "blocked") return no("blocked", `blocked by the reconciler: ${node.blockedReason || "no reason recorded"}`);
  if (isOnOrGoingOn(node)) return no("app-on", "the app already has it switched on — the reconciler is on it, or it needs a look");
  if (normalizedState(node) !== "live") return no("never-live", "never confirmed on Shopify by the app");
  if (!CONDITIONS.includes(node.condition)) return no("no-condition", "no condition grade");
  const sizes = Array.isArray(product.sizes) ? product.sizes : [];
  if (!sizes.length) return no("no-sizes", "the app record has no sizes");
  const titles = new Set((shop.variants || []).map((v) => v.title));
  const missing = sizes.filter((s) => !titles.has(displaySizeName(s)));
  if (missing.length) return no("size-no-variant", `size(s) ${missing.join(", ")} have no Shopify variant — relisting would need a new variant`);
  if (hasMediaModel(node) && node.mediaSyncedSig !== pushSigFor(node, product)) {
    return no("photos-changed", "its photo list changed in the app while it was off — relisting would push new photos to Shopify");
  }
  return { relist: true };
}

/**
 * The intent, as a transaction body on /shopify_publish/{pid}. Re-checks the
 * server's value: anything that is no longer "confirmed live, switched off,
 * not blocked, no intent to go on" is left alone (undefined = abort).
 */
export function relistIntent(cur, { now, by }) {
  if (!cur || normalizedState(cur) !== "live" || isOnOrGoingOn(cur)) return undefined;
  return { ...cur, desiredState: "on", blockedReason: null, relistKeep: now, updatedAt: now, updatedBy: by };
}

/**
 * The after-check for one relisted product: did Shopify keep the SAME title,
 * handle, media ids and variant ids, and is it now listed?
 * → [] when clean, else the list of what moved.
 */
export function relistDrift(before, after) {
  if (!after) return ["the product is gone from Shopify"];
  const out = [];
  if (after.title !== before.title) out.push(`title "${before.title}" → "${after.title}"`);
  if (after.handle !== before.handle) out.push(`handle ${before.handle} → ${after.handle}`);
  const ids = (xs) => JSON.stringify([...(xs || [])].sort());
  if (ids(after.mediaIds) !== ids(before.mediaIds)) out.push(`media ${before.mediaIds.length} → ${after.mediaIds.length} (ids changed)`);
  if (ids((after.variants || []).map((v) => v.id)) !== ids((before.variants || []).map((v) => v.id))) out.push("variant ids changed");
  return out;
}
