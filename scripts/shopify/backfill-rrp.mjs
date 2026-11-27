// ── BACKFILL RRP: put the struck-through RRP on every live Shopify product ────
//
//   node scripts/shopify/backfill-rrp.mjs                    dry run (default): counts,
//                                                            a sample of 20, skips + reasons
//   node scripts/shopify/backfill-rrp.mjs --commit           write it; the rollback file
//                                                            goes to ~/marathon-rollbacks/ FIRST
//   node scripts/shopify/backfill-rrp.mjs --rollback <file>  put every variant's previous
//                                                            compareAtPrice back (price untouched)
//   --limit N    only the first N products that need a change (a trial run)
//   --pids a,b   only these products
//
// WHAT IT WRITES. Exactly what the reconciler's price sync writes on every push
// from now on (priceSync.mjs → syncProductPrice): price = the app's retail
// price, compareAtPrice = rrpFor(price, the product's 65%/70% chip). It IS that
// code path, so the backfill and the reconciler can never disagree, and the
// reconciler's diff sees a backfilled product as in step.
//
// LIVE ONLY. The set is /shopify_publish state "live" + liveState "on" (the
// indexed query the reconciler already uses — no whole-node read), and each of
// those must also be ACTIVE in Shopify's own bulk snapshot. Nothing else is
// touched; anything left out is listed with its reason.
//
// IDEMPOTENT + RESUMABLE. Every run re-measures Shopify and changes only what
// differs, so a re-run after an interruption picks up where it stopped and a
// finished catalogue reports zero. Each --commit run writes its own rollback
// file covering exactly the products it was about to change.
import { createRequire } from "module";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { graphql } from "./client.mjs";
import { comparePrices, syncProductPrice, inBatches, variantInputsFor, PRICE_LOG_PATH } from "./priceSync.mjs";
import { rrpOffPct } from "../../src/utils/shopifyRrp.js";
import { serverNowMs } from "./publishNode.mjs";

const flags = process.argv.slice(2);
const arg = (name) => { const i = flags.indexOf(name); return i === -1 ? null : flags[i + 1]; };
const COMMIT = flags.includes("--commit");
const ROLLBACK = arg("--rollback");
const LIMIT = arg("--limit") != null ? Number(arg("--limit")) : null;
const ONLY = arg("--pids") ? new Set(arg("--pids").split(",").map((s) => s.trim()).filter(Boolean)) : null;
// Products written at once. Each is one read + one write; client.mjs waits on
// Shopify's cost bucket when it runs low, so this only sets the ceiling.
const WIDTH = 4;

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const R = (n) => (n == null ? "—" : `R${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`);

// ── ROLLBACK ─────────────────────────────────────────────────────────────────
if (ROLLBACK) {
  const file = JSON.parse(readFileSync(ROLLBACK, "utf8"));
  let restored = 0, failed = 0;
  await inBatches(file.rows, WIDTH, async (row) => {
    // RRP ONLY: the price is never restored — an app price edit since the
    // backfill must not be undone, and the price sync owns price anyway.
    const fixes = row.before.map((v) => ({ id: v.id, to: null, toCompareAt: v.compareAtPrice ?? null }));
    try {
      const r = await graphql(
        `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } } }`,
        { productId: row.gid, variants: variantInputsFor(fixes) }, { mutation: true });
      const errs = r.productVariantsBulkUpdate.userErrors;
      if (errs?.length) { failed++; console.error(`  ⚠ ${row.pid}: ${JSON.stringify(errs)}`); } else restored++;
    } catch (e) { failed++; console.error(`  ⚠ ${row.pid}: ${String(e?.message || e)}`); }
  });
  console.log(`rollback: ${restored} product(s) restored, ${failed} failed, from ${ROLLBACK}.`);
  console.log("NOTE: the RRP is derived on every push — the reconciler's price backstop puts it back within 3 hours unless the code is rolled back too.");
  process.exit(failed ? 1 : 0);
}

// ── MEASURE ──────────────────────────────────────────────────────────────────
const liveSnap = await db.ref("shopify_publish").orderByChild("state").equalTo("live").get();
const liveOn = Object.entries(liveSnap.val() || {}).filter(([, n]) => n?.liveState === "on").map(([pid]) => pid);
const pids = liveOn.filter((pid) => !ONLY || ONLY.has(pid)).sort();
if (ONLY) for (const pid of ONLY) if (!liveOn.includes(pid)) console.log(`  ${pid}: not live and ON — left out`);
console.log(`live and ON: ${liveOn.length} products${ONLY ? ` (${pids.length} selected by --pids)` : ""} — reading the app's prices and one Shopify bulk snapshot…`);

const rows = await comparePrices(db, graphql, pids, { log: (l) => console.error(l) });
const skips = [];
const todo = [];
let inStep = 0;
for (const r of rows) {
  if (!r.gid) skips.push([r, "no Shopify product mapped"]);
  else if (!r.variants) skips.push([r, "not ACTIVE on Shopify (missing from the active snapshot)"]);
  else if (!r.variants.length) skips.push([r, "no variants on Shopify"]);
  else if (r.want == null && !r.fixes.length) skips.push([r, `no usable retail price in the app (${JSON.stringify(r.retail ?? null)}) — no RRP`]);
  else if (r.fixes.length) todo.push(r);
  else inStep++;
}
const priceAlsoWrong = todo.filter((r) => r.fixes.some((f) => f.to != null && Math.round(Number(f.from) * 100) !== Math.round(Number(f.to) * 100)));
const clearing = todo.filter((r) => r.wantCompareAt == null);
const at70 = rows.filter((r) => r.rrpDiscountPct === 70).length;

