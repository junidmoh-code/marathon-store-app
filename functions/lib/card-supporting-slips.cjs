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
function authorityOf(rec) {
  if (!rec) return null;
  if (isStaffSlipRecord(rec)) return "staff";
  if (rec.capturedVia === "manual" || rec.declaredTotal) return "junid";
  return "machine";
}

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
 * The supporting slips a NEW record inherits from the one it supersedes: the
 * superseded record's own supporting slips, and — when it was itself a staff
 * slip — that slip, now beside the better figure. Only on the SAME SAST day:
 * a later-day report of a long batch is a different day's settlement and its
 * slips are that day's. Returns a map keyed by slipId, or null.
 */
function carriedSlips(superseded, supersededKey, newClosedAt) {
  if (!superseded || !superseded.slip) return null;
  if (!sameSastDay(Number(superseded.slip.closedAt), Number(newClosedAt))) return null;
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

module.exports = {
  SUPPORTING_FIELD, STAFF_SLIP_VIA,
  sameSastDay, isStaffSlipRecord, authorityOf, shouldAttach, buildSupportingSlip, carriedSlips, photosOf,
};
