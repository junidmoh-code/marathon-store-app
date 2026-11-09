// ─── MUTATION PROOF — dead style-code claims ─────────────────────────────────
// Reintroduce each bug, watch the suite FAIL, restore, watch it PASS. A run that
// errors instead of failing an assertion is reported as an error, not a kill.
// Run from a separate worktree, with the tree committed:
//   node scripts/mutation-proof-style-code-orphans.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const LIB = "functions/lib/style-code-orphans.cjs";
const RESOLVE = "functions/styleCode/resolveStyleCode.js";
const SERVER = { server: ["test/style-code-orphans.test.cjs"] };
const CLAIM = { client: ["src/utils/styleCodeClaim.test.js"] };
const GATE = { client: ["src/components/admin/styleCodeGateLogic.test.js"] };

const MUTATIONS = [
  ["M1", "A failed product write must stop the claim", "src/utils/styleCodeClaim.js", "  await writeProduct();\n", "  writeProduct().catch(() => {});\n", CLAIM],
  ["M2", "A claim that throws must not fail the save", "src/utils/styleCodeClaim.js", "    return { outcome: null, claimError };\n", "    throw claimError;\n", CLAIM],
  ["M3", "App.jsx must save through the helper", "src/App.jsx", "        writeProduct: () => addProductToFirebase(newProduct),\n", "        writeProduct: async () => {},\n", CLAIM],
  ["M4", "Existence is the record's, not the id child's", LIB, "(await db.ref(`products/${id}`).get()).val()", "(await db.ref(`products/${id}/id`).get()).val()", SERVER],
  ["M5", "A merged primary must be followed", LIB, "    if (!record.mergedInto) return { state: seen.size === 1 ? \"live\" : \"merged\", id };\n", "    return { state: \"live\", id };\n", SERVER],
  ["M6", "A merge cycle must never read as dead", LIB, "return { state: \"unresolved\", reason: \"merge-cycle\" };", "return { state: \"dead\" };", SERVER],
  ["M7", "A dangling redirect must never read as dead", LIB, "return seen.size === 1 ? { state: \"dead\" } : { state: \"unresolved\", reason: \"merge-dangling\" };", "return { state: \"dead\" };", SERVER],
  ["M8", "A live sibling keeps the claim", LIB, "  if (answering.length) return { kind: CLAIM_SIBLINGS_ONLY, owners: answering };\n", "", SERVER],
  ["M9", "A release must be logged", LIB, "  await logRef.set(record);\n", "", SERVER],
  ["M10", "Only the claim that was judged may be removed", LIB, "    return sameClaim(current, node) ? null : undefined;\n", "    return null;\n", SERVER],
  ["M11", "A sibling added meanwhile counts as a change", LIB, "a.productId === b.productId && sibs(a) === sibs(b)", "a.productId === b.productId", SERVER],
  ["M12", "The first transaction pass must not abort", LIB, "    if (current === null) return null;\n", "    if (current === null) return undefined;\n", SERVER],
  ["M13", "An aborted release must withdraw its log", LIB, "      await logRef.set(prior);\n", "", SERVER],
  ["M14", "An earlier release is kept in previous", LIB, "  if (prior) {\n    record.previous", "  if (false) {\n    record.previous", SERVER],
  ["M15", "Only a literal true applies the sweep", LIB, "      if (apply !== true) return;\n", "      if (!apply) return;\n", SERVER],
  ["M16", "The sweep must not release a claim with live siblings", LIB, "case CLAIM_SIBLINGS_ONLY: report.siblingsOnly.push(row); return;", "case CLAIM_SIBLINGS_ONLY: break;", SERVER],
  ["M17", "The sweep must not release a claim it could not settle", LIB, "case CLAIM_UNRESOLVED: report.unresolved.push({ ...row, reason: verdict.reason }); return;", "case CLAIM_UNRESOLVED: break;", SERVER],
  ["M18", "A merged row found by the scan must still be followed", RESOLVE, "if (claim && (!scanHit || scanHit.mergedInto)) {", "if (claim && !scanHit) {", SERVER],
  ["M19", "A released code must come back free", RESOLVE, "          claim = null;\n          owners = [];\n", "", SERVER],
  ["M20", "A failed release must be reported for a retry", RESOLVE, "could not release dead claim ${normalised}:`, err && err.message);\n        claimOrphaned = true;\n", "could not release dead claim ${normalised}:`, err && err.message);\n", SERVER],
  ["M21", "An unreadable owner must not be released", RESOLVE, "owner check failed for ${normalised}:`, err && err.message);\n", "owner check failed for ${normalised}:`, err && err.message);\n      verdict = { kind: CLAIM_DEAD, owners: [] };\n", SERVER],
  ["M30", "An unreadable owner asks for a retry", RESOLVE, "      console.warn(`resolveStyleCode: owner check failed for ${normalised}:`, err && err.message);\n      claimOrphaned = true;\n", "      console.warn(`resolveStyleCode: owner check failed for ${normalised}:`, err && err.message);\n", SERVER],
  ["M22", "Survivors and live siblings must be what the client gets", RESOLVE, "      claim = { ...claim, productId: owners[0], siblingIds: owners.slice(1) };\n", "", SERVER],
  ["M23", "The release names the caller", RESOLVE, "releasedBy: actor ? actor.uid : \"system:resolveStyleCode\",", "releasedBy: \"system:resolveStyleCode\",", SERVER],
  ["M24", "An unsettled claim reads as a failed lookup", "src/components/admin/styleCodeGateLogic.js", "if (d.claimOrphaned) return STEP_UNAVAILABLE;", "if (d.claimOrphaned) return STEP_EXISTING;", GATE],
  ["M25", "The orphan screen must stay gone", "src/components/admin/StyleCodeGate.jsx", "      {step === \"unavailable\" && (", "      {step === \"orphan\" && <div />}\n      {step === \"unavailable\" && (", GATE],
  ["M26", "Several owners are never settled on the first", "src/components/admin/styleCodeGateLogic.js", "    if (ownerIds.length > 1) {\n", "    if (ownerIds.length > 99) {\n", GATE],
  ["M27", "An unsettled claim offers no save that would lose it", "src/components/admin/StyleCodeGate.jsx", "{!result?.claimOrphaned && (", "{(", { client: ["src/components/admin/StyleCodeGate.unblock.test.jsx"] }],
  ["M28", "A live primary costs one read", LIB, "  if (primary.state === \"live\") return { kind: CLAIM_LIVE, owners: ids };\n", "  await Promise.all(ids.slice(1).map((id) => resolveOwner(db, id)));\n  if (primary.state === \"live\") return { kind: CLAIM_LIVE, owners: ids };\n", SERVER],
  ["M29", "A released claim must not come back headless", "functions/styleCode/styleCodeSibling.js", "    if (cur === null) return null;\n    if (!cur.productId ||", "    if (cur === null) cur = {};\n    if (false ||", { server: ["test/style-code-siblings.test.cjs"] }],
];

