// ─── BLACK FRIDAY 2026 — the card's state, pure ──────────────────────────────
// Junid, 19 Nov 2026. The Mac mini (marathon-group-poster bin/bf-build.mjs)
// writes the price groups to /bf_campaign_2026/groups every morning; Junid's
// approvals and unticks live beside them in /bf_campaign_2026/state, written
// ONLY by bfCampaignSet; the poster records what went out in /posts.
//
//   groups/{key}  { key, label, price, part, parts, caption, count, builtAt,
//                   items: { pid: { n, name, sizes, qty, photo } } }   (the Mac)
//   state/{key}   { approvedAt, approvedBy, approvedItems: {pid:true},
//                   excluded: {pid:true} }                             (the card)
//   posts/{key}   { lap, status, at, posted, dropped }                 (the Mac)
//   decisions/{push}  one row per tap                                   (the card)
//
// Only the STOCK price is ever shown. The status words are the card's:
// waiting · approved · posted · partly sold out (and sold out / held).
"use strict";

const ROOT = "bf_campaign_2026";
const KEY_RE = /^R\d+(_\d\d)?(-part\d+)?$/;
const PID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Junid's caption, word for word — the Mac's src/bf/core.mjs CAPTION_TEXT.
const priceLabel = (p) => (Number.isInteger(Number(p)) ? `R${Number(p)}` : `R${Number(p).toFixed(2)}`);
const sizesPhrase = (t) => (t === "one size" ? "one size" : `sizes ${t}`);
function captionPreview(price, items) {
  const lines = items.map((it, i) => `${i + 1}. ${String(it.name || "").trim()} — ${sizesPhrase(it.sizes)}`);
  return [`BLACK FRIDAY 🔥 R${Math.round(Number(price))} EACH`, ...lines, "Message us to order."].join("\n");
}

function groupStatus(state, post) {
  const lap = (state && state.approvedAt) || null;
  if (lap && post && post.lap === lap) {
    if (post.status === "sold out") return "sold out";
    if (post.status === "held") return "held";
    return post.dropped && Object.keys(post.dropped).length ? "partly sold out" : "posted";
  }
  return lap ? "approved" : "waiting";
}

const itemsInOrder = (group) => Object.entries((group && group.items) || {})
  .map(([pid, it]) => ({ pid, ...it })).sort((a, b) => (a.n || 0) - (b.n || 0));

/** One group as the card shows it. Pure. */
function viewGroup(key, group, state, post) {
  const excluded = (state && state.excluded) || {};
  const approved = (state && state.approvedItems) || {};
  const status = groupStatus(state, post);
  const items = itemsInOrder(group).map((it) => ({
    pid: it.pid, n: it.n, name: it.name || it.pid, sizes: it.sizes || "", qty: it.qty || 0, photo: it.photo || null,
    excluded: excluded[it.pid] === true,
    // On the card after an approval: an item added by a later rebuild is not covered until Junid approves again.
    newSinceApproval: status === "approved" && !approved[it.pid] && excluded[it.pid] !== true,
  }));
  const included = items.filter((it) => !it.excluded);
  return {
    key, label: group.label || key, price: group.price, part: group.part || 1, parts: group.parts || 1,
    count: items.length, included: included.length, status,
    approvedAt: (state && state.approvedAt) || null,
    newSinceApproval: items.filter((it) => it.newSinceApproval).length,
    caption: captionPreview(group.price, included),
    items,
    // Posted under an EARLIER approval (then undone or approved again): said
    // plainly, so a new Approve is never mistaken for a first post.
    postedEarlierAt: post && post.status === "posted" && !(state && post.lap === state.approvedAt) ? (post.at || null) : null,
    post: post && state && post.lap === state.approvedAt ? {
      at: post.at || null, status: post.status || null,
      posted: Object.keys(post.posted || {}).length,
      dropped: Object.entries(post.dropped || {}).map(([pid, d]) => ({ pid, name: (d && d.name) || pid, why: (d && d.why) || "" })),
    } : null,
  };
}

