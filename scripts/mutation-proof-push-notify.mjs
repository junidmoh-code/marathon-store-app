// ─── MUTATION PROOF HARNESS — refill push notifications ──────────────────────
// For each guard: reintroduce the bug, prove the suite FAILS, restore the file,
// prove it PASSES. A test that cannot fail proves nothing, so this runs the
// whole cycle and refuses to report a pass it did not watch break first.
//
// Same discipline as scripts/mutation-proof-hold-notify.mjs — ERROR is not FAIL,
// unique anchors, signal-safe restore, clean-tree preflight — and the same two
// runners, because this feature spans both halves: the client resolves who is
// subscribed (vitest) and the server fans out (node --test).
//
// The two guards the owner named specifically are M1/M2 (DEFAULT ON — deleting
// it must go red) and M7/M8 (dead-token pruning). The rest are here because
// each is a way this feature fails LOUDLY at a staff member and quietly in the
// logs: a sweep firing four hundred notifications, a redelivery double-sending,
// shadow rows notifying forever about work nobody will ever do.
//
// Run:  node scripts/mutation-proof-push-notify.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const PREFS = "src/push/notificationPrefs.js";
const PUSH = "functions/lib/refill-push.cjs";
const SERVER_TESTS = ["test/refill-push.test.cjs"];
const PREFS_TESTS = ["src/push/notificationPrefs.test.js"];

const MUTATIONS = [
  // ── DEFAULT ON ────────────────────────────────────────────────────────────
  {
    id: "M1",
    guard: "DEFAULT ON — no preferences record means the ROLE decides, not off",
    file: PREFS,
    from: `  const on = explicit === null ? roleDefault : explicit;`,
    to: `  const on = explicit === true;`,
    tests: PREFS_TESTS,
  },
  {
    id: "M2",
    guard: "The default is ON for the roles that actually pick refills",
    file: PREFS,
    from: `export const DEFAULT_ON_ROLES = Object.freeze(["warehouse", "admin"]);`,
    to: `export const DEFAULT_ON_ROLES = Object.freeze([]);`,
    tests: PREFS_TESTS,
  },
  {
    id: "M3",
    guard: "An EXPLICIT off beats the role default — a picker who opted out stays out",
    file: PREFS,
    from: `  const on = explicit === null ? roleDefault : explicit;`,
    to: `  const on = explicit === null ? roleDefault : (roleDefault || explicit);`,
    tests: PREFS_TESTS,
  },
  {
    id: "M4",
    guard: "A dirty account that opted in lands in a bucket, never in none",
    file: PREFS,
    from: `  return [AUDIENCE_ALL];
}

function normalise(v) {`,
    to: `  return [];
}

function normalise(v) {`,
    tests: PREFS_TESTS,
  },
  {
    id: "M5",
    guard: "A malformed prefs value is 'never set', not 'off' — a stray string cannot silence a picker",
    file: PREFS,
    from: `  const explicit = typeof (prefs && prefs.refillRequests) === "boolean"
    ? prefs.refillRequests
    : null;`,
    to: `  const explicit = prefs && "refillRequests" in prefs ? !!prefs.refillRequests : null;`,
    tests: PREFS_TESTS,
  },

  // ── DEAD TOKEN PRUNING ────────────────────────────────────────────────────
  {
    id: "M6",
    guard: "A dead token is DELETED — the server must stop writing to an address nobody is at",
    file: PUSH,
    from: `    if (code && DEAD_TOKEN_CODES.has(code)) dead.push(rows[i]);`,
    to: `    if (false) dead.push(rows[i]);`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M7",
    guard: "The prune actually runs — collecting dead tokens and never deleting them is the same bug",
    file: PUSH,
    from: `  await pruneDeadTokens(db, dead);`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M8",
    guard: "ONLY a dead address is pruned — a quota or transport blip must not cost a registration",
    file: PUSH,
    from: `const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);`,
    to: `const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
  "messaging/server-unavailable",
]);`,
    nodeTests: SERVER_TESTS,
  },

  // ── BURST COLLAPSE ────────────────────────────────────────────────────────
  {
    id: "M9",
    guard: "THE COLLAPSE — only the invocation that OPENED the window sends; 40 requests are one notification",
    file: PUSH,
    from: `  if (claim.snapshot.val() && claim.snapshot.val().windowId !== windowId) {
    return { sent: false, skipped: "joined_window" };
  }`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M10",
    guard: "A request that joins an open window is COUNTED, not treated as a fresh one",
    file: PUSH,
    from: `    const open = !!(cur && cur.windowId && !cur.closedAt && nowMs - Number(cur.startedAt || 0) < WINDOW_MS);`,
    to: `    const open = false;`,
    nodeTests: SERVER_TESTS,
  },

  // ── IDEMPOTENCY ───────────────────────────────────────────────────────────
  {
    id: "M11",
    guard: "IDEMPOTENCY — a redelivered creation is recognised and sends nothing",
    file: PUSH,
    from: `    if (seen[requestId]) { replay = true; return undefined; }`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M12",
    guard: "The replay memory SURVIVES the window closing — a retry a minute later is still a replay",
    file: PUSH,
    from: `  return { windowId: null, startedAt: 0, count: 0, sample: null, closedAt: nowMs, seen: pruneSeen(cur && cur.seen, nowMs) };`,
    to: `  return { windowId: null, startedAt: 0, count: 0, sample: null, closedAt: nowMs, seen: {} };`,
    nodeTests: SERVER_TESTS,
  },

  // ── THE TWO FAILURES THE FIRST DRAFT HAD ──────────────────────────────────
  {
    id: "M15",
    guard: "A dead claimer's count is CARRIED FORWARD — its requests are already in `seen` and can never be re-counted",
    file: PUSH,
    from: `    const orphaned = cur && cur.windowId && !cur.closedAt ? Number(cur.count || 0) : 0;`,
    to: `    const orphaned = 0;`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M16",
    guard: "The replay memory is CAPPED — uncapped, one hub's burst costs O(n^2) bytes on a single node",
    file: PUSH,
    from: `  if (fresh.length > MAX_SEEN) {
    fresh.sort((a, b) => b[1] - a[1]);
    fresh.length = MAX_SEEN;
  }`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },

  // ── SHADOW ROWS ───────────────────────────────────────────────────────────
  {
    id: "M13",
    guard: "Shadow rows notify NOBODY — they are a preview the sweep rewrites every 15 minutes",
    file: PUSH,
    from: `  if (typeof requestId === "string" && requestId.startsWith("SHDWrr-")) return "shadow_key";`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M14",
    guard: "Only an OPEN request is new work — a fulfil or a withdrawal is not",
    file: PUSH,
    from: `  if (rec.status !== "open") return "not_open";`,
    to: ``,
    nodeTests: SERVER_TESTS,
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
