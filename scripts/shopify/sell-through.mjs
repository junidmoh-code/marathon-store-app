// ── WHAT ACTUALLY SELLS — the home page's running order ──────────────────────
// The storefront's home page leads on the categories that MOVE, and the only
// honest evidence for that is the shop's own POS history. Web traffic is not
// evidence here: the storefront went live weeks ago and barely anybody has
// been to it, so ranking by page views would rank noise. The tills, by
// contrast, have rung up thousands of units.
//
//   node scripts/shopify/sell-through.mjs               last 56 days
//   node scripts/shopify/sell-through.mjs --days 84     a longer floor
//   node scripts/shopify/sell-through.mjs --json out.json
//
// READS ONLY. Nothing is written, on Shopify or in RTDB.
//
// ── THE SOURCE, AND WHY THIS WINDOW ──────────────────────────────────────────
// One sale is one /insights_log entry with action "ready". /orders cannot be
// used: the daily orderNumber reset overwrites it, so it only ever holds today.
//
// Attribution needs `productId` on the event, and that field only became
// reliable through 2026-06:
//
//     2026-05   6.5% attributable      2026-07   99.9%
//     2026-06  68.2%                   2026-08   99.6%
//
// The name fallback that used to cover the gap is dead — the AI naming pass
// rewrote the catalogue titles the historic events were typed against. So 8
// weeks is the deepest CLEAN window, longer windows are floors rather than
// totals, and this script prints its own attribution rate every run so a
// degraded window announces itself instead of silently ranking on a third of
// the data.
//
// ── HOW /insights_log IS READ (no whole-node read) ───────────────────────────
// The node has no `.indexOn`, so orderByChild("timestamp") is unavailable. Push
// keys encode write time, so orderByKey() IS a time range — the same trick
// src/insights/insightsLogRange.js documents, with its 48h pad for key/timestamp
// skew. Pages run BACKWARDS from newest and stop at the first page whose newest
// entry already predates the window, so nothing older is ever downloaded.
//
// ── COUNTING RULES (mirrored from functions/analyzeReorderNeeds) ─────────────
// • dedupe on `${SA-date}::${orderNumber}` — the counter resets daily and an
//   undo/redo writes the event twice.
// • drop any composite key that appears in /returns_log in the same window.
// • units = `qty` when present, else 1.
import { createRequire } from "module";
import { writeFileSync } from "fs";
import { recentDaysStartKey } from "../../src/insights/insightsLogRange.js";
import { dedupeByOrderNumber, returnedOrderNumberSet, excludeReturnedOrderNumbers } from "../../src/utils/insights.js";
import { resolveCollection, COLLECTION_BY_KEY, buildRailOrderSetting } from "./collectionMap.mjs";

const flags = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = flags.indexOf(name);
  return i === -1 ? dflt : flags[i + 1];
};
const DAYS = Math.max(1, Number(argOf("--days", 56)) || 56);
const JSON_OUT = argOf("--json", null);
const PAGE = 4000;
const MAX_PAGES = 60;

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const { startKey, startMs } = recentDaysStartKey(DAYS, Date.now());
// The window the events are FILTERED on is the real one; startKey is only the
// padded download bound (48h wider, by design).
const fromIso = new Date(startMs + 48 * 60 * 60 * 1000).toISOString();
const toIso = new Date(Date.now() + 60_000).toISOString();

/** Page a log node backwards by key until its newest row predates the window. */
async function pageBackwards(node, fromKey, wantAction) {
  const out = [];
  let endBeforeKey = null;
  let pages = 0;
  for (;;) {
    let q = db.ref(node).orderByKey();
    q = endBeforeKey ? q.endAt(endBeforeKey).limitToLast(PAGE + 1) : q.limitToLast(PAGE);
    const val = (await q.once("value")).val() || {};
    pages++;
    const keys = Object.keys(val).sort();
    if (endBeforeKey) {
      const i = keys.indexOf(endBeforeKey);
      if (i >= 0) keys.splice(i, 1); // the cursor row was already taken
    }
    if (keys.length === 0) break;
    for (const k of keys) {
      const e = val[k];
      if (!e || typeof e !== "object") continue;
      if (wantAction && e.action !== wantAction) continue;
      out.push(e);
    }
    // Every key on this page sorts below the padded window start ⇒ done.
    if (keys[keys.length - 1] < fromKey) break;
    endBeforeKey = keys[0];
    if (keys.length < PAGE) break; // reached the start of the node
    if (pages >= MAX_PAGES) {
      console.warn(`⚠ ${node}: paging hit its ${MAX_PAGES}-page bound — the window may be short.`);
      break;
    }
  }
  return { rows: out, pages };
}

console.log(`window: ${fromIso.slice(0, 10)} → ${toIso.slice(0, 10)}  (${DAYS} SA days)\n`);

