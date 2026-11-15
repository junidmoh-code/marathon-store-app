// ─── CONCRETE LISTING — which products ALSO list on the Concrete store ───────
// Junid opened a second Shopify store for his brand Concrete (g2m9cm-9q,
// concreteworld.co.za). A product he marks is listed on BOTH stores and sells
// from the one shared stock pool. Marathon's publishing never reads any of
// this: a product stays on Marathon exactly as today whether it is marked or
// not.
//
// ── WHERE THE TRUTH LIVES ───────────────────────────────────────────────────
//   /products/{pid}.listOnConcrete       true = also on Concrete; absent/false = Marathon only
//   /products/{pid}.listOnConcreteSetBy  uid of whoever last flipped it
//   /products/{pid}.listOnConcreteSetAt  serverNowMs() of that flip
//   /products/{pid}.brandVerifiedAt      serverNowMs() of the human brand check
//   /products/{pid}.brandVerifiedBy      uid of that human
//
// ── NO SECOND INDEX ─────────────────────────────────────────────────────────
// Every browser screen already holds /products in memory (useProducts, the
// offline-mirrored subscription), so the Concrete publishing tab and Brand
// Check filter that list; nothing here needs an .indexOn or a shadow node.
// The scripts never need "every marked product" either: they work from
// /shopify_publish_concrete (indexed like Marathon's) and read /products/{pid}
// one record at a time, refusing any product whose mark has gone.
//
// ── BRAND CHECK ─────────────────────────────────────────────────────────────
// A product needs a human brand check when it was created after this shipped
// (CONCRETE_SHIP_AT) or its Concrete mark was flipped, and no brandVerifiedAt
// covers that flip. The bulk list in Product Admin is Junid/admin making a
// deliberate brand decision, so it passes verify:true and stamps both at once;
// the upload switch does not, so a staff-marked product lands in Brand Check.

// ── UNMARKING A LIVE PRODUCT ────────────────────────────────────────────────
// Takes it off the Concrete store, never off Marathon: the same update writes
// /shopify_publish_concrete/{pid}/desiredState = "off" for every product the
// caller knows is live there. The reconciler applies it like any other Off.
// It never creates a publish row for a product that has none (the rule
// requires `state`, and a fabricated row would show as a ghost in the tab).
import { assertSafeSegment } from "./sizeKey.js";

// The instant this shipped (2026-11-15 22:00 SAST). Products created before it were
// never brand-checked by this process and are not dumped into Brand Check.
export const CONCRETE_SHIP_AT = Date.UTC(2026, 10, 15, 20, 0, 0);
export const CONCRETE_PUBLISH_PATH = "shopify_publish_concrete";
export const CONCRETE_SYNC_PATH = "shopify_sync_concrete";

/** The one reader. Anything but literal true is "Marathon only". */
export function isOnConcrete(product) {
  return product?.listOnConcrete === true;
}

/** Creation instant from the id ("p" + server ms — every id conforms). */
export function createdAtFromId(pid) {
  const m = /^p(\d{12,14})/.exec(String(pid || ""));
  return m ? Number(m[1]) : 0;
}

/** True when this product is waiting for a human brand check. */
export function needsBrandCheck(product, pid = product?.id, shipAt = CONCRETE_SHIP_AT) {
  if (!product || typeof product !== "object") return false;
  const verifiedAt = Number(product.brandVerifiedAt) || 0;
  const setAt = Number(product.listOnConcreteSetAt) || 0;
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
 * The multi-path update that marks / unmarks products. PURE — no clock, no
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
    updates[`products/${pid}/listOnConcrete`] = on;
    updates[`products/${pid}/listOnConcreteSetBy`] = uid;
    updates[`products/${pid}/listOnConcreteSetAt`] = nowMs;
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
export async function setOnConcrete(applyRootUpdate, args) {
  const updates = buildConcreteUpdate(args);
  const count = Object.keys(updates).filter((k) => k.endsWith("/listOnConcrete")).length;
  if (!count) return { ok: true, count: 0 };
  try {
    await applyRootUpdate(updates);
    return { ok: true, count };
  } catch (err) {
    const msg = String(err?.message || err);
    return {
      ok: false,
      message: /permission/i.test(msg)
        ? "Permission denied — the Concrete console rules have not been pasted yet."
        : msg,
    };
  }
}
