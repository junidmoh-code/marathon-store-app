// ─── BLACK FRIDAY 2026 — the card's state, pure (v3, Junid 19 Nov evening) ────
// ONE ROW PER PRODUCT. The Mac mini (marathon-group-poster bin/bf-build.mjs)
// writes the campaign's products every morning, never a paper bag:
//   items/main/{pid}   total on hand 13 or more (New Arrivals included)
//   items/under/{pid}  everything else that qualifies (in stock, priced, photo)
//                      — shown only behind "Show under 13"
// Junid's decisions are per product (the card's callables only):
//   picks/{pid}   { state: "approved"|"rejected", sig, at, by, section, price,
//                   kind, name, sizes, rev }   — absent = To review.
//                 A rejection PERSISTS: the rebuild never brings it back.
//   photos/{pid}  { use, genId, gens, generating, rev }      (photo choice)
//   styles/{kind} { approvedAt, by }   Junid approved that category's AI look
//   schedule      { …, plan: { album: { due, lap, pids: { pid: true } } } }
//   posted/{pid}  { at, sig, approvedAt, album }             (the poster)
// GROUPING HAPPENS ONLY AT POSTING: approved products → albums of one stock
// price and one kind (clothing and sneakers never together; caps/beanies,
// perfumes, bags … each with their own kind), ≤ 30 photos and a caption that
// fits, computed here when the plan is made. Only the STOCK price is shown.
//
// AN APPROVAL IS OF A PHOTO: picks.sig = "current" or the generation id
// approved; a new photo makes the product wait again.
"use strict";

const sched = require("./schedule.cjs");

const ROOT = "bf_campaign_2026";
const PID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GEN_RE = /^g\d{10,16}$/;
const KIND_RE = /^[a-z][a-z0-9-]{0,30}$/;
const SECTIONS = Object.freeze(["main", "under"]);
const BIG_QTY = 30;            // "Approve all 30+": the first block of MAIN
const ALBUM_MAX = 30;          // photos per album
const CAPTION_MAX = 950;       // caption characters (WhatsApp's limit is 1024)
// The AI looks Junid has had since October; every other kind needs his OK on its sample first.
const ESTABLISHED_STYLES = Object.freeze(["sneakers", "clothing"]);
const KIND_LABEL = Object.freeze({ sneakers: "Sneakers", clothing: "Clothing", headwear: "Caps & beanies", perfume: "Perfume", bags: "Bags", belts: "Belts", sunglasses: "Sunglasses", watches: "Watches", jewellery: "Chains & bracelets", accessories: "Accessories" });

const priceLabel = (p) => (Number.isInteger(Number(p)) ? `R${Number(p)}` : `R${Number(p).toFixed(2)}`);
const priceKey = (p) => (Number.isInteger(Number(p)) ? `R${Number(p)}` : `R${Number(p).toFixed(2).replace(".", "_")}`);
const sizesPhrase = (t) => (t === "one size" ? "one size" : `sizes ${t}`);
function captionPreview(price, items) {
  const lines = items.map((it, i) => `${i + 1}. ${String(it.name || "").trim()} — ${sizesPhrase(it.sizes)}`);
  return [`BLACK FRIDAY 🔥 ${priceLabel(price)} EACH`, ...lines, "Message us to order."].join("\n");
}

function sigOf(photo) {
  return photo && photo.use === "generated" && photo.genId && photo.gens && photo.gens[photo.genId] ? photo.genId : "current";
}
/**
 * Approved, with the photo it shows now. Pure. With the product's card row: its
 * own photo must also still be the one approved (pick.shown) — a photo the
 * 05:00 rebuild brought in is never "approved" unseen.
 */
const isApproved = (pick, photo, item = null) => !!pick && pick.state === "approved" && pick.sig === sigOf(photo)
  && !(item && pick.sig === "current" && pick.shown && item.photo && item.photo !== pick.shown);
const isRejected = (pick) => !!pick && pick.state === "rejected";
/** Posted for THIS approval (a re-approval posts again). Pure. */
const postedFor = (pick, posted) => !!posted && !!pick && posted.approvedAt === pick.at;

