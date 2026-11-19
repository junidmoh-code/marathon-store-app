// ─── BLACK FRIDAY 2026 — the card's state, pure ──────────────────────────────
// Junid, 19 Nov 2026. The Mac mini (marathon-group-poster bin/bf-build.mjs)
// writes the price groups to /bf_campaign_2026/groups every morning: every
// product with more than 12 on hand PLUS every New Arrival (past 20 days),
// grouped by exact STOCK price — clothing and sneakers never in one group.
// Junid's approvals, photo choices and the schedule are written ONLY by the
// card's callables; the poster records what went out in /posts.
//
//   groups/{key}    { key, label, price, division, part, parts, caption, count, builtAt,
//                     items: { pid: { n, name, sizes, qty, photo, na? } } }      (the Mac)
//   state/{key}     { approvedAt, approvedBy, approvedItems: { pid: sig },
//                     excluded: { pid: true }, rev }                            (the card)
//   photos/{pid}    { use: "current"|"generated", genId, gen, gens: { genId: gen },
//                     generating: { at, by }, rev }                             (the card)
//   schedule        { start, from, to, mode, gapMin, until, confirmedAt, confirmedBy,
//                     plan: { key: dueMs }, planAt }                            (the card)
//   stats           { spentZar, generations }                                   (bfGenerate)
//   posts/{key}     { lap, status, at, posted, dropped }                        (the poster)
//   decisions/{push}  one row per tap                                           (the card)
//
// AN APPROVAL IS OF A PHOTO: approvedItems[pid] holds the signature of the
// photo Junid approved ("current", or the generation's id). Choosing another
// photo or generating a new one changes the signature, so the item is simply
// waiting again — Approve is offered (never greyed out) and nothing posts a
// photo Junid has not seen. (`true` from the first version means "current".)
//
// Only the STOCK price is ever shown.
"use strict";

const ROOT = "bf_campaign_2026";
const KEY_RE = /^R\d+(_\d\d)?(-(clothing|sneakers))?(-part\d+)?$/;
const PID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GEN_RE = /^g\d{10,16}$/;
const DIVISIONS = Object.freeze(["clothing", "sneakers"]);
const DIVISION_LABEL = Object.freeze({ clothing: "Clothing", sneakers: "Sneakers" });

// Junid's caption, word for word — the Mac's src/bf/core.mjs CAPTION_TEXT.
const priceLabel = (p) => (Number.isInteger(Number(p)) ? `R${Number(p)}` : `R${Number(p).toFixed(2)}`);
const sizesPhrase = (t) => (t === "one size" ? "one size" : `sizes ${t}`);
function captionPreview(price, items) {
  const lines = items.map((it, i) => `${i + 1}. ${String(it.name || "").trim()} — ${sizesPhrase(it.sizes)}`);
  return [`BLACK FRIDAY 🔥 ${priceLabel(price)} EACH`, ...lines, "Message us to order."].join("\n");
}

