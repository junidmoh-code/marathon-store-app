// ─── FIRST BATCH DIRECT TO SHOP — mutation proof of every key guard ──────────
// Each mutation breaks ONE guard in the shipped code and expects the suite to
// go RED. A guard whose mutation stays GREEN is a guard no test protects —
// that is the finding this harness exists to surface (feedback_mutation_test_
// the_guard_rail). Run from the repo root on a CLEAN tree:
//   node scripts/mutation-proof-first-batch.mjs
// Restores every file from the bytes it captured, never from git.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { requireCleanTree } from "./lib/mutationPreflight.mjs";

const SERVER = "functions/lib/first-batch.cjs";
const CORE = "src/components/stock/firstBatchCore.js";
const SOLVE = "src/components/stock/NetworkTransfer.jsx";
const UNDO = "src/components/stock/solveUndo.js";

const SERVER_TESTS = ["test/first-batch.test.cjs"];
const CORE_TESTS = ["src/components/stock/firstBatchCore.test.js"];
const SOLVE_TESTS = ["src/components/stock/firstBatchSolve.render.test.jsx"];
const UNDO_TESTS = ["src/components/stock/solveUndo.test.js", "src/components/stock/solveUndo.gate.test.js"];

const MUTATIONS = [
  // ── the deferred leg (server) ──────────────────────────────────────────────
  {
    id: "M-LEG-ONCE",
    guard: "a second fire / retry / double tap never raises a second Hub 2 request",
    file: SERVER,
    from: `  if (rr.firstBatch && rr.firstBatch.hub2Leg) return { skipped: "hub2_leg_done", hub2Leg: rr.firstBatch.hub2Leg };`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-LEG-PARTIAL",
    guard: "a partial send raises the leg",
    file: SERVER,
    from: `  const touched = (num(rr.sentQty) || 0) > 0;`,
    to: `  const touched = false;`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-LEG-REMAINDER",
    guard: "the shop's open remainder is served before Hub 2 (sized from what Central still has)",
    file: SERVER,
    from: `  if (!resolved) reserved += Math.max(num(rr.qty) || 0, 0);`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-LEG-CENTRAL-CAP",
    guard: "Hub 2's leg is capped by Central's remainder, never the bare target",
    file: SERVER,
    from: `  const qty = Math.min(deficit, free, cap);`,
    to: `  const qty = Math.min(deficit, cap);`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-LEG-EMPTY",
    guard: "Central empty → no request is created (never an empty one)",
    file: SERVER,
    from: `  if (qty <= 0) {`,
    to: `  if (false) {`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-LEG-ENGINE-DUP",
    guard: "an engine-held Hub 2 lock is detected — no second request beside the engine's",
    file: SERVER,
    from: `  if (held && held.runId !== runId) {`,
    to: `  if (false) {`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-LEG-LOCK-RACE",
    guard: "a lock that lands between the read and the claim still means one request",
    file: SERVER,
    from: `  const ours = !!cur && cur.runId === runId;
  if (!ours) {`,
    to: `  const ours = true;
  if (!ours) {`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-LEG-UNDONE",
    guard: "the Solve's undo raises no Hub 2 leg",
    file: SERVER,
    from: `  if (resolved && rr.cancelReason === SOLVE_UNDONE_REASON) {`,
    to: `  if (false) {`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-LEG-TAG",
    guard: "a row without the firstBatch tag is never touched",
    file: SERVER,
    from: `  if (!rr.createdFrom || rr.createdFrom.firstBatch !== true) return { skipped: "not_first_batch" };`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-LEG-RECURSE",
    guard: "Hub 2's own leg never recurses",
    file: SERVER,
    from: `  if (rr.requestingLocation === FIRST_BATCH_HUB) return { skipped: "hub_leg" };`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-LEG-REAL-TARGET",
    guard: "the Hub 2 target is the engine's own resolveTarget (explicit row outranks the run)",
    file: SERVER,
    from: `    targets: hub2TargetRow ? { [FIRST_BATCH_HUB]: { [pid]: hub2TargetRow } } : {},`,
    to: `    targets: {},`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-SEED-TXN",
    guard: "the Hub 2 seed is create-if-absent — a real quantity landing meanwhile is never overwritten",
    file: SERVER,
    from: `  const res = await db.ref(path).transaction((cur) => (cur ? undefined : seedCell(nowIso)));
  return res.committed;`,
    to: `  await db.ref(path).set(seedCell(nowIso));
  return true;`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-SEED-BEFORE-MARKER",
    guard: "the seed lands BEFORE the atomic request/lock/marker update, so a crash never strands a marker without a cell",
    file: SERVER,
    from: `  if (seedNeeded) await seedIfAbsent(db, seedPath, now);
  const upd = {
    [\`refill_requests/\${key}\`]: hubRequest,`,
    to: `  const upd = {
    [\`refill_requests/\${key}\`]: hubRequest,`,
    nodeTests: SERVER_TESTS,
  },
  // ── the open-request guard (server) ───────────────────────────────────────
  {
    id: "M-GUARD-SHOP-LOCK",
    guard: "the shop's open Central request holds an engine lock (no hub2->shop while open)",
    file: SERVER,
    from: `    const r = await claimShopLock({ db, rr, requestId, pid, sizeKey, store, runId, now });
    return { skipped: "open_untouched", lock: r };`,
    to: `    return { skipped: "open_untouched", lock: { claimed: true } };`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-GUARD-SOURCE",
    guard: "the shop's lock names Central as its source",
    file: SERVER,
    from: `  const mine = { qty: Math.max(num(rr.qty) || 1, 1), source: SOURCE, createdAt: now, runId, refillId: requestId, orderId: null, orderCreatedAt: null };`,
    to: `  const mine = { qty: Math.max(num(rr.qty) || 1, 1), createdAt: now, runId, refillId: requestId, orderId: null, orderCreatedAt: null };`,
    nodeTests: SERVER_TESTS,
  },
  // ── the Solve (client) ─────────────────────────────────────────────────────
  {
    id: "M-SOLVE-NO-HUB-SEED",
    guard: "Hub 2 is NOT seeded for a size Central can send",
    file: CORE,
    from: `  for (const l of split.firstBatch) seed(store, l.size);`,
    to: `  for (const l of split.firstBatch) { seed(store, l.size); seed(FIRST_BATCH_HUB, l.size); }`,
    tests: [...CORE_TESTS, ...SOLVE_TESTS],
  },
  {
    id: "M-SOLVE-MAPPED-OUT",
    guard: "a mapped category (unscoped Hub 2 leg) stays on the old path",
    file: CORE,
    from: `    if (legs.includes(FIRST_BATCH_HUB) && !(hubLeg && hubLeg.carriedOnly === true)) return false;`,
    to: ``,
    tests: [...CORE_TESTS, ...SOLVE_TESTS],
  },
  {
    id: "M-SOLVE-EXPLICIT-OUT",
    guard: "an explicit Hub 2 row stays on the old path",
    file: CORE,
    from: `  if (targets?.[FIRST_BATCH_HUB]?.[product?.id] && Object.keys(targets[FIRST_BATCH_HUB][product.id]).length > 0) return false;`,
    to: ``,
    tests: [...CORE_TESTS, ...SOLVE_TESTS],
  },
  {
    id: "M-SOLVE-ROUTE",
    guard: "only a shop routed via Hub 2 is in scope",
    file: CORE,
    from: `  if (!store || routes?.[store] !== FIRST_BATCH_HUB) return false;`,
    to: `  if (!store) return false;`,
    tests: [...CORE_TESTS, ...SOLVE_TESTS],
  },
  {
    id: "M-SOLVE-CENTRAL-SOURCE",
    guard: "a hub-stranded card stays on the old path",
    file: CORE,
    from: `  if (source !== "central") return false;`,
    to: ``,
    tests: [...CORE_TESTS, ...SOLVE_TESTS],
  },
  {
    id: "M-SOLVE-CAP",
    guard: "the shop's request is capped by Central's stock",
    file: CORE,
    from: `    const qty = Math.min(target, avail, cap);`,
    to: `    const qty = Math.min(target, cap);`,
    tests: [...CORE_TESTS, ...SOLVE_TESTS],
  },
  {
    id: "M-SOLVE-SEED-IF-ABSENT",
    guard: "an existing cell is never overwritten by a seed",
    file: CORE,
    from: `    if (has(loc, sz)) return;`,
    to: ``,
    tests: CORE_TESTS,
  },
  {
    id: "M-SOLVE-ATOMIC",
    guard: "the first-batch Solve writes ONE atomic update (seeds + requests together)",
    file: SOLVE,
    from: `        await update(ref(database), updates);
        setUndoables((l) => [{ key: \`\${card.pid}_\${now}\`, pid: card.pid, name: card.name, store, locs, paths, priorOpen, firstBatch:`,
    to: `        for (const [k, v] of Object.entries(updates)) await update(ref(database), { [k]: v });
        setUndoables((l) => [{ key: \`\${card.pid}_\${now}\`, pid: card.pid, name: card.name, store, locs, paths, priorOpen, firstBatch:`,
    tests: SOLVE_TESTS,
  },
  {
    id: "M-UNDO-CAS",
    guard: "the undo's cancel refuses a row Central already fulfilled or started (CAS, not a blind patch)",
    file: CORE,
    from: `    if (cur.status !== "open" || (Number(cur.sentQty) || 0) > 0) return undefined;`,
    to: ``,
    tests: CORE_TESTS,
  },
  {
    id: "M-LEG-DECLINE-STAMP",
    guard: "Central's Out of Stock on the shop's batch is stamped as a withdrawal, never a shop-level human rejection",
    file: SERVER,
    from: `  const centralDeclined = rr.status === "cancelled" && !rr.cancelReason;`,
    to: `  const centralDeclined = false;`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-LEG-OWN-RESERVATION",
    guard: "a crashed fire's own pending Hub 2 lock is not counted as a Central reservation on the re-fire",
    file: SERVER,
    from: `    if (excludeRunId && entry.runId === excludeRunId) continue;`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-LEG-FULL-VIEW",
    guard: "the Hub 2 target is resolved over Central's and the shop's stock too, not a Hub 2-only view",
    file: SERVER,
    from: `      [SOURCE]: { [pid]: centralCell ? { [sizeKey]: centralCell } : {} },
      [store]: { [pid]: storeCells || {} },`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-LEG-NO-TARGET-SEEDS",
    guard: "no Hub 2 target right now still seeds Hub 2, so the engine can take over later",
    file: SERVER,
    from: `    if (seedNeeded) await seedIfAbsent(db, seedPath, now);
    await reqRef.update({ "firstBatch/hub2Leg": { none: "no_hub2_target", at: now }, ...declineStamp });`,
    to: `    await reqRef.update({ "firstBatch/hub2Leg": { none: "no_hub2_target", at: now }, ...declineStamp });`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-LEG-ENGINE-OFF",
    guard: "a disabled engine / non-live Hub 2 gets a seed, never a lock or request",
    file: SERVER,
    from: `  if (config.enabled !== true || (config.mode && config.mode[FIRST_BATCH_HUB] !== "live")) {`,
    to: `  if (false) {`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-GUARD-RETRY-LOST-CLAIM",
    guard: "a lost shop-lock claim is retried, never recorded as done",
    file: SERVER,
    from: `    if (rr.firstBatch && rr.firstBatch.lock && rr.firstBatch.lock.claimedAt) return { skipped: "open_untouched" };`,
    to: `    if (rr.firstBatch && rr.firstBatch.lock) return { skipped: "open_untouched" };`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-GUARD-STALE-TAKEOVER",
    guard: "a stale first-batch lock (its request no longer open) is taken over",
    file: SERVER,
    from: `    if (staleId && cur.refillId === staleId) return mine;`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-LEG-NULL-HOLE",
    guard: "a null hole in an array-coerced Hub 2 row is an absent cell",
    file: SERVER,
    from: `  const seedNeeded = !hub2Cells || hub2Cells[sizeKey] == null;`,
    to: `  const seedNeeded = !hub2Cells || hub2Cells[sizeKey] === undefined;`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-QUEUE-DECLINE-STAMP",
    guard: "Source's Out of Stock on a first-batch SHOP leg stamps the reason in the SAME write as the cancel",
    file: "src/components/stock/RefillQueue.jsx",
    from: `      [\`refill_requests/\${row.id}/cancelReason\`]: isFirstBatchShopLeg(row._r) ? CENTRAL_DECLINED_REASON : null,`,
    to: `      [\`refill_requests/\${row.id}/cancelReason\`]: null,`,
    tests: ["src/components/stock/firstBatchSourceTab.render.test.jsx"],
  },
  {
    id: "M-UNDO-OWN-LOCK",
    guard: "the undo exempts ONLY this solve's own lock (any other lock still blocks)",
    file: UNDO,
    from: `      if (ownRunId && cur.runId === ownRunId) continue;      // this solve's own leg`,
    to: `      if (ownRunId) continue;      // this solve's own leg`,
    tests: UNDO_TESTS,
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
  if (m.tests?.length) verdicts.push(runVitest(m.tests));
  if (m.nodeTests?.length) verdicts.push(runNodeTests(m.nodeTests));
  const errored = verdicts.find((v) => String(v).startsWith("ERROR"));
  if (errored) return errored;
  return verdicts.includes("FAIL") ? "FAIL" : "PASS";
}

requireCleanTree([...new Set(MUTATIONS.map((m) => m.file))]);

const results = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    results.push({ ...m, mutated: hits === 0 ? "ANCHOR-MISSING" : "ANCHOR-AMBIGUOUS", restored: "-" });
    console.log(`${m.id.padEnd(24)} ANCHOR ${hits === 0 ? "NOT FOUND" : `FOUND ${hits}×`} in ${m.file}`);
    continue;
  }
  let mutated = "?", restored = "?";
  const restore = () => { try { writeFileSync(m.file, original); } catch { /* keep going */ } };
  const onSignal = () => { restore(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    writeFileSync(m.file, original.replace(m.from, () => m.to));
    mutated = runAll(m);
  } finally {
    restore();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  restored = readFileSync(m.file, "utf8") === original ? (runAll(m) === "PASS" ? "PASS" : "FAIL") : "RESTORE-MISMATCH";
  const verdict = mutated === "FAIL" && restored === "PASS" ? "PROVEN" : mutated === "PASS" ? "UNCAUGHT" : "INCONCLUSIVE";
  results.push({ ...m, mutated, restored, verdict });
  console.log(`${m.id.padEnd(24)} mutated=${String(mutated).padEnd(6)} restored=${String(restored).padEnd(6)} → ${verdict}   ${m.guard}`);
}

const proven = results.filter((r) => r.verdict === "PROVEN").length;
console.log(`\n${proven}/${results.length} guards proven.`);
if (proven !== results.length) process.exit(1);
