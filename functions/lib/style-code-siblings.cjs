// ─── STYLE CODE SIBLINGS — one code, several colourways, by design ───────────
// (Owner evidence 2026-08-07.) Three Nike size labels photographed the same
// day: a white US 7, a white US 8 and a BLACK US 8.5 — all three printing the
// SAME style code HF5509-002, the SAME UPC and the same factory code. The
// standard Nike tongue label carries no colourway text, so the label CANNOT
// distinguish black from white, and a per-size UPC reused across a size run is
// exactly how this stock is labelled. No OCR improvement fixes that.
//
// THE MODEL CHANGE: /style_code_index/{code} keeps its original claim shape —
//   { productId, claimedAt, claimedBy }            (untouched, no migration)
// — and gains ONE new child, written only by the styleCodeSibling callable on
// the Admin SDK (rules bypassed; the client claim rule never sees it):
//   siblings: { {productId}: { addedAt, addedBy, origin } }
//
// The OWNERS of a code are the primary claimant plus every sibling. Two owners
// of the same code are NOT duplicates, NOT a collision, and must never route
// to merge or /duplicate_candidates — they are two real colourways whose
// manufacturer printed one code. A legacy claim with no `siblings` child reads
// as exactly one owner, which is why no data migration exists: the old shape
// IS the one-owner case of the new shape.
//
// WHAT SIBLINGSHIP CHANGES ELSEWHERE (each site cites this file):
//   • resolveStyleCode  — sibling pairs are excluded from duplicate flagging.
//   • the count picker  — 2+ owners NEVER resolve silently; the human picks.
//   • registration      — a claimed code asks "same shoe, or a different
//                         colourway?" instead of blocking or merging.
//   • product merge     — a merged-away sibling's entry follows the survivor.
//
// VELOCITY IS LOGGED, NEVER ACTED ON. A code accumulating siblings unusually
// fast, or one pair being re-answered "different colourway" repeatedly, is
// recorded to /style_code_sibling_events with a flag — a note for a human,
// never an automatic decision.

"use strict";

const SIBLING_EVENTS_PATH = "style_code_sibling_events";

// The two answers an operator can give at a registration collision. Recorded
// verbatim on the event row so the decision trail says which way every
// collision went.
const ANSWER_SAME_SHOE = "same-shoe";
const ANSWER_DIFFERENT_COLOURWAY = "different-colourway";
const SIBLING_ANSWERS = [ANSWER_SAME_SHOE, ANSWER_DIFFERENT_COLOURWAY];

// Observability thresholds — see "VELOCITY IS LOGGED" above. Numbers chosen
// against the physical reality: a style code genuinely owning four or more
// colourways in this catalogue, or two registered inside a day, is unusual
// enough to be worth a human glance. Neither threshold blocks anything.
const VELOCITY_OWNER_COUNT = 4;
const VELOCITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const VELOCITY_ADDS_IN_WINDOW = 2;

/**
 * Every product that owns this code: the primary claimant first, then the
 * siblings in key order. A legacy claim (no siblings child) yields exactly
 * [productId] — the shape change is invisible to one-owner codes.
 * @param {object|null} claimNode  the raw /style_code_index/{code} value
 * @returns {string[]} deduped product ids; [] when the node is empty/malformed
 */
function claimOwnerIds(claimNode) {
  if (!claimNode || typeof claimNode !== "object") return [];
  const out = [];
  const primary = typeof claimNode.productId === "string" && claimNode.productId ? claimNode.productId : null;
  if (primary) out.push(primary);
  const sib = claimNode.siblings;
  if (sib && typeof sib === "object" && !Array.isArray(sib)) {
    for (const id of Object.keys(sib).sort()) {
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** Are BOTH products registered owners of this code? Then their sharing it is
 *  sibling colourways, not a collision. */
function isSiblingPair(claimNode, idA, idB) {
  const owners = claimOwnerIds(claimNode);
  return owners.includes(String(idA)) && owners.includes(String(idB)) && String(idA) !== String(idB);
}

/**
 * Split colliding pairs into the ones that are registered siblings (never
 * flagged) and the ones that are genuine collisions (flagged as before).
 * @param {object|null} claimNode
 * @param {Array<{pairId, productIdA, productIdB}>} pairs
 */
function partitionPairs(claimNode, pairs) {
  const sibling = [];
  const collision = [];
  for (const p of pairs || []) {
    (isSiblingPair(claimNode, p.productIdA, p.productIdB) ? sibling : collision).push(p);
  }
  return { sibling, collision };
}

/** The one shape a sibling entry is allowed to be. Constructed field by field —
 *  never spread — so nothing extra can leak into the index node. */
function buildSiblingEntry({ addedBy, nowMs, origin }) {
  const entry = { addedAt: Number(nowMs) };
  if (addedBy) entry.addedBy = String(addedBy);
  if (origin) entry.origin = String(origin).slice(0, 32);
  return entry;
}

/**
 * Should this code's growth be flagged for a human to glance at?
 * Pure observation — the caller LOGS the answer and changes nothing.
 * @returns {{flag: boolean, reasons: string[], ownerCount: number}}
 */
function siblingVelocity(claimNode, nowMs) {
  const owners = claimOwnerIds(claimNode);
  const reasons = [];
  if (owners.length >= VELOCITY_OWNER_COUNT) reasons.push("owner-count");
  const sib = (claimNode && claimNode.siblings && typeof claimNode.siblings === "object") ? claimNode.siblings : {};
  const now = Number(nowMs) || 0;
  const recent = Object.values(sib).filter((e) => {
    const at = e && Number(e.addedAt);
    return Number.isFinite(at) && now - at <= VELOCITY_WINDOW_MS;
  }).length;
  if (recent >= VELOCITY_ADDS_IN_WINDOW) reasons.push("adds-in-24h");
  return { flag: reasons.length > 0, reasons, ownerCount: owners.length };
}

/**
 * Has this exact pair already been answered "different colourway" before?
 * A repeat answer for the same pair is worth a flag (someone keeps hitting the
 * same collision), and — like every flag here — is logged, never acted on.
 * @param {object|null} eventsNode  the whole /style_code_sibling_events node
 */
function repeatAnswerCount(eventsNode, code, idA, idB) {
  if (!eventsNode || typeof eventsNode !== "object") return 0;
  const [a, b] = [String(idA), String(idB)].sort();
  let n = 0;
  for (const ev of Object.values(eventsNode)) {
    if (!ev || ev.code !== code || ev.answer !== ANSWER_DIFFERENT_COLOURWAY) continue;
    const ids = [String(ev.productId || ""), String(ev.otherId || "")].sort();
    if (ids[0] === a && ids[1] === b) n++;
  }
  return n;
}

module.exports = {
  SIBLING_EVENTS_PATH,
  ANSWER_SAME_SHOE,
  ANSWER_DIFFERENT_COLOURWAY,
  SIBLING_ANSWERS,
  VELOCITY_OWNER_COUNT,
  VELOCITY_WINDOW_MS,
  VELOCITY_ADDS_IN_WINDOW,
  claimOwnerIds,
  isSiblingPair,
  partitionPairs,
  buildSiblingEntry,
  siblingVelocity,
  repeatAnswerCount,
};
