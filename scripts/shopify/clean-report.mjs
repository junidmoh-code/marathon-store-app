// ── Brand-trigger engine v2 — full-catalogue report ──────────────────────────
// Read-only census of how every /products record fares through cleanTitleFor:
//
//   node scripts/shopify/clean-report.mjs            summary + 40 sample pairs
//   node scripts/shopify/clean-report.mjs --residue  also list every record the
//                                                    lexicon could NOT clean
//                                                    (the AI pass's worklist)
//   node scripts/shopify/clean-report.mjs --json <f> also write the residue
//                                                    list to <f> for ai-rename
//
// Reads /products via ADC. Writes NOTHING to RTDB, ever. The "40 random"
// pairs are deterministic (pid-hash order) so two runs of the same catalogue
// produce the same report — reviewable, diffable evidence.
import { createRequire } from "module";
import { writeFileSync } from "fs";
import { cleanTitleFor } from "../../src/utils/shopifyTriggers.js";

const flags = process.argv.slice(2);
const SHOW_RESIDUE = flags.includes("--residue");
const jsonIdx = flags.indexOf("--json");
const JSON_OUT = jsonIdx !== -1 ? flags[jsonIdx + 1] : null;
if (jsonIdx !== -1 && !JSON_OUT) {
  console.error("--json needs a file path");
  process.exit(2);
}

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const all = (await admin.database().ref("products").get()).val() || {};

let original = 0;
const cleaned = [];
const residue = [];
let total = 0;
for (const [pid, p] of Object.entries(all)) {
  if (!p || typeof p !== "object" || p.mergedInto) continue;
  total++;
  const r = cleanTitleFor(p);
  if (r.needsAI) {
    residue.push({ pid, name: p.name ?? "", reason: r.reason,
                   category: p.category ?? null, subcategory: p.subcategory ?? null });
  } else if (r.source === "original") {
    original++;
  } else {
    cleaned.push({ pid, before: p.name, after: r.title });
  }
}

console.log(`products: ${total}`);
console.log(`clean automatically: ${original + cleaned.length}`);
console.log(`  · already trigger-free (name ships as-is): ${original}`);
console.log(`  · lexicon-cleaned (title rebuilt): ${cleaned.length}`);
console.log(`need AI / manual naming: ${residue.length}`);
const byReason = {};
for (const r of residue) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
for (const [reason, n] of Object.entries(byReason)) console.log(`    ${reason}: ${n}`);

const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
console.log("\n40 before/after pairs (deterministic sample):");
for (const p of [...cleaned].sort((a, b) => hash(a.pid) - hash(b.pid)).slice(0, 40)) {
  console.log(`  "${p.before}"  →  "${p.after}"`);
}

if (SHOW_RESIDUE) {
  console.log("\nresidue (AI worklist):");
  for (const r of residue) console.log(`  [${r.reason}] ${r.pid}  "${r.name}"  (${r.category}/${r.subcategory})`);
}
if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(residue, null, 2));
  console.log(`\nresidue JSON → ${JSON_OUT}`);
}
process.exit(0);
