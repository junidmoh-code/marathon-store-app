// ─── HUB REFILL: NO SHOP TAG + THE PICK CLAIM — mutation proof ──────────────
// Each mutation breaks ONE guard and expects the suite to go RED. Run from the
// repo root on a CLEAN, COMMITTED tree:
//   node scripts/mutation-proof-pick-claim.mjs
// Restores every file from the bytes it captured, never from git.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { requireCleanTree } from "./lib/mutationPreflight.mjs";

const QUEUE = "src/components/stock/RefillQueue.jsx";
const MARKER = "src/components/stock/pickMarker.js";
const REFUSAL = "src/components/stock/refusalGuard.js";
const RULE = "functions/lib/shop-source-rule.cjs";
const ENGINE = "functions/lib/refill-engine.cjs";
const SCAN = "functions/refill-scan.cjs";
const TRIGGER = "functions/lib/first-batch.cjs";
const QUEUE_TESTS = ["src/components/stock/RefillQueue.render.test.jsx"];
const MARKER_TESTS = ["src/components/stock/pickMarker.test.js"];
const SERVER_TESTS = ["test/pick-marker.test.cjs"];

const MUTATIONS = [
  // ── commit 2: no shop name, one row ───────────────────────────────────────
  { id: "M-TAG-BACK", guard: "no line names a shop", file: QUEUE,
    from: "{sent > 0 && <span style={{ fontSize: 11, color: GRAY }}>· {sent} sent</span>}",
    to: "{sent > 0 && <span style={{ fontSize: 11, color: GRAY }}>· {sent} sent</span>}{row._r?.forDests?.length ? <span>· for {row._r.forDests.map((d) => HUB_LABEL[d] || d).join(\" + \")}</span> : null}",
    tests: QUEUE_TESTS },
  { id: "M-ROW-WRAPS", guard: "Fulfil and Out of Stock never wrap apart", file: QUEUE,
    from: `gap: 8, flexWrap: "nowrap" }}>`, to: `gap: 8, flexWrap: "wrap" }}>`, tests: QUEUE_TESTS },
  // ── commit 3: the claim, client ───────────────────────────────────────────
  { id: "M-CLAIM-SKIPPED", guard: "Fulfil claims before it moves stock", file: QUEUE,
    from: `    let claimed = false;\n    if (!res) {`, to: `    let claimed = false;\n    if (false) {`, tests: QUEUE_TESTS },
  { id: "M-CLAIM-OTHER", guard: "another device's fresh claim stops Fulfil", file: MARKER,
    from: `  if (pickInProgress(cur, atMs) && cur.picking.movementId !== movementId) return undefined;`, to: ``, tests: [...MARKER_TESTS, ...QUEUE_TESTS] },
  { id: "M-CLAIM-END", guard: "the fulfil write ends the claim", file: QUEUE,
    from: "        [`refill_requests/${r.id}/picking`]: null,             // the claim ends with the fulfil", to: ``, tests: QUEUE_TESTS },
  { id: "M-CLAIM-RELEASE", guard: "a failed move releases the claim", file: QUEUE,
    from: "    if (!res.ok) { await releaseClaim(); return", to: "    if (!res.ok) { return", tests: QUEUE_TESTS },
  { id: "M-OOS-WAITS", guard: "Out of Stock waits on a claim", file: REFUSAL,
    from: `  if (pickInProgress(cur, nowMs)) return undefined;`, to: ``, tests: MARKER_TESTS },
  { id: "M-TTL-CLIENT", guard: "a stale claim stops blocking (client twin)", file: MARKER,
    from: `  return nowMs - at < PICK_MARKER_TTL_MS;`, to: `  return true;`, tests: MARKER_TESTS },
  // ── commit 3: the claim, server ───────────────────────────────────────────
  { id: "M-TTL-SERVER", guard: "a stale claim stops blocking (server)", file: RULE,
    from: `  return nowMs - at < PICK_MARKER_TTL_MS;`, to: `  return true;`, nodeTests: SERVER_TESTS },
  { id: "M-UNTOUCHED-CLAIM", guard: "a claimed request is not untouched", file: RULE,
    from: `  if (pickInProgress(rr, nowMs)) return false;`, to: ``, nodeTests: SERVER_TESTS },
  { id: "M-ENG-PICKING-INFLIGHT", guard: "the plan treats a claim as in flight", file: ENGINE,
    from: `        const inFlight = inFlightPlanGen || inFlightLedger || inFlightMidWrite || inFlightPicking;`, to: `        const inFlight = inFlightPlanGen || inFlightLedger || inFlightMidWrite;`, nodeTests: SERVER_TESTS },
  { id: "M-ENG-PICKING-WITHDRAW", guard: "the plan never withdraws a claimed request", file: ENGINE,
    from: `        if ((needGone || unfillable || sourceEmpty) && !inFlightPicking) {`, to: `        if (needGone || unfillable || sourceEmpty) {`, nodeTests: SERVER_TESTS },
  { id: "M-SCAN-CLOSE-CLAIM", guard: "the close transaction refuses a claim", file: SCAN,
    from: `  if (pickInProgress(cur)) return;\n  // A shop ← Central withdrawal`, to: `  // A shop ← Central withdrawal`, nodeTests: SERVER_TESTS },
  { id: "M-SCAN-RESIZE-CLAIM", guard: "the resize transaction refuses a claim", file: SCAN,
    from: `          if (pickInProgress(cur)) return;                               // never resized mid-pick`, to: ``, nodeTests: SERVER_TESTS },
  { id: "M-SCAN-SAT-CLAIM", guard: "the lock-less withdrawal refuses a claim", file: SCAN,
    from: `        if (pickInProgress(cur)) return;                      // claimed by a picker — never withdrawn mid-pick`, to: ``, nodeTests: SERVER_TESTS },
  { id: "M-SCAN-KEEP-LOCK-OPEN", guard: "an open request whose close was refused keeps its lock", file: SCAN,
    from: `            if (!(res && res.committed) && res?.snapshot?.val()?.status === "open") continue;`, to: ``, nodeTests: SERVER_TESTS },
  { id: "M-TRIG-CLAIM", guard: "the first-batch withdrawal refuses a claim", file: TRIGGER,
    from: `      if (pickInProgress(cur)) return undefined;   // a picker has claimed it — never withdrawn mid-pick`, to: ``, nodeTests: SERVER_TESTS },
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
