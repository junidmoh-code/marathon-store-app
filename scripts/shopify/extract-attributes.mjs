// ── ATTRIBUTE EXTRACTION, in batches ─────────────────────────────────────────
// Reads a sneaker's PHOTO and writes the closed attribute schema
// (src/utils/productAttributes.js) to /product_attributes/{pid}. The SAME
// pipeline as the vision namer — same model pin, same transport
// (visionCall.mjs), same cost accounting, same confirm-the-batch friction —
// asking for structure instead of prose.
//
//   node scripts/shopify/extract-attributes.mjs                    quote only, nothing spent
//   node scripts/shopify/extract-attributes.mjs --pids p1,p2       scope: named products
//   node scripts/shopify/extract-attributes.mjs --limit 200        cap the scope
//   node scripts/shopify/extract-attributes.mjs --sample 200       a SPREAD sample across brands
//   node scripts/shopify/extract-attributes.mjs --refresh          re-extract products already current
//   node scripts/shopify/extract-attributes.mjs --confirm-batch N  SPEND. Must equal the scope size.
//
// ── NOTHING IS SPENT WITHOUT --confirm-batch, AND IT MUST MATCH ───────────────
// Same deliberate friction as the namer: the default run resolves the scope,
// prints the projected cost, and stops. "I thought it was only doing the boots"
// is the mistake worth making impossible.
//
// ── RESUMABLE, AND FREE TO RESUME ────────────────────────────────────────────
// A product already carrying the current EXTRACTOR_VERSION is out of scope, so
// a crashed run restarts and re-bills NOTHING. --refresh overrides that; a
// version bump does it automatically for the whole catalogue.
//
// ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────────
//   • It never writes /products. Not the name, not anything.
//   • It never writes `confirmed` — buildAttributeRecord structurally cannot
//     produce that child, so a re-run cannot clobber a human correction.
//   • It never coerces a value into the vocabulary. An illegal value is dropped
//     and counted; a product missing a required field is left UNENRICHED and is
//     simply absent from suggestions. There is no manual lane by design.
//   • It never re-tries after a response arrives — a completed generation has
//     been charged. The ONE retry is for a REFUSED answer, and it is the same
//     one-regeneration-then-refuse rule the namer uses.
//
// WRITES: /product_attributes/{pid} only.
import { createRequire } from "module";
import "./env.mjs"; // side effect: tops up process.env from the git-ignored .env
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { isPriceRecord } from "../../src/utils/productCategory.js";
import { visionModel } from "../../src/utils/visionNaming.js";
import {
  ATTRIBUTE_PROMPT, parseAttributeResponse, attributeRetryNote,
  projectExtractionCost,
} from "../../src/utils/attributeExtraction.js";
import {
  ATTRIBUTES_PATH, EXTRACTOR_VERSION, buildAttributeRecord, isCurrentExtraction,
  usableAttributes, VISION_FIELDS,
} from "../../src/utils/productAttributes.js";
import { USD_TO_ZAR } from "../../src/utils/visionNaming.js";
import { readMapPaged } from "../lib/rtdbPaged.mjs";
import { callVision } from "./visionCall.mjs";
import { isSneakerProduct, SNEAKER_SCOPE_NOTE } from "../lib/sneakerScope.mjs";

const MODEL = visionModel(process.env);

const flags = process.argv.slice(2);
const arg = (name) => {
  const i = flags.indexOf(name);
  if (i === -1) return null;
  const v = flags[i + 1];
  if (!v || v.startsWith("--")) { console.error(`${name} needs a value`); process.exit(2); }
  return v;
};
const PIDS = arg("--pids");
const LIMIT = arg("--limit") ? Number(arg("--limit")) : null;
const SAMPLE = arg("--sample") ? Number(arg("--sample")) : null;
const CONFIRM = arg("--confirm-batch") ? Number(arg("--confirm-batch")) : null;
const REFRESH = flags.includes("--refresh");
if (LIMIT !== null && !(LIMIT > 0)) { console.error("--limit needs a positive number"); process.exit(2); }
if (SAMPLE !== null && !(SAMPLE > 0)) { console.error("--sample needs a positive number"); process.exit(2); }

