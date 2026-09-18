// ─── THE 2026-09-18 TERMINAL ESTATE, APPLIED IN ONE GO ────────────────────────
// The estate changed: three tills renamed, two machines added, none removed, and
// Trophy Till 1's merchant number — unknown when it was mapped — now known.
//
//   node scripts/apply-terminal-registry-20260918.mjs            # dry run + diff
//   node scripts/apply-terminal-registry-20260918.mjs --execute  # write + verify
//
// ── THE STORE KEY STAYS `pe` ────────────────────────────────────────────────
// The shop trades as Marathon and its terminals are now labelled "Marathon Till
// 1/2/3". Its STORE ID is not renamed, and that is the whole point of the
// distinction:
//
//   · /pos/paymentEvents rows carry `storeId: "pe"`. The expected-card
//     calculator joins the registry's storeId+tillId against them VERBATIM, so
//     a registry that said "marathon" would compute R0 expected for every
//     Marathon till and report every batch as a 100% variance.
//   · /card_batches is filed under the store id — 30 records live under
//     /card_batches/pe today — and every reader subscribes to
//     card_batches/{registry storeId}/{tid}. Re-keying the registry without
//     migrating those makes them unreachable.
//   · The id is a join key across the entire estate: /pos/sales, /pos/cashups,
//     the credit ledger, /inventory, and the canonical /stock location
//     "marathon-pe". Renaming it is not a card-recon change, it is an estate
//     migration.
//   · There is precedent, and it is the owner's own: POS PR #26 renamed the
//     shops to "Marathon PE / Marathon Pine / Trophy" and deliberately kept the
//     ids `pe / pine / trophy` — "no data migration; existing values keep
//     working".
//   · And POS #357 (17 Sep 2026) REVERTED a reader that followed a terminal's
//     store-mapping history, on the owner's instruction. The estate is built on
//     a terminal's store id not moving.
//
// So: NO STORE KEY CHANGES, NO RECORDS MIGRATE, NOTHING IS ORPHANED. The
// trading name lives in `label`, which is exactly what this change moves.
//
// ── WHAT DOES MOVE ──────────────────────────────────────────────────────────
// Two rows change tillId (0000HP1X till-1 → till-2, 67365901 till-2 → till-3).
// That is safe where a store change would not be, because a batch record stamps
// its own storeId, tillId and terminalLabel at capture: the 12 batches already
// filed under 0000HP1X keep saying pe/till-1/"PE Till 1", which is where that
// money was actually rung. Only NEW captures join on the new till — which is
// the machine's new home, and the reason the owner renamed it.

import { createRequire } from "module";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

const EXECUTE = process.argv.includes("--execute");

// The estate as the owner gave it, 18 Sep 2026. `mid` omitted means none
// registered; every row here has one.
const ESTATE = {
  "67325636": { mid: "100000002453164", storeId: "pe",     tillId: "till-1", label: "Marathon Till 1" },
  "0000HP1X": { mid: "000000004977890", storeId: "pe",     tillId: "till-2", label: "Marathon Till 2" },
  "67365901": { mid: "100000001178101", storeId: "pe",     tillId: "till-3", label: "Marathon Till 3" },
  "67377843": { mid: "100000002816030", storeId: "trophy", tillId: "till-1", label: "Trophy Till 1"   },
  "0000Z4M6": { mid: "000000004977890", storeId: "trophy", tillId: "till-2", label: "Trophy Till 2"   },
  "67364485": { mid: "100000001178101", storeId: "pine",   tillId: "till-1", label: "Pine Till 1"     },
};

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const SERVER_NOW = admin.database.ServerValue.TIMESTAMP;

const before = (await db.ref("config/cardTerminals").get()).val() || {};

