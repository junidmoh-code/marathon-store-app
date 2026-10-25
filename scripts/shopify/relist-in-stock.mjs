#!/usr/bin/env node
// ─── RELIST EVERY UNLISTED SHOPIFY PRODUCT THAT HAS STOCK (Junid, 25 Oct 2026) ─
//
//   node scripts/shopify/relist-in-stock.mjs                     dry run: census + verdicts
//   node scripts/shopify/relist-in-stock.mjs --json <file>       … and the full table as JSON
//   node scripts/shopify/relist-in-stock.mjs --commit --batch 100   write the next 100 relist intents
//   node scripts/shopify/relist-in-stock.mjs --check             after a batch: listed? anything moved?
//
// relist.mjs decides; this reads, writes intents and checks. It NEVER calls a
// Shopify mutation itself: the intent (desiredState "on" + relistKeep) is
// applied by the reconciler's "RELIST AS IT IS" branch, which pushes no title,
// description or photo. The one Shopify operation here is a read-only bulk
// query (the same kind the nightly sweep runs).
//
// READS: the bulk snapshot; /shopify_sync/_claims (the numeric id → pid index);
// shallow keys of /config/shopifyReviewHidden; then per pid /products/{pid},
// /shopify_publish/{pid} and one /stock cell set per counted location — point
// reads only, never a whole node.
//
// WRITES (--commit only): /shopify_publish/{pid} by transaction (relistIntent),
// and a local ledger ~/marathon-rollbacks/relist-<date>.json holding each
// product's Shopify title, handle, media ids and variant ids BEFORE, so
// --check can prove none of them moved.
//
// STOPS (exit 3) on --check when any relisted product's title, handle, media
// or variant ids differ from the ledger — Junid's stop condition.
//
// REFUSES --commit unless a reconciler tick in the last 15 minutes stamped
// /shopify_sync/_reconcile/features/relistKeep: an older reconciler would
// ignore the flag and push the record's title and photos.
import { createRequire } from "module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { graphql } from "./client.mjs";
import { runBulkQuery } from "./bulkSnapshot.mjs";
import { requireOnlineStorePublication } from "./collections.mjs";
import { locationNames } from "./inventorySync.mjs";
import { HIDDEN_PATH } from "./reviewStock.mjs";
import { serverNowMs } from "./publishNode.mjs";
import { RECONCILE_STATE_PATH } from "./reconcileScope.mjs";
import { relistBulkQuery, parseRelistSnapshot, isListed, numericIdOf, onlineUnits, relistVerdict, relistIntent, relistDrift }
  from "./relist.mjs";
import { shallowKeys } from "../lib/rtdbPaged.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const flags = process.argv.slice(2);
const COMMIT = flags.includes("--commit");
const CHECK = flags.includes("--check");
const BATCH = flags.includes("--batch") ? Number(flags[flags.indexOf("--batch") + 1]) : 100;
const JSON_OUT = flags.includes("--json") ? flags[flags.indexOf("--json") + 1] : null;
const LEDGER_DIR = join(homedir(), "marathon-rollbacks");
// One ledger for the whole relist, whatever day a batch runs (append, never a new file).
const LEDGER = join(LEDGER_DIR, "relist-2026-10-25.json");
const BY = "script:relist-in-stock";
if (COMMIT && !(BATCH > 0 && BATCH <= 100)) { console.error("--batch must be 1..100"); process.exit(2); }

let bytes = 0;
const get = async (p) => { const v = (await db.ref(p).get()).val(); bytes += Buffer.byteLength(JSON.stringify(v ?? null)); return v; };
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i]); }
  }));
}
const loadLedger = () => (existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : { entries: {} });
const saveLedger = (l) => { mkdirSync(LEDGER_DIR, { recursive: true }); writeFileSync(LEDGER, JSON.stringify(l, null, 1)); };

async function snapshot() {
  // strict: a guessed publication would read the whole catalogue as unlisted.
  const online = await requireOnlineStorePublication(graphql, { strict: true });
  const text = await runBulkQuery(graphql, relistBulkQuery(online), { log: (s) => console.error(s) });
  return parseRelistSnapshot(text);
}

