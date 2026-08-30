// ─── APPLY THE THREE INTAKE NODES' RULES TO THE LIVE DOCUMENT ────────────────
// /card_batch_intake, /card_batch_poll_status and /card_batch_intake_seen are
// TOP-LEVEL nodes written only by the Mac mini's poller through the Admin SDK.
// Top-level and unnamed, they answer to no rule at all — which is why the
// `".write": "false"` on each of them matters: it is not a restriction on the
// writer (the Admin SDK bypasses rules), it is the guarantee that nothing else
// can write there.
//
// THE METHOD IS THE HOUSE ONE, and it is the whole point of this file existing
// rather than someone pasting into the console: console-managed rules drift,
// and `database.rules.json` in this repo is STALE — deploying it would REGRESS
// the live document. So: GET live → timestamped backup IN THIS WORKTREE →
// patch in memory → diff → PUT → re-GET → verify byte-for-byte → RESTORE the
// backup on anything unexpected. NEVER `firebase deploy --only database`.
//
// The blocks come from scripts/cardrecon/intakeRules.mjs, which is also what
// print-card-intake-rule.mjs prints, so what was shown and what is live cannot
// diverge.
//
//   node scripts/cardrecon/apply-card-intake-rules.mjs           # dry run + diff
//   node scripts/cardrecon/apply-card-intake-rules.mjs --apply   # write + verify + auto-restore

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { INTAKE_RULE_BLOCKS } from "./intakeRules.mjs";

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const APPLY = process.argv.includes("--apply");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
// ── OUTSIDE THE REPO, WHICH IS PUBLIC ───────────────────────────────────────
// The backup is the complete LIVE enforcement document, and this repo's own
// database.rules.json is documented as stale — so a committed backup is the
// first accurate public copy of who may read what. It holds no credentials, and
// rules are enforcement rather than secrets, but it does tell anyone reading
// exactly which nodes a signed-in staff account can reach, which is a map worth
// having for someone who has got hold of a PIN. It goes in the home directory,
// named and timestamped, and the console prints the path.
// (Independent review, PR #519.)
const BACKUP = join(homedir(), `rules-live-backup-${stamp}-card-intake.json`);

// The Firebase CLI's own stored owner credentials (gcloud is not installed on
// this machine). Same accessor as scripts/merge-card-recon-top-level-rules.mjs.
function accessToken() {
  const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8"));
  const refresh = cfg?.tokens?.refresh_token;
  if (!refresh) throw new Error("No firebase-tools refresh token — run `firebase login`.");
  const body = new URLSearchParams({
    client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
    refresh_token: refresh, grant_type: "refresh_token",
  }).toString();
  const res = JSON.parse(execSync("curl -sS -X POST https://oauth2.googleapis.com/token -d @-",
    { input: body, encoding: "utf8" }));
  if (!res.access_token) throw new Error("Token refresh failed.");
  return res.access_token;
}
const token = accessToken();
const url = `${DB}/.settings/rules.json?access_token=${token}`;

