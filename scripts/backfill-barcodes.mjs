// scripts/backfill-barcodes.mjs
//
// One-time backfill: mints a per-size barcode for EVERY existing product × size
// that doesn't already have one — so the catalog is universal and the "N size(s)
// have no barcode yet" message can never appear for an existing product. Covers:
//   • every size listed in product.sizes (half-sizes included — keyed via the
//     canonical barcodeSizeKey/encodeSizeKey, e.g. "5.5" → "5_5")
//   • one-size / sizeless products (sizes empty/missing) → the "_" slot
//
// For each gap it writes the SAME two locations ensureBarcode() writes from the
// app, so the model stays identical:
//   /products/{id}/barcodes/{sizeKey}  — the permanent code for that product+size
//   /barcodes/{code} -> {productId,size?,at} — reverse index for POS scan-to-sell
// …and advances the ONE shared counter /products_meta.lastBarcode.
//
// AUTH: the marathon-club RTDB rules (#57) require a NON-anonymous user, and
// /barcodes additionally requires a stockRole — anonymous auth (the older
// backfill scripts) can no longer write these. So this script authenticates with
// the project owner's Application Default Credentials OAuth token, which the RTDB
// REST API treats as admin and which bypasses the security rules. Get one with:
//   gcloud auth application-default print-access-token
// and pass it in the FB_TOKEN env var (see Usage).
//
// COLLISION SAFETY: we RESERVE the whole block first (advance lastBarcode to the
// final value before writing any slot). If a slot batch then fails, the counter is
// already past the reserved numbers, so a re-run derives fresh numbers from the new
// high-water mark — at worst a few burned numbers (gaps are explicitly fine in this
// codebase), never a duplicate code. Re-running is otherwise idempotent: slots that
// already hold a valid code are skipped.
//
// Project: HARDCODED to marathon-club via DB_URL below. Cannot target any other.
//
// Usage:
//   FB_TOKEN=$(gcloud auth application-default print-access-token) \
//     node scripts/backfill-barcodes.mjs            # DRY RUN — prints plan, writes nothing
//   FB_TOKEN=$(gcloud auth application-default print-access-token) \
//     node scripts/backfill-barcodes.mjs --commit   # actually writes
//
// Exit codes: 0 success / 1 any error.

