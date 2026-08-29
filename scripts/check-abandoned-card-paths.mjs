// ─── ARE THE ABANDONED /pos CARD PATHS STILL EMPTY? ──────────────────────────
// The card-recon records moved to the top level so that no parent grant reaches
// them. The old /pos/card_batches, /pos/card_batch_drafts and
// /pos/card_batch_overrides remain in the live rules carrying `".write":
// "false"`, which is deliberate: an old bundle is refused rather than quietly
// writing a shadow record.
//
// THEIR READ CANNOT BE CLOSED. RTDB read grants cascade downward and cannot be
// revoked by a deeper rule — /pos grants `.read` to every signed-in
// non-anonymous staff member, so `".read": "false"` on a child of /pos does
// nothing at all. (Verified against the real rules engine with exactly that
// rule applied: staff read straight through it. The `.write` denial works only
// because /pos has no `.write` of its own to override.)
//
// So the safety of those paths rests entirely on them being EMPTY and staying
// empty. Two things keep them that way, and this script checks the second:
//   • no client can write them            — the `.write": "false"` rule
//   • no server code names them           — functions/test/card-recon-paths.test.cjs
//   • and nothing is there today          — THIS
//
//   node scripts/check-abandoned-card-paths.mjs
//
// Exits non-zero if anything has appeared, because that would be readable by
// every signed-in staff member and would need moving, not just deleting.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import process from "node:process";

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const PATHS = ["pos/card_batches", "pos/card_batch_drafts", "pos/card_batch_overrides"];

function accessToken() {
  const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8"));
  const body = new URLSearchParams({
    client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
    refresh_token: cfg.tokens.refresh_token, grant_type: "refresh_token",
  }).toString();
  return JSON.parse(execSync("curl -sS -X POST https://oauth2.googleapis.com/token -d @-",
    { input: body, encoding: "utf8" })).access_token;
}

const token = accessToken();
let occupied = 0;
for (const path of PATHS) {
  // `shallow=true` returns keys only — never the records themselves.
  const res = await fetch(`${DB}/${path}.json?shallow=true&access_token=${token}`);
  if (!res.ok) { console.error(`  ${path}: read failed HTTP ${res.status}`); process.exitCode = 2; continue; }
  const val = await res.json();
  const n = val === null ? 0 : Object.keys(val).length;
  if (n) occupied++;
  console.log(`  /${path.padEnd(24)} ${n === 0 ? "empty" : `${n} record(s)  ← READABLE BY EVERY SIGNED-IN STAFF MEMBER`}`);
}

console.log(occupied === 0
  ? "\nAll abandoned paths are empty — the residual read grant on them exposes nothing."
  : "\nSomething is sitting on an abandoned path. It is readable estate-wide. Move it to the top-level node and delete it from here.");
process.exit(occupied ? 1 : (process.exitCode ?? 0));
