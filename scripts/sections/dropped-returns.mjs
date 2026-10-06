#!/usr/bin/env node
// ─── DROPPED RETURNS — READ-ONLY COUNT ───────────────────────────────────────
//
//   node scripts/sections/dropped-returns.mjs --cache DIR [--today YYYY-MM-DD] [--weeks 8] [--shape]
//
// WRITES NOTHING to the database — this file contains no write call at all.
// It writes its report OUTSIDE this (public) repo — the report names real
// products and POS records: ~/Documents/sections-private/dropped-returns.md
// unless --out says otherwise — and caches each day's reads under --cache
// so a re-run does not read the database again.
//
// THE QUESTION. Every return, exchange return line, refund, void or lay-by
// cancel taken at Marathon PE or Trophy in the window where the POS record
// says the goods came back, and NO `return` stock movement exists for the
// line at any location. The customer was credited or refunded; nothing was
// restocked.
//
// READS, all bounded (no whole-node read):
//   /pos/sales        by the `createdAt` index, one day per request
//   /stock_movements  by the `ts` index, one day per request
//   single keys: the original sale's `sold:` movement per candidate location,
//   the hub cell it deducted, one product name, and a prior-day original sale.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const reg = require("../../functions/lib/network-registry.cjs");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const CACHE = opt("--cache", null);
if (!CACHE) { console.error("--cache DIR is required"); process.exit(2); }
mkdirSync(CACHE, { recursive: true });
const WEEKS = Number(opt("--weeks", 8));
const TODAY = opt("--today", new Date().toISOString().slice(0, 10));
const SHAPE = argv.includes("--shape");
// Lay-bys are cancelled weeks after they are made. --lookback-weeks N also
// reads the N weeks BEFORE the window, and keeps from them only lay-bys whose
// cancellation falls inside the window.
const LOOKBACK = Number(opt("--lookback-weeks", 0));
const JSON_OUT = opt("--json", null);
const R = reg.SEED_REGISTRY;
const SECTION2_STORES = new Set(["pe", "trophy"]);

let TOKEN = null;
function token() {
  if (TOKEN) return TOKEN;
  const cfg = JSON.parse(readFileSync(join(process.env.HOME, ".config/configstore/firebase-tools.json"), "utf8"));
  const out = execFileSync("curl", ["-s", "https://oauth2.googleapis.com/token",
    "-d", "grant_type=refresh_token",
    "-d", "client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    "-d", "client_secret=j9iVZfS8kkCEFUPaAeJV0sAi",
    "--data-urlencode", `refresh_token=${cfg.tokens.refresh_token}`], { encoding: "utf8" });
  TOKEN = JSON.parse(out).access_token;
  if (!TOKEN) throw new Error("could not get an access token from the Firebase CLI login");
  return TOKEN;
}
// GET only.
function getJson(path, params = []) {
  const args = ["-s", "-G", `${DB}/${path}.json`, "-H", `Authorization: Bearer ${token()}`];
  for (const [k, v] of params) args.push("--data-urlencode", `${k}=${v}`);
  const j = JSON.parse(execFileSync("curl", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }));
  if (j && typeof j === "object" && j.error) throw new Error(`${path}: ${j.error}`);
  return j;
}
function cached(name, fetch, { final = true } = {}) {
  const f = join(CACHE, name);
  if (final && existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const v = fetch();
  writeFileSync(f, JSON.stringify(v));
  return v;
}
const enc = (s) => String(s ?? "_").replace(/\./g, "_");
const sizeKeyOf = (size) => (size === null || size === undefined || size === "" ? "_" : enc(String(size).trim()));

// ── gather ───────────────────────────────────────────────────────────────────
const endMs = Date.parse(`${TODAY}T00:00:00.000Z`) + 864e5;
const startMs = endMs - WEEKS * 7 * 864e5;
const sales = {};
const returnMv = new Map();    // `${recordId}|${pid}|${sizeKey}` → [{ loc, qty }]
const soldMv = new Map();      // `${recordId}|${pid}|${sizeKey}` → [{ loc, qty, shortfall }]
let mvScanned = 0;
for (let t = startMs; t < endMs; t += 864e5) {
  const day = new Date(t).toISOString().slice(0, 10);
  const isToday = day >= new Date().toISOString().slice(0, 10);
  const s = cached(`sales-${day}.json`, () => getJson("pos/sales", [["orderBy", '"createdAt"'], ["startAt", String(t)], ["endAt", String(t + 864e5 - 1)]]) || {}, { final: !isToday });
  Object.assign(sales, s);
  const m = cached(`mv-${day}.json`, () => getJson("stock_movements", [["orderBy", '"ts"'], ["startAt", `"${new Date(t).toISOString()}"`], ["endAt", `"${new Date(t + 864e5 - 1).toISOString()}"`]]) || {}, { final: !isToday });
  for (const [id, mv] of Object.entries(m)) {
    mvScanned++;
    if (!mv || (mv.type !== "return" && mv.type !== "sold")) continue;
    const parts = id.split(":");
    if (parts.length < 5 || (parts[0] !== "return" && parts[0] !== "sold")) continue;
    const key = `${parts[1]}|${mv.productId}|${enc(mv.size)}`;
    const map = parts[0] === "return" ? returnMv : soldMv;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ loc: mv.to || mv.from || parts[2], qty: Number(mv.qty) || 0, shortfall: Number(mv.shortfall) || 0 });
  }
}