/** The whole card from the campaign node. Pure. */
function viewCampaign(node) {
  const n = node || {};
  const groups = n.groups || {};
  const keys = (n.meta && Array.isArray(n.meta.keys) ? n.meta.keys : Object.keys(groups)).filter((k) => groups[k]);
  const list = keys.map((k) => viewGroup(k, groups[k], (n.state || {})[k] || null, (n.posts || {})[k] || null));
  const counts = {};
  for (const g of list) counts[g.status] = (counts[g.status] || 0) + 1;
  const m = n.meta || {};
  return {
    groups: list, counts,
    meta: { builtAt: m.builtAt || null, eligible: m.eligible || 0, groupCount: m.groupCount || list.length, noPhotoCount: m.noPhotoCount || 0, noPhoto: Array.isArray(m.noPhoto) ? m.noPhoto : [] },
  };
}

// ── the taps, as transaction mutators on state/{key} ─────────────────────────
// `post` is posts/{key} as read just before; `group` is groups/{key}.

/** Approve: covers every item not unticked. A posted group approved again is a new lap. */
function approveMutator({ group, post, uid, nowMs }, out = {}) {
  return (cur) => {
    const s = cur || {};
    const excluded = s.excluded || {};
    const pids = itemsInOrder(group).map((it) => it.pid).filter((pid) => excluded[pid] !== true);
    if (!pids.length) { out.refusal = "every item is unticked — tick at least one"; return undefined; }
    const status = groupStatus(s, post);
    const cover = Object.fromEntries(pids.map((p) => [p, true]));
    // Already approved, waiting, and nothing new to cover: leave it (its place in the queue is kept).
    if (status === "approved" && pids.every((p) => (s.approvedItems || {})[p])) { out.noop = true; return undefined; }
    // Approved and waiting with new items: widen the cover, keep the queue place.
    const keepLap = status === "approved";
    out.lap = keepLap ? s.approvedAt : nowMs;
    return { ...s, approvedAt: out.lap, approvedBy: uid || null, approvedItems: keepLap ? { ...(s.approvedItems || {}), ...cover } : cover };
  };
}

/** Undo an approval that has not posted. */
function unapproveMutator({ post }, out = {}) {
  return (cur) => {
    const s = cur || {};
    const status = groupStatus(s, post);
    if (status === "waiting") { out.noop = true; return undefined; }
    if (status !== "approved") { out.refusal = "already posted — nothing to undo"; return undefined; }
    const { approvedAt, approvedBy, approvedItems, ...rest } = s; // eslint-disable-line no-unused-vars
    return Object.keys(rest).length ? rest : null;
  };
}

/** Untick (exclude) or tick (include) one item. An approval waiting to post follows the tick. */
function tickMutator({ pid, include, group, post }, out = {}) {
  return (cur) => {
    const s = { ...(cur || {}) };
    const excluded = { ...(s.excluded || {}) };
    if (include) delete excluded[pid]; else excluded[pid] = true;
    s.excluded = Object.keys(excluded).length ? excluded : null;
    if (groupStatus(cur || {}, post) === "approved") {
      const ap = { ...(s.approvedItems || {}) };
      if (include) { if ((group && group.items || {})[pid]) ap[pid] = true; } else delete ap[pid];
      if (Object.keys(ap).length) s.approvedItems = ap;
      else { s.approvedItems = null; s.approvedAt = null; s.approvedBy = null; out.unapproved = true; }
    }
    const clean = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== null && v !== undefined));
    return Object.keys(clean).length ? clean : null;
  };
}

module.exports = { ROOT, KEY_RE, PID_RE, captionPreview, groupStatus, viewGroup, viewCampaign, approveMutator, unapproveMutator, tickMutator, priceLabel };
