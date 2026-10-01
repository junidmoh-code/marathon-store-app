// ─── RUN THE ROLLUP SWEEP BY HAND ────────────────────────────────────────────
//
// The same `runSweep` the scheduled function calls, with the same io, against
// the real database. Two uses:
//
//   1. catching up after an outage without waiting for the next schedule;
//   2. PROVING the sweep works before trusting the schedule with it — in
//      particular that the cursor advance commits, which is a transaction and
//      therefore the one thing in this feature that a unit test can be made to
//      pass while the real thing silently refuses. (It did: see
//      functions/test/insights-rollup-io.test.cjs.)
//
// It writes only under /insights_rollup. It never touches /insights_log.
//
//   node scripts/run-insights-rollup-sweep.mjs

import { createRequire } from "module";
import { adminRequire } from "./adminRequire.mjs";

const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");

const localRequire = createRequire(import.meta.url);
const { runSweep } = localRequire("../functions/insightsRollup/builder.cjs");
const { makeIo } = localRequire("../functions/insightsRollup/io.cjs");

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DB });
const db = admin.database();

async function main() {
  const before = (await db.ref("insights_rollup/meta").once("value")).val() || {};
  console.log(`cursor before : ${before.cursor || "(none)"}`);
  console.log(`counter before: ${before.logTotals ? before.logTotals.n : "(none)"}`);
  console.log("");

  const res = await runSweep({ io: makeIo(db), nowMs: Date.now(), log: (m) => console.log(m) });

  const after = (await db.ref("insights_rollup/meta").once("value")).val() || {};
  console.log("");
  console.log(`built         : ${res.dates.length} day(s), ${res.rows} rows`);
  if (res.late) console.log(`late filed    : ${res.late}`);
  if (res.truncated) console.log("catch-up      : TRUNCATED — run again");
  console.log(`cursor after  : ${after.cursor || "(none)"}`);
  console.log(`counter after : ${after.logTotals ? after.logTotals.n : "(none)"}`);
  console.log(`advanced      : ${res.advanced}`);

  // The whole point of running this by hand: a cursor advance that silently
  // refuses looks exactly like a quiet day.
  if (!res.advanced) {
    console.log("");
    console.log("✗ THE CURSOR DID NOT ADVANCE. Either something else moved it while this");
    console.log("  ran, or the transaction is refusing. The day nodes still landed — they");
    console.log("  are recomputations — but the counter did not, and it will not until");
    console.log("  this succeeds.");
    process.exitCode = 1;
  }
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error(e); process.exit(1); });
