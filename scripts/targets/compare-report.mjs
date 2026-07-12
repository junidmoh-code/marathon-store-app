// ─── TARGETS PIPELINE · STEP 3: COMPARISON REPORT ─────────────────────────────
// Merges the three model outputs with the deterministic baseline into one
// decision artifact for the owner:
//
//   out/targets-comparison-<date>.csv  — one row per (product, location, size);
//     columns claude|gpt|gemini|baseline plus a prefilled FINAL column (median
//     of the three models). The owner edits FINAL where he disagrees, saves as
//     out/approved-targets.csv, and seed-targets.mjs takes it from there.
//   out/targets-summary-<date>.md      — readable agreement stats, biggest
//     disagreements, and total-units impact per location.
//
// Only products WITH demand signal appear (the models only saw those). Products
// holding stock but with zero sales/OOS stay unmanaged until they sell — the
// engine's default-run rule picks them up on their first sale (see plan §1).
//
// RUN:  node scripts/targets/compare-report.mjs

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
const latest = (prefix) => {
  const f = readdirSync(OUT_DIR).filter((n) => n.startsWith(prefix) && n.endsWith(".json")).sort().pop();
  if (!f) throw new Error(`missing ${prefix}*.json — run the earlier steps first`);
  return JSON.parse(readFileSync(path.join(OUT_DIR, f), "utf8"));
};

const { meta, products } = latest("demand-aggregates-");
const model = { claude: latest("targets-claude-"), gpt: latest("targets-gpt-"), gemini: latest("targets-gemini-") };
const PROVIDERS = ["claude", "gpt", "gemini"];
const LOCATIONS = ["marathon-pe", "trophy", "hub2"];
const date = meta.windowEndSa;

const median = (a, b, c) => [a, b, c].sort((x, y) => x - y)[1];
const csvEsc = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const rows = [];
const stats = { cells: 0, unanimous: 0, within1: 0, disagree: 0, missingFromModel: { claude: 0, gpt: 0, gemini: 0 } };
const unitsByLoc = {}; // loc → {claude, gpt, gemini, final, current}

for (const p of products) {
  const recs = PROVIDERS.map((prov) => model[prov].targets[p.productId]);
  if (recs.every((r) => !r)) continue; // Tier B — models never saw it
  for (const loc of LOCATIONS) {
    for (const [size, s] of Object.entries(p.sizes)) {
      const vals = PROVIDERS.map((prov, i) => {
        const cell = recs[i]?.[loc]?.[size];
        if (!cell) stats.missingFromModel[prov]++;
        return cell ? cell.target : null;
      });
      const filled = vals.map((v, i) => (v === null ? vals.find((x) => x !== null) ?? 0 : v));
      const mins = PROVIDERS.map((prov, i) => recs[i]?.[loc]?.[size]?.minQty ?? null);
      const fin = median(...filled);
      const finMin = median(...mins.map((m, i) => (m === null ? Math.ceil(filled[i] / 2) : m)));
      const cur = loc === "hub2" ? s.hub2Qty : s[loc]?.qty ?? 0;
      const baseline = loc === "hub2" ? s.hub2BaselineTarget : s[loc]?.baselineTarget ?? 0;
      const sold = loc === "hub2"
        ? (s["marathon-pe"]?.sold90 || 0) + (s.trophy?.sold90 || 0)
        : s[loc]?.sold90 || 0;
      const sold7 = loc === "hub2"
        ? (s["marathon-pe"]?.sold7 || 0) + (s.trophy?.sold7 || 0)
        : s[loc]?.sold7 || 0;

      stats.cells++;
      const spread = Math.max(...filled) - Math.min(...filled);
      // Agreement stats only over cells ALL THREE models actually answered —
      // null-filled cells would otherwise inflate "unanimous".
      if (vals.every((v) => v !== null)) {
        stats.allThree = (stats.allThree || 0) + 1;
        if (spread === 0) stats.unanimous++; else if (spread <= 1) stats.within1++; else stats.disagree++;
      }
      const flags = [];
      if (spread > 1) flags.push("DISAGREE");
      if (baseline > 0 && fin > 2 * baseline) flags.push("HIGH");
      if (fin === 0 && sold7 > 0) flags.push("ZERO-BUT-SELLING");

      const u = (unitsByLoc[loc] ||= { claude: 0, gpt: 0, gemini: 0, final: 0, current: 0 });
      u.claude += filled[0]; u.gpt += filled[1]; u.gemini += filled[2]; u.final += fin; u.current += Math.max(cur, 0);

      rows.push({
        productId: p.productId, name: p.name, subcategory: p.subcategory || "", location: loc, size,
        [`sold${meta.actualLedgerDays}d`]: sold, sold7, oos: s.oos90, currentQty: cur,
        hub2Qty: s.hub2Qty, centralQty: s.centralQty,
        claude: filled[0], gpt: filled[1], gemini: filled[2], baseline,
        final: fin, finalMinQty: finMin, spread, flag: flags.join("+"),
        reasoning: recs.find(Boolean)?.reasoning || "",
      });
    }
  }
}