const [ready, returns] = await Promise.all([
  pageBackwards("insights_log", startKey, "ready"),
  pageBackwards("returns_log", startKey, null),
]);
console.log(`/insights_log: ${ready.pages} page(s), ${ready.rows.length} "ready" rows`);
console.log(`/returns_log:  ${returns.pages} page(s), ${returns.rows.length} rows`);

const inWindow = ready.rows.filter((e) => e.timestamp >= fromIso && e.timestamp < toIso);
const returnedSet = returnedOrderNumberSet(returns.rows, fromIso, toIso, null);
const events = excludeReturnedOrderNumbers(dedupeByOrderNumber(inWindow), returnedSet);

const unitsOf = (e) => Math.max(1, Number(e.qty) || 1);
const totalUnits = events.reduce((s, e) => s + unitsOf(e), 0);

// ── Attribution ──────────────────────────────────────────────────────────────
const byPid = new Map();
let attributedUnits = 0;
for (const e of events) {
  const pid = typeof e.productId === "string" ? e.productId.trim() : "";
  if (!pid) continue;
  const u = unitsOf(e);
  attributedUnits += u;
  byPid.set(pid, (byPid.get(pid) || 0) + u);
}
const coverage = totalUnits ? attributedUnits / totalUnits : 0;
console.log(
  `\n${events.length} sale events after dedupe/returns · ${totalUnits} units · ` +
    `${byPid.size} distinct products\nattribution: ${(coverage * 100).toFixed(1)}% of units carry a productId`
);
if (coverage < 0.9) {
  console.warn(
    `⚠ attribution is below 90% — this ranking is a FLOOR, not a total. Do not scale it up; ` +
      `there is no honest factor (see the header).`
  );
}

// ── pid → category, read one record at a time (never the whole /products node) ─
const pids = [...byPid.keys()];
const BATCH = 60;
const records = new Map();
for (let i = 0; i < pids.length; i += BATCH) {
  const slice = pids.slice(i, i + BATCH);
  const snaps = await Promise.all(slice.map((p) => db.ref(`products/${p}`).get()));
  slice.forEach((p, j) => records.set(p, snaps[j].val()));
}

const byCollection = new Map();
let unmapped = 0;
const unmappedKeys = new Map();
for (const [pid, units] of byPid) {
  const rec = records.get(pid);
  if (!rec) { unmapped += units; unmappedKeys.set("(record deleted)", (unmappedKeys.get("(record deleted)") || 0) + units); continue; }
  const r = resolveCollection(rec);
  if (!r.collectionKey) {
    unmapped += units;
    unmappedKeys.set(r.key || r.status, (unmappedKeys.get(r.key || r.status) || 0) + units);
    continue;
  }
  const cur = byCollection.get(r.collectionKey) || { units: 0, products: 0 };
  cur.units += units;
  cur.products += 1;
  byCollection.set(r.collectionKey, cur);
}

const ranked = [...byCollection.entries()].sort((a, b) => b[1].units - a[1].units);
console.log(`\n══ SELL-THROUGH BY STOREFRONT COLLECTION (${DAYS} days) ══\n`);
console.log("units".padStart(7), "share".padStart(7), " products  collection");
for (const [key, v] of ranked) {
  const title = COLLECTION_BY_KEY.get(key)?.title ?? key;
  console.log(
    String(v.units).padStart(7),
    (((v.units / attributedUnits) * 100).toFixed(1) + "%").padStart(7),
    String(v.products).padStart(9),
    ` ${title}  (${key})`
  );
}
if (unmapped) {
  console.log(`\n${unmapped} attributed units land in no storefront collection:`);
  for (const [k, v] of [...unmappedKeys.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(String(v).padStart(7), ` ${k}`);
  }
}

// PASTE-READY, not merely informative. The theme's "Rail order" setting parses
// `Label~tag~collection-handle` rows; a list of bare collection keys parses to
// nothing and silently empties the home page. So the setting value is BUILT
// from the shared rail table (collectionMap.mjs HOME_RAILS) rather than printed
// as keys and left for a human to translate.
console.log(`\n══ THE HOME-PAGE ORDER ══
Measured order (collection keys, best first):
  ${ranked.map(([k]) => k).join(", ") || "(nothing measured)"}

Paste this into the theme editor → Home rails → "Rail order":

${buildRailOrderSetting(ranked.map(([k]) => k))}
`);

if (JSON_OUT) {
  writeFileSync(
    JSON_OUT,
    JSON.stringify(
      {
        windowDays: DAYS, fromIso, toIso,
        events: events.length, totalUnits, attributedUnits, coverage,
        ranked: ranked.map(([key, v]) => ({ key, title: COLLECTION_BY_KEY.get(key)?.title ?? key, ...v })),
        unmapped: Object.fromEntries(unmappedKeys),
      },
      null, 2
    )
  );
  console.log(`\nwrote ${JSON_OUT}`);
}
process.exit(0);
