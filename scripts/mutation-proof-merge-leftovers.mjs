// ─── MUTATION PROOF — break each property on purpose, prove a test catches it ─
// A green suite proves nothing on its own. For every behaviour this branch
// claims, this script edits the SHIPPING source to reintroduce the defect, runs
// the specific test that should catch it, asserts it FAILS, restores the file
// byte-for-byte and asserts it passes again.
//
// The mutation SHAPES are deliberately varied — a deleted guard, an inverted
// condition, a reintroduced cap, a silently-swallowed sign, a stale snapshot,
// a hardcoded hub — because a suite that only survives one kind of edit is
// pinned to the implementation, not to the behaviour.
//
// Usage:  node scripts/mutation-proof-merge-leftovers.mjs
// Exit 0 = every mutation was caught. Exit 1 = at least one was not.

import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const MUTATIONS = [
  // ── PART 1 — SLIDES ────────────────────────────────────────────────────────
  {
    name: "the gate stops honouring a category the config names",
    shape: "condition inverted to a hardcoded list",
    file: "src/components/admin/styleCodeGateLogic.js",
    from: `  return enforced.some((k) => typeof k === "string" && k === categoryKey);`,
    to: `  return categoryKey === "sneakers";`,
    test: "src/components/admin/slidesEnforced.test.js",
    runner: "vitest",
  },
  {
    name: "a malformed config value enforces instead of failing open",
    shape: "fallback removed",
    file: "src/components/admin/styleCodeGateLogic.js",
    from: `  return clean.length ? clean : def;`,
    to: `  return clean;`,
    test: "src/components/admin/slidesEnforced.test.js",
    runner: "vitest",
  },

  // ── PART 2 — THE MERGE SEARCH ──────────────────────────────────────────────
  {
    name: "the result cap comes back",
    shape: "a limit reintroduced",
    file: "src/components/stock/mergeSearch.js",
    from: `  const out = (pool || []).filter((p) => matchesQuery(p, query, identityMap));`,
    to: `  const out = (pool || []).filter((p) => matchesQuery(p, query, identityMap)).slice(0, 12);`,
    test: "src/components/stock/mergeSearch.test.js",
    runner: "vitest",
  },
  {
    name: "an empty query goes back to showing nothing",
    shape: "an early return added",
    file: "src/components/stock/mergeSearch.js",
    from: `  const q = String(rawQuery ?? "").trim();
  if (!q) return true;`,
    to: `  const q = String(rawQuery ?? "").trim();
  if (!q) return false;`,
    test: "src/components/stock/mergeSearch.test.js",
    runner: "vitest",
  },
  {
    name: "codes and aliases stop being searchable",
    shape: "a loop deleted",
    file: "src/components/stock/mergeSearch.js",
    from: `  for (const term of searchTermsFor(product, identityMap)) {`,
    to: `  for (const term of []) {`,
    test: "src/components/stock/mergeSearch.test.js",
    runner: "vitest",
  },
  {
    name: "a merged-away product becomes offerable again",
    shape: "a guard dropped",
    file: "src/components/stock/mergeSearch.js",
    from: `    p && p.id && !isMergedAway(p)`,
    to: `    p && p.id`,
    test: "src/components/stock/mergeSearch.test.js",
    runner: "vitest",
  },
  {
    name: "the footwear filter is dropped and a t-shirt is offered for a shoe",
    shape: "a comparison removed",
    file: "src/components/stock/mergeSearch.js",
    from: `    && (!loserIsFootwear || productIsFootwear(p))`,
    to: `    && true`,
    test: "src/components/stock/mergeSearch.test.js",
    runner: "vitest",
  },
  {
    name: "search rows stop showing where the stock is",
    shape: "a render block emptied",
    file: "src/components/stock/MergeProducts.jsx",
    // Anchored on the line ABOVE too: CellList on the confirm screen holds a
    // byte-identical line, and mutating THAT one proves nothing about the
    // search rows. The first version of this entry did exactly that and the
    // suite (correctly) stayed green.
    from: [
      '  const { codes, aliases } = identityFor(product, identityMap);',
      '  const locs = locationsHolding(product.id, allStock || {});',
    ].join("\n"),
    to: [
      '  const { codes, aliases } = identityFor(product, identityMap);',
      '  const locs = [];',
    ].join("\n"),
    test: "src/components/stock/mergeScreen.render.test.jsx",
    runner: "vitest",
  },
  {
    name: "the CONFIRM screen stops showing each product's stock cells",
    shape: "a render block emptied",
    file: "src/components/stock/MergeProducts.jsx",
    from: [
      'function CellList({ product, allStock, registry }) {',
      '  const locs = locationsHolding(product.id, allStock || {});',
    ].join("\n"),
    to: [
      'function CellList({ product, allStock, registry }) {',
      '  const locs = [];',
    ].join("\n"),
    test: "src/components/stock/mergeScreen.render.test.jsx",
    runner: "vitest",
  },
  {
    name: "the count page stops showing the style code",
    shape: "a component neutered",
    file: "src/components/shared/IdentityLine.jsx",
    from: `  const hasCodes = codes.length > 0;`,
    to: `  const hasCodes = false;`,
    test: "src/components/stock/leftoversLive.render.test.jsx",
    runner: "vitest",
  },

  // ── PART 4 — LEFTOVERS ─────────────────────────────────────────────────────
  {
    name: "a registered product is a leftover again",
    shape: "the exclusion deleted",
    file: "src/components/stock/hubCleanupCore.js",
    from: `    if (isRegistered(p, identityMap)) continue; // carries a code, a claim or an alias`,
    to: `    // exclusion removed`,
    test: "src/components/stock/leftoversRegistered.test.js",
    runner: "vitest",
  },
  {
    name: "only the style-code FIELD counts, aliases and claims ignored",
    shape: "a predicate narrowed to one store",
    file: "src/utils/labelIdentity.js",
    from: `  const entry = entryFor(identityMap, product.id);
  if (!entry) return false;
  return (Array.isArray(entry.c) && entry.c.length > 0)
      || (Array.isArray(entry.a) && entry.a.length > 0);`,
    to: `  return false;`,
    test: "src/components/stock/leftoversRegistered.test.js",
    runner: "vitest",
  },
  {
    name: "an empty identity entry counts as registration",
    shape: "a length check dropped",
    file: "src/utils/labelIdentity.js",
    from: `  return (Array.isArray(entry.c) && entry.c.length > 0)
      || (Array.isArray(entry.a) && entry.a.length > 0);`,
    to: `  return true;`,
    test: "src/utils/labelIdentity.test.js",
    runner: "vitest",
  },
  {
    name: "the leftovers list is frozen at first paint instead of recomputing",
    shape: "a memo dependency removed",
    file: "src/components/stock/HubCleanup.jsx",
    from: `  }, [hub, products, hubStock, registered, allStock, identity.map, identity.ready]);`,
    to: `  }, [hub]);`,
    test: "src/components/stock/leftoversLive.render.test.jsx",
    runner: "vitest",
  },
  {
    name: "a sibling claim stops registering its product",
    shape: "a branch deleted in the server fold",
    file: "functions/lib/label-identity.cjs",
    from: `    for (const sibId of Object.keys(siblings)) {
      if (siblings[sibId]) addCode(map, sibId, codeKey);
    }`,
    to: `    void siblings;`,
    test: "test/label-identity.test.cjs",
    runner: "node",
  },

  // ── PART 5 — THE MERGE DECIDES ─────────────────────────────────────────────
  {
    name: "a counted cell transfers instead of being removed (the double count)",
    shape: "a disposition branch deleted",
    file: "functions/lib/merge-disposition.cjs",
    from: `  if (keys.has(countCellKey(survivorId, sizeKey))) return "remove";`,
    to: `  // branch removed`,
    test: "test/merge-counted-removal.test.cjs",
    runner: "node",
  },
  {
    name: "an UNcounted cell is removed instead of transferred (stock destroyed)",
    shape: "a default inverted",
    file: "functions/lib/merge-disposition.cjs",
    from: `  return "transfer";
}

/**
 * The whole plan, per location`,
    to: `  return "remove";
}

/**
 * The whole plan, per location`,
    test: "test/merge-counted-removal.test.cjs",
    runner: "node",
  },
  {
    name: "a count verified under the LOSER is written off",
    shape: "the loser-side guard removed",
    file: "functions/lib/merge-disposition.cjs",
    from: `  if (keys.has(countCellKey(loserId, sizeKey))) return "transfer";`,
    to: `  // guard removed`,
    test: "test/merge-counted-removal.test.cjs",
    runner: "node",
  },
  {
    name: "hub 1 is hardcoded instead of driven by the count records",
    shape: "a literal substituted for the data",
    file: "functions/lib/merge-disposition.cjs",
    from: `      const d = dispositionForCell({ loserId, survivorId, sizeKey, countedKeys });`,
    to: `      const d = loc === "hub1" ? "remove" : "transfer";`,
    test: "test/merge-disposition.test.cjs",
    runner: "node",
  },
  {
    name: "a staled count record authorises a removal",
    shape: "a validity check weakened",
    file: "functions/lib/merge-disposition.cjs",
    from: `  return !!rec && !rec.staleAt && rec.settled !== false;`,
    to: `  return !!rec;`,
    test: "test/merge-counted-removal.test.cjs",
    runner: "node",
  },
  {
    name: "an OLD session's counts are used instead of the live one",
    shape: "a lookup broadened",
    file: "functions/lib/product-merge.cjs",
    from: [
      '      const node = await readOrRefuse(db, `${COUNTED_PATH}/${loc}/${sessionId}`,',
      '        `The count records at ${loc} could not be read — merge refused rather than guessed.`);',
      '      countedByLoc[loc] = countedCellKeys(node);',
    ].join("\n"),
    to: [
      '      const all = (await db.ref(`${COUNTED_PATH}/${loc}`).get()).val() || {};',
      '      countedByLoc[loc] = countedCellKeys(Object.assign({}, ...Object.values(all)));',
    ].join("\n"),
    test: "test/merge-counted-removal.test.cjs",
    runner: "node",
  },
  {
    name: "a removal becomes a silent deletion with no ledger movement",
    shape: "a write dropped",
    file: "functions/lib/product-merge.cjs",
    from: [
      '          updates[`stock_movements/${mvIdL}`] = {',
      '            productId: loserId, type: "adjustment", size: rawSize, qty: Math.abs(q),',
    ].join("\n"),
    to: [
      '          const _skipped = {',
      '            productId: loserId, type: "adjustment", size: rawSize, qty: Math.abs(q),',
    ].join("\n"),
    test: "test/merge-counted-removal.test.cjs",
    runner: "node",
  },
  {
    name: "a negative cell is clamped to zero on the way across",
    shape: "a sign swallowed",
    file: "functions/lib/product-merge.cjs",
    from: '        updates[`${cellPath}/qty`] = sQ + q;',
    to: '        updates[`${cellPath}/qty`] = Math.max(0, sQ + q);',
    test: "test/merge-counted-removal.test.cjs",
    runner: "node",
  },
  {
    name: "a merge refuses a location again (the Pine guard returns)",
    shape: "a guard reintroduced",
    file: "functions/lib/product-merge.cjs",
    from: `    const loserCells = {};    // { loc: { sizeKey: cell } }`,
    to: [
      '    for (const loc of ["marathon-pine", "hub3"]) {',
      '      if ((await db.ref(`stock/${loc}/${loserId}`).get()).val()',
      '       || (await db.ref(`stock/${loc}/${survivorId}`).get()).val()) {',
      '        throw new MergeRefused("failed-precondition", `a product holds stock at ${loc}.`);',
      '      }',
      '    }',
      '    const loserCells = {};    // { loc: { sizeKey: cell } }',
    ].join("\n"),
    test: "test/merge-counted-removal.test.cjs",
    runner: "node",
  },
  {
    name: "the merge stops being one atomic update",
    shape: "a single commit split in two",
    file: "functions/lib/product-merge.cjs",
    from: `    await db.ref().update(updates);`,
    to: `    const ks = Object.keys(updates);
    await db.ref().update(Object.fromEntries(ks.slice(0, 1).map((k) => [k, updates[k]])));
    await db.ref().update(Object.fromEntries(ks.slice(1).map((k) => [k, updates[k]])));`,
    test: "test/merge-counted-removal.test.cjs",
    runner: "node",
  },
  {
    name: "the client's preview drifts from the server's decision",
    shape: "one copy of a mirrored rule edited",
    file: "src/components/stock/mergeDisposition.js",
    from: `  if (keys.has(countCellKey(loserId, sizeKey))) return "transfer";`,
    to: `  // the mirror drifts`,
    test: "test/merge-disposition-differential.test.cjs",
    runner: "node",
  },
  {
    name: "the confirm screen commits before the outcome is known",
    shape: "a disabled gate loosened",
    file: "src/components/stock/MergeProducts.jsx",
    from: `    if (plan === null || plan === PLAN_ERROR) {
      setError("The outcome hasn't been worked out yet — nothing was changed.");
      return;
    }`,
    to: `    // guard removed`,
    test: "src/components/stock/mergeScreen.render.test.jsx",
    runner: "vitest",
  },
  {
    name: "the screen stops stating what will be removed",
    shape: "a sentence emptied",
    file: "src/components/stock/mergeDisposition.js",
    from: '      text: `${row.removeQty} at ${locLabel} will be removed — already counted under this product`,',
    to: '      text: "something happens",',
    test: "src/components/stock/mergeScreen.render.test.jsx",
    runner: "vitest",
  },
  {
    name: "a badly-categorised shoe loses access to its sneaker twin",
    shape: "a one-directional filter made symmetric again",
    file: "src/components/stock/mergeSearch.js",
    from: `    && (!loserIsFootwear || productIsFootwear(p))`,
    to: `    && productIsFootwear(p) === loserIsFootwear`,
    test: "src/components/stock/mergeSearch.test.js",
    runner: "vitest",
  },
  {
    name: "nameless products lead the default list again",
    shape: "a sort comparator reverted",
    file: "src/components/stock/mergeSearch.js",
    from: `    if (!an !== !bn) return an ? -1 : 1;`,
    to: `    // nameless rows sort first again`,
    test: "src/components/stock/mergeSearch.test.js",
    runner: "vitest",
  },
  {
    name: "a nameless row renders as a blank card",
    shape: "a fallback label removed",
    file: "src/components/stock/mergeSearch.js",
    from: '  return `(no name \u2014 id ${product && product.id ? String(product.id) : "unknown"})`;',
    to: `  return "";`,
    test: "src/components/stock/mergeSearch.test.js",
    runner: "vitest",
  },
  {
    name: "a failed plan claims the loser holds no stock and lets the merge fire",
    shape: "an error state collapsed onto the empty one",
    file: "src/components/stock/MergeProducts.jsx",
    from: `        if (alive) { setPlanFailed(Object.keys(loserCells)); setPlan(PLAN_ERROR); }`,
    to: `        if (alive) { setPlanFailed(Object.keys(loserCells)); setPlan([]); }`,
    test: "src/components/stock/mergeScreen.render.test.jsx",
    runner: "vitest",
  },
  {
    name: "an unreadable count node is silently treated as 'nothing counted'",
    shape: "a fail-closed read made fail-soft",
    file: "functions/lib/product-merge.cjs",
    from: [
      '    return (await db.ref(path).get()).val();',
      '  } catch (err) {',
      '    throw new MergeRefused("failed-precondition", `${message} (${err && err.message ? err.message : err})`);',
      '  }',
    ].join("\n"),
    to: [
      '    return (await db.ref(path).get()).val();',
      '  } catch {',
      '    return null;',
      '  }',
    ].join("\n"),
    test: "test/merge-counted-removal.test.cjs",
    runner: "node",
  },
  {
    name: "a removal commits on a count record that was staled mid-merge",
    shape: "a fence loop deleted",
    file: "functions/lib/product-merge.cjs",
    from: `      if (!countRecordCounts(removalLive[i].val())) {`,
    to: `      if (false) {`,
    test: "test/merge-counted-removal.test.cjs",
    runner: "node",
  },
  {
    name: "a superseded identity response overwrites a just-filed registration",
    shape: "a version guard removed",
    file: "src/utils/labelIdentityStore.js",
    from: `        if (startedAt === version) latest = map;   // otherwise superseded — discard`,
    to: `        latest = map;`,
    test: "src/utils/labelIdentityStore.test.js",
    runner: "vitest",
  },
  {
    name: "every registration costs a full 150KB refetch again",
    shape: "a patch turned back into an invalidate",
    file: "src/utils/labelIdentityStore.js",
    from: `  if (c.length === prev.c.length && a.length === prev.a.length) return;
  latest = { ...latest, [productId]: { c, a } };`,
    to: `  if (c.length === prev.c.length && a.length === prev.a.length) return;
  needsFetch = true;`,
    test: "src/utils/labelIdentityStore.test.js",
    runner: "vitest",
  },
  {
    name: "a hostile product id breaks the whole identity map",
    shape: "a null prototype removed",
    file: "functions/lib/label-identity.cjs",
    from: `  const map = Object.create(null);`,
    to: `  const map = {};`,
    test: "test/label-identity.test.cjs",
    runner: "node",
  },
  // NOT LISTED — "an inherited key fakes a registration". The hasOwnProperty
  // guard in utils/labelIdentity.entryFor is defence in depth, not a behaviour.
  // This script tried it (run of 2026-08-23): replacing the whole guarded
  // lookup with a bare `identityMap[id]` was NOT caught, and correctly so —
  // with a pristine Object.prototype an inherited value is a function that
  // carries no `c`/`a` arrays, so isRegistered/identityFor/registrationRoute
  // return exactly the same thing either way. A mutation that changes nothing
  // observable cannot be caught by a behavioural test, and claiming a catch
  // would be the structural pin this script exists to avoid.
  // labelIdentity.test.js:77 keeps the OUTCOME pinned; the guard stays because
  // a polluted prototype is cheap to defend against.
];

