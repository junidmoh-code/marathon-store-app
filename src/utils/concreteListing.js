// ─── CONCRETE PRODUCTS — Concrete-ONLY (Junid, 20 Nov 2026) ─────────────────
// Junid opened a second Shopify store for his brand Concrete (g2m9cm-9q,
// concreteworld.co.za). PRs #911/#912 shipped "listOnConcrete = also list on
// Concrete, stay on Marathon". Junid then decided: a product marked Concrete is
// CONCRETE-ONLY — sold on the Concrete website only, and handled by the
// Concrete division in Missing Products.
//
// ── WHERE THE TRUTH LIVES ───────────────────────────────────────────────────
//   /products/{pid}.concreteProduct        true = Concrete-only; absent/false = Marathon
//   /products/{pid}.concreteProductSetBy   uid of whoever last flipped it
//   /products/{pid}.concreteProductSetAt   serverNowMs() of that flip
//   /products/{pid}.brandVerifiedAt / By   the human brand check (PayFast rule)
//   /settings/concreteOnlyIndex/{pid}      true while Concrete-only — a SMALL
//                                          index so the Marathon reconciler can
//                                          find Concrete-only products without
//                                          reading /products (6,000+ records)
//
// ── THE LEGACY FIELD (one release) ──────────────────────────────────────────
// listOnConcrete is still READ: a record with no concreteProduct field and
// listOnConcrete:true is Concrete-only (the migration converts all of them).
// For this one release every write ALSO mirrors listOnConcrete*, so a Mac mini
// still running the #911 Concrete reconciler (which checks listOnConcrete)
// keeps publishing the same set. Next release: set LEGACY_MIRROR = false.
//
// ── WHAT CONCRETE-ONLY MEANS ELSEWHERE ──────────────────────────────────────
//   • Marathon's publishing tab and reconciler skip these products, and the
//     Marathon reconciler turns OFF any that are live on marathonclub.co.za
//     (scripts/shopify/reconcile.mjs, reading the index above).
//   • Missing Products lists them under the Concrete division, not Marathon
//     (missingProductsCore.js).
//
// ── BRAND CHECK ─────────────────────────────────────────────────────────────
// Concrete still refuses a product no human has brand-checked (PayFast). The
// Brand Check TAB is hidden (Junid, 20 Nov 2026): the only places that mark a
// product now are Junid/admin screens (the Concrete Products card, Missing
// Products' Concrete button, Product Admin → All products), and they pass
// verify:true, so the flip IS the check. Staff no longer mark at upload.
//
// ── UNMARKING A PRODUCT LIVE ON CONCRETE ────────────────────────────────────
// Takes it off the Concrete store: the same update writes
// /shopify_publish_concrete/{pid}/desiredState = "off" for every product the
// caller knows is live there. It never creates a publish row for a product
// that has none. It does NOT republish it on Marathon — that is a person's
// decision on the Marathon tab.
import { assertSafeSegment } from "./sizeKey.js";

// The instant this shipped (2026-11-15 22:00 SAST). Products created before it were
// never brand-checked by this process and are not dumped into Brand Check.
export const CONCRETE_SHIP_AT = Date.UTC(2026, 10, 15, 20, 0, 0);
export const CONCRETE_PUBLISH_PATH = "shopify_publish_concrete";
export const CONCRETE_SYNC_PATH = "shopify_sync_concrete";

export const CONCRETE_INDEX_PATH = "settings/concreteOnlyIndex";
// Mirror listOnConcrete* on every write for ONE release (see header).
export const LEGACY_MIRROR = true;

/**
 * THE one reader: is this product Concrete-only? An explicit concreteProduct
 * boolean wins; with no concreteProduct field the legacy listOnConcrete:true
 * still counts (readable for one release). Anything but literal true is
 * "Marathon".
 */
export function isConcreteProduct(product) {
  if (!product || typeof product !== "object") return false;
  if (typeof product.concreteProduct === "boolean") return product.concreteProduct;
  return product.listOnConcrete === true;
}
/** @deprecated — the #911 name; same answer as isConcreteProduct. */
export const isOnConcrete = isConcreteProduct;

/** Creation instant from the id ("p" + server ms — every id conforms). */
export function createdAtFromId(pid) {
  const m = /^p(\d{12,14})/.exec(String(pid || ""));
  return m ? Number(m[1]) : 0;
}

/** True when this product is waiting for a human brand check. */
export function needsBrandCheck(product, pid = product?.id, shipAt = CONCRETE_SHIP_AT) {
  if (!product || typeof product !== "object") return false;
  const verifiedAt = Number(product.brandVerifiedAt) || 0;
  const setAt = Math.max(Number(product.listOnConcreteSetAt) || 0, Number(product.concreteProductSetAt) || 0);
  const created = Number(product.createdBy?.at) || createdAtFromId(pid);
  if (setAt > 0 && setAt > verifiedAt) return true;
  return created >= shipAt && verifiedAt === 0;
}

