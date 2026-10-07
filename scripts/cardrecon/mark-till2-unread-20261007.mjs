// ─── MARATHON TILL 2 (0000HP1X): THE DAYS NO BATCH WAS EVER RECORDED ─────────
// Diagnosis 7 Oct 2026 — docs/CARD-RECON-TILL2-2026-10-07.md. 0000HP1X cannot
// email its report; its slip is photographed and read by Gemini. Every day a
// read failed, the photo was thrown away with it (photos were only stored
// AFTER a successful read), so these days cannot be re-read: there is nothing
// on the server to read. What CAN be done is make each of them visible in
// Junid's Card recon report as "Unread – needs manual entry", with that day's
// evidence, so he can type the figures in from the paper.
//
// WHAT IT WRITES — one multi-path update, and only:
//   card_batch_overrides/unread/pe/0000HP1X/{day}   (one marker per missing day)
//   card_batch_overrides/notices/backfill~0000HP1X~2026-10-07  (ONE email, not 16)
// A day that has a recorded batch by the time this runs is SKIPPED — the read
// for it is per day, on the indexed slip/closedAt, never the terminal's node.
// A marker already present is merged (lib/card-unread.cjs), never replaced, so
// a second run changes nothing but `lastAt`/`failures`; run it once.
//
//   node scripts/cardrecon/mark-till2-unread-20261007.mjs            # dry run
//   node scripts/cardrecon/mark-till2-unread-20261007.mjs --execute  # write + verify

import { createRequire } from "module";
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { placementAt } = require("./lib/card-terminal-placements.cjs");
const {
  unreadPath, sastDayStartMs, addUnreadFailure, NOTICES_PATH, DAY_MS,
} = require("./lib/card-unread.cjs");

const EXECUTE = process.argv.includes("--execute");
const TID = "0000HP1X";
const STORE = "pe"; // the filing key — the registry row's own storeId

// The evidence, per day, from Cloud Logging (cardbatchcapture request log and
// the callable's own lines) and /card_batches, read 7 Oct 2026. Large requests
// (>200 KB) are photo captures; the emailed PDFs are ~70 KB.
const NO_UPLOAD = "No photo of this day's slip reached the server — no capture upload is in the function log for the day.";
const DAYS = {
  "2026-09-11": NO_UPLOAD, "2026-09-12": NO_UPLOAD, "2026-09-13": NO_UPLOAD, "2026-09-14": NO_UPLOAD,
  "2026-09-15": NO_UPLOAD, "2026-09-16": NO_UPLOAD, "2026-09-17": NO_UPLOAD,
  "2026-09-18": "Four photo uploads that evening (17:32 and 20:12) were refused by Google's slip reader with HTTP 429 (rate limit). The photos were not kept.",
  "2026-09-19": "Two photo uploads (16:37, 16:41) were refused by Google's slip reader with HTTP 402 — the reader's prepaid credit had run out. The photos were not kept.",
  "2026-09-20": "Three photo uploads (15:27–16:22) were refused by Google's slip reader with HTTP 503 (overloaded); a fourth was read but refused. The photos were not kept.",
  "2026-09-21": "Three photo uploads (17:17–19:20) were refused by Google's slip reader with HTTP 503 (overloaded); two later ones were read but refused. The photos were not kept.",
  "2026-09-22": "One photo upload was read but refused after 150 s; a second (17:42) got HTTP 503 (overloaded). The photos were not kept.",
  "2026-09-23": "A photo upload at 20:46 was refused by Google's slip reader with HTTP 503 (overloaded). The photo was not kept.",
  "2026-09-24": NO_UPLOAD,
  "2026-09-27": NO_UPLOAD,
  "2026-10-07": "Two photo uploads (17:03 and 17:40) waited over two minutes each and Google's slip reader timed out both times. The photos were not kept.",
};

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const offset = (await db.ref(".info/serverTimeOffset").once("value")).val() || 0;
const nowMs = Date.now() + offset;

const row = (await db.ref(`config/cardTerminals/${TID}`).once("value")).val();
if (!row || row.storeId !== STORE) {
  console.error(`✗ ${TID} is not filed under ${STORE} in the registry — refusing.`);
  process.exit(1);
}
const batchesRef = db.ref(`card_batches/${STORE}/${TID}`);

const patch = {};
const marked = [];
for (const [dayYmd, reason] of Object.entries(DAYS)) {
  const start = sastDayStartMs(dayYmd);
  const recorded = (await batchesRef.orderByChild("slip/closedAt").startAt(start).endAt(start + DAY_MS - 1).once("value")).val();
  if (recorded) {
    console.log(`  · ${dayYmd}: batch ${Object.keys(recorded).join(", ")} recorded since — skipped`);
    continue;
  }
  // Where the machine stood that evening: its placement, else the till the
  // last record before the day stamped (0000HP1X was PE Till 1 until 18 Sep).
  const evening = start + 17 * 60 * 60 * 1000;
  let till = placementAt(row, evening);
  if (!till) {
    const prev = (await batchesRef.orderByChild("slip/closedAt").endAt(start - 1).limitToLast(1).once("value")).val();
    const p = prev && Object.values(prev)[0];
    till = p ? { storeId: p.storeId, tillId: p.tillId, label: p.terminalLabel || null } : { tillId: row.tillId, label: row.label };
  }
  const label = till.label || (till.tillId === "till-1" ? "PE Till 1" : row.label);
  const path = unreadPath({ storeId: STORE, tid: TID, dayYmd });
  const existing = (await db.ref(path).once("value")).val();
  const { marker } = addUnreadFailure(existing, {
    storeId: STORE, tid: TID, tillId: till.tillId, label, dayYmd, reason,
    source: "backfill-20261007", nowMs,
  });
  patch[path] = marker;
  marked.push(`${dayYmd}  ${till.tillId}  ${label}`);
  console.log(`  · ${dayYmd}: ${existing ? "merge" : "new"} marker on ${till.tillId} (${label})`);
}

if (!marked.length) {
  console.log("Nothing to mark — every day has a recorded batch.");
  process.exit(0);
}

const noticePath = `${NOTICES_PATH}/backfill~${TID}~2026-10-07`;
patch[noticePath] = {
  kind: "summary",
  subject: `Card recon: Marathon Till 2 — ${marked.length} days unread, need manual entry`,
  text: [
    `Marathon Till 2's card machine (terminal ${TID}) has no recorded batch for ${marked.length} days.`,
    "It is the one machine that cannot email its report. Its slip photos were read by Google's",
    "reader at the till, and every failed read (rate limit, out of credit, overloaded, timed out —",
    "or a photo that never reached the server) threw the photo away with it. The mapping was fine.",
    "",
    ...marked.map((m) => `  ${m}`),
    "",
    "Each day is now a row in the POS → Reports → Card recon marked \"Unread – needs manual entry\".",
    "From tonight, a photographed slip is kept the moment it arrives and read in the background with retries.",
  ].join("\n"),
  createdAt: nowMs,
  attempts: 0,
};

console.log(`\n${marked.length} day(s) to mark; one summary email queued.`);
if (!EXECUTE) {
  console.log("Dry run — nothing written. Re-run with --execute.");
  process.exit(0);
}
await db.ref().update(patch);
let bad = 0;
for (const p of Object.keys(patch)) {
  const back = (await db.ref(p).once("value")).val();
  if (!back) { bad++; console.error(`✗ ${p} did not read back`); }
}
console.log(bad ? `✗ ${bad} path(s) failed verification` : `✓ written and verified (${Object.keys(patch).length} paths)`);
process.exit(bad ? 1 : 0);