// ── COUNT WHAT EXISTS, PER STORE AND PER TERMINAL, BEFORE AND AFTER ─────────
// Nothing in this change moves a record. Counting anyway is what makes that a
// FACT rather than an intention.
//
// COUNTED BY KEY, over REST, with `shallow=true`. The Admin SDK has no shallow
// read: `ref.once("value")` on a terminal's node pulls every record it holds,
// each carrying a whole transaction roll — that is the bandwidth mistake this
// repo keeps a rule against, and a counting routine is the last place worth
// making it. Shallow returns `{ "494": true, … }`: the keys, and nothing else.
function accessToken() {
  const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8"));
  const body = new URLSearchParams({
    client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
    refresh_token: cfg?.tokens?.refresh_token, grant_type: "refresh_token",
  }).toString();
  // --http1.1 and a retry: this token endpoint intermittently fails HTTP/2
  // framing from here, and a registry script that dies on a transport hiccup
  // gets re-run by hand until it does not, which is how a half-applied estate
  // happens.
  const res = JSON.parse(execSync(
    "curl -sS --http1.1 --retry 3 --retry-all-errors -X POST https://oauth2.googleapis.com/token -d @-",
    { input: body, encoding: "utf8" }));
  if (!res.access_token) throw new Error("Token refresh failed — run `firebase login`.");
  return res.access_token;
}
const TOKEN = accessToken();
const DB_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
// RETRIED ON A CONNECTION FAILURE, not on an answer. This laptop intermittently
// cannot reach Google over IPv6, and a counting pass that dies of a transport
// hiccup makes an operator re-run a registry script until it does not — which
// is how a half-considered estate gets applied. An HTTP status is an answer and
// is never retried.
async function shallow(path, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(`${DB_URL}/${path}.json?shallow=true&access_token=${TOKEN}`);
      if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
      return (await r.json()) || {};
    } catch (err) {
      if (i >= attempts || /HTTP \d/.test(err.message)) throw err;
      console.warn(`  ${path}: connection failed (${err?.cause?.code || err.message}) — retrying ${i}/${attempts - 1}`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

async function batchCounts() {
  const out = {};
  for (const storeId of Object.keys(await shallow("card_batches"))) {
    for (const tid of Object.keys(await shallow(`card_batches/${storeId}`))) {
      out[`${storeId}/${tid}`] = Object.keys(await shallow(`card_batches/${storeId}/${tid}`)).length;
    }
  }
  return out;
}

const countsBefore = await batchCounts();
console.log("batch records BEFORE:", JSON.stringify(countsBefore));

const updates = {};
for (const [tid, want] of Object.entries(ESTATE)) {
  const cur = before[tid] || null;
  if (cur && cur.storeId && cur.storeId !== want.storeId) {
    console.error(`REFUSED: ${tid} would move store ${cur.storeId} → ${want.storeId}, which strands /card_batches/${cur.storeId}/${tid}. Nothing written.`);
    process.exit(1);
  }
  const row = { ...(cur || {}), ...want };
  // A TILL MOVE IS STAMPED. Two rows move till in this change, and the first
  // batch each of them files afterwards covers a window that OPENED BEFORE the
  // move — the expected-card figure for it joins the new till across the whole
  // window and is not to be trusted. The stamp is what makes the capture say so
  // on the record (tillMoveWarning, functions/lib/card-terminals.cjs) instead of
  // publishing a confident wrong variance on the one batch anybody will check.
  if (cur && cur.tillId && cur.tillId !== want.tillId) row.tillChangedAt = SERVER_NOW;
  // Rows seeded before `activeFrom` existed have always been active; stamping
  // them NOW would tell the outstanding report they arrived today and blank
  // their whole history of expected evenings. Only a row being created gets a
  // stamp.
  if (!cur && !Number.isFinite(row.activeFrom)) row.activeFrom = SERVER_NOW;
  updates[tid] = row;
  const changes = Object.entries(want).filter(([k, v]) => !cur || cur[k] !== v).map(([k, v]) => `${k}: ${cur ? JSON.stringify(cur[k]) : "—"} → ${JSON.stringify(v)}`);
  console.log(`${cur ? "UPDATE" : "CREATE"} ${tid}${changes.length ? `  [${changes.join(", ")}]` : "  [no change]"}`);
}
for (const tid of Object.keys(before)) {
  if (!ESTATE[tid]) console.log(`LEFT ALONE ${tid} — not in this change; a mapping is never deleted.`);
}

if (!EXECUTE) {
  console.log("\ndry run — nothing written. Re-run with --execute.");
  process.exit(0);
}

// ── THE SNAPSHOT MUST STILL BE TRUE ────────────────────────────────────────
// `before` was read at the top, and three shallow counting walks have happened
// since. Every row below is a FULL REPLACEMENT built from that snapshot, so
// anything written to one of these six rows in the meantime — a `retiredAt`
// from a concurrent `seed-card-terminals.mjs --retire`, a hand edit in the
// console — would be silently clobbered by a value computed before it existed.
// update() makes this all-or-nothing; it does not make it a merge. So: re-read,
// and refuse if the ground moved. (Second-pass review, PR #611.)
const stillBefore = (await db.ref("config/cardTerminals").get()).val() || {};
for (const tid of Object.keys(ESTATE)) {
  if (JSON.stringify(stillBefore[tid] ?? null) !== JSON.stringify(before[tid] ?? null)) {
    console.error(`REFUSED: ${tid} changed in the registry while this script was running.`);
    console.error(`  was: ${JSON.stringify(before[tid] ?? null)}`);
    console.error(`  now: ${JSON.stringify(stillBefore[tid] ?? null)}`);
    console.error("Nothing was written — the plan above was made against a registry that has moved. Re-run it.");
    process.exit(1);
  }
}
for (const tid of Object.keys(stillBefore)) {
  if (!before[tid]) {
    console.error(`REFUSED: ${tid} was ADDED to the registry while this script was running. Nothing was written; re-run.`);
    process.exit(1);
  }
}

// ONE ATOMIC update() ON THE PARENT, keyed by TID.
//
// NOT set() — a set() on /config/cardTerminals would DELETE every row this
// script does not name, which is the one thing the registry must never do.
// update() writes only the keys it is given and leaves the rest alone.
//
// AND NOT A LOOP OF PER-TID set()s, which is what this did first. Six
// sequential writes is six chances to lose the network half-way, and a
// half-applied estate is one where some machines answer to their new till and
// some to their old — while the shop is trading and the poller is running every
// 120 seconds. One update() commits all six or none. (CodeRabbit, PR #611.)
await db.ref("config/cardTerminals").update(updates);

const after = (await db.ref("config/cardTerminals").get()).val() || {};
let bad = 0;
for (const [tid, want] of Object.entries(ESTATE)) {
  const got = after[tid];
  for (const [k, v] of Object.entries(want)) {
    if (!got || got[k] !== v) { console.error(`SURPRISE: ${tid}.${k} is ${JSON.stringify(got && got[k])}, expected ${JSON.stringify(v)}`); bad++; }
  }
  // A NEW row must be stamped. A row that existed before must NOT be — the four
  // seeded on 2026-08-29 predate the field and have always been active, and
  // stamping them now would tell the outstanding report they arrived today.
  // (An earlier version of this check demanded the stamp on every row and would
  // have failed the run four times over, after writing successfully. CodeRabbit,
  // PR #611.)
  if (!before[tid]) {
    if (!Number.isFinite(got?.activeFrom)) { console.error(`SURPRISE: new row ${tid} carries no activeFrom stamp (${JSON.stringify(got?.activeFrom)})`); bad++; }
  } else if ("activeFrom" in (got || {}) && !Number.isFinite(got.activeFrom)) {
    console.error(`SURPRISE: ${tid}.activeFrom is present but unusable (${JSON.stringify(got.activeFrom)})`); bad++;
  }
  const movedTill = before[tid] && before[tid].tillId && before[tid].tillId !== want.tillId;
  if (movedTill && !Number.isFinite(got?.tillChangedAt)) { console.error(`SURPRISE: ${tid} moved till and carries no tillChangedAt stamp — its next batch would publish an untrustworthy variance silently`); bad++; }
}
for (const tid of Object.keys(before)) {
  if (!after[tid]) { console.error(`SURPRISE: ${tid} disappeared from the registry`); bad++; }
}

const countsAfter = await batchCounts();
console.log("batch records AFTER: ", JSON.stringify(countsAfter));
if (JSON.stringify(countsBefore) !== JSON.stringify(countsAfter)) {
  console.error("SURPRISE: the batch counts moved. This change touches no record — investigate before trusting the registry.");
  bad++;
}

console.log(bad ? `\n${bad} surprise(s) — check by hand.` : "\nregistry applied and verified; no batch record moved.");
console.log(JSON.stringify(after, null, 2));
process.exit(bad ? 1 : 0);