// ── THE KEY. Absent ⇒ DISABLED, with a plain message. No stub, no fallback. ──
const API_KEY = process.env.GEMINI_API_KEY || "";
const QUOTE_ONLY = CONFIRM === null;
if (!API_KEY && !QUOTE_ONLY) {
  console.error(
    "GEMINI_API_KEY is not set — attribute extraction is DISABLED.\n" +
    "Set it in the environment or in the git-ignored .env at the repo root, then re-run.\n" +
    "There is no fallback: without the key there is no vision pass, and nothing is written."
  );
  process.exit(2);
}

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// ── Resolve the scope ────────────────────────────────────────────────────────
// PAGED, never one whole-node read — /products is 3.92 MB and a single get() of
// it is exactly the read that spikes the bandwidth bill.
const products = await readMapPaged(db, "products", { pageSize: 500 });
const existing = await readMapPaged(db, ATTRIBUTES_PATH, { pageSize: 500 });
const onlyPids = PIDS ? new Set(PIDS.split(",").map((s) => s.trim()).filter(Boolean)) : null;
if (onlyPids && onlyPids.size === 0) { console.error("--pids parsed to an empty list"); process.exit(2); }

const skipped = { notSneaker: 0, priceRecord: 0, noPhoto: 0, merged: 0, alreadyCurrent: 0 };
const scope = [];
for (const [pid, p] of Object.entries(products)) {
  if (!p || typeof p !== "object" || !p.id) continue;
  if (p.mergedInto) { skipped.merged += 1; continue; }
  if (onlyPids && !onlyPids.has(pid)) continue;
  if (!isSneakerProduct(p)) { skipped.notSneaker += 1; continue; }
  if (isPriceRecord(p)) { skipped.priceRecord += 1; continue; }
  // One image per call, so a product with no photo has nothing to read. It stays
  // unenriched — never hand-tagged, never guessed from its name.
  const photo = String(p.photoUrl || "").trim();
  if (!photo) { skipped.noPhoto += 1; continue; }
  if (!REFRESH && isCurrentExtraction(existing[pid])) { skipped.alreadyCurrent += 1; continue; }
  scope.push({ pid, product: p, photo });
}
scope.sort((a, b) => a.pid.localeCompare(b.pid));

// ── --sample: a SPREAD, not the first N ──────────────────────────────────────
// The pid is a creation timestamp, so the first 200 by pid are 200 products
// loaded in the same week — usually the same delivery, often the same brand. A
// pilot run on that tells you nothing about the catalogue. Round-robin across
// brands so the sample spans them, deterministic so it is repeatable.
let work = scope;
if (SAMPLE) {
  const byBrand = new Map();
  for (const row of scope) {
    const b = String(row.product.brand || "(none)");
    if (!byBrand.has(b)) byBrand.set(b, []);
    byBrand.get(b).push(row);
  }
  const lanes = [...byBrand.entries()].sort((a, b) => b[1].length - a[1].length).map(([, v]) => v);
  const picked = [];
  for (let i = 0; picked.length < Math.min(SAMPLE, scope.length); i++) {
    let moved = false;
    for (const lane of lanes) {
      if (i >= lane.length) continue;
      picked.push(lane[i]); moved = true;
      if (picked.length >= SAMPLE) break;
    }
    if (!moved) break;
  }
  work = picked.sort((a, b) => a.pid.localeCompare(b.pid));
} else if (LIMIT) {
  work = scope.slice(0, LIMIT);
}

const quote = projectExtractionCost(work.length);
console.log(SNEAKER_SCOPE_NOTE);
console.log(`\nscope: ${work.length} product(s)${work.length < scope.length ? ` (of ${scope.length} eligible)` : ""}`);
console.log(`  skipped — not a sneaker: ${skipped.notSneaker} · price record: ${skipped.priceRecord} · ` +
            `no photo: ${skipped.noPhoto} · merged: ${skipped.merged} · already at v${EXTRACTOR_VERSION}: ${skipped.alreadyCurrent}`);
console.log(`\nPROJECTED COST: $${quote.usd} (~R${quote.zar}) at $${quote.perProductUsd}/product, one image per call`);
console.log(`FOR REFERENCE, every eligible sneaker (${scope.length + skipped.alreadyCurrent}): ` +
            `$${projectExtractionCost(scope.length + skipped.alreadyCurrent).usd}`);

if (QUOTE_ONLY) {
  console.log(`\nQUOTE ONLY — nothing sent, nothing written, nothing spent.`);
  console.log(`To run it: re-run with --confirm-batch ${work.length}`);
  if (!API_KEY) console.log(`NOTE: GEMINI_API_KEY is not set, so the run itself would be DISABLED.`);
  process.exit(0);
}
if (CONFIRM !== work.length) {
  console.error(`\nREFUSED: --confirm-batch ${CONFIRM} does not match the ${work.length} product(s) in scope.`);
  console.error(`Re-run with --confirm-batch ${work.length} if that is really what you want.`);
  process.exit(2);
}
if (!work.length) { console.log("nothing in scope."); process.exit(0); }

// ── The run ──────────────────────────────────────────────────────────────────
const results = [];
let spent = 0;
let measuredUsd = 0;
const droppedTally = {};
const startedAt = Date.now();

