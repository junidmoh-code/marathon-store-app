// ─── MUTATION PROOF — THE EMAILED-SLIP INTAKE ────────────────────────────────
// Every property this feature depends on is SILENT when broken. A routing check
// that stops checking still records a batch — against the wrong till. A refusal
// filed as "unrelated" still appears in the feed — as noise nobody reads. A
// claim that always takes still processes the mail — twice. None of that turns
// a suite red by itself, so each one is broken on purpose here and the suite is
// asked whether it noticed.
//
// TWO FILES, TWO SUITES: the server's routing decision (functions/lib/
// card-recon-email.cjs, node --test) and the poller's own (scripts/cardrecon/
// intakeCore.mjs, vitest). Restores both on every exit path, writes nothing
// anywhere else, and touches no database.
//
//   node scripts/mutation-proof-card-intake.mjs

import { readFileSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const FUNCTIONS_DIR = fileURLToPath(new URL("../functions/", import.meta.url));

const TARGETS = {
  routing: {
    src: new URL("../functions/lib/card-recon-email.cjs", import.meta.url),
    run: () => execFileSync("node", ["--test", "test/card-recon-email.test.cjs"], { cwd: FUNCTIONS_DIR, stdio: "pipe" }),
  },
  parser: {
    src: new URL("../functions/lib/card-recon-pdf.cjs", import.meta.url),
    run: () => execFileSync("node", ["--test", "test/card-recon-pdf.test.cjs"], { cwd: FUNCTIONS_DIR, stdio: "pipe" }),
  },
  // normaliseMid moved here when the PDF parser started asking the same
  // question of a file about ITSELF. Both suites run against it, because both
  // now depend on it agreeing with itself.
  base: {
    src: new URL("../functions/lib/card-recon.cjs", import.meta.url),
    run: () => execFileSync("node", ["--test", "test/card-recon-email.test.cjs", "test/card-recon-pdf.test.cjs", "test/card-recon.test.cjs"], { cwd: FUNCTIONS_DIR, stdio: "pipe" }),
  },
  intake: {
    src: new URL("../scripts/cardrecon/intakeCore.mjs", import.meta.url),
    run: () => execFileSync("npx", ["vitest", "run", "scripts/cardrecon/intakeCore.test.mjs"], { cwd: REPO, stdio: "pipe" }),
  },
};
for (const t of Object.values(TARGETS)) t.original = readFileSync(t.src, "utf8");

const restore = () => {
  for (const t of Object.values(TARGETS)) { try { writeFileSync(t.src, t.original); } catch { /* nothing left to do */ } }
};
process.on("exit", restore);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(130); });