// ─── Pure helpers — MIRRORED from src/components/stock/barcode.js +
//     src/utils/sizeKey.js (kept inline because barcode.js's internal import is
//     extensionless and only resolves under Vite, not raw node). KEEP IN SYNC. ──
const BARCODE_DIGITS = 8;
const ILLEGAL_RTDB_CHARS = /[.#$[\]/\s]/g;
const formatBarcode  = (n) => String(n).padStart(BARCODE_DIGITS, "0");
const isValidBarcode = (v) => typeof v === "string" && /^\d{8}$/.test(v);
function encodeSizeKey(size) {
  if (typeof size === "number") size = String(size);
  if (typeof size !== "string") return size;
  return size.replace(ILLEGAL_RTDB_CHARS, "_");
}
const barcodeSizeKey = (size) => (size == null || size === "" ? "_" : encodeSizeKey(size));
function barcodeIndexRecord(productId, size, at) {
  const rec = { productId, at };
  if (size != null && size !== "") rec.size = size; // RAW size; omitted for unsized
  return rec;
}

const DB_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const TOKEN  = process.env.FB_TOKEN;
const COMMIT = process.argv.includes("--commit");
const BATCH  = 1000; // multi-path entries per PATCH

if (!TOKEN) {
  console.error("[backfill] missing FB_TOKEN. Run:\n  FB_TOKEN=$(gcloud auth application-default print-access-token) node scripts/backfill-barcodes.mjs [--commit]");
  process.exit(1);
}

const now = new Date().toISOString();

async function rGet(path) {
  const res = await fetch(`${DB_URL}/${path}.json?access_token=${TOKEN}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}
// Multi-path PATCH at root: keys are deep "a/b/c" paths, applied atomically.
async function rPatch(updates) {
  const res = await fetch(`${DB_URL}/.json?access_token=${TOKEN}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`PATCH → ${res.status} ${await res.text()}`);
}

console.log(`[backfill] project: marathon-club`);
console.log(`[backfill] mode:    ${COMMIT ? "COMMIT (will write)" : "DRY RUN (no writes)"}`);

// ─── Read catalog + counter ──────────────────────────────────────────────────
const all  = (await rGet("products")) || {};
const meta = (await rGet("products_meta")) || {};
const products = Object.values(all).filter(v => v && typeof v === "object" && v.id && v.name);
const startLast = typeof meta.lastBarcode === "number" ? meta.lastBarcode : 0;
console.log(`[backfill] /products real entries: ${products.length}`);
console.log(`[backfill] /products_meta.lastBarcode: ${startLast}`);

// ─── Compute gaps ────────────────────────────────────────────────────────────
// One assignment = one (product,size) slot that has no valid code yet.
let next = startLast;
const assignments = []; // { id, name, size, sizeKey, code }
let sizedGaps = 0, oneSizeGaps = 0;

for (const p of products) {
  const sizes = (Array.isArray(p.sizes) && p.sizes.length) ? p.sizes : [null]; // null = one-size "_"
  const existing = (p.barcodes && typeof p.barcodes === "object") ? p.barcodes : {};
  for (const size of sizes) {
    const sizeKey = barcodeSizeKey(size); // half-sizes via encodeSizeKey; "_" for one-size
    if (isValidBarcode(existing[sizeKey])) continue; // already has a code — reuse, never overwrite
    next += 1;
    assignments.push({ id: p.id, name: p.name, size, sizeKey, code: formatBarcode(next) });
    if (size == null) oneSizeGaps++; else sizedGaps++;
  }
}

console.log(`[backfill] gaps to mint: ${assignments.length} (sized=${sizedGaps}, one-size=${oneSizeGaps})`);
if (assignments.length) {
  console.log(`[backfill] plan preview (first 8):`);
  for (const a of assignments.slice(0, 8)) {
    console.log(`  ${a.code}  ${a.id.padEnd(18)} size=${a.size ?? "(one-size)"} key=${a.sizeKey} "${a.name}"`);
  }
  if (assignments.length > 8) console.log(`  … and ${assignments.length - 8} more`);
  console.log(`[backfill] lastBarcode ${startLast} → ${next}`);
}

if (assignments.length === 0) { console.log(`[backfill] nothing to mint — exiting.`); process.exit(0); }
if (!COMMIT) { console.log(`[backfill] DRY RUN complete — pass --commit to write.`); process.exit(0); }

// ─── Commit ──────────────────────────────────────────────────────────────────
try {
  // 1. RESERVE the whole block first (collision-safe on re-run — see header).
  await rPatch({ "products_meta/lastBarcode": next });
  console.log(`[backfill] reserved block: lastBarcode → ${next}`);

  // 2. Write slot + reverse-index for each assignment, in batches.
  const updates = [];
  for (const a of assignments) {
    updates.push([`products/${a.id}/barcodes/${a.sizeKey}`, a.code]);
    updates.push([`barcodes/${a.code}`, barcodeIndexRecord(a.id, a.size, now)]);
  }
  let written = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const slice = updates.slice(i, i + BATCH);
    await rPatch(Object.fromEntries(slice));
    written += slice.length;
    console.log(`[backfill] wrote ${written}/${updates.length} paths …`);
  }
  console.log(`[backfill] done. minted=${assignments.length} barcodes (sized=${sizedGaps}, one-size=${oneSizeGaps}).`);
  process.exit(0);
} catch (err) {
  console.error(`[backfill] FAILED: ${err.message}`);
  console.error(`[backfill] counter already advanced — a re-run will derive fresh numbers (no duplicates).`);
  process.exit(1);
}