console.log(`\n══ ${rows.length} live products checked`);
console.log(`   ${todo.length} need their RRP set or corrected` +
  (priceAlsoWrong.length ? ` (${priceAlsoWrong.length} of them also have a Shopify price that disagrees with the app — corrected to the app price too)` : "") +
  (clearing.length ? ` · ${clearing.length} carry an RRP with no app price and will have it cleared` : ""));
console.log(`   ${inStep} already show the right RRP · ${skips.length} skipped · ${at70} set to 70%`);

const sample = [...todo].sort(() => Math.random() - 0.5).slice(0, 20);
await Promise.all(sample.map(async (r) => { r.name = (await db.ref(`products/${r.pid}/name`).get()).val(); }));
if (sample.length) {
  console.log(`\nSAMPLE (${sample.length} of ${todo.length}):`);
  console.log(["product id".padEnd(16), "price".padStart(9), "RRP now".padStart(10), "RRP new".padStart(10), "off".padStart(5), "  name"].join(" "));
  for (const r of sample) {
    const now = r.fixes[0].fromCompareAt;
    const off = rrpOffPct(r.want, r.wantCompareAt);
    console.log([r.pid.padEnd(16), R(r.want).padStart(9), R(now).padStart(10), R(r.wantCompareAt).padStart(10),
      (off == null ? "—" : `${off}%`).padStart(5), ` ${r.name || ""}`].join(" "));
  }
}
if (skips.length) {
  const byWhy = new Map();
  for (const [r, why] of skips) (byWhy.get(why) ?? byWhy.set(why, []).get(why)).push(r.pid);
  console.log(`\nSKIPPED (${skips.length}):`);
  for (const [why, list] of byWhy) console.log(`  ${list.length} × ${why}: ${list.slice(0, 12).join(", ")}${list.length > 12 ? " …" : ""}`);
}

if (!COMMIT) { console.log("\nDry run — nothing written. Re-run with --commit to apply."); process.exit(0); }
const work = LIMIT != null ? todo.slice(0, LIMIT) : todo;
if (!work.length) { console.log("\nnothing to change."); process.exit(0); }

// ── COMMIT: rollback file FIRST, then the same write the reconciler makes ───
const dir = join(homedir(), "marathon-rollbacks");
mkdirSync(dir, { recursive: true });
const file = join(dir, `shopify-rrp-backfill-${new Date().toISOString().replace(/[:.]/g, "")}.json`);
// Rows are the values syncProductPrice read from Shopify for the very write it
// is about to send (its beforeWrite hook) — never the earlier bulk snapshot —
// and the file is re-written after each one, before the next batch starts.
const rollbackRows = [];
const saveRollback = () => writeFileSync(file, JSON.stringify({
  writtenAt: new Date().toISOString(),
  note: "Shopify variant price + compareAtPrice BEFORE backfill-rrp.mjs --commit. Restore: node scripts/shopify/backfill-rrp.mjs --rollback <this file>",
  rows: rollbackRows,
}, null, 2));
saveRollback();
console.log(`\nrollback file: ${file} (filled in as each product is written)`);

let changed = 0, already = 0, failed = 0, done = 0, noLongerLive = 0;
await inBatches(work, WIDTH, async (r) => {
  try {
    // LIVE ONLY, re-checked at write time: a product switched off (or
    // unlisted) since the measurement is left alone.
    const node = (await db.ref(`shopify_publish/${r.pid}`).get()).val();
    if (node?.state !== "live" || node?.liveState !== "on") { noLongerLive++; console.log(`  ${r.pid}: no longer live and ON — skipped`); return; }
    const res = await syncProductPrice(db, graphql, r.pid, {
      commit: true, source: "backfill-rrp", now: () => serverNowMs(db), log: () => {},
      beforeWrite: async (row) => {
        if (!r.variants.length || row.gid !== r.gid) throw new Error(`mapping moved from ${r.gid} to ${row.gid} since the measurement — not written`);
        rollbackRows.push({ ...row, appRetail: r.want, rrp: r.wantCompareAt, rrpDiscountPct: r.rrpDiscountPct });
        saveRollback();
      },
    });
    if (res.changed) changed++;
    else if (res.ok) already++;
    else { failed++; console.error(`  ⚠ ${r.pid}: ${res.why}`); }
  } catch (e) { failed++; console.error(`  ⚠ ${r.pid}: ${String(e?.message || e)}`); }
  if (++done % 100 === 0) console.log(`  … ${done}/${work.length}`);
});
console.log(`\napplied: ${changed} product(s) written · ${already} already right on re-read · ${noLongerLive} no longer live · ${failed} failed · log at /${PRICE_LOG_PATH}/{pid}`);

// Re-measure only what this run touched — proves the write converged.
const after = await comparePrices(db, graphql, work.map((r) => r.pid), { log: (l) => console.error(l) });
const still = after.filter((r) => r.fixes.length);
console.log(`re-measured: ${after.length - still.length}/${after.length} now in step` + (still.length ? ` · STILL DIFFERENT: ${still.slice(0, 20).map((r) => r.pid).join(", ")}` : ""));
process.exit(failed || still.length ? 1 : 0);
