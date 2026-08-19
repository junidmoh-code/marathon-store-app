// ─── MUTATION PROOF HARNESS — the restored hold notification (owner 2026-08-19)
// For each guard: reintroduce the bug, prove the suite FAILS, restore the file,
// prove it PASSES. A test that cannot fail proves nothing, so this runs the
// whole cycle and refuses to report a pass it did not watch break first.
//
// Same discipline as scripts/mutation-proof-multi-token.mjs — ERROR ≠ FAIL,
// unique anchors, signal-safe restore, clean-tree preflight — and the same two
// runners, because this feature spans BOTH halves: the client writes the
// re-link (vitest) and the server sends the message (node --test).
//
// The stakes are the reason this harness exists at all. A previous version of
// this notification sent the same message 2-5 times to real customers and got
// the gateway number banned. "One customer, one message" has to be a property
// something watches break, not a claim in a comment.
//
// Run:  node scripts/mutation-proof-hold-notify.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const LIB = "functions/lib/hold-availability-notify.cjs";
const PLAN = "src/components/stock/onHoldRefill.js";
const SERVER_TESTS = ["test/hold-availability-notify.test.cjs"];
// M9/M10 run against the BEHAVIOURAL suite only. The gate suite asserts the
// exact source text of both anchors, so including it would let those mutations
// be "proven" by the string disappearing rather than by anything breaking —
// circular, and worth nothing. (CodeRabbit #385.)
const PLAN_BEHAVIOUR_TESTS = ["src/components/stock/onHoldRefill.test.js"];

const MUTATIONS = [
  // ── "Out of Stock sends nothing" / "nothing enqueues without a fulfil" ─────
  {
    id: "M1",
    guard: "Only a 'fulfilled' status can send — Out of Stock and every other transition send nothing",
    file: LIB,
    from: `  if (after !== "fulfilled") return { sent: false, skipped: "not_fulfilled" };`,
    to: `  if (false) return { sent: false, skipped: "not_fulfilled" };`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M2",
    guard: "A redelivered fulfilled→fulfilled event is a replay, not a fulfil",
    file: LIB,
    from: `  if (before === "fulfilled") return { sent: false, skipped: "no_transition" };`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M3",
    guard: "Only a HOLD-ORIGIN line messages anybody — an armed flag, not merely a link",
    file: LIB,
    from: `  if (!link || link.notifyOnFulfil !== true) return { sent: false, skipped: "not_hold_origin" };`,
    to: `  if (!link) return { sent: false, skipped: "not_hold_origin" };`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M4",
    guard: "A status flip with no fulfilment record behind it moved no stock, so it messages nobody",
    file: LIB,
    from: `  if (!rec.fulfilledBy || typeof rec.fulfilledBy !== "object") {`,
    to: `  if (false) {`,
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
    id: "M6",
    guard: "A double-tap fulfil is refused by the durable stamp, not left to the 90s window",
    file: LIB,
    from: `  if (link.notifiedAt || link.notifyFailedAt) return { sent: false, skipped: "already_handled" };`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M7",
    guard: "THE MERGED-LINE RULE — the live record must still be fulfilled; a part-sent line is not",
    file: LIB,
    from: `  if (rec.status !== "fulfilled") return { sent: false, skipped: "status_moved" };`,
    to: ``,
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
  {
    id: "M11",
    guard: "An unresolved claim past the dedupe window REFUSES to send rather than risk a second message",
    file: LIB,
    from: `  if (claimedAt && !resumable) {`,
    to: `  if (false) {`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M12",
    guard: "Once the producer has answered, NOTHING releases the claim — the 2-5 copies incident in miniature",
    file: LIB,
    from: `  }).catch((e) => console.error(
    "holdAvailabilityNotify: ENQUEUED but could not stamp notifiedAt (claim kept, will not resend):",
    requestId, e.message,
  ));`,
    to: `  }).catch(async () => { await reqRef.child("holdLink").update({ notifyClaimedAt: null }).catch(() => {}); });`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M14",
    guard: "RESUMING IS A CAS — two live deliveries can never both reach the producer",
    file: LIB,
    from: `      if (resumable && cur === claimedAt) return now;               // take over the run that died`,
    to: `      if (resumable) return now;                                    // take over the run that died`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M13",
    guard: "A claim inside the dedupe window RESUMES — a mid-flight death must not silently drop the message",
    file: LIB,
    from: `  const resumable = Number.isFinite(claimAgeMs) && claimAgeMs >= 0 && claimAgeMs < PRODUCER_DEDUPE_MS;`,
    to: `  const resumable = false;`,
    nodeTests: SERVER_TESTS,
  },
  // ── the client half: without the re-link there is nobody to message ────────
  {
    id: "M9",
    guard: "The hold stores the re-link on the request — the send has no other way to find the customer",
    file: PLAN,
    from: `      holdLink: holdCustomerLink(order, saDate),`,
    to: ``,
    tests: PLAN_BEHAVIOUR_TESTS,
  },
  {
    id: "M10",
    guard: "A hold with no phone raises its refill row but never arms a send",
    file: PLAN,
    from: `    notifyOnFulfil: !!phone,`,
    to: `    notifyOnFulfil: true,`,
    tests: PLAN_BEHAVIOUR_TESTS,
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
    // failure as ERROR — silently crediting no guard at all. (CodeRabbit #385.)
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

const bad = results.filter((r) => !r.proven);
console.log(`\n${results.length - bad.length}/${results.length} guards proven.`);
if (bad.length) {
  console.log("NOT PROVEN:");
  for (const r of bad) console.log(`  ${r.id}  mutated:${r.mutated}  restored:${r.restored}  — ${r.guard}`);
  process.exit(1);
}
