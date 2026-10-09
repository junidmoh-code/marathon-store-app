// ── BACKFILL THROUGH THE TRIGGER — every sneaker missing attributes or a profile
//
// Owner rule: automated or not at all. This script does NOT enrich anything
// itself. It stamps /products/{pid}/altRefreshAt with the server time on each
// sneaker that needs work, and that write wakes the alternativesProfile
// trigger — the SAME path a newly created product takes (vision when needed,
// the daily cap, the claim, the failure record, the profile).
//
//   node scripts/alternatives/backfill-alt-profiles.mjs            DRY RUN — counts only
//   node scripts/alternatives/backfill-alt-profiles.mjs --apply    stamp them, 20 at a time
//
// Reads /products and /product_attributes once, paged (an admin one-off, never
// a per-tap read). Writes one child per product and never onto a product that
// has disappeared since the read (shallow key check just before each batch).
import { createRequire } from "module";
import { readMapPaged, shallowKeys } from "../lib/rtdbPaged.mjs";
import { ATTRIBUTES_PATH, isCurrentExtraction } from "../../src/utils/productAttributes.js";
import { ALT_PROFILE_FIELD, decodeAltProfile } from "../../src/utils/altProfile.js";
import { productIsFootwear } from "../../src/utils/footwearLine.js";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";

const APPLY = process.argv.includes("--apply");
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const products = await readMapPaged(db, "products", { pageSize: 500 });
const attrs = await readMapPaged(db, ATTRIBUTES_PATH, { pageSize: 500 });

const inScope = (p) => p?.id && !p.mergedInto && productIsFootwear(p) && (p.productType || "sneaker") !== "clothing";
const todo = [];
let scope = 0, noAttrs = 0, noProfile = 0;
for (const [pid, p] of Object.entries(products)) {
  if (!inScope(p)) continue;
  scope += 1;
  const missingAttrs = !!String(p.photoUrl || "").trim() && !isCurrentExtraction(attrs[pid]);
  const missingProfile = !decodeAltProfile(p[ALT_PROFILE_FIELD]);
  if (missingAttrs) noAttrs += 1;
  if (missingProfile) noProfile += 1;
  if (missingAttrs || missingProfile) todo.push(pid);
}
console.log(`footwear in scope: ${scope} · missing attributes (vision will run): ${noAttrs} · missing profile: ${noProfile}`);
console.log(`to stamp: ${todo.length}`);
if (!APPLY) { console.log("DRY RUN — nothing written. Re-run with --apply."); process.exit(0); }

const BATCH = 20;
let stamped = 0, vanished = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const live = new Set(await shallowKeys(admin.app(), "products"));
  const patch = {};
  for (const pid of todo.slice(i, i + BATCH)) {
    assertSafeSegment(pid, "productId");
    if (!live.has(pid)) { vanished += 1; continue; }
    patch[`${pid}/altRefreshAt`] = admin.database.ServerValue.TIMESTAMP;
  }
  if (Object.keys(patch).length) await db.ref("products").update(patch);
  stamped += Object.keys(patch).length;
  console.log(`  … ${stamped}/${todo.length}`);
  // Let the triggers (and their vision calls) drain before the next batch.
  await new Promise((r) => setTimeout(r, 4000));
}
console.log(`stamped ${stamped}${vanished ? ` · ${vanished} deleted since the read, skipped` : ""}`);
process.exit(0);
