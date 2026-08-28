// ─── WHY A PRODUCT WENT OFF THE STOREFRONT ───────────────────────────────────
// Every path that can take a product off the shop writes ONE record, in this
// shape, in the same breath as the state change. Before this existed, the
// question "who turned this off, when, and why" was unanswerable from the
// database — see docs/PUBLISH-AUTO-OFF.md, where 107 products taken off on 22
// August 2026 all read `updatedBy: script:approve-name-proposals`, the rename
// that happened eight hours AFTERWARDS and had nothing to do with the switch.
//
//   /shopify_publish/{pid}/lastOff = {
//     at:         epoch ms — SERVER clock (serverNowMs() in the browser,
//                 ServerValue.TIMESTAMP resolved by the Admin SDK). Never
//                 Date.now(): `updatedAt` beside it is a rules-validated field
//                 and a skewed device clock poisons the node for every later
//                 browser write.
//     actor:      "<uid>" | "script:<name>" | "function:<name>"
//     reasonCode: one of OFF_REASONS
//     detail:     one human-readable sentence, ≤ 300 chars
//   }
//   /shopify_publish/{pid}/offLog/{at} = the same record   (last OFF_LOG_KEEP)
//
// WHY A SEPARATE `actor` AND NOT `updatedBy`. The live console rule on
// /shopify_publish/$pid is `"updatedBy": { ".validate": "newData.val() ===
// auth.uid" }`, so a browser write cannot put anything else there, and every
// write to the node re-stamps it — which is exactly how the 22 August
// attribution was lost. `actor` is written once, at the moment of the off, and
// nothing else ever touches it.
//
// NO RULE CHANGE IS NEEDED. Both fields ride the live rule's
// `"$other": { ".validate": true }` clause on /shopify_publish/$pid (verified
// against the LIVE rules on 2026-08-28, not the stale repo copy).
//
// NO IMPORTS, deliberately — the same discipline as publishState.js. The
// Admin-SDK scripts load this file under plain Node ESM, where an
// extension-less import of a sibling is fatal.

/** The reason a product left the storefront. One list, both sides. */
export const OFF_REASONS = {
  // A person used the on/off switch, with no further context.
  switched_off: "switched off from the publishing page",
  // A person switched it off in order to change its listing name. The rename
  // paths REFUSE a product that is on (isOnOrGoingOn), so this is a forced
  // round trip and the one that produced the "goes off by itself" reports.
  off_to_rename: "switched off so the listing name could be changed",
  // A publish that had not gone public yet was called back.
  publish_cancelled: "the pending publish was cancelled before it went public",
  // The reconciler's apply-time validator said no. `detail` carries its words.
  reconciler_refused: "the last publish attempt was refused",
  // Confirmed off because there is no Shopify product to unpublish.
  no_shopify_product: "there is nothing on Shopify under this product",
  // The intent was withdrawn between validation and the publish call.
  cancelled_mid_run: "the publish was called back while it was being applied",
  // An Admin-SDK script. `actor` names which one.
  script: "changed by a maintenance script",
};

/** How many off events one product keeps. Rare events; ten is a long memory. */
export const OFF_LOG_KEEP = 10;

const MAX_DETAIL = 300;

function isReason(code) {
  return Object.prototype.hasOwnProperty.call(OFF_REASONS, code);
}

/**
 * Build the record. `at` is passed in rather than read from a clock here:
 * the browser supplies serverNowMs() and the scripts supply a resolved server
 * timestamp, and this file must not know which world it is in.
 *
 * An unknown reasonCode is NOT silently accepted — it would produce a row that
 * says nothing, which is the state this whole module exists to end.
 */
export function buildOffRecord({ at, actor, reasonCode, detail = null }) {
  if (!isReason(reasonCode)) throw new Error(`unknown off reasonCode: ${JSON.stringify(reasonCode)}`);
  if (!actor) throw new Error("an off record needs an actor");
  const text = detail == null ? null : String(detail).trim().slice(0, MAX_DETAIL);
  return {
    at,
    actor: String(actor),
    reasonCode,
    ...(text ? { detail: text } : {}),
  };
}

/**
 * Merge an off record into a node body, trimming the log.
 *
 * `at` may be a sentinel (the Admin SDK's ServerValue.TIMESTAMP) rather than a
 * number, so the log key cannot come from it — the caller passes `logKey`, an
 * ordinary epoch-ms string. Never an ISO string or free text: an RTDB key that
 * is not a plain number sorts as a string and, as this repo learned once
 * already, a "-" prefix is the ZERO character.
 *
 * Returns the FIELDS to merge, not a whole node — the browser store spreads
 * them into its transaction and the scripts hand them to update().
 */
export function offAuditFields(node, record, logKey) {
  const key = String(logKey);
  if (!/^\d+$/.test(key)) throw new Error(`off log key must be plain epoch ms, got ${JSON.stringify(logKey)}`);
  const existing = node && typeof node.offLog === "object" && node.offLog ? node.offLog : {};
  const log = { ...existing, [key]: record };
  // Trim oldest-first. Numeric compare — string sort puts a 13-digit stamp
  // beside a 10-digit one in the wrong order once the clock rolls a digit.
  // SAME-MILLISECOND COLLISION is accepted, not worked around. Two writers
  // taking the SAME product off inside one millisecond would share a key and
  // the second would replace the first — but the transaction serialises them,
  // `lastOff` is correct either way, and the alternative is a key that is not
  // plain epoch ms, which this repo has already been bitten by once.
  const keys = Object.keys(log).sort((a, b) => Number(a) - Number(b));
  const drop = keys.slice(0, Math.max(0, keys.length - OFF_LOG_KEEP));
  for (const k of drop) delete log[k];
  return { lastOff: record, offLog: log };
}

function shortDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    return new Date(n).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return null;
  }
}

/**
 * The sentence the row shows. ONE builder, so the list row, the product page
 * and any future surface cannot describe the same node differently.
 *
 * Returns null when the product is not off (nothing to explain), and a plain
 * admission when it is off with no record — every product switched off before
 * this shipped is in that bucket and pretending otherwise would be a lie.
 *
 * `renamedSince` is the round-trip half: a product taken off FOR a rename,
 * whose rename has landed, is finished waiting and can go back on. Nothing
 * here switches it on — this is a sentence, not an action.
 */
export function describeOff(node) {
  if (!node) return null;
  const rec = node.lastOff;
  if (!rec || !isReason(rec.reasonCode)) {
    return {
      known: false,
      renamedSince: false,
      text: "Off the shop. It went off before this app started recording why.",
    };
  }
  const when = shortDate(rec.at);
  const head = when ? `Taken off the shop on ${when}` : "Taken off the shop";
  const why = rec.detail || OFF_REASONS[rec.reasonCode];
  const approved = Number(node.nameApprovedAt) || 0;
  const renamedSince =
    rec.reasonCode === "off_to_rename" && approved > 0 && approved >= (Number(rec.at) || 0);
  // `text` states what HAPPENED. `renamedSince` is a separate fact the caller
  // decides how to show — the product page gives it its own green line, and
  // appending it to the sentence as well printed the same thing twice on the
  // same screen (CodeRabbit review, 2026-08-28). One fact, one place, and the
  // caller owns the emphasis.
  return { known: true, renamedSince, text: `${head} — ${why}.` };
}
