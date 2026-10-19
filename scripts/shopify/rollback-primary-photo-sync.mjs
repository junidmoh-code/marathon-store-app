#!/usr/bin/env node
// ─── ROLLBACK of sync-primary-photos-to-app.mjs ──────────────────────────────
//   node scripts/shopify/rollback-primary-photo-sync.mjs <ledger.json>            # dry run
//   node scripts/shopify/rollback-primary-photo-sync.mjs <ledger.json> --commit   # restore
//   … --pid=p123 (one product)
//
// Per ledger entry: puts photoUrl, photoUrlOriginal and photoSource back as
// they were before the sync, and rebuilds the till thumbnail from the old
// photo (or removes it when that fails — never the synced photo's thumbnail
// under the restored marker). REFUSES a product whose photoUrl, photoUrlOriginal
// or photoSource has changed since the sync — a later edit is never overwritten.
// The Shopify Publishing list is not touched.
import { readFileSync } from "node:fs";
import { rollbackEntry } from "./primaryPhotoSync.mjs";
import { initAdmin, readers, productWriter, thumbRebuilder, thumbRemover } from "./primaryPhotoNode.mjs";

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
const COMMIT = argv.includes("--commit");
const ONLY = argv.find((a) => a.startsWith("--pid="))?.slice(6) || null;
if (!file) { console.error("usage: rollback-primary-photo-sync.mjs <ledger.json> [--commit] [--pid=…]"); process.exit(2); }

const ledger = JSON.parse(readFileSync(file, "utf8"));
const entries = (ledger.entries || []).filter((e) => !ONLY || e.pid === ONLY);
const { app, db, bucket } = initAdmin();
const { readProduct } = readers(db);
const deps = { readProduct, writeProduct: productWriter(db), rebuildThumb: thumbRebuilder(bucket, "rollback"),
               removeThumb: thumbRemover(bucket), apply: COMMIT };

console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — rolling back ${entries.length} product(s) from ${file}`);
let restored = 0, refused = 0, failed = 0;
for (const e of entries) {
  try {
    const r = await rollbackEntry(e, deps);
    if (r.ok) { restored += 1; console.log(`  ${e.pid}: ${COMMIT ? "restored" : "would restore"} → ${r.patch.photoUrl ?? "(no photo)"}${COMMIT && !r.thumb ? " (thumbnail removed, not rebuilt)" : ""}`); }
    else { refused += 1; console.log(`  ${e.pid}: REFUSED — ${r.refused}`); }
  } catch (err) {
    failed += 1;
    console.log(`  ${e.pid}: FAILED — ${err?.message || err}`);
  }
}
console.log(`\n${COMMIT ? "restored" : "would restore"}: ${restored} · refused: ${refused} · failed: ${failed}`);
await app.delete();
process.exit(failed ? 1 : 0);
