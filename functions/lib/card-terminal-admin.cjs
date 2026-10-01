// ─── TERMINAL SETTINGS — EVERY EDIT TO THE ESTATE, DECIDED IN ONE PLACE ──────
// The Card machines screen carries a settings sheet (owner only) that adds,
// edits, retires and replaces card terminals. Until 21 Sept 2026 each of those
// was a Claude Code session running scripts/apply-terminal-registry-*.mjs; the
// sheet is now the normal path and the scripts still work.
//
// This module is the PURE half: given the current row(s) and what was asked,
// it answers "refuse, and why" or "write exactly this". The callable
// (functions/cardRecon/cardTerminalAdmin.js) owns the IO — per-row RTDB
// transactions, the server clock, the audit trail.
//
// THE RULES, AND WHERE EACH ONE COMES FROM:
//
//   • THE TID IS THE ONLY TYPED IDENTITY, and it is never overwritten or
//     deleted. Batches are filed under /card_batches/{storeId}/{tid}; a
//     mapping that disappears strands them (lib/card-terminals.cjs). So there
//     is no rename and no delete here — a swapped speedpoint is RETIRE the old
//     TID + ADD the new one, which "replace" does as one action.
//
//   • THE STORE AND TILL ARE PICKED, NEVER TYPED. The store key joins to
//     /pos/paymentEvents; a key that is not one of the POS's makes every
//     variance for that machine 100% short. Both are checked here against the
//     list the callable read from the POS, not against the client's word.
//
//   • A TERMINAL NEVER CHANGES STORE IN PLACE. Its batches live under the OLD
//     store key and the history reader follows the CURRENT one, so a store
//     move would silently orphan every batch it has (the 18 Sept apply script
//     refused this for the same reason). A machine that physically moves shop
//     keeps its TID only if it keeps its store; otherwise retire and add.
//
//   • MOVING TILLS STAMPS `tillChangedAt`, exactly as the apply script did —
//     lib/card-terminals.cjs → tillMoveWarning reads it to flag the one batch
//     whose window straddles the move.
//
// PURE: no firebase-admin, no clock. `now` is whatever the caller stamps with
// (the callable passes ServerValue.TIMESTAMP). Tested in
// functions/test/card-terminal-admin.test.cjs.

"use strict";

const { isRetiredTerminal } = require("./card-terminals.cjs");

/** How a terminal's report reaches us. Absent on a row = "both". */
const CAPTURE_MODES = Object.freeze(["email", "photo", "both"]);

const LABEL_MAX = 40;

/** [A-Z0-9]{4,16}, uppercased. Anything else is refused, never repaired. */
function readTypedTid(raw) {
  const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return /^[A-Z0-9]{4,16}$/.test(s) ? s : null;
}

/** Optional. Digits only once spaces are dropped; empty means "none". */
function readMid(raw) {
  if (raw === undefined || raw === null) return { ok: true, mid: null };
  const s = String(raw).replace(/\s+/g, "");
  if (!s) return { ok: true, mid: null };
  if (!/^\d{6,20}$/.test(s)) return { ok: false, reason: "The MID is digits only (6 to 20 of them), or leave it empty." };
  return { ok: true, mid: s };
}

function readLabel(raw) {
  const s = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!s) return { ok: false, reason: "Give the terminal a label — it is the name on its card." };
  if (s.length > LABEL_MAX) return { ok: false, reason: `Keep the label to ${LABEL_MAX} characters.` };
  return { ok: true, label: s };
}

function readCapture(raw) {
  return CAPTURE_MODES.includes(raw) ? raw : null;
}

/**
 * Is (storeId, tillId) a real POS till? `stores` is the callable's own read of
 * the POS: [{ storeId, label, tills: [{ tillId, name }] }].
 */
function checkPlacement(stores, storeId, tillId) {
  const store = (stores || []).find((s) => s.storeId === storeId);
  if (!store) return { ok: false, reason: `"${storeId}" is not a POS store. Pick the store from the list.` };
  if (!(store.tills || []).some((t) => t.tillId === tillId)) {
    return { ok: false, reason: `${store.label} has no till "${tillId}" in the POS. Pick the till from the list.` };
  }
  return { ok: true };
}

/** The fields every add/edit carries, read and refused in one place. */
function readCommon(input, stores) {
  const label = readLabel(input.label);
  if (!label.ok) return label;
  const mid = readMid(input.mid);
  if (!mid.ok) return mid;
  const capture = readCapture(input.capture);
  if (!capture) return { ok: false, reason: "Pick how this terminal's report arrives: Email, Photo or Both." };
  const placed = checkPlacement(stores, input.storeId, input.tillId);
  if (!placed.ok) return placed;
  return { ok: true, label: label.label, mid: mid.mid, capture, storeId: input.storeId, tillId: input.tillId };
}

/**
 * ADD a terminal. `current` is whatever sits at /config/cardTerminals/{tid}
 * right now (null when nothing does).
 *
 * @returns {{ok:false, reason:string} | {ok:true, tid:string, row:object}}
 */
function planAdd(input, current, { stores, now }) {
  const tid = readTypedTid(input && input.tid);
  if (!tid) return { ok: false, reason: "A TID is 4 to 16 letters and digits, exactly as printed after TID: on the slip." };
  if (current) {
    return {
      ok: false,
      reason: isRetiredTerminal(current)
        ? `${tid} is already registered as ${current.label || tid}, retired. Reinstate it rather than adding it again — its batches are filed under that record.`
        : `${tid} is already active as ${current.label || tid}. A TID is never added twice.`,
    };
  }
  const c = readCommon(input, stores);
  if (!c.ok) return c;
  return {
    ok: true, tid,
    row: {
      storeId: c.storeId, tillId: c.tillId, label: c.label, capture: c.capture,
      ...(c.mid ? { mid: c.mid } : {}),
      activeFrom: now,
    },
  };
}

