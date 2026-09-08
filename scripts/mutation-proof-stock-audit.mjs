// ─── MUTATION PROOF HARNESS — the stock audit ────────────────────────────────
// For each guard: reintroduce the bug, prove the suite FAILS, restore the file,
// prove it PASSES. A test that cannot fail proves nothing, so this runs the
// whole cycle and refuses to report a pass it did not watch break first.
//
// Same discipline as scripts/mutation-proof-push-notify.mjs — ERROR is not
// FAIL, unique anchors, signal-safe restore, clean-tree preflight — and the
// same two runners, because this feature spans both halves: the lists are
// computed server-side (node --test) and actioned client-side (vitest).
//
// The guards worth naming, because each is a way this feature fails QUIETLY:
//   • the kill switch and the once-a-day gate (K1–K5) — a broken gate turns a
//     free feature into a per-run cost nobody would see until the bill
//   • the rotation's ordering (R1–R3) — a starved product is an audit that
//     silently never checks part of the shop
//   • the LIVE-cell base and its `expect` (C1–C3) — an adjustment computed
//     against a day-old number lands the shelf on a figure nobody counted
//   • record-after-write (C4) — a refused correction that still marks the row
//     done takes the phantom off the list and leaves it in the database
//   • the blank quantity (C5) — Number("") is 0, so the emptiest instruction
//     would read as the most destructive one
//
// M45 is not this feature's guard at all; it is the existing 45-day movement
// window, mutated here to prove the fence still bites after this PR touched
// the file it lives in.
//
// Run:  node scripts/mutation-proof-stock-audit.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const LIB = "functions/lib/stock-audit.cjs";
const PASS = "functions/stockAudit/dailyPass.cjs";
const SCAN = "functions/refill-scan.cjs";
const STORE = "src/components/stock/stockAuditStore.js";
const VIEW = "src/components/stock/StockAuditView.jsx";

const LIB_TESTS = ["test/stock-audit.test.cjs"];
const PASS_TESTS = ["test/stock-audit-pass.test.cjs"];
const STORE_TESTS = ["src/components/stock/stockAuditStore.test.js"];
const VIEW_TESTS = ["src/components/stock/StockAuditView.render.test.jsx"];

