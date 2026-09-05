#!/usr/bin/env node
// ─── MUTATION PROOF — the assistant-hide + zero-stock-merge build ────────────
// A test that passes proves nothing on its own. Each mutation below REINTRODUCES
// one specific defect in the source, runs the tests that are supposed to catch
// it, and demands a FAILURE. Then the file is restored byte-for-byte and the
// same tests must pass again.
//
// REFUSES TO RUN ON A DIRTY TREE. This edits real source files; a kill -9 in
// the middle would otherwise take uncommitted work with it.
//
//   node scripts/mutation-proof-assistant-hide.mjs

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirty = execSync("git status --porcelain", { cwd: root }).toString().trim();
if (dirty) {
  console.error("REFUSED: the tree is dirty. Commit first — this script edits source files.\n" + dirty);
  process.exit(2);
}

const F = {
  cat:   "src/components/assistant/assistantCatalogue.js",
  vis:   "src/config/assistantVisibility.js",
  deact: "src/utils/deactivation.js",
  hub:   "src/components/stock/HubCleanup.jsx",
  dup:   "src/components/stock/duplicateGroups.js",
  app:   "src/App.jsx",
  pa:    "src/components/stock/ProductActions.jsx",
};

const T = {
  assistant: "src/components/assistant/assistantCatalogue.test.js",
  merge:     "src/components/stock/leftoversMergeExit.test.js",
  read:      "src/components/stock/deactivationRead.test.js",
  left:      "src/components/stock/leftoversDeactivate.test.js",
  actions:   "src/components/stock/productActions.render.test.jsx",
  hubIso:    "src/components/stock/hubIsolation.test.js",
};

const MUTATIONS = [
  {
    name: "1. The gate is removed: a deactivated product is back in the pool",
    file: F.cat,
    from: "    if (!showDeactivated && isDeactivated(p)) return false;",
    to:   "    if (false && isDeactivated(p)) return false;",
    tests: [T.assistant],
  },
  {
    name: "2. The gate ignores the exemption: Pine loses its shelf",
    file: F.cat,
    from: "    if (!showDeactivated && isDeactivated(p)) return false;",
    to:   "    if (isDeactivated(p)) return false;",
    tests: [T.assistant],
  },
  {
    name: "3. Every shop is exempt (the exemption stops being scoped)",
    file: F.vis,
    from: "  if (!shopId || typeof shopId !== \"string\") return false;\n  return !!(shopMap && shopMap[shopId] === true);",
    to:   "  return true;",
    tests: [T.assistant],
  },
  {
    name: "4. An unknown / unassigned shop is exempted instead of hidden strictly",
    file: F.vis,
    from: "  if (!shopId || typeof shopId !== \"string\") return false;",
    to:   "  if (!shopId || typeof shopId !== \"string\") return true;",
    tests: [T.assistant],
  },
  {
    name: "5. The config value is ignored — the switch cannot be turned off",
    file: F.vis,
    from: "    for (const [id, on] of Object.entries(raw)) if (typeof id === \"string\" && id) out[id] = !!on;",
    to:   "    for (const [id] of Object.entries(raw)) if (typeof id === \"string\" && id) out[id] = true;",
    tests: [T.assistant],
  },
  {
    name: "6. A denied/malformed config read fails CLOSED instead of to the default",
    file: F.vis,
    from: "  return fallback;\n}",
    to:   "  return {};\n}",
    tests: [T.assistant],
  },
  {
    name: "7. The size rule ignores the per-store override (Pine can see but not order)",
    file: F.deact,
    from: "  if (deactivated === undefined ? isDeactivated(product) : !!deactivated) return true;",
    to:   "  if (isDeactivated(product)) return true;",
    tests: [T.assistant],
  },
  {
    name: "8. AssistantView browses the raw universe again",
    file: F.app,
    from: "  const browse = useMemo(() => (showDeactivated ? base : browsableProducts(base)), [base, showDeactivated]);",
    to:   "  const browse = useMemo(() => base, [base]);",
    tests: [T.read],
  },
  {
    name: "9. The desktop overlay and the phone sheet disagree (the prop is dropped)",
    file: F.app,
    from: "          deadForOrder={deadForOrder}\n",
    to:   "",
    tests: [T.read, T.hubIso],
  },
  {
    name: "10. The submit-time stale-cart guard is removed",
    file: F.app,
    from: ".find((item) => deadForOrder(resolveProductById(item.product.id) || item.product));",
    to:   ".find(() => false);",
    tests: [T.left],
  },
  {
    name: "11. Zero-stock leftovers lose the merge exit (finished lines)",
    file: F.hub,
    from: "                    <LeftoverExits product={product} twin={twinFor(product)} busy={busy}\n                                   onMerge={openMerge} onDeactivate={doDeactivate} />\n                  </div>\n                ))}\n              </>\n            )}\n\n            {/* ── UNREGISTERED, NOT HELD HERE",
    to:   "                    <BigButton tone=\"ghost\" disabled={busy} onClick={() => doDeactivate(product)}>Deactivate</BigButton>\n                  </div>\n                ))}\n              </>\n            )}\n\n            {/* ── UNREGISTERED, NOT HELD HERE",
    tests: [T.merge, T.left],
  },
  {
    name: "12. Deactivate is promoted above Merge (the wrong action reads as primary)",
    file: F.hub,
    from: "      <BigButton tone=\"blue\" disabled={busy} onClick={() => onMerge(product, null)}\n                 style={twin ? { minHeight: 46, fontSize: 15 } : undefined}>\n        {twin ? \"⇄ Choose another product to merge into…\" : \"⇄ Merge into another product…\"}\n      </BigButton>\n      <BigButton tone=\"ghost\" disabled={busy} onClick={() => onDeactivate(product)}\n                 style={{ minHeight: 46, fontSize: 15 }}>\n        ⏸ Deactivate — finished line, stop refills &amp; ordering\n      </BigButton>",
    to:   "      <BigButton tone=\"ghost\" disabled={busy} onClick={() => onDeactivate(product)}\n                 style={{ minHeight: 46, fontSize: 15 }}>\n        ⏸ Deactivate — finished line, stop refills &amp; ordering\n      </BigButton>\n      <BigButton tone=\"blue\" disabled={busy} onClick={() => onMerge(product, null)}\n                 style={twin ? { minHeight: 46, fontSize: 15 } : undefined}>\n        {twin ? \"⇄ Choose another product to merge into…\" : \"⇄ Merge into another product…\"}\n      </BigButton>",
    tests: [T.merge],
  },
  {
    name: "13. The twin row loses its photo / its pre-picked survivor",
    file: F.hub,
    from: "          <Photo url={twin.product.photoUrl} size={56} radius={12} />",
    to:   "          <span />",
    tests: [T.merge],
  },
  {
    name: "14. suggestTwin crosses brands (it would nominate the wrong shoe)",
    file: F.dup,
    from: "      if (namesAreClose(product.name, p.name)) close.push(p);",
    to:   "      close.push(p);",
    tests: [T.merge],
  },
  {
    name: "15. suggestTwin nominates a deactivated or merged-away record",
    file: F.dup,
    from: "  const ok = (p) => p && p.id && p.id !== product.id && p.name && !isMergedAway(p) && !isDeactivated(p);",
    to:   "  const ok = (p) => p && p.id && p.id !== product.id && p.name;",
    tests: [T.merge],
  },
  {
    name: "16. Deactivation starts refusing while a product holds stock",
    file: F.pa,
    from: "    if (busy || !canRetire) return;",
    to:   "    if (busy || !canRetire || totalHeld > 0) return;",
    tests: [T.actions],
  },
  {
    name: "17. Zeroing is folded into the deactivate tap instead of being separate",
    file: F.pa,
    from: "    const res = deactivated ? await reactivateProduct(product.id) : await deactivateProduct(product.id);",
    to:   "    const res = deactivated ? await reactivateProduct(product.id) : await deactivateProduct(product.id);\n    if (!deactivated && totalHeld > 0) await doZero();",
    tests: [T.actions],
  },
];

