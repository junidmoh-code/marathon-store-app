// ─── REPROCESS: PE TILL 2, TROPHY TILL 2 AND PINE FROM 2 NOV 2026 (Junid, 27 Nov 2026) ─
// Junid's total rule (functions/lib/card-total-rule.cjs) is live: a slip is
// READ the moment its bottom total is found. This re-reads every photo of
// Marathon PE Till 2 (0000HP1X), Trophy Till 2 (0000Z4M6) and Pine Till 1
// (67364485) received from 2 Nov 2026 that went Unread under the old gates —
// exactly what Junid's "Read again" button does (cardBatchManualEntry
// "reread"), for all of them at once — and then reports, per till and day,
// the total read, the POS card total and the verdict.
//
// BOUNDED, never a whole node: one key-range read of the jobs received since
// 2 Nov (push ids sort by time); per till one indexed range of its records
// (slip/closedAt); one indexed range of /pos/paymentEvents (at).
// IDEMPOTENT: a job is re-queued only while it is still "unread" (a
// transaction checks); a re-queued job is no longer Unread, so a second run
// queues nothing. Records are never written here — the read job does that,
// through the same pipeline as every slip.
//
//   node scripts/cardrecon/reprocess-till2-pine-20261127.mjs             # dry run + report
//   node scripts/cardrecon/reprocess-till2-pine-20261127.mjs --execute   # re-queue, then report
//   node scripts/cardrecon/reprocess-till2-pine-20261127.mjs --report    # the report only
import { createRequire } from "node:module";
import { adminRequire } from "../adminRequire.mjs";

const admin = adminRequire(import.meta.url)("firebase-admin");
const req = createRequire(import.meta.url);
const { JOBS_PATH, DUE_PATH, dueKey } = req("../../functions/lib/card-read-jobs.cjs");

