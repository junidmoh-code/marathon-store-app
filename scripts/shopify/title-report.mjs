// ── Flagged-title report over the live catalogue ─────────────────────────────
// READ-ONLY. Runs shopifyTitle over every /products name and prints the
// products whose rewrite trips a guard (empty / digit-leading / <3 chars after
// the brand strip) — the manual-naming worklist for the Shopify push. Nothing
// is written anywhere. A flagged count is NOT a failure (exit 0); only a
// credential/RTDB error exits non-zero.
//
//   node scripts/shopify/title-report.mjs            counts + first 40 rows
//   node scripts/shopify/title-report.mjs --all      every flagged row
import { createRequire } from "module";
import { shopifyTitle } from "./nameRewrite.mjs";

const ALL = process.argv.includes("--all");

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const products = (await admin.database().ref("products").get()).val() || {};

const flagged = [];
let named = 0;
for (const [pid, p] of Object.entries(products)) {
  if (!p?.name) continue; // record invisible to the app anyway (no inner name)
  named += 1;
  const t = shopifyTitle(p.name);
  if (t.flagged) flagged.push({ pid, name: String(p.name).trim(), reason: t.reason });
}

const byReason = {};
for (const f of flagged) byReason[f.reason] = (byReason[f.reason] || 0) + 1;

console.log(`named products scanned: ${named}`);
console.log(`flagged (original name ships, needs manual naming): ${flagged.length}`);
for (const [reason, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${reason}`);
}
console.log("");
const rows = ALL ? flagged : flagged.slice(0, 40);
for (const f of rows) console.log(`${f.pid}  [${f.reason}]  ${f.name}`);
if (!ALL && flagged.length > rows.length) {
  console.log(`… ${flagged.length - rows.length} more (--all to list)`);
}
process.exit(0);
