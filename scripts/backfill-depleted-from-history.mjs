// scripts/backfill-depleted-from-history.mjs
//
// ONE-TIME backfill: reconstructs the product-level `depletedAt` flag (Phase 15)
// from historical `stock_depleted` events in /insights_log. Before Phase 15,
// "no stock left to refill" was only ever recorded as an append-only insights
// event (action: "stock_depleted") on a per-ORDER basis — it never set the
// persistent product-level flag that drives the Depleted Products card + the
// assistant-grid blur. This script walks those events and lights up the flag on
// the products they map to, so the card reflects history instead of starting
// empty. Junid then uses "Bring Live" to clear the ones actually back in stock.
//
// MATCHING — events carry `productName` only (NO productId), so we match by
// NORMALIZED name (lowercase + trim + collapse internal whitespace) against the
// live catalog. Three outcomes, only the first is written:
//   • exactly 1 catalog product  → backfill it
//   • >1 product (ambiguous)      → SKIP (can't tell which is out of stock)
//   • 0 products (unmatched)      → SKIP (old shorthand/typo names, no catalog row)
// For a written product, depletedAt = the MOST RECENT matching event's timestamp
// and depletedBy = that event's hub (displayRefilledBy, falling back to placedAtHub).
//
// IDEMPOTENT / SAFE — skips any product that ALREADY has depletedAt set, so
// re-running never clobbers a product Junid has since "Bring Live"d, and never
// overwrites a fresh live depletion with an older historical timestamp. Default
// is a DRY RUN; nothing is written without --commit.
//
// Auth: anonymous Firebase auth. The marathon-club RTDB rules permit any
// authenticated user (incl. anon) to write /products — the project's known
// deferred security debt. Mirrors scripts/backfill-sku-barcode.mjs.
//
// Project: HARDCODED to marathon-club via FB_CONFIG below (mirrored from
// src/firebase.js). This script CANNOT target any other project.
//
// Usage:
//   node scripts/backfill-depleted-from-history.mjs           # DRY RUN — prints plan, writes nothing
//   node scripts/backfill-depleted-from-history.mjs --commit  # actually writes depletedAt/depletedBy
//
// Exit codes: 0 success / 1 any error.

import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, get, ref, update } from "firebase/database";

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

const COMMIT = process.argv.includes("--commit");

// Normalized name key — must match the matching contract documented above.
const norm = (s) => String(s == null ? "" : s).toLowerCase().trim().replace(/\s+/g, " ");

const app  = initializeApp(FB_CONFIG);
const auth = getAuth(app);
const db   = getDatabase(app);

console.log(`[backfill-depleted] project: ${FB_CONFIG.projectId}`);
console.log(`[backfill-depleted] mode:    ${COMMIT ? "COMMIT (will write)" : "DRY RUN (no writes)"}`);
console.log(`[backfill-depleted] signing in anonymously …`);
await signInAnonymously(auth);

// ─── Read source data ────────────────────────────────────────────────────────
console.log(`[backfill-depleted] reading /insights_log and /products …`);
const [logSnap, prodSnap] = await Promise.all([
  get(ref(db, "insights_log")),
  get(ref(db, "products")),
]);
const logs     = Object.values(logSnap.val() || {}).filter(Boolean);
const products = Object.entries(prodSnap.val() || {}).map(([id, v]) => ({ id, ...v }));

const events = logs.filter((e) => e.action === "stock_depleted");
console.log(`[backfill-depleted] stock_depleted events: ${events.length}`);

// ─── Collapse events to one entry per normalized product name (latest wins) ──
const byName = new Map(); // normName -> { rawName, latest }
for (const e of events) {
  const nn = norm(e.productName);
  if (!nn) continue;
  const cur = byName.get(nn) || { rawName: e.productName, latest: null };
  if (!cur.latest || String(e.timestamp || "") > String(cur.latest.timestamp || "")) cur.latest = e;
  byName.set(nn, cur);
}

// ─── Index catalog by normalized name (detect ambiguity) ─────────────────────
const prodByName = new Map(); // normName -> [products]
for (const p of products) {
  const nn = norm(p.name);
  if (!nn) continue;
  if (!prodByName.has(nn)) prodByName.set(nn, []);
  prodByName.get(nn).push(p);
}

// ─── Build the write plan ────────────────────────────────────────────────────
const toWrite = [];   // { id, name, depletedAt, depletedBy }
const skipExisting = [];
const ambiguous = [];
const unmatched = [];
for (const [nn, info] of byName) {
  const hits = prodByName.get(nn) || [];
  if (hits.length === 0) { unmatched.push(info.rawName); continue; }
  if (hits.length > 1)   { ambiguous.push({ name: info.rawName, ids: hits.map((h) => h.id) }); continue; }
  const p = hits[0];
  if (p.depletedAt) { skipExisting.push(p.name); continue; } // already depleted — never clobber
  toWrite.push({
    id: p.id,
    name: p.name,
    depletedAt: info.latest.timestamp,
    depletedBy: info.latest.displayRefilledBy || info.latest.placedAtHub || null,
  });
}

console.log(`\n[backfill-depleted] unique depleted product names: ${byName.size}`);
console.log(`[backfill-depleted]   matched & to write: ${toWrite.length}`);
console.log(`[backfill-depleted]   skipped (already depleted): ${skipExisting.length}`);
console.log(`[backfill-depleted]   skipped (ambiguous name → >1 product): ${ambiguous.length}`);
console.log(`[backfill-depleted]   skipped (unmatched name → 0 products): ${unmatched.length}`);
if (ambiguous.length) console.log(`[backfill-depleted]   ambiguous:`, JSON.stringify(ambiguous));
console.log(`\n[backfill-depleted] WRITE PLAN:`);
for (const w of toWrite) console.log(`  ${w.id}  depletedAt=${w.depletedAt}  depletedBy=${w.depletedBy ?? "(none)"}  — ${w.name}`);

if (!toWrite.length) { console.log(`\n[backfill-depleted] nothing to write.`); process.exit(0); }

if (!COMMIT) {
  console.log(`\n[backfill-depleted] DRY RUN — re-run with --commit to write the ${toWrite.length} flags above.`);
  process.exit(0);
}

// ─── Commit: one atomic root multi-path update ───────────────────────────────
const updates = {};
for (const w of toWrite) {
  updates[`products/${w.id}/depletedAt`] = w.depletedAt;
  updates[`products/${w.id}/depletedBy`] = w.depletedBy;
}
console.log(`\n[backfill-depleted] writing ${toWrite.length} products …`);
try {
  await update(ref(db), updates);
  console.log(`[backfill-depleted] ✓ done — ${toWrite.length} products marked depleted.`);
  process.exit(0);
} catch (err) {
  console.error(`[backfill-depleted] ✗ write failed:`, err && err.message ? err.message : err);
  process.exit(1);
}
