// ─── MUTATION PROOF — DOES THE WATCHDOG SUITE ACTUALLY BITE? ─────────────────
//
// social-health.test.cjs is green. So was every check on 2026-08-27, the day
// the engine stopped producing. A green suite is evidence of nothing until you
// have broken the property on purpose and watched it go red.
//
// This breaks lib/social-health.cjs one mutation at a time, in the shapes a
// real regression would take — a check quietly dropped, a threshold widened, a
// severity downgraded, a filter loosened — and asserts the suite FAILS for
// each. A mutation that survives names a property nobody is testing.
//
// Writes nothing anywhere. The file is restored on every exit path, including
// a crash and a Ctrl-C.
//
//   node scripts/mutation-proof-social-health.mjs

import { readFileSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const SRC = new URL("../functions/lib/social-health.cjs", import.meta.url);
const FUNCTIONS_DIR = fileURLToPath(new URL("../functions/", import.meta.url));
const original = readFileSync(SRC, "utf8");

const restore = () => { try { writeFileSync(SRC, original); } catch { /* nothing left to do */ } };
process.on("exit", restore);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(130); });

// Each mutation is [name, find, replace]. `find` must appear EXACTLY once — a
// mutation that silently fails to apply is a mutation that trivially
// "survives" and would be reported as a hole in the suite that is not there.
const MUTATIONS = [
  ["generation check removed entirely",
    "} else if (made === 0) {",
    "} else if (false) {"],

  ["a run that made NOTHING is treated as fine",
    "reasons.push(`the 06:00 generator made nothing — all ${skipped || wanted} skipped`);",
    "/* mutated */"],

  ["a PARTIAL run is treated as fine",
    "reasons.push(`the 06:00 generator made ${made} of ${wanted}`);",
    "/* mutated */"],

  ["a missing autopilot record is treated as fine",
    'reasons.push("the 06:00 generator has no record of running today");',
    "/* mutated */"],

  ["the generator's own error is swallowed",
    "reasons.push(`the 06:00 generator failed: ${String(autopilotLog.error).slice(0, 200)}`);",
    "/* mutated */"],

  ["overdue posts no longer raise anything",
    "reasons.push(`${overdue.length} approved post(s) are past due and still unpublished`);",
    "/* mutated */"],

  ["the publish grace period is widened to a week",
    "const PUBLISH_GRACE_MS = 20 * 60 * 1000;",
    "const PUBLISH_GRACE_MS = 7 * 24 * 60 * 60 * 1000;"],

  ["overdue only looks at today, forgetting a post stranded yesterday",
    "Number(p.scheduledAt) < nowMs - PUBLISH_GRACE_MS);",
    "Number(p.scheduledAt) < nowMs - PUBLISH_GRACE_MS && Number(p.scheduledAt) >= dayStart);"],

  ["failed posts no longer raise anything",
    "reasons.push(`${failed.length} post(s) are in failed`);",
    "/* mutated */"],

  ["the silence check is removed",
    'reasons.push("nothing has published today");',
    "/* mutated */"],

  ["a post counts as published on STATUS alone, even if every platform failed",
    'return Object.values(r).some((x) => x && x.state === "ok");',
    "return true;"],

  ["published-today loses its day window, so yesterday's post covers today",
    "Number(p.postedAt) >= dayStart && Number(p.postedAt) < dayEnd &&",
    ""],

  ["the heartbeat check is removed",
    "} else if (nowMs - tickAt > HEARTBEAT_STALE_MS) {",
    "} else if (false) {"],

  ["a never-ticking publisher is treated as fine",
    'reasons.push("the publisher has never recorded a tick");',
    "/* mutated */"],

  ["the heartbeat staleness window is widened to a day",
    "const HEARTBEAT_STALE_MS = 15 * 60 * 1000;",
    "const HEARTBEAT_STALE_MS = 24 * 60 * 60 * 1000;"],

  ["severity is never worse than degraded",
    'const severity = reasons.length === 0\n    ? "ok"\n    : (nothingPublished || publisherDead) ? "silent" : "degraded";',
    'const severity = reasons.length === 0 ? "ok" : "degraded";'],

  // These two were ONE mutation under the first name, which was wrong: setting
  // nothingPublished to false does not stop a dead publisher forcing "silent",
  // because publisherDead is a separate term. The mutation was killed, but not
  // by the property its name claimed.
  ["nothing publishing no longer counts toward 'silent'",
    "const nothingPublished = earliestDue !== undefined && publishedToday.length === 0;",
    "const nothingPublished = false;"],

  ["a dead publisher no longer counts toward 'silent'",
    "const publisherDead = !haveTick || nowMs - tickAt > HEARTBEAT_STALE_MS;",
    "const publisherDead = false;"],

  ["a DISCARDED post is enough to make the day look owed",
    'const OWED_STATUSES = new Set(["approved", "posting", "posted", "failed"]);',
    'const OWED_STATUSES = new Set(["approved", "posting", "posted", "failed", "draft", "discarded"]);'],

  ["the SA offset is dropped, filing every evening under the wrong day",
    "return Math.floor((ms + SAST_OFFSET_MS) / DAY_MS) * DAY_MS - SAST_OFFSET_MS;",
    "return Math.floor(ms / DAY_MS) * DAY_MS;"],

  ["the alarm message loses its reasons",
    'return `${head} ${verdict.reasons.join("; ")}.`;',
    "return head;"],

  // Added after review found the original heartbeat check comparing THROUGH
  // NaN — every non-numeric value read as a fresh tick. These pin the fix.
  ["the heartbeat value is coerced instead of type-checked",
    "  const tickAt = timestampOrNull(publisherTickAt);\n  const haveTick = tickAt !== null;",
    "  const tickAt = Number(publisherTickAt);\n  const haveTick = publisherTickAt != null;"],

  ["a non-timestamp heartbeat is accepted as valid",
    "  if (typeof v === \"number\") return Number.isFinite(v) ? v : null;",
    "  if (typeof v === \"number\") return v;"],

  ["an object or array heartbeat coerces instead of being refused",
    "  return null;\n}\n\n/** Midnight SAST",
    "  return Number(v);\n}\n\n/** Midnight SAST"],

  ["a numeric string heartbeat stops counting as a heartbeat",
    '  if (typeof v === "string" && v.trim() !== "") {',
    "  if (false) {"],

  ["policyTotal stops counting RTDB's object form",
    'const len = (v) => (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0);',
    "const len = (v) => (Array.isArray(v) ? v.length : 0);"],
];