function runTests({ server, client }) {
  const env = { ...process.env, FIREBASE_DATABASE_EMULATOR_HOST: "127.0.0.1:9" };
  const r = server
    ? spawnSync("node", ["--test", ...server], { cwd: "functions", env, encoding: "utf8", timeout: 60000 })
    : spawnSync("npx", ["vitest", "run", ...client], { env, encoding: "utf8", timeout: 120000 });
  const out = `${r.stdout}${r.stderr}`;
  const assertionFailed = server ? /^# fail [1-9]/m.test(out) : /Tests\s+\d+ failed/.test(out);
  return { passed: r.status === 0, assertionFailed, out };
}

let bad = 0;
for (const [id, guard, file, from, to, tests] of MUTATIONS) {
  const original = readFileSync(file, "utf8");
  if (original.split(from).length !== 2) {
    console.log(`${id} ANCHOR NOT UNIQUE in ${file}`);
    bad++;
    continue;
  }
  let verdict;
  try {
    writeFileSync(file, original.replace(from, () => to));
    const broken = runTests(tests);
    if (broken.passed) verdict = "SURVIVED";
    else if (!broken.assertionFailed) verdict = "ERROR (not an assertion)";
    else verdict = "killed";
    if (verdict !== "killed") console.log(broken.out.slice(-600));
  } finally {
    writeFileSync(file, original);
  }
  const restored = runTests(tests);
  if (!restored.passed) verdict += " / DID NOT RESTORE GREEN";
  if (verdict !== "killed") bad++;
  console.log(`${id} ${verdict} — ${guard}`);
}
console.log(bad ? `\n${bad} PROBLEM(S)` : `\nAll ${MUTATIONS.length} mutations killed.`);
process.exit(bad ? 1 : 0);
