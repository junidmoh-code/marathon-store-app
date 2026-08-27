// ─── BUILD THE META CUSTOM AUDIENCE FILES ────────────────────────────────────
//
//   node scripts/audience/build-audience.mjs --out ~/marathon-audience \
//        --oldpos ~/Downloads/lightspeed-customers-export-*.csv
//
// READS ONLY. Nothing is uploaded, nothing is written to RTDB or Shopify. The
// only output is CSV files in --out, and this REFUSES to write them inside the
// repository — they are real customers' names and phone numbers and they must
// not end up in a commit.
//
// Sources, and what each is worth: see scripts/audience/audienceCore.mjs.
import { createRequire } from "module";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { makeRow, mergeRows, splitName, segmentOf, estimateMatchRate, toCsv, RECENT_MONTHS } from "./audienceCore.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { normaliseSAPhone } = require("./lib/sa-phone.cjs");
const admin = require("firebase-admin");

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const argsAfter = (n) => { const i = argv.indexOf(n); if (i < 0) return []; const out = []; for (let j = i + 1; j < argv.length && !argv[j].startsWith("--"); j++) out.push(argv[j]); return out; };

const OUT = resolve(argOf("--out") || `${process.env.HOME}/marathon-audience`);
const REPO = resolve(new URL("../../", import.meta.url).pathname);
if (OUT.startsWith(REPO)) {
  console.error(`REFUSING: --out is inside the repository (${OUT}).\nThese files are customers' names and phone numbers. Write them somewhere that is not version controlled.`);
  process.exit(2);
}

// ── tiny CSV reader (quoted fields, embedded commas) ────────────────────────
function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (c !== "\r") cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const rows = [];
const stats = { shopify: 0, pos: 0, oldpos: 0, unusable: { shopify: 0, pos: 0, oldpos: 0 } };

// ── 1. OLD POS (Lightspeed CSV exports) ─────────────────────────────────────
for (const f of argsAfter("--oldpos")) {
  const parsed = parseCsv(readFileSync(f, "utf8"));
  const head = parsed[0];
  for (const r of parsed.slice(1)) {
    if (r.length < 5) continue;
    const o = Object.fromEntries(head.map((h, i) => [h, (r[i] || "").trim()]));
    const phone = normaliseSAPhone(o.mobile_number || o.phone_number || "");
    const row = makeRow({
      source: "oldpos", phone: phone || "", email: o.email,
      fn: o.first_name, ln: o.last_name,
      ct: o.shipping_address_city || o.billing_address_city,
      st: o.shipping_address_province_state || o.billing_address_province_state,
      country: o.shipping_address_country || o.billing_address_country || "ZA",
    });
    if (!row.phone && !row.email) { stats.unusable.oldpos++; continue; }
    rows.push(row); stats.oldpos++;
  }
}

// ── 2. MARATHON POS (/customers) ────────────────────────────────────────────
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const customers = (await db.ref("customers").get()).val() || {};
for (const [key, v] of Object.entries(customers)) {
  if (!v || key === "unknown") continue;
  // The KEY is the phone in one of three dialects; v.phone is the same number
  // as typed. Either may be the readable one, so both are tried.
  const phone = normaliseSAPhone(v.phone || "") || normaliseSAPhone(key);
  const { fn, ln } = splitName(v.name);
  const row = makeRow({
    source: "pos", phone: phone || "", fn, ln,
    orderCount: v.orderCount, lastOrderAt: v.lastOrderAt, firstOrderAt: v.firstOrderAt,
  });
  if (!row.phone && !row.email) { stats.unusable.pos++; continue; }
  rows.push(row); stats.pos++;
}

// ── 3. SHOPIFY (orders since the first one) ─────────────────────────────────
// The best records in the building and currently unreadable. Rather than
// silently contributing nothing, this SAYS so — an audience quietly missing
// its online buyers would look like a working file.
let shopifyNote = "";
try {
  const { graphql } = await import("../shopify/client.mjs");
  const SINCE = argOf("--since") || "2025-08-25";
  let cursor = null, page = 0;
  for (;;) {
    const d = await graphql(
      `query ($after: String) { orders(first: 100, after: $after, query: "created_at:>=${SINCE}") {
        pageInfo { hasNextPage endCursor }
        nodes { createdAt email phone customer { firstName lastName email phone numberOfOrders
          defaultAddress { city province countryCodeV2 } } } } }`, { after: cursor });
    for (const o of d.orders.nodes) {
      const c = o.customer || {};
      const phone = normaliseSAPhone(c.phone || o.phone || "");
      const row = makeRow({
        source: "shopify", phone: phone || "", email: c.email || o.email,
        fn: c.firstName, ln: c.lastName,
        ct: c.defaultAddress?.city, st: c.defaultAddress?.province,
        country: c.defaultAddress?.countryCodeV2 || "ZA",
        orderCount: Number(c.numberOfOrders) || 1,
        lastOrderAt: Date.parse(o.createdAt) || null, firstOrderAt: Date.parse(o.createdAt) || null,
      });
      if (!row.phone && !row.email) { stats.unusable.shopify++; continue; }
      rows.push(row); stats.shopify++;
    }
    if (!d.orders.pageInfo.hasNextPage || ++page > 60) break;
    cursor = d.orders.pageInfo.endCursor;
  }
} catch (e) {
  shopifyNote = String(e?.message || e).slice(0, 200);
}

// ── merge, segment, write ───────────────────────────────────────────────────
const merged = mergeRows(rows);
const now = Date.now();
const bySegment = {};
for (const r of merged) (bySegment[segmentOf(r, now)] ||= []).push(r);

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const written = [];
const write = (name, list) => {
  if (!list.length) return;
  const path = `${OUT}/${name}.csv`;
  writeFileSync(path, toCsv(list));
  written.push({ name, path, ...estimateMatchRate(list) });
};
for (const [seg, list] of Object.entries(bySegment)) write(seg, list);
write("all", merged);

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\nSOURCES`);
console.log(`  shopify (online buyers)  ${String(stats.shopify).padStart(6)}${shopifyNote ? `   UNREADABLE — ${shopifyNote}` : ""}`);
console.log(`  pos (Marathon POS)       ${String(stats.pos).padStart(6)}   ${stats.unusable.pos} dropped, no usable key`);
console.log(`  oldpos (Lightspeed)      ${String(stats.oldpos).padStart(6)}   ${stats.unusable.oldpos} dropped, no usable key`);
console.log(`  ─ rows in                ${String(rows.length).padStart(6)}`);
console.log(`  ─ people out (deduped)   ${String(merged.length).padStart(6)}   ${rows.length - merged.length} duplicates collapsed`);

const inMore = merged.filter((r) => r.sources.length > 1).length;
console.log(`  ─ found in >1 source     ${String(inMore).padStart(6)}`);

console.log(`\nFILES  (segments; "recent" = ordered in the last ${RECENT_MONTHS} months)`);
console.log(`  ${"segment".padEnd(20)} ${"people".padStart(7)} ${"email".padStart(6)} ${"phone".padStart(6)}   expected match`);
for (const w of written.sort((a, b) => b.rows - a.rows)) {
  console.log(`  ${w.name.padEnd(20)} ${String(w.rows).padStart(7)} ${String(w.withEmail).padStart(6)} ${String(w.phoneOnly).padStart(6)}   ${w.loPct}%–${w.hiPct}%  (${w.lo}–${w.hi})`);
}
console.log(`\nwritten to ${OUT}`);
console.log(`NOTHING WAS UPLOADED. Check the files, then upload the ONE segment you want as the Lookalike seed.`);
process.exit(0);
