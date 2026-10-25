// ─── WHICH TILLS TOOK CARD MONEY WITH NO BATCH RECORDED — READ ONLY ─────────
// The same reads and the same decision as cardTillSilenceScan
// (functions/lib/till-silence.cjs), printed instead of alarmed. Nothing is
// written, ever.
//
//   node scripts/cardrecon/till-silence-report.mjs            # as of now
//   node scripts/cardrecon/till-silence-report.mjs --at 2026-10-26T07:30:00+02:00
//
// --at replays a morning: the run judges the days before it. Records and
// legs written after that moment are still read, so a replay of a past
// morning can only show FEWER silent tills than that morning really had.

import { createRequire } from "node:module";

// Resolved against functions/package.json, as install-cardrecon-alarm.mjs does
// — scripts/ has no dependency manifest of its own.
const admin = createRequire(new URL("../../functions/package.json", import.meta.url))("firebase-admin");
const local = createRequire(import.meta.url);
const { readTillSilenceInputs, assessTillSilence, alarmLine } = local("../../functions/lib/till-silence.cjs");

admin.initializeApp({
  credential: admin.credential.applicationDefault(), projectId: "marathon-club",
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const atArg = process.argv.indexOf("--at");
const offset = (await db.ref(".info/serverTimeOffset").once("value")).val() || 0;
const nowMs = atArg > 0 ? Date.parse(process.argv[atArg + 1]) : Date.now() + offset;
if (!Number.isFinite(nowMs)) { console.error("--at needs an ISO time"); process.exit(2); }

const inputs = await readTillSilenceInputs(db, { nowMs });
const verdict = assessTillSilence({ nowMs, ...inputs });
console.log(`Judged ${verdict.days.at(-1)} → ${verdict.days[0]} (as of ${new Date(nowMs).toISOString()}).`);
if (!verdict.silent.length) console.log("No till took card money without a batch.");
else console.log(alarmLine(verdict.silent));
process.exit(0);
