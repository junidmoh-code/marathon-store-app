// ── Create / reconcile the storefront collections ────────────────────────────
// Owner-run. Reads scripts/shopify/collectionMap.mjs and makes Shopify agree
// with it. Idempotent: a re-run reconciles drift and never creates a duplicate.
//
//   node scripts/shopify/ensure-collections.mjs             dry run (default)
//   node scripts/shopify/ensure-collections.mjs --commit     apply
//
// RTDB writes: /shopify_sync/_collections ONLY (the collection ids), Admin SDK.
// Shopify writes: collectionCreate / collectionUpdate / publishablePublish on
// the Online Store channel. It never touches a product, never touches
// membership, and never touches /products or /stock.
//
// Every collection's title, handle, description and SEO fields run through the
// brand-trigger validator BEFORE any mutation — and the run refuses WHOLE if
// any one of them fails, because a half-built navigation is worse than none.
import { createRequire } from "module";
import { graphql } from "./client.mjs";
import { COLLECTIONS } from "./collectionMap.mjs";
import { ensureAllCollections } from "./collections.mjs";

const COMMIT = process.argv.slice(2).includes("--commit");

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

console.log(`${COLLECTIONS.length} collections in the map ` +
  `(${COLLECTIONS.filter((c) => c.kind === "manual").length} manual, ` +
  `${COLLECTIONS.filter((c) => c.kind === "smart").length} smart)`);
console.log(COMMIT ? "MODE: commit\n" : "MODE: dry run — nothing written\n");

let results;
try {
  results = await ensureAllCollections(graphql, db, { commit: COMMIT });
} catch (e) {
  console.error(`🛑 ${String(e?.message || e)}`);
  process.exit(1);
}

console.log("key             kind    action         handle");
for (const r of results) {
  const spec = COLLECTIONS.find((c) => c.key === r.key);
  const icon = r.action === "failed" ? "✗" : "✓";
  console.log(`${icon} ${r.key.padEnd(14)} ${spec.kind.padEnd(7)} ${r.action.padEnd(14)} ${r.handle}`);
  for (const n of r.notes) console.log(`    · ${n}`);
}

const failed = results.filter((r) => r.action === "failed");
console.log("\n══ COLLECTIONS REPORT ══");
for (const a of ["created", "updated", "noop", "would-create", "would-update", "failed"]) {
  const n = results.filter((r) => r.action === a).length;
  if (n) console.log(`  ${a}: ${n}`);
}
if (!COMMIT) console.log("\ndry run — Shopify and RTDB untouched. Re-run with --commit to apply.");
process.exit(failed.length ? 1 : 0);
