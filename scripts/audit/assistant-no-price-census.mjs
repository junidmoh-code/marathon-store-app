#!/usr/bin/env node
// ─── Which products could have read "No price set" on the assistant view? ───
//
// docs/ASSISTANT-NO-PRICE-SET.md. Read-only. Two lists:
//
//  1. FIELD MISMATCH: a price in the editor's field (retailPrice) that the OLD
//     card logic (`typeof p.retailPrice === "number" && p.retailPrice > 0`)
//     would have refused, e.g. a string "300", or a price only in a legacy
//     `price`. Judged from every price batch's products in the window, read by
//     key.
//  2. STALE-COPY RISK: products FIRST priced in the window (retailPrice went
//     from not set to a price). A device that missed that one change record
//     kept showing "No price set", which is the 6080/6082 case.
//
// Every read is bounded: a key range of /price_history_index, then
// /price_history/{batchId} and products/{id}/{field} by key. No whole-node
// read.
//
//   ACCESS_TOKEN=$(gcloud auth print-access-token) node scripts/audit/assistant-no-price-census.mjs [days=30]

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
import { execFileSync } from "child_process";
// ACCESS_TOKEN, refreshed from gcloud on a 401 (a long window outlives one token).
const GCLOUD = process.env.GCLOUD || "gcloud";
let token = process.env.ACCESS_TOKEN;
if (!token) { console.error("ACCESS_TOKEN is required (gcloud auth print-access-token)."); process.exit(2); }
const refreshToken = () => { token = execFileSync(GCLOUD, ["auth", "print-access-token"]).toString().trim(); };
const days = Number(process.argv[2] || 30);

async function read(path, qs = "", retried = false) {
  const res = await fetch(`${DB}/${path}.json${qs}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 && !retried) { refreshToken(); return read(path, qs, true); }
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i]); }
  }));
  return out;
}

export const oldLogicPriced = (p) => typeof p?.retailPrice === "number" && p.retailPrice > 0;

const sinceMs = Date.now() - days * 86400e3;
const index = (await read("price_history_index",
  `?orderBy=%22$key%22&startAt=%22pb_${sinceMs}%22&endAt=%22pb_~%22`)) || {};
const firstPriced = new Map();   // pid -> { name, at, by, batch, to }
const touched = new Set();
const batchIds = Object.keys(index).sort();
const recs = await mapLimit(batchIds, 12, (id) => read(`price_history/${id}`));
for (let bi = 0; bi < batchIds.length; bi += 1) {
  const batchId = batchIds[bi];
  const rec = recs[bi];
  if (!rec?.lines || rec.restoredAt) continue;
  for (const [pid, line] of Object.entries(rec.lines)) {
    touched.add(pid);
    const to = line?.to?.retailPrice;
    const from = line?.from?.retailPrice ?? null;
    if (typeof to === "number" && to > 0 && (from === null || !(from > 0))) {
      firstPriced.set(pid, { name: line.name, at: rec.at, by: rec.byEmail, batch: batchId, to });
    }
  }
}

const mismatch = [];
const rows = [];
const fields = await mapLimit([...touched], 16, (pid) => Promise.all(
  ["sku", "retailPrice", "price", "mergedInto"].map((f) => read(`products/${pid}/${f}`))));
let ti = 0;
for (const pid of touched) {
  const [sku, retailPrice, price, mergedInto] = fields[ti++];
  const p = { sku, retailPrice, price };
  const editorHas = retailPrice !== null && retailPrice !== undefined && retailPrice !== "";
  if ((editorHas || price) && !oldLogicPriced(p)) mismatch.push({ pid, sku, retailPrice, price });
  if (firstPriced.has(pid) && !mergedInto) rows.push({ pid, sku, ...firstPriced.get(pid), now: retailPrice });
}

console.log(`Window: last ${days} days, ${Object.keys(index).length} price batches, ${touched.size} products touched.`);
console.log(`\n1. FIELD MISMATCH (editor price, old card logic says "No price set"): ${mismatch.length}`);
for (const m of mismatch) console.log(`   ${m.sku}  ${m.pid}  retailPrice=${JSON.stringify(m.retailPrice)} price=${JSON.stringify(m.price)}`);
rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
console.log(`\n2. FIRST PRICED in the window (stale-copy risk; now healed on view by usePriceRecheck): ${rows.length}`);
for (const r of rows) console.log(`   ${r.sku}  ${r.pid}  R${r.now}  ${String(r.at).slice(0, 16)}  ${r.by}  ${r.name}`);
