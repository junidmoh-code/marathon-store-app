// ─── MUTATION PROOF — the guards are load-bearing ────────────────────────────
// A green test proves nothing on its own. For each guard this build adds, put
// the bug BACK, run the test that claims to catch it, require it to FAIL, then
// restore the file byte-for-byte and require it to pass again.
//
// Run from the repo root:  node scripts/mutation-proof-deactivate-read.mjs
//
// The restore is in a finally block AND the originals are captured before any
// edit, so a crash cannot leave a mutated source behind. (Never `git add -A`
// while this is running — see the standing rule.)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const F = (p) => path.join(ROOT, p);

const MUTATIONS = [
  {
    name: "BUG 1 · the grid browses the FULL universe again (the reported bug)",
    file: "src/App.jsx",
    find: "    if (!q) return browse;   // no query = browsing: deactivated products are not on offer",
    replace: "    if (!q) return base;",
    test: "src/components/stock/deactivationRead.test.js",
  },
  {
    name: "BUG 1 · the desktop overlay is handed the unfiltered list again",
    file: "src/App.jsx",
    find: "          products={browse} searchResults={filtered}",
    replace: "          products={base} searchResults={filtered}",
    test: "src/components/stock/deactivationRead.test.js",
  },
  {
    name: "BUG 1 · search stops finding a deactivated product (over-filtering)",
    file: "src/App.jsx",
    find: "  const fuse = useMemo(() => new Fuse(base, {",
    replace: "  const fuse = useMemo(() => new Fuse(browse, {",
    test: "src/components/stock/deactivationRead.test.js",
  },
  {
    name: "BUG 1 · the engine decision queue owes decisions on retired lines again",
    file: "src/components/stock/NoTargetQueue.jsx",
    find: "      if (isDeactivated(p)) continue;   // retired finished line — no decision is owed on it",
    replace: "      // guard removed",
    test: "src/components/stock/deactivationRead.test.js",
  },
  {
    name: "BUG 1 · introduce-to-engine arms a retired line again",
    file: "src/components/stock/introduceExistingCore.js",
    find: "      if (isDeactivated(productsById.get(pid))) continue;",
    replace: "      // guard removed",
    test: "src/components/stock/deactivationRead.test.js",
  },
  {
    name: "BUG 1 · display registration offers a retired line a display again",
    file: "src/components/stock/DisplayRegistrationView.jsx",
    find: "predicate: (p) => isFootwearProduct(p) && !isDeactivated(p)",
    replace: "predicate: isFootwearProduct",
    test: "src/components/stock/deactivationRead.test.js",
  },
  {
    name: "BUG 2 · the third section requires stock, reopening the Pine hole",
    file: "src/components/stock/hubCleanupCore.js",
    find: "    if (cellLocs.length && net <= 0) continue;",
    replace: "    if (net <= 0) continue;",
    test: "src/components/stock/unregisteredElsewhere.test.js",
  },
  {
    name: "BUG 2 · the third section duplicates cards the Leftovers list already shows",
    file: "src/components/stock/hubCleanupCore.js",
    find: "    if (totalQty(hubStock[p.id]) > 0) continue;",
    replace: "    // overlap guard removed",
    test: "src/components/stock/unregisteredElsewhere.test.js",
  },
  {
    name: "BUILD 3 · a digit-bearing token counts as a typo again (bags, T-shirts, Air Max 95/97)",
    file: "src/components/stock/duplicateGroups.js",
    find: "  if (/\\d/.test(x) || /\\d/.test(y)) return false;",
    replace: "  // digit guard removed",
    test: "src/components/stock/duplicateGroups.test.js",
  },
  {
    // The token-COUNT gate is what stops the 96-strong Air Force family
    // collapsing: without it the token-SET check compares a shorter sorted list
    // against a longer one and reports a match, so "Nike Air Force 1" swallows
    // "Nike Air Force 1 White".
    name: "BUILD 3 · a name may absorb a longer one (the Air Force family collapses)",
    file: "src/components/stock/duplicateGroups.js",
    find: "  if (a.length !== b.length) return false;",
    replace: "  if (Math.abs(a.length - b.length) > 1) return false;",
    test: "src/components/stock/duplicateGroups.test.js",
  },
  {
    name: "BUILD 3 · the survivor is picked blind (first record wins)",
    file: "src/components/stock/duplicateGroups.js",
    find: "      const d = score(b) - score(a);",
    replace: "      const d = 0 * (score(b) - score(a));",
    test: "src/components/stock/duplicateGroups.test.js",
  },
  {
    name: "BUILD 3 · opening a group no longer pre-selects the loser",
    file: "src/components/stock/DuplicatesTab.jsx",
    find: "    const loser = group.members.find((m) => m.id !== survivorId);",
    replace: "    const loser = null;",
    test: "src/components/stock/duplicatesTab.render.test.jsx",
  },
  {
    name: "BUILD 4 · stock blocks deactivation again (a phantom unit keeps it alive)",
    file: "src/components/stock/ProductActions.jsx",
    find: "          <button disabled={busy} onClick={doToggle}",
    replace: "          <button disabled={busy || totalHeld > 0} onClick={doToggle}",
    test: "src/components/stock/productActions.render.test.jsx",
  },
  {
    name: "BUILD 4 · zeroing happens SILENTLY as part of deactivating",
    file: "src/components/stock/ProductActions.jsx",
    find: "            <button disabled={busy} onClick={() => setConfirmZero(true)}",
    replace: "            <button disabled={busy} onClick={() => doZero()}",
    test: "src/components/stock/productActions.render.test.jsx",
  },
  {
    name: "BUILD 4 · cells are written outside applyMovement's precondition",
    file: "src/components/stock/ProductActions.jsx",
    find: "          expect: { qty: cell.qty },   // refuse if the cell moved since we read it",
    replace: "          // precondition removed",
    test: "src/components/stock/productActions.render.test.jsx",
  },
  {
    name: "BUILD 4 · the stock read becomes a whole-node read of /stock",
    file: "src/components/stock/ProductActions.jsx",
    find: "      const snap = await get(ref(database, `stock/${loc}/${product.id}`)).catch(() => null);",
    replace: "      const snap = await get(ref(database, `stock`)).catch(() => null);",
    test: "src/components/stock/productActions.render.test.jsx",
  },
];

