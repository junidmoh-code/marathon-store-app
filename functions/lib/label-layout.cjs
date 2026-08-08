// ─── LABEL LAYOUT RULES — learn which token IS the style number ──────────────
// (Owner spec 2026-08-08.) When a label yields several code-shaped tokens, the
// operator is asked "tap the style number" — and once a human has answered
// that for a given LABEL LAYOUT, the same question must not be asked again.
//
// ── HOW A LAYOUT IS KEYED ────────────────────────────────────────────────────
// By the SHAPE MULTISET of the candidates: each candidate's recognised format
// (styleCodeFormat — "numeric-6-3", "puma-6-2", …), sorted and joined. The
// Diesel Big D label reads 190935-505 (numeric-6-3) + 740750-35 (puma-6-2),
// so its key is "numeric-6-3__puma-6-2" — and EVERY Diesel label printed in
// that layout produces the same key, whatever the digits say. Order on the
// label does not matter (OCR reading order is not stable); the shapes are.
//
// A key exists only when EVERY candidate has a recognised format and there are
// at least two — an unrecognised shape means we don't actually know what the
// layout is, so nothing is learned and nothing auto-picks (fail closed).
//
// ── WHAT A RULE SAYS, AND WHEN IT APPLIES ────────────────────────────────────
//   /label_layout_rules/{layoutKey} = { chosenFormat, confirms, conflicts,
//                                       disabled?, addedAt, updatedAt, by }
// A rule auto-picks ONLY when exactly one candidate carries chosenFormat.
// Two candidates of the SAME format ("numeric-6-3__numeric-6-3") can never
// auto-pick — the shape cannot distinguish them, so the human is asked.
//
// ── INVALIDATION — the rule must be able to turn out wrong ───────────────────
// Every human tap on the picker re-learns. A tap that AGREES bumps confirms.
// A tap that DISAGREES (same layout, different chosen shape) replaces the rule
// once — maybe the first answer was the mistake — but a SECOND disagreement
// proves the layout genuinely varies, and the rule is DISABLED for good: that
// layout always asks. Disabling is one-way by design; flip-flopping between
// two answers forever would auto-pick wrong half the time, silently.
//
// The node is written and read ONLY by callables on the Admin SDK — no client
// rules needed, no rules change. This module is the pure half (node-tested);
// IO lives in labelAlias/labelAlias.js (learn) and readStyleCodeLabel.js
// (apply).

"use strict";

const { normaliseStyleCode, styleCodeFormat } = require("./style-code.cjs");

const LAYOUT_RULES_PATH = "label_layout_rules";
const MAX_LAYOUT_CONFLICTS = 2; // second disagreement kills the rule for good

/**
 * The layout key for a candidate set, or null when no key exists (fewer than
 * two candidates, or any candidate of unrecognised shape — fail closed).
 * @param {string[]} codes  candidate codes (raw or normalised)
 * @returns {string|null}   e.g. "numeric-6-3__puma-6-2"
 */
function layoutKeyFor(codes) {
  const arr = Array.isArray(codes) ? codes.map(normaliseStyleCode).filter(Boolean) : [];
  if (arr.length < 2) return null;
  const formats = arr.map((c) => styleCodeFormat(c));
  if (formats.some((f) => !f)) return null;
  return formats.sort().join("__");
}

/**
 * Does a stored rule decide this candidate set? Auto-picks only when the rule
 * is live and EXACTLY ONE candidate carries the learned format.
 * @returns {string|null} the auto-picked normalised code, or null (ask)
 */
function applyLayoutRule(rule, codes) {
  if (!rule || rule.disabled || typeof rule.chosenFormat !== "string") return null;
  const arr = Array.isArray(codes) ? codes.map(normaliseStyleCode).filter(Boolean) : [];
  if (arr.length < 2) return null;
  const matching = arr.filter((c) => styleCodeFormat(c) === rule.chosenFormat);
  return matching.length === 1 ? matching[0] : null;
}

/**
 * PURE state transition for one human answer on one layout. The caller runs
 * this inside an RTDB transaction so two tablets answering at once cannot
 * clobber each other's counts.
 * @param {object|null} rule          the stored rule (or null)
 * @param {string} chosenFormat       the format of the token the human tapped
 * @param {{nowMs:number, uid:string|null}} meta
 * @returns {object} the next rule value
 */
function learnLayoutTransition(rule, chosenFormat, { nowMs, uid = null } = {}) {
  if (!rule || typeof rule.chosenFormat !== "string") {
    return { chosenFormat, confirms: 1, conflicts: 0, addedAt: nowMs, updatedAt: nowMs, by: uid };
  }
  if (rule.disabled) return { ...rule, updatedAt: nowMs }; // dead stays dead
  if (rule.chosenFormat === chosenFormat) {
    return { ...rule, confirms: (Number(rule.confirms) || 0) + 1, updatedAt: nowMs, by: uid };
  }
  const conflicts = (Number(rule.conflicts) || 0) + 1;
  if (conflicts >= MAX_LAYOUT_CONFLICTS) {
    // Second disagreement: the layout genuinely varies. Ask forever.
    return { ...rule, conflicts, disabled: true, updatedAt: nowMs, by: uid };
  }
  // First disagreement: the original answer may have been the mistake —
  // replace once, keep the conflict on record.
  return { ...rule, chosenFormat, confirms: 1, conflicts, updatedAt: nowMs, by: uid };
}

module.exports = {
  LAYOUT_RULES_PATH,
  MAX_LAYOUT_CONFLICTS,
  layoutKeyFor,
  applyLayoutRule,
  learnLayoutTransition,
};
