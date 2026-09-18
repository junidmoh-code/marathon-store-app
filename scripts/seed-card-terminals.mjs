// ─── /config/cardTerminals — ONE ROW PER PHYSICAL CARD MACHINE ────────────────
// The card-recon capture rejects any slip whose printed TID is not registered
// here. One row per machine, keyed by the TID it prints; that key is the only
// thing that identifies it (functions/test/card-terminal-identity.test.cjs).
//
//   node scripts/seed-card-terminals.mjs \
//     --tid 0000HP1X --mid 000000004977890 --store pe --till till-2 \
//     --label "Marathon Till 2" --execute
//
// Without --execute it prints what it WOULD write. Store ids are the POS ids
// (pe / pine / trophy) and till ids the POS till ids (till-1 … till-3) —
// exactly what /pos/paymentEvents rows carry, because the expected-card
// calculator joins on them verbatim. THE STORE ID IS NOT A TRADING NAME: PE
// trades as Marathon and its terminals are labelled "Marathon Till N", while
// its store id stays `pe` — the id is a join key across the whole estate
// (/pos/sales, /pos/paymentEvents, /card_batches, /inventory), the label is
// what a person reads. Renaming the shop renames the LABEL.
//
// ── A TID MAPPING IS NEVER DELETED ──────────────────────────────────────────
// Batches are filed under /card_batches/{storeId}/{tid}. Delete the mapping and
// every reader stops subscribing to that node: years of records are still there
// and nothing can reach them. A machine that leaves the estate is RETIRED —
//
//   node scripts/seed-card-terminals.mjs --tid 67365901 --retire \
//     --reason "swapped for a PAX A920Pro" --execute
//   node scripts/seed-card-terminals.mjs --tid 67365901 --reinstate --execute
//
// — which stamps `retiredAt`, keeps the row and all of its history, stops the
// capture screen offering it and stops the callable taking a hand capture
// against it. A batch report that emails itself in afterwards is still
// recorded, with the retirement said out loud on the record: dropping a late
// final settlement to make a point about tidiness is the worse answer.
//
// ── A STORE MOVE IS REFUSED WHILE IT WOULD ORPHAN RECORDS ───────────────────
// Re-pointing a TID at a different STORE moves where its future batches are
// filed, and leaves the past ones under the old store where nothing looks any
// more. This script refuses that while records exist under the old path, and
// prints what would have to be migrated. (Till and label moves are free: those
// live INSIDE the record, stamped at capture.)

import { createRequire } from "module";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
};
const has = (name) => process.argv.includes(`--${name}`);
const EXECUTE = has("execute");
const RETIRE = has("retire");
const REINSTATE = has("reinstate");

const tid = (arg("tid") || "").trim().toUpperCase();
const mid = (arg("mid") || "").trim();
const storeId = (arg("store") || "").trim();
const tillId = (arg("till") || "").trim();
const label = (arg("label") || "").trim();
const reason = (arg("reason") || "").trim();

