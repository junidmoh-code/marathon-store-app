// ─── READ AGAIN: STANDARD BANK PHOTOS THAT WENT UNREAD THIS WEEK ─────────────
// Junid, 7 Nov 2026: Marathon PE Till 2's #564 was photographed twice (Yasmin
// 16:41, Junid 21:54) and refused both times — its TID line printed too faintly
// to read. Reader version 2 (lib/card-sb-photo.cjs sequenceTidProof) proves
// the till by its own batch chain. This queues the photos that went Unread
// under an OLDER Standard Bank reader for one more background read — exactly
// what Junid's "Read again" button (cardBatchManualEntry action "reread") does,
// for every such till/day of the last 7 days at once.
//
// BOUNDED: one indexed read of the jobs received in the last 7 days (push ids
// sort by time). Every such photo is queued, OLDEST FIRST and 90 s apart: the
// first read records the batch (and answers the staff member's own log entry),
// a second photo of the same paper then comes back "duplicate". A job that is not
// Unread, or was read by the current reader, is left alone. Writes go through
// a transaction that checks the job is still Unread. Running it twice changes
// nothing more: a re-queued job is no longer Unread.
//
//   node scripts/cardrecon/reread-sb-unread-20261107.mjs            # dry run
//   node scripts/cardrecon/reread-sb-unread-20261107.mjs --execute

import { createRequire } from "node:module";
import { adminRequire } from "../adminRequire.mjs";

const admin = adminRequire(import.meta.url)("firebase-admin");
const req = createRequire(import.meta.url);
const { JOBS_PATH, DUE_PATH, dueKey } = req("../../functions/lib/card-read-jobs.cjs");
const { SB_READER_VERSION } = req("../../functions/lib/card-sb-photo.cjs");

const EXECUTE = process.argv.includes("--execute");
const DAYS = 7;
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "marathon-club",
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const nowMs = Date.now() + ((await db.ref(".info/serverTimeOffset").once("value")).val() || 0);

// A push id's first 8 characters are its creation time — the lowest key from then.
const PUSH = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
const pushPrefix = (ms) => { let s = ""; for (let i = 0; i < 8; i++) { s = PUSH[ms % 64] + s; ms = Math.floor(ms / 64); } return s; };
const since = nowMs - DAYS * 24 * 60 * 60 * 1000;
const jobs = (await db.ref(JOBS_PATH).orderByKey().startAt(pushPrefix(since)).once("value")).val() || {};

const todo = Object.entries(jobs)
  .filter(([, j]) => j && j.bank === "standard-bank" && j.status === "unread" && j.mode !== "check")
  .filter(([, j]) => !(Number(j.readerVersion) >= SB_READER_VERSION))
  .sort((a, b) => Number(a[1].receivedAt) - Number(b[1].receivedAt));
console.log(`${Object.keys(jobs).length} job(s) since ${new Date(since).toISOString()}; ${todo.length} Standard Bank photo(s) Unread under reader < v${SB_READER_VERSION}.`);
let bad = 0;
for (const [i, [id, j]] of todo.entries()) {
  console.log(`${j.storeId}/${j.pickedTid}/${j.dayYmd} ${j.label || ""}: job ${id} by ${j.byEmail || j.by}, last: ${j.lastReason || "—"}`);
  if (!EXECUTE) continue;
  const due = nowMs + i * 90 * 1000;
  const key = dueKey(due, id);
  // The queue entry FIRST (architect review, #869): if this dies before the
  // job moves, the sweep drops an entry whose job is not waiting, and a
  // re-run finds the job still Unread. The other order could strand a job in
  // "retry" with no queue entry, invisible to the sweep and to a re-run.
  await db.ref(`${DUE_PATH}/${key}`).set(id);
  const txn = await db.ref(`${JOBS_PATH}/${id}`).transaction((cur) => {
    if (cur === null) return null;
    if (cur.status !== "unread") return undefined;
    return { ...cur, status: "retry", attempts: 0, refusedReads: 0, dueAt: due, dueKey: key, rereadAt: nowMs, readerVersion: SB_READER_VERSION };
  });
  const after = txn.snapshot && txn.snapshot.val();
  if (!txn.committed || !after || after.dueKey !== key) {
    await db.ref(`${DUE_PATH}/${key}`).remove();
    console.log("  ✗ changed under us — left alone"); bad++; continue;
  }
  console.log(`  ✓ queued for ${new Date(due).toISOString()}; the cardBatchReadRetry sweep (every 5 min) reads it.`);
}
if (!EXECUTE) console.log("Dry run — re-run with --execute.");
process.exit(bad ? 1 : 0);
