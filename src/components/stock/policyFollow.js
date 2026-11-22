// ─── PINE FOLLOWS TROPHY — browser twin of functions/lib/policy-follow.cjs ───
// The text between the markers is identical to the server's; a parity test pins
// it. See the server file for the whole story.

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
  const allowed = Object.prototype.hasOwnProperty.call(POLICY_FOLLOW_ALLOWED, loc) ? POLICY_FOLLOW_ALLOWED[loc] : null;
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
  const allowed = typeof location === "string" && Object.prototype.hasOwnProperty.call(POLICY_FOLLOW_ALLOWED, location) ? POLICY_FOLLOW_ALLOWED[location] : null;
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

export {
  POLICY_FOLLOW_KEY, POLICY_FOLLOW_ALLOWED, policyFollowOf, policyFollowMap, validatePolicyFollow, followRows, followedTarget,
};