rows.sort((a, b) => b.spread - a.spread || (b[`sold${meta.actualLedgerDays}d`] - a[`sold${meta.actualLedgerDays}d`]));

const headers = Object.keys(rows[0]);
const csvPath = path.join(OUT_DIR, `targets-comparison-${date}.csv`);
writeFileSync(csvPath, [headers.join(","), ...rows.map((r) => headers.map((h) => csvEsc(r[h])).join(","))].join("\n") + "\n");

// ── summary.md ────────────────────────────────────────────────────────────────
const all3 = Math.max(stats.allThree || 0, 1);
const pct = (n) => ((100 * n) / all3).toFixed(1) + "%";
const top = rows.filter((r) => r.spread > 1).slice(0, 20);
const md = [
  `# Three-model stock-target comparison — ${date}`, "",
  `Window: ${meta.windowStartSa} → ${date} (**${meta.actualLedgerDays} days of real ledger history** — no seasonality claims possible).`,
  `Models: claude=${model.claude.model}, gpt=${model.gpt.model}, gemini=${model.gemini.model}.`, "",
  `## Agreement across ${stats.allThree || 0} of ${stats.cells} cells answered by all three models`,
  `- Per-model missing cells: claude=${stats.missingFromModel.claude}, gpt=${stats.missingFromModel.gpt}, gemini=${stats.missingFromModel.gemini} (missing cells fall back to the other models' median)`,
  `- Unanimous: ${stats.unanimous} (${pct(stats.unanimous)})`,
  `- Within 1 unit: ${stats.within1} (${pct(stats.within1)})`,
  `- Disagree by >1: ${stats.disagree} (${pct(stats.disagree)}) — these are flagged DISAGREE in the CSV and sorted to the top`, "",
  `## Total units implied per location (FINAL = per-cell median of the three)`,
  `| Location | Current | Claude | GPT | Gemini | FINAL (median) |`,
  `|---|---|---|---|---|---|`,
  ...LOCATIONS.map((l) => { const u = unitsByLoc[l]; return `| ${l} | ${u.current} | ${u.claude} | ${u.gpt} | ${u.gemini} | ${u.final} |`; }), "",
  `## Biggest disagreements (top 20)`,
  `| Product | Loc | Size | Sold${meta.actualLedgerDays}d | Claude | GPT | Gemini | FINAL |`,
  `|---|---|---|---|---|---|---|---|`,
  ...top.map((r) => `| ${r.name.slice(0, 40)} | ${r.location} | ${r.size} | ${r[`sold${meta.actualLedgerDays}d`]} | ${r.claude} | ${r.gpt} | ${r.gemini} | ${r.final} |`), "",
  `## How to approve`,
  `1. Open \`${path.basename(csvPath)}\` in a spreadsheet.`,
  `2. Review rows flagged DISAGREE / HIGH / ZERO-BUT-SELLING (already sorted to the top); edit the \`final\` / \`finalMinQty\` columns where you disagree.`,
  `3. Save as \`out/approved-targets.csv\` (same columns).`,
  `4. Run \`node scripts/targets/seed-targets.mjs\` (preview) then \`--commit\`.`, "",
  `Products with stock but no sales in the window are NOT in this file — the refill engine leaves them unmanaged until their first sale, then the default run (M3/L3/XL2/XXL2/XXXL1) applies automatically.`,
].join("\n");
const mdPath = path.join(OUT_DIR, `targets-summary-${date}.md`);
writeFileSync(mdPath, md + "\n");

console.error(`Wrote ${csvPath} (${rows.length} rows) and ${mdPath}`);
console.error(md.split("\n").slice(0, 20).join("\n"));
