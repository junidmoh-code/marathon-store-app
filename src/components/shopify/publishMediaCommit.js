// ─── THE ONLY WAY THE APP WRITES A PUBLISHING MEDIA LIST ─────────────────────
// Every edit of /shopify_publish/{pid}/media from the browser — reorder, Make
// primary, remove, upload, AI Studio add / "Use instead of this one" — comes
// through commitPublishMedia, so none can move the PRIMARY photo without the
// app photo following (primaryPhotoCore.setShopifyPrimaryPhoto, Junid 26 Sep /
// 19 Oct 2026). primaryPhotoGuard.test.js fails if a caller writes the list
// any other way.
//
// Firebase-free: the Storage/RTDB legs are the injected `deps`
// (appPhoto.browserPrimaryPhotoDeps in the app).
import { photoUrlsOf, resolveMediaList } from "./publishShared";
import { setPublishMedia, appendPublishMedia } from "./shopifyPublishStore";
import { publishTarget, holdTarget } from "./publishTarget.js";
import { setShopifyPrimaryPhoto } from "./primaryPhotoCore";

const primaryOf = (node, product) => photoUrlsOf(resolveMediaList(node, product).items)[0] || null;

/**
 * Write the product's publishing media list — `op` "set" (the whole ordered
 * list) or "append" (new items at the end) — and, when that moved the
 * primary, make the app photo follow (one retry: the list is already saved).
 * → { res, app }: the store's answer, and the app-photo answer (null when
 * the list write was refused).
 */
export async function commitPublishMedia(product, node, op, items, deps) {
  // Read the store ONCE, before any await, and hold it for the whole commit.
  const release = holdTarget();
  try { return await commitPublishMediaHeld(product, node, op, items, deps, publishTarget()); }
  finally { release(); }
}

async function commitPublishMediaHeld(product, node, op, items, deps, store) {
  const oldPrimary = primaryOf(node, product);
  const res = op === "append"
    ? await appendPublishMedia(product.id, node, items, product)
    : await setPublishMedia(product.id, node, items);
  if (!res?.ok) return { res, app: null };
  const newPrimary = primaryOf(res.node, product);
  if (!newPrimary || newPrimary === oldPrimary) return { res, app: { ok: true, changed: false } };
  // CONCRETE NEVER MOVES THE APP PHOTO. The Concrete store's publishing photo
  // (its house-style photo, or any reorder on that tab) is a Concrete-only
  // choice: the product's app photo — and so Marathon's listing — is untouched.
  if (store !== "marathon") return { res, app: { ok: true, changed: false, reason: "concrete-only" } };
  const args = { product, oldPrimary, newPrimary };
  let app = await setShopifyPrimaryPhoto(product.id, args, deps);
  if (!app.ok) app = await setShopifyPrimaryPhoto(product.id, args, deps);
  return { res, app };
}
