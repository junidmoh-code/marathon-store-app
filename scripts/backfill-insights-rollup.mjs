// ─── ONE-OFF BACKFILL: EVERY FINISHED DAY OF /insights_log ───────────────────
//
// The scheduled sweep (functions:insightsRollupSweep) keeps the last fortnight
// healthy. History is this script's job: one pass over the whole log, one node
// per SA day, so the all-time screens have something to read.
//
// ── IT IS RESUMABLE, AND THAT IS NOT A CONVENIENCE ─────────────────────────
//
// The log spans about 140 days and 35.99 MB. A pass that has to start over
// because a laptop slept is a pass nobody finishes. So progress is the DATA:
// after each day is written, /insights_rollup/meta/built/{date} exists, and a
// re-run skips every date that already has an entry. Kill it and run it again
// and it continues.
//
// ── AND IDEMPOTENT ─────────────────────────────────────────────────────────
//
// A day node is a pure function of that day's events (see
// functions/insightsRollup/builder.cjs), so rebuilding a day writes the same
// bytes. --force rebuilds days that already exist, which is what to reach for
// after a codec change; without it, existing days are left alone.
//
// ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
//
// It never writes to /insights_log. It never deletes anything. It does not
// build TODAY — today is still being written to and the screens read it live.
// It does not move the sweep's cursor: the cursor is the sweep's high-water
// mark over what is NEW, and history is not new.
//
//   node scripts/backfill-insights-rollup.mjs --dry-run
//   node scripts/backfill-insights-rollup.mjs
//   node scripts/backfill-insights-rollup.mjs --from 2026-05-01 --to 2026-06-30
//   node scripts/backfill-insights-rollup.mjs --force

import { createRequire } from "module";
import { adminRequire } from "./adminRequire.mjs";

const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");

const localRequire = createRequire(import.meta.url);
const {
  buildDay, saDateStringOf, shiftSaDate, DAYS_PATH, INDEX_PATH,
} = localRequire("../functions/insightsRollup/builder.cjs");
const { makeIo } = localRequire("../functions/insightsRollup/io.cjs");

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const DRY = has("--dry-run");
const FORCE = has("--force");

admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DB });
const db = admin.database();
const io = makeIo(db);

/** The first SA date the log holds — read from the single oldest key, not from
 *  a scan of the node. */
async function firstDate() {
  const snap = await db.ref("insights_log").orderByKey().limitToFirst(1).once("value");
  let iso = null;
  snap.forEach((c) => { iso = c.val()?.timestamp ?? null; });
  if (!iso) return null;
  return saDateStringOf(Date.parse(iso));
}

async function main() {
  const todaySA = saDateStringOf(Date.now());
  const from = val("--from") || (await firstDate());
  const to = val("--to") || shiftSaDate(todaySA, -1);

  if (!from) { console.log("insights_log is empty — nothing to build."); return; }
  if (from > to) { console.log(`nothing to do: ${from} is after ${to}`); return; }

  const already = new Set(await io.listDayKeys());

  const dates = [];
  for (let d = from; d <= to; d = shiftSaDate(d, 1)) {
    if (d >= todaySA) break;               // today is never built
    if (!FORCE && already.has(d)) continue;
    dates.push(d);
  }

  console.log(`insights rollup backfill`);
  console.log(`  span       ${from} … ${to}   (today ${todaySA}, never built)`);
  console.log(`  already    ${already.size} day(s) have a node`);
  console.log(`  to build   ${dates.length} day(s)${FORCE ? " (--force: rebuilding existing days too)" : ""}`);
  if (DRY) { console.log("  DRY RUN — nothing written."); return; }
  if (dates.length === 0) return;

  let rows = 0;
  let bytes = 0;
  let done = 0;
  for (const date of dates) {
    const built = await buildDay(io, date);
    const json = JSON.stringify(built.node);
    bytes += json.length;
    rows += built.rows;
    // One day per commit, WITH its index entry. Progress is therefore the data
    // itself: whatever has landed is skipped on a re-run.
    await io.commit({
      updates: {
        [built.path]: built.node,
        [`${INDEX_PATH}/${date}`]: built.rows,
      },
    });
    done += 1;
    if (done % 10 === 0 || done === dates.length) {
      console.log(`  ${done}/${dates.length}  ${date}  ${rows} rows  ${(bytes / 1024).toFixed(0)} KB written`);
    }
  }

  const days = dates.length;
  console.log("");
  console.log(`  built      ${days} day(s), ${rows} rows`);
  console.log(`  size       ${(bytes / 1024 / 1024).toFixed(2)} MB of rollup`);
  console.log(`  per day    ${(bytes / days / 1024).toFixed(1)} KB average`);
  console.log(`  growth     ${(rows / days).toFixed(0)} rows/day -> ~${(bytes / days / 1024).toFixed(1)} KB/day`);
  console.log(`  path       /${DAYS_PATH}/{date}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
