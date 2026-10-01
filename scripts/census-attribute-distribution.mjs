// ── THE PILOT MEASUREMENT, AS A SCRIPT ───────────────────────────────────────
// READ-ONLY. Reports what the extractor actually produced, so "no field
// collapsed" is a number anyone can reproduce rather than a claim in a PR body.
//
//   node scripts/census-attribute-distribution.mjs
//   node scripts/census-attribute-distribution.mjs --sample 15   photo URLs to eyeball
//
// ── WHAT IT IS LOOKING FOR ───────────────────────────────────────────────────
// A field where one value takes more than COLLAPSE_THRESHOLD of the catalogue
// is not discriminating: every product agrees on it, so it can neither rank a
// neighbour nor separate two names, and it is costing tokens on every call.
// The owner brief names 70%.
//
// It flags a collapse; it does NOT decide what to do about one. The pilot's
// toeShape came back 82.9% "round", which is a true fact about sneakers rather
// than an extractor failure — the answer there was to demote the field, not to
// make the model invent variety. That judgement is a person's.
//
// The number that matters most is the LAST one: distinct attribute signatures.
// A healthy per-field histogram can still describe a catalogue where every shoe
// is identical to three others, and only the signature count shows it.
import { createRequire } from "module";
import "./shopify/env.mjs";
import {
  ATTRIBUTES_PATH, EXTRACTOR_VERSION, resolveAttributes, usableAttributes,
  nameFromAttributes, distinctNamesFor, handleFromName,
} from "../src/utils/productAttributes.js";
import { readMapPaged } from "./lib/rtdbPaged.mjs";

const COLLAPSE_THRESHOLD = 0.70;
const FIELDS = ["silhouette", "upperMaterial", "primaryColour", "secondaryColour", "colourFamily",
                "pattern", "toeShape", "soleColour", "soleType", "closure", "finish", "priceBand"];

const flags = process.argv.slice(2);
const SAMPLE = flags.includes("--sample") ? Number(flags[flags.indexOf("--sample") + 1]) || 15 : 0;

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const attrs = await readMapPaged(db, ATTRIBUTES_PATH, { pageSize: 500 });
const products = await readMapPaged(db, "products", { pageSize: 500 });
const publish = await readMapPaged(db, "shopify_publish", { pageSize: 400 });

const rows = Object.entries(attrs)
  .filter(([, n]) => n?.a && Number(n.v) === EXTRACTOR_VERSION)
  .map(([pid, n]) => [pid, resolveAttributes(n), n]);
console.log(`extractions at v${EXTRACTOR_VERSION}: ${rows.length} (of ${Object.keys(attrs).length} on record)`);
const usable = rows.filter(([, , n]) => usableAttributes(n)).length;
console.log(`usable (every required field present): ${usable}  (${(100 * usable / Math.max(rows.length, 1)).toFixed(1)}%)`);
if (!rows.length) process.exit(0);

console.log(`\n${"=".repeat(72)}\nFIELD DISTRIBUTIONS — one value over ${COLLAPSE_THRESHOLD * 100}% is COLLAPSING\n${"=".repeat(72)}`);
const collapsing = [];
for (const f of FIELDS) {
  const c = {};
  for (const [, a] of rows) c[a[f] || "(blank)"] = (c[a[f] || "(blank)"] || 0) + 1;
  const sorted = Object.entries(c).sort((x, y) => y[1] - x[1]);
  const share = sorted[0][1] / rows.length;
  if (share > COLLAPSE_THRESHOLD) collapsing.push(`${f} (${(share * 100).toFixed(1)}% ${sorted[0][0]})`);
  console.log(`\n${f}  (${sorted.length} distinct · top ${(share * 100).toFixed(1)}%)${share > COLLAPSE_THRESHOLD ? "   ⚠ COLLAPSING" : ""}`);
  for (const [k, v] of sorted.slice(0, 10)) {
    console.log(`    ${String(k).padEnd(16)} ${String(v).padStart(4)}  ${(100 * v / rows.length).toFixed(1).padStart(5)}%  ${"█".repeat(Math.round(40 * v / rows.length))}`);
  }
  if (sorted.length > 10) console.log(`    … and ${sorted.length - 10} more`);
}

