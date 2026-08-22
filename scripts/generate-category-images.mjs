// ─── CATEGORY IMAGES — ONE STUDIO PHOTOGRAPH PER CATEGORY ─────────────────────
//
// Replaces the emoji glyphs on the Engine Policy screen with studio product
// photography: one square image per category, a single representative item on a
// plain neutral seamless background, even lighting, no logos, no text, no
// branding, no people.
//
// ── IT RUNS ONCE, AS A SCRIPT, NEVER AT RENDER TIME ──────────────────────────
// The image is generated here, uploaded to Firebase Storage under
// `category-images/`, and its URL is CACHED on the taxonomy registry entry at
// /settings/productTaxonomy/cats/<key>/imageUrl. The card reads that field and
// nothing else. A category with no image renders its emoji, which is the
// fallback for as long as it takes — the screen never waits on a model.
//
// ── IT REUSES THE PIPELINE THIS REPO ALREADY HAS ─────────────────────────────
// Same provider, same model, same secret as the product-photo path in
// functions/index.js: gemini-3.1-flash-image ("Nano Banana 2") over raw REST,
// with GEMINI_API_KEY read from Secret Manager. No new provider, no new key, no
// new dependency — the constants below are copied WITH their source noted so a
// model change over there is findable from here.
//
// ── WHAT IT WRITES, AND WHAT IT DOES NOT ─────────────────────────────────────
// WRITES:  a Storage object per category, and ONE new field (`imageUrl`) on the
//          taxonomy registry entry.
// NEVER:   a product record, a categoryKey, a /stock_targets row, a policy, or
//          any other field on the registry entry. The update is a single-key
//          `update()` on the entry, not a `set()` of it.
//
// ── COST ─────────────────────────────────────────────────────────────────────
// MEASURED 2026-08-22: $0.0908 per image, and $2.91 for 32 of the 35 live
// categories. The model's documented flat rate of $0.067 is a floor, not an
// average — this prompt is long and the output is 1024 square. The real figure
// comes back in usageMetadata per call and is totalled at the end; the estimate
// that gates the spend uses the measured number, because an estimate guarding a
// bill must not lean low.
//
// The script REFUSES to start if its own estimate exceeds MAX_SPEND_USD — a
// runaway here is a bill, not a stack trace.
//
// The run is RESUMABLE and that is load-bearing: it skips any category that
// already has an imageUrl, so a run interrupted by an empty account or a
// dropped connection is finished by running it again, not repeated.
//
// ── USAGE ────────────────────────────────────────────────────────────────────
//   node scripts/generate-category-images.mjs                 # dry run: prompts + cost, nothing generated
//   node scripts/generate-category-images.mjs --execute       # generate the missing ones
//   node scripts/generate-category-images.mjs --execute --only sneakers,bags
//   node scripts/generate-category-images.mjs --execute --regenerate   # replace existing images too
//
// A dry run prints every prompt in full. Read them before spending.