const locs = await locationNames(db);
async function unitsFor(pid, product) {
  const tree = {};
  await Promise.all(locs.map(async (l) => { const c = await get(`stock/${l}/${pid}`); if (c) tree[l] = { [pid]: c }; }));
  return onlineUnits(tree, pid, product?.sizes);
}

// ── --check: what happened to the products written so far ───────────────────
if (CHECK) {
  const ledger = loadLedger();
  const pids = Object.keys(ledger.entries);
  if (!pids.length) { console.log("ledger empty — nothing relisted yet"); process.exit(0); }
  const shop = await snapshot();
  const tally = { listed: 0, pending: 0, blocked: 0, other: 0, drift: 0 };
  const drifted = [];
  for (const pid of pids) {
    const e = ledger.entries[pid];
    const node = await get(`shopify_publish/${pid}`);
    const now = shop.get(e.gid);
    const moved = relistDrift(e.before, now);
    if (moved.length) { tally.drift++; drifted.push({ pid, gid: e.gid, moved }); }
    let state;
    if (node?.state === "blocked") { tally.blocked++; state = `blocked: ${node.blockedReason}`; }
    else if (node?.liveState === "on" && isListed(now)) { tally.listed++; state = "listed"; }
    else if (node?.desiredState === "on") { tally.pending++; state = "waiting for the reconciler"; }
    else { tally.other++; state = `state ${node?.state}/${node?.liveState}/${node?.desiredState}`; }
    e.lastCheck = { state, moved };
  }
  saveLedger(ledger);
  console.log(`relisted so far: ${pids.length} · listed ${tally.listed} · waiting ${tally.pending} · blocked ${tally.blocked} · other ${tally.other}`);
  for (const [pid, e] of Object.entries(ledger.entries)) if (!/^listed|^waiting/.test(e.lastCheck.state)) console.log(`  ${pid}  ${e.lastCheck.state}`);
  if (drifted.length) {
    console.error(`\n🛑 STOP — ${drifted.length} relisted product(s) changed on Shopify:`);
    for (const d of drifted) console.error(`  ${d.pid} ${d.gid}: ${d.moved.join("; ")}`);
    process.exit(3);
  }
  console.log("no title, handle, photo or variant id moved on any relisted product.");
  process.exit(0);
}

// ── Census ───────────────────────────────────────────────────────────────────
const shop = await snapshot();
const claims = (await get("shopify_sync/_claims")) || {};
const pidByNumeric = new Map(Object.entries(claims).filter(([k, v]) => /^\d+$/.test(k) && typeof v === "string").map(([k, v]) => [k, v]));
const unlisted = [...shop.values()].filter((p) => !isListed(p));
console.log(`Shopify: ${shop.size} product(s), ${shop.size - unlisted.length} listed on the Online Store, ${unlisted.length} not`);

const rows = [];
const legacy = [];
await pool(unlisted, 16, async (s) => {
  const pid = pidByNumeric.get(numericIdOf(s.id));
  if (!pid) { legacy.push({ gid: s.id, title: s.title, status: s.status }); return; }
  const [product, node, mappedGid] = await Promise.all([get(`products/${pid}`), get(`shopify_publish/${pid}`), get(`shopify_sync/${pid}/shopifyProductId`)]);
  const units = product ? await unitsFor(pid, product) : 0;
  // The claim index and the record's own map must name the SAME product —
  // the reconciler relists the map's gid, and the ledger checks this one.
  const v = mappedGid !== s.id
    ? { relist: false, code: "map-mismatch", why: `the claim says ${s.id} but the record maps to ${mappedGid || "nothing"}` }
    : relistVerdict({ product, node, shop: s, units });
  rows.push({ pid, gid: s.id, title: s.title, status: s.status, published: s.published, units,
              offReason: node?.lastOff?.reasonCode ?? null, ...v,
              before: { title: s.title, handle: s.handle, mediaIds: s.mediaIds, variants: s.variants } });
});

