// scripts/seed-depleted-preview.mjs  (PREVIEW-ONLY — not part of PR #47)
//
// Marks/clears a single product's depletedAt+depletedBy so the Phase 15
// depleted-product feature can be previewed against the live marathon-club DB.
// SAFE while PR #47 is unmerged: the deployed prod app has no depleted code, so
// this flag is invisible in production and only renders in the local dev build.
// ALWAYS clear it before deploy.
//
// Auth: anonymous Firebase auth (rules allow any authed user to write /products),
// mirroring scripts/backfill-sku-barcode.mjs.
//
// Usage:
//   node scripts/seed-depleted-preview.mjs --list                 # list products (id, name, type, hubs, depletedAt)
//   node scripts/seed-depleted-preview.mjs --set <id> [--hub hub1] # mark depleted (default hub: hub1)
//   node scripts/seed-depleted-preview.mjs --clear <id>            # clear depletion (Bring Live equivalent)

import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, get, ref, update } from "firebase/database";

const FB_CONFIG = {
  apiKey:            "AIzaSyAA3r3arlTQvouidDWY0OE-Y2t5ZUF8kCo",
  authDomain:        "marathon-club.firebaseapp.com",
  databaseURL:       "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "marathon-club",
  storageBucket:     "marathon-club.firebasestorage.app",
  messagingSenderId: "306270814317",
  appId:             "1:306270814317:web:470395933121de7dbdbf64",
};

const args = process.argv.slice(2);
const has  = (f) => args.includes(f);
const valOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

const app = initializeApp(FB_CONFIG);
const auth = getAuth(app);
const db = getDatabase(app);

await signInAnonymously(auth);

const snap = await get(ref(db, "products"));
const data = snap.val() || {};
const products = Object.values(data).filter(p => p && p.id && p.name);

if (has("--list") || args.length === 0) {
  console.log(`\n${products.length} products:\n`);
  for (const p of products.sort((a, b) => (a.name || "").localeCompare(b.name || ""))) {
    const hubs = (p.hubs || (p.hub ? [p.hub] : [])).join("/") || "—";
    const dep  = p.depletedAt ? `  *** DEPLETED @ ${p.depletedAt} (${p.depletedBy || "?"}) ***` : "";
    console.log(`  ${p.id}\t[${p.productType || "sneaker"}]\t${hubs}\t${p.photoUrl ? "📷" : "  "}  ${p.name}${dep}`);
  }
  process.exit(0);
}

const id = valOf("--set") || valOf("--clear");
if (!id) { console.error("Provide a product id: --set <id> | --clear <id>"); process.exit(1); }
const target = products.find(p => p.id === id);
if (!target) { console.error(`No product with id ${id}`); process.exit(1); }

if (has("--set")) {
  const hub = valOf("--hub") || "hub1";
  await update(ref(db, `products/${id}`), { depletedAt: new Date().toISOString(), depletedBy: hub });
  console.log(`SET depleted: "${target.name}" (${id}) depletedBy=${hub}`);
} else if (has("--clear")) {
  await update(ref(db, `products/${id}`), { depletedAt: null, depletedBy: null });
  console.log(`CLEARED depletion: "${target.name}" (${id})`);
}
process.exit(0);
