// ─── MUTATION PROOF HARNESS — the restored order_tomorrow message ────────────
// For each guard: reintroduce the bug, prove the suite FAILS, restore the file,
// prove it PASSES. A test that cannot fail proves nothing, so this runs the
// whole cycle and refuses to report a pass it did not watch break first.
//
// Same discipline as scripts/mutation-proof-hold-notify.mjs — ERROR ≠ FAIL,
// unique anchors, signal-safe restore, clean-tree preflight, pinned TAP output.
//
// Two things are at stake and they pull in opposite directions.
//   THE MESSAGE MUST FIRE. It was dead for eleven days (e115cde, 2026-08-08)
//   and 892 sends a month went to zero, with nothing in the code looking
//   obviously broken. M1/M2 are the guards that would let it silently die
//   again.
//   THE MESSAGE MUST FIRE ONCE. A previous customer message in this codebase
//   went out 2-5 times and got the gateway number banned. M4-M8 are the guards
//   that keep "one order, one message" a property something watches break.
//
// M9/M10 keep it from reaching the wrong person, M11 keeps it the RIGHT message
// (the approved template, the approved arity), and M12 keeps it out of PR #385's
// way.
//
// Run:  node scripts/mutation-proof-order-tomorrow.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const LIB = "functions/lib/order-tomorrow-notify.cjs";
const FN  = "functions/index.js";
const SERVER_TESTS = ["test/order-tomorrow-notify.test.cjs"];
// The #385 suite runs alongside on the isolation mutation: the whole claim of
// M12 is that this feature cannot disturb that one, and the only way to watch
// that break is to run its tests.
const BOTH_SUITES = ["test/order-tomorrow-notify.test.cjs", "test/hold-availability-notify.test.cjs"];

const MUTATIONS = [
  // ── "it fires at all" — the failure mode that started this ────────────────
  {
    id: "M1",
    guard: "The message FIRES on coming_tomorrow — the state that went silent for eleven days",
    file: LIB,
    from: `  if (after !== STATE) return { sent: false, skipped: "not_coming_tomorrow" };`,
    to: `  if (after !== "__never__") return { sent: false, skipped: "not_coming_tomorrow" };`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M2",
    guard: "It fires on THIS state only — no other order transition may wake it",
    file: LIB,
    from: `  if (after !== STATE) return { sent: false, skipped: "not_coming_tomorrow" };`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M3",
    guard: "A redelivered event (tomorrow → tomorrow) is a replay, not a transition",
    file: LIB,
    from: `  if (before === STATE) return { sent: false, skipped: "no_transition" };`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },

  // ── "one order, one message, ever" ────────────────────────────────────────
  {
    id: "M4",
    guard: "RE-ENTERING the state is refused by the durable stamp, not left to the 90s window",
    file: LIB,
    from: `  if (rec.tomorrowNotifiedAt || rec.tomorrowNotifyFailedAt) {
    return { sent: false, skipped: "already_handled" };
  }`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M5",
    guard: "THE CLAIM — two overlapping deliveries produce one message, not two",
    file: LIB,
    from: `    claimed = res.committed && res.snapshot.val() === now;`,
    to: `    claimed = true;`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M5b",
    guard: "res.committed is the LOAD-BEARING half of the claim check — the value comparison alone is not enough",
    file: LIB,
    // Exactly the shape CodeRabbit #386 feared the code already had: identity by
    // timestamp alone. Two deliveries in the same millisecond both see their own
    // value and both send. Test 2c-ms is what catches it.
    from: `    claimed = res.committed && res.snapshot.val() === now;`,
    to: `    claimed = res.snapshot.val() === now;`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M6",
    guard: "An unresolved claim is NEVER taken over — no resume, no lease, at any age",
    file: LIB,
    from: `  if (rec.tomorrowNotifyClaimedAt) {`,
    to: `  if (false) {`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M7",
    guard: "Once the producer has answered, NOTHING releases the claim — the 2-5 copies incident in miniature",
    file: LIB,
    from: `  }).catch((e) => console.error(
    "orderTomorrowNotify: ENQUEUED but could not stamp tomorrowNotifiedAt (claim kept, will not resend):",
    orderId, e.message,
  ));`,
    to: `  }).catch(async () => { await orderRef.update({ tomorrowNotifyClaimedAt: null }).catch(() => {}); });`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M8",
    guard: "Only an unusable RECIPIENT is terminal — a template-contract failure stays retryable",
    file: LIB,
    from: `    const terminal = !!(err && err.code === "invalid-argument" && err.details && err.details.unusableRecipient);`,
    to: `    const terminal = !!(err && err.code === "invalid-argument");`,
    nodeTests: SERVER_TESTS,
  },

  // ── "nothing is promised to the wrong person" ─────────────────────────────
  {
    id: "M9",
    guard: "A flip-and-revert messages nobody — the LIVE record is what counts, not the event",
    file: LIB,
    from: `  if (rec.status !== STATE) return { sent: false, skipped: "status_moved" };`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M10",
    guard: "An order with no phone enqueues nothing and does not throw",
    file: LIB,
    from: `  if (!rec.customerPhone) return { sent: false, skipped: "no_phone" };`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },

  // ── "the right message, and PR #385 is not disturbed" ─────────────────────
  {
    id: "M11",
    guard: "The template and its arity are the approved ones — order_tomorrow, one param, the order number",
    file: LIB,
    from: `      templateParams: [orderId],`,
    to: `      templateParams: [orderId, orderId],`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M12",
    guard: "The trigger is keyed on the ORDER status leaf — pointing it at #385's node breaks both",
    file: FN,
    from: `    ref:            "/orders/{orderId}/status",`,
    to: `    ref:            "/refill_requests/{requestId}/status",`,
    nodeTests: BOTH_SUITES,
    vitest: ["src/signedInPillAndHoldMerge.gate.test.js"],
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
  if (m.vitest && m.vitest.length) verdicts.push(runVitest(m.vitest));
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
  // An uncaught throw outside the try would otherwise leave the MUTATED file on
  // disk: the next run fails its clean-tree preflight, and a careless commit
  // ships the bug. (CodeRabbit #386.)
  const onCrash = (e) => { restore(); console.error("restored after crash:", e); process.exit(3); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);
  try {
    writeFileSync(m.file, original.replace(m.from, () => m.to));
    mutated = runAll(m);
    restore();
    restored = runAll(m);
  } finally {
    restore();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("uncaughtException", onCrash);
    process.removeListener("unhandledRejection", onCrash);
  }
  const proven = mutated === "FAIL" && restored === "PASS";
  results.push({ ...m, mutated, restored, proven });
  console.log(`${m.id}  mutated:${mutated}  restored:${restored}  ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  — ${m.guard}`);
}

const bad = results.filter((r) => !r.proven);
console.log(`\n${results.length - bad.length}/${results.length} guards proven.`);
if (bad.length) {
  console.log("NOT PROVEN:");
  for (const r of bad) console.log(`  ${r.id}  mutated:${r.mutated}  restored:${r.restored}  — ${r.guard}`);
  process.exit(1);
}