const MUTATIONS = [
  // ── the kill switch and the day gate ──────────────────────────────────────
  { id: "K1", file: LIB, nodeTests: LIB_TESTS,
    guard: "ABSENT IS OFF — only a real `true` enables the feature, never a truthy string",
    from: `    enabled: c.enabled === true,`, to: `    enabled: !!c.enabled,` },
  { id: "K2", file: LIB, nodeTests: LIB_TESTS,
    guard: "the pass does not run before its SA hour",
    from: `  if (saHour(nowMs) < passHour) return { run: false, saDate, why: "before_pass_hour" };\n`, to: `` },
  { id: "K3", file: LIB, nodeTests: LIB_TESTS,
    guard: "ONCE A DAY — the stored SA date stops every later run of the same day",
    from: `  if (lastPassDate === saDate) return { run: false, saDate, why: "already_ran_today" };\n`, to: `` },
  { id: "K4", file: LIB, nodeTests: LIB_TESTS,
    guard: "the hour is read in SAST, not UTC — a UTC read fires the pass two hours early",
    from: `  return new Date(nowMs + SAST_OFFSET_MS).getUTCHours();`, to: `  return new Date(nowMs).getUTCHours();` },
  { id: "K5", file: PASS, nodeTests: PASS_TESTS,
    guard: "DISABLED COSTS NOTHING — the switch stops the pass before any other read or write",
    from: `  if (!cfg.enabled) return { skipped: "disabled" };`, to: `  if (!cfg.enabled && false) return { skipped: "disabled" };` },
  { id: "K6", file: PASS, nodeTests: PASS_TESTS,
    guard: "the free hour gate comes BEFORE the date read, so 47 of 48 runs read one node",
    from: `  if (audit.saHour(nowMs) < cfg.passHour) return { skipped: "before_pass_hour" };\n`, to: `` },
  { id: "K7", file: PASS, nodeTests: PASS_TESTS,
    guard: "the day is CLAIMED — a writer that already owns today makes this pass stand down",
    from: `  if (!claim.committed) return { skipped: "claimed_elsewhere" };`, to: `  if (!claim.committed && false) return { skipped: "claimed_elsewhere" };` },
  { id: "K8", file: PASS, nodeTests: PASS_TESTS,
    guard: "the claim transaction refuses a stamp another writer just made",
    from: `    if (cur === saDate) return;                 // someone else owns today — abort`,
    to: `    if (false) return;                 // someone else owns today — abort` },

  // ── the cost contract ─────────────────────────────────────────────────────
  { id: "$4", file: PASS, nodeTests: PASS_TESTS,
    guard: "THE SHALLOW FETCH IS BOUNDED — a hang would burn the invocation while the scan holds its run lock",
    from: `    signal: AbortSignal.timeout(SHALLOW_TIMEOUT_MS),\n`, to: `` },

  // ── TAB A: per hub, sneakers, the two answers that turn a customer away ────
  { id: "H3", file: LIB, nodeTests: LIB_TESTS,
    guard: "HUB 3 IS OUT OF SCOPE — it serves Pine, and a chip must never open a node nothing fills",
    from: `const AUDIT_HUBS = ["hub1", "hub2"];`, to: `const AUDIT_HUBS = ["hub1", "hub2", "hub3"];` },
  { id: "A1", file: LIB, nodeTests: LIB_TESTS,
    guard: "SNEAKERS ONLY — clothing has its own tab and does not belong on a hub shelf-walk",
    from: `    if (!o || o.productType !== "sneaker") continue;`, to: `    if (!o) continue;` },
  { id: "A2", file: LIB, nodeTests: LIB_TESTS,
    guard: "THIS HUB'S SHELF — a list addressed to hub1 must not carry hub2's answers",
    from: `    if ((o.placedAtHub || o.hub) !== hub) continue;`, to: `    if (false) continue;` },
  { id: "A3", file: LIB, nodeTests: LIB_TESTS,
    guard: "RESOLVED IS NOT A CHECK — an order found and handed over is work nobody can do",
    from: `    if (o.readyAt || o.collectedAt) continue;`, to: `    if (false) continue;` },
  { id: "A4", file: LIB, nodeTests: LIB_TESTS,
    guard: "ONLY THE TWO ANSWERS — an ordinary order nobody was turned away from is not a check",
    from: `    const answer = UNAVAILABLE_ANSWERS.find((a) => o[a.field]);\n    if (!answer) continue;`,
    to: `    const answer = UNAVAILABLE_ANSWERS.find((a) => o[a.field]) || { key: "out_of_stock", field: "createdAt" };` },
  { id: "A5", file: LIB, nodeTests: LIB_TESTS,
    guard: "the lookback window bounds the list — yesterday's trading, not every refusal ever recorded",
    from: `    if (!Number.isFinite(at) || at < since) continue;`, to: `    if (!Number.isFinite(at)) continue;` },
  { id: "A6", file: LIB, nodeTests: LIB_TESTS,
    guard: "ONE CELL IS ONE SHELF — three customers refused the same size is one walk, with a count",
    from: `    const cur = rows.get(k);\n    if (cur) {`, to: `    const cur = null;\n    if (cur) {` },
  { id: "A7", file: LIB, nodeTests: LIB_TESTS,
    guard: "SOLD OUT OUTRANKS TOMORROW on one cell, whichever answer was recorded last",
    from: `      if (answer.key === "out_of_stock" && cur.r !== "out_of_stock") { cur.r = answer.key; cur.at = at; }`,
    to: `      if (at > cur.at) { cur.r = answer.key; cur.at = at; }` },
  { id: "A8", file: LIB, nodeTests: LIB_TESTS,
    guard: "THE PHANTOM LEADS — sold out against a cell that still reads stock is the only certainly-wrong row",
    from: `  const phantom = (r) => (r.r === "out_of_stock" && r.q > 0 ? 0 : 1);`,
    to: `  const phantom = () => 0;` },
  { id: "A9", file: LIB, nodeTests: LIB_TESTS,
    guard: "THE CELL KEY IS /stock's OWN FOLD — a half size must name the cell that actually exists",
    from: `    const sizeKey = stockSizeKey(o.size);`,
    to: `    const sizeKey = require("./refill-engine.cjs").encodeSizeKey(o.size);` },
  { id: "A10", file: LIB, nodeTests: LIB_TESTS,
    guard: "…and the fold keeps the synthetic \"Free Size\" label off its own phantom cell",
    from: `  if (size == null || size === "" || size === "Free Size") return "_";`,
    to: `  if (size == null || size === "") return "_";` },

  // ── TAB B: the rotation ───────────────────────────────────────────────────
  { id: "R0", file: LIB, nodeTests: LIB_TESTS,
    guard: "NOT SOLD IS THE UNIVERSE, not a badge — a line that sold last week must not spend a batch slot",
    from: `    if (soldPids && soldPids.has(pid)) continue;`, to: `    if (false) continue;` },
  { id: "R1", file: LIB, nodeTests: LIB_TESTS,
    guard: "NEVER CHECKED COUNTS AS LONGEST — the one rule that stops a product starving",
    from: `    return Number.isFinite(at) && at > 0 ? at : -1;`,
    to: `    return Number.isFinite(at) && at > 0 ? at : Infinity;` },
  { id: "R2", file: LIB, nodeTests: LIB_TESTS,
    guard: "the batch is tie-broken by product id, so it cannot depend on object key order",
    from: `    .sort((a, b) => stampOf(a.pid) - stampOf(b.pid) || a.pid.localeCompare(b.pid))`,
    to: `    .sort((a, b) => stampOf(a.pid) - stampOf(b.pid))` },
  { id: "R3", file: LIB, nodeTests: LIB_TESTS,
    guard: "the universe is what the store HOLDS — a zero cell has no shelf to walk to",
    from: `      if (q > 0) sizes.push({ sk: sizeKey, q });`, to: `      sizes.push({ sk: sizeKey, q });` },
  { id: "R4", file: LIB, nodeTests: LIB_TESTS,
    guard: "the sold signal is a SALE FROM THIS STORE — not a receive, not another shop's till",
    from: `    if (!m || m.type !== "sold" || m.from !== store || !m.productId) continue;`,
    to: `    if (!m || !m.productId) continue;` },
  { id: "R5", file: LIB, nodeTests: LIB_TESTS,
    guard: "the sold window is bounded — an ancient sale must not read as recent movement",
    from: `  const since = nowMs - soldWindowDays * 864e5;`, to: `  const since = 0;` },
  { id: "R6", file: PASS, nodeTests: PASS_TESTS,
    guard: "result day nodes are pruned past the keep window — and only those",
    from: `    return Number.isFinite(t) && t < cutoff;`, to: `    return Number.isFinite(t);` },
  { id: "S1", file: LIB, nodeTests: LIB_TESTS,
    guard: "A BATCH ALREADY WALKED DOES NOT COME BACK — the per-day results node cannot remember a carried batch",
    from: `      return Number.isFinite(at) && at > 0 && at >= batchAt;`, to: `      return false;` },
  { id: "S1b", file: LIB, nodeTests: LIB_TESTS,
    guard: "…and a stamp from BEFORE the batch was minted does not count, so the rotation still comes round",
    from: `      return Number.isFinite(at) && at > 0 && at >= batchAt;`,
    to: `      return Number.isFinite(at) && at > 0;` },
  { id: "S1c", file: LIB, nodeTests: LIB_TESTS,
    guard: "the batch IDENTITY survives the walked filter, so tomorrow still knows which thirty it was",
    from: `  const batchPids = picked.map((x) => x.pid);\n  picked = picked.filter(({ pid }) => !walked.has(pid));`,
    to: `  picked = picked.filter(({ pid }) => !walked.has(pid));\n  const batchPids = picked.map((x) => x.pid);` },
  { id: "S8", file: LIB, nodeTests: LIB_TESTS,
    guard: "A MISSING MINT TIME SHOWS THE WORK — zero would read every stamp in history as walked and blank the list",
    from: `    else batchAt = Number(prevBatchAt) > 0 ? Number(prevBatchAt) : nowMs;`,
    to: `    else batchAt = Number(prevBatchAt) || 0;` },
  { id: "S9", file: LIB, nodeTests: LIB_TESTS,
    guard: "a carried batch reports the day it was MINTED, not whichever day it is read on",
    from: `    batchDate: saDateStringFromMs(batchAt),`, to: `    batchDate: saDate,` },

  // ── the client writers ────────────────────────────────────────────────────

  // ── the screen and the one action ─────────────────────────────────────────
  { id: "V1", file: VIEW, tests: VIEW_TESTS,
    guard: "the screen reads the selected list and that day's results — nothing else",
    from: `  const snap = usePathState(onHubs ? hubSnapshotPath(hub) : snapshotPath(store), true);`,
    to: `  usePathState("products", true);\n  const snap = usePathState(onHubs ? hubSnapshotPath(hub) : snapshotPath(store), true);` },
  { id: "V2", file: VIEW, tests: VIEW_TESTS,
    guard: "ONE subscription at a time — the tab that is not up costs nothing",
    from: `  const onHubs = tab === "oos";`, to: `  const onHubs = true;` },
  { id: "V3", file: VIEW, tests: VIEW_TESTS,
    guard: "the results day comes from SERVER time, and FOLLOWS SA midnight",
    from: `    const t = setTimeout(() => setSaDate(saDateOf(serverNowMs())), delay);`,
    to: `    const t = setTimeout(() => {}, delay);` },
  { id: "V4", file: VIEW, tests: VIEW_TESTS,
    guard: "an actioned row does not come back — today's results filter the list",
    from: `      ? (data.oos?.rows || []).filter((r) => !done[r.k])`,
    to: `      ? (data.oos?.rows || [])` },
  { id: "V5", file: VIEW, tests: VIEW_TESTS,
    guard: "UNANSWERED IS NOT 'NOTHING DONE' — the list waits for the results read",
    from: `      {!snap.settled || !results.settled ? <Empty text="Loading…" />`,
    to: `      {!snap.settled ? <Empty text="Loading…" />` },
  { id: "V6", file: VIEW, tests: VIEW_TESTS,
    guard: "…and an unreadable results node disables the action rather than inviting duplicate work",
    from: `  const resultsKnown = results.settled && !results.error;`, to: `  const resultsKnown = true;` },
  { id: "V7", file: VIEW, tests: VIEW_TESTS,
    guard: "a walked batch reads as FINISHED, not as an empty shop",
    from: `                : data.rotation?.walked ? \`Batch done — \${data.rotation.walked} checked.\``,
    to: `                : false ? ""` },
  { id: "V8", file: VIEW, tests: VIEW_TESTS,
    guard: "a list that is not today's SAYS SO — the pass stands down whenever the refill engine does",
    from: `  const stale = data && data.saDate && data.saDate !== saDate;`, to: `  const stale = false;` },
  { id: "V9", file: VIEW, tests: VIEW_TESTS,
    guard: "THE SIZE IS ON THE LINE — there is no product/size toggle to go and find it behind",
    from: `  const sizes = (r.z || []).map((z) => \`\${formatSize(z.s)} \${z.q}\`).join("   ");`,
    to: `  const sizes = "";` },
  { id: "V10", file: VIEW, tests: VIEW_TESTS,
    guard: "the hub line carries the answer, the size AND what the hub believed",
    from: `    \`\${locationLabel(r.w)} says \${r.q}\`,`, to: `    "",` },

  // ── the writers: one outcome, and it moves no stock ───────────────────────
  { id: "W1", file: STORE, tests: STORE_TESTS,
    guard: "the hub check is RECORDED — a row nobody records comes back tomorrow unchanged",
    from: `  await update(ref(database), {\n    [\`\${hubResultsPath(hub, saDateOf(nowMs))}/\${row.k}\`]: {`,
    to: `  if (row) return { ok: true };\n  await update(ref(database), {\n    [\`\${hubResultsPath(hub, saDateOf(nowMs))}/\${row.k}\`]: {` },
  { id: "W2", file: STORE, tests: STORE_TESTS,
    guard: "THE ROTATION STAMP is what sends a product to the back of the queue",
    from: `    [\`\${rotationPath(store)}/\${row.p}\`]: { at: nowMs, o: FIXED, by: uid },\n`, to: `` },
  { id: "W3", file: STORE, tests: STORE_TESTS,
    guard: "…and the day's result rides in the SAME update, so neither can exist without the other",
    from: `    [\`\${resultsPath(store, saDateOf(nowMs))}/\${row.p}\`]: {\n      outcome: FIXED, at: nowMs, by: uid, productId: row.p,\n    },\n`,
    to: `` },
  { id: "W4", file: STORE, tests: STORE_TESTS,
    guard: "a row with no key is refused rather than written to a junk path",
    from: `  if (!row || !row.k) return { ok: false, reason: "invalid_row" };\n`, to: `` },
  { id: "W5", file: STORE, tests: STORE_TESTS,
    guard: "a row with no product is refused too",
    from: `  if (!row || !row.p) return { ok: false, reason: "invalid_row" };\n`, to: `` },
  { id: "W6", file: STORE, tests: STORE_TESTS,
    guard: "NOTHING HERE WRITES STOCK — correcting a quantity is the Adjust screen's job",
    from: `import { ref, update } from "firebase/database";`,
    to: `import { ref, update } from "firebase/database";\nimport { applyMovement } from "./applyMovement";\nvoid applyMovement;` },

  // ── the fence this PR did not move ────────────────────────────────────────
  { id: "M45", file: SCAN, nodeTests: ["test/refill-cadence.test.cjs"],
    guard: "MOVEMENTS_WINDOW_DAYS is still held at 45 — the reduction to 31 was reverted as unsafe",
    from: `const MOVEMENTS_WINDOW_DAYS = 45;`, to: `const MOVEMENTS_WINDOW_DAYS = 31;` },
];

