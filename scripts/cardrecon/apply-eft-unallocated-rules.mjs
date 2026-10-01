// ─── APPLY THE UNALLOCATED-REMAINDER RULE TO THE LIVE DOCUMENT ───────────────
// /eft_unallocated is a TOP-LEVEL node written only by the eftPool callables
// through the Admin SDK. Top-level and unnamed, it answers to no rule at all —
// which is why the `".write": "false"` matters: it is not a restriction on the
// writer (the Admin SDK bypasses rules), it is the guarantee that nothing else
// can write there. The read grant is owner-only; the rationale lives in
// eftUnallocatedRules.mjs.
//
// THE METHOD IS THE HOUSE ONE, copied line for line from
// apply-card-intake-rules.mjs (see that file for why each guard exists):
// GET live → timestamped backup OUTSIDE the repo → patch in memory → diff →
// PUT → re-GET → verify byte-for-byte → RESTORE the backup on anything
// unexpected. NEVER `firebase deploy --only database` — the repo's
// database.rules.json is STALE and deploying it would REGRESS the live document.
//
//   node scripts/cardrecon/apply-eft-unallocated-rules.mjs    # dry run + diff
//   node scripts/cardrecon/apply-eft-unallocated-rules.mjs --apply   # write + verify + auto-restore

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { EFT_UNALLOCATED_RULE_BLOCKS as EFT_RULE_BLOCKS } from "./eftUnallocatedRules.mjs";

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const APPLY = process.argv.includes("--apply");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
// Outside the repo, which is public — the backup is the complete live
// enforcement document. (Independent review, PR #519.)
const BACKUP = join(homedir(), `rules-live-backup-${stamp}-eft-unallocated.json`);

// The Firebase CLI's own stored owner credentials (gcloud is not installed on
// this machine). Same accessor as apply-card-intake-rules.mjs.
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
if (".read" in rules || ".write" in rules) {
  throw new Error("The ROOT carries a .read/.write — a top-level node would inherit it. Aborting.");
}
const rootWildcards = Object.keys(rules).filter((k) => k.startsWith("$"));
if (rootWildcards.length) {
  throw new Error(`The ROOT carries wildcard(s) ${rootWildcards.join(", ")} — check deliberately before proceeding.`);
}
for (const name of Object.keys(EFT_RULE_BLOCKS)) {
  if (name in rules) {
    console.log(`\n/${name} ALREADY EXISTS at the top level:`);
    console.log(JSON.stringify(rules[name], null, 2));
    throw new Error(`Refusing to overwrite an existing /${name}. Inspect it first.`);
  }
}
// The neighbours must come out byte-identical — /pos trades three shops; the
// card-recon nodes are the pattern this one copies and must not be disturbed.
const untouched = [
  "pos", "card_batches", "card_batch_drafts", "card_batch_overrides",
  "card_batch_intake", "card_batch_poll_status", "card_batch_intake_seen", "eft_pool",
];
for (const k of untouched) {
  if (!(k in rules)) throw new Error(`/${k} is not in the live document — the neighbour guard cannot check what is not there. Aborting.`);
}
const neighboursBefore = Object.fromEntries(untouched.map((k) => [k, JSON.stringify(rules[k])]));

for (const [name, block] of Object.entries(EFT_RULE_BLOCKS)) rules[name] = block;

const after = JSON.stringify(doc, null, 2) + "\n";
console.log("\n── the addition ─────────────────────────────────────────────");
for (const [name, block] of Object.entries(EFT_RULE_BLOCKS)) {
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

writeFileSync(BACKUP, before);
console.log(`\nlive rules backed up to ${BACKUP} (${before.length} bytes) — OUTSIDE the repo, which is public`);

// From here on, a throw is a document left in an unknown state — everything
// after the write runs inside one try, and the catch restores.
const restore = async (why) => {
  console.error(`\nRESTORING the backup — ${why}`);
  try {
    const r = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: before });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const back = await getRules("restore");
    if (back !== before) throw new Error("the restored document does not match the backup");
    console.error(`restored from ${BACKUP}, and verified byte-identical`);
  } catch (err) {
    console.error(`RESTORE FAILED (${err.message}) — restore ${BACKUP} by hand NOW, through the same endpoint`);
  }
};

const put = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: after })
  .catch((err) => ({ ok: false, status: 0, text: async () => String(err.message) }));
if (!put.ok) {
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
// THE VERIFICATION ITSELF CAN THROW — malformed JSON, an empty document — and
// a throw here is after the PUT has landed: it must reach restore(), not an
// unhandled rejection that leaves the live document unverified and the backup
// unused. (CodeRabbit, this PR.)
const problems = [];
const expected = [...Object.keys(JSON.parse(before).rules), ...Object.keys(EFT_RULE_BLOCKS)].sort();
try {
  if (live !== after) problems.push("the re-fetched document is not byte-identical to what was sent");
  const liveDoc = JSON.parse(live);
  for (const k of untouched) {
    if (JSON.stringify(liveDoc.rules[k]) !== neighboursBefore[k]) problems.push(`/${k} CHANGED — it must be untouched`);
  }
  for (const [name, block] of Object.entries(EFT_RULE_BLOCKS)) {
    if (JSON.stringify(liveDoc.rules[name]) !== JSON.stringify(block)) problems.push(`/${name} did not land verbatim`);
  }
  if (JSON.stringify(Object.keys(liveDoc.rules).sort()) !== JSON.stringify(expected)) {
    problems.push("the set of root children is not exactly what was expected");
  }
} catch (err) {
  problems.push(`the verification itself failed (${err.message})`);
}

if (problems.length) {
  console.error("\nVERIFY FAILED:");
  for (const p of problems) console.error(`  • ${p}`);
  await restore("the written document did not verify");
  process.exit(1);
}

console.log("\nVERIFIED:");
console.log("  • the root carries no .read/.write and no wildcard — a top-level node is unreachable from above");
console.log(`  • ${Object.keys(EFT_RULE_BLOCKS).join(", ")} landed verbatim`);
console.log(`  • ${untouched.map((k) => `/${k}`).join(", ")} byte-identical — untouched`);
console.log(`  • root children: ${expected.length}, exactly the ones expected`);
console.log(`  • backup: ${BACKUP}`);
