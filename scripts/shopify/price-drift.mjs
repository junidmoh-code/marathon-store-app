// ── PRICE DRIFT: the app's retail price beside the website's, every live product
//
//   node scripts/shopify/price-drift.mjs              report (read-only, default)
//   node scripts/shopify/price-drift.mjs --apply      set Shopify to the app's retail
//                                                     price on every mismatch; writes
//                                                     ~/marathon-rollbacks/shopify-price-drift-<ts>.json
//                                                     FIRST, then re-measures
//   node scripts/shopify/price-drift.mjs --rollback <file>   put the "before" prices back
//
// Repeatable: it reads, compares and (with --apply) writes only what differs,
// so a second run reports zero and writes nothing.
//
// Reads WITHOUT a whole-node read: the live set is the indexed
// /shopify_publish state=="live" query the reconciler already uses; each
// product's retailPrice/stockPrice/mapping are read by id; Shopify comes from
// ONE bulk query (no throttle).
//
// Pattern column (which suspect the mismatch matches):
//   "1: trade price pushed"  Shopify shows the record's stockPrice
//   "3: edited in Shopify"   a non-app (admin) event on the product after it went live
//   "2: app price changed after publish"  everything else — the reconciler
//       priced it at publish and nothing pushed the later app price
import { createRequire } from "module";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { graphql } from "./client.mjs";
import { comparePrices, driftPattern, syncProductPrice, PRICE_LOG_PATH } from "./priceSync.mjs";

const flags = process.argv.slice(2);
const APPLY = flags.includes("--apply");
const rbIdx = flags.indexOf("--rollback");
const ROLLBACK = rbIdx !== -1 ? flags[rbIdx + 1] : null;

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const R = (n) => `R${Number(n).toFixed(2)}`;

if (ROLLBACK) {
  const file = JSON.parse(readFileSync(ROLLBACK, "utf8"));
  let n = 0;
  for (const row of file.rows) {
    const byPrice = new Map();
    for (const v of row.before) (byPrice.get(v.price) ?? byPrice.set(v.price, []).get(v.price)).push(v.id);
    for (const [price, ids] of byPrice) {
      const r = await graphql(
        `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } } }`,
        { productId: row.gid, variants: ids.map((id) => ({ id, price })) }, { mutation: true });
      const errs = r.productVariantsBulkUpdate.userErrors;
      if (errs?.length) console.error(`  ⚠ ${row.pid}: ${JSON.stringify(errs)}`); else n += ids.length;
    }
  }
  console.log(`rollback: ${n} variant price(s) restored from ${ROLLBACK}.`);
  console.log("NOTE: the reconciler's price backstop will set them back to the app price on its next run unless the app prices change too.");
  process.exit(0);
}

const liveSnap = await db.ref("shopify_publish").orderByChild("state").equalTo("live").get();
const live = Object.entries(liveSnap.val() || {}).filter(([, n]) => n?.liveState === "on");
const nodeOf = new Map(live);
const pids = live.map(([pid]) => pid).sort();
console.log(`live and ON: ${pids.length} products — reading the app's prices and one Shopify bulk snapshot…`);

async function measure() {
  return comparePrices(db, graphql, pids, { log: (l) => console.error(l) });
}

async function classify(rows) {
  // Suspect 3 needs Shopify's own audit trail — asked only for the mismatches.
  for (const r of rows) {
    r.pattern = driftPattern({ retail: r.retail, trade: r.trade, shopify: r.fixes[0].from });
    if (r.pattern.startsWith("1:")) continue;
    const liveAt = Number(nodeOf.get(r.pid)?.liveAt) || 0;
    const ev = await graphql(
      `query ($id: ID!) { product(id: $id) { title events(first: 50, sortKey: CREATED_AT, reverse: true) { nodes { createdAt appTitle message } } } }`,
      { id: r.gid });
    r.title = ev.product?.title ?? "";
    const human = (ev.product?.events?.nodes ?? []).filter((e) =>
      Date.parse(e.createdAt) > liveAt && !/Marathon Catalogue Sync/i.test(e.appTitle || "") &&
      !/Facebook|Instagram|Point of Sale|Online Store|status/i.test(e.message || ""));
    r.pattern = human.length ? `3: edited in Shopify (${human[0].createdAt} ${human[0].appTitle || "admin"})` : "2: app price changed after publish";
  }
}