function suitePasses() {
  try {
    execFileSync("node", ["--test", "test/social-health.test.cjs"], { cwd: FUNCTIONS_DIR, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

console.log("Baseline: the suite must be green before any of this means anything.");
if (!suitePasses()) {
  console.error("✗ the suite is RED before a single mutation — fix that first");
  process.exit(1);
}
console.log("✓ baseline green\n");

let survived = 0;
for (const [name, find, replace] of MUTATIONS) {
  const hits = original.split(find).length - 1;
  if (hits !== 1) {
    console.error(`✗ MUTATION DID NOT APPLY (${hits} matches): ${name}`);
    console.error("  the source has moved under this proof — fix the anchor, do not delete the mutation");
    survived++;
    continue;
  }
  writeFileSync(SRC, original.replace(find, replace));
  const stillGreen = suitePasses();
  writeFileSync(SRC, original);
  if (stillGreen) { console.log(`✗ SURVIVED  ${name}`); survived++; }
  else { console.log(`✓ killed    ${name}`); }
}

console.log(`\n${MUTATIONS.length - survived}/${MUTATIONS.length} mutations killed.`);
if (survived) {
  console.error(`✗✗ ${survived} mutation(s) survived — the suite does not test what it appears to test.`);
  process.exit(1);
}
console.log("Every deliberate break was caught.");