const MUTATIONS = [
  // ── The routing decision: which till an emailed slip lands on ─────────────
  ["routing", "an unregistered terminal is quietly accepted instead of refused",
    "  if (!terminal || !terminal.storeId || !terminal.tillId) {",
    "  if (false) {"],

  ["routing", "a terminal registered with no till still routes",
    "  if (!terminal || !terminal.storeId || !terminal.tillId) {",
    "  if (!terminal) {"],

  ["routing", "a contradicting merchant ID stops being a refusal",
    "  if (registered && printed && registered !== printed) {",
    "  if (false) {"],

  ["routing", "the MID comparison is made case of nothing — every MID matches",
    "  if (registered && printed && registered !== printed) {",
    "  if (registered && printed && false) {"],

  ["routing", "an unreadable TID routes to whatever the registry's first row is",
    "  if (!tid) {",
    "  if (false && !tid) {"],

  ["routing", "a missing merchant ID passes silently instead of saying so",
    "  if (registered && !printed) {",
    "  if (false) {"],

  ["routing", "a terminal with no MID registered pretends both checks ran",
    "  if (!registered) {",
    "  if (false) {"],

  ["base", "leading zeros make two identical merchants differ",
    '  const digits = String(raw ?? "").replace(/\\D/g, "").replace(/^0+/, "");',
    '  const digits = String(raw ?? "").replace(/\\D/g, "");'],

  // ── The parser: one file, one terminal ────────────────────────────────────
  ["parser", "a PDF naming two terminals takes the first and records it anyway",
    "  if (allTids.length > 1) {",
    "  if (false) {"],

  ["parser", "a PDF naming two merchants takes the first and records it anyway",
    "  if (allMids.length > 1) {",
    "  if (false) {"],

  ["parser", "only the first TID row is ever looked at",
    "  const allTids = [...new Set(fieldAll(rows, RE.tid).map(normaliseTid).filter(Boolean))];",
    "  const allTids = [tid];"],

  // ── The poller's own decisions ────────────────────────────────────────────
  ["intake", "the bytes stop deciding — a renamed JPEG is submitted as a slip",
    '  const isPdf = size >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-";',
    "  const isPdf = looksNamed;"],

  ["intake", "an oversized scan is submitted instead of refused with a reason",
    "  if (size > MAX_ATTACHMENT_BYTES) {",
    "  if (false) {"],

  ["intake", "a real refusal is filed as 'unrelated' — a failing terminal becomes noise",
    "  return NOT_A_SLIP.some((re) => re.test(text)) ? \"unrelated\" : \"refused\";",
    '  return "unrelated";'],

  ["intake", "every invoice is filed as a refusal — the alarm stops meaning anything",
    "  return NOT_A_SLIP.some((re) => re.test(text)) ? \"unrelated\" : \"refused\";",
    '  return "refused";'],

  ["intake", "a message already processed is processed again",
    '  if (claim.state === "done") return { take: false, done: true, why: "already processed" };',
    "  /* mutated */"],

  ["intake", "a claim another run is holding is taken anyway — two runs, one slip",
    "  if (age > STALE_CLAIM_MS) return { take: true, why: \"a previous run claimed this and never finished\" };",
    "  return { take: true, why: \"mutated\" };"],

  ["intake", "a held message is reported as finished, so the poller marks it read and nothing ever rescues it",
    '  return { take: false, done: false, why: "another run is holding it" };',
    '  return { take: false, done: true, why: "another run is holding it" };'],

  ["intake", "a finished message stops saying so, so it is re-downloaded every tick for ever",
    '  if (claim.state === "done") return { take: false, done: true, why: "already processed" };',
    '  if (claim.state === "done") return { take: false, why: "already processed" };'],

  ["intake", "a claim a killed run left behind is never retaken — the slip is lost",
    "  if (age > STALE_CLAIM_MS) return { take: true, why: \"a previous run claimed this and never finished\" };",
    "  /* mutated */"],

  ["intake", "a refused attachment no longer raises the message",
    '    state: refused > 0 ? "needs-attention" : "done",',
    '    state: "done",'],

  ["intake", "a thrown capture error vanishes instead of becoming a refusal",
    '  if (error) return { filename: name, outcome: "refused", reason: clip(error, 400) };',
    '  if (error) return { filename: name, outcome: "unrelated", reason: clip(error, 400) };'],

  ["intake", "one message may cost an unbounded number of capture calls",
    "    if (take.length >= MAX_ATTACHMENTS_PER_MESSAGE) {",
    "    if (false) {"],

  // The whole two-line expression, not just its first line: replacing only the
  // first left the `|| \`no-id|...\`` line dangling after a complete statement,
  // which is a SyntaxError — and a suite that fails to parse "kills" every
  // mutation for a reason that has nothing to do with what it tests.
  // (CodeRabbit, PR #510.)
  ["intake", "two different messages with no id collide, and the second is lost",
    "  const basis = clip(messageId, 400)\n    || `no-id|${uidValidity || \"\"}|${uid ?? \"\"}|${clip(from, 200) || \"\"}|${clip(subject, 200) || \"\"}|${date || \"\"}|${size || 0}`;",
    '  const basis = clip(messageId, 400) || "no-id";'],

  ["intake", "a subject line is stored unbounded — attacker text in a record people read",
    "  return s.length > max ? `${s.slice(0, max - 1)}…` : s;",
    "  return s;"],
];

function passes(target) {
  try { TARGETS[target].run(); return true; } catch { return false; }
}

console.log("Baseline: every suite must be green before any of this means anything.");
for (const name of Object.keys(TARGETS)) {
  if (!passes(name)) { console.error(`✗ the ${name} suite is RED before a single mutation`); process.exit(1); }
  console.log(`✓ baseline green — ${name}`);
}
console.log("");

let survived = 0;
for (const [target, name, find, replace] of MUTATIONS) {
  const t = TARGETS[target];
  const hits = t.original.split(find).length - 1;
  if (hits !== 1) {
    console.error(`✗ MUTATION DID NOT APPLY (${hits} matches): ${name}`);
    console.error("  the source has moved under this proof — fix the anchor, do not delete the mutation");
    survived++;
    continue;
  }
  writeFileSync(t.src, t.original.replace(find, replace));
  const stillGreen = passes(target);
  writeFileSync(t.src, t.original);
  if (stillGreen) { console.log(`✗ SURVIVED  [${target}] ${name}`); survived++; }
  else { console.log(`✓ killed    [${target}] ${name}`); }
}

console.log(`\n${MUTATIONS.length - survived}/${MUTATIONS.length} mutations killed.`);
if (survived) {
  console.error(`✗✗ ${survived} mutation(s) survived — the suite does not test what it appears to test.`);
  process.exit(1);
}
console.log("Every deliberate break was caught.");