/** The photo an item would post now: its signature. Pure. */
function sigOf(photo) {
  return photo && photo.use === "generated" && photo.genId && photo.gens && photo.gens[photo.genId] ? photo.genId : "current";
}
/** Is pid approved with the photo it shows now? Pure. */
function itemApproved(state, pid, photo) {
  const v = state && state.approvedItems ? state.approvedItems[pid] : undefined;
  if (v === undefined || v === null || v === false) return false;
  const sig = sigOf(photo);
  return v === sig || (v === true && sig === "current");
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

/** The pids a group would post now: approved with their current photo, not unticked. Pure. */
function postablePids(group, state, photos) {
  const ex = (state && state.excluded) || {};
  return itemsInOrder(group).map((it) => it.pid).filter((pid) => ex[pid] !== true && itemApproved(state, pid, (photos || {})[pid]));
}

/** One group as the card shows it. Pure. */
function viewGroup(key, group, state, post, photos = {}, planDue = null) {
  const excluded = (state && state.excluded) || {};
  const status = groupStatus(state, post);
  const items = itemsInOrder(group).map((it) => {
    const ph = photos[it.pid] || null;
    const sig = sigOf(ph);
    const gen = sig !== "current" ? ph.gens[sig] : null;
    const latestGen = ph && ph.genId && ph.gens && ph.gens[ph.genId] ? ph.gens[ph.genId] : null;
    const approved = itemApproved(state, it.pid, ph);
    return {
      pid: it.pid, n: it.n, name: it.name || it.pid, sizes: it.sizes || "", qty: it.qty || 0,
      photo: it.photo || null, na: it.na === true,
      excluded: excluded[it.pid] === true,
      use: sig === "current" ? "current" : "generated",
      shown: gen ? gen.url : (it.photo || null),
      generatedUrl: latestGen ? latestGen.url : null,
      genId: ph && ph.genId ? ph.genId : null,
      generations: ph && ph.gens ? Object.keys(ph.gens).length : 0,
      generating: !!(ph && ph.generating && ph.generating.at),
      approved,
      // Approved with a photo it no longer shows (Junid chose another or generated a new one): waiting again.
      changedSinceApproval: !approved && !!(state && state.approvedItems && state.approvedItems[it.pid]),
    };
  });
  const included = items.filter((it) => !it.excluded);
  const approvedItems = included.filter((it) => it.approved);
  return {
    key, label: group.label || key, price: group.price, division: group.division || null,
    part: group.part || 1, parts: group.parts || 1,
    count: items.length, included: included.length, approvedCount: approvedItems.length, status,
    approvedAt: (state && state.approvedAt) || null,
    dueAt: status === "approved" ? planDue : null,
    caption: captionPreview(group.price, approvedItems.length ? approvedItems : included),
    items,
    postedEarlierAt: post && post.status === "posted" && !(state && post.lap === state.approvedAt) ? (post.at || null) : null,
    post: post && state && post.lap === state.approvedAt ? {
      at: post.at || null, status: post.status || null,
      posted: Object.keys(post.posted || {}).length,
      dropped: Object.entries(post.dropped || {}).map(([pid, d]) => ({ pid, name: (d && d.name) || pid, why: (d && d.why) || "" })),
    } : null,
  };
}

/** The totals at the top of the card. Pure. */
function totalsOf(list, stats) {
  const pids = new Set(), ai = new Set();
  let photosN = 0, approved = 0, waiting = 0;
  for (const g of list) {
    for (const it of g.items) {
      pids.add(it.pid);
      if (it.generations > 0) ai.add(it.pid);
      if (it.excluded) continue;
      photosN += 1;
      if (it.approved) approved += 1; else waiting += 1;
    }
  }
  const spent = Number(stats && stats.spentZar) || 0;
  return { products: pids.size, photos: photosN, groups: list.length, aiPhotos: ai.size, approved, waiting, spentZar: Math.round(spent * 100) / 100 };
}

/** The whole card from the campaign node. Pure. */
function viewCampaign(node, { postingPaused = false } = {}) {
  const n = node || {};
  const groups = n.groups || {};
  const photos = n.photos || {};
  const plan = (n.schedule && n.schedule.plan) || {};
  const keys = (n.meta && Array.isArray(n.meta.keys) ? n.meta.keys : Object.keys(groups)).filter((k) => groups[k]);
  const list = keys.map((k) => viewGroup(k, groups[k], (n.state || {})[k] || null, (n.posts || {})[k] || null, photos, plan[k] || null));
  const counts = {};
  for (const g of list) counts[g.status] = (counts[g.status] || 0) + 1;
  const m = n.meta || {};
  const s = n.schedule || null;
  return {
    groups: list, counts, totals: totalsOf(list, n.stats),
    schedule: s && s.confirmedAt ? { start: s.start, from: s.from, to: s.to, mode: s.mode, gapMin: s.gapMin || null, until: s.until || null, confirmedAt: s.confirmedAt, planAt: s.planAt || null } : null,
    postingPaused: !!postingPaused,
    meta: { builtAt: m.builtAt || null, eligible: m.eligible || 0, newArrivals: m.newArrivals || 0, groupCount: m.groupCount || list.length, noPhotoCount: m.noPhotoCount || 0, noPhoto: Array.isArray(m.noPhoto) ? m.noPhoto : [] },
  };
}

// ── the taps, as transaction mutators on state/{key} ─────────────────────────
// `post` is posts/{key}; `group` is groups/{key}; `photos` the photos of its items.

/**
 * Approve: one item (pid) or the whole group (every item not unticked), each
 * with the photo it shows now. A posted group approved again is a new lap.
 */
function approveMutator({ group, post, uid, nowMs, photos = {}, pid = null }, out = {}) {
  return (cur) => {
    const s = cur || {};
    const excluded = s.excluded || {};
    const pids = (pid ? [pid] : itemsInOrder(group).map((it) => it.pid)).filter((p) => excluded[p] !== true);
    if (!pids.length) { out.refusal = pid ? "that item is unticked — tick it first" : "every item is unticked — tick at least one"; return undefined; }
    const status = groupStatus(s, post);
    const cover = Object.fromEntries(pids.map((p) => [p, sigOf(photos[p])]));
    if (status === "approved" && pids.every((p) => itemApproved(s, p, photos[p]))) { out.noop = true; return undefined; }
    const keepLap = status === "approved";
    out.lap = keepLap ? s.approvedAt : nowMs;
    return { ...s, approvedAt: out.lap, approvedBy: uid || null, approvedItems: keepLap ? { ...(s.approvedItems || {}), ...cover } : cover };
  };
}

/** Undo a group's approval that has not posted. */
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

/**
 * Untick (exclude) or tick (include) one item. An untick drops the item from a
 * waiting approval; ticking it back does NOT approve it (it has its own Approve).
 */
function tickMutator({ pid, include, post }, out = {}) {
  return (cur) => {
    const s = { ...(cur || {}) };
    const excluded = { ...(s.excluded || {}) };
    if (include) delete excluded[pid]; else excluded[pid] = true;
    s.excluded = Object.keys(excluded).length ? excluded : null;
    if (groupStatus(cur || {}, post) === "approved") {
      const ap = { ...(s.approvedItems || {}) };
      if (!include) delete ap[pid];
      if (Object.keys(ap).length) s.approvedItems = ap;
      else { s.approvedItems = null; s.approvedAt = null; s.approvedBy = null; out.unapproved = true; }
    }
    const clean = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== null && v !== undefined));
    return Object.keys(clean).length ? clean : null;
  };
}