import { createRequire } from "module";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXECUTE = process.argv.includes("--execute");
const REGENERATE = process.argv.includes("--regenerate");
const ONLY = (() => {
  const i = process.argv.indexOf("--only");
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean) : null;
})();
const OUT = join(ROOT, "var", `category-images-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

// ── THE MODEL, MIRRORED FROM functions/index.js ──────────────────────────────
// gemini-3.1-flash-image, the forced replacement for gemini-2.5-flash-image
// (retired 2026-10-02). If that constant moves over there, move it here too;
// this comment is the only thing linking them and it is doing real work.
const GEMINI_MODEL = "gemini-3.1-flash-image";
const GEMINI_OUT_PER_MTOK = 60;
const GEMINI_FLAT_IMAGE_USD = 0.067;   // the model's documented flat rate, used when usageMetadata is absent
// The MEASURED cost of one image from this prompt, 2026-08-22: $0.0908. The
// documented flat rate is a floor, not an average — this prompt is long and the
// output is 1024², so it comes back above it. Estimating on 0.067 understated
// the full set by a third, which is exactly the direction an estimate that
// gates a spend must not lean.
const ESTIMATE_PER_IMAGE_USD = 0.095;
const GEMINI_TIMEOUT_MS = 180000;
const STORAGE_BUCKET = "marathon-club.firebasestorage.app";
const SECRET = "projects/marathon-club/secrets/GEMINI_API_KEY/versions/latest";

// A runaway loop here is a BILL, not a stack trace. The estimate is checked
// before the first call and the running total is checked before every one.
const MAX_SPEND_USD = 5;

// ── THE SUBJECT ──────────────────────────────────────────────────────────────
// One concrete noun phrase per category, because "Bags" is a category and a
// photograph needs an object. Derived from the registry LABEL where the label
// already names an object; overridden here only where it does not, or where it
// names two things and the photograph can only be one.
//
// The overrides are deliberately plain and unbranded — "a plain black leather
// belt", not "a designer belt" — because the constraint below forbids logos and
// a prompt that asks for a designer item and then forbids branding is a prompt
// arguing with itself.
const SUBJECTS = {
  "caps-beanies": "a plain navy knitted beanie, sitting upright",
  "fitted-caps": "a plain black fitted baseball cap, three-quarter view",
  visors: "a plain white sun visor",
  perfumes: "a clear glass perfume bottle with a silver cap, no label",
  bags: "a plain black nylon duffel bag",
  belts: "a plain black leather belt, coiled",
  "t-shirts": "a plain white cotton t-shirt, neatly folded",
  hoodies: "a plain grey pullover hoodie, neatly folded",
  jackets: "a plain black zip-up jacket on an invisible mannequin",
  pants: "a pair of plain black chino trousers, neatly folded",
  "cargo-pants": "a pair of plain khaki cargo trousers, neatly folded",
  jeans: "a pair of plain indigo denim jeans, neatly folded",
  shorts: "a pair of plain navy athletic shorts, neatly folded",
  sneakers: "a single plain white leather sneaker, side profile",
  "designer-shoes": "a single plain black leather dress shoe, side profile",
  loafers: "a single plain brown leather loafer, side profile",
  "running-shoes": "a single plain grey mesh running shoe, side profile",
  "kids-shoes": "a single small plain white child's trainer, side profile",
  boots: "a single plain tan leather ankle boot, side profile",
  slides: "a single plain black slide sandal, side profile",
  "soccer-boots": "a single plain black football boot with studs, side profile",
  "soccer-jerseys": "a plain red short-sleeved football jersey on an invisible mannequin",
  "baseball-shirts": "a plain cream baseball shirt with navy sleeves, neatly folded",
  "basketball-vests": "a plain white basketball vest, neatly folded",
  "golf-t-shirts": "a plain navy short-sleeved polo shirt, neatly folded",
  shirts: "a plain light blue long-sleeved button shirt, neatly folded",
  suits: "a plain charcoal two-piece suit jacket on an invisible mannequin",
  dresses: "a plain black knee-length dress on an invisible mannequin",
  tracksuits: "a plain navy tracksuit jacket and trousers, neatly folded together",
  "ladies-tracksuits": "a plain light grey women's tracksuit jacket and trousers, neatly folded together",
  sweaters: "a plain oatmeal knitted crew-neck sweater, neatly folded",
  underwear: "a pair of plain grey cotton boxer briefs, neatly folded",
  gloves: "a pair of plain black knitted gloves, laid flat",
  watches: "a plain silver analogue wristwatch with a black leather strap",
  sunglasses: "a pair of plain black sunglasses, three-quarter view",
  "chains-bracelets": "a plain silver curb-link chain, coiled",
  packaging: "a plain brown cardboard shipping box, closed",
};

// ── THE PROMPT ───────────────────────────────────────────────────────────────
// One template, one subject slot. Every constraint in the brief is stated
// POSITIVELY first and then negatively, because a model given only prohibitions
// tends to produce something that satisfies them and nothing else.
//
// "photographed against a seamless light grey studio backdrop" rather than
// "white": the card renders on a black background, and a pure-white cut-out
// reads as a hole in the page rather than as a photograph.
const PROMPT_TEMPLATE = (subject) => [
  `A single product photograph of ${subject}.`,
  "Studio product photography: the item is the only object in the frame, centred, filling roughly 80% of a perfectly square image.",
  "Photographed against a seamless plain neutral light grey backdrop with no visible edges, corners or horizon line.",
  "Even, soft, diffuse studio lighting from both sides, with a gentle contact shadow directly beneath the item and no harsh highlights.",
  "Sharp focus across the whole item, realistic materials and texture, natural colour.",
  "The item is completely unbranded: no logos, no brand marks, no emblems, no printed or embroidered text of any kind, no tags, no labels, no swing tickets, no barcodes.",
  "No people, no hands, no mannequin heads, no props, no packaging, no other objects, no reflections of a studio, no watermark, no border, no text anywhere in the image.",
].join(" ");

const pad = (s, n) => String(s).padEnd(n);
const line = (n = 92) => "─".repeat(n);

async function geminiImage(apiKey, prompt) {
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        // Square, because the card's thumbnail is square and a letterboxed
        // image cropped to a square loses the item's edges.
        generationConfig: { imageConfig: { aspectRatio: "1:1" } },
      }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
  } catch (err) {
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`gemini request timed out after ${GEMINI_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    const e = new Error(`gemini HTTP ${res.status}: ${body}`);
    e.status = res.status;
    throw e;
  }
  const json = await res.json();
  const parts = ((((json.candidates || [])[0] || {}).content) || {}).parts || [];
  let b64 = null, mime = "image/png";
  for (const p of parts) {
    const inl = p.inlineData || p.inline_data;          // REST returns camelCase; accept both
    if (inl && inl.data) { b64 = inl.data; mime = inl.mimeType || inl.mime_type || mime; break; }
  }
  if (!b64) throw new Error("gemini returned no image");
  const outTok = (json.usageMetadata || {}).candidatesTokenCount || 0;
  const costUSD = outTok ? +((outTok / 1e6) * GEMINI_OUT_PER_MTOK).toFixed(6) : GEMINI_FLAT_IMAGE_USD;
  return { buffer: Buffer.from(b64, "base64"), costUSD, mime };
}

