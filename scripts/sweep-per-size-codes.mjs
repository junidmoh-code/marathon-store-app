// ─── SWEEP — products already split by per-size style codes. READ ONLY. ──────
// (Owner spec 2026-08-12, commit 3: report only, merge NOTHING — a merge is
// the owner's decision.) Lacoste prints a different article reference per
// size, so one physical shoe registered from two sizes' labels becomes two
// product records. This script reports:
//
//   1. AUTO-LINKABLE GROUPS — live products whose registered codes are
//      per-size siblings under THE rule the count now runs
//      (src/utils/perSizeStyleCode.js): same Lacoste shape, same prefix, same
//      colourway suffix, exactly one article digit apart. These are one shoe
//      split into several records.
//   2. AMBIGUOUS NEAR-MISSES — same-shape pairs one character apart that the
//      rule REFUSES (suffix-less codes, or the difference sits in the printed
//      colour code). Listed so a human can look; the rule never touches them.
//
// Codes come from styleCodeNormalised AND (marked) pendingStyleCode — a split
// pair often has the code confirmed on one record and pending on the other.
// This script performs ZERO writes. Run: node scripts/sweep-per-size-codes.mjs

import { createRequire } from "module";
import { perSizeSiblingCodes } from "../src/utils/perSizeStyleCode.js";
import { normaliseStyleCode, styleCodeFormat } from "../src/utils/styleCode.js";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });

const products = await admin.database().ref("products").once("value").then((s) => s.val() || {});

// One row per (product, code) — confirmed and pending codes both count, marked.
const rows = [];
for (const [id, p] of Object.entries(products)) {
  if (!p || p.mergedInto) continue;
  const seen = new Set();
  for (const [field, raw] of [["confirmed", p.styleCodeNormalised], ["pending", p.pendingStyleCode]]) {
    const code = normaliseStyleCode(raw);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    rows.push({ id, code, field, name: p.name || "(unnamed)", brand: p.brand || "" });
  }
}
const lacoste = rows.filter((r) => styleCodeFormat(r.code) === "lacoste-ref");
console.log(`live products: ${Object.keys(products).length} · with a code: ${new Set(rows.map((r) => r.id)).size} · Lacoste-shaped codes: ${lacoste.length}`);

// Union-find over per-size sibling pairs.
const parent = new Map(lacoste.map((_, i) => [i, i]));
const find = (i) => (parent.get(i) === i ? i : (parent.set(i, find(parent.get(i))), parent.get(i)));
const union = (i, j) => parent.set(find(i), find(j));
const nearMisses = [];
for (let i = 0; i < lacoste.length; i++) {
  for (let j = i + 1; j < lacoste.length; j++) {
    const a = lacoste[i], b = lacoste[j];
    if (a.id === b.id) continue;
    if (perSizeSiblingCodes(a.code, b.code)) { union(i, j); continue; }
    // Same length, exactly one character apart, but refused — the human list.
    if (a.code !== b.code && a.code.length === b.code.length) {
      let diff = 0;
      for (let k = 0; k < a.code.length; k++) if (a.code[k] !== b.code[k]) diff++;
      if (diff === 1) nearMisses.push([a, b]);
    }
  }
}
const groups = new Map();
for (let i = 0; i < lacoste.length; i++) {
  const root = find(i);
  if (!groups.has(root)) groups.set(root, []);
  groups.get(root).push(lacoste[i]);
}
const split = [...groups.values()].filter((g) => new Set(g.map((r) => r.id)).size > 1);

console.log(`\n═══ 1. ONE SHOE SPLIT ACROSS PRODUCT RECORDS (rule-linked) — ${split.length} group(s) ═══`);
if (!split.length) console.log("(none — no two live product records carry per-size sibling codes today)");
for (const g of split) {
  console.log("");
  for (const r of g) console.log(`  ${r.code.padEnd(16)} [${r.field}] ${r.name} (${r.id})`);
}

console.log(`\n═══ 2. AMBIGUOUS NEAR-MISSES the rule refuses (human eyes only, likely colourways) — ${nearMisses.length} pair(s) ═══`);
for (const [a, b] of nearMisses) {
  console.log(`  ${a.code} ↔ ${b.code}   ${a.name} (${a.id}) ↔ ${b.name} (${b.id})`);
}
console.log("\nThis sweep wrote nothing. Merging is a human decision — see MergeProducts / the duplicate queue.");
process.exit(0);
