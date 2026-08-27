#!/usr/bin/env node
// ─── PUBLISH TITLES — AND ONLY TITLES ────────────────────────────────────────
// Pushes the approved `cleanName` from /shopify_publish/{pid} to the Shopify
// product's `title`, and touches NOTHING ELSE.
//
// ── WHY THIS EXISTS, WHEN reconcile.mjs ALREADY PUSHES TITLES ────────────────
// Because reconcile.mjs pushes the handle with them. Its field-reconcile path
// sends
//
//     { id: gid, title: payload.title, handle: payload.handle, ... }
//
// where `payload.handle = buildHandle(title)` — so renaming a product THERE
// rewrites its handle from the new name. On a product that is already live
// that is not a cosmetic change:
//
//   · the storefront URL changes, and every existing link to it — an old post,
//     a customer's bookmark, a WhatsApp share — stops resolving;
//   · the Meta catalogue's `link` field is the product URL, so every ad
//     pointing at that product changes destination mid-flight;
//   · handles are the strong duplicate key the publisher's own guard relies on
//     (`productByIdentifier(handle:)`), and a bulk rewrite is a bulk chance of
//     collision — two of the naming run's 2,751 proposed handles already
//     collide with each other.
//
// A title change on its own has none of those consequences. Shopify only
// regenerates a handle when you SEND one, so the fix is simply not to send it.
//
// ── THE GUARANTEE, AND HOW IT IS PROVEN ─────────────────────────────────────
// Not "we don't pass handle" as a claim in a comment — the handle is read
// BEFORE the write and read again AFTER it, and a run that finds them
// different stops immediately and says so. If Shopify ever changes its
// behaviour, this finds out on the first product rather than the six hundredth.
//
// SEO title is deliberately left alone too. `buildSeo` derives it from the
// product name, so a strict titles-only push leaves the SEO title showing the
// old name. That is a known, reported trade-off of "titles only" — it is not
// an oversight, and `--with-seo` opts into updating it.
//
// ── SAFETY ──────────────────────────────────────────────────────────────────
//   · DRY RUN BY DEFAULT. `--commit` is required to write.
//   · Every title is re-validated against the trigger lexicon at push time.
//     The payment gateway keyword-flags brand terms in any pushed field, and a
//     name approved before a lexicon change could have gone stale since.
//   · `--pid <id>` restricts the run to one product, which is how this gets
//     tested against live data at all.
//   · `--limit N` caps a run (default 25, matching the reconciler's cap).
//
// Usage:
//   node scripts/shopify/publish-titles.mjs                 # dry run, all drift
//   node scripts/shopify/publish-titles.mjs --pid p177...   # one product
//   node scripts/shopify/publish-titles.mjs --commit --limit 25
import { createRequire } from "module";
import { graphql } from "./client.mjs";
import { isTriggerFree, triggersInText } from "../../src/utils/shopifyTriggers.js";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const COMMIT = has("--commit");
const WITH_SEO = has("--with-seo");
const ONLY_PID = val("--pid", null);
const LIMIT = Number(val("--limit", "25"));
const INCLUDE_OFFLINE = has("--include-offline");

if (!Number.isFinite(LIMIT) || LIMIT <= 0) { console.error("--limit must be a positive number"); process.exit(2); }

// firebase-admin lives in functions/, same shim the reconciler uses. A git
// WORKTREE has no functions/node_modules of its own, so fall back to the main
// checkout's copy rather than failing with an opaque MODULE_NOT_FOUND.
function loadAdmin() {
  const candidates = [
    new URL("../../functions/package.json", import.meta.url),
    new URL("../../../../functions/package.json", import.meta.url), // .worktrees/<name>/ → main checkout
  ];
  let last;
  for (const c of candidates) {
    try { return createRequire(c)("firebase-admin"); } catch (e) { last = e; }
  }
  console.error("Could not load firebase-admin. Run `npm install` in functions/ of the main checkout.");
  console.error(String(last?.message || last));
  process.exit(2);
}
const admin = loadAdmin();
admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const pub = (await db.ref("shopify_publish").get()).val() || {};
const sync = (await db.ref("shopify_sync").get()).val() || {};

// ── BUILD THE WORK LIST ─────────────────────────────────────────────────────
// A row qualifies when the product is mapped to Shopify AND its approved
// cleanName differs from what Shopify currently shows. The live title is read
// from Shopify per product rather than from any cached copy — the whole point
// is to find out what is actually there.
const candidates = [];
for (const [pid, node] of Object.entries(pub)) {
  if (ONLY_PID && pid !== ONLY_PID) continue;
  const gid = sync[pid]?.shopifyProductId;
  if (!gid || !node) continue;
  const want = String(node.cleanName || "").trim();
  if (!want) continue;
  candidates.push({ pid, gid, want, src: node.cleanNameSource || "(none)", live: node.liveState || "-" });
}