/** One product row as the card shows it. Pure. */
function viewItem(pid, it, { pick = null, photo = null, posted = null, styles = {}, nowMs = Date.now() } = {}) {
  const sig = sigOf(photo);
  const gen = sig !== "current" ? photo.gens[sig] : null;
  const latest = photo && photo.genId && photo.gens && photo.gens[photo.genId] ? photo.gens[photo.genId] : null;
  const approved = isApproved(pick, photo, it);
  const kind = it.kind || "clothing";
  return {
    pid, name: it.name || pid, price: it.price, qty: Number(it.qty) || 0, sizes: it.sizes || "", kind,
    big: (Number(it.qty) || 0) >= BIG_QTY, na: it.na === true,
    photo: it.photo || null, shown: gen ? gen.url : (it.photo || null),
    use: sig === "current" ? "current" : "generated", genId: photo && photo.genId ? photo.genId : null, sig,
    generatedUrl: latest ? latest.url : null, generations: photo && photo.gens ? Object.keys(photo.gens).length : 0,
    generating: !!(photo && photo.generating && nowMs - Number(photo.generating.at) < sched.CLAIM_MS),
    // A kind whose AI look Junid has not approved yet: "Use current photo" is the safe default.
    styleApproved: ESTABLISHED_STYLES.includes(kind) || !!(styles[kind] && styles[kind].approvedAt),
    // The last Generate failed (photos/{pid}/failed, set by bfGenerate; the next success clears it).
    failed: photo && photo.failed && photo.failed.at ? { at: photo.failed.at, reason: String(photo.failed.reason || "") } : null,
    tab: approved ? "approved" : "review",
    changedSinceApproval: !!pick && pick.state === "approved" && !approved,
    posted: approved && postedFor(pick, posted) ? (posted.at || true) : null,
  };
}

/** MAIN order: every 30+ product first (one block, highest first), then 13–29 (highest first). UNDER: highest first. Pure. */
function orderRows(rows) {
  return [...rows].sort((a, b) => (Number(b.big) - Number(a.big)) || (b.qty - a.qty) || String(a.name).localeCompare(String(b.name)) || (a.pid < b.pid ? -1 : 1));
}

/**
 * The card for one section. node: { meta, items: { [section]: … }, picks, photos, posted, styles, stats, schedule }.
 * Rejected products are never listed (only in the small "Rejected (n)" list). Pure.
 */
function viewSection(node, section = "main", { postingPaused = false, nowMs = Date.now(), extraApproved = {} } = {}) {
  const n = node || {};
  // extraApproved: the other section's APPROVED products (so the Approved tab always shows every approval).
  const items = { ...extraApproved, ...(((n.items || {})[section]) || {}) };
  const picks = n.picks || {}, photos = n.photos || {}, posted = n.posted || {}, styles = n.styles || {};
  const rows = [];
  for (const [pid, it] of Object.entries(items)) {
    if (!it || isRejected(picks[pid])) continue;
    rows.push(viewItem(pid, it, { pick: picks[pid], photo: photos[pid], posted: posted[pid], styles, nowMs }));
  }
  const ordered = orderRows(rows);
  const m = n.meta || {};
  const idx = n.idx || null;
  const live = (pid) => !idx || !!idx[pid];
  const rejected = Object.entries(picks).filter(([pid, p]) => isRejected(p) && live(pid)).map(([pid, p]) => ({ pid, name: p.name || pid, section: p.section || null, at: p.at || null }))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  return {
    section,
    review: ordered.filter((r) => r.tab === "review" && !extraApproved[r.pid]),
    approved: ordered.filter((r) => r.tab === "approved"),
    totals: totalsOf(n, picks, photos),
    rejected,
    styles: Object.fromEntries(Object.entries(styles).map(([k, v]) => [k, !!(v && v.approvedAt)])),
    schedule: n.schedule && n.schedule.confirmedAt ? { start: n.schedule.start, from: n.schedule.from, to: n.schedule.to, mode: n.schedule.mode, gapMin: n.schedule.gapMin || null, until: n.schedule.until || null, confirmedAt: n.schedule.confirmedAt } : null,
    plan: n.schedule && n.schedule.confirmedAt ? planView(n.schedule.plan) : [],
    postingPaused: !!postingPaused,
    meta: { builtAt: m.builtAt || null, main: m.main || 0, big: m.big || 0, under: m.under || 0, newArrivals: m.newArrivals || 0, paperBags: m.paperBags || 0, noPhotoCount: m.noPhotoCount || 0 },
  };
}