function report(rows, label) {
  const bad = rows.filter((r) => r.fixes.length);
  const unmapped = rows.filter((r) => !r.gid || !r.variants);
  const noRetail = rows.filter((r) => r.gid && r.variants && r.want == null);
  console.log(`\n══ ${label}: ${rows.length} live products checked · ${bad.length} price mismatch(es)` +
    (unmapped.length ? ` · ${unmapped.length} with no Shopify product in the active snapshot` : "") +
    (noRetail.length ? ` · ${noRetail.length} with no retailPrice in the app (not compared)` : ""));
  if (!bad.length) return { bad, under: [], underTotal: 0, overTotal: 0 };
  const lines = bad.map((r) => {
    const shop = Number(r.fixes[0].from);
    const mixed = new Set(r.fixes.map((f) => f.from)).size > 1 ? "*" : "";
    return { ...r, shop, mixed, diff: Number(r.want) - shop };
  }).sort((a, b) => b.diff - a.diff);
  console.log(["product id".padEnd(16), "app retail".padStart(11), "app trade".padStart(10), "Shopify".padStart(10), "diff".padStart(9), "  name / pattern"].join(" "));
  for (const l of lines) {
    console.log([l.pid.padEnd(16), R(l.want).padStart(11), (l.trade != null ? R(l.trade) : "-").padStart(10),
      (R(l.shop) + l.mixed).padStart(10), (l.diff > 0 ? "+" : "") + l.diff.toFixed(2).padStart(8),
      ` ${l.name || l.title || ""} · ${l.pattern || ""}`].join(" "));
  }
  const under = lines.filter((l) => l.diff > 0);
  const underTotal = under.reduce((s, l) => s + l.diff, 0);
  const overTotal = lines.filter((l) => l.diff < 0).reduce((s, l) => s - l.diff, 0);
  console.log(`\nUNDERCHARGED (website below app): ${under.length} product(s), total ${R(underTotal)} per unit across them` +
    ` · overcharged: ${lines.length - under.length} product(s), total ${R(overTotal)}` +
    `\n(* = the product's variants disagree with each other; the first variant's price is shown)`);
  return { bad: lines, under, underTotal, overTotal };
}

const rows = await measure();
const mism = rows.filter((r) => r.fixes.length);
await Promise.all(mism.map(async (r) => { r.name = (await db.ref(`products/${r.pid}/name`).get()).val(); }));
await classify(mism);
const before = report(rows, "BEFORE");

if (!APPLY) process.exit(0);
if (!before.bad.length) { console.log("nothing to correct."); process.exit(0); }

const dir = join(homedir(), "marathon-rollbacks");
mkdirSync(dir, { recursive: true });
const file = join(dir, `shopify-price-drift-${new Date().toISOString().replace(/[:.]/g, "")}.json`);
writeFileSync(file, JSON.stringify({
  writtenAt: new Date().toISOString(),
  note: "Shopify variant prices BEFORE price-drift.mjs --apply. Restore: node scripts/shopify/price-drift.mjs --rollback <this file>",
  rows: before.bad.map((r) => ({ pid: r.pid, gid: r.gid, name: r.name, appRetail: r.want, appTrade: r.trade, pattern: r.pattern,
    before: r.variants.map((v) => ({ id: v.id, price: v.price })) })),
}, null, 2));
console.log(`\nrollback file written: ${file}`);

let fixed = 0, failed = 0;
for (const r of before.bad) {
  try {
    const res = await syncProductPrice(db, graphql, r.pid, { commit: true, source: "price-drift --apply", log: (l) => console.log(l) });
    if (res.changed) fixed++; else if (!res.ok) { failed++; console.error(`  ⚠ ${r.pid}: ${res.why}`); }
  } catch (e) { failed++; console.error(`  ⚠ ${r.pid}: ${String(e?.message || e)}`); }
}
console.log(`\napplied: ${fixed} product(s) corrected · ${failed} failed · log at /${PRICE_LOG_PATH}/{pid}`);

const afterRows = await measure();
const after = report(afterRows, "AFTER");
process.exit(after.bad.length ? 1 : 0);
