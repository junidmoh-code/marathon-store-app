// ── BACKFILL /users/{uid}/permFlags FROM /users/{uid}/permissions ────────────
//
//   node scripts/backfillPermFlags.mjs             # dry run — prints, writes nothing
//   node scripts/backfillPermFlags.mjs --execute   # writes
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The RTDB rules cannot read the `permissions` ARRAY (it reaches the rules
// engine keyed by position, so there is no containment test), so every grant a
// RULE has to see is mirrored into a MAP at /users/{uid}/permFlags. From now on
// that map is written in the same update() as the array — by UserManagement for
// an edit, by createStaffUser for a new account.
//
// Existing accounts have no map at all. Without this pass, the new clause in the
// /shopify_publish rule can never match anyone, and a permission granted to an
// account created before today would show its card and then be refused by the
// database — a grant that looks present and is not.
//
// ── WHY IT IS SAFE TO RUN, AND TO RE-RUN ─────────────────────────────────────
// It is PURELY DERIVED: permFlags is computed from the permissions array that is
// already on the record, and nothing else is read or written. It grants nobody
// anything they do not already have — a flag only ever appears for a permission
// already in that account's array.
//
// It is IDEMPOTENT: a second run computes the same map and skips every record
// whose map already matches. Running it twice is running it once.
//
// It writes ONE CHILD per user (`permFlags`), with update(), so no other field
// on the record is touched — not the array it mirrors, not stockRole, not
// destShop. A rollback is `--clear`, which removes only that child.
//
// ── WHY IT READS THE WHOLE /users NODE ───────────────────────────────────────
// The standing rule against whole-node reads is about /stock and the movement
// feeds, which are megabytes. /users is the staff table: 33 records and ~8 KB on
// 2026-08-23. There is no bounded query that answers "every account", and
// per-uid reads would need the uid list first — which is the same read.
import { createRequire } from "node:module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";

const EXECUTE = process.argv.includes("--execute");
const CLEAR   = process.argv.includes("--clear");

// The SAME derivation the client and the server use. Kept as a literal copy
// rather than an import because this script must run against functions/'s
// dependency tree (CJS firebase-admin) while permissionCatalog.js is ESM in the
// bundle; the three are pinned equal by permissionFlags.test.js.
function permFlagsFor(permissions) {
  const flags = {};
  for (const key of Array.isArray(permissions) ? permissions : []) {
    if (typeof key === "string" && key) flags[key] = true;
  }
  return Object.keys(flags).length ? flags : null;
}

function sameFlags(a, b) {
  if (a === null || b === null) return a === b || (!a && !b);
  const ka = Object.keys(a || {}).sort(), kb = Object.keys(b || {}).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DB });
const db = admin.database();

const snap = await db.ref("users").once("value");
const users = snap.val() || {};
const uids = Object.keys(users);

let willWrite = 0, alreadyRight = 0, noPerms = 0;
const plan = [];

for (const uid of uids) {
  const u = users[uid] || {};
  const want = CLEAR ? null : permFlagsFor(u.permissions);
  const have = u.permFlags ?? null;
  const name = u.username || u.displayName || "(no username)";

  if (sameFlags(want, have)) {
    if (want === null) noPerms++; else alreadyRight++;
    continue;
  }
  willWrite++;
  plan.push({ uid, name, want, count: want ? Object.keys(want).length : 0 });
}

console.log(`\n/users records:            ${uids.length}`);
console.log(`already correct:           ${alreadyRight}`);
console.log(`no permissions (POS etc.): ${noPerms}`);
console.log(`${CLEAR ? "to clear" : "to write"}:                  ${willWrite}\n`);

for (const p of plan) {
  console.log(`  ${p.name.padEnd(16)} ${p.uid}  ${CLEAR ? "clear" : `${p.count} flag(s): ${Object.keys(p.want).join(", ")}`}`);
}

if (!EXECUTE) {
  console.log(`\nDRY RUN — nothing written. Re-run with --execute to apply.\n`);
  await admin.app().delete();
  process.exit(0);
}

// One update() per record, each touching ONLY the permFlags child. Not a
// multi-path update at /users: a single failure there would abandon the whole
// pass with no way to tell which half landed, whereas per-record writes fail
// individually and are re-runnable.
let ok = 0, failed = 0;
for (const p of plan) {
  try {
    await db.ref(`users/${p.uid}`).update({ permFlags: p.want });
    ok++;
  } catch (err) {
    failed++;
    console.error(`  ✗ ${p.name} (${p.uid}): ${err.message}`);
  }
}
console.log(`\nwritten: ${ok}   failed: ${failed}\n`);

// Read back and prove it, rather than trusting the writes returned cleanly.
const after = (await db.ref("users").once("value")).val() || {};
let mismatched = 0;
for (const uid of uids) {
  const want = CLEAR ? null : permFlagsFor(after[uid]?.permissions);
  if (!sameFlags(want, after[uid]?.permFlags ?? null)) {
    mismatched++;
    console.error(`  ✗ verify: ${after[uid]?.username || uid} does not match`);
  }
}
console.log(mismatched === 0
  ? "VERIFIED — every record's permFlags matches its permissions array.\n"
  : `✗✗ ${mismatched} record(s) do not match. Re-run.\n`);

await admin.app().delete();
process.exit(mismatched === 0 ? 0 : 1);
