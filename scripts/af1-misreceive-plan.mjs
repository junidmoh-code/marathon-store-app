// DRY RUN (Junid, 28 Nov 2026): the AF1 wrong-product correction plan.
// Reads ONLY the facts file written by scripts/af1-misreceive-investigate.mjs
// (no database access at all) and prints, per size and location:
//   RIGHT delta = +R − M − Ys        WRONG delta = −R + Ys
// with before → after, lines that would go negative, ambiguous lines, the
// −M combined-total check, and every BLOCKER. It writes nothing anywhere.
//
//   node scripts/af1-misreceive-plan.mjs <facts.json> [--expected-receive-day YYYY-MM-DD]
//
// There is deliberately no apply step in this PR: the brief's premise did not
// hold on the live ledger (see the PR body), so the plan is for Junid to read.
import { readFileSync } from "fs";
import { planCorrection } from "./lib/af1Misreceive.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) { console.error("usage: node scripts/af1-misreceive-plan.mjs <facts.json> [--expected-receive-day YYYY-MM-DD]"); process.exit(2); }
const i = args.indexOf("--expected-receive-day");
const expectedReceiveDay = i >= 0 ? args[i + 1] : "2026-11-25";

const { wrong, right, facts } = JSON.parse(readFileSync(file, "utf8"));
const plan = planCorrection(facts, { expectedReceiveDay });
const show = (k) => k.replace(/^(\d+)_(\d+)$/, "$1.$2");
const name = (l) => (l.product === "right" ? `RIGHT ${right.name}` : `WRONG ${wrong.name}`);

console.log(`DRY RUN — nothing is written. Reason that would be stamped: "${plan.reason}"\n`);
console.log(`R ${plan.totals.R} · M ${plan.totals.M} · Ys ${plan.totals.Ys} (Ws ${plan.totals.Ws} stay deducted)`);
const sorted = (ls) => [...ls].sort((a, b) => (a.product + a.loc).localeCompare(b.product + b.loc) || parseFloat(show(a.size)) - parseFloat(show(b.size)));
console.log("\nLines:");
for (const l of sorted(plan.lines)) console.log(`  ${name(l).padEnd(44)} ${l.loc.padEnd(10)} size ${show(l.size).padEnd(4)} ${l.delta > 0 ? "+" : ""}${l.delta}  ${l.before} → ${l.after}`);
console.log("\nWould go negative (not applied):");
for (const l of sorted(plan.negative)) console.log(`  ${name(l).padEnd(44)} ${l.loc.padEnd(10)} size ${show(l.size).padEnd(4)} ${l.delta}  ${l.before} → ${l.after}`);
if (!plan.negative.length) console.log("  (none)");
console.log(`\nCombined change across both products: ${plan.totals.combinedDelta} (must equal −M = ${-plan.totals.M}) → ${plan.totals.combinedDeltaOk ? "OK" : "MISMATCH"}`);
console.log(`\nAmbiguous lines (${facts.ambiguous.length}):`);
for (const a of facts.ambiguous) console.log(`  ${a.loc} size ${show(a.size)}: ${a.note}`);
console.log(`\nSTATUS: ${plan.status}`);
for (const b of plan.blockers) console.log(`  BLOCKER ${b.code}: ${b.text}`);
