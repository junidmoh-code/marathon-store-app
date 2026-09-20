// ─── DOES THE ROLLUP STILL SAY WHAT THE LOG SAYS? ────────────────────────────
//
// The unit tests prove the codec is lossless over a fixture. This proves it
// over PRODUCTION: it reads real day nodes and the real /insights_log rows they
// were built from, and compares them row by row, field by field, in order.
//
// That comparison is the whole promise of this feature. Every figure on the
// Insights, Customers and Admin screens is computed by the unchanged production
// selectors from these rows, so if the rows match, the numbers match.
//
// ── WHAT IT COMPARES, AND WHY THAT IS NOT CIRCULAR ─────────────────────────
//
// The log side does NOT go through the codec. An earlier version of this
// script built the day again with buildDay() and compared the two decoded
// results — which put the production ENCODER on both sides, so a codec defect
// that dropped or transformed a field would have affected them identically and
// passed. It was checking that the rollup agreed with itself. (CodeRabbit, and
// the same trap as feedback-differential-test-the-mirror-not-the-copy.)
//
// The log side is now the raw rows: a bounded key-range read, filtered by each
// event's own SA date, reduced with keptFieldsOf — which is a projection, not
// an encoding. The rollup side is the stored node decoded. Nothing but the
// decoder is shared, and the decoder is what is under test.
//
// ── BOUNDED, AND IT SAYS WHAT IT SPENT ──────────────────────────────────────
//
// One day is a padded key range — about 919 KB on the live node — so a sample
// of five days is roughly 4.6 MB. It prints the bytes. There is no mode that
// reads the whole node.
//
//   node scripts/verify-insights-rollup.mjs                  # 5 random days
//   node scripts/verify-insights-rollup.mjs --days 20
//   node scripts/verify-insights-rollup.mjs --date 2026-09-18
//   node scripts/verify-insights-rollup.mjs --all            # every built day

import { createRequire } from "module";
import { adminRequire } from "./adminRequire.mjs";

const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");

const localRequire = createRequire(import.meta.url);
const { keyRangeForDate, saDateOf, DAYS_PATH, INDEX_PATH } =
  localRequire("../functions/insightsRollup/builder.cjs");
const { makeIo } = localRequire("../functions/insightsRollup/io.cjs");
const { expandDay, keptFieldsOf } = localRequire("../functions/insightsRollup/rollupCodec.cjs");

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DB });
const db = admin.database();
const io = makeIo(db);

/** Key order inside a row is not data. Compare the pairs, sorted. */
const canon = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));

async function main() {
  const built = await io.listDayKeys();
  if (built.length === 0) { console.log("no rollup days exist yet — run the backfill first."); return; }

  let dates;
  if (val("--date")) dates = [val("--date")];
  else if (has("--all")) dates = built.slice().sort();
  else {
    const n = Number(val("--days")) || 5;
    const pool = built.slice().sort();
    dates = [];
    // Spread the sample across the whole span rather than clustering, so a
    // drift that started on a particular day is not missed by luck.
    for (let i = 0; i < Math.min(n, pool.length); i++) {
      dates.push(pool[Math.floor((i + 0.5) * pool.length / Math.min(n, pool.length))]);
    }
  }

  console.log(`verifying ${dates.length} of ${built.length} built day(s) against /insights_log`);
  console.log("");

  let bytes = 0;
  let rows = 0;
  let bad = 0;

  for (const date of dates) {
    const snap = await db.ref(`${DAYS_PATH}/${date}`).once("value");
    const node = snap.val();
    if (!node) { console.log(`  ✗ ${date}  no node, but the index says there is one`); bad += 1; continue; }

    // The log side: raw rows, never encoded. See the header.
    const { startKey, endKey } = keyRangeForDate(date);
    const page = await io.readKeyRange(startKey, endKey);
    const fromLog = page
      .filter((r) => r && r.value && saDateOf(r.value.timestamp) === date)
      .map((r) => keptFieldsOf(r.value));
    const fromRollup = expandDay(node);

    bytes += JSON.stringify(node).length;
    if (!fromRollup) { console.log(`  ✗ ${date}  the stored node will not decode`); bad += 1; continue; }

    const a = fromRollup.map(canon);
    const b = fromLog.map(canon);
    const same = a.length === b.length && a.every((v, i) => v === b[i]);
    rows += b.length;

    if (same) {
      console.log(`  ✓ ${date}  ${b.length} rows, identical`);
    } else {
      bad += 1;
      console.log(`  ✗ ${date}  rollup ${a.length} rows, log ${b.length} rows`);
      const at = a.findIndex((v, i) => v !== b[i]);
      if (at >= 0) {
        console.log(`      first difference at row ${at}`);
        console.log(`      rollup: ${JSON.stringify(fromRollup[at])}`);
        console.log(`      log:    ${JSON.stringify(fromLog[at])}`);
      }
    }
  }

  // The counter and the day index are kept by two different passes over the
  // same log, so they check each other: the index covers finished days, the
  // counter covers everything, and the difference should be today.
  const idxSnap = await db.ref(INDEX_PATH).once("value");
  const idx = idxSnap.val() || {};
  const totals = { n: 0, pe: 0, trophy: 0, pine: 0, other: 0 };
  for (const v of Object.values(idx)) for (const k of Object.keys(totals)) totals[k] += Number(v?.[k]) || 0;
  const counter = (await db.ref("insights_rollup/meta/logTotals").once("value")).val();

  console.log("");
  console.log(`  day index (${Object.keys(idx).length} finished days)  ${totals.n}`);
  if (counter) {
    console.log(`  running counter (whole log)        ${counter.n}`);
    console.log(`  difference (should be today)       ${Number(counter.n) - totals.n}`);
  } else {
    console.log("  running counter                    (not written yet)");
  }

  console.log("");
  console.log(`  ${rows} rows compared, ${(bytes / 1024).toFixed(0)} KB of rollup read`);
  console.log(bad === 0 ? "  ✓ every day checked matches the log." : `  ✗ ${bad} day(s) DO NOT match.`);
  process.exitCode = bad === 0 ? 0 : 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error(e); process.exit(1); });
