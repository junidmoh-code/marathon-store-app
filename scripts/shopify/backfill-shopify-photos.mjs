#!/usr/bin/env node
// ─── BACKFILL: the Shopify photo becomes the app's primary where they differ ──
//
//   node scripts/shopify/backfill-shopify-photos.mjs                 dry run: every verdict, nothing written
//   node scripts/shopify/backfill-shopify-photos.mjs --json <file>   … and the rows as JSON
//   node scripts/shopify/backfill-shopify-photos.mjs --sheet <dir>   … and before/after JPEGs of the replacements
//   node scripts/shopify/backfill-shopify-photos.mjs --commit --batch 100   one batch, then its check
//
// Decisions: shopifyPhotoBackfill.mjs. The write: src/utils/setPrimaryPhoto.js
// (old photo → photo history, thumbnail before photoUrl, child keys only).
//
// READS: one Shopify bulk query (read-only); /shopify_sync/_claims; per
// product its map gid, /products/{pid} photo fields + name/brand/merged,
// /shopify_publish/{pid}/cleanName — point reads, never a whole node.
// WRITES (--commit): products/{pid}/shopify_backfill/{at}.<ext> in OUR bucket
// (a copy — the Shopify CDN is never referenced by the app), the till
// thumbnail, and /products/{pid} child keys. Ledger:
// ~/marathon-rollbacks/shopify-photo-backfill-2026-10-25.json — every entry
// holds the old URL, so each swap can be undone (and Undo photo in the app
// does the same from the photo history).
//
// STOPS (exit 3) when the check after a batch finds a product whose new photo
// is not Shopify's picture, whose old photo is not in its history, or whose
// Shopify link moved.
import { createRequire } from "module";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { graphql } from "./client.mjs";
import { runBulkQuery } from "./bulkSnapshot.mjs";
import { numericIdOf } from "./relist.mjs";
import { thumbRebuilder, thumbRemover, productWriter, serverClock, BUCKET, DB_URL } from "./primaryPhotoNode.mjs";
import {
  BACKFILL_BULK_QUERY, parseBackfillSnapshot, dhashFromGrey, shopifySized, linkVerdict, pictureVerdict,
  sharedPictureConflicts, copyPathFor, batchCheck,
} from "./shopifyPhotoBackfill.mjs";
import { primaryPhotoUrl, storagePathOfUrl, PHOTO_HISTORY_KEY } from "../../src/utils/primaryPhoto.js";
import { setPrimaryPhoto } from "../../src/utils/setPrimaryPhoto.js";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const sharp = require("sharp");
admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DB_URL, storageBucket: BUCKET });
const db = admin.database();
const bucket = admin.storage().bucket();

const flags = process.argv.slice(2);
const arg = (k) => (flags.includes(k) ? flags[flags.indexOf(k) + 1] : null);
const COMMIT = flags.includes("--commit");
const BATCH = Number(arg("--batch") || 100);
const JSON_OUT = arg("--json");
const SHEET = arg("--sheet");
const LEDGER = join(homedir(), "marathon-rollbacks", "shopify-photo-backfill-2026-10-25.json");
const BY = "script:backfill-shopify-photos";
if (COMMIT && !(BATCH >= 1 && BATCH <= 100)) { console.error("--batch must be 1..100"); process.exit(2); }

let bytes = 0;
const get = async (p) => { const v = (await db.ref(p).get()).val(); bytes += Buffer.byteLength(JSON.stringify(v ?? null)); return v; };
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i]); }
  }));
}
const loadLedger = () => (existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : { kind: "shopify-photo-backfill", entries: {} });
const saveLedger = (l) => { mkdirSync(join(homedir(), "marathon-rollbacks"), { recursive: true }); writeFileSync(LEDGER, JSON.stringify(l, null, 1)); };

// ── pictures ────────────────────────────────────────────────────────────────
async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type") || "" };
}
async function ourBuf(url) {
  const path = storagePathOfUrl(url);
  if (path && url.includes(`/b/${BUCKET}/o/`)) return (await bucket.file(path).download())[0];
  return (await fetchBuf(url)).buf;   // a legacy photo stored elsewhere (http)
}
const dhash = async (buf) => dhashFromGrey(await sharp(buf).rotate().flatten({ background: "#fff" }).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer());

