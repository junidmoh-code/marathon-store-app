// ─── BACK-FILL: STANDARD BANK STAFF SLIPS SINCE 2 NOV 2026 (Junid, 25 Nov 2026) ─
// Marathon PE Till 2 (0000HP1X) and Trophy Till 2 (0000Z4M6) send report
// PHOTOS. Since 13 Nov PE Till 2's PAX settles itself at 18:50, after the
// ~17:10 photo, so each photo is the PREVIOUS day's batch and its log entry
// looked "being read" on the day it was sent. This walks each till's staff-slip
// log since 2 Nov (one per-till read, keyed by day — never a whole node) and:
//   · writes read.filedDayYmd (the day the read batch closed) on every entry
//     whose read recorded a batch, so the POS names it ("photo read as batch
//     #581 (2026-11-24)") — the ONLY write, and only that one field;
//   · lists every entry the reader never answered (stuck), and every day from
//     2 Nov with POS card money on the till but no record in force (a gap).
// A stuck entry is not re-run here: the read job's own sweep retries it, and
// none were stuck on 25 Nov. Nothing is ever recorded or deleted.
//
//   node scripts/cardrecon/backfill-sb-staff-slips-20261125.mjs [--execute]
import { createRequire } from "node:module";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const DATABASE_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const EXECUTE = process.argv.includes("--execute");
const FROM = "2026-11-02";
const TILLS = [
  { store: "pe", tid: "0000HP1X", tillId: "till-2", label: "Marathon PE Till 2" },
  { store: "trophy", tid: "0000Z4M6", tillId: "till-2", label: "Trophy Till 2" },
];
const SAST = 2 * 60 * 60 * 1000;
const ymd = (ms) => (Number.isFinite(ms) ? new Date(ms + SAST).toISOString().slice(0, 10) : null);

admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DATABASE_URL });
const db = admin.database();
try {
  // POS card money per till and day since FROM — one indexed range read.
  const fromMs = Date.parse(`${FROM}T00:00:00+02:00`);
  const money = new Map();
  const ev = await db.ref("pos/paymentEvents").orderByChild("at").startAt(fromMs).once("value");
  ev.forEach((c) => {
    const e = c.val();
    if (!e || e.method !== "card") return;
    const k = `${e.storeId}/${e.tillId}/${ymd(e.at)}`;
    money.set(k, (money.get(k) || 0) + (Number(e.amount) || 0));
  });
  const today = ymd(Date.now());
  for (const t of TILLS) {
    console.log(`\n== ${t.label} (${t.store}/${t.tid})`);
    const slips = (await db.ref(`card_batch_overrides/staff_slips/${t.store}/${t.tid}`).orderByKey().startAt(FROM).once("value")).val() || {};
    const recs = (await db.ref(`card_batches/${t.store}/${t.tid}`).orderByChild("slip/closedAt").startAt(fromMs - 3 * 86400000).once("value")).val() || {};
    const supersededKeys = new Set(Object.values(recs).map((r) => r && r.supersedes).filter(Boolean));
    const inForceDays = new Set(Object.entries(recs)
      .filter(([k, r]) => r && !r.displacedBy && !supersededKeys.has(k))
      .map(([, r]) => ymd(Number(r.slip && r.slip.closedAt))));
    let annotated = 0;
    for (const [day, entries] of Object.entries(slips)) {
      for (const [id, e] of Object.entries(entries || {})) {
        const read = e && e.read;
        if (!read || !read.outcome) { console.log(`  STUCK ${day} ${id}: no read outcome`); continue; }
        if (read.batchKey && !read.filedDayYmd) {
          const closedAt = (await db.ref(`card_batches/${t.store}/${t.tid}/${read.batchKey}/slip/closedAt`).once("value")).val();
          const filed = ymd(Number(closedAt));
          if (!filed) continue;
          console.log(`  ${day} ${id}: batch #${read.batchKey} → filed on ${filed}${filed !== day ? "  (the previous day's report)" : ""}`);
          if (EXECUTE) {
            await db.ref(`card_batch_overrides/staff_slips/${t.store}/${t.tid}/${day}/${id}/read/filedDayYmd`).set(filed);
          }
          annotated++;
        }
      }
    }
    for (let d = new Date(`${FROM}T12:00:00Z`); ymd(d.getTime()) < today; d = new Date(d.getTime() + 86400000)) {
      const day = ymd(d.getTime());
      const cents = money.get(`${t.store}/${t.tillId}/${day}`) || 0;
      if (cents > 0 && !inForceDays.has(day)) console.log(`  GAP ${day}: R${(cents / 100).toFixed(2)} card in POS, no report on file closing that day`);
    }
    console.log(`  ${EXECUTE ? "annotated" : "would annotate"} ${annotated} entr${annotated === 1 ? "y" : "ies"}`);
  }
} finally {
  await admin.app().delete();
}