// ── A NON-ZERO EXIT IS NOT PROOF ─────────────────────────────────────────────
// Only a runner that EXECUTED tests and saw them fail counts as FAIL. A syntax
// error, a missing file, a reworded summary — all report ERROR, loudly, and
// never credit the guard.
function runVitest(files) {
  try {
    execFileSync("npx", ["vitest", "run", ...files, "--silent"], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/Tests\s+\d+\s+failed/.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 120)})`;
  }
}

function runNodeTests(files) {
  try {
    // TAP is PINNED, not left to the default reporter: node 24 prints "ℹ fail 1"
    // where node 22 prints "# fail 1", and the parser below would read a real
    // failure as ERROR — silently crediting no guard at all.
    execFileSync("node", ["--test", "--test-reporter=tap", ...files], { stdio: "pipe", cwd: "functions", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/.test(out)) {
      return `ERROR(${(out.trim().split("\n").find((l) => /Error/.test(l)) || "load crash").slice(0, 120)})`;
    }
    if (/^# fail [1-9]/m.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 120)})`;
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
    console.error("Commit or stash first — a dirty file would be captured as the baseline.");
    process.exit(2);
  }
}

const results = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  const hits = original.split(m.from).length - 1;
  if (hits === 0) {
    results.push({ ...m, mutated: "ANCHOR-MISSING", restored: "-" });
    console.log(`${m.id}  ANCHOR NOT FOUND in ${m.file}`);
    continue;
  }
  if (hits > 1) {
    results.push({ ...m, mutated: "ANCHOR-AMBIGUOUS", restored: "-" });
    console.log(`${m.id}  ANCHOR FOUND ${hits}× in ${m.file} — widen it`);
    continue;
  }
  let mutated = "?";
  let restored = "?";
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
  console.log(`${m.id}  mutated:${mutated}  restored:${restored}  ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  — ${m.guard}`);
}

const unproven = results.filter((r) => !r.proven);
console.log(`\n${results.length - unproven.length}/${results.length} guards proven`);
if (unproven.length) {
  console.log("NOT PROVEN:");
  for (const r of unproven) console.log(`  ${r.id}  mutated:${r.mutated} restored:${r.restored}  ${r.guard}`);
  process.exit(1);
}
