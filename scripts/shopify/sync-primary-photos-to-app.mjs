#!/usr/bin/env node
// ─── BACKFILL: every product's Shopify primary photo becomes its app photo ──
// Junid, 26 Sep / 19 Oct 2026: the Shopify Publishing PRIMARY photo is the
// product's photo everywhere in the app. The forward rule is live in the photo
// strip and the New Arrivals chain; this brings every product edited before
// it in line, through the SAME function (primaryPhotoCore.setShopifyPrimaryPhoto).
//
//   node scripts/shopify/sync-primary-photos-to-app.mjs            # dry run (default)
//   node scripts/shopify/sync-primary-photos-to-app.mjs --commit   # apply
//   … --pid=p123 (one product)  --limit=N  --concurrency=8  --report=rows.jsonl
//
// Walks /shopify_publish KEYS shallowly; per product reads only media/photos
// and the product's photoUrl/photoUrlOriginal/photoSource. One listing of
// products/ in Storage (names + md5) finds photos shared with ANOTHER product:
// those are skipped and listed, never synced.
//
// Idempotent: a rerun finds every synced product "matching" (same URL) and
// skips it. Every replacement is recorded, before-state first, in
// ~/marathon-rollbacks/shopify-photo-sync-{date}.json (rewritten after every
// product, so an interrupted run keeps its ledger); undo with
// rollback-primary-photo-sync.mjs. No photo object is ever deleted or
// overwritten: the old app photo stays where it is.
import { writeFileSync } from "node:fs";
import { runSync, buildOwnersByMd5 } from "./primaryPhotoSync.mjs";
import { initAdmin, shallowKeys, serverClock, md5Reader, listProductObjects, readers, thumbRebuilder,
         thumbRemover, productWriter, openLedger, ledgerPath } from "./primaryPhotoNode.mjs";

const argv = process.argv.slice(2);
const COMMIT = argv.includes("--commit");
const arg = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const LIMIT = Number(arg("limit")) || Infinity;
const CONCURRENCY = Number(arg("concurrency")) || 8;
const REPORT = arg("report") || null; // every product's verdict as JSON lines
const ONLY = arg("pid") || null;
const SHARED_STOP = 10;

const { app, db, bucket } = initAdmin();
const t0 = Date.now();
console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — Shopify primary photo → app photo`);
let pids = ONLY ? [ONLY] : await shallowKeys(app, "shopify_publish");
if (pids.length > LIMIT) pids = pids.slice(0, LIMIT);
console.log(`/shopify_publish keys: ${pids.length}`);
console.log("Listing products/ in Storage (names + md5 only) …");
const ownersByMd5 = buildOwnersByMd5(await listProductObjects(bucket));
console.log(`  ${ownersByMd5.size} distinct photo contents`);

const date = new Date().toISOString().slice(0, 10);
const ledger = COMMIT ? openLedger(ledgerPath(date)) : null;
const write = COMMIT ? {
  now: await serverClock(db),
  rebuildThumb: thumbRebuilder(bucket),
  removeThumb: thumbRemover(bucket),
  writeProduct: productWriter(db),
} : null;

const shown = new Set(["replace", "shared", "error", "no-product", "primary-missing"]);
const { counts, rows } = await runSync(pids, { ...readers(db), md5Of: md5Reader(bucket), ownersByMd5 }, {
  write, concurrency: CONCURRENCY, gapMs: 50,
  onReplaced: ledger ? ledger.add : undefined,
  log: (r) => {
    if (!shown.has(r.verdict) && !ONLY) return;
    const res = r.result ? (r.result.ok ? (r.result.changed ? ` → REPLACED${r.result.thumb ? "" : " (thumbnail NOT rebuilt)"}` : ` → unchanged (${r.result.reason})`) : ` → FAILED: ${r.result.message}`) : "";
    const extra = r.verdict === "shared" ? ` — also ${r.others.join(", ")}` : r.message ? ` — ${r.message}` : "";
    console.log(`  ${r.pid}: ${r.verdict}${extra}${res}`);
  },
});

if (REPORT) writeFileSync(REPORT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log("\n── summary ──");
console.log(`mode:                ${COMMIT ? "COMMIT" : "DRY RUN (nothing written)"}`);
console.log(`total nodes:         ${counts.total}`);
console.log(`already matching:    ${counts.matching}`);
console.log(`will replace:        ${counts.replace}`);
console.log(`no Shopify primary:  ${counts["no-shopify-primary"]}`);
console.log(`product gone:        ${counts["no-product"]}`);
console.log(`primary file gone:   ${counts["primary-missing"]}`);
console.log(`shared (skipped):    ${counts.shared}`);
if (COMMIT) {
  console.log(`replaced:            ${counts.replaced}`);
  console.log(`unchanged at write:  ${counts.unchanged}`);
  console.log(`thumbnail not built: ${rows.filter((r) => r.result?.changed && !r.result.thumb).length}`);
  console.log(`rollback ledger:     ${ledgerPath(date)} (${ledger.doc.entries.length} entries)`);
}
console.log(`failed:              ${counts.failed}`);
if (counts.shared > SHARED_STOP) console.log(`\n⚠ ${counts.shared} products share their primary photo with another product (> ${SHARED_STOP}) — all skipped, listed above.`);
console.log(`wall time:           ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await app.delete();
process.exit(counts.failed ? 1 : 0);