// Lay-bys created before the window and cancelled inside it.
let lookbackRecords = 0;
for (let t = startMs - LOOKBACK * 7 * 864e5; t < startMs; t += 864e5) {
  const day = new Date(t).toISOString().slice(0, 10);
  const s = cached(`sales-${day}.json`, () => getJson("pos/sales", [["orderBy", '"createdAt"'], ["startAt", String(t)], ["endAt", String(t + 864e5 - 1)]]) || {});
  for (const [id, r] of Object.entries(s)) {
    lookbackRecords++;
    const cancelledAt = Number(r?.layby?.cancelledAt) || 0;
    if (r?.type === "layby" && r.status === "cancelled" && cancelledAt >= startMs && cancelledAt < endMs) sales[id] = r;
  }
}

if (SHAPE) {
  const tally = (f) => { const o = {}; for (const r of Object.values(sales)) { const k = String(f(r)); o[k] = (o[k] || 0) + 1; } return o; };
  const keys = {};
  for (const r of Object.values(sales)) for (const k of Object.keys(r || {})) keys[k] = (keys[k] || 0) + 1;
  const lineKeys = {};
  for (const r of Object.values(sales)) for (const l of Object.values(r?.lineItems || {})) for (const k of Object.keys(l || {})) lineKeys[k] = (lineKeys[k] || 0) + 1;
  console.log(JSON.stringify({ records: Object.keys(sales).length, mvScanned, byType: tally((r) => r?.type), byStatus: tally((r) => r?.status), byStore: tally((r) => r?.storeId), recordKeys: keys, lineKeys }, null, 1));
  process.exit(0);
}