function run(m) {
  const cmd = m.runner === "vitest"
    ? `npx vitest run ${m.test}`
    : `cd functions && node --test ${m.test}`;
  try {
    execSync(cmd, { cwd: ROOT, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

let failures = 0;
const rows = [];

for (const m of MUTATIONS) {
  const path = join(ROOT, m.file);
  const original = readFileSync(path, "utf8");
  if (!original.includes(m.from)) {
    console.error(`SETUP FAILED: anchor not found in ${m.file}\n  ${m.from.split("\n")[0]}`);
    failures += 1;
    rows.push({ ...m, caught: "ANCHOR MISSING" });
    continue;
  }
  writeFileSync(path, original.replace(m.from, m.to));
  const passedWhileBroken = run(m);
  writeFileSync(path, original);
  const passedWhenRestored = run(m);

  const caught = !passedWhileBroken && passedWhenRestored;
  if (!caught) failures += 1;
  rows.push({
    ...m,
    caught: caught ? "yes" : (passedWhileBroken ? "NO — test passed with the bug in" : "NO — still failing after restore"),
  });
  console.log(`${caught ? "✓" : "✗"} ${m.name}  [${m.shape}]  → ${m.test}`);
}

console.log("\n| # | Property broken | Mutation shape | Test | Failed while broken | Passed on restore |");
console.log("|---|---|---|---|---|---|");
rows.forEach((r, i) => {
  console.log(`| ${i + 1} | ${r.name} | ${r.shape} | \`${r.test}\` | ${r.caught === "yes" ? "yes" : r.caught} | ${r.caught === "yes" ? "yes" : "—"} |`);
});

console.log(`\n${rows.length - failures}/${rows.length} mutations caught.`);
process.exit(failures ? 1 : 0);
