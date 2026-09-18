// ─── /config/cardTerminals — VALIDATE THE TWO NEW STAMPS ─────────────────────
// The registry gained `activeFrom` and `retiredAt` (and an optional
// `retiredReason`) on 2026-09-18. Both are epoch milliseconds and both BOUND A
// FINANCIAL REPORT: `activeFrom` decides which evenings a terminal is expected
// to have filed a slip for, `retiredAt` decides when it stops being expected at
// all. A string in either place is a machine silently dropped from — or added
// to — the outstanding-slip report.
//
// The readers already refuse a non-numeric stamp (functions/lib/card-terminals.cjs
// treats anything but a finite number as absent, which fails SAFE: the terminal
// stays live and stays expected). This rule stops the bad value being written in
// the first place. It is a belt: every write today goes through the Admin SDK,
// which bypasses rules entirely — but the node carries a stockRole-admin
// `.write` grant, so a client CAN write it, and this is what that client is
// held to.
//
// NOTHING ELSE IN THE RULES IS TOUCHED, and the change is provably inert for
// every row that exists: none of the four rows seeded on 2026-08-29 carries
// either field, and the two rows created on 2026-09-18 carry server timestamps,
// which are numbers.
//
//   node scripts/cardrecon/apply-terminal-registry-rules.mjs           # dry run + diff
//   node scripts/cardrecon/apply-terminal-registry-rules.mjs --apply   # write + verify
//
// Method (the house one — console-managed rules drift, and database.rules.json
// in this repo is STALE): GET live → timestamped backup IN THIS WORKTREE →
// patch in memory → diff → PUT → re-GET → verify → RESTORE the backup on
// anything unexpected. NEVER `firebase deploy --only database`.

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import process from "node:process";

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const APPLY = process.argv.includes("--apply");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const BACKUP = `rules-live-backup-${stamp}-cardterminals.json`;

function accessToken() {
  const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8"));
  const body = new URLSearchParams({
    client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
    refresh_token: cfg?.tokens?.refresh_token, grant_type: "refresh_token",
  }).toString();
  const res = JSON.parse(execSync(
    "curl -sS --http1.1 --retry 3 --retry-all-errors -X POST https://oauth2.googleapis.com/token -d @-",
    { input: body, encoding: "utf8" }));
  if (!res.access_token) throw new Error("Token refresh failed — run `firebase login`.");
  return res.access_token;
}
const token = accessToken();
const url = `${DB}/.settings/rules.json?access_token=${token}`;

// A RULES SCRIPT MUST NOT DIE OF A TRANSPORT HICCUP. This laptop intermittently
// fails to connect to Google over IPv6, and a half-run rules edit — PUT sent,
// verification never reached — is the state this whole method exists to avoid.
// A connection failure is retried; an HTTP answer is not, because an answer is
// an answer.
const tryFetch = async (what, init, attempts = 4) => {
  for (let i = 1; ; i++) {
    try { return await fetch(url, init); } catch (err) {
      if (i >= attempts) throw new Error(`${what}: could not reach the database after ${attempts} attempts (${err?.cause?.code || err?.message})`);
      console.warn(`  ${what}: connection failed (${err?.cause?.code || err?.message}) — retrying ${i}/${attempts - 1}`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
};
const getRules = async (what) => {
  const r = await tryFetch(`GET rules (${what})`);
  if (!r.ok) throw new Error(`GET rules (${what}) failed: HTTP ${r.status}`);
  return r.text();
};
const putRules = async (text) => {
  const r = await tryFetch("PUT rules", { method: "PUT", body: text });
  if (!r.ok) throw new Error(`PUT rules failed: HTTP ${r.status} ${await r.text()}`);
};

const NUMBER = { ".validate": "newData.isNumber()" };
const STRING = { ".validate": "newData.isString()" };

const before = await getRules("before");
writeFileSync(BACKUP, before);
console.log(`live rules backed up to ${BACKUP} (${before.length} bytes)`);

const doc = JSON.parse(before);
const node = doc?.rules?.config?.cardTerminals?.$tid;

// ── GUARDS. Each of these would make the patch meaningless or destructive. ──
if (!node) throw new Error("live rules have no config/cardTerminals/$tid block — the shape has moved; patch nothing.");
if (node[".validate"] !== "newData.hasChildren(['storeId','tillId'])") {
  throw new Error(`the $tid .validate is not what this script was written against (${JSON.stringify(node[".validate"])}) — read it before patching.`);
}
for (const [field, want] of [["activeFrom", NUMBER], ["retiredAt", NUMBER], ["retiredReason", STRING]]) {
  if (node[field] && JSON.stringify(node[field]) !== JSON.stringify(want)) {
    throw new Error(`${field} already carries a DIFFERENT rule (${JSON.stringify(node[field])}) — this script would overwrite it.`);
  }
}

node.activeFrom = NUMBER;
node.retiredAt = NUMBER;
node.retiredReason = STRING;

const after = JSON.stringify(doc, null, 2);
console.log("\n--- the block, after ---");
console.log(JSON.stringify(doc.rules.config.cardTerminals, null, 2));

if (!APPLY) { console.log("\ndry run — nothing written. Re-run with --apply."); process.exit(0); }

await putRules(after);
const check = JSON.parse(await getRules("after"))?.rules?.config?.cardTerminals?.$tid;
const ok = check
  && JSON.stringify(check.activeFrom) === JSON.stringify(NUMBER)
  && JSON.stringify(check.retiredAt) === JSON.stringify(NUMBER)
  && JSON.stringify(check.retiredReason) === JSON.stringify(STRING)
  && check[".validate"] === "newData.hasChildren(['storeId','tillId'])"
  && check.storeId?.[".validate"] === "newData.isString()"
  && check.tillId?.[".validate"] === "newData.isString()";
if (!ok) {
  console.error("SURPRISE: the live rules did not come back as written — RESTORING the backup.");
  await putRules(before);
  console.error(`restored ${BACKUP}. Nothing else was changed.`);
  process.exit(1);
}
console.log("\napplied and verified against the live rules.");