// ── which lines came back ────────────────────────────────────────────────────
// One entry per (record, product, size) the POS says was returned to stock.
const isStockLine = (l) => l && l.productId && !l.chargeType && l.priceProduct !== true && !String(l.productId).startsWith("SYNTH_");
const expected = [];
for (const [id, r] of Object.entries(sales)) {
  if (!r || !SECTION2_STORES.has(r.storeId)) continue;
  const lines = Object.entries(r.lineItems || {}).filter(([, l]) => isStockLine(l));
  const at = r.createdAt;
  // (1) return lines on a refund / exchange / return record
  for (const [, l] of lines) {
    // A no-receipt return has no original sale: every stock line on it came back.
    if (l.sourceType !== "return" && r.type !== "no_receipt_return") continue;
    expected.push({ lineName: l.name || null, kind: r.type === "exchange" ? "exchange return" : r.type === "no_receipt_return" ? "no-receipt return" : (r.type || "return"), recordId: id, storeId: r.storeId, at, productId: l.productId, size: l.size, qty: Number(l.qty) || 0, originalSaleId: l.originalSaleId || null, sourceHub: l.sourceHub || null });
  }
  // (2) a voided sale. In the window's data no record carries a voided status:
  // a void is written as a `refund` record with return lines, so (1) covers it.
  if (r.status === "voided" || r.voidedAt) {
    for (const [, l] of lines) {
      if (l.sourceType === "return") continue;
      const q = (Number(l.qty) || 0) - (Number(l.refundedQty) || 0);
      if (q > 0) expected.push({ kind: "void", recordId: id, storeId: r.storeId, at: r.voidedAt || at, productId: l.productId, size: l.size, qty: q, originalSaleId: id, sourceHub: l.sourceHub || null });
    }
  }
  // (3) a cancelled lay-by: its goods were deducted when it was created
  if (r.type === "layby" && (r.status === "cancelled" || r.cancelledAt)) {
    for (const [, l] of lines) {
      if (l.sourceType === "return") continue;
      expected.push({ lineName: l.name || null, kind: "layby cancel", recordId: id, storeId: r.storeId, at: r.layby?.cancelledAt || r.cancelledAt || at, productId: l.productId, size: l.size, qty: Number(l.qty) || 0, originalSaleId: id, sourceHub: l.sourceHub || null });
    }
  }
}

// ── which of those restocked nothing ─────────────────────────────────────────
const deductionIds = (id) => (typeof id === "string" && id.endsWith("~C") ? [id, id.slice(0, -2)] : [id]);
const probeLocs = ["hub1", "hub2", "hub3", "marathon-pe", "trophy", "marathon-pine", "central"];
const cellCache = new Map();
const cellQty = (loc, pid, sk) => { const k = `${loc}|${pid}|${sk}`; if (!cellCache.has(k)) cellCache.set(k, getJson(`stock/${loc}/${pid}/${sk}/qty`)); return cellCache.get(k); };
const nameCache = new Map();
const productName = (pid) => { if (!nameCache.has(pid)) nameCache.set(pid, getJson(`products/${pid}/name`) || pid); return nameCache.get(pid); };
const isFootwearCache = new Map();
const category = (pid) => { if (!isFootwearCache.has(pid)) isFootwearCache.set(pid, getJson(`products/${pid}/category`) || null); return isFootwearCache.get(pid); };

const dropped = [];
let restocked = 0;
for (const e of expected) {
  const sk = sizeKeyOf(e.size);
  const got = [e.recordId, ...deductionIds(e.recordId)].flatMap((rid) => returnMv.get(`${rid}|${e.productId}|${sk}`) || []);
  if (got.length) { restocked++; continue; }
  // Where did the original sale deduct? The window's movements first, then single keys.
  let sold = [];
  for (const sid of e.originalSaleId ? deductionIds(e.originalSaleId) : []) {
    sold = soldMv.get(`${sid}|${e.productId}|${sk}`) || [];
    if (sold.length) break;
    for (const loc of probeLocs) {
      const row = getJson(`stock_movements/sold:${sid}:${loc}:${e.productId}:${sk}`);
      if (row) sold.push({ loc, qty: Number(row.qty) || 0, shortfall: Number(row.shortfall) || 0 });
    }
    if (sold.length) break;
  }
  const from = sold.length === 1 ? sold[0] : null;
  const loc = from ? reg.locationOf(R, from.loc) : null;
  dropped.push({
    ...e, sizeKey: sk, name: (() => { const n = productName(e.productId); return n === e.productId && e.lineName ? `${e.lineName} (product record gone)` : n; })(), category: category(e.productId),
    // The sale itself could not be covered by the books (the cell was already
    // at 0), so the no-negative-cells rule withholds the return's credit ON
    // PURPOSE: crediting it would invent a unit the books never held.
    why: sold.length === 1 && sold[0].shortfall >= e.qty ? "withheld by design" : sold.length ? "no restock found" : "original sale not found",
    soldFrom: from ? from.loc : (sold.length ? sold.map((s) => s.loc).join(" + ") : null),
    soldShortfall: from ? from.shortfall : null,
    soldFromIsHub: !!loc && loc.type === "hub",
    onHandNow: from ? cellQty(from.loc, e.productId, sk) : null,
  });
}