/**
 * To review / Approved across BOTH sections, and AI spend — counting only
 * products in the campaign now (idx, written by the build): a pick for a
 * product that sold out and left is never a ghost in the counts. Pure.
 */
function totalsOf(n, picks, photos) {
  const m = n.meta || {};
  const idx = n.idx || null;
  // "To review" is MAIN only (13+ on hand, Junid 19 Nov): under-13 has its own count behind its switch.
  let approved = 0, rejected = 0, mainTouched = 0, underTouched = 0;
  for (const [pid, p] of Object.entries(picks)) {
    if (idx && !idx[pid]) continue;
    const touched = isRejected(p) || isApproved(p, photos[pid]);
    if (isRejected(p)) rejected += 1;
    else if (isApproved(p, photos[pid])) approved += 1;
    if (touched) { if ((idx ? idx[pid] : (p.section === "under" ? "u" : "m")) === "u") underTouched += 1; else mainTouched += 1; }
  }
  const spent = Number(n.stats && n.stats.spentZar) || 0;
  return {
    review: Math.max(0, (Number(m.main) || 0) - mainTouched), underReview: Math.max(0, (Number(m.under) || 0) - underTouched),
    approved, rejected, spentZar: Math.round(spent * 100) / 100,
  };
}

const planView = (plan) => Object.entries(plan || {}).map(([album, e]) => ({ album, due: Number(e && e.due) || null, count: Object.keys((e && e.pids) || {}).length }))
  .sort((a, b) => (a.due || 0) - (b.due || 0));

// ── the taps, as transaction mutators on picks/{pid} ─────────────────────────
/** item: the product's row (from items/{section}); photo: photos/{pid}. */
/**
 * seenSig: the photo the card showed when Junid tapped ("current" or a genId).
 * A different photo now (a generation landed meanwhile) is refused — never an
 * approval of a photo he has not seen. onlyIfUntouched: "Approve all 30+".
 * `shown` pins the exact image approved.
 */
function approveMutator({ item, section, photo, uid, nowMs, seenSig = null, onlyIfUntouched = false }, out = {}) {
  return (cur) => {
    const sig = sigOf(photo);
    if (seenSig && seenSig !== sig) { out.refusal = "its photo changed since the card loaded — look again, then approve"; return undefined; }
    if (onlyIfUntouched && cur && cur.state) { out.noop = true; return undefined; }
    const shown = sig === "current" ? (item.photo || null) : ((photo.gens[sig] && photo.gens[sig].url) || null);
    if (cur && cur.state === "approved" && cur.sig === sig && cur.shown === shown) { out.noop = true; return undefined; }
    return { state: "approved", sig, shown, at: nowMs, by: uid || null, section, price: item.price, kind: item.kind || "clothing", name: item.name || "", sizes: item.sizes || "" };
  };
}
function rejectMutator({ item, section, uid, nowMs }, out = {}) {
  return (cur) => {
    if (cur && cur.state === "rejected") { out.noop = true; return undefined; }
    return { state: "rejected", at: nowMs, by: uid || null, section, name: (item && item.name) || (cur && cur.name) || "" };
  };
}
/** Back to To review (undo a rejection, or take back an approval). The node stays (rev). */
function resetMutator(out = {}) {
  return (cur) => {
    if (!cur || !cur.state) { out.noop = true; return undefined; }
    return { name: cur.name || "" };
  };
}
/**
 * Undo: put back exactly what the pick was before (prev), but only if it is
 * still what the action wrote (its `at`) — an Undo never clobbers a newer change.
 */
function restoreMutator({ prev, expectAt }, out = {}) {
  return (cur) => {
    if (!cur || Number(cur.at) !== Number(expectAt)) { out.refusal = "it changed since — not undone"; return undefined; }
    const { rev, ...was } = prev || {}; // eslint-disable-line no-unused-vars
    return was.state ? was : { name: was.name || cur.name || "" };
  };
}
/** Choose the photo a product posts with. On photos/{pid}. */
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
/** Every picks/photos write bumps `rev`, so the node is never empty and never deleted. */
function withRev(next, base) {
  return { ...(next || {}), rev: ((base && base.rev) || 0) + 1 };
}