if (!candidates.length) {
  console.error(ONLY_PID ? `No mapped product with an approved name for pid ${ONLY_PID}.` : "No mapped products with approved names.");
  process.exit(1);
}

console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — ${candidates.length} mapped product(s) to inspect\n`);

const plan = [];
let unchanged = 0, refusedTrigger = 0, missing = 0, skippedOffline = 0;

for (const c of candidates) {
  let cur;
  try {
    cur = (await graphql(
      `query ($id: ID!) { product(id: $id) { id title handle status } }`,
      { id: c.gid }
    )).product;
  } catch (e) {
    console.log(`  ⚠ ${c.pid} — could not read Shopify product: ${String(e?.message || e)}`);
    missing++;
    continue;
  }
  if (!cur) { console.log(`  ⚠ ${c.pid} — ${c.gid} not found on Shopify`); missing++; continue; }

  if (String(cur.title).trim() === c.want) { unchanged++; continue; }

  // Re-validate at push time. An approved name is not permanently safe: the
  // lexicon is a living data decision and a term added since approval would
  // otherwise sail into a pushed field and trip the gateway.
  if (!isTriggerFree(c.want)) {
    console.log(`  ✗ ${c.pid} REFUSED — approved name trips the lexicon (${triggersInText(c.want).join(", ")}): "${c.want}"`);
    refusedTrigger++;
    continue;
  }

  if (!INCLUDE_OFFLINE && c.live !== "on") { skippedOffline++; continue; }

  plan.push({ ...c, gid: cur.id, from: cur.title, handle: cur.handle, status: cur.status });
}

console.log(`  already correct        : ${unchanged}`);
console.log(`  refused (lexicon)      : ${refusedTrigger}`);
console.log(`  not readable on Shopify: ${missing}`);
if (!INCLUDE_OFFLINE) console.log(`  skipped (channel off)  : ${skippedOffline}   (--include-offline to include)`);
console.log(`  TO CHANGE              : ${plan.length}\n`);

if (!plan.length) { console.log("Nothing to do."); process.exit(0); }

const batch = plan.slice(0, LIMIT);
if (plan.length > batch.length) console.log(`Capped at --limit ${LIMIT}; ${plan.length - batch.length} left for the next run.\n`);

for (const r of batch) {
  console.log(`  ${r.pid} [${r.src}] ${r.status}`);
  console.log(`      from: "${r.from}"`);
  console.log(`      to  : "${r.want}"`);
  console.log(`      handle stays: ${r.handle}`);
}

if (!COMMIT) {
  console.log(`\nDry run — nothing written. Re-run with --commit to apply these ${batch.length}.`);
  process.exit(0);
}

// ── APPLY ───────────────────────────────────────────────────────────────────
console.log(`\nApplying ${batch.length}…\n`);
let ok = 0, failed = 0;
for (const r of batch) {
  const input = { id: r.gid, title: r.want };
  if (WITH_SEO) input.seo = { title: r.want };
  try {
    const res = await graphql(
      `mutation ($input: ProductUpdateInput!) {
        productUpdate(product: $input) {
          product { id title handle }
          userErrors { field message }
        }
      }`,
      { input },
      { mutation: true }
    );
    const errs = res.productUpdate.userErrors;
    if (errs?.length) {
      console.log(`  ✗ ${r.pid} userErrors: ${JSON.stringify(errs)}`);
      failed++;
      continue;
    }
    const after = res.productUpdate.product;

    // THE GUARANTEE, CHECKED. A changed handle here means Shopify altered
    // behaviour or something else wrote concurrently; either way this run stops
    // rather than doing it to another six hundred products.
    if (after.handle !== r.handle) {
      console.error(`\n  ✗✗ ${r.pid} HANDLE CHANGED: "${r.handle}" -> "${after.handle}"`);
      console.error(`  Stopping the run. ${ok} title(s) already applied. Nothing further is written.`);
      process.exit(3);
    }
    if (String(after.title).trim() !== r.want) {
      console.log(`  ✗ ${r.pid} title did not stick: got "${after.title}"`);
      failed++;
      continue;
    }
    console.log(`  ✓ ${r.pid} "${after.title}"  (handle unchanged: ${after.handle})`);
    ok++;
  } catch (e) {
    console.log(`  ✗ ${r.pid} ${String(e?.message || e)}`);
    failed++;
  }
}

console.log(`\napplied ${ok}, failed ${failed}`);
if (!WITH_SEO && ok) {
  console.log("NOTE: SEO titles still carry the OLD name (titles-only by request). --with-seo updates them.");
}
process.exit(failed ? 1 : 0);