/** Choose the photo an item posts with: its current photo, or one of its generations. On photos/{pid}. */
function useMutator({ use, genId = null }, out = {}) {
  return (cur) => {
    const p = cur || {};
    if (use === "current") {
      if (p.use !== "generated") { out.noop = true; return undefined; }
      return { ...p, use: "current" };
    }
    const id = genId || p.genId;
    if (!id || !p.gens || !p.gens[id]) { out.refusal = "there is no generated photo for it yet — tap Generate"; return undefined; }
    if (p.use === "generated" && p.genId === id) { out.noop = true; return undefined; }
    return { ...p, use: "generated", genId: id };
  };
}

/** Every state/photos write bumps `rev`, so the node is never empty and never deleted (see bfCampaignSet). */
function withRev(next, base) {
  return { ...(next || {}), rev: ((base && base.rev) || 0) + 1 };
}

// ── the schedule ─────────────────────────────────────────────────────────────
// Times are SAST (UTC+2, no daylight saving). Pure functions of their inputs.
const SAST_MS = 2 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const CAMPAIGN_END_MS = Date.parse("2026-11-27T20:00:00+02:00");
const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const NOW_GAP_MS = 3 * 60 * 1000;
const hm = (s) => { const m = HM_RE.exec(String(s || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const sastDayStart = (t) => Math.floor((t + SAST_MS) / DAY_MS) * DAY_MS - SAST_MS;

/** The first moment at or after t inside the daily window [from, to). Pure. */
function intoWindow(t, fromMin, toMin) {
  const day = sastDayStart(t);
  const open = day + fromMin * 60000, close = day + toMin * 60000;
  if (t < open) return open;
  if (t >= close) return open + DAY_MS;
  return t;
}
/** t moved forward by `ms` of window time (time outside the window doesn't count). Pure. */
function addWindowTime(t, ms, fromMin, toMin) {
  let at = intoWindow(t, fromMin, toMin), left = ms;
  for (let i = 0; i < 400 && left > 0; i++) {
    const close = sastDayStart(at) + toMin * 60000;
    if (at + left < close) return at + left;
    left -= close - at;
    at = intoWindow(close, fromMin, toMin);
  }
  return at;
}
/** Window time between a and b. Pure. */
function windowTimeBetween(a, b, fromMin, toMin) {
  let total = 0, at = intoWindow(a, fromMin, toMin);
  for (let i = 0; i < 400 && at < b; i++) {
    const close = sastDayStart(at) + toMin * 60000;
    total += Math.min(close, b) - at;
    at = intoWindow(close, fromMin, toMin);
  }
  return total;
}

/** A schedule as typed on the card → a clean one, or { error }. Pure. */
function cleanSchedule(raw, nowMs) {
  const r = raw || {};
  const mode = ["gap", "spread", "now"].includes(r.mode) ? r.mode : null;
  if (!mode) return { error: "Choose a gap, spread evenly, or post all now." };
  const from = r.from || "08:00", to = r.to || "20:00";
  const fromMin = hm(from), toMin = hm(to);
  if (fromMin === null || toMin === null || toMin <= fromMin) return { error: "The daily window must be like 08:00 to 20:00." };
  const start = mode === "now" ? nowMs : Number(r.start);
  if (!Number.isFinite(start) || start <= 0) return { error: "Choose a start date and time." };
  const out = { mode, from, to, start };
  if (mode === "gap") {
    const g = Number(r.gapMin);
    if (!(Number.isFinite(g) && g >= 5 && g <= 24 * 60)) return { error: "The gap must be between 5 minutes and 24 hours." };
    out.gapMin = Math.round(g);
  }
  if (mode === "spread") {
    const u = Number(r.until);
    if (!(Number.isFinite(u) && u > Math.max(start, nowMs))) return { error: "\"Spread evenly until\" must be after the start." };
    out.until = Math.min(u, CAMPAIGN_END_MS);
  }
  return out;
}

/**
 * Which approved group posts when. `queue`: [{ key, approvedAt, price, part }]
 * (approved, not yet posted, with something to post). → { key: dueMs }.
 * A time past the end of the campaign (27 Nov 20:00) is left out. Pure.
 */
function planSchedule(queue, schedule, nowMs) {
  const s = schedule;
  if (!s || !queue.length) return {};
  const order = [...queue].sort((a, b) => (a.approvedAt - b.approvedAt) || (a.price - b.price) || ((a.part || 1) - (b.part || 1)) || (a.key < b.key ? -1 : 1));
  const plan = {};
  if (s.mode === "now") {
    order.forEach((g, i) => { plan[g.key] = Math.max(nowMs, s.start) + i * NOW_GAP_MS; });
    return plan;
  }
  const fromMin = hm(s.from), toMin = hm(s.to);
  const first = intoWindow(Math.max(s.start, nowMs), fromMin, toMin);
  let step;
  if (s.mode === "gap") step = s.gapMin * 60000;
  else {
    const span = windowTimeBetween(first, Math.min(s.until, CAMPAIGN_END_MS), fromMin, toMin);
    step = order.length > 1 ? Math.floor(span / order.length) : 0;
  }
  let t = first;
  for (const g of order) {
    if (t >= CAMPAIGN_END_MS) break;
    plan[g.key] = t;
    t = addWindowTime(t, step, fromMin, toMin);
  }
  return plan;
}

/** The queue planSchedule takes, from the campaign node. Pure. */
function queueOf(node) {
  const n = node || {};
  const groups = n.groups || {};
  const keys = (n.meta && Array.isArray(n.meta.keys) ? n.meta.keys : Object.keys(groups)).filter((k) => groups[k]);
  const out = [];
  for (const k of keys) {
    const st = (n.state || {})[k] || null;
    if (groupStatus(st, (n.posts || {})[k] || null) !== "approved") continue;
    if (!postablePids(groups[k], st, n.photos).length) continue;
    out.push({ key: k, approvedAt: st.approvedAt, price: groups[k].price, part: groups[k].part || 1 });
  }
  return out;
}

module.exports = {
  ROOT, KEY_RE, PID_RE, GEN_RE, DIVISIONS, DIVISION_LABEL, CAMPAIGN_END_MS,
  priceLabel, captionPreview, sigOf, itemApproved, groupStatus, postablePids, viewGroup, viewCampaign, totalsOf,
  approveMutator, unapproveMutator, tickMutator, useMutator, withRev,
  cleanSchedule, planSchedule, queueOf, intoWindow, addWindowTime, windowTimeBetween,
};