const vitest = (tests) => spawnSync("npx", ["vitest", "run", ...tests], { cwd: root, encoding: "utf8" });
const ok = (r) => r.status === 0;

let bad = 0;
const rows = [];
for (const m of MUTATIONS) {
  const abs = path.join(root, m.file);
  const original = fs.readFileSync(abs, "utf8");
  if (!original.includes(m.from)) {
    console.error(`\n✗ ${m.name}\n  ANCHOR NOT FOUND in ${m.file} — the mutation could not be applied.`);
    rows.push([m.name, "ANCHOR MISSING", "—"]);
    bad++;
    continue;
  }
  let mutatedFails = false;
  try {
    fs.writeFileSync(abs, original.replace(m.from, m.to));
    mutatedFails = !ok(vitest(m.tests));
  } finally {
    fs.writeFileSync(abs, original);           // restore, always
  }
  const restoredPasses = ok(vitest(m.tests));
  const verdict = mutatedFails && restoredPasses ? "PROVED" : "NOT PROVED";
  if (verdict !== "PROVED") bad++;
  rows.push([m.name, mutatedFails ? "FAILS" : "still passes", restoredPasses ? "passes" : "STILL FAILS"]);
  console.log(`${verdict === "PROVED" ? "✓" : "✗"} ${m.name}  [mutated: ${rows.at(-1)[1]} · restored: ${rows.at(-1)[2]}]`);
}

console.log("\n| mutation | mutated | restored |");
console.log("|---|---|---|");
for (const [n, a, b] of rows) console.log(`| ${n} | ${a} | ${b} |`);

const after = execSync("git status --porcelain", { cwd: root }).toString().trim();
if (after) {
  console.error("\nTREE NOT CLEAN AFTER RESTORE:\n" + after);
  process.exit(3);
}
console.log(`\n${rows.length - bad}/${rows.length} proved. Tree restored clean.`);
process.exit(bad ? 1 : 0);