if (!/^[A-Z0-9]{4,16}$/.test(tid)) { console.error("--tid must be 4-16 alphanumerics (as printed on the slip)"); process.exit(1); }
if (RETIRE && REINSTATE) { console.error("--retire and --reinstate are opposites; pick one"); process.exit(1); }
// A mapping is edited or retired, never removed. There is no delete flag here
// on purpose, and adding one is the change this comment exists to argue with.
if (has("delete") || has("remove")) {
  console.error("REFUSED: a TID mapping is never deleted — its batches are filed under it and would be stranded. Use --retire.");
  process.exit(1);
}
if (!RETIRE && !REINSTATE) {
  if (!["pe", "pine", "trophy"].includes(storeId)) { console.error("--store must be pe | pine | trophy (the POS store ids, not trading names)"); process.exit(1); }
  if (!/^till-\d$/.test(tillId)) { console.error("--till must be a POS till id, e.g. till-1"); process.exit(1); }
  if (!label) { console.error("--label is required, e.g. \"Marathon Till 2\""); process.exit(1); }
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const path = `config/cardTerminals/${tid}`;
const existing = (await db.ref(path).get()).val();
if (existing) console.log("EXISTING row:", JSON.stringify(existing));

// THE SERVER'S CLOCK, never this laptop's: `activeFrom` and `retiredAt` bound
// what the outstanding-slip report expects of a terminal, and a machine stamped
// from a skewed laptop is a machine reported as missing evenings it was not in
// the estate for. RTDB fills the sentinel as it writes, so the row is stamped
// by the database itself and read back to prove it — no probe node, nothing
// left behind under a path the capture screen enumerates.
const SERVER_NOW = admin.database.ServerValue.TIMESTAMP;

let row;
if (RETIRE || REINSTATE) {
  if (!existing) { console.error(`REFUSED: ${tid} is not registered, so there is nothing to ${RETIRE ? "retire" : "reinstate"}.`); process.exit(1); }
  row = { ...existing };
  if (RETIRE) {
    // A REPEAT --retire MUST NOT MOVE THE DATE. The stamp is a reporting
    // boundary: the outstanding-slip report stops expecting a slip after it, so
    // re-stamping on a retry or a second run silently rewrites which evenings
    // that machine owed. Retiring an already-retired terminal is a no-op that
    // says so. (CodeRabbit, PR #611.)
    if (Number.isFinite(existing.retiredAt)) {
      console.log(`${tid} was already retired on ${new Date(existing.retiredAt).toISOString().slice(0, 10)} — the stamp is left alone.`);
      if (reason && !existing.retiredReason) row.retiredReason = reason;
    } else {
      row.retiredAt = SERVER_NOW;
      if (reason) row.retiredReason = reason;
    }
  } else {
    delete row.retiredAt;
    delete row.retiredReason;
  }
} else {
  // A STORE MOVE IS THE ONE EDIT THAT CAN STRAND RECORDS.
  if (existing && existing.storeId && existing.storeId !== storeId) {
    // ONE KEY, NEVER THE NODE. Each record carries a whole transaction roll and
    // they accumulate for years; the question here is only "is there anything
    // under the old path", which orderByKey().limitToFirst(1) answers for the
    // price of a single record. (The same rule readBatchKeysFor follows.)
    const probe = await db.ref(`card_batches/${existing.storeId}/${tid}`).orderByKey().limitToFirst(1).once("value");
    if (probe.exists()) {
      console.error(`REFUSED: ${tid} is mapped to store "${existing.storeId}" and holds batch records at /card_batches/${existing.storeId}/${tid}.`);
      console.error(`Re-pointing it at "${storeId}" would leave those where no reader looks. Migrate them first (copy → verify counts → delete the old path), then run this again.`);
      process.exit(1);
    }
    console.log(`store move ${existing.storeId} → ${storeId}: no records under the old path, nothing to migrate.`);
  }
  row = {
    ...(existing || {}),
    mid: mid || (existing && existing.mid) || null,
    storeId, tillId, label,
  };
  // WHEN THIS MACHINE ENTERED THE ESTATE — not when it was made, and not batch
  // 1: two of the six live machines arrived second-hand on batches 57 and 480.
  // It bounds the outstanding-slip report, which would otherwise report a
  // terminal registered today as having missed every evening in the range.
  if (!Number.isFinite(row.activeFrom)) row.activeFrom = SERVER_NOW;
  // WHEN ITS TILL LAST CHANGED. A batch settles at ~18:50, so the first window
  // after a till move began BEFORE the move — and the expected-card figure for
  // that window joins the NEW till across the whole of it. This stamp is what
  // lets the capture say so on the record instead of publishing a confident
  // wrong variance. See tillMoveWarning in functions/lib/card-terminals.cjs.
  if (existing && existing.tillId && existing.tillId !== tillId) row.tillChangedAt = SERVER_NOW;
  if (row.mid === null) delete row.mid;
}

const shown = JSON.stringify(row, (k, v) => (v === SERVER_NOW ? "<server timestamp>" : v));
console.log(`${EXECUTE ? "WRITING" : "WOULD write"} /${path}:`, shown);
if (EXECUTE) {
  await db.ref(path).set(row);
  const after = (await db.ref(path).get()).val();
  console.log("done — verify:", JSON.stringify(after));
  // The sentinel is only a promise until it is read back: a row whose stamp
  // came back as anything but a number was not stamped by the server.
  for (const field of ["activeFrom", "retiredAt", "tillChangedAt"]) {
    if (field in row && !Number.isFinite(after && after[field])) {
      console.error(`SURPRISE: ${field} did not come back as a server timestamp — check /${path} by hand.`);
      process.exit(1);
    }
  }
}
process.exit(0);
