// ─── PINE FOLLOWS TROPHY — one shop's policy resolved from another's ─────────
//
// Junid, 22 Nov 2026: Marathon Pine and Trophy are the same kind of shop, so
// every product policy at Pine is Trophy's. It is a LINK, not a copy:
//     config/refillEngine/policyFollow = { "marathon-pine": "trophy" }
// With the key on, the refill engine resolves Pine's keep, minimum and ask-at
// from Trophy's policy at the moment it plans (refill-engine.cjs resolveTarget),
// so an edit to Trophy on the Engine Policy card is Pine's from the next scan
// with no second step. Deleting the key (the card's Revert) is the rollback:
// Pine is back on the numbers it had before.
//
// HOW MANY, NEVER WHERE.
//   • It speaks only for a product Pine already carries (a seat, or its cell).
//     It never seats a Trophy product at Pine and never names a new location.
//   • A switch-off at Pine (a target 0 row there) is read first and wins.
//   • A switch-off at Trophy is Trophy's own and is not taken.
//   • Where Trophy has no policy for a cell, Pine keeps what it had.
//   • Footwear is left out: Pine's sneakers are Hub 3's, on the footwear policy.
//   • Where Pine's stock COMES FROM is not this file's business and does not
//     change: Central for everything that is not footwear, Hub 3 for footwear.
//
// TWO COPIES, ONE BODY: this file and src/components/stock/policyFollow.js
// carry the same text between the markers; a parity test pins them. Pure: no
// firebase, no clock, no require.
"use strict";

// ── BEGIN SHARED BODY ────────────────────────────────────────────────────────
const POLICY_FOLLOW_KEY = "policyFollow";
// The only link there is: Marathon Pine follows Trophy (Junid, 22 Nov 2026).
// A pair that is not listed here is ignored wherever it is read and refused
// wherever it is written, so no config edit can link any other location.
const POLICY_FOLLOW_ALLOWED = Object.freeze({ "marathon-pine": Object.freeze(["trophy"]) });

function followIsObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// The location `loc` follows, or null (key absent, garbled, or not an allowed pair).
function policyFollowOf(config, loc) {
  const map = followIsObj(config) && followIsObj(config[POLICY_FOLLOW_KEY]) ? config[POLICY_FOLLOW_KEY] : null;
  if (!map || typeof loc !== "string" || !loc) return null;
  const leader = map[loc];
  const allowed = POLICY_FOLLOW_ALLOWED[loc];
  return typeof leader === "string" && !!allowed && allowed.includes(leader) ? leader : null;
}

// { follower: leader } for every link that is on.
function policyFollowMap(config) {
  const out = {};
  for (const loc of Object.keys(POLICY_FOLLOW_ALLOWED)) {
    const leader = policyFollowOf(config, loc);
    if (leader) out[loc] = leader;
  }
  return out;
}

// A proposed link: null when it may be written, else the sentence to show.
// `follows` null = switch the link off.
function validatePolicyFollow(location, follows) {
  const allowed = typeof location === "string" ? POLICY_FOLLOW_ALLOWED[location] : null;
  if (!allowed) return "Only Marathon Pine can follow another shop's policy.";
  if (follows === null) return null;
  if (typeof follows !== "string" || !allowed.includes(follows)) return "Marathon Pine can follow Trophy only.";
  return null;
}

// The leader's per-product rows a follower takes: its rows ABOVE ZERO only.
// A target 0 row at the leader is the leader switched off (WHERE the product
// is kept), never a number for the follower; the follower's own switch-off
// rows are read under its own id, before any of this.
function followRows(rows) {
  if (!followIsObj(rows)) return null;
  const out = {};
  for (const k of Object.keys(rows)) {
    const r = rows[k];
    if (followIsObj(r) && typeof r.target === "number" && Number.isFinite(r.target) && r.target > 0) out[k] = r;
  }
  return Object.keys(out).length ? out : null;
}

// What the leader's policy answers for one size of one product THE FOLLOWER
// CARRIES, asked of the caller's own resolver (`resolve` is resolveTarget) so
// there is still one implementation of "which numbers govern a cell".
//   • the leader's rows above zero, its category and group policy, its size
//     rows and its size run all answer, exactly as they answer at the leader;
//   • carriage is the FOLLOWER's: the caller asks only for a product the
//     follower carries, and the leader is read as carrying it too, so a
//     "carried products only" leg or the size run speaks for it;
//   • nothing is written and the config is not changed.
// Returns undefined when the leader has no policy for the cell (the follower's
// own numbers then stand), else { target, minQty, reorderPoint, source:
// "follows", follows, followedSource }.
function followedTarget(resolve, ctx, dest, pid, size) {
  const c = ctx || {};
  const leader = policyFollowOf(c.config, dest);
  if (!leader || typeof resolve !== "function") return undefined;
  const rows = followRows(c.targets && c.targets[leader] ? c.targets[leader][pid] : null);
  const node = c.stock && c.stock[leader] ? c.stock[leader][pid] : null;
  const carried = followIsObj(node) && Object.keys(node).length > 0 ? node : { _follow: {} };
  const stock = Object.assign({}, c.stock, { [leader]: { [pid]: carried } });
  const t = resolve({ targets: { [leader]: rows ? { [pid]: rows } : {} }, config: c.config, products: c.products, stock, network: c.network }, leader, pid, size);
  if (!t || typeof t.target !== "number") return undefined;
  return {
    target: t.target,
    minQty: t.minQty,
    reorderPoint: t.reorderPoint === undefined ? null : t.reorderPoint,
    source: "follows", follows: leader, followedSource: t.source || null,
  };
}
// ── END SHARED BODY ──────────────────────────────────────────────────────────

module.exports = {
  POLICY_FOLLOW_KEY, POLICY_FOLLOW_ALLOWED, policyFollowOf, policyFollowMap, validatePolicyFollow, followRows, followedTarget,
};
