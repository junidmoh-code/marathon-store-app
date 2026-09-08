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
  {
    id: "K1", file: LIB, nodeTests: LIB_TESTS,
    guard: "ABSENT IS OFF — only a real `true` enables the feature, never a truthy string",
    from: `    enabled: c.enabled === true,`,
    to: `    enabled: !!c.enabled,`,
  },
  {
    id: "K2", file: LIB, nodeTests: LIB_TESTS,
    guard: "the pass does not run before its SA hour",
    from: `  if (saHour(nowMs) < passHour) return { run: false, saDate, why: "before_pass_hour" };\n`,
    to: ``,
  },
  {
    id: "K3", file: LIB, nodeTests: LIB_TESTS,
    guard: "ONCE A DAY — the stored SA date stops every later run of the same day",
    from: `  if (lastPassDate === saDate) return { run: false, saDate, why: "already_ran_today" };\n`,
    to: ``,
  },
  {
    id: "K4", file: LIB, nodeTests: LIB_TESTS,
    guard: "the hour is read in SAST, not UTC — a UTC read fires the pass two hours early",
    from: `  return new Date(nowMs + SAST_OFFSET_MS).getUTCHours();`,
    to: `  return new Date(nowMs).getUTCHours();`,
  },
  {
    id: "K5", file: PASS, nodeTests: PASS_TESTS,
    guard: "DISABLED COSTS NOTHING — the switch stops the pass before any other read or write",
    from: `  if (!cfg.enabled) return { skipped: "disabled" };`,
    to: `  if (!cfg.enabled && false) return { skipped: "disabled" };`,
  },
  {
    id: "K6", file: PASS, nodeTests: PASS_TESTS,
    guard: "the free hour gate comes BEFORE the date read, so 47 of 48 runs read one node",
    from: `  if (audit.saHour(nowMs) < cfg.passHour) return { skipped: "before_pass_hour" };\n`,
    to: ``,
  },
  {
    id: "K7", file: PASS, nodeTests: PASS_TESTS,
    guard: "the day is CLAIMED — a writer that already owns today makes this pass stand down",
    from: `  if (!claim.committed) return { skipped: "claimed_elsewhere" };`,
    to: `  if (!claim.committed && false) return { skipped: "claimed_elsewhere" };`,
  },
  {
    id: "K8", file: PASS, nodeTests: PASS_TESTS,
    guard: "the claim transaction refuses a stamp another writer just made",
    from: `    if (cur === saDate) return;                 // someone else owns today — abort`,
    to: `    if (false) return;                 // someone else owns today — abort`,
  },

  // ── the cost contract ─────────────────────────────────────────────────────
  {
    id: "$1", file: PASS, nodeTests: PASS_TESTS,
    guard: "display registration is read SHALLOW — the bodies are ~1.8 MB and answer nothing extra",
    from: `        shallowKeys(app, \`displayChecks_active/\${store}\`).catch((e) => {`,
    to: `        db.ref(\`displayChecks_active/\${store}\`).once("value").then((s) => Object.keys(s.val() || {})).catch((e) => {`,
  },
  {
    id: "$2", file: VIEW, tests: VIEW_TESTS,
    guard: "the screen reads the snapshot and today's results — nothing else",
    from: `  const { snap, results } = useStoreAudit(store, saDate);`,
    to: `  const { snap, results } = useStoreAudit(store, saDate);\n  usePathState("products", true);`,
  },
  {
    id: "$3", file: VIEW, tests: VIEW_TESTS,
    guard: "the results day comes from SERVER time — a wrong device date must not file under the wrong day",
    from: `  const [saDate, setSaDate] = useState(() => saDateOf(serverNowMs()));`,
    to: `  const [saDate, setSaDate] = useState(() => saDateOf(Date.now()));`,
  },

  // ── Tab A ─────────────────────────────────────────────────────────────────
  {
    id: "A1", file: LIB, nodeTests: LIB_TESTS,
    guard: "THE PLACE IS PART OF THE ROW — the same line missing at two locations is two shelf walks",
    from: "  return `${pid}__${sizeKey}__${where}`;",
    to: "  return `${pid}__${sizeKey}`;",
  },
  {
    id: "A2", file: LIB, nodeTests: LIB_TESTS,
    guard: "CLOTHING ONLY — a negative sneaker cell must never reach a clothing shelf walk",
    from: `      if (!isClothing(products?.[pid])) continue;\n      for (const sizeKey of Object.keys(byPid[pid] || {})) {\n        const q = num(byPid[pid][sizeKey]?.qty);\n        if (q >= 0) continue;`,
    to: `      for (const sizeKey of Object.keys(byPid[pid] || {})) {\n        const q = num(byPid[pid][sizeKey]?.qty);\n        if (q >= 0) continue;`,
  },
  {
    id: "A3", file: LIB, nodeTests: LIB_TESTS,
    guard: "the engine's own bookkeeping tidy-ups are not shelf walks — only came-back-unavailable is",
    from: `    if (why !== "rejected" && why !== "unfillable" && why !== "awaiting_upstream") continue;`,
    to: `    if (why === "no_longer_needed") continue;`,
  },
  {
    id: "A4", file: LIB, nodeTests: LIB_TESTS,
    guard: "the lookback window bounds the list — yesterday's trading, not every rejection ever recorded",
    from: `    if (!Number.isFinite(resolvedAt) || resolvedAt < since) continue;`,
    to: `    if (!Number.isFinite(resolvedAt)) continue;`,
  },
  {
    id: "A5", file: LIB, nodeTests: LIB_TESTS,
    guard: "an OPEN request against a source reading zero is a check; a stocked source is not",
    from: `      if (believed > 0) continue;                       // the source can still answer`,
    to: `      if (believed >= 0) continue;                       // the source can still answer`,
  },

  // ── the rotation ──────────────────────────────────────────────────────────
  {
    id: "R1", file: LIB, nodeTests: LIB_TESTS,
    guard: "NEVER CHECKED COUNTS AS LONGEST — the one rule that stops a product starving",
    from: `    return Number.isFinite(at) && at > 0 ? at : -1;`,
    to: `    return Number.isFinite(at) && at > 0 ? at : Infinity;`,
  },
  {
    id: "R2", file: LIB, nodeTests: LIB_TESTS,
    guard: "the batch is tie-broken by product id, so it cannot depend on object key order",
    from: `    .sort((a, b) => stampOf(a.pid) - stampOf(b.pid) || a.pid.localeCompare(b.pid))`,
    to: `    .sort((a, b) => stampOf(a.pid) - stampOf(b.pid))`,
  },
  {
    id: "R3", file: LIB, nodeTests: LIB_TESTS,
    guard: "the universe is what the store HOLDS — a zero cell has no shelf to walk to",
    from: `      if (q > 0) sizes.push({ sk: sizeKey, q });`,
    to: `      sizes.push({ sk: sizeKey, q });`,
  },
  {
    id: "R4", file: LIB, nodeTests: LIB_TESTS,
    guard: "the sold signal is a SALE FROM THIS STORE — not a receive, not another shop's till",
    from: `    if (!m || m.type !== "sold" || m.from !== store || !m.productId) continue;`,
    to: `    if (!m || !m.productId) continue;`,
  },
  {
    id: "R5", file: LIB, nodeTests: LIB_TESTS,
    guard: "the sold window is bounded — an ancient sale must not read as recent movement",
    from: `  const since = nowMs - soldWindowDays * 864e5;`,
    to: `  const since = 0;`,
  },
  {
    id: "R6", file: PASS, nodeTests: PASS_TESTS,
    guard: "an unreadable display signal is SAID, never rendered as a confident 'no display'",
    from: `      snapshot.displaySignal = displayKeys ? "ok" : "unavailable";`,
    to: `      snapshot.displaySignal = "ok";`,
  },
  {
    id: "R7", file: PASS, nodeTests: PASS_TESTS,
    guard: "result day nodes are pruned past the keep window — and only those",
    from: `    return Number.isFinite(t) && t < cutoff;`,
    to: `    return Number.isFinite(t);`,
  },

  // ── the client writers ────────────────────────────────────────────────────
  {
    id: "C1", file: STORE, tests: STORE_TESTS,
    guard: "THE DELTA COMES FROM THE LIVE CELL — the snapshot's quantity is evidence, not a base",
    from: `  const live = Number(snap.val()?.qty) || 0;`,
    to: `  const live = 0;`,
  },
  {
    id: "C2", file: STORE, tests: STORE_TESTS,
    guard: "`expect` pins the read-decide-write, so a sale in the gap REFUSES instead of landing",
    from: `    expect: { qty: live },\n`,
    to: ``,
  },
  {
    id: "C3", file: STORE, tests: STORE_TESTS,
    guard: "a cell already correct writes no movement — an adjustment of nothing is ledger noise",
    from: `  if (delta === 0) return { ok: true, noop: true, live };\n`,
    to: ``,
  },
  {
    id: "C4", file: STORE, tests: STORE_TESTS,
    guard: "RECORD ONLY AFTER THE WRITE LANDS — a refused correction must stay on the list",
    from: `    if (!res.ok) return res;                       // NOT recorded — rule 3\n    movementId = res.movementId || null;\n  }\n\n  const saDate`,
    to: `    if (!res.ok) { /* recorded anyway */ }\n    movementId = res.movementId || null;\n  }\n\n  const saDate`,
  },
  {
    id: "C5", file: STORE, tests: STORE_TESTS,
    guard: "A BLANK QUANTITY IS NOT ZERO — Number('') is 0, and that would zero the shelf on a tap nobody meant",
    from: `  if (actual === null || actual === undefined || String(actual).trim() === "") return { ok: false, reason: "invalid_quantity" };\n`,
    to: ``,
  },
  {
    id: "C6", file: STORE, tests: STORE_TESTS,
    guard: "EVERY rotation outcome stamps — 'present but slow' settles to the back, it is not re-raised",
    from: `    [\`\${rotationPath(store)}/\${row.p}\`]: { at: nowMs, o: outcome, by: uid },`,
    to: `    [\`\${rotationPath(store)}/\${row.p}\`]: { at: nowMs, o: outcome === "slow" ? "present" : outcome, by: uid },`,
  },
  {
    id: "C7", file: STORE, tests: STORE_TESTS,
    guard: "a PARTIAL 'not there' stamps nothing and names what landed",
    from: `      if (!res.ok) return { ...res, partial: movementIds };`,
    to: `      if (!res.ok) break;`,
  },
  {
    id: "C8", file: STORE, tests: STORE_TESTS,
    guard: "the outcome whitelist — an unknown outcome is refused, never stored",
    from: `  if (!OOS_OUTCOMES.includes(outcome)) return { ok: false, reason: "unknown_outcome" };\n`,
    to: ``,
  },
  {
    id: "C9", file: VIEW, tests: VIEW_TESTS,
    guard: "an actioned row does not come back — today's results filter the list",
    from: `    () => (data?.oos?.rows || []).filter((r) => !done[r.k]),`,
    to: `    () => (data?.oos?.rows || []),`,
  },

  // ── the five the adversarial architecture review found ────────────────────
  {
    id: "F1", file: STORE, tests: STORE_TESTS,
    guard: "CONFIRMED EMPTY CORRECTS A PHANTOM — a cell that disagrees is set to zero, not just ticked off",
    from: `  if (outcome === "confirmed_empty" && Number(row.q) !== 0) {`,
    to: `  if (false) {`,
  },
  {
    id: "F1n", file: STORE, tests: STORE_TESTS,
    guard: "…including a NEGATIVE cell, which is wrong by definition and would otherwise return every day forever",
    from: `  if (outcome === "confirmed_empty" && Number(row.q) !== 0) {`,
    to: `  if (outcome === "confirmed_empty" && Number(row.q) > 0) {`,
  },
  {
    id: "F1b", file: STORE, tests: STORE_TESTS,
    guard: "…and a REFUSED confirmed-empty correction records nothing either",
    from: `    if (!res.ok) return res;                       // NOT recorded — rule 3 (confirm)`,
    to: `    if (!res.ok) { /* recorded anyway */ }`,
  },
  {
    id: "F2", file: LIB, nodeTests: LIB_TESTS,
    guard: "THE STRONGER READING WINS — dedup compares rank, so a newer rejection is not lost to an older open request",
    from: `    if (!cur || row.rank < cur.rank) rows.set(row.k, row);`,
    to: `    if (!cur) rows.set(row.k, row);`,
  },
  {
    id: "F3", file: VIEW, tests: ["src/components/stock/stockAuditReasons.test.js"],
    guard: "THE REFUSAL STRING IS applyMovement's, not one invented here",
    from: `export const STALE = "stale_expectation";`,
    to: `export const STALE = "expect_mismatch";`,
  },
  {
    id: "F3b", file: VIEW, tests: ["src/components/stock/stockAuditReasons.test.js"],
    guard: "EVERY reason applyMovement can return has a sentence — a raw code at a shelf is a dead end",
    from: `  insufficient_stock: "Not enough on hand to remove.",\n`,
    to: ``,
  },
  {
    id: "F4", file: VIEW, tests: VIEW_TESTS,
    guard: "THE SIZE VIEW READS — a per-size outcome would stamp sizes nobody looked at as checked",
    from: `          {mode === "product"`,
    to: `          {true`,
  },
  {
    id: "F5", file: VIEW, tests: VIEW_TESTS,
    guard: "a list that is not today's SAYS SO — the pass stands down whenever the refill engine does",
    from: `      {data && data.saDate && data.saDate !== saDate && (`,
    to: `      {false && (`,
  },

  {
    id: "F6", file: VIEW, tests: VIEW_TESTS,
    guard: "A DARK DISPLAY SIGNAL IS NOT A NEGATIVE ONE — the pill stays off rather than putting a finding on every row",
    from: `      {displayKnown && !disp && <span style={pill(GRAY)}>No display</span>}`,
    to: `      {!disp && <span style={pill(GRAY)}>No display</span>}`,
  },
  {
    id: "F6b", file: VIEW, tests: VIEW_TESTS,
    guard: "…and the screen SAYS the signal is missing rather than going quiet about it",
    from: `      {!displayKnown && (`,
    to: `      {false && (`,
  },

  // ── CodeRabbit, PR #580 ───────────────────────────────────────────────────
  {
    id: "CR1", file: PASS, nodeTests: PASS_TESTS,
    guard: "THE SHALLOW FETCH IS BOUNDED — a hang would burn the invocation while the scan holds its run lock",
    from: `    signal: AbortSignal.timeout(SHALLOW_TIMEOUT_MS),\n`,
    to: ``,
  },
  {
    id: "CR2", file: VIEW, tests: VIEW_TESTS,
    guard: "THE RESULTS DAY FOLLOWS SA MIDNIGHT — a tablet left overnight must not write to yesterday",
    from: `    const t = setTimeout(() => setSaDate(saDateOf(serverNowMs())), delay);`,
    to: `    const t = setTimeout(() => {}, delay);`,
  },
  {
    id: "CR3", file: VIEW, tests: VIEW_TESTS,
    guard: "UNANSWERED IS NOT 'NOTHING DONE' — the list waits for the results read",
    from: `      {!snap.settled || !results.settled ? <Empty text="Loading…" />`,
    to: `      {!snap.settled ? <Empty text="Loading…" />`,
  },
  {
    id: "CR3b", file: VIEW, tests: VIEW_TESTS,
    guard: "…and an unreadable results node disables the actions rather than inviting duplicate work",
    from: `  const resultsKnown = results.settled && !results.error;`,
    to: `  const resultsKnown = true;`,
  },

  // ── the fence this PR did not move ────────────────────────────────────────
  {
    id: "M45", file: SCAN, nodeTests: ["test/refill-cadence.test.cjs"],
    guard: "MOVEMENTS_WINDOW_DAYS is still held at 45 — the reduction to 31 was reverted as unsafe",
    from: `const MOVEMENTS_WINDOW_DAYS = 45;`,
    to: `const MOVEMENTS_WINDOW_DAYS = 31;`,
  },
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