for (const [i, { pid, product, photo }] of work.entries()) {
  try {
    // INSIDE the try: thrown out here it is an unhandled rejection at module
    // top level, the process dies, and the report below never prints — losing
    // the record of every call already PAID FOR in this chunk.
    assertSafeSegment(pid, "productId");

    const call = (extra) => callVision(photo, ATTRIBUTE_PROMPT, {
      apiKey: API_KEY, model: MODEL, extra,
      // Temperature 0.1, not the namer's 0.4: prose wants variety, a
      // classification wants the same answer twice for the same photo. The
      // namer's own rotation existed to fight convergence; here convergence on
      // the truth is the goal.
      temperature: 0.1,
      onCost: (usd) => { measuredUsd += usd; },
    });

    let parsed = parseAttributeResponse(await call([]));
    spent += 1;
    let attempts = 1;

    // ── ONE regeneration, NAMING what was wrong. Then refuse. ──
    if (!parsed.ok) {
      const first = parsed.error;
      parsed = parseAttributeResponse(await call([attributeRetryNote(parsed)]));
      spent += 1;
      attempts = 2;
      if (!parsed.ok) {
        results.push({ pid, status: "unusable", detail: `${parsed.error} (first attempt: ${first})` });
        continue;
      }
    }
    for (const d of parsed.dropped) droppedTally[d] = (droppedTally[d] || 0) + 1;

    const prev = existing[pid];
    const record = buildAttributeRecord({
      vision: parsed.vision, product, model: MODEL,
      // A SERVER instant, not this machine's clock — the same rule the app
      // follows for every timestamp it writes (serverNowMs). A script has no
      // /.info/serverTimeOffset, so it uses the server's own value directly.
      at: admin.database.ServerValue.TIMESTAMP,
      previousVersion: prev?.v ?? null,
    });

    // The MACHINE half only. `confirmed` is untouched by construction and by
    // update(): a child not named in the patch is not written.
    await db.ref(`${ATTRIBUTES_PATH}/${pid}`).update(record);

    // usableAttributes over what was just written — reported so a run that
    // produces records nothing can rank is visible immediately rather than at
    // neighbour-building time. `at` is a server sentinel until it lands, so the
    // check runs against the record's own attribute half.
    const usable = usableAttributes({ a: record.a, confirmed: prev?.confirmed });
    results.push({
      pid, status: usable ? "extracted" : "incomplete", attempts,
      detail: VISION_FIELDS.map((k) => `${k}=${record.a[k] ?? "-"}`).join(" ") +
        (parsed.dropped.length ? ` · dropped: ${parsed.dropped.join(",")}` : ""),
    });
  } catch (e) {
    results.push({ pid, status: "failed", detail: String(e?.message || e) });
  }

  // ── Rate limiting, and a progress line ─────────────────────────────────────
  // Serial by construction (one call at a time), plus a small pause so a long
  // backfill cannot trip a per-minute quota on a shared key. 250 ms puts the
  // ceiling near 240 calls/minute, well under the free-tier flash limits.
  if (i < work.length - 1) await new Promise((r) => setTimeout(r, 250));
  if ((i + 1) % 25 === 0 || i === work.length - 1) {
    const done = i + 1;
    const rate = done / ((Date.now() - startedAt) / 1000);
    console.log(`  … ${done}/${work.length} · $${measuredUsd.toFixed(4)} so far · ` +
                `${rate.toFixed(2)}/s · ETA ${Math.round((work.length - done) / Math.max(rate, 1e-6))}s`);
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
const BAD = new Set(["failed", "unusable"]);
for (const r of results) {
  const icon = BAD.has(r.status) ? "✗" : r.status === "incomplete" ? "⚠" : "✓";
  console.log(`${icon} ${r.pid.padEnd(16)} ${r.status.padEnd(11)} ${r.detail}`);
}
const tally = {};
for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
console.log(`\n${Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join(" · ") || "nothing done"}`);
if (Object.keys(droppedTally).length) {
  // A field the vocabulary refuses ACROSS A WHOLE RUN is a prompt problem, not
  // a model having a bad day, and it is invisible unless counted.
  console.log(`dropped values by field: ${Object.entries(droppedTally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" · ")}`);
}
console.log(`model: ${MODEL} · extractor v${EXTRACTOR_VERSION} · calls made: ${spent} (retries included)`);
console.log(`MEASURED cost from the model's own usage: $${measuredUsd.toFixed(5)} (~R${(measuredUsd * USD_TO_ZAR).toFixed(3)})` +
  (spent ? ` · $${(measuredUsd / spent).toFixed(6)}/call vs $${projectExtractionCost(1).usd} projected` : ""));
console.log(`wall clock: ${Math.round((Date.now() - startedAt) / 1000)}s`);
process.exit(results.some((r) => BAD.has(r.status)) ? 1 : 0);
