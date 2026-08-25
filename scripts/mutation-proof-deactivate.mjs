// ─── MUTATION PROOF — the deactivate-leftovers guards ────────────────────────
//
// For each guard: reintroduce the hole, prove the suite FAILS, restore the
// file, prove it PASSES. Same discipline as mutation-proof-engine-policy.mjs:
// ERROR is not FAIL, anchors must be unique, restore is signal-safe, and the
// mutated files must be clean before anything is touched. Mutation SHAPES are
// varied deliberately (delete a guard, invert a comparison, widen a predicate,
// over-delete a payload) — a harness that only deletes lines only proves
// deletions.
//
//   M-ENGINE-GUARD   delete resolveTarget's deactivated guard      (refill-engine.cjs)
//   M-ENGINE-REACT   treat a REACTIVATED product as still dead     (refill-engine.cjs)
//   M-ENGINE-QUEUE   let a deactivated product back into the
//                    Decision Queue loop                           (refill-engine.cjs)
//   M-ARRIVAL        stop `received` counting as an arrival        (applyMovement.js)
//   M-ARRIVAL-SOLD   let a SALE reactivate (widen, don't delete)   (applyMovement.js)
//   M-ORDER          let deactivated sizes be ordered              (deactivation.js)
//   M-PAYLOAD        make deactivation ALSO delete the barcodes    (deactivation.js)
//   M-LEFTOVERS      keep a deactivated product on the Leftovers   (hubCleanupCore.js)
//   M-FINISHED       invert the zero-everywhere test               (hubCleanupCore.js)
//   M-DEACT-ROWS     hide zero-stock deactivated products          (hubCleanupCore.js)
//   M-MERGE-POOL     filter deactivated out of the merge picker    (mergeSearch.js)
//   M-MERGE-LABEL    drop the "· deactivated" marking              (mergeSearch.js)
//   M-MISSING        offer a deactivated product in Missing
//                    Sneakers again                                (missingFootwearCore.js)
//   M-PIN-CHIPS      bypass orderSizeOut at one chip surface       (App.jsx)
//   M-PIN-BANNER     unmount the global ReactivationNotice         (App.jsx)
//   M-PIN-STALE      delete one stale-screen write guard           (MissingFootwear.jsx)
//   M-PIN-BUTTON     delete the finished-line Deactivate button    (HubCleanup.jsx)
//
// Run: node scripts/mutation-proof-deactivate.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ENGINE = "functions/lib/refill-engine.cjs";
const APPLY = "src/components/stock/applyMovement.js";
const DEACT = "src/utils/deactivation.js";
const CORE = "src/components/stock/hubCleanupCore.js";
const MERGE = "src/components/stock/mergeSearch.js";
const MISSCORE = "src/components/stock/missingFootwearCore.js";
const APP = "src/App.jsx";
const MISSJSX = "src/components/stock/MissingFootwear.jsx";
const HUBJSX = "src/components/stock/HubCleanup.jsx";

const ENGINE_TESTS = ["test/refill-deactivated.test.cjs"];
const DEACT_TESTS = ["src/utils/deactivation.test.js"];
const APPLY_TESTS = ["src/components/stock/applyMovementReactivate.test.js"];
const LIST_TESTS = ["src/components/stock/leftoversDeactivate.test.js"];

