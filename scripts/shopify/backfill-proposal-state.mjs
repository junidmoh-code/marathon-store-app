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
// WRITES: /shopify_publish/{pid}/state = "awaiting", and ONLY on a node that
// CARRIES A PROPOSAL and still has no state ON THE SERVER at write time.
// "awaiting" is not a new claim about the product — it is what a stateless node
// already means to normalizedState() in the app, written down.
//
// Two deliberate narrowings, both reviewer findings:
//   · Only proposal-carrying nodes. A stateless node with no proposal has
//     nothing to review, and stamping it would drop it into the "Awaiting
//     review" filter as a product nobody ever nominated. (Measured today the
//     two sets are identical — every stateless node carries a proposal — but
//     the run must not depend on that staying true.)
//   · The absence is re-tested on the SERVER, in a transaction on the `state`
//     child, not against the paged snapshot this script opened with. The page
//     read takes a while and the reconciler runs every two minutes; a product
//     that went live in between must not be stamped back to "awaiting".
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
  console.log(`\nDRY RUN — nothing written. Re-run with --commit to stamp state:"awaiting" on the ${withProposal.length} proposal-carrying node(s).`);
  console.log(`(The ${withoutProposal.length} stateless node(s) with no proposal are deliberately NOT touched.)`);
  process.exit(0);
}

// One transaction per node on the `state` CHILD. Not a batched multi-path
// update: a batch would write the value decided at page-read time, and the
// whole point is that the decision must be made against the server value at
// write time. A transaction returning undefined aborts, so a node that gained
// a state in the meantime is left exactly as it is.
const CONCURRENCY = 12;
let done = 0, stamped = 0, skipped = 0;
let cursor = 0;
async function worker() {
  while (cursor < withProposal.length) {
    const [pid] = withProposal[cursor++];
    assertSafeSegment(pid, "productId");
    const res = await db.ref(`shopify_publish/${pid}/state`).transaction((cur) => (cur ? undefined : "awaiting"));
    if (res.committed) stamped += 1; else skipped += 1;
    done += 1;
    if (done % 100 === 0) console.log(`  ${done}/${withProposal.length} (stamped ${stamped}, already had a state ${skipped})`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`\nDone. ${stamped} node(s) stamped state:"awaiting"; ${skipped} already carried one and were left alone.`);
console.log(`${stamped} proposal(s) that were unreachable are now reviewable in the app.`);
process.exit(0);