// ── posting: albums are made from the approved products, only when planning ─
/** Approved products still to post: { pid: pick }. Pure. */
function toPost(picks, photos, posted) {
  const out = {};
  for (const [pid, p] of Object.entries(picks || {})) {
    if (!isApproved(p, (photos || {})[pid])) continue;
    if (postedFor(p, (posted || {})[pid])) continue;
    out[pid] = p;
  }
  return out;
}

/** 32-bit FNV-1a of a string → a safe whole number (the album's send id for Signal Studio). Pure. */
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

/**
 * Albums: one stock price + one kind, ≤ ALBUM_MAX photos and a caption ≤
 * CAPTION_MAX; as few near-equal parts as hold them. Products in name order.
 * → [{ key, price, kind, part, parts, pids: [pid], lap, firstAt }]. Pure.
 */
function albumsOf(pending) {
  const by = new Map();
  for (const [pid, p] of Object.entries(pending)) {
    const k = `${Number(p.price)}|${p.kind || "clothing"}`;
    if (!by.has(k)) by.set(k, { price: Number(p.price), kind: p.kind || "clothing", rows: [] });
    by.get(k).rows.push({ pid, ...p });
  }
  const fits = (rows) => captionPreview(rows[0].price, rows).length <= CAPTION_MAX;
  const out = [];
  for (const { price, kind, rows } of [...by.values()].sort((a, b) => (a.price - b.price) || (a.kind < b.kind ? -1 : 1))) {
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)) || (a.pid < b.pid ? -1 : 1));
    const split = (n) => { const size = Math.floor(rows.length / n), extra = rows.length % n; const parts = []; let at = 0; for (let i = 0; i < n; i++) { const c = size + (i < extra ? 1 : 0); parts.push(rows.slice(at, at + c)); at += c; } return parts; };
    let n = Math.ceil(rows.length / ALBUM_MAX);
    while (n < rows.length && !split(n).every(fits)) n++;
    split(n).forEach((part, i) => {
      const pids = part.map((r) => r.pid);
      out.push({ key: `${priceKey(price)}-${kind}-${i + 1}`, price, kind, part: i + 1, parts: n, pids,
        // The send id covers the products, their photos AND their approval times: a re-approval is a new send.
        lap: fnv(part.map((r) => `${r.pid}:${r.sig}:${r.at}`).join("|")), firstAt: Math.min(...part.map((r) => Number(r.at) || 0)) });
    });
  }
  return out;
}

/**
 * The plan: { album: { due, lap, pids } }. An album already planned for a
 * time still ahead — or not yet posted at all — keeps its time; the rest are
 * placed after the last kept time. A confirm passes no prevPlan. Pure.
 */
function planAlbums(albums, schedule, nowMs, prevPlan = null, posted = {}) {
  const keep = {};
  for (const [key, e] of Object.entries(prevPlan || {})) {
    if (!e || !(Number(e.due) > 0)) continue;
    const anyPosted = Object.keys(e.pids || {}).some((pid) => posted && posted[pid] && posted[pid].album === key && Number(posted[pid].at) >= Number(e.due) - 60_000);
    if (Number(e.due) > nowMs || !anyPosted) keep[key] = Number(e.due);
  }
  const queue = albums.map((a) => ({ key: a.key, approvedAt: a.firstAt, price: a.price, part: a.part }));
  const times = sched.planSchedule(queue, schedule, nowMs, keep);
  const plan = {};
  for (const a of albums) if (times[a.key]) plan[a.key] = { due: times[a.key], lap: a.lap, pids: Object.fromEntries(a.pids.map((p) => [p, true])) };
  return plan;
}

module.exports = {
  ROOT, PID_RE, GEN_RE, KIND_RE, SECTIONS, BIG_QTY, ALBUM_MAX, CAPTION_MAX, ESTABLISHED_STYLES, KIND_LABEL,
  priceLabel, priceKey, captionPreview, sigOf, isApproved, isRejected, postedFor,
  viewItem, orderRows, viewSection, totalsOf, planView,
  approveMutator, rejectMutator, resetMutator, restoreMutator, useMutator, withRev,
  toPost, albumsOf, planAlbums, fnv,
  ...sched,
};