const MUTATIONS = [
  {
    id: "M-ENGINE-GUARD",
    guard: "deactivating raises no refill request on the next engine pass",
    file: ENGINE,
    from: `  if (isDeactivated(products?.[pid])) return null;
  const explicit = targets?.[dest]?.[pid]?.[encodeSizeKey(size)];`,
    to: `  const explicit = targets?.[dest]?.[pid]?.[encodeSizeKey(size)];`,
    nodeTests: ENGINE_TESTS,
  },
  {
    id: "M-ENGINE-REACT",
    guard: "reactivating restores normal engine behaviour byte-for-byte",
    file: ENGINE,
    from: `function isDeactivated(product) {
  return !!(product && product.deactivated);
}`,
    to: `function isDeactivated(product) {
  return !!(product && (product.deactivated || product.reactivated));
}`,
    nodeTests: ENGINE_TESTS,
  },
  {
    id: "M-ENGINE-QUEUE",
    guard: "a deactivated product owes no Decision Queue entry",
    file: ENGINE,
    from: `      if (!isClothing(products?.[pid])) continue;
      if (isDeactivated(products?.[pid])) continue;    // finished line — no decision owed
      if (managedHere(loc, pid)) continue;             // target resolves here → managed`,
    to: `      if (!isClothing(products?.[pid])) continue;
      if (managedHere(loc, pid)) continue;             // target resolves here → managed`,
    nodeTests: ENGINE_TESTS,
  },
  {
    id: "M-ARRIVAL",
    guard: "receiving stock into a deactivated product reactivates it automatically",
    file: APPLY,
    from: `  if (m.type === "received" || m.type === "opening" || m.type === "return" || m.type === "transfer_in") return true;`,
    to: `  if (m.type === "opening" || m.type === "return" || m.type === "transfer_in") return true;`,
    tests: APPLY_TESTS,
  },
  {
    id: "M-ARRIVAL-SOLD",
    guard: "a SALE never reactivates — only arrivals do (widened predicate, not a deletion)",
    file: APPLY,
    from: `  return m.type === "adjustment" && !!m.to;
}`,
    to: `  return m.type !== "transfer_out";
}`,
    tests: APPLY_TESTS,
  },
  {
    id: "M-ORDER",
    guard: "a deactivated product's sizes are not selectable when ordering",
    file: DEACT,
    from: `export function orderSizeOut(product, { clothingOrder, hubQty }) {
  if (isDeactivated(product)) return true;
  return !!clothingOrder && hubQty <= 0;
}`,
    to: `export function orderSizeOut(product, { clothingOrder, hubQty }) {
  return !!clothingOrder && hubQty <= 0;
}`,
    tests: DEACT_TESTS,
  },
  {
    id: "M-PAYLOAD",
    guard: "nothing about the product, its stock, its barcodes or its history is deleted",
    file: DEACT,
    from: `    [\`products/\${pid}/deactivated\`]: {
      at: nowMs,
      by: uid,
      ...(byName ? { byName } : {}),   // omit-don't-copy: never write undefined
    },
    [\`products/\${pid}/reactivated\`]: null,`,
    to: `    [\`products/\${pid}/deactivated\`]: {
      at: nowMs,
      by: uid,
      ...(byName ? { byName } : {}),   // omit-don't-copy: never write undefined
    },
    [\`products/\${pid}/reactivated\`]: null,
    [\`products/\${pid}/barcodes\`]: null,`,
    tests: DEACT_TESTS,
  },
  {
    id: "M-LEFTOVERS",
    guard: "deactivating removes the card from the Leftovers list",
    file: CORE,
    from: `    if (isDeactivated(p)) continue;            // retired — the Deactivated list shows it
    if (registeredPids.has(p.id)) continue;    // seen on the floor — not a leftover`,
    to: `    if (registeredPids.has(p.id)) continue;    // seen on the floor — not a leftover`,
    tests: LIST_TESTS,
  },
  {
    id: "M-FINISHED",
    guard: "finished lines are ZERO-everywhere products (inverted comparison)",
    file: CORE,
    from: `    if (everywhere > 0) continue;              // holds stock — that is a leftover, not a finished line`,
    to: `    if (everywhere <= 0) continue;              // holds stock — that is a leftover, not a finished line`,
    tests: LIST_TESTS,
  },
  {
    id: "M-DEACT-ROWS",
    guard: "EVERY deactivated product stays visible, stockless ones included",
    file: CORE,
    from: `    if (!p || !p.id || isMergedAway(p) || !isDeactivated(p)) continue;
    let units = 0;
    if (allStock) for (const prods of Object.values(allStock)) units += totalQty(prods?.[p.id]);
    out.push({ product: p, units, locations: allStock ? locationsHolding(p.id, allStock) : [] });`,
    to: `    if (!p || !p.id || isMergedAway(p) || !isDeactivated(p)) continue;
    let units = 0;
    if (allStock) for (const prods of Object.values(allStock)) units += totalQty(prods?.[p.id]);
    if (units <= 0) continue;
    out.push({ product: p, units, locations: allStock ? locationsHolding(p.id, allStock) : [] });`,
    tests: LIST_TESTS,
  },
  {
    id: "M-MERGE-POOL",
    guard: "a deactivated product is still findable in the merge picker",
    file: MERGE,
    from: `    p && p.id && !isMergedAway(p)
    && p.id !== (loser && loser.id)`,
    to: `    p && p.id && !isMergedAway(p) && !isDeactivated(p)
    && p.id !== (loser && loser.id)`,
    tests: LIST_TESTS,
  },
  {
    id: "M-MERGE-LABEL",
    guard: "…and it is clearly MARKED deactivated there",
    file: MERGE,
    from: `  const mark = isDeactivated(product) ? " · deactivated" : "";`,
    to: `  const mark = "";`,
    tests: LIST_TESTS,
  },
  {
    id: "M-MISSING",
    guard: "Missing Sneakers never offers a deactivated product",
    file: MISSCORE,
    from: `    if (isDeactivated(p)) continue;
    const centralUnits = unitsAt(allStock, "central", pid);`,
    to: `    const centralUnits = unitsAt(allStock, "central", pid);`,
    tests: LIST_TESTS,
  },
  {
    id: "M-PIN-CHIPS",
    guard: "the phone sheet's size chips actually consult orderSizeOut",
    file: APP,
    from: `                const out = orderSizeOut(selected, { clothingOrder: (selected.productType || "sneaker") === "clothing", hubQty: hubQty(selected.id, s) });`,
    to: `                const out = (selected.productType || "sneaker") === "clothing" && hubQty(selected.id, s) <= 0;`,
    tests: LIST_TESTS,
  },
  {
    id: "M-PIN-BANNER",
    guard: "the reactivation banner is mounted app-wide",
    file: APP,
    from: `      <PWAUpdateBanner />
      <ReactivationNotice />`,
    to: `      <PWAUpdateBanner />`,
    tests: LIST_TESTS,
  },
  {
    id: "M-PIN-STALE",
    guard: "the stale-screen write guard exists on BOTH MissingFootwear write paths",
    file: MISSJSX,
    from: `    // Same stale-screen guard as solve(): a finished line takes no requests.
    if (isDeactivated(byId.get(card.pid))) {
      setDone((d) => ({ ...d, [card.pid]: { ok: false, dest, msg: "This product was deactivated — no refills are raised for it." } }));
      return;
    }
`,
    to: ``,
    tests: LIST_TESTS,
  },
  {
    id: "M-PIN-BUTTON",
    guard: "the finished-line card carries its own Deactivate button",
    file: HUBJSX,
    from: `                    <div style={{ marginTop: 10 }}>
                      <BigButton tone="ghost" disabled={busy} onClick={() => doDeactivate(product)}>
                        ⏸ Deactivate — finished line, stop refills &amp; ordering
                      </BigButton>
                    </div>`,
    to: `                    <div style={{ marginTop: 10 }} />`,
    tests: LIST_TESTS,
  },
  // ── review-fix guards (CodeRabbit + substitute pair, PR #445) ─────────────
  {
    id: "M-LOCKLESS",
    guard: "a LOCK-LESS open request is withdrawn on deactivation with no stock proof",
    file: ENGINE,
    from: `      if (isDeactivated(products?.[r.productId])) {
        satisfiedClosures.push({
          refillId: id, dest, pid: r.productId, sizeKey, size: r.size,
          qty: 0, have: 0, rrStatus: "cancelled", cancelReason: "no_longer_needed",
          deactivated: true,
        });
        continue;
      }`,
    to: ``,
    nodeTests: ENGINE_TESTS,
  },
  {
    id: "M-APPLY-STALE",
    guard: "the apply pass skips its live-cell proof for deactivation closures",
    file: "functions/refill-scan.cjs",
    from: `    if (!s.deactivated) {`,
    to: `    {`,
    nodeTests: ENGINE_TESTS,
  },
  {
    id: "M-INTRANSIT",
    guard: "an adjustment INTO in_transit never reactivates",
    file: APPLY,
    from: `  return m.type === "adjustment" && !!m.to && m.to !== "in_transit";`,
    to: `  return m.type === "adjustment" && !!m.to;`,
    tests: APPLY_TESTS,
  },
  {
    id: "M-MISSING-CLOTHING",
    guard: "the clothing/perfume Missing Products twin skips deactivated too",
    file: "src/components/stock/missingProductsCore.js",
    from: `    if (isDeactivated(p)) continue;`,
    to: ``,
    tests: LIST_TESTS,
  },
  {
    id: "M-PIN-SUBMIT",
    guard: "placeOrders re-checks deactivation at submit time (the stale-cart window)",
    file: APP,
    from: `        .find((item) => isDeactivated(resolveProductById(item.product.id) || item.product));`,
    to: `        .find(() => false);`,
    tests: LIST_TESTS,
  },
  {
    id: "M-PIN-MOVEEXCESS",
    guard: "MoveExcess stays in lockstep with the engine's excess pass",
    file: "src/components/stock/MoveExcess.jsx",
    from: `        if (isDeactivated(p)) continue;
        const sizes = [];`,
    to: `        const sizes = [];`,
    tests: LIST_TESTS,
  },
  {
    id: "M-PIN-ALLSTOCK",
    guard: "the Deactivated section waits for allStock",
    file: HUBJSX,
    from: `            {allStock && deactivatedRows.length > 0 && (`,
    to: `            {deactivatedRows.length > 0 && (`,
    tests: LIST_TESTS,
  },
];