const tc = {};
for (const [, a] of rows) for (const t of a.styleTags) tc[t] = (tc[t] || 0) + 1;
console.log(`\nstyleTags (${Object.keys(tc).length} distinct)`);
for (const [k, v] of Object.entries(tc).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(16)} ${String(v).padStart(4)}  ${(100 * v / rows.length).toFixed(1)}%`);
}

const confs = [];
for (const [, , n] of rows) for (const v of Object.values(n.conf || {})) confs.push(v);
confs.sort((a, b) => a - b);
if (confs.length) {
  console.log(`\nper-field confidence: n=${confs.length} · p10=${confs[Math.floor(confs.length * 0.1)]} · ` +
              `median=${confs[Math.floor(confs.length * 0.5)]} · p90=${confs[Math.floor(confs.length * 0.9)]}`);
}

// ── THE NUMBER THAT ACTUALLY MATTERS ─────────────────────────────────────────
const sig = new Map();
for (const [pid, a] of rows) {
  const k = FIELDS.map((f) => a[f]).join("|");
  if (!sig.has(k)) sig.set(k, []);
  sig.get(k).push(pid);
}
const dupSig = [...sig.values()].filter((v) => v.length > 1);
console.log(`\n${"=".repeat(72)}`);
console.log(`DISTINCT ATTRIBUTE SIGNATURES: ${sig.size} for ${rows.length} products (${(100 * sig.size / rows.length).toFixed(1)}%)`);
console.log(`  identical-signature groups: ${dupSig.length} covering ${dupSig.reduce((t, v) => t + v.length, 0)} product(s); largest ${Math.max(0, ...dupSig.map((v) => v.length))}`);

const named = rows.map(([pid, a]) => [pid, a]).filter(([, a]) => nameFromAttributes(a));
const derived = distinctNamesFor(named);
const handles = new Set([...derived.values()].map((v) => v.handle));
console.log(`DERIVED NAMES: ${derived.size} emitted · ${handles.size} distinct handle(s) · ` +
            `${named.length - derived.size} refused rather than collided`);

const todayH = new Map();
for (const [pid] of rows) {
  const h = handleFromName(publish[pid]?.cleanName || "");
  if (!h) continue;
  if (!todayH.has(h)) todayH.set(h, []);
  todayH.get(h).push(pid);
}
const todayDup = [...todayH.values()].filter((v) => v.length > 1);
console.log(`TODAY, the same products: ${todayH.size} distinct handle(s) · ${todayDup.length} colliding group(s)`);

if (SAMPLE) {
  console.log(`\n${"=".repeat(72)}\nSAMPLE — ${SAMPLE} extractions against their photos\n${"=".repeat(72)}`);
  const step = Math.max(1, Math.floor(rows.length / SAMPLE));
  for (let i = 0, shown = 0; i < rows.length && shown < SAMPLE; i += step, shown++) {
    const [pid, a] = rows[i];
    const p = products[pid] || {};
    console.log(`\n${pid}  ${JSON.stringify(p.name || "")}  ${p.brand || "-"}  R${p.retailPrice}`);
    console.log(`   ${FIELDS.map((f) => `${f}=${a[f] || "-"}`).join(" ")} tags=${a.styleTags.join(",")}`);
    console.log(`   name → ${JSON.stringify(derived.get(pid)?.name || nameFromAttributes(a) || "(refused)")}`);
    console.log(`   ${p.photoUrl || "(no photo)"}`);
  }
}

console.log(collapsing.length
  ? `\n⚠ COLLAPSING: ${collapsing.join(" · ")}\n  A collapse is not automatically an extractor fault — the pilot's 82.9%\n  "round" toeShape is a true fact about sneakers. Decide, do not auto-fix.`
  : `\nNo field collapses.`);
process.exit(0);
