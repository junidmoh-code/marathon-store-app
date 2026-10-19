#!/usr/bin/env node
// ─── REPAIR: card thumbnails that do not show the product's current photo ────
//   node scripts/thumbs/repair-card-thumbs.mjs            # dry run (default)
//   node scripts/thumbs/repair-card-thumbs.mjs --commit   # rebuild + stamp thumbAt
//   … --pid=p123  --limit=N
//
// Walks /products KEYS shallowly; per product reads only photoUrl. One listing
// of products/ in Storage gives every thumbnail's metadata. Missing, or of
// unproven origin for a photo that is not photo.jpg → rebuilt from photoUrl
// (thumbSource=repair) and thumbAt stamped so devices re-fetch. (The 24×24
// pixel diff is printed for the record only; it never decides.)
// Idempotent: a rebuilt thumbnail records its source, so a rerun says "ok".
// Every repair is listed in ~/marathon-rollbacks/card-thumb-repair-{date}.json.
// Thumbnails are derived files: no photo is touched, moved or deleted.
import { createRequire } from "module";
import { join } from "node:path";
import { runRepair, signatureDiff } from "./cardThumbRepair.mjs";
import { eachLimited } from "../shopify/primaryPhotoSync.mjs";
import { initAdmin, shallowKeys, serverClock, thumbRebuilder, openLedger, ROLLBACK_DIR, BUCKET } from "../shopify/primaryPhotoNode.mjs";

const sharp = createRequire(import.meta.url)("sharp");
const argv = process.argv.slice(2);
const COMMIT = argv.includes("--commit");
const arg = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const LIMIT = Number(arg("limit")) || Infinity;
const ONLY = arg("pid") || null;

const { app, db, bucket } = initAdmin();
console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — card thumbnails ← current photo`);
let pids = ONLY ? [ONLY] : await shallowKeys(app, "products");
if (pids.length > LIMIT) pids = pids.slice(0, LIMIT);

const thumbs = new Map();
for (let q = { prefix: "products/", maxResults: 1000, autoPaginate: false }; q;) {
  const [files, next] = await bucket.getFiles(q);
  for (const f of files) if (/^products\/[^/]+\/thumb_300\.webp$/.test(f.name)) thumbs.set(f.name.split("/")[1], f.metadata);
  q = next;
}
console.log(`products: ${pids.length} · thumbnails in the bucket: ${thumbs.size}`);

const sig = async (buf) => sharp(buf).rotate().resize(24, 24, { fit: "fill" }).greyscale().raw().toBuffer();
const io = {
  readPhotoUrl: (pid) => db.ref(`products/${pid}/photoUrl`).once("value").then((s) => s.val()),
  thumbMetaOf: (pid) => thumbs.get(pid) || null,
  inBucket: (u) => typeof u === "string" && u.includes(`/v0/b/${BUCKET}/o/`),
  looksLike: async (pid, path) => {
    const [[t], [p]] = await Promise.all([bucket.file(`products/${pid}/thumb_300.webp`).download(), bucket.file(path).download()]);
    return signatureDiff(await sig(t), await sig(p));
  },
};
const date = new Date().toISOString().slice(0, 10);
const ledger = COMMIT ? openLedger(join(ROLLBACK_DIR, `card-thumb-repair-${date}.json`), "card-thumb-repair") : null;
const now = COMMIT ? await serverClock(db) : null;
const write = COMMIT ? {
  rebuildThumb: thumbRebuilder(bucket, "repair"),
  stamp: (pid) => db.ref(`products/${pid}`).update({ thumbAt: Math.round(now()) }),
} : null;

const { counts } = await runRepair(pids, io, {
  write, onRepaired: ledger ? ledger.add : undefined,
  each: (items, fn) => eachLimited(items, 8, fn, { gapMs: 25 }),
  log: (r) => {
    if (!["missing", "unproven", "error"].includes(r.verdict) && !ONLY) return;
    console.log(`  ${r.pid}: ${r.verdict}${r.diff != null ? ` (pixel diff ${r.diff.toFixed(1)})` : ""}${r.result ? ` → ${r.result}` : ""}${r.message ? ` — ${r.message}` : ""}`);
  },
});

console.log("\n── summary ──");
for (const [k, v] of Object.entries(counts)) console.log(`${k.padEnd(14)} ${v}`);
if (ledger) console.log(`ledger: ${join(ROLLBACK_DIR, `card-thumb-repair-${date}.json`)} (${ledger.doc.entries.length})`);
await app.delete();
process.exit(counts.failed ? 1 : 0);