function runVitest(files) {
  try {
    execFileSync("npx", ["vitest", "run", ...files, "--silent"], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/Tests\s+\d+\s+failed/.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 140)})`;
  }
}

function runNodeTests(files) {
  try {
    execFileSync("node", ["--test", "--test-reporter=tap", ...files], { stdio: "pipe", cwd: "functions", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/.test(out)) {
      return `ERROR(${(out.trim().split("\n").find((l) => /Error/.test(l)) || "load crash").slice(0, 140)})`;
    }
    if (/^# fail [1-9]/m.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 140)})`;
  }
}

function runAll(m) {
  const verdicts = [];
  if (m.tests && m.tests.length) verdicts.push(runVitest(m.tests));
  if (m.nodeTests && m.nodeTests.length) verdicts.push(runNodeTests(m.nodeTests));
  const errored = verdicts.find((v) => String(v).startsWith("ERROR"));
  if (errored) return errored;
  if (verdicts.includes("FAIL")) return "FAIL";
  return "PASS";
}

// ── PREFLIGHT: NEVER MUTATE AN ALREADY-DIRTY FILE ────────────────────────────
{
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...new Set(MUTATIONS.map((m) => m.file))])
    .toString().trim();
  if (dirty) {
    console.error("Working tree is not clean for the files this harness mutates:\n" + dirty);
    console.error("Commit first — a dirty file would be captured as the baseline.");
    process.exit(2);
  }
}

