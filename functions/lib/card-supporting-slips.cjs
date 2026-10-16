// ─── A STAFF SLIP BESIDE A BETTER FIGURE: THE SUPPORTING SLIP ────────────────
// Junid, 16 Oct 2026 (his decisions on the per-till slip):
//   1. A staff slip is NEVER refused because the machine's report is already
//      in. The photo and the typed total are kept as a SUPPORTING slip on that
//      batch; the machine's report stays the figure the verdict uses. If the
//      staff total differs, Junid's view says so ("staff typed R X, machine
//      report R Y"). The person who sent it still sees only "Sent — thank you".
//   2. Junid's own figure (a typed total or a manual entry) outranks a staff
//      slip. A staff slip never replaces it; it is attached the same way.
//      PRECEDENCE: machine report > Junid > staff typed.
//
// So a staff slip either IS the day's record (nothing better is in yet — the
// existing typed capture, kept) or is ATTACHED to the record that is. When
// something better arrives after a staff-slip record — the machine's report of
// that filing number, or Junid's correction — the staff slip moves onto the
// new record as a supporting slip (carriedSlips), so the comparison is never
// lost behind a superseded revision.
//
// Pure: no IO. cardRecon.js and cardBatchManual.js do the reads and writes.
"use strict";

const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const sastDay = (ms) => Math.floor((ms + SAST_OFFSET_MS) / DAY_MS);
const sameSastDay = (a, b) => Number.isFinite(a) && Number.isFinite(b) && sastDay(a) === sastDay(b);

const SUPPORTING_FIELD = "supportingSlips";
const STAFF_SLIP_VIA = "staff-slip";

/** Was this record itself sent as a staff slip (cardBatchCapture action "slip")? */
const isStaffSlipRecord = (rec) => !!rec && !!rec.declaredTotal && rec.declaredTotal.via === STAFF_SLIP_VIA;

/**
 * Whose figure is this record — "machine" (its emailed or photographed
 * report), "junid" (a total he typed, or a manual entry) or "staff" (a staff
 * slip)? The precedence is machine > junid > staff.
 */
// Junid's sign-in — THE one constant mayDeclareTotal checks (Fable review, #731).
const { DECLARED_TOTAL_EMAIL: JUNID_EMAIL } = require("./card-recon.cjs");

function authorityOf(rec) {
  if (!rec) return null;
  if (isStaffSlipRecord(rec)) return "staff";
  // A MANUAL entry is Junid's alone (mayEnterManually). A typed total is his
  // only when he typed it: on a typed-entry machine anyone with card_recon may
  // type the evening's figure, and a manager's typed figure is staff typing —
  // it does not outrank a staff slip (a later slip corrects it, as before).
  if (rec.capturedVia === "manual") return "junid";
  if (rec.declaredTotal) return rec.declaredTotal.byEmail === JUNID_EMAIL ? "junid" : "staff";
  return "machine";
}

// A staff member can send the slip again and again; each one stores a photo
// and pays for a read. Beyond this many beside one record, the slip is
// refused in words (no figure, no verdict) and Junid is the one to call.
const MAX_SUPPORTING_SLIPS = 10;

const photosOf = (rec) => (Array.isArray(rec && rec.photos) ? rec.photos : Object.values((rec && rec.photos) || {})).filter((p) => typeof p === "string");

/**
 * Should a staff slip arriving now be ATTACHED to the record in force, rather
 * than recorded as the day's figure? Yes when that record is today's and is a
 * better figure (the machine's, or Junid's). A record that is itself today's
 * staff slip is corrected instead (a second slip is a revision); no record
 * today means the slip is the day's record.
 */
function shouldAttach(inForce, nowMs) {
  if (!inForce || !inForce.record || !inForce.record.slip) return false;
  if (!sameSastDay(Number(inForce.record.slip.closedAt), nowMs)) return false;
  // Their own (or another staff member's) typed figure is corrected instead.
  return authorityOf(inForce.record) !== "staff";
}

/** One supporting slip, as stored under {record}/supportingSlips/{slipId}. */
function buildSupportingSlip({ slipId, cents, photos, byUid, byEmail, nowMs, fromKey = null, photoRead = null }) {
  return {
    slipId,
    via: STAFF_SLIP_VIA,
    cents,
    photos: photos.slice(),
    byUid: byUid || null,
    byEmail: byEmail || null,
    at: nowMs,
    // Set when the slip was the day's record first and a better figure took
    // over: the batch key it was recorded under, which is kept unchanged.
    fromKey,
    // What the background read made of the photo (writePhotoRead) — set later.
    photoRead: photoRead || null,
  };
}

/**
 * Does `successor` inherit the slips of the record it supersedes? A record
 * that REPLACES it — a person's correction, or a report recorded as its
 * replacement — always does, whatever the day: it stands in its place. A
 * LATER REPORT of a batch left open (autoSuperseded) is a different day's
 * settlement unless it closes the same SAST day, and the slips stay with
 * their own day.
 */
function inherits(superseded, successor) {
  if (!superseded || !superseded.slip || !successor) return false;
  if (successor.autoSuperseded !== true) return true;
  return sameSastDay(Number(superseded.slip.closedAt), Number(successor.slip && successor.slip.closedAt));
}

/**
 * The supporting slips a NEW record inherits from the one it supersedes (see
 * inherits): the superseded record's own supporting slips, and — when it was
 * itself a staff slip — that slip, now beside the better figure. `successor`
 * is the new record, or { slip: { closedAt }, autoSuperseded } before it is
 * written. Returns a map keyed by slipId, or null.
 */
function carriedSlips(superseded, supersededKey, successor) {
  if (!inherits(superseded, successor)) return null;
  const out = { ...(superseded[SUPPORTING_FIELD] || {}) };
  if (isStaffSlipRecord(superseded) && Number.isInteger(superseded.slip.totalCents)) {
    const slipId = `rec-${supersededKey}`;
    out[slipId] = buildSupportingSlip({
      slipId,
      cents: superseded.slip.totalCents,
      photos: photosOf(superseded),
      byUid: superseded.declaredTotal.byUid,
      byEmail: superseded.declaredTotal.byEmail,
      nowMs: Number(superseded.declaredTotal.at) || Number(superseded.submittedAt) || null,
      fromKey: supersededKey,
      photoRead: superseded.photoRead || null,
    });
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The records that took over from `fromKey` and inherit its slips (inherits),
 * oldest first, following `supersedes` — the chain a slip on `fromKey` must
 * also sit on. `revisions` is
 * every record of that batch ({batchKey: record}, one equalTo(batchNo) read).
 */
function sameDaySuccessors(revisions, fromKey) {
  const all = Object.entries(revisions || {}).filter(([, r]) => r && typeof r === "object");
  const out = [];
  let at = fromKey;
  let atRec = (all.find(([k]) => k === fromKey) || [])[1];
  for (let guard = 0; atRec && guard < 1000; guard++) {
    const next = all.filter(([, r]) => r.supersedes === at)
      .sort((a, b) => (Number(a[1].revision) || 1) - (Number(b[1].revision) || 1)).at(-1);
    if (!next || !inherits(atRec, next[1])) break;
    out.push(next[0]);
    [at, atRec] = next;
  }
  return out;
}

module.exports = {
  SUPPORTING_FIELD, STAFF_SLIP_VIA, JUNID_EMAIL, MAX_SUPPORTING_SLIPS, sameDaySuccessors,
  sameSastDay, inherits, isStaffSlipRecord, authorityOf, shouldAttach, buildSupportingSlip, carriedSlips, photosOf,
};
