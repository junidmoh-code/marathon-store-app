// ─── READ A WAITING SLIP NOW, NOT AT ITS NEXT RETRY ──────────────────────────
// Junid, 18 Oct 2026: Gemini was topped up; "re-run her slip now". A read job
// in `retry` waits out its back-off (up to four hours). This moves its next
// read to NOW, so the next five-minute sweep (cardBatchReadRetry) takes it.
//
// It touches ONLY the job's due time and its queue entry, in one multi-path
// write. The photo, the attempt count, the history and every record are left
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
const updates = {
  [`${JOBS_PATH}/${jobId}/dueAt`]: nowMs,
  [`${JOBS_PATH}/${jobId}/dueKey`]: newKey,
  [`${DUE_PATH}/${newKey}`]: jobId,
  ...(job.dueKey && job.dueKey !== newKey ? { [`${DUE_PATH}/${job.dueKey}`]: null } : {}),
};
console.log(`${EXECUTE ? "WRITING" : "Would write"}:`, updates);
if (!EXECUTE) { console.log("Dry run — re-run with --execute."); process.exit(0); }
await db.ref().update(updates);
console.log(`✓ due now (${new Date(nowMs).toISOString()}); the next cardBatchReadRetry sweep (every 5 min) reads it.`);
process.exit(0);