const results = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    results.push({ ...m, mutated: hits === 0 ? "ANCHOR-MISSING" : "ANCHOR-AMBIGUOUS", restored: "-" });
    console.log(`${m.id.padEnd(15)} ANCHOR ${hits === 0 ? "NOT FOUND" : `FOUND ${hits}×`} in ${m.file}`);
    continue;
  }
  let mutated = "?", restored = "?";
  const restore = () => { try { writeFileSync(m.file, original); } catch { /* nothing better available */ } };
  const onSignal = () => { restore(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    writeFileSync(m.file, original.replace(m.from, () => m.to));
    mutated = runAll(m);
    restore();
    restored = runAll(m);
  } finally {
    restore();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  const proven = mutated === "FAIL" && restored === "PASS";
  results.push({ ...m, mutated, restored, proven });
  console.log(`${m.id.padEnd(15)} mutated:${String(mutated).padEnd(6)} restored:${String(restored).padEnd(6)} ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  — ${m.guard}`);
}

const bad = results.filter((r) => !r.proven);
console.log(`\n${results.length - bad.length}/${results.length} guards proven.`);
if (bad.length) {
  console.log("NOT PROVEN:");
  for (const r of bad) console.log(`  ${r.id}  mutated:${r.mutated}  restored:${r.restored}  — ${r.guard}`);
  process.exit(1);
}
