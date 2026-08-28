// ─── MOVE THE CARD-RECON NODES OUT FROM UNDER /pos ───────────────────────────
// Card-recon records are investigation material about named staff: masked PANs,
// auth codes, RRNs, and a per-till variance. Under /pos they inherited the
// block's `.read` — "any signed-in, non-anonymous staff member" — and the only
// way to stop that from there was to rewrite /pos's read grant child by child,
// which is a shop-stopping risk for a benefit obtainable another way.
//
// So the nodes move to the TOP LEVEL, where no parent grant reaches them:
//   /card_batches  /card_batch_drafts  /card_batch_overrides
// read and write owner-only. Writes still happen through the Admin SDK inside
// the callables, which bypasses rules entirely — the owner-only `.write` is a
// belt, not the mechanism.
//
// NOTHING UNDER /pos IS TOUCHED. The old /pos/card_* rules stay exactly as they
// are, and that is deliberate: they carry `".write": "false"`, so any client
// still running yesterday's bundle is REFUSED rather than quietly creating a
// shadow record under the old path.
//
//   node scripts/merge-card-recon-top-level-rules.mjs           # dry run + diff
//   node scripts/merge-card-recon-top-level-rules.mjs --apply   # write + verify + auto-restore
//
// Method (the house one — console-managed rules drift, and database.rules.json
// in this repo is STALE): GET live → timestamped backup IN THIS WORKTREE →
// patch in memory → diff → PUT → re-GET → verify byte-for-byte → RESTORE the
// backup on anything unexpected. NEVER `firebase deploy --only database`.

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import process from "node:process";

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const APPLY = process.argv.includes("--apply");
const OWNER = "gunidmoh@gmail.com";
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const BACKUP = `rules-live-backup-${stamp}.json`;

// The Firebase CLI's own stored owner credentials (gcloud is not installed).
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

const ownerOnly = `auth != null && auth.token.email === '${OWNER}'`;
const BLOCKS = {
  card_batches: {
    ".read": ownerOnly,
    ".write": ownerOnly,
    // The POS reader's two queries: the per-terminal closedAt range subscription
    // and the equalTo(batchNo) revision-completion fetch. Without these the
    // reads still answer correctly but scan the terminal's node client-side.
    $storeId: { $tid: { ".indexOn": ["slip/closedAt", "batchNo"] } },
  },
  card_batch_drafts: { ".read": ownerOnly, ".write": ownerOnly },
  card_batch_overrides: { ".read": ownerOnly, ".write": ownerOnly },
};

const before = await getRules("before");
const doc = JSON.parse(before);
const rules = doc.rules;

// ── Guards. Each of these would silently make the move pointless. ───────────
// 1. A TOP-LEVEL node only escapes a parent grant if the ROOT has none.
if (".read" in rules || ".write" in rules) {
  throw new Error("The ROOT carries a .read/.write — a top-level node would inherit it. Aborting: this move would not achieve anything.");
}
// 1b. …and if no root-level $wildcard could claim it. In RTDB a $wildcard only
// matches children with NO explicit sibling rule, so a named node is outside
// its reach — but a wildcard at the root is worth refusing to work beside
// blind, because the next person adding a node here may not name it.
const rootWildcards = Object.keys(rules).filter((k) => k.startsWith("$"));
if (rootWildcards.length) {
  throw new Error(`The ROOT carries wildcard(s) ${rootWildcards.join(", ")}. Naming these nodes puts them outside that reach, but check it deliberately before proceeding.`);
}
// 2. Never clobber something already there.
for (const name of Object.keys(BLOCKS)) {
  if (name in rules) {
    console.log(`\n/${name} ALREADY EXISTS at the top level:`);
    console.log(JSON.stringify(rules[name], null, 2));
    throw new Error(`Refusing to overwrite an existing /${name}. Inspect it first.`);
  }
}
// 3. /pos must come out byte-identical.
const posBefore = JSON.stringify(rules.pos);

for (const [name, block] of Object.entries(BLOCKS)) rules[name] = block;

const after = JSON.stringify(doc, null, 2) + "\n";
console.log("\n── the additions ────────────────────────────────────────────");
for (const [name, block] of Object.entries(BLOCKS)) {
  console.log(`"${name}": ${JSON.stringify(block, null, 2).replace(/\n/g, "\n")}`);
}
console.log(`\nroot children: ${Object.keys(JSON.parse(before).rules).length} before → ${Object.keys(rules).length} after`);
console.log(`/pos unchanged in the proposed document: ${JSON.stringify(rules.pos) === posBefore}`);

if (!APPLY) {
  console.log("\nDRY RUN — nothing written, and no backup file left behind. Re-run with --apply.");
  process.exit(0);
}

// The backup is written HERE — after every guard has passed and immediately
// before the only write. Writing it on entry left a stray snapshot of the live
// rules behind on every dry run and every refusal.
writeFileSync(BACKUP, before);
console.log(`\nlive rules backed up to ./${BACKUP} (${before.length} bytes)`);

const put = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: after });
if (!put.ok) throw new Error(`PUT failed: HTTP ${put.status} ${await put.text()}`);
console.log("\nwritten. re-fetching to verify…");

const live = await getRules("after");
const problems = [];
if (live !== after) problems.push("the re-fetched document is not byte-identical to what was sent");
const liveDoc = JSON.parse(live);
if (JSON.stringify(liveDoc.rules.pos) !== posBefore) problems.push("/pos CHANGED — it must be untouched");
for (const [name, block] of Object.entries(BLOCKS)) {
  if (JSON.stringify(liveDoc.rules[name]) !== JSON.stringify(block)) problems.push(`/${name} did not land verbatim`);
}
const expected = [...Object.keys(JSON.parse(before).rules), ...Object.keys(BLOCKS)].sort();
if (JSON.stringify(Object.keys(liveDoc.rules).sort()) !== JSON.stringify(expected)) {
  problems.push("the set of root children is not exactly what was expected");
}

if (problems.length) {
  console.error("\nVERIFY FAILED:");
  for (const p of problems) console.error(`  • ${p}`);
  console.error("RESTORING the backup…");
  const restore = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: before });
  console.error(restore.ok ? `restored from ./${BACKUP}` : `RESTORE ALSO FAILED (HTTP ${restore.status}) — restore ./${BACKUP} by hand NOW`);
  process.exit(1);
}

console.log("\nVERIFIED:");
console.log("  • the root carries no .read/.write and no wildcard — a top-level node is unreachable from above");
console.log(`  • /card_batches, /card_batch_drafts, /card_batch_overrides landed verbatim, owner-only`);
console.log(`  • /pos byte-identical — untouched`);
console.log(`  • root children: ${expected.length}, exactly the ones expected`);
console.log(`  • backup: ./${BACKUP}`);
