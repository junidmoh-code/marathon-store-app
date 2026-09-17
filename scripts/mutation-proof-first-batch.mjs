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

const TAB = "src/components/stock/missingProductsCore.js";
const PLAN = "src/components/stock/solvePlan.js";

const SERVER_TESTS = ["test/first-batch.test.cjs", "test/first-batch-categories.test.cjs"];
const CORE_TESTS = ["src/components/stock/firstBatchCore.test.js"];
const SOLVE_TESTS = ["src/components/stock/firstBatchSolve.render.test.jsx"];
const UNDO_TESTS = ["src/components/stock/solveUndo.test.js", "src/components/stock/solveUndo.gate.test.js"];
const TAB_TESTS = ["src/components/stock/missingProductsCore.test.js"];
// The incident revert (PR #609): the path OFF on both sides, the shop tabs'
// origin filter, the server backstop.
const QUEUE = "src/components/stock/RefillQueue.jsx";
const OFF_SERVER_TESTS = ["test/first-batch-off.test.cjs"];
const OFF_CLIENT_TESTS = ["src/components/stock/firstBatchCore.test.js", "src/components/stock/firstBatchGuard.render.test.jsx"];
const GUARD_SERVER_TESTS = ["test/first-batch-guard.test.cjs", "test/first-batch-categories.test.cjs", "test/first-batch-fuzz.test.cjs"];
const QUEUE_TESTS = ["src/components/stock/firstBatchSourceTab.render.test.jsx"];

