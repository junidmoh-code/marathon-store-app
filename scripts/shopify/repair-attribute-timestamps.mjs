// ── ONE-OFF REPAIR: the extractions written with `at: 0` ─────────────────────
// The first 205 v1 records and the first 199 v2 records went in stamped zero.
// Number(ServerValue.TIMESTAMP) is NaN — the Admin SDK sentinel is the OBJECT
// {".sv":"timestamp"} — and `at: Number(at) || 0` turned every one of them into
// a zero. Fixed at source in src/utils/productAttributes.js (serverStamp); this
// repairs what was already written.
//
//   node scripts/shopify/repair-attribute-timestamps.mjs           DRY RUN
//   node scripts/shopify/repair-attribute-timestamps.mjs --apply
//
// ── IT DOES NOT PRETEND TO KNOW WHEN THE EXTRACTION RAN ──────────────────────
// The real instant is gone; nothing recorded it. So the repair writes the
// REPAIR time and flags it `atRepaired: true`, and anything reading `at` can
// tell a measured timestamp from a reconstructed one. Backdating to a guessed
// run time would be a number that looks exactly like a measurement and is not.
//
// Re-runnable: a record with a non-zero `at` is out of scope, so a second run
// touches nothing. Costs nothing — no model call.
//
// WRITES: /product_attributes/{pid}/at and /atRepaired only.
import { createRequire } from "module";
import "./env.mjs";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { ATTRIBUTES_PATH } from "../../src/utils/productAttributes.js";
import { readMapPaged } from "../lib/rtdbPaged.mjs";

const APPLY = process.argv.includes("--apply");

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const rows = await readMapPaged(db, ATTRIBUTES_PATH, { pageSize: 500 });
const broken = Object.entries(rows).filter(([, n]) => n?.a && !(Number(n.at) > 0));
console.log(`${Object.keys(rows).length} extraction(s) · ${broken.length} carrying at:0`);
if (!broken.length) { console.log("nothing to repair."); process.exit(0); }
console.log(`  by version: ${Object.entries(broken.reduce((m, [, n]) => (m[n.v] = (m[n.v] || 0) + 1, m), {})).map(([k, v]) => `v${k}:${v}`).join(" · ")}`);

if (!APPLY) {
  console.log(`\nDRY RUN — nothing written. Re-run with --apply.`);
  process.exit(0);
}

const patch = {};
for (const [pid] of broken) {
  assertSafeSegment(pid, "productId");
  patch[`${pid}/at`] = admin.database.ServerValue.TIMESTAMP;
  patch[`${pid}/atRepaired`] = true;
}
const keys = Object.keys(patch);
const CHUNK = 400;
for (let i = 0; i < keys.length; i += CHUNK) {
  const slice = {};
  for (const k of keys.slice(i, i + CHUNK)) slice[k] = patch[k];
  await db.ref(ATTRIBUTES_PATH).update(slice);
  console.log(`  … ${Math.min(i + CHUNK, keys.length)}/${keys.length}`);
}
console.log(`\nrepaired ${broken.length} record(s), each flagged atRepaired:true — the repair time, not the extraction time.`);
process.exit(0);
