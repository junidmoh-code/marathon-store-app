// ─── CENSUS: what does the 4-unit review floor hide? ─────────────────────────
//
//   node scripts/shopify/review-hidden-census.mjs [--min N] [--json <file>]
//
// READ-ONLY. Answers, for every product /config/shopifyReviewHidden holds
// (reviewStock.mjs REVIEW_MIN_UNITS — the Awaiting-review floor): how many
// online units it has (networkTotals, the pusher's own sum, at the locations
// the website sells from), what those units are worth at retailPrice, and
// whether it is otherwise publishable today — photo, price > 0, sizes,
// condition grade, and a name the publisher would accept (the auto-publish
// agent's own readiness()). `--min N` reports what a different floor would
// bring back.
//
// READS: shallow keys of the hidden node, then per pid /products/{pid},
// /shopify_publish/{pid} and one /stock cell set per counted location — point
// reads only.
import { createRequire } from "module";
import { writeFileSync } from "fs";
import { networkTotals } from "./inventory.mjs";
import { locationNames } from "./inventorySync.mjs";
import { HIDDEN_PATH, REVIEW_MIN_UNITS } from "./reviewStock.mjs";
import { readiness } from "./autoPublish.mjs";
import { CONDITIONS } from "../../src/components/shopify/publishShared.js";
import { effectivePhotoList } from "../../src/components/shopify/shopifyPublishCore.js";
import { shallowKeys } from "../lib/rtdbPaged.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const flags = process.argv.slice(2);
const MIN = flags.includes("--min") ? Number(flags[flags.indexOf("--min") + 1]) : 1;
const JSON_OUT = flags.includes("--json") ? flags[flags.indexOf("--json") + 1] : null;
let bytes = 0;
const get = async (p) => { const v = (await db.ref(p).get()).val(); bytes += Buffer.byteLength(JSON.stringify(v ?? null)); return v; };

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i]); }
  }));
}

const pids = await shallowKeys(admin.app(), HIDDEN_PATH);
const locs = await locationNames(db);
const rows = [];
await pool(pids, 16, async (pid) => {
  const [product, node, ...cells] = await Promise.all([get(`products/${pid}`), get(`shopify_publish/${pid}`), ...locs.map((l) => get(`stock/${l}/${pid}`))]);
  const sizes = Array.isArray(product?.sizes) ? product.sizes : [];
  const tree = {};
  locs.forEach((l, i) => { if (cells[i]) tree[l] = { [pid]: cells[i] }; });
  const units = Object.values(networkTotals(tree, pid, sizes)).reduce((a, q) => a + q, 0);
  const price = Number(product?.retailPrice) || 0;
  const ready = product ? readiness(product, node) : { ready: false, why: "no product" };
  const checks = {
    photo: (effectivePhotoList(product || {}, node)?.photos?.length || 0) > 0,
    priceOk: price > 0,
    sizes: sizes.length > 0,
    grade: CONDITIONS.includes(node?.condition),
    nameOk: ready.ready || !/name/.test(ready.why || ""),
  };
  rows.push({ pid, name: product?.name ?? null, units, price, value: units * price, ...checks, readyWhy: ready.ready ? null : ready.why });
});

const sum = (rs, f) => rs.reduce((a, r) => a + f(r), 0);
const band = (lo, hi) => rows.filter((r) => r.units >= lo && r.units <= hi);
const publishable = (r) => r.photo && r.priceOk && r.sizes && r.nameOk;
console.log(`hidden by the ${REVIEW_MIN_UNITS}-unit floor: ${rows.length} product(s)`);
for (const [label, rs] of [["0 units online", band(0, 0)], ["1 unit", band(1, 1)], ["2 units", band(2, 2)], ["3 units", band(3, 3)], [`${REVIEW_MIN_UNITS}+ (stale entry)`, band(REVIEW_MIN_UNITS, Infinity)]]) {
  console.log(`  ${label.padEnd(18)} ${String(rs.length).padStart(5)} product(s) · ${String(sum(rs, (r) => r.units)).padStart(5)} unit(s) · R${sum(rs, (r) => r.value).toLocaleString("en-ZA")} retail · ${rs.filter(publishable).length} otherwise publishable (${rs.filter((r) => publishable(r) && r.grade).length} already graded)`);
}
const withStock = rows.filter((r) => r.units >= MIN);
console.log(`\nwith ≥${MIN} unit(s): ${withStock.length} product(s), ${sum(withStock, (r) => r.units)} unit(s), R${sum(withStock, (r) => r.value).toLocaleString("en-ZA")} retail`);
console.log(`  photo ${withStock.filter((r) => r.photo).length} · price ${withStock.filter((r) => r.priceOk).length} · sizes ${withStock.filter((r) => r.sizes).length} · grade ${withStock.filter((r) => r.grade).length} · acceptable name ${withStock.filter((r) => r.nameOk).length}`);
console.log(`  otherwise publishable (photo+price+sizes+name): ${withStock.filter(publishable).length}; of those already graded: ${withStock.filter((r) => publishable(r) && r.grade).length}`);
console.log(`rtdb read: ${bytes.toLocaleString()} B`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(rows, null, 1));
process.exit(0);