function runTest(file) {
  try {
    execFileSync("npx", ["vitest", "run", file], { cwd: ROOT, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const originals = new Map();
for (const m of MUTATIONS) if (!originals.has(m.file)) originals.set(m.file, fs.readFileSync(F(m.file), "utf8"));

const rows = [];
let broken = 0;
try {
  for (const m of MUTATIONS) {
    const original = originals.get(m.file);
    if (!original.includes(m.find)) {
      rows.push([m.name, "ANCHOR MISSING", m.test]);
      broken += 1;
      continue;
    }
    fs.writeFileSync(F(m.file), original.replace(m.find, m.replace));
    const passedWhileBroken = runTest(m.test);
    fs.writeFileSync(F(m.file), original);
    const passesRestored = runTest(m.test);
    const ok = !passedWhileBroken && passesRestored;
    if (!ok) broken += 1;
    rows.push([m.name, ok ? "PROVEN (fails broken, passes restored)" : `NOT PROVEN (broken:${passedWhileBroken ? "passed" : "failed"} restored:${passesRestored ? "passed" : "failed"})`, m.test]);
    console.log(`${ok ? "✓" : "✗"} ${m.name}`);
  }
} finally {
  for (const [file, src] of originals) fs.writeFileSync(F(file), src);
}

console.log("\n| mutation | result | test |");
console.log("|---|---|---|");
for (const [n, r, t] of rows) console.log(`| ${n} | ${r} | ${t} |`);
console.log(`\n${rows.length - broken}/${rows.length} proven`);
process.exit(broken ? 1 : 0);