// Mapped products whose Shopify listing no longer exists (deleted in the admin).
const gone = [];
for (const [num, pid] of pidByNumeric) if (!shop.has(`gid://shopify/Product/${num}`)) gone.push(pid);
const goneWithStock = [];
await pool(gone, 16, async (pid) => {
  const product = await get(`products/${pid}`);
  if (!product || product.mergedInto) return;
  const units = await unitsFor(pid, product);
  if (units >= 1) goneWithStock.push({ pid, name: product.name, units });
});

// What the 4-unit floor hid that was never on Shopify at all.
const hidden = await shallowKeys(admin.app(), HIDDEN_PATH);
const mappedPids = new Set(pidByNumeric.values());
const neverListed = [];
await pool(hidden.filter((p) => !mappedPids.has(p)), 16, async (pid) => {
  const product = await get(`products/${pid}`);
  if (!product || product.mergedInto) return;
  const units = await unitsFor(pid, product);
  if (units >= 1) neverListed.push({ pid, name: product.name, units });
});

const relist = rows.filter((r) => r.relist).sort((a, b) => a.pid.localeCompare(b.pid));
const skipped = rows.filter((r) => !r.relist && r.units >= 1);
const byCode = {};
for (const r of skipped) (byCode[r.code] ||= []).push(r);
console.log(`\nunlisted on Shopify, linked to an app product: ${rows.length}`);
console.log(`  with no stock online (left unlisted): ${rows.filter((r) => !r.relist && !(r.units >= 1)).length}`);
console.log(`  TO RELIST (stock 1+, as it is): ${relist.length} — ${relist.reduce((a, r) => a + r.units, 0)} unit(s)`);
console.log(`  skipped with stock: ${skipped.length}`);
for (const [code, rs] of Object.entries(byCode).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`    ${code.padEnd(16)} ${String(rs.length).padStart(4)}  e.g. ${rs[0].pid} "${rs[0].title}" — ${rs[0].why}`);
}
console.log(`unlisted on Shopify with NO app link (legacy — never matched by name): ${legacy.length}`);
console.log(`linked app products whose Shopify listing was deleted, with stock: ${goneWithStock.length}`);
console.log(`hidden by the 4-unit floor and never on Shopify, with stock: ${neverListed.length} (back in the publisher's list; listing them means NEW products, not a relist)`);
console.log(`rtdb read: ${bytes.toLocaleString()} B`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ relist, skipped, legacy, goneWithStock, neverListed }, null, 1));

if (!COMMIT) { console.log("\ndry run — nothing written. --commit --batch 100 writes the next batch."); process.exit(0); }

// ── Commit one batch ─────────────────────────────────────────────────────────
const now = await serverNowMs(db);
const rstate = (await get(RECONCILE_STATE_PATH)) || {};
if (rstate?.features?.relistKeep !== 1 || !(now - Number(rstate.updatedAt) < 15 * 60 * 1000)) {
  console.error("REFUSED: no reconciler tick in the last 15 minutes understands relistKeep — pull the mini's checkout first.");
  process.exit(2);
}
const ledger = loadLedger();
const todo = relist.filter((r) => !ledger.entries[r.pid]).slice(0, BATCH);
let written = 0;
for (const r of todo) {
  const res = await db.ref(`shopify_publish/${r.pid}`).transaction((cur) => relistIntent(cur, { now, by: BY, gid: r.gid }));
  if (!res.committed || res.snapshot.val()?.relistKeep !== now) { console.log(`  ${r.pid}: changed since the census — left alone`); continue; }
  ledger.entries[r.pid] = { gid: r.gid, units: r.units, before: r.before, writtenAt: now };
  written++;
  // Saved per product: an intent written but not ledgered would never be drift-checked.
  saveLedger(ledger);
}
saveLedger(ledger);
console.log(`\nwrote ${written} relist intent(s); ${relist.filter((r) => !ledger.entries[r.pid]).length} still to go. Ledger: ${LEDGER}`);
console.log("The reconciler applies them over the next few ticks. Then: --check");
process.exit(0);
