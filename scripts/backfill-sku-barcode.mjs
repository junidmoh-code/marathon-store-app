// scripts/backfill-sku-barcode.mjs
//
// One-time backfill: assigns sku + barcode to every /products/{id} that
// doesn't have them yet. Sorts by createdAt ascending so the oldest products
// get the lowest numbers. Idempotent — re-running skips products that
// already have sku. Counter logic mirrors reserveNextSkuAndBarcode() in
// src/App.jsx so the admin UI and this script will not collide if both
// happen to run at the same time.
//
// Auth: anonymous Firebase auth. The marathon-club RTDB rules permit any
// authenticated user (including anon) to write to /products and
// /products_meta — this is the project's known deferred security debt and
// is intentional for now. If rules tighten, this script will need a real
// staff credential instead.
//
// Project: HARDCODED to marathon-club via the FB_CONFIG below (mirrored
// from src/firebase.js). This script CANNOT target any other project.
//
// Usage:
//   node scripts/backfill-sku-barcode.mjs              # DRY RUN — prints plan, writes nothing
//   node scripts/backfill-sku-barcode.mjs --commit     # actually writes
//
// Exit codes: 0 success / 1 any write error.

import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, get, ref, runTransaction, update } from "firebase/database";

// ─── Config (mirrored from src/firebase.js — keep in sync) ───────────────────
const FB_CONFIG = {
  apiKey:            "AIzaSyAA3r3arlTQvouidDWY0OE-Y2t5ZUF8kCo",
  authDomain:        "marathon-club.firebaseapp.com",
  databaseURL:       "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "marathon-club",
  storageBucket:     "marathon-club.firebasestorage.app",
  messagingSenderId: "306270814317",
  appId:             "1:306270814317:web:470395933121de7dbdbf64",
};

// ─── Counter ceilings (mirrored from src/App.jsx — keep in sync) ─────────────
const SKU_MAX     =     9999; // 4-digit zero-padded
const BARCODE_MAX = 99999999; // 8-digit zero-padded

const COMMIT = process.argv.includes("--commit");

// ─── Init ────────────────────────────────────────────────────────────────────
const app  = initializeApp(FB_CONFIG);
const auth = getAuth(app);
const db   = getDatabase(app);

console.log(`[backfill] project: ${FB_CONFIG.projectId}`);
console.log(`[backfill] mode:    ${COMMIT ? "COMMIT (will write)" : "DRY RUN (no writes)"}`);
console.log(`[backfill] signing in anonymously …`);
await signInAnonymously(auth);

// ─── Read /products ──────────────────────────────────────────────────────────
console.log(`[backfill] reading /products …`);
const allSnap = await get(ref(db, "products"));
const all     = allSnap.val() || {};

// Same product-shape guard as useProducts() in src/App.jsx — drops empty
// slots and array-deserialized artefacts.
const products = Object.values(all).filter(
  v => v && typeof v === "object" && v.id && v.name
);
console.log(`[backfill] /products has ${products.length} real entries`);

// ─── Filter: missing sku (treat empty/whitespace as missing) ─────────────────
const needsSku = products.filter(p => {
  const s = p.sku;
  return !(typeof s === "string" && s.trim().length > 0);
});
console.log(`[backfill] ${needsSku.length} products need sku/barcode assignment`);

if (needsSku.length === 0) {
  console.log(`[backfill] nothing to do — exiting.`);
  process.exit(0);
}

// ─── Sort oldest first so the earliest createdAt gets sku 0001 ───────────────
// createdAt is an ISO string in this codebase (see placeOrders in App.jsx)
// so localeCompare gives correct chronological order. Missing createdAt
// sorts to the top (treated as ""), which is fine — those are the oldest
// pre-instrumented products and deserve the lowest numbers.
needsSku.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));

// ─── Show the plan ───────────────────────────────────────────────────────────
console.log(`[backfill] plan preview (first 5):`);
for (const p of needsSku.slice(0, 5)) {
  console.log(`  ${p.id.padEnd(20)} createdAt=${p.createdAt || "(none)"} name="${p.name}"`);
}
if (needsSku.length > 5) console.log(`  … and ${needsSku.length - 5} more`);

// ─── Show current /products_meta state ───────────────────────────────────────
const metaSnap = await get(ref(db, "products_meta"));
const meta     = metaSnap.val() || {};
console.log(`[backfill] /products_meta current: lastSku=${meta.lastSku ?? "(unset)"} lastBarcode=${meta.lastBarcode ?? "(unset)"}`);

if (!COMMIT) {
  console.log(`[backfill] DRY RUN complete — pass --commit to write.`);
  process.exit(0);
}

// ─── Commit: per-product runTransaction on /products_meta ────────────────────
// Per-product transaction keeps the script safe even if the admin UI is
// being used in parallel. About ~50ms/product on a normal connection;
// 1026 products → ~1 minute.
console.log(`[backfill] starting writes …`);
let written = 0;
let skipped = 0;
let errors  = 0;

for (const p of needsSku) {
  try {
    // Re-fetch right before writing: another tab may have assigned sku
    // mid-backfill via the admin UI.
    const liveSnap = await get(ref(db, `products/${p.id}`));
    const live     = liveSnap.val();
    if (live && typeof live.sku === "string" && live.sku.trim().length > 0) {
      skipped++;
      continue;
    }

    // Reserve next sku + barcode atomically. Mirrors reserveNextSkuAndBarcode
    // in src/App.jsx — must stay in sync.
    let reserved = null;
    const tx = await runTransaction(ref(db, "products_meta"), (current) => {
      const lastSku     = (current && typeof current.lastSku     === "number") ? current.lastSku     : 0;
      const lastBarcode = (current && typeof current.lastBarcode === "number") ? current.lastBarcode : 0;
      const nextSku     = lastSku + 1;
      const nextBarcode = lastBarcode + 1;
      if (nextSku > SKU_MAX || nextBarcode > BARCODE_MAX) {
        reserved = { error: `Counter exhausted at sku=${nextSku} barcode=${nextBarcode}` };
        return; // abort transaction
      }
      reserved = {
        sku:     String(nextSku).padStart(4, "0"),
        barcode: String(nextBarcode).padStart(8, "0"),
      };
      return { ...(current || {}), lastSku: nextSku, lastBarcode: nextBarcode };
    });
    if (!tx.committed) throw new Error(reserved?.error || "reservation aborted");

    await update(ref(db, `products/${p.id}`), {
      sku:     reserved.sku,
      barcode: reserved.barcode,
    });
    written++;
    if (written % 50 === 0) {
      console.log(`[backfill] wrote ${written}/${needsSku.length} …`);
    }
  } catch (err) {
    console.warn(`[backfill] FAILED ${p.id}: ${err.message}`);
    errors++;
  }
}

// ─── Final summary ───────────────────────────────────────────────────────────
const finalMetaSnap = await get(ref(db, "products_meta"));
const finalMeta     = finalMetaSnap.val() || {};
console.log(`[backfill] done. written=${written} skipped=${skipped} errors=${errors}`);
console.log(`[backfill] /products_meta final:   lastSku=${finalMeta.lastSku} lastBarcode=${finalMeta.lastBarcode}`);
process.exit(errors > 0 ? 1 : 0);