const MUTATIONS = [
  // ── location history informs the split (Phase 3, Commit 6) ────────────────
  {
    id: "M-HIST-SPLIT-USED",
    guard: "the Solve passes history's size hints to the split",
    file: SOLVE,
    from: `      sizeHints,\n    });`,
    to: `    });`,
    tests: SOLVE_TESTS,
  },
  {
    id: "M-HIST-SPLIT-HELD",
    guard: "a size hinted 'hub' takes the normal path and is reported as held",
    file: CORE,
    from: `    if (qty > 0 && hint && hint.to === "hub") { normal.push(size); held.push({ size, why: hint.why || null }); continue; }`,
    to: ``,
    tests: [...CORE_TESTS, ...SOLVE_TESTS],
  },
  {
    id: "M-HIST-SPLIT-FLOOR",
    guard: "the category's placement has a say only from MIN_LINES_FOR_SIZE_HINT lines",
    file: CORE,
    from: `    if ((h.categoryCarried || 0) >= minLines) {`,
    to: `    if ((h.categoryCarried || 0) >= 1) {`,
    tests: CORE_TESTS,
  },
  {
    id: "M-HIST-SPLIT-SIBLINGS-FIRST",
    guard: "colourway siblings at the shop outrank the category's size placement",
    file: CORE,
    from: `    if (h.siblingCells > 0) {\n      const n = h.siblingSizes?.[sk] || 0;`,
    to: `    if (false) {\n      const n = h.siblingSizes?.[sk] || 0;`,
    tests: CORE_TESTS,
  },
  {
    id: "M-HIST-SPLIT-SIZE-KEY",
    guard: "the size hint looks the shop's cells up by the stored size key (one-size '_' included)",
    file: CORE,
    from: `    const sk = stockSizeKey(size);\n    if (h.siblingCells > 0) {`,
    to: `    const sk = size;\n    if (h.siblingCells > 0) {`,
    tests: CORE_TESTS,
  },
  {
    id: "M-HIST-SPLIT-NEVER-ADDS",
    guard: "a hint never adds a size Central has none of",
    file: CORE,
    from: `    if (qty > 0) firstBatch.push({ size, qty, target, avail });\n    else normal.push(size);`,
    to: `    if (qty > 0 || (hint && hint.to === "shop")) firstBatch.push({ size, qty: Math.max(qty, 1), target, avail });\n    else normal.push(size);`,
    tests: CORE_TESTS,
  },
  // ── the Hub 2-presence guard (Phase 3) ─────────────────────────────────────
  {
    id: "M-GUARD-CLIENT-FAIL-CLOSED",
    guard: "firstBatchEligible fails CLOSED: anything but an explicit hub2Present:false is ineligible",
    file: CORE,
    from: `  if (present !== false) return false;`,
    to: `  if (present === true) return false;`,
    tests: [...CORE_TESTS, ...OFF_CLIENT_TESTS],
  },
  {
    id: "M-GUARD-CLIENT-PASSED",
    guard: "the Solve passes the REAL presence (stock node + live locks) to the eligibility test",
    file: SOLVE,
    from: `hub2Present: hub2PresentFor(card.pid, openByLoc) });`,
    to: `hub2Present: false });`,
    tests: [...SOLVE_TESTS, ...OFF_CLIENT_TESTS],
  },
  {
    id: "M-GUARD-CLIENT-LOCK-SIGNAL",
    guard: "an engine lock at Hub 2 is presence (a pending inbound) on the client",
    file: CORE,
    from: `  if (hub2Locks && typeof hub2Locks === "object" && Object.values(hub2Locks).some(priorLock)) signals.push("engine_lock");`,
    to: ``,
    tests: [...CORE_TESTS, ...SOLVE_TESTS, ...OFF_CLIENT_TESTS],
  },
  {
    id: "M-GUARD-CLIENT-OWN-SEED",
    guard: "only THIS Solve's own qty-0 seeds are excluded from presence (a unit in one, or a foreign seed, counts)",
    file: CORE,
    from: `  const ownSeed = (k, c) => own.has(String(k)) && !!c && c.mv === "seed" && !((Number(c.qty) || 0) > 0) && (!ownSeedAt || c.updatedAt === ownSeedAt);`,
    to: `  const ownSeed = (k, c) => !!c && c.mv === "seed";`,
    tests: CORE_TESTS,
  },
  {
    id: "M-GUARD-CLIENT-UNREADABLE",
    guard: "an unreadable lock table is UNKNOWN presence: the write falls to the old Solve",
    file: SOLVE,
    from: `      const split = onPath && openNow ? firstBatchFor(card, store, sizes, openNow) : null;`,
    to: `      const split = onPath ? firstBatchFor(card, store, sizes, openNow || {}) : null;`,
    tests: OFF_CLIENT_TESTS,
  },
  {
    id: "M-GUARD-SEEDED-STAMP",
    guard: "the request records the Hub 2 seeds this Solve wrote (the trigger must not read them as presence)",
    file: CORE,
    from: `        ...(hub2Seeded.length ? { hub2Seeded } : {}),`,
    to: ``,
    tests: CORE_TESTS,
  },
  {
    id: "M-GUARD-LOCK-SINCE",
    guard: "a Hub 2 lock claimed at/after the request's own createdAt is not prior presence (the scan-in-the-gap race)",
    file: SERVER,
    from: `  const priorLock = (e) => !!e && typeof e === "object" && !(Number.isFinite(sinceMs) && e.createdAt && Date.parse(e.createdAt) >= sinceMs);`,
    to: `  const priorLock = (e) => !!e && typeof e === "object";`,
    nodeTests: GUARD_SERVER_TESTS,
  },
  {
    id: "M-GUARD-HELD-INBOUND",
    guard: "a held line in the hold lane (units on the way to Hub 2) is presence",
    file: SERVER,
    from: `    if (lines.some((l) => l && typeof l === "object" && l.productId === pid)) signals.push("held_inbound");`,
    to: ``,
    nodeTests: GUARD_SERVER_TESTS,
  },
  {
    id: "M-GUARD-OWN-SEED-STAMP",
    guard: "a listed own seed must be stamped at the Solve's own time",
    file: SERVER,
    from: `&& (!ownSeedAt || c.updatedAt === ownSeedAt);`,
    to: `;`,
    nodeTests: GUARD_SERVER_TESTS,
  },
  {
    id: "M-GUARD-SERVER-COMMITTED",
    guard: "'already judged' is the server-owned shop lock, never a field on the row",
    file: SERVER,
    from: `  if (!resolved && !touched && !committed) {`,
    to: `  if (!resolved && !touched && !committed && !(rr.firstBatch && rr.firstBatch.lock) && !(rr.firstBatch && rr.firstBatch.hub2Leg)) {`,
    nodeTests: GUARD_SERVER_TESTS,
  },
  {
    id: "M-GUARD-CLIENT-HELD",
    guard: "the Solve reads the hold lane's held lines for Hub 2 as a presence input",
    file: SOLVE,
    from: `    heldLines: openByLoc ? openByLoc.heldHub2 : null, pid,`,
    to: `    heldLines: null, pid,`,
    tests: OFF_CLIENT_TESTS,
  },
  {
    id: "M-GUARD-CLIENT-RAW-LOCKS",
    guard: "the Solve judges presence from the RAW Hub 2 lock node, not the pruned one",
    file: SOLVE,
    from: `    hub2Locks: openByLoc ? (openByLoc.hub2Raw ?? openByLoc[FIRST_BATCH_HUB]) : null,`,
    to: `    hub2Locks: openByLoc ? openByLoc[FIRST_BATCH_HUB] : null,`,
    tests: OFF_CLIENT_TESTS,
  },
  {
    id: "M-GUARD-SERVER-CHECK",
    guard: "the trigger re-checks Hub 2 presence at creation and withdraws a request Hub 2 already holds",
    file: SERVER,
    from: `    if (signals.length) {`,
    to: `    if (false) {`,
    nodeTests: GUARD_SERVER_TESTS,
  },
  {
    id: "M-GUARD-SERVER-ONCE",
    guard: "presence is judged ONCE, before any lock is claimed — never on a later write",
    file: SERVER,
    from: `  if (!resolved && !touched && !committed) {`,
    to: `  if (!resolved && !touched) {`,
    nodeTests: GUARD_SERVER_TESTS,
  },
  {
    id: "M-GUARD-SERVER-OWN-SEED",
    guard: "the server excludes only the Solve's own listed seeds (hub2Seeded)",
    file: SERVER,
    from: `    const signals = hub2PresenceSignals({ hub2Node, hub2Locks, ownSeedKeys: rr.createdFrom.hub2Seeded || [], ownSeedAt: rr.createdAt, sinceIso: rr.createdAt, heldLines, pid });`,
    to: `    const signals = hub2PresenceSignals({ hub2Node, hub2Locks, ownSeedKeys: Object.keys(hub2Node || {}), ownSeedAt: null, sinceIso: rr.createdAt, heldLines, pid });`,
    nodeTests: GUARD_SERVER_TESTS,
  },
  {
    id: "M-GUARD-SERVER-LOCK-SIGNAL",
    guard: "an engine lock at Hub 2 is presence on the server",
    file: SERVER,
    from: `    const signals = hub2PresenceSignals({ hub2Node, hub2Locks, ownSeedKeys: rr.createdFrom.hub2Seeded || [], ownSeedAt: rr.createdAt, sinceIso: rr.createdAt, heldLines, pid });`,
    to: `    const signals = hub2PresenceSignals({ hub2Node, hub2Locks: null, ownSeedKeys: rr.createdFrom.hub2Seeded || [], ownSeedAt: rr.createdAt, sinceIso: rr.createdAt, heldLines, pid });`,
    nodeTests: GUARD_SERVER_TESTS,
  },
  {
    id: "M-GUARD-SERVER-REASON",
    guard: "the presence withdrawal carries its own reason (first_batch_hub2_present)",
    file: SERVER,
    from: `      const r = await withdrawToOldSolve({ reason: HUB2_PRESENT_REASON, none: "hub2_present", product });`,
    to: `      const r = await withdrawToOldSolve({ reason: PATH_OFF_REASON, none: "hub2_present", product });`,
    nodeTests: GUARD_SERVER_TESTS,
  },
  // ── the incident revert (PR #609) ──────────────────────────────────────────
  {
    id: "M-OFF-CLIENT",
    guard: "the path is OFF: no Solve takes the first-batch branch unless enabled: true is passed",
    file: CORE,
    from: `  if (enabled !== true) return false;`,
    to: ``,
    tests: OFF_CLIENT_TESTS,
  },
  {
    id: "M-OFF-STRICT",
    guard: "the flag is judged strictly — a truthy string never turns the path on",
    file: CORE,
    from: `  if (enabled !== true) return false;`,
    to: `  if (!enabled) return false;`,
    tests: OFF_CLIENT_TESTS,
  },
  {
    id: "M-OFF-NO-LOCK-READS",
    guard: "a card the path cannot take reads nothing from the engine's lock table",
    file: SOLVE,
    from: `    if (!openCard || !STORES.some((s) => eligibleAt(openCard, s, undefined))) return undefined;`,
    to: ``,
    tests: OFF_CLIENT_TESTS,
  },
  {
    id: "M-TAB-ORIGIN-FILTER",
    guard: "a shop tab lists first-batch shop legs ONLY — never the engine's hub2→shop rows (the incident)",
    file: QUEUE,
    from: `    let mine = allRequests.filter((r) => r.requestingLocation === DEST_LOC && sourceQueueLists(r, SHOP_DESTS));`,
    to: `    let mine = allRequests.filter((r) => r.requestingLocation === DEST_LOC && sourceQueueLists(r, new Set()));`,
    tests: QUEUE_TESTS,
  },
  {
    id: "M-BADGE-ORIGIN",
    guard: "the badge counts a shop's first-batch legs only — 225 engine rows count 0",
    file: CORE,
    from: `shopLocs.includes?.(r.requestingLocation)) ? isFirstBatchShopLeg(r) : true);`,
    to: `shopLocs.includes?.(r.requestingLocation)) ? true : true);`,
    tests: QUEUE_TESTS,
  },
  {
    id: "M-SERVER-OFF",
    guard: "the trigger's path-off backstop runs under the live default",
    file: SERVER,
    from: `  if (!resolved && !touched && pathEnabled !== true) {`,
    to: `  if (false) {`,
    nodeTests: OFF_SERVER_TESTS,
  },
  {
    id: "M-SERVER-OFF-SEED",
    guard: "a withdrawal to the old Solve seeds Hub 2 first (Hub 2 stays a valid source)",
    file: SERVER,
    from: `    if (product) await seedIfAbsent(db, \`stock/\${FIRST_BATCH_HUB}/\${pid}/\${sizeKey}\`, now);`,
    to: ``,
    nodeTests: [...OFF_SERVER_TESTS, ...GUARD_SERVER_TESTS],
  },
  {
    id: "M-SERVER-OFF-CAS",
    guard: "the withdrawal re-verifies open-and-untouched INSIDE the transaction (Central's fulfil in the gap wins)",
    file: SERVER,
    from: `      if (cur.status !== "open" || (num(cur.sentQty) || 0) > 0 || (cur.sentQty != null && typeof cur.sentQty !== "number")) return undefined;`,
    to: ``,
    nodeTests: OFF_SERVER_TESTS,
  },
  {
    id: "M-SERVER-OFF-PRODUCT-GONE",
    guard: "a product gone from the catalogue gets no Hub 2 carriage cell",
    file: SERVER,
    from: `    if (product) await seedIfAbsent(`,
    to: `    if (true) await seedIfAbsent(`,
    nodeTests: [...OFF_SERVER_TESTS, ...GUARD_SERVER_TESTS],
  },
  {
    id: "M-SERVER-OFF-SHOP-ONLY",
    guard: "the backstop touches only a destination routed via Hub 2",
    file: SERVER,
    from: `    if (((offConfig.routes || {})[store]) !== FIRST_BATCH_HUB) return { skipped: "path_off_not_shop", store };`,
    to: ``,
    nodeTests: OFF_SERVER_TESTS,
  },
  {
    id: "M-SERVER-OFF-TOUCHED-SHAPE",
    guard: "a sentQty of an unexpected shape counts as touched",
    file: SERVER,
    from: `  const touched = (num(rr.sentQty) || 0) > 0 || (rr.sentQty != null && typeof rr.sentQty !== "number");`,
    to: `  const touched = (num(rr.sentQty) || 0) > 0;`,
    nodeTests: OFF_SERVER_TESTS,
  },
  {
    id: "M-SERVER-OFF-REASON",
    guard: "the withdrawal carries a reason — to the engine a bare cancel is a shop-level rejection",
    file: SERVER,
    from: `      return { ...cur, status: "cancelled", cancelReason: reason, resolvedAt: now,`,
    to: `      return { ...cur, status: "cancelled", resolvedAt: now,`,
    nodeTests: [...OFF_SERVER_TESTS, ...GUARD_SERVER_TESTS],
  },
  {
    id: "M-SERVER-LOCK-OWN-ONLY",
    guard: "the backstop releases only the shop lock that names THIS request",
    file: SERVER,
    from: `return cur && cur.refillId === requestId ? null : undefined; })`,
    to: `return cur ? null : undefined; })`,
    nodeTests: OFF_SERVER_TESTS,
  },
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
    from: `  const touched = (num(rr.sentQty) || 0) > 0 || (rr.sentQty != null && typeof rr.sentQty !== "number");`,
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
    guard: "Hub 2 IS seeded for every first-batch size (Hub 2 always a valid source)",
    file: CORE,
    from: `  for (const l of split.firstBatch) { if (seed(FIRST_BATCH_HUB, l.size)) hub2Seeded.push(stockSizeKey(l.size)); seed(store, l.size); }`,
    to: `  for (const l of split.firstBatch) seed(store, l.size);`,
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
    from: `    if (has(loc, sz)) return false;`,
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
    from: `    if (committed) return { skipped: "open_untouched" };`,
    to: `    if (committed || (rr.firstBatch && rr.firstBatch.lock)) return { skipped: "open_untouched" };`,
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
    id: "M-UNDO-RETRY",
    guard: "a retry after a partial undo treats its own landed cancel as done, not as a blocker",
    file: CORE,
    from: `    if (r.status === "cancelled" && r.cancelReason === SOLVE_UNDONE_REASON) continue;`,
    to: ``,
    tests: CORE_TESTS,
  },
  {
    id: "M-SOLVE-PROBE-KEY",
    guard: "the seed existence probe uses the path's own encoder (stockSizeKey)",
    file: CORE,
    from: `  const has = (loc, sz) => existing?.[loc]?.[stockSizeKey(sz)] != null;`,
    to: `  const has = (loc, sz) => existing?.[loc]?.[String(sz).replace(/[.#$/\\[\\]\\s]/g, "_")] != null;`,
    tests: CORE_TESTS,
  },
  {
    id: "M-UNDO-OPEN-ONLY",
    guard: "the undo re-runs the cancel CAS only on rows still open (a retry never re-CASes its own landed cancel)",
    file: SOLVE,
    from: `        const ids = Object.keys(liveFb).filter((id) => liveFb[id] && liveFb[id].status === "open");`,
    to: `        const ids = Object.keys(liveFb).filter((id) => liveFb[id]);`,
    tests: SOLVE_TESTS,
  },
  {
    id: "M-UNDO-OWN-LOCK",
    guard: "the undo exempts ONLY this solve's own lock (any other lock still blocks)",
    file: UNDO,
    from: `      if (ownRunId && cur.runId === ownRunId) continue;      // this solve's own leg`,
    to: `      if (ownRunId) continue;      // this solve's own leg`,
    tests: UNDO_TESTS,
  },
  // ── every category except sneakers and slides (2026-09-17) ─────────────────
  {
    id: "M-SCOPE-SNEAKER",
    guard: "sneakers and slides never take the first-batch path",
    file: CORE,
    from: `  if (isSneakerOrSlide(product)) return false;\n  return true;`,
    to: `  return true;`,
    tests: CORE_TESTS,
  },
  {
    id: "M-SCOPE-SLIDES-KEY",
    guard: "slides are excluded by key, not only sneakers",
    file: CORE,
    from: `export const EXCLUDED_KEYS = Object.freeze(["sneakers", "slides"]);`,
    to: `export const EXCLUDED_KEYS = Object.freeze(["sneakers"]);`,
    tests: CORE_TESTS,
  },
  {
    id: "M-SCOPE-LEGACY-SLIDE",
    guard: "a keyless legacy slide (Footwear + Sandals & Slides) is a slide",
    file: CORE,
    from: `  return p.category === "Footwear" && p.subcategory === "Sandals & Slides";`,
    to: `  return false;`,
    tests: CORE_TESTS,
  },
  {
    id: "M-TAB-GATE",
    guard: "the Missing Products tab keeps the footwear group out (and admits everything else)",
    file: TAB,
    from: `export const admitsMissingProduct = (p) => !!p && !inFootwearGroup(p);`,
    to: `export const admitsMissingProduct = (p) => !!p;`,
    tests: TAB_TESTS,
  },
  {
    id: "M-TAB-CLOTHING-FIRST",
    guard: "a clothing-typed record is clothing whatever its category says (the engine's precedence)",
    file: TAB,
    from: `  if (!p || isClothing(p)) return false;\n  if (p.category === "Footwear") return true;`,
    to: `  if (!p) return false;\n  if (p.category === "Footwear") return true;`,
    tests: TAB_TESTS,
  },
  // ── location history ───────────────────────────────────────────────────────
  {
    id: "M-HIST-OWN-ROW-POSITIVE",
    guard: "an explicit 0 row is 'deliberately excluded', never a seat",
    file: CORE,
    from: `Object.values(rows).some((r) => r && typeof r.target === "number" && r.target > 0);`,
    to: `Object.values(rows).some((r) => r && typeof r.target === "number" && r.target >= 0);`,
    tests: CORE_TESTS,
  },
  {
    id: "M-HIST-SIBLINGS-TIER",
    guard: "colourway siblings outrank the category prior",
    file: CORE,
    from: `    || pick((h) => h.siblingCells * 1000 + h.siblingUnits, "siblings",`,
    to: `    || pick(() => 0, "siblings",`,
    tests: CORE_TESTS,
  },
  {
    id: "M-HIST-TIE",
    guard: "a tie at a tier falls through instead of nominating the first candidate",
    file: CORE,
    from: `      else if (v === bestScore && v > 0) tie = true;`,
    to: ``,
    tests: CORE_TESTS,
  },
  {
    id: "M-HIST-CANDIDATES",
    guard: "history only orders the shops the policy allows",
    file: CORE,
    from: `  const cands = (candidates || []).filter((s) => history?.byStore?.[s]);`,
    to: `  const cands = Object.keys(history?.byStore || {});`,
    tests: CORE_TESTS,
  },
  {
    id: "M-HIST-USED",
    guard: "the Solve's default nomination IS the history choice",
    file: SOLVE,
    from: `  const defaultStoreFor = (card) => storeChoiceFor(card).store;`,
    to: `  const defaultStoreFor = (card) => (STORES.find((s) => qualifyingSizes(card, s).length > 0) || STORES[0]);`,
    tests: SOLVE_TESTS,
  },
  // ── Central's open reservations ────────────────────────────────────────────
  {
    id: "M-RESERVE-SOURCE",
    guard: "only locks whose source is Central reserve Central (a hub2->shop lock does not)",
    file: CORE,
    from: `      if (src !== source) continue;`,
    to: ``,
    tests: CORE_TESTS,
  },
  {
    id: "M-RESERVE-NET",
    guard: "Central free = on-hand minus the reservation (a promised unit is never asked for twice)",
    file: CORE,
    from: `  Math.max((Number(typeof qtyAt === "function" ? qtyAt(size) : 0) || 0) - (reserved?.[lockKeyFor(size)] || 0), 0);`,
    to: `  Math.max((Number(typeof qtyAt === "function" ? qtyAt(size) : 0) || 0), 0);`,
    tests: [...CORE_TESTS, ...SOLVE_TESTS],
  },
  {
    id: "M-SOLVE-LIVE-LOCKS",
    guard: "the write re-reads the lock table live, never the panel's earlier read",
    file: SOLVE,
    from: `    if (onPath) { try { openNow = await readOpenLocks(card.pid); } catch { openNow = null; } }`,
    to: `    if (onPath) openNow = openLocks[card.pid] || {};`,
    tests: SOLVE_TESTS,
  },
  {
    id: "M-SOLVE-GATE",
    guard: "the confirm waits for the lock read so the estimate shown is the request written",
    file: SOLVE,
    from: `        }) || (fbSplit && !locksReadyFor(card.pid) ? "One moment — checking what Central has already promised…" : null)) : null;`,
    to: `        }) || null) : null;`,
    tests: SOLVE_TESTS,
  },
  {
    id: "M-RESERVE-PRUNE",
    guard: "a lock whose request is gone / fulfilled / cancelled is not a Central reservation",
    file: CORE,
    from: `        if (!r || r.status !== "open") continue;   // gone, fulfilled or cancelled → not a reservation`,
    to: ``,
    tests: [...CORE_TESTS, ...SOLVE_TESTS],
  },
  {
    id: "M-RESERVE-LOCK-KEY",
    guard: "the reservation lookup uses the engine's lock key (trimmed, blank → '_')",
    file: CORE,
    from: `export const lockKeyFor = (size) => { const k = String(size ?? "").trim(); return k ? encodeSizeKey(k) : "_"; };`,
    to: `export const lockKeyFor = (size) => encodeSizeKey(size);`,
    tests: CORE_TESTS,
  },
  {
    id: "M-MAP-SIZES",
    guard: "a per-location size map (soccer-jerseys / underwear) arms the sizes it names on the client, as the engine does",
    file: PLAN,
    from: `    if (isMapEntry(entry)) {
      if (!mapUsable(cat, entry)) continue;`,
    to: `    if (isMapEntry(entry)) {
      continue;`,
    tests: [...CORE_TESTS, ...SOLVE_TESTS],
  },
  {
    id: "M-MAP-GARBLED",
    guard: "an entry with BOTH target and sizes is garbled — the client arms nothing for it, like the engine",
    file: PLAN,
    from: `const isGarbledEntry = (entry) => isMapEntry(entry) && entry.target !== undefined;`,
    to: `const isGarbledEntry = () => false;`,
    tests: CORE_TESTS,
  },
  {
    id: "M-MAP-DEAD-SIZE",
    guard: "a mapped size with zero units anywhere is a dead 0, never re-armed",
    file: PLAN,
    from: `        run[String(sz).toUpperCase()] = at(sz) > 0 ? row.target : 0;`,
    to: `        run[String(sz).toUpperCase()] = row.target;`,
    tests: CORE_TESTS,
  },
  {
    id: "M-SNEAKER-NEVER-SEEDED",
    guard: "a sneaker or slide that reaches the list is never seeded (the old path would arm its carriedOnly Hub 2 policy)",
    file: SOLVE,
    from: `        const solveBlocked = (offTab ? "this is a sneaker or slide — it is refilled from the Sneakers tab, never seeded here." : null) || solveReason({`,
    to: `        const solveBlocked = solveReason({`,
    tests: SOLVE_TESTS,
  },
  {
    id: "M-LEG-MAP-CONFIG",
    guard: "Hub 2's leg for a mapped category is sized by the LIVE map (the real resolveTarget over the real config)",
    file: SERVER,
    from: `  const ctx = {\n    config,`,
    to: `  const ctx = {\n    config: { ...config, categoryPolicy: undefined },`,
    nodeTests: SERVER_TESTS,
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
