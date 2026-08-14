// Mutation proofs for the customer phone-normalization + merge project.
//
// For each guard: reintroduce the bug, prove the test suite FAILS, restore the
// file, prove it PASSES. A test that cannot fail proves nothing, so this runs
// the whole cycle and refuses to report a pass it did not watch break first.
//
// Safe: every mutation is applied to a file whose original bytes are held in
// memory and written back in a finally block, including on crash and signal,
// and the restore is verified byte-for-byte before the run continues. Nothing
// here touches any database — the suites under test are themselves pure.
//
//   node scripts/mutation-proof-customer-merge.mjs
//   node scripts/mutation-proof-customer-merge.mjs --only=M3,M7

import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

const CORE   = "scripts/lib/customerMergeCore.mjs";
const PHONE  = "src/utils/phone.js";
const SEARCH = "src/utils/customerSearch.js";
const ORDER  = "src/utils/orderCustomer.js";
const CINDEX = "src/insights/customerIndex.js";

const CORE_SUITE   = ["scripts/lib/customerMergeCore.test.mjs"];
const PHONE_SUITE  = ["src/utils/phone.test.js"];
const SEARCH_SUITE = ["src/utils/customerSearch.test.js"];
const ORDER_SUITE  = ["src/utils/orderCustomer.test.js"];
const CINDEX_SUITE = ["src/insights/customerIndexEquivalence.test.js"];

const MUTATIONS = [
  { id: "M1",
    guard: "canonicalSA refuses junk/truncated/foreign numbers instead of grouping them",
    file: CORE,
    from: `  return /^\\+27\\d{9}$/.test(e164) ? e164 : null;`,
    to:   `  return e164 || null;`,
    tests: CORE_SUITE },
  { id: "M2",
    guard: "all stored dialects (0/27/+27/bare-9) resolve to ONE canonical identity",
    file: PHONE,
    from: `  if (/^27\\d{9}$/.test(d)) return "0" + d.slice(2); // 27XXXXXXXXX → 0XXXXXXXXX`,
    to:   `  if (false) return "0" + d.slice(2); // 27XXXXXXXXX → 0XXXXXXXXX`,
    tests: PHONE_SUITE },
  { id: "M3",
    guard: "customer search finds a record by ANY typed phone dialect (the shipped filter, not a copy)",
    file: SEARCH,
    from: `      saSignificantDigits(c.phone).includes(qSig || qDigits) ||`,
    to:   `      (c.phone || "").includes(q) ||`,
    tests: SEARCH_SUITE },
  { id: "M4",
    guard: "store credits MOVE to the survivor — dropping the survivor-side write destroys value",
    file: CORE,
    from: `    updates[\`customers/\${survivorKey}/storeCredit/\${cid}\`] = credit;`,
    to:   `    `,
    tests: CORE_SUITE },
  { id: "M5",
    guard: "an open layby re-points by customerPhone while invoiceNo stays untouched and findable",
    file: CORE,
    from: `    updates[\`laybys/\${id}/customerPhone\`] = survivorKey;`,
    to:   `    updates[\`laybys/\${id}/invoiceNo\`] = survivorKey;`,
    tests: CORE_SUITE },
  { id: "M6",
    guard: "a REVIEW group is NEVER merged",
    file: CORE,
    from: `  if (classification !== "SAFE") refuse(\`classification is \${classification} — only SAFE groups merge\`);`,
    to:   `  if (false) refuse(\`classification is \${classification} — only SAFE groups merge\`);`,
    tests: CORE_SUITE },
  { id: "M7",
    guard: "every touched path is captured in preState — the loser is recoverable byte-for-byte",
    file: CORE,
    from: `  const touch = (path, prior) => { preState[path] = prior === undefined ? null : prior; };`,
    to:   `  const touch = () => {};`,
    tests: CORE_SUITE },
  { id: "M8",
    guard: "the core module stays firebase-free — no test can ever write live data",
    file: CORE,
    from: `import { normalizeSAPhone } from "../../src/utils/phone.js";`,
    to:   `import { normalizeSAPhone } from "../../src/utils/phone.js";\n// firebase import would go here`,
    tests: CORE_SUITE },
  { id: "M9",
    guard: "ledger balances fold by exact sum (value conserved), not overwrite",
    file: CORE,
    from: `    updates[\`pos/creditLedger/\${survivorKey}/balance\`] = sBalance + lBalance;`,
    to:   `    updates[\`pos/creditLedger/\${survivorKey}/balance\`] = lBalance;`,
    tests: CORE_SUITE },
  { id: "M10",
    guard: "pos/sales.customerId is re-pointed (instalments/backfill would otherwise resurrect the loser)",
    file: CORE,
    from: `    updates[\`pos/sales/\${saleId}/customerId\`] = survivorKey;`,
    to:   `    `,
    tests: CORE_SUITE },
  { id: "M11",
    guard: "the bare-9 key dialect is probed, so a bare-keyed record is found, not duplicated",
    file: PHONE,
    from: `    const bare = local.slice(1);`,
    to:   `    const bare = local;`,
    tests: PHONE_SUITE },
  { id: "M12",
    guard: "the survivor is the record with the MOST sale history",
    file: CORE,
    from: `    return (sb.posSales - sa.posSales)`,
    to:   `    return (sa.posSales - sb.posSales)`,
    tests: CORE_SUITE },
  { id: "M13",
    guard: "order-time resolution FOLLOWS mergedInto — a tombstone never re-accrues bookkeeping",
    file: ORDER,
    from: `    for (let hop = 0; hop < MAX_MERGE_HOPS && cur.mergedInto && !seen.has(cur.mergedInto); hop++) {`,
    to:   `    for (let hop = 0; false; hop++) {`,
    tests: ORDER_SUITE },
  { id: "M14",
    guard: "the autocomplete index skips tombstones — a merged-away twin can't win a suggestion slot",
    file: CINDEX,
    from: `    if (c.mergedInto) continue;`,
    to:   `    if (false) continue;`,
    tests: CINDEX_SUITE },
  { id: "M15",
    guard: "loser refs match by stripped digits (census comparison) — a '+27…'-stored layby is not left behind",
    file: CORE,
    from: `      if (d === loserKey) { out[id] = v; continue; }`,
    to:   `      if (String(v?.[field] || "") === loserKey) { out[id] = v; continue; }`,
    tests: CORE_SUITE },
  { id: "M16",
    guard: "a third-dialect in-group ref is re-pointed with the survivor, never left stranded on a dead key",
    file: CORE,
    from: `      if (d !== survivorKey && canonical && canonicalSA(d) === canonical) {
        out[id] = v;`,
    to:   `      if (false) {
        out[id] = v;`,
    tests: CORE_SUITE },
  { id: "M17",
    guard: "tombstones leave group membership — triples pair-merge down and re-runs stay clean",
    file: CORE,
    from: `    if (rec?.mergedInto) { tombstones.push({ key, rec }); continue; }`,
    to:   `    if (false) { tombstones.push({ key, rec }); continue; }`,
    tests: CORE_SUITE },
  { id: "M18",
    guard: "an audit event id already under the survivor refuses — a move can never overwrite survivor history",
    file: CORE,
    from: `      if ((survivorAudit[k] || {})[eventId] !== undefined)`,
    to:   `      if (false)`,
    tests: CORE_SUITE },
  { id: "M19",
    guard: "a bare-9 survivor (unreachable by the POS probe) refuses the pair for an owner decision",
    file: CORE,
    from: `  if (/^\\d{9}$/.test(survivorKey) && !survivorKey.startsWith("0"))`,
    to:   `  if (false)`,
    tests: CORE_SUITE },
];