const EXECUTE = process.argv.includes("--execute");
const REPORT_ONLY = process.argv.includes("--report");
const FROM = "2026-11-02";
const TILLS = [
  { store: "pe", tid: "0000HP1X", tillId: "till-2", label: "Marathon PE Till 2" },
  { store: "trophy", tid: "0000Z4M6", tillId: "till-2", label: "Trophy Till 2" },
  { store: "pine", tid: "67364485", tillId: "till-1", label: "Pine Till 1" },
];
const SAST = 2 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const ymd = (ms) => new Date(ms + SAST).toISOString().slice(0, 10);
const rand = (c) => (Number.isInteger(c) ? `R${(c / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—");

admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "marathon-club",
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const nowMs = Date.now() + ((await db.ref(".info/serverTimeOffset").once("value")).val() || 0);
const fromMs = Date.parse(`${FROM}T00:00:00+02:00`);

if (!REPORT_ONLY) {
  const PUSH = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
  const pushPrefix = (ms) => { let s = ""; for (let i = 0; i < 8; i++) { s = PUSH[ms % 64] + s; ms = Math.floor(ms / 64); } return s; };
  const jobs = (await db.ref(JOBS_PATH).orderByKey().startAt(pushPrefix(fromMs)).once("value")).val() || {};
  const tids = new Set(TILLS.map((t) => t.tid));
  const todo = Object.entries(jobs)
    // Unread — or already moved by an earlier run of THIS script (so a run that
    // died before writing the queue entry is finished by the next one).
    .filter(([, j]) => j && tids.has(j.pickedTid) && j.mode !== "check"
      && (j.status === "unread" || (j.status === "retry" && j.rereadFor === "total-rule-20261127")))
    .sort((a, b) => Number(a[1].receivedAt) - Number(b[1].receivedAt));
  console.log(`${Object.keys(jobs).length} job(s) since ${FROM}; ${todo.length} Unread on these tills.`);
  for (const [i, [id, j]] of todo.entries()) {
    console.log(`  ${j.label || j.pickedTid} ${j.dayYmd}: job ${id} (${j.byEmail || j.by}) — last: ${String(j.lastReason || "—").slice(0, 160)}`);
    if (!EXECUTE) continue;
    const due = nowMs + i * 90 * 1000;
    const key = dueKey(due, id);
    // The JOB first, then its queue entry (CodeRabbit, #1022): the sweep drops
    // an entry whose job is still Unread, so an entry written first could be
    // lost. A run that dies between the two is finished by the next run (the
    // filter above takes this script's own "retry" jobs too).
    const txn = await db.ref(`${JOBS_PATH}/${id}`).transaction((cur) => {
      if (cur === null) return null;
      if (cur.status === "retry" && cur.rereadFor === "total-rule-20261127") return { ...cur, dueAt: due, dueKey: key };
      if (cur.status !== "unread") return undefined;
      return { ...cur, status: "retry", attempts: 0, refusedReads: 0, dueAt: due, dueKey: key, rereadAt: nowMs, rereadFor: "total-rule-20261127" };
    });
    const after = txn.snapshot && txn.snapshot.val();
    if (!txn.committed || !after || after.dueKey !== key) {
      console.log("    ✗ changed under us — left alone");
      continue;
    }
    await db.ref(`${DUE_PATH}/${key}`).set(id);
    console.log(`    ✓ queued for ${new Date(due).toISOString()} — the cardBatchReadRetry sweep reads it.`);
  }
  if (!EXECUTE) console.log("Dry run — nothing queued. Re-run with --execute.");
}

// ── THE REPORT: per till and day, the total read, the POS total, the verdict ──
// Right after --execute the re-queued reads have not run yet (90 s apart):
// run again with --report once the sweep has read them.
if (EXECUTE) console.log("\n(The reads just queued have not run yet — re-run with --report in ~10 minutes for their verdicts.)");
const events = (await db.ref("pos/paymentEvents").orderByChild("at").startAt(fromMs).once("value")).val() || {};
const posDay = new Map();
for (const e of Object.values(events)) {
  if (!e || e.method !== "card" || !Number.isInteger(e.amount)) continue;
  const k = `${e.storeId}/${e.tillId}/${ymd(e.at)}`;
  posDay.set(k, (posDay.get(k) || 0) + e.amount);
}
const today = ymd(nowMs);
for (const t of TILLS) {
  const recs = (await db.ref(`card_batches/${t.store}/${t.tid}`).orderByChild("slip/closedAt").startAt(fromMs).once("value")).val() || {};
  // The record in force per batch number (highest revision), not displaced.
  const best = new Map();
  for (const [key, r] of Object.entries(recs)) {
    if (!r || r.displacedBy || !r.slip) continue;
    const b = Number(r.batchNo); const cur = best.get(b);
    if (!cur || (Number(r.revision) || 1) > (Number(cur.r.revision) || 1)) best.set(b, { key, r });
  }
  const byDay = new Map();
  for (const { key, r } of best.values()) {
    const d = ymd(Number(r.slip.closedAt));
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push({ key, r });
  }
  console.log(`\n${t.label} (${t.tid})`);
  for (let ms = fromMs; ymd(ms) <= today; ms += DAY) {
    const d = ymd(ms);
    const pos = posDay.get(`${t.store}/${t.tillId}/${d}`) || 0;
    const rows = byDay.get(d) || [];
    if (!rows.length) {
      if (pos) console.log(`  ${d}  read —            POS ${rand(pos).padStart(12)}  NO RECORD`);
      continue;
    }
    for (const { key, r } of rows) {
      const v = Number.isInteger(r.varianceCents) ? r.varianceCents : null;
      const verdict = v === null ? "—" : Math.abs(v) <= 500 ? "GREEN" : "RED";
      const src = r.fromTypedTotal ? "typed total" : r.capturedVia;
      const exp = r.expected && Number.isInteger(r.expected.cardCents) ? r.expected.cardCents : null;
      console.log(`  ${d}  read ${rand(r.slip.totalCents).padStart(12)}  POS(window) ${rand(exp).padStart(12)}  POS(day) ${rand(pos).padStart(12)}  ${verdict}${v ? ` (${v > 0 ? "+" : ""}${rand(v)})` : ""}  #${key} ${src}`);
    }
  }
}
process.exit(0);