const getRules = async (what) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET rules (${what}) failed: HTTP ${r.status}`);
  return r.text();
};

const before = await getRules("before");
const doc = JSON.parse(before);
const rules = doc.rules;

// ── Guards. Each of these would silently make the change pointless or unsafe ──
// 1. A TOP-LEVEL node only escapes a parent grant if the ROOT has none.
if (".read" in rules || ".write" in rules) {
  throw new Error("The ROOT carries a .read/.write — a top-level node would inherit it. Aborting.");
}
// 1b. …and no root wildcard. A $wildcard matches only children with no explicit
// sibling rule, so naming these puts them outside its reach — but a wildcard at
// the root is worth refusing to work beside blind.
const rootWildcards = Object.keys(rules).filter((k) => k.startsWith("$"));
if (rootWildcards.length) {
  throw new Error(`The ROOT carries wildcard(s) ${rootWildcards.join(", ")} — check deliberately before proceeding.`);
}
// 2. Never clobber something already there.
for (const name of Object.keys(INTAKE_RULE_BLOCKS)) {
  if (name in rules) {
    console.log(`\n/${name} ALREADY EXISTS at the top level:`);
    console.log(JSON.stringify(rules[name], null, 2));
    throw new Error(`Refusing to overwrite an existing /${name}. Inspect it first.`);
  }
}
// 3. The neighbours must come out byte-identical. /pos is the one three shops
// trade through; the existing card-recon trio is the evidence these nodes sit
// beside, and a change to their read grant is exactly the accident this method
// exists to catch.
const untouched = ["pos", "card_batches", "card_batch_drafts", "card_batch_overrides"];
// AN ABSENT KEY MUST NOT PASS. JSON.stringify(undefined) is undefined, so a
// missing neighbour compared equal to itself and the guard whose entire purpose
// is to catch a change to their read grant reported a clean pass while checking
// nothing. It did its job here because all four exist — but this script is
// documented as re-runnable elsewhere, and "elsewhere" is exactly where one of
// them is renamed. (Independent review, PR #519.)
for (const k of untouched) {
  if (!(k in rules)) throw new Error(`/${k} is not in the live document — the neighbour guard cannot check what is not there. Aborting.`);
}
const neighboursBefore = Object.fromEntries(untouched.map((k) => [k, JSON.stringify(rules[k])]));

for (const [name, block] of Object.entries(INTAKE_RULE_BLOCKS)) rules[name] = block;

const after = JSON.stringify(doc, null, 2) + "\n";
console.log("\n── the additions ────────────────────────────────────────────");
for (const [name, block] of Object.entries(INTAKE_RULE_BLOCKS)) {
  console.log(`"${name}": ${JSON.stringify(block, null, 2)}`);
}
console.log(`\nroot children: ${Object.keys(JSON.parse(before).rules).length} before → ${Object.keys(rules).length} after`);
for (const k of untouched) {
  console.log(`/${k} unchanged in the proposed document: ${JSON.stringify(rules[k]) === neighboursBefore[k]}`);
}

if (!APPLY) {
  console.log("\nDRY RUN — nothing written, and no backup left behind. Re-run with --apply.");
  process.exit(0);
}

// The backup is written HERE — after every guard has passed and immediately
// before the only write, so a dry run or a refusal leaves no stray snapshot of
// the live rules behind.
writeFileSync(BACKUP, before);
console.log(`\nlive rules backed up to ${BACKUP} (${before.length} bytes) — OUTSIDE the repo, which is public`);

// ── FROM HERE ON, A THROW IS A DOCUMENT LEFT IN AN UNKNOWN STATE ────────────
// The verify GET can fail on a transient 5xx or a dropped socket, AFTER the
// PUT has landed. Left unguarded that exits on an unhandled rejection: no
// verification, no restore, and not even the line telling someone to restore by
// hand — precisely the "surprise" this file's header promises to restore from.
// So everything after the write runs inside one try, and the catch restores.
// (Independent review, PR #519.)
const restore = async (why) => {
  console.error(`\nRESTORING the backup — ${why}`);
  try {
    const r = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: before });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    // ── THE RESTORE IS RE-READ TOO ──────────────────────────────────────────
    // It runs when the document is already known to be wrong, and it was the
    // one write in this script trusted on an HTTP status alone while the
    // forward write got three checks. If the restore is not byte-identical, say
    // so loudly: the backup file is the only remaining truth.
    const back = await getRules("restore");
    if (back !== before) throw new Error("the restored document does not match the backup");
    console.error(`restored from ./${BACKUP}, and verified byte-identical`);
  } catch (err) {
    console.error(`RESTORE FAILED (${err.message}) — restore ./${BACKUP} by hand NOW, through the same endpoint`);
  }
};

const put = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: after })
  .catch((err) => ({ ok: false, status: 0, text: async () => String(err.message) }));
if (!put.ok) {
  // A failed PUT may still have landed — a timeout says nothing about what the
  // server did — so this restores rather than assuming nothing happened.
  await restore(`the PUT reported HTTP ${put.status} ${await put.text()}`);
  process.exit(1);
}
console.log("\nwritten. re-fetching to verify…");

let live;
try {
  live = await getRules("after");
} catch (err) {
  await restore(`the verification re-fetch failed (${err.message}) — the write landed and cannot be checked`);
  process.exit(1);
}
const problems = [];
if (live !== after) problems.push("the re-fetched document is not byte-identical to what was sent");
const liveDoc = JSON.parse(live);
for (const k of untouched) {
  if (JSON.stringify(liveDoc.rules[k]) !== neighboursBefore[k]) problems.push(`/${k} CHANGED — it must be untouched`);
}
for (const [name, block] of Object.entries(INTAKE_RULE_BLOCKS)) {
  if (JSON.stringify(liveDoc.rules[name]) !== JSON.stringify(block)) problems.push(`/${name} did not land verbatim`);
}
const expected = [...Object.keys(JSON.parse(before).rules), ...Object.keys(INTAKE_RULE_BLOCKS)].sort();
if (JSON.stringify(Object.keys(liveDoc.rules).sort()) !== JSON.stringify(expected)) {
  problems.push("the set of root children is not exactly what was expected");
}

if (problems.length) {
  console.error("\nVERIFY FAILED:");
  for (const p of problems) console.error(`  • ${p}`);
  await restore("the written document did not verify");
  process.exit(1);
}

console.log("\nVERIFIED:");
console.log("  • the root carries no .read/.write and no wildcard — a top-level node is unreachable from above");
console.log(`  • ${Object.keys(INTAKE_RULE_BLOCKS).join(", ")} landed verbatim`);
console.log(`  • ${untouched.map((k) => `/${k}`).join(", ")} byte-identical — untouched`);
console.log(`  • root children: ${expected.length}, exactly the ones expected`);
console.log(`  • backup: ${BACKUP}`);
console.log("\nSTILL TO PROVE, and it is not provable from here: that a CARD_RECON");
console.log("HOLDER can now read the feed. This credential is the owner, who could");
console.log("read it either way. Check with a real holder's ID token — the poller");
console.log("identity is one — and expect 200 where it was 401.");