// ── read the shop and the links ───────────────────────────────────────────────
const shop = parseBackfillSnapshot(await runBulkQuery(graphql, BACKFILL_BULK_QUERY, { log: (s) => console.error(s) }));
const claims = (await get("shopify_sync/_claims")) || {};
const linked = [...shop.values()].map((s) => ({ s, pid: claims[numericIdOf(s.id)] })).filter((x) => typeof x.pid === "string");
console.log(`Shopify: ${shop.size} product(s); linked to an app product by id: ${linked.length}`);

const rows = [];
await pool(linked, 12, async ({ s, pid }) => {
  const [mappedGid, photoUrl, photo, mergedInto, name, brand, cleanName] = await Promise.all([
    get(`shopify_sync/${pid}/shopifyProductId`), get(`products/${pid}/photoUrl`), get(`products/${pid}/photo`),
    get(`products/${pid}/mergedInto`), get(`products/${pid}/name`), get(`products/${pid}/brand`), get(`shopify_publish/${pid}/cleanName`),
  ]);
  const product = name == null && photoUrl == null ? null : { id: pid, photoUrl, photo, mergedInto, name, brand };
  const row = { pid, gid: s.id, title: s.title, shopUrl: s.image?.url ?? null, oldUrl: primaryPhotoUrl(product) };
  const link = linkVerdict({ pid, gid: s.id, mappedGid, product, node: { cleanName }, shop: s });
  if (!link.go) { rows.push({ ...row, action: "skip", code: link.code, why: link.why }); return; }
  try {
    row.shopHash = await dhash((await fetchBuf(shopifySized(s.image.url, 256))).buf);
    row.appHash = row.oldUrl ? await dhash(await ourBuf(row.oldUrl)) : null;
  } catch (e) {
    rows.push({ ...row, action: "skip", code: "unreadable", why: String(e?.message || e) }); return;
  }
  rows.push({ ...row, ...pictureVerdict(row.shopHash, row.appHash) });
});

const twins = sharedPictureConflicts(rows.filter((r) => r.action === "replace"));
for (const r of rows) if (twins.has(r.pid) && r.action === "replace") Object.assign(r, { action: "skip", code: "shared-picture", why: "the same Shopify picture would go to more than one app product" });

