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
//
// ── THE SINGLE FORWARD WALK, AND WHY IT IS WORTH ITS 36 MB ─────────────────
//
// Days are built from key RANGES, and a key range can only find rows whose key
// is near their own timestamp. Two kinds of row are not:
//
//   · one written far later than the day it belongs to (a till offline for a
//     week), whose key is days above its day's padded range;
//   · one with no usable timestamp at all, which belongs to no day — and which
//     the Insights sidebar and the Customers list both still count today.
//
// Neither is reachable by any per-day read, so the backfill also walks the log
// once, forward, in bounded pages, and files those rows under
// /insights_rollup/late/. The same walk leaves the sweep's cursor at the end of
// the log, which is what the sweep needs to start following only what is new
// instead of rediscovering all of history on its first run.
//
// That walk is the one expensive thing here: ~35.99 MB, about $0.03, once.
// --skip-walk is for a re-run that only needs to finish building days.
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
  buildDay, saDateStringOf, saDateOf, shiftSaDate, isWithinDayRange,
  DAYS_PATH, INDEX_PATH, LATE_PATH, UNDATED_BUCKET, CURSOR_PATH, CATCHUP_PAGE,
} = localRequire("../functions/insightsRollup/builder.cjs");
const { makeIo } = localRequire("../functions/insightsRollup/io.cjs");

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const DRY = has("--dry-run");
const FORCE = has("--force");
const SKIP_WALK = has("--skip-walk");

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

/**
 * One forward walk of the whole log. Files the rows no per-day read can find,
 * and leaves the cursor at the end so the sweep follows only what is new.
 * Resumable in the same way everything else here is: it starts from whatever
 * cursor is already stored.
 */
async function forwardWalk() {
  let cursor = await io.readCursor();
  let seen = 0;
  let bytes = 0;
  let filed = 0;
  let pending = {};

  const flush = async () => {
    if (DRY || Object.keys(pending).length === 0) return;
    await io.commit({ updates: pending });
    pending = {};
  };

  for (;;) {
    const page = await io.readPageAfter(cursor, CATCHUP_PAGE);
    if (!page || page.length === 0) break;
    for (const r of page) {
      if (!r || !r.key) continue;
      seen += 1;
      bytes += JSON.stringify(r.value ?? null).length;
      const d = r.value ? saDateOf(r.value.timestamp) : "";
      if (!d || !isWithinDayRange(r.key, d)) {
        pending[`${LATE_PATH}/${d || UNDATED_BUCKET}/${r.key}`] = r.value;
        filed += 1;
      }
      cursor = r.key;
    }
    // The cursor advances only with the rows it justified, in one update.
    pending[CURSOR_PATH] = cursor;
    await flush();
    process.stdout.write(`\r  walked ${seen} rows, ${(bytes / 1024 / 1024).toFixed(1)} MB, ${filed} filed…    `);
    if (page.length < CATCHUP_PAGE) break;
  }
  console.log("");
  return { seen, bytes, filed, cursor };
}

async function main() {
  const todaySA = saDateStringOf(Date.now());
  const from = val("--from") || (await firstDate());
  const to = val("--to") || shiftSaDate(todaySA, -1);

  if (!from) { console.log("insights_log is empty — nothing to build."); return; }
  if (from > to) { console.log(`nothing to do: ${from} is after ${to}`); return; }

  if (!SKIP_WALK) {
    console.log("▸ forward walk (once): seeding the cursor, filing rows no day read can find");
    const w = await forwardWalk();
    console.log(`  ${w.seen} rows, ${(w.bytes / 1024 / 1024).toFixed(2)} MB read, ${w.filed} filed under /${LATE_PATH}`);
    console.log(`  cursor -> ${w.cursor}`);
    console.log("");
  }

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
        [`${INDEX_PATH}/${date}`]: built.counts,
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