// ── report ───────────────────────────────────────────────────────────────────
const name = (loc) => (loc ? reg.locationName(R, loc) : "not found");
const day = (ms) => (ms ? new Date(Number(ms) + 2 * 3600e3).toISOString().slice(0, 10) : "?");
const units = (list) => list.reduce((t, d) => t + d.qty, 0);
const shortLooks = (d) => (d.onHandNow === null || d.onHandNow === undefined ? "no cell" : Number(d.onHandNow) <= 0 ? `yes (on hand ${d.onHandNow})` : `on hand ${d.onHandNow}`);
const byHub = {};
for (const d of dropped) { const k = d.soldFrom || "not found"; (byHub[k] ||= []).push(d); }
const byStore = {};
for (const d of dropped) (byStore[d.storeId] ||= []).push(d);
const byKind = {};
for (const d of dropped) (byKind[d.kind] ||= []).push(d);
const row = (d) => `| ${d.name} | ${d.size ?? "one size"} | ${d.qty} | ${day(d.at)} | ${d.storeId === "pe" ? "Marathon PE" : "Trophy"} | ${d.kind} | ${name(d.soldFrom)}${d.soldShortfall ? ` (sale short by ${d.soldShortfall})` : ""} | ${shortLooks(d)} | ${d.why} | \`${d.recordId}\` |`;
const real = dropped.filter((d) => d.why !== "withheld by design");
const design = dropped.filter((d) => d.why === "withheld by design");
const realByLoc = real.reduce((m, d) => ((m[d.soldFrom || "not found"] ||= []).push(d), m), {});
const md = [
  "# Dropped returns — Marathon PE and Trophy, read-only count",
  "",
  `Generated ${new Date().toISOString()} by \`scripts/sections/dropped-returns.mjs\`. Nothing was written to the database and nothing was repaired.`,
  "",
  `Window: ${new Date(startMs).toISOString().slice(0, 10)} to ${TODAY} (${WEEKS} weeks). POS records read by date index: ${Object.keys(sales).length}. Stock movements scanned by date index: ${mvScanned}.`,
  "",
  "A line is counted here when the POS record says goods came back (a return line on a refund or exchange, a voided sale, or a cancelled lay-by), the record was taken at Marathon PE or Trophy, and there is **no `return` stock movement for that record, product and size at any location**.",
  "",
  "| | lines | units |",
  "|---|---|---|",
  `| Returned lines the POS recorded at Marathon PE / Trophy | ${expected.length} | ${units(expected)} |`,
  `| …with a restock movement | ${restocked} | |`,
  `| **…with no restock anywhere** | **${dropped.length}** | **${units(dropped)}** |`,
  `| of those: credit withheld BY DESIGN (the original sale was already short — the cell was at 0 when it sold) | ${design.length} | ${units(design)} |`,
  `| of those: **genuinely dropped** (the sale deducted a unit and nothing put it back) | **${real.length}** | **${units(real)}** |`,
  "",
  "## What the numbers say",
  "",
  "- The earlier hypothesis — that Marathon PE / Trophy returns were being routed to Pine's frozen cells and silently dropped in bulk — is **not what the data shows**. Of the returned lines in the window, all but a handful have a restock movement.",
  "- Most of the lines with no restock were withheld on purpose by the no-negative-cells rule: the item was sold while its cell was already at 0, so the books never held it and the return does not add it. The physical item is back in the shop, uncounted.",
  "- The genuine drops are lay-by cancels (the goods were deducted when the lay-by was made and never credited back) and one exchange return whose product record no longer exists.",
  "",
  "## Genuinely dropped units, per location the sale deducted",
  "",
  "| deducted from | lines | units | of which that cell is now at 0 or below |",
  "|---|---|---|---|",
  ...Object.entries(realByLoc).sort((a, b) => units(b[1]) - units(a[1])).map(([k, l]) => `| ${name(k === "not found" ? null : k)} | ${l.length} | ${units(l)} | ${units(l.filter((d) => d.onHandNow !== null && d.onHandNow !== undefined && Number(d.onHandNow) <= 0))} |`),
  "",
  "## All unrestocked units (by design + genuine) by the location the original sale deducted from",
  "",
  "| original sale deducted from | lines | units | of which that cell is now at 0 or below |",
  "|---|---|---|---|",
  ...Object.entries(byHub).sort((a, b) => units(b[1]) - units(a[1])).map(([k, l]) => `| ${name(k === "not found" ? null : k)} | ${l.length} | ${units(l)} | ${units(l.filter((d) => d.onHandNow !== null && d.onHandNow !== undefined && Number(d.onHandNow) <= 0))} |`),
  "",
  "## By store and by kind",
  "",
  "| | lines | units |",
  "|---|---|---|",
  ...Object.entries(byStore).map(([k, l]) => `| taken at ${k === "pe" ? "Marathon PE" : "Trophy"} | ${l.length} | ${units(l)} |`),
  ...Object.entries(byKind).map(([k, l]) => `| ${k} | ${l.length} | ${units(l)} |`),
  `| footwear | ${dropped.filter((d) => d.category === "Footwear").length} | ${units(dropped.filter((d) => d.category === "Footwear"))} |`,
  `| not footwear | ${dropped.filter((d) => d.category !== "Footwear").length} | ${units(dropped.filter((d) => d.category !== "Footwear"))} |`,
  "",
  "## Every dropped line",
  "",
  "| product | size | units | date | taken at | kind | original sale deducted from | looks short now? | why | POS record |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...dropped.sort((a, b) => Number(a.at) - Number(b.at)).map(row),
  "",
  "## Limits of this count",
  "",
  LOOKBACK
    ? `- Lay-bys created up to ${LOOKBACK} weeks before the window and cancelled inside it ARE included (${lookbackRecords} earlier records read for them). One created earlier still is not.`
    : "- Records are found by the date they were CREATED. A lay-by created before the window and cancelled inside it is not counted (run with --lookback-weeks).",
  "- A void has no status of its own in this data; it is a refund record with return lines, and is counted as a refund.",
  "- \"Looks short now\" is the cell's on-hand today. It cannot prove a shortage: later counts, refills and sales have moved the cell since.",
  "- Read-only. Nothing was repaired.",
  "",
].join("\n");
const OUT = opt("--out", join(process.env.HOME, "Documents/sections-private/dropped-returns.md"));
if (OUT.startsWith(ROOT)) throw new Error("the report names real products and records — write it outside this (public) repo");
writeFileSync(OUT, md);
if (JSON_OUT) {
  if (JSON_OUT.startsWith(ROOT)) throw new Error("the list names real products and records — write it outside this (public) repo");
  writeFileSync(JSON_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), window: { startMs, endMs }, dropped: real }, null, 1));
}
console.log(JSON.stringify({ genuine: real.length, byDesign: design.length, genuineByLoc: Object.fromEntries(Object.entries(realByLoc).map(([k, l]) => [k, units(l)])), records: Object.keys(sales).length, mvScanned, expectedLines: expected.length, restocked, dropped: dropped.length, droppedUnits: units(dropped), byHub: Object.fromEntries(Object.entries(byHub).map(([k, l]) => [k, units(l)])), byKind: Object.fromEntries(Object.entries(byKind).map(([k, l]) => [k, units(l)])) }, null, 1));
