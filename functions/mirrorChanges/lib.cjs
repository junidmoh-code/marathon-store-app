// ─── /mirror_changes — THE PURE PART ─────────────────────────────────────────
//
// The decisions this module makes have to be testable without a trigger, an
// emulator or a clock — so they live here, in plain CommonJS with no
// firebase-functions import, exactly as displayChecks/lib.cjs does.
// mirrorChanges.js is the I/O around them.
//
// See mirrorChanges.js for what the change log is and why it exists.

const { rowKeyFromParams } = require("./legs.cjs");

/**
 * The record to append for one write, or null for one that needs none.
 *
 * A write whose before and after are byte-identical is NOT a change. RTDB
 * fires on such writes routinely — a client that re-sends the record it
 * already holds, an `update()` that rewrites a field to its own value — and
 * appending for them would grow the log and make every device re-read a child
 * for nothing.
 */
function changeRecord(leg, params, beforeVal, afterVal, nowMs) {
  const key = rowKeyFromParams(leg, params);
  // A segment carrying "|" would collide two rows into one on the client. It
  // cannot be represented, so it is REFUSED and logged rather than written
  // under a key that means something else.
  if (key === null) return null;
  if (sameValue(beforeVal, afterVal)) return null;
  return { n: leg.node, k: key, t: nowMs };
}

// Structural equality over what RTDB can store: nulls, primitives, objects and
// arrays. JSON.stringify would answer "different" for two equal objects whose
// keys arrived in a different order, which is exactly what an update() through
// a different code path produces.
//
// An ARRAY and an OBJECT with the same entries are deliberately NOT equal:
// RTDB coerces dense integer keys to an array and back (560 of 5,793 /stock
// rows are array-coerced today), and a mirror that treated the two as the same
// value would miss the write that flipped one into the other.
function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!sameValue(a[k], b[k])) return false;
  }
  return true;
}

// The 8-character push-key prefix encoding `ms`. Push keys sort
// lexicographically in this alphabet's order, which is the same order as time
// — so a key prefix is a time bound. The same arithmetic lives on the client
// in src/insights/insightsLogRange.js; the two are pinned against each other
// by src/offline/__tests__/pushKeyAgreement.test.js.
const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
function pushKeyForMs(ms) {
  let n = Math.max(0, Math.floor(Number(ms) || 0));
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out = PUSH_CHARS[n % 64] + out;
    n = Math.floor(n / 64);
  }
  return out;
}

module.exports = { changeRecord, sameValue, pushKeyForMs };