function ids(productIds) {
  const list = Array.isArray(productIds) ? productIds : [productIds];
  const out = [];
  const seen = new Set();
  for (const pid of list) {
    if (typeof pid !== "string" || !pid) continue;
    assertSafeSegment(pid, "productId");
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
  }
  return out;
}

/**
 * The multi-path update that marks / unmarks products Concrete-only. PURE — no clock, no
 * database: the caller passes `nowMs` (serverNowMs() in the browser,
 * publishNode.serverNowMs(db) in a script).
 *
 *   on              boolean — the new state
 *   uid             who is doing it (opaque uid, never an email)
 *   nowMs           server-corrected epoch ms
 *   verify          true = this flip IS the brand check (stamps brandVerified*)
 *   liveOnConcrete  Set/array of pids currently live on Concrete — unmarking one
 *                   of those also turns its Concrete listing off
 */
export function buildConcreteUpdate({ productIds, on, uid, nowMs, verify = false, liveOnConcrete = null }) {
  if (typeof on !== "boolean") throw new Error("buildConcreteUpdate: `on` must be a boolean");
  if (typeof uid !== "string" || !uid) throw new Error("buildConcreteUpdate: `uid` is required");
  if (!(Number.isFinite(nowMs) && nowMs > 0)) throw new Error("buildConcreteUpdate: `nowMs` must be server epoch ms");
  const live = liveOnConcrete instanceof Set ? liveOnConcrete : new Set(liveOnConcrete || []);
  const updates = {};
  for (const pid of ids(productIds)) {
    updates[`products/${pid}/concreteProduct`] = on;
    updates[`products/${pid}/concreteProductSetBy`] = uid;
    updates[`products/${pid}/concreteProductSetAt`] = nowMs;
    if (LEGACY_MIRROR) {
      updates[`products/${pid}/listOnConcrete`] = on;
      updates[`products/${pid}/listOnConcreteSetBy`] = uid;
      updates[`products/${pid}/listOnConcreteSetAt`] = nowMs;
    }
    updates[`${CONCRETE_INDEX_PATH}/${pid}`] = on ? true : null;
    if (verify) {
      updates[`products/${pid}/brandVerifiedAt`] = nowMs;
      updates[`products/${pid}/brandVerifiedBy`] = uid;
    }
    if (!on && live.has(pid)) {
      updates[`${CONCRETE_PUBLISH_PATH}/${pid}/desiredState`] = "off";
      updates[`${CONCRETE_PUBLISH_PATH}/${pid}/updatedAt`] = nowMs;
      updates[`${CONCRETE_PUBLISH_PATH}/${pid}/updatedBy`] = uid;
    }
  }
  return updates;
}

/**
 * Brand Check's one tap: confirm what the product is, optionally flipping the
 * Concrete marking in the same write. `on` = the state being confirmed.
 */
export function buildBrandConfirmUpdate({ productId, on, wasOn, uid, nowMs, liveOnConcrete = null }) {
  const [pid] = ids(productId);
  if (!pid) throw new Error("buildBrandConfirmUpdate: productId is required");
  if (typeof on !== "boolean") throw new Error("buildBrandConfirmUpdate: `on` must be a boolean");
  if (on !== (wasOn === true)) {
    return buildConcreteUpdate({ productIds: [pid], on, uid, nowMs, verify: true, liveOnConcrete });
  }
  if (typeof uid !== "string" || !uid) throw new Error("buildBrandConfirmUpdate: `uid` is required");
  if (!(Number.isFinite(nowMs) && nowMs > 0)) throw new Error("buildBrandConfirmUpdate: `nowMs` must be server epoch ms");
  return {
    [`products/${pid}/brandVerifiedAt`]: nowMs,
    [`products/${pid}/brandVerifiedBy`]: uid,
  };
}

/**
 * Apply a mark/unmark through an injected root-level `update(updates)`.
 * Returns { ok, count } or { ok:false, message }.
 */
export async function setConcreteProduct(applyRootUpdate, args) {
  const updates = buildConcreteUpdate(args);
  const count = Object.keys(updates).filter((k) => k.endsWith("/concreteProduct")).length;
  if (!count) return { ok: true, count: 0 };
  try {
    await applyRootUpdate(updates);
    return { ok: true, count };
  } catch (err) {
    const msg = String(err?.message || err);
    return {
      ok: false,
      message: /permission/i.test(msg)
        ? "Permission denied — the Concrete console rules have not been pasted yet. Nothing was saved."
        : msg,
    };
  }
}
/** @deprecated — the #911 name. */
export const setOnConcrete = setConcreteProduct;
