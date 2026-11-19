#!/usr/bin/env node
// ─── NEW ARRIVALS — BACKFILL THE NEW TAB (run once; safe to run again) ───────
// Puts into New every uploaded product that is NOT in the queue yet, has stock
// above zero at a counted location, and was created after a starting point:
//   default  the newest product already in the queue (any lane), i.e. "since
//            the last item that reached the card"
//   --since=2026-10-02  or  --since=p1790…   any earlier point (a gap sweep)
//
//   node scripts/newArrivals/backfillNew.mjs --dry-run     count only, write nothing
//   node scripts/newArrivals/backfillNew.mjs               add them
//
// IDEMPOTENT: a product already queued (any status, Done and Skipped included)
// is never touched. The item is written by a transaction that only creates
// (cur ? abort : item), exactly as the upload trigger does, then its index entry.
// A second run adds nothing.
//
// READS: the queue indexes (keys; limitToLast(1) for the start), the products
// AFTER the start by key in pages of 200 (orderByKey().startAfter().limitToFirst()),
// and per candidate the scalar items/{pid}/status plus stock/{loc}/{pid}.
// Never a whole node.
// WRITES: new_arrivals/items/{pid} (create only), by_status/new/{pid}, and a
// run record at new_arrivals/backfills/{runId} with what was added.
//
// Credentials: Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS).
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const core = require("../../functions/newArrivals/core.cjs");
const { ONLINE_EXCLUDED_LOCATIONS } = require("../../functions/lib/social-select.cjs");

const PAGE = 200;
const val = async (db, p) => (await db.ref(p).once("value")).val();

/** The start key from --since (a date or a pid), or null. Pure. */
export function sinceKey(arg) {
  if (!arg) return null;
  if (core.PID_RE.test(arg)) return arg;
  const ms = Date.parse(arg);
  return Number.isFinite(ms) ? `p${ms}` : null;
}

/** Why a product is not a backfill candidate (or null). The upload marker is NOT required: this is for what the trigger never saw. Pure. */
export function notCandidate(pid, product) {
  if (!core.PID_RE.test(String(pid))) return "not an uploaded product id";
  if (!product || typeof product !== "object") return "no record";
  if (product.mergedInto) return "merged record";
  if (product.category === "Price Products") return "price record";
  return null;
}

async function newestQueued(db) {
  let best = null;
  for (const s of core.STATUSES) {
    const k = Object.keys((await db.ref(`${core.BY_STATUS}/${s}`).orderByKey().limitToLast(1).once("value")).val() || {})[0];
    if (k && (!best || core.keyCmp(k, best) > 0)) best = k;
  }
  return best;
}

export async function run(db, { since = null, dryRun = false, nowMs = Date.now(), log = () => {} } = {}) {
  const start = since || await newestQueued(db);
  if (!start) throw new Error("no starting point: the queue is empty and no --since was given");
  const locations = Object.keys((await db.ref("locations").orderByKey().limitToFirst(100).once("value")).val() || {})
    .filter((l) => !ONLINE_EXCLUDED_LOCATIONS.has(l));
  const out = { start, scanned: 0, alreadyQueued: 0, outOfStock: 0, notCandidate: 0, added: [], counts: { sneakers: 0, clothing: 0 } };
  let cursor = start;
  for (;;) {
    const page = (await db.ref("products").orderByKey().startAfter(cursor).limitToFirst(PAGE).once("value")).val() || {};
    const pids = Object.keys(page);
    if (!pids.length) break;
    cursor = pids[pids.length - 1];
    for (const pid of pids) {
      out.scanned += 1;
      const product = page[pid];
      if (notCandidate(pid, product)) { out.notCandidate += 1; continue; }
      const queuedAs = await val(db, `${core.ITEMS}/${pid}/status`);
      if (queuedAs) {
        out.alreadyQueued += 1;
        // A crash between an earlier run's item write and its index write: re-assert the index entry (idempotent).
        if (!dryRun && !(await val(db, `${core.BY_STATUS}/${queuedAs}/${pid}`))) {
          await db.ref(core.ROOT).update(core.indexMove(pid, null, queuedAs, Number(await val(db, `${core.ITEMS}/${pid}/enqueuedAt`)) || nowMs));
          out.reindexed = (out.reindexed || 0) + 1;
        }
        continue;
      }
      const cells = await Promise.all(locations.map((loc) => val(db, `stock/${loc}/${pid}`)));
      const tree = {};
      locations.forEach((loc, j) => { if (cells[j]) tree[loc] = cells[j]; });
      const summary = core.productSummary(product);
      if (!(core.stockSummary(summary.sizes, tree).totalUnits > 0)) { out.outOfStock += 1; continue; }
      const group = core.groupOf(product);
      if (!dryRun) {
        const item = { ...core.buildItem(pid, product, nowMs), backfilled: true };
        const res = await db.ref(`${core.ITEMS}/${pid}`).transaction((cur) => (cur ? undefined : item));
        const cur = res.snapshot && res.snapshot.val();
        if (!res.committed) { out.alreadyQueued += 1; continue; } // queued meanwhile (the trigger won)
        await db.ref(core.ROOT).update(core.indexMove(pid, null, "new", cur.enqueuedAt));
      }
      out.added.push(pid);
      out.counts[group] += 1;
      log(`${dryRun ? "would add" : "added"} ${pid} ${group} ${String(product.name || "").slice(0, 60)}`);
    }
    if (pids.length < PAGE) break;
  }
  if (!dryRun && out.added.length) {
    await db.ref(`${core.ROOT}/backfills/bf-${nowMs}`).set({ at: nowMs, start, added: Object.fromEntries(out.added.map((p) => [p, true])), counts: out.counts });
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const admin = require("../../functions/node_modules/firebase-admin");
  admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
  const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
  const dryRun = process.argv.includes("--dry-run");
  const sinceArg = arg("since");
  const since = sinceKey(sinceArg);
  if (sinceArg && !since) { console.error(`--since: not a date or product id: ${sinceArg}`); process.exit(2); }
  const out = await run(admin.database(), { since, dryRun, log: (l) => console.log(l) });
  console.log(JSON.stringify({ dryRun, ...out, added: out.added.length }, null, 1));
  process.exit(0);
}