const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(",")) : null;

function runSuite(tests) {
  try {
    execSync(`npx vitest run ${tests.join(" ")}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const results = [];
let failed = false;

// A signal mid-mutation must restore the file before exiting, or the repo is
// left carrying an injected bug (CodeRabbit, #364).
let activeRestore = null;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { if (activeRestore) activeRestore(); process.exit(130); });
}

for (const m of MUTATIONS) {
  if (ONLY && !ONLY.has(m.id)) continue;
  const original = readFileSync(m.file, "utf8");
  // The anchor must occur EXACTLY once — String.replace substitutes the first
  // occurrence only, so an ambiguous anchor could mutate an unintended site
  // and still report PROVEN for the wrong reason (CodeRabbit, #364).
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    console.error(`✗ ${m.id}: mutation anchor ${hits === 0 ? "not found" : `matched ${hits} times`} in ${m.file} — exactly 1 required. FAIL.`);
    results.push({ id: m.id, guard: m.guard, outcome: "ANCHOR MISSING" });
    failed = true;
    continue;
  }
  activeRestore = () => { try { writeFileSync(m.file, original); } catch { /* best effort */ } };
  let outcome;
  try {
    // M8 is special: the guard is a source-content pin, so the mutation embeds
    // the banned word in a comment — enough to trip the pin, harmless to run.
    writeFileSync(m.file, original.replace(m.from, m.to.replace("// firebase import would go here", '// import { getDatabase } from "firebase/database";')));
    const brokeAsExpected = !runSuite(m.tests);
    writeFileSync(m.file, original);
    if (readFileSync(m.file, "utf8") !== original) throw new Error("byte-for-byte restore failed");
    const passesRestored = runSuite(m.tests);
    outcome = brokeAsExpected && passesRestored ? "PROVEN"
      : !brokeAsExpected ? "SUITE DID NOT FAIL UNDER MUTATION"
      : "SUITE STILL FAILING AFTER RESTORE";
  } finally {
    writeFileSync(m.file, original);
    activeRestore = null;
  }
  if (outcome !== "PROVEN") failed = true;
  console.log(`${outcome === "PROVEN" ? "✓" : "✗"} ${m.id} ${outcome.padEnd(12)} ${m.guard}`);
  results.push({ id: m.id, guard: m.guard, outcome });
}

console.log(`\n${results.filter((r) => r.outcome === "PROVEN").length}/${results.length} guards mutation-proven`);
process.exit(failed ? 1 : 0);
