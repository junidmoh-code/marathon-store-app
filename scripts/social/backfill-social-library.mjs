// ── PUT EVERY PICTURE ALREADY MADE INTO THE ALBUM ────────────────────────────
// From today the generator writes an album entry as it writes the post, in the
// same atomic update. This script is for everything made BEFORE that: it walks
// /social_posts and archives every picture it finds.
//
// It is safe to run repeatedly. Entries are keyed by post id, so a second run
// rewrites the same keys with the same values rather than making duplicates,
// and it is DRY by default — it prints what it would archive and changes
// nothing until you pass --commit.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
// It does not delete. Not orphans, not entries whose post has since been
// removed from the queue, not anything. The album's one promise is that a
// picture put into it stays there, and a backfill that can remove things is a
// backfill that can break that promise on a bad day.
//
//   node scripts/social/backfill-social-library.mjs            # dry run
//   node scripts/social/backfill-social-library.mjs --commit
import { createRequire } from "module";
import { buildLibraryEntry, LIBRARY_PATH, isOutfitEntry } from "../../functions/lib/social-library.cjs";

// firebase-admin lives in functions/, not at the repo root — resolve from there,
// the same way publish.mjs does.
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { TWIN_ROLE } = require("./lib/social-twin.cjs");

const COMMIT = process.argv.includes("--commit");
const CHUNK = 200;                       // keep any one update() small enough to retry

admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const posts = (await db.ref("social_posts").get()).val() || {};
const existing = (await db.ref(LIBRARY_PATH).get()).val() || {};

const updates = {};
const stats = { posts: 0, twins: 0, noImage: 0, already: 0, queued: 0, outfits: 0 };

for (const [postId, record] of Object.entries(posts)) {
  stats.posts++;
  // A twin shares its story's picture. Archiving it would put the same image
  // in the album twice — the identical reason the live path skips it.
  if (record && record.twinRole === TWIN_ROLE) { stats.twins++; continue; }
  const entry = buildLibraryEntry(postId, record, { isTwin: false });
  if (!entry) { stats.noImage++; continue; }
  if (existing[postId]) { stats.already++; continue; }
  updates[`${LIBRARY_PATH}/${postId}`] = entry;
  stats.queued++;
  if (isOutfitEntry(entry)) stats.outfits++;
}

console.log(`queue records read        ${stats.posts}`);
console.log(`  feed twins skipped      ${stats.twins}   (share a picture already archived)`);
console.log(`  no usable picture       ${stats.noImage}  (video, or media missing)`);
console.log(`  already in the album    ${stats.already}`);
console.log(`  TO ARCHIVE              ${stats.queued}   of which outfits (2+ products): ${stats.outfits}`);

if (!stats.queued) { console.log("\nnothing to do."); process.exit(0); }
if (!COMMIT) {
  const sample = Object.entries(updates).slice(0, 5);
  console.log("\nsample of what would be written:");
  for (const [path, e] of sample) {
    console.log(`  ${path}  ${e.kind.padEnd(12)} ${String(e.products.length).padStart(2)} product(s)  ${e.media[0].url.slice(0, 72)}…`);
  }
  console.log("\nDRY RUN — nothing written. Re-run with --commit to archive.");
  process.exit(0);
}

const keys = Object.keys(updates);
for (let i = 0; i < keys.length; i += CHUNK) {
  const slice = {};
  for (const k of keys.slice(i, i + CHUNK)) slice[k] = updates[k];
  await db.ref().update(slice);
  console.log(`archived ${Math.min(i + CHUNK, keys.length)}/${keys.length}`);
}
console.log(`\ndone — ${keys.length} picture(s) archived into /${LIBRARY_PATH}.`);
process.exit(0);