const count = (a, c) => rows.filter((r) => r.action === a && (!c || r.code === c)).length;
const byCode = {};
for (const r of rows) (byCode[`${r.action}:${r.code}`] ||= []).push(r);
console.log(`\nverdicts (${rows.length}):`);
for (const [k, rs] of Object.entries(byCode).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${k.padEnd(28)} ${String(rs.length).padStart(5)}${rs[0].why ? `  e.g. ${rs[0].pid}: ${rs[0].why}` : ""}`);
}
const todoAll = rows.filter((r) => r.action === "replace").sort((a, b) => a.pid.localeCompare(b.pid));
console.log(`\nTO REPLACE: ${todoAll.length} (differs ${count("replace", "differs")}, app had none ${count("replace", "app-has-none")}) · same already ${count("same")} · skipped ${count("skip")}`);
console.log(`rtdb read: ${bytes.toLocaleString()} B`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(rows, null, 1));

if (SHEET) {
  // Before/after pairs at 400px, for a person to look at (never uploaded anywhere).
  mkdirSync(SHEET, { recursive: true });
  for (const r of todoAll.slice(0, Number(arg("--sheet-n") || 24))) {
    try {
      const a = r.oldUrl ? await sharp(await ourBuf(r.oldUrl)).rotate().resize(400, 400, { fit: "contain", background: "#fff" }).jpeg({ quality: 80 }).toBuffer() : null;
      const b = await sharp((await fetchBuf(shopifySized(r.shopUrl, 800))).buf).rotate().resize(400, 400, { fit: "contain", background: "#fff" }).jpeg({ quality: 80 }).toBuffer();
      if (a) writeFileSync(join(SHEET, `${r.pid}-before.jpg`), a);
      writeFileSync(join(SHEET, `${r.pid}-after.jpg`), b);
    } catch (e) { console.error(`  sheet ${r.pid}: ${e?.message || e}`); }
  }
  console.log(`sheet: ${SHEET}`);
}
if (!COMMIT) { console.log("\ndry run — nothing written."); process.exit(0); }

// ── one batch ─────────────────────────────────────────────────────────────────
const ledger = loadLedger();
const todo = todoAll.filter((r) => !ledger.entries[r.pid]).slice(0, BATCH);
const now = await serverClock(db);
const deps = {
  now,
  readProduct: async (pid) => {
    const [photoUrl, photo, photoHistory] = await Promise.all(["photoUrl", "photo", PHOTO_HISTORY_KEY].map((k) => get(`products/${pid}/${k}`)));
    return { photoUrl, photo, photoHistory };
  },
  rebuildThumb: thumbRebuilder(bucket, "shopify_backfill"),
  removeThumb: thumbRemover(bucket),
  writeProduct: productWriter(db),
};
let done = 0;
for (const r of todo) {
  // The photo may have changed since the census: only the one we judged is replaced.
  const current = primaryPhotoUrl({ photoUrl: await get(`products/${r.pid}/photoUrl`), photo: await get(`products/${r.pid}/photo`) });
  if (current !== r.oldUrl) { console.log(`  ${r.pid}: photo changed since the census — left alone`); continue; }
  let newUrl = null;
  const res = await setPrimaryPhoto(r.pid, {
    product: { id: r.pid, photoUrl: r.oldUrl }, source: "shopify_backfill", by: BY,
    produce: async () => {
      const { buf, type } = await fetchBuf(r.shopUrl);
      const ext = /png/.test(type) ? "png" : /webp/.test(type) ? "webp" : "jpg";
      const path = copyPathFor(r.pid, now(), ext);
      const token = randomUUID();
      await bucket.file(path).save(buf, { resumable: false, contentType: type || "image/jpeg",
        metadata: { cacheControl: "public, max-age=31536000, immutable", metadata: { firebaseStorageDownloadTokens: token, copiedFrom: r.shopUrl, shopifyProduct: r.gid } } });
      newUrl = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
      return newUrl;
    },
  }, deps);
  if (!res.ok || !res.changed) { console.log(`  ${r.pid}: ${res.message || res.reason}`); continue; }
  const at = res.patch.photoSource.at;
  ledger.entries[r.pid] = { pid: r.pid, gid: r.gid, oldUrl: r.oldUrl, newUrl, at, shopUrl: r.shopUrl, shopHash: r.shopHash };
  saveLedger(ledger);
  done++;
}
console.log(`\nbatch: ${done} replaced (of ${todo.length} taken). Checking…`);

// ── the check after the batch ─────────────────────────────────────────────────
const problems = [];
await pool(todo.filter((r) => ledger.entries[r.pid]?.at && !ledger.entries[r.pid].checkedAt), 8, async (r) => {
  const e = ledger.entries[r.pid];
  const [photoUrl, hist, mappedGid] = await Promise.all([get(`products/${r.pid}/photoUrl`), get(`products/${r.pid}/${PHOTO_HISTORY_KEY}/${e.at}`), get(`shopify_sync/${r.pid}/shopifyProductId`)]);
  let copyHash = null;
  try { copyHash = await dhash(await ourBuf(e.newUrl)); } catch { /* → mismatch below */ }
  const claimPid = (await get(`shopify_sync/_claims/${numericIdOf(e.gid)}`));
  const bad = batchCheck({ entry: e, now: { photoUrl, history: hist, copyHash, mappedGid, claimPid } });
  if (bad.length) problems.push({ pid: r.pid, bad }); else e.checkedAt = now();
});
saveLedger(ledger);
const left = todoAll.filter((r) => !ledger.entries[r.pid]).length;
if (problems.length) {
  console.error(`\n🛑 STOP — ${problems.length} product(s) failed the check:`);
  for (const p of problems) console.error(`  ${p.pid}: ${p.bad.join("; ")}`);
  process.exit(3);
}
console.log(`check: all ${done} correct — new photo is Shopify's picture, old one in history, link unchanged. ${left} still to go. Ledger: ${LEDGER}`);
process.exit(0);