(async () => {
  console.log(`\n${"═".repeat(92)}`);
  console.log(`  CATEGORY IMAGES — ${EXECUTE ? "GENERATE" : "DRY RUN (nothing is generated, nothing is written)"}`);
  console.log(`${"═".repeat(92)}`);

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
    storageBucket: STORAGE_BUCKET,
  });
  const db = admin.database();

  const taxonomy = (await db.ref("settings/productTaxonomy").once("value")).val() || {};
  const cats = taxonomy.cats && typeof taxonomy.cats === "object" ? taxonomy.cats : {};

  const keys = Object.keys(cats).sort()
    .filter((k) => (ONLY ? ONLY.includes(k) : true))
    .filter((k) => REGENERATE || typeof cats[k].imageUrl !== "string");
  const skipped = Object.keys(cats).length - keys.length;

  const missingSubject = keys.filter((k) => !SUBJECTS[k]);
  if (missingSubject.length) {
    // A missing subject is NOT filled in from the label automatically. "Sweaters"
    // as a subject produces a photograph of the word's average, which is a
    // different thing every run; the point of the map is that the subject is a
    // decision somebody made.
    console.log(`\n  🛑 no subject written for: ${missingSubject.join(", ")}`);
    console.log(`     Add one to SUBJECTS in this file. A category's photograph is a decision, not a default.`);
    if (EXECUTE) process.exit(1);
  }

  const todo = keys.filter((k) => SUBJECTS[k]);
  const estimate = +(todo.length * ESTIMATE_PER_IMAGE_USD).toFixed(2);

  console.log(`\n  categories in the registry : ${Object.keys(cats).length}`);
  console.log(`  already have an image      : ${skipped}${REGENERATE ? " (regenerating anyway)" : " (skipped)"}`);
  console.log(`  to generate                : ${todo.length}`);
  console.log(`  model                      : ${GEMINI_MODEL} @ ~$${ESTIMATE_PER_IMAGE_USD}/image (measured 2026-08-22)`);
  console.log(`  ESTIMATE                   : $${estimate}   (ceiling $${MAX_SPEND_USD})`);

  if (estimate > MAX_SPEND_USD) {
    console.log(`\n  🛑 STOP — the estimate exceeds the ceiling. Narrow it with --only, or raise`);
    console.log(`     MAX_SPEND_USD deliberately after reading why it is there.`);
    process.exit(1);
  }

  console.log(`\n── THE PROMPTS ${line(78)}`);
  for (const k of todo) {
    console.log(`\n  ${k}  (${cats[k].label})`);
    console.log(`    ${PROMPT_TEMPLATE(SUBJECTS[k])}`);
  }

  if (!EXECUTE) {
    console.log(`\n  Dry run. Nothing generated, nothing uploaded, nothing written.`);
    console.log(`  Re-run with --execute to spend $${estimate}.\n`);
    process.exit(0);
  }

  const sm = new SecretManagerServiceClient();
  const [v] = await sm.accessSecretVersion({ name: SECRET });
  const apiKey = v.payload.data.toString().trim();
  if (!apiKey) { console.error("GEMINI_API_KEY is empty."); process.exit(1); }

  const bucket = admin.storage().bucket(STORAGE_BUCKET);
  const results = [];
  let spent = 0;

  console.log(`\n── GENERATING ${line(79)}`);
  for (const key of todo) {
    // ── RESERVE BEFORE THE CALL, RECONCILE AFTER ──────────────────────────────
    // `spent` used to update only from the RESPONSE, so the check at the top of
    // the loop could not stop an over-budget request — it could only notice one
    // after it had been paid for. The upper bound for one request is reserved
    // first and replaced with the measured figure once it comes back, so the
    // ceiling is a ceiling rather than a report. (CodeRabbit, PR #401.)
    if (spent + ESTIMATE_PER_IMAGE_USD > MAX_SPEND_USD) {
      console.log(`  🛑 spend ceiling would be crossed by the next image ($${spent.toFixed(3)} + $${ESTIMATE_PER_IMAGE_USD}) — stopping with ${todo.length - results.length} left.`);
      break;
    }
    spent += ESTIMATE_PER_IMAGE_USD;                 // reserved; reconciled below
    const prompt = PROMPT_TEMPLATE(SUBJECTS[key]);
    try {
      // ── 429 IS NOT A FAILURE, IT IS A QUEUE ────────────────────────────────
      // The first full run lost three categories to rate limiting at the tail
      // and reported them as errors, which reads as "the prompt was rejected".
      // A rate limit is the API asking to be asked again; backing off costs
      // nothing (a refused request is not billed) and a lost image costs a
      // re-run of the whole set to notice.
      let gen = null, wait = 20000;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try { gen = await geminiImage(apiKey, prompt); break; }
        catch (err) {
          // A 429 carrying "prepayment credits" is not a rate limit — it is an
          // empty account, and no amount of waiting fixes it. Measured
          // 2026-08-22: the last three categories of the full run failed this
          // way, and retrying them three times each was three minutes of
          // waiting for the same answer.
          if (/prepayment credits/i.test(String(err.message || ""))) {
            throw new Error("Gemini prepayment credits are exhausted — top the account up and re-run; images already generated are skipped.");
          }
          if (err.status !== 429 || attempt === 4) throw err;
          console.log(`    ${key}: rate limited, waiting ${wait / 1000}s (attempt ${attempt} of 3)`);
          await new Promise((r) => setTimeout(r, wait));
          wait *= 2;
        }
      }
      const { buffer, costUSD, mime } = gen;
      spent += costUSD - ESTIMATE_PER_IMAGE_USD;     // reconcile the reservation

      // A UNIQUE PATH PER GENERATION. Overwriting the previous object would
      // change what an already-cached URL points at, and the cache header below
      // is a year long and immutable — a browser holding the old copy would
      // never see the new one, and one holding neither would see whichever
      // arrived last. A new path is a new URL and there is no ambiguity.
      const token = randomUUID();
      const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
      const path = `category-images/${key}_${token}.${ext}`;
      await bucket.file(path).save(buffer, {
        resumable: false,
        contentType: mime,
        metadata: {
          cacheControl: "public, max-age=31536000, immutable",
          metadata: { firebaseStorageDownloadTokens: token },
        },
      });
      const url = `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;

      // ── ONE FIELD, AND AN UPLOAD THAT DOES NOT OUTLIVE ITS REFERENCE ──────
      // `update`, never `set` — the registry entry carries the category's
      // label, size run, flags and legacy mapping, and this script has no
      // business touching any of them.
      //
      // If the database write fails after the upload succeeds, the object is
      // ORPHANED: nothing references it, the next run still sees no imageUrl,
      // generates another paid image, and the first one sits in the bucket
      // forever. It is deleted here rather than left — it is seconds old, its
      // path is unique to this generation, and nothing can be pointing at it.
      // The path is printed either way, so a failed cleanup is recoverable by
      // hand. (CodeRabbit, PR #401.)
      try {
        await db.ref(`settings/productTaxonomy/cats/${key}`).update({ imageUrl: url });
      } catch (dbErr) {
        let cleaned = false;
        try { await bucket.file(path).delete(); cleaned = true; } catch { /* reported below */ }
        results.push({ key, label: cats[key].label, prompt, path, url, costUSD,
          error: `registry write failed: ${String(dbErr.message || dbErr)}`,
          orphanCleaned: cleaned });
        console.log(`  ✗ ${pad(key, 20)} registry write failed; uploaded object ${cleaned ? "deleted" : `LEFT AT ${path} — delete it by hand`}`);
        continue;
      }

      results.push({ key, label: cats[key].label, prompt, path, url, costUSD, bytes: buffer.length });
      console.log(`  ✓ ${pad(key, 20)} $${costUSD.toFixed(4)}  ${(buffer.length / 1024).toFixed(0)}kB  ${path}`);
    } catch (e) {
      results.push({ key, label: cats[key].label, prompt, error: String(e.message || e) });
      console.log(`  ✗ ${pad(key, 20)} ${String(e.message || e).slice(0, 90)}`);
    }
  }

  const ok = results.filter((r) => r.url).length;
  console.log(`\n  ${ok} of ${todo.length} generated.  SPENT: $${spent.toFixed(3)}`);
  console.log(`  Categories without an image keep their emoji — the card falls back on its own.`);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(), model: GEMINI_MODEL, spentUSD: +spent.toFixed(3),
    promptTemplate: PROMPT_TEMPLATE("<subject>"), results,
  }, null, 2));
  console.log(`  JSON → ${OUT}\n`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
