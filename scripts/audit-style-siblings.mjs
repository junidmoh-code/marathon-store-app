// ─── AUDIT — style-code sharing + colour-only alias pairs. READ ONLY. ────────
// (Owner spec 2026-08-07, §6: report only, change nothing.) Three reports:
//   1. every group of products currently sharing a styleCodeNormalised
//   2. every pair of label aliases (different products) whose token sets
//      differ ONLY by colour words
//   3. claim verification — every /style_code_index claim checked against
//      /products (exists? stamped with the same code?) — the proof the
//      sibling change orphans nothing
// This script performs ZERO writes. Run: node scripts/audit-style-siblings.mjs

import { createRequire } from "module";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { COLOUR_LEXICON } = require("../functions/lib/style-code-ocr.cjs");
const { claimOwnerIds } = require("../functions/lib/style-code-siblings.cjs");

admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const [products, index, aliases] = await Promise.all([
  db.ref("products").once("value").then((s) => s.val() || {}),
  db.ref("style_code_index").once("value").then((s) => s.val() || {}),
  db.ref("label_aliases").once("value").then((s) => s.val() || {}),
]);

// ── 1. Products sharing a style code ─────────────────────────────────────────
const byCode = new Map();
for (const [id, p] of Object.entries(products)) {
  if (!p || !p.styleCodeNormalised) continue;
  const code = String(p.styleCodeNormalised);
  if (!byCode.has(code)) byCode.set(code, []);
  byCode.get(code).push({ id, name: p.name || "(unnamed)", merged: !!p.mergedInto });
}
console.log("═══ 1. STYLE CODES SHARED BY MORE THAN ONE PRODUCT ═══");
let sharedGroups = 0;
for (const [code, rows] of [...byCode.entries()].sort()) {
  const live = rows.filter((r) => !r.merged);
  if (live.length < 2) continue;
  sharedGroups++;
  const owners = claimOwnerIds(index[code]);
  console.log(`\n${code}  (${live.length} live products; index owners: ${owners.length ? owners.join(", ") : "NONE — unclaimed"})`);
  for (const r of live) {
    const status = owners.includes(r.id) ? "registered owner" : "stamped only (NOT in index)";
    console.log(`  ${r.id}  ${status}  ${r.name}`);
  }
}
if (!sharedGroups) console.log("(none — no style code is shared by two live products)");
console.log(`\nTotal shared-code groups: ${sharedGroups}`);

// ── 2. Alias pairs differing only by colour words ───────────────────────────
console.log("\n═══ 2. LABEL-ALIAS PAIRS DIFFERING ONLY BY COLOUR WORDS ═══");
const stripColours = (set) => [...set].filter((t) => !COLOUR_LEXICON.has(t)).sort().join("|");
const aliasRows = Object.entries(aliases)
  .map(([aid, a]) => a && a.productId && a.t ? {
    aid, productId: a.productId,
    tokens: new Set(Object.keys(a.t)),
  } : null)
  .filter(Boolean)
  // Pre-compute the colour-stripped key once per alias, and only compare
  // within groups sharing it — the population is small by design, but the
  // grouped scan keeps this linear-ish rather than all-pairs.
  .map((r) => ({ ...r, key: stripColours(r.tokens) }));
const byStripped = new Map();
for (const r of aliasRows) {
  if (!byStripped.has(r.key)) byStripped.set(r.key, []);
  byStripped.get(r.key).push(r);
}
let colourPairs = 0;
for (const group of byStripped.values()) {
  for (let i = 0; i < group.length; i++) {
  for (let j = i + 1; j < group.length; j++) {
    const a = group[i], b = group[j];
    if (a.productId === b.productId) continue;
    const sameEitherWay = a.tokens.size === b.tokens.size && [...a.tokens].every((t) => b.tokens.has(t));
    if (sameEitherWay) continue; // identical sets are a different problem, not a colour split
    colourPairs++;
    const aColours = [...a.tokens].filter((t) => COLOUR_LEXICON.has(t));
    const bColours = [...b.tokens].filter((t) => COLOUR_LEXICON.has(t));
    const nameOf = (pid) => (products[pid] && products[pid].name) || "(gone)";
    console.log(`\n${a.aid} (${a.productId} ${nameOf(a.productId)})  colours: ${aColours.join(" ") || "—"}`);
    console.log(`${b.aid} (${b.productId} ${nameOf(b.productId)})  colours: ${bColours.join(" ") || "—"}`);
  }
  }
}
if (!colourPairs) console.log("(none — no two aliases of different products differ only by colour words)");
console.log(`\nTotal colour-only alias pairs: ${colourPairs}`);

// ── 3. Claim verification — nothing orphaned ─────────────────────────────────
console.log("\n═══ 3. CLAIM VERIFICATION (/style_code_index) ═══");
let ok = 0, orphaned = 0, unstamped = 0, mismatched = 0, stale = 0, withSiblings = 0;
for (const [code, node] of Object.entries(index)) {
  const owners = claimOwnerIds(node);
  if ((node.siblings && Object.keys(node.siblings).length) > 0) withSiblings++;
  for (const pid of owners) {
    const p = products[pid];
    if (!p) { orphaned++; console.log(`ORPHAN     ${code} → ${pid} (product does not exist)`); continue; }
    // A merged-away owner is a STALE claim — the merge should have repointed
    // it to the survivor. Counting it as ok would hide a failed repoint.
    if (p.mergedInto) { stale++; console.log(`STALE      ${code} → ${pid} merged into ${p.mergedInto} — claim not repointed`); continue; }
    if (!p.styleCodeNormalised) { unstamped++; console.log(`UNSTAMPED  ${code} → ${pid} (${p.name || "?"}) — owner not stamped`); continue; }
    if (String(p.styleCodeNormalised) !== code) { mismatched++; console.log(`MISMATCH   ${code} → ${pid} stamped ${p.styleCodeNormalised}`); continue; }
    ok++;
  }
}
console.log(`\nClaims: ${Object.keys(index).length} codes, ${withSiblings} with siblings`);
console.log(`Owner entries — ok: ${ok}, orphaned: ${orphaned}, stale(merged): ${stale}, unstamped: ${unstamped}, mismatched: ${mismatched}`);
console.log("\nAUDIT COMPLETE — zero writes performed.");
// Graceful shutdown: process.exit() can truncate piped stdout mid-flush.
// Deleting the app closes the RTDB connection so Node exits on its own.
await admin.app().delete();
process.exitCode = 0;
