// ── Seed /product_identity from what the catalogue already knows ─────────────
// The searchable identity of a product is its brand-first name — "Lacoste
// Gripshot Lace Boot White Navy". Today that lives in `/products/{pid}.name`
// and nowhere else, and `name` is about to be rewritten by the vision namer.
// This copies it somewhere renaming cannot reach, ONCE, before that happens.
//
//   node scripts/backfill-search-identity.mjs                 dry run
//   node scripts/backfill-search-identity.mjs --commit        write it
//   node scripts/backfill-search-identity.mjs --commit --live-only
//
// SOURCE "record": this is supplier data — the name the product was received
// under, typed off the box by staff. It outranks anything a model later reads
// off a photo, which is the whole point of the ranking (searchIdentity.js).
//
// NEVER OVERWRITES. shouldReplaceIdentity decides every write, so re-running is
// free and a manual correction made in between survives. A product whose
// identity is already recorded is left exactly as it is.
//
// WRITES: /product_identity ONLY. Never /products, never /shopify_publish,
// never Shopify. Nothing is renamed by this script — it only remembers.
import { createRequire } from "module";
import { assertSafeSegment } from "../src/utils/sizeKey.js";
import { isPriceRecord } from "../src/utils/productCategory.js";
import {
  SEARCH_IDENTITY_PATH, buildRecordIdentity, shouldReplaceIdentity,
} from "../src/utils/searchIdentity.js";
import { readMapPaged } from "./lib/rtdbPaged.mjs";

const flags = process.argv.slice(2);
const COMMIT = flags.includes("--commit");
const LIVE_ONLY = flags.includes("--live-only");

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// Paged, not a single whole-node read: /products is 4,000+ records and this
// project has a bandwidth-cost incident on record.
const products = await readMapPaged(db, "products", { pageSize: 500 });
const existing = (await db.ref(SEARCH_IDENTITY_PATH).get()).val() || {};
const publish = (await db.ref("shopify_publish").get()).val() || {};
const confirmedOn = (n) => n?.state === "live" && n?.liveState === "on";

const now = Date.now();
const updates = {};
let seeded = 0, kept = 0, skippedPrice = 0, skippedBlank = 0, total = 0;

for (const [pid, p] of Object.entries(products)) {
  if (!p || typeof p !== "object" || !p.id) continue;
  if (p.mergedInto) continue;
  if (LIVE_ONLY && !confirmedOn(publish[pid])) continue;
  total += 1;
  // Not merchandise: it will never be searched for, and giving it an identity
  // would only widen what the index has to exclude.
  if (isPriceRecord(p)) { skippedPrice += 1; continue; }
  const incoming = buildRecordIdentity(p, { at: now, by: "script:backfill-search-identity" });
  if (!incoming) { skippedBlank += 1; continue; }
  if (!shouldReplaceIdentity(existing[pid], incoming)) { kept += 1; continue; }
  assertSafeSegment(pid, "productId");
  updates[`${SEARCH_IDENTITY_PATH}/${pid}`] = incoming;
  seeded += 1;
}

console.log(`${total} products in scope${LIVE_ONLY ? " (live only)" : ""}`);
console.log(`  to seed                      : ${seeded}`);
console.log(`  already have identity (kept) : ${kept}`);
console.log(`  price records (skipped)      : ${skippedPrice}`);
console.log(`  no name to seed from         : ${skippedBlank}`);

if (!COMMIT) {
  const sample = Object.entries(updates).slice(0, 5);
  console.log("\nsample:");
  for (const [path, v] of sample) console.log(`  ${path} ← ${JSON.stringify(v.text)}${v.brand ? ` (brand ${JSON.stringify(v.brand)})` : ""}`);
  console.log("\ndry run — nothing written. Re-run with --commit.");
  process.exit(0);
}

// Chunked multi-path update: one whole-tree write of 4,000 records is a single
// enormous payload, and a failure halfway through would leave no record of how
// far it got. Chunks are individually atomic and individually resumable.
const entries = Object.entries(updates);
const CHUNK = 400;
for (let i = 0; i < entries.length; i += CHUNK) {
  await db.ref().update(Object.fromEntries(entries.slice(i, i + CHUNK)));
  console.log(`  written ${Math.min(i + CHUNK, entries.length)}/${entries.length}`);
}
console.log(`seeded ${seeded} identities`);
process.exit(0);