/**
 * EDIT a terminal in place: label, till, MID, capture. Never the TID, never
 * the store (see the header). Unknown fields on the row are kept.
 */
function planEdit(input, current, { stores, now }) {
  const tid = readTypedTid(input && input.tid);
  if (!tid || !current) return { ok: false, reason: `${tid || "That TID"} is not registered.` };
  if (isRetiredTerminal(current)) return { ok: false, reason: `${current.label || tid} is retired. Reinstate it before editing it.` };
  if (input.storeId !== current.storeId) {
    return {
      ok: false,
      reason: `A terminal never changes store in place — its batches are filed under ${current.storeId} and would be orphaned. If this machine now belongs to another shop, retire it and add it there.`,
    };
  }
  const c = readCommon(input, stores);
  if (!c.ok) return c;
  const row = { ...current, label: c.label, tillId: c.tillId, capture: c.capture };
  if (c.mid) row.mid = c.mid; else delete row.mid;
  // THE ONE EDIT THAT CAN MAKE A FIGURE WRONG — see tillMoveWarning.
  if (current.tillId && current.tillId !== c.tillId) row.tillChangedAt = now;
  // `capture` is compared by its MEANING: a row written before the field
  // existed has none, which is "both" — so saving "both" over it is no change
  // and must not write. (Found live on 21 Sept 2026: a no-op save of Pine
  // Till 1 stamped `capture: "both"` onto it.)
  const changed = ["label", "tillId", "mid"].some((k) => (current[k] ?? null) !== (row[k] ?? null))
    // ABSENT means "both"; anything else is compared as written, so a junk
    // value ("fax") can still be repaired by choosing Both.
    || (current.capture === undefined ? "both" : current.capture) !== c.capture;
  if (!changed) return { ok: false, reason: "Nothing changed." };
  // Unchanged meaning, unchanged row: an absent field stays absent.
  if (current.capture === undefined && c.capture === "both") delete row.capture;
  return { ok: true, tid, row };
}

/** RETIRE: stamp `retiredAt`; the row and its history stay. */
function planRetire(input, current, { now }) {
  const tid = readTypedTid(input && input.tid);
  if (!tid || !current) return { ok: false, reason: `${tid || "That TID"} is not registered.` };
  if (isRetiredTerminal(current)) return { ok: false, reason: `${current.label || tid} is already retired.` };
  return { ok: true, tid, row: { ...current, retiredAt: now } };
}

/** REINSTATE: the stamp comes off; nothing else changes. */
function planReinstate(input, current) {
  const tid = readTypedTid(input && input.tid);
  if (!tid || !current) return { ok: false, reason: `${tid || "That TID"} is not registered.` };
  if (!isRetiredTerminal(current)) return { ok: false, reason: `${current.label || tid} is not retired.` };
  // A REPLACED machine stays retired: its till belongs to its replacement, and
  // reinstating it would put two live TIDs on one till.
  if (current.replacedBy) {
    return { ok: false, reason: `${tid} was replaced by ${current.replacedBy}, which now has its till. Retire ${current.replacedBy} first if this machine is really back.` };
  }
  const row = { ...current };
  delete row.retiredAt;
  delete row.retiredReason;
  return { ok: true, tid, row };
}

/**
 * REPLACE: a speedpoint was swapped. The old TID is retired and the new one
 * takes its place — same store, same till, same label unless a new one is
 * given — in one action. Neither row is overwritten: the old keeps its
 * history and points forward (`replacedBy`), the new points back (`replaces`).
 *
 * @returns {{ok:false, reason} | {ok:true, oldTid, newTid, oldRow, newRow}}
 */
function planReplace(input, oldCurrent, newCurrent, { stores, now }) {
  const oldTid = readTypedTid(input && input.oldTid);
  if (!oldTid || !oldCurrent) return { ok: false, reason: `${oldTid || "The old TID"} is not registered.` };
  if (isRetiredTerminal(oldCurrent)) return { ok: false, reason: `${oldCurrent.label || oldTid} is already retired — add the new machine instead.` };
  const newTid = readTypedTid(input.newTid);
  if (!newTid) return { ok: false, reason: "The new TID is 4 to 16 letters and digits, exactly as printed after TID: on the new machine's slip." };
  if (newTid === oldTid) return { ok: false, reason: "The new TID is the same as the old one — nothing to replace." };
  if (newCurrent) return { ok: false, reason: `${newTid} is already registered (${newCurrent.label || newTid}). A TID is never added twice.` };
  const added = planAdd({
    tid: newTid,
    storeId: oldCurrent.storeId, tillId: oldCurrent.tillId,
    label: input.label ?? oldCurrent.label,
    // A new machine is a new merchant contract more often than not: the MID is
    // whatever was typed, never silently carried over.
    mid: input.mid,
    capture: input.capture ?? oldCurrent.capture ?? "both",
  }, null, { stores, now });
  if (!added.ok) return added;
  return {
    ok: true, oldTid, newTid,
    oldRow: { ...oldCurrent, retiredAt: now, retiredReason: "replaced", replacedBy: newTid },
    newRow: { ...added.row, replaces: oldTid },
  };
}

module.exports = {
  CAPTURE_MODES, readTypedTid, readMid, readLabel, readCapture, checkPlacement,
  planAdd, planEdit, planRetire, planReinstate, planReplace,
};
