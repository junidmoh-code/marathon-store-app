// ── One-time: give every proposal-only node the `state` it was written without ─
//
// scripts/shopify/vision-name.mjs used to write /shopify_publish/{pid} with a
// single child — nameProposal — and nothing else. Two consequences, both of
// which made the proposal unusable rather than merely untidy:
//
//   1. INVISIBLE. Every read the review page makes is a server-filtered query
//      on the one index that exists (.indexOn ["state"]). A node with no state
//      matches no query, so its proposal could never appear in the app.
//   2. UNWRITABLE. The live rule on /shopify_publish/$pid is
//        ".validate": "!newData.exists() || (newData.hasChildren(['state']) && …)"
//      so even if the page HAD found it, approving the name would have been
//      refused by the database.
//
// Measured on 2026-08-19: 1,402 nodes, 560 of them holding nothing but a
// nameProposal. The runner now supplies the state itself; this closes the ones
// already written.
//
//   node scripts/shopify/backfill-proposal-state.mjs            dry run
//   node scripts/shopify/backfill-proposal-state.mjs --commit   writes
//
// WRITES: /shopify_publish/{pid}/state = "awaiting", and ONLY where the node
// has no state at all. "awaiting" is not a new claim about the product — it is
// what a stateless node already means to normalizedState() in the app, written
// down. A node that carries any state is never touched, so a live product
// cannot be moved out of the pipeline by this.
import { createRequire } from "module";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { readMapPaged } from "../lib/rtdbPaged.mjs";

const COMMIT = process.argv.includes("--commit");
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const publish = await readMapPaged(db, "shopify_publish", { pageSize: 400 });
const entries = Object.entries(publish);
const stateless = entries.filter(([, n]) => n && typeof n === "object" && !n.state);
const withProposal = stateless.filter(([, n]) => n.nameProposal);
const withoutProposal = stateless.filter(([, n]) => !n.nameProposal);

console.log(`/shopify_publish nodes            : ${entries.length}`);
console.log(`  with no state                   : ${stateless.length}`);
console.log(`    carrying a name proposal      : ${withProposal.length}   ← these become reviewable`);
console.log(`    carrying no proposal          : ${withoutProposal.length}`);

if (!COMMIT) {
  console.log(`\nDRY RUN — nothing written. Re-run with --commit to stamp state:"awaiting" on ${stateless.length} node(s).`);
  process.exit(0);
}

// Batched multi-path updates. Each key is a per-node CHILD path, so this can
// never clobber a sibling field written between the read and the write.
const BATCH = 200;
let done = 0;
for (let i = 0; i < stateless.length; i += BATCH) {
  const slice = stateless.slice(i, i + BATCH);
  const updates = {};
  for (const [pid] of slice) {
    assertSafeSegment(pid, "productId");
    updates[`${pid}/state`] = "awaiting";
  }
  await db.ref("shopify_publish").update(updates);
  done += slice.length;
  console.log(`  stamped ${done}/${stateless.length}`);
}
console.log(`\nDone. ${done} node(s) now carry state:"awaiting" — ${withProposal.length} proposal(s) are reachable in the app.`);
process.exit(0);
