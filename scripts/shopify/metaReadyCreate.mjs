// ─── NEW Shopify products lead with the Meta-ready photo (from 28 Oct 2026) ──
// Junid, 25 Oct: "Shopify and the Meta catalogue use it for NEW products only;
// existing catalogue images untouched. Switch on 28 Oct." The Meta catalogue
// is fed from Shopify (its Facebook & Instagram channel), so a new listing's
// first image is what reaches it.
//
// Called by the reconciler ONLY when it has just CREATED a product. The
// reviewed photo set is not changed — only the file Shopify is handed for its
// first photo, so the set's fingerprint / media record stay as they are and
// nothing re-syncs later. Any failure → null, and the product is created with
// its normal primary.
import { createRequire } from "module";
import { metaReadyOn } from "../../src/utils/primaryPhotoFollow.js";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));

/** → the Meta-ready URL to hand Shopify instead of `firstUrl`, or null. */
export async function metaReadyFirstPhoto({ db, nowMs, pid, firstUrl, log = () => {}, deps = null }) {
  try {
    const cfg = (await db.ref("config/primaryPhoto").get()).val();
    if (!metaReadyOn(nowMs, cfg)) return null;
    const photoUrl = (await db.ref(`products/${pid}/photoUrl`).get()).val();
    // Only when the list leads with the product's primary photo.
    if (!firstUrl || firstUrl !== photoUrl) return null;
    const d = deps || (() => {
      const admin = require("firebase-admin");
      return { db, bucket: admin.storage().bucket("marathon-club.firebasestorage.app"), sharp: require("sharp") };
    })();
    const { ensureMetaReady } = require("./primaryPhoto/metaReady.cjs");
    await ensureMetaReady(d, pid);
    const meta = (await db.ref(`products/${pid}/photoMeta`).get()).val();
    if (meta?.sourceUrl !== firstUrl || typeof meta.url !== "string") return null;
    log(`  Meta-ready first photo for the new listing (${meta.fill || "?"})`);
    return meta.url;
  } catch (e) {
    log(`  ⚠ ${pid}: Meta-ready photo not used (${String(e?.message || e)}) — created with the normal primary`);
    return null;
  }
}
