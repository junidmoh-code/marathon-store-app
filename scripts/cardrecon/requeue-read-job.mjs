// ─── READ A WAITING SLIP NOW, NOT AT ITS NEXT RETRY ──────────────────────────
// Junid, 18 Oct 2026: Gemini was topped up; "re-run her slip now". A read job
// in `retry` waits out its back-off (up to four hours). This moves its next
// read to NOW, so the next five-minute sweep (cardBatchReadRetry) takes it.
//
// It touches ONLY the job's due time (a transaction that checks the job is
// still waiting) and then its queue entry. The photo, the attempt count, the history and every record are left
// alone; a job that is not waiting (recorded, unread, duplicate, or being read
// right now) is refused. Running it twice changes nothing more.
//
//   node scripts/cardrecon/requeue-read-job.mjs <jobId>            # dry run
//   node scripts/cardrecon/requeue-read-job.mjs <jobId> --execute

import { createRequire } from "node:module";
import { adminRequire } from "../adminRequire.mjs";

const admin = adminRequire(import.meta.url)("firebase-admin");
const { JOBS_PATH, DUE_PATH, dueKey } = createRequire(import.meta.url)("../../functions/lib/card-read-jobs.cjs");

const jobId = process.argv[2];
const EXECUTE = process.argv.includes("--execute");
if (!/^[A-Za-z0-9_-]{10,40}$/.test(jobId || "")) { console.error("usage: requeue-read-job.mjs <jobId> [--execute]"); process.exit(1); }

admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "marathon-club",
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const nowMs = Date.now() + ((await db.ref(".info/serverTimeOffset").once("value")).val() || 0);
const job = (await db.ref(`${JOBS_PATH}/${jobId}`).once("value")).val();
if (!job) { console.error(`✗ no job ${jobId}`); process.exit(1); }
console.log(`${job.label || job.pickedTid} ${job.dayYmd}: status ${job.status}, attempt ${job.attempts}, due ${job.dueAt ? new Date(job.dueAt).toISOString() : "—"}, last: ${job.lastOutcome || "—"}`);
if (job.status !== "retry" && job.status !== "queued") { console.error(`✗ not waiting (${job.status}) — nothing to do.`); process.exit(job.status === "recorded" ? 0 : 1); }
if (Number.isFinite(job.dueAt) && job.dueAt <= nowMs) { console.log("Already due — the next sweep takes it. Nothing written."); process.exit(0); }

const newKey = dueKey(nowMs, jobId);
console.log(`${EXECUTE ? "WRITING" : "Would write"}: job ${jobId} dueAt → ${new Date(nowMs).toISOString()}, queue ${job.dueKey || "—"} → ${newKey}`);
if (!EXECUTE) { console.log("Dry run — re-run with --execute."); process.exit(0); }
// CONDITIONAL (CodeRabbit, #754): the job moves only if it is STILL waiting
// under the queue key read above — a worker that claimed or finished it in
// between wins, and nothing is written.
const txn = await db.ref(`${JOBS_PATH}/${jobId}`).transaction((cur) => {
  if (cur === null) return null; // cold-null: let the server answer
  if ((cur.status !== "retry" && cur.status !== "queued") || cur.dueKey !== job.dueKey) return undefined;
  return { ...cur, dueAt: nowMs, dueKey: newKey };
});
const after = txn.snapshot && txn.snapshot.val();
if (!txn.committed || !after || after.dueKey !== newKey) { console.error("✗ the job changed under us (claimed or finished) — nothing written."); process.exit(1); }
// The queue follows the job. A stale entry left by a crash here is cleaned by
// the sweep itself (sweepReadJobs drops an entry whose job no longer matches).
await db.ref().update({
  [`${DUE_PATH}/${newKey}`]: jobId,
  ...(job.dueKey && job.dueKey !== newKey ? { [`${DUE_PATH}/${job.dueKey}`]: null } : {}),
});
console.log(`✓ due now (${new Date(nowMs).toISOString()}); the next cardBatchReadRetry sweep (every 5 min) reads it.`);
process.exit(0);
