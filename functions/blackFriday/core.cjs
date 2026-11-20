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
//
// JUNID'S OWN PHOTOS (20 Nov 2026): a photo he picks from his iPhone ("Replace
// photo") or from the web ("Find online") is kept in photos/{pid}/gens like a
// generation — { src: "upload"|"web", url, path, site?, pageUrl? } — so it is
// approved, pinned and posted exactly like one (the poster needs no change).
// photos/{pid}/srcId names the product's SOURCE photo on the card: the photo
// Generate starts from. The app's own photo (products/{pid}/photoUrl) is never
// touched or deleted; "Use app photo" brings it back.
//
// NO PRICE, NO POST (Junid, 20 Nov 2026): a product whose stock price is R0 or
// missing cannot be approved, and an approval of one never posts.
"use strict";
const captionLib = require("./caption.cjs");

const sched = require("./schedule.cjs");

const ROOT = "bf_campaign_2026";
const PID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GEN_RE = /^g\d{10,16}$/;
// A photo the card showed: "current", a generation id, or "na" (a New Arrival's main AI photo).
const SIG_OK = (s) => s === "current" || s === "na" || GEN_RE.test(String(s));
const KIND_RE = /^[a-z][a-z0-9-]{0,30}$/;
const SECTIONS = Object.freeze(["main", "under"]);
const BIG_QTY = 30;            // "Approve all 30+": the first block of MAIN
const ALBUM_MAX = 30;          // photos per album
const CAPTION_MAX = 950;       // caption characters (WhatsApp's limit is 1024)
// The AI looks Junid has had since October; every other kind needs his OK on its sample first.
const ESTABLISHED_STYLES = Object.freeze(["sneakers", "clothing"]);
const KIND_LABEL = Object.freeze({ sneakers: "Sneakers", clothing: "Clothing", headwear: "Caps & beanies", perfume: "Perfume", bags: "Bags", belts: "Belts", sunglasses: "Sunglasses", watches: "Watches", jewellery: "Chains & bracelets", accessories: "Accessories" });

/** Is this stock price a real one (above R0)? Pure. */
const hasPrice = (p) => p !== null && p !== undefined && p !== "" && Number.isFinite(Number(p)) && Number(p) > 0;
const NO_PRICE = "No price, set price first";
/** A photos/{pid}/gens entry that is Junid's own photo (upload / web), not an AI generation. Pure. */
const isSourceGen = (g) => !!g && (g.src === "upload" || g.src === "web");
/** The newest AI generation's id (never one of his own photos), or null. Pure. */
function latestAiId(photo) {
  const gens = (photo && photo.gens) || {};
  const ids = Object.keys(gens).filter((id) => gens[id] && gens[id].url && !isSourceGen(gens[id])).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return ids.length ? ids[ids.length - 1] : null;
}
/** The source photo Generate starts from (his own photo), or null for the app's photo. Pure. */
function sourceOf(photo) {
  const id = photo && photo.srcId;
  const g = id && photo.gens && photo.gens[id];
  return isSourceGen(g) && g.url ? { id, ...g } : null;
}
/** Every photo the card can swipe through, oldest first: the app photo, then his photos and the AI photos. Pure. */
function galleryOf(appPhoto, photo, { extra = [] } = {}) {
  const out = appPhoto ? [{ id: "app", url: appPhoto, label: "App photo" }] : [];
  out.push(...extra);
  const gens = (photo && photo.gens) || {};
  for (const id of Object.keys(gens).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
    const g = gens[id];
    if (!g || !g.url) continue;
    out.push({ id, url: g.url, label: g.src === "upload" ? "Your photo" : g.src === "web" ? `From ${g.site || "the web"}` : g.fromSrc ? "AI (from your photo)" : "AI", ...(g.pageUrl ? { pageUrl: g.pageUrl } : {}) });
  }
  return out;
}

const priceLabel = (p) => (Number.isInteger(Number(p)) ? `R${Number(p)}` : `R${Number(p).toFixed(2)}`);
const priceKey = (p) => (Number.isInteger(Number(p)) ? `R${Number(p)}` : `R${Number(p).toFixed(2).replace(".", "_")}`);
/** The album's caption, as it will be sent (Junid, 20 Nov): "R750" / "Available sizes: 6, 7, 8, …". items: [{ sizes: "6-11" | [..] }]. Pure. */
function captionPreview(price, items) {
  return captionLib.caption(price, items.flatMap((it) => (Array.isArray(it.sizes) ? it.sizes : it.sizes === "one size" ? [] : captionLib.splitSizesText(it.sizes))));
}

function sigOf(photo) {
  return photo && photo.use === "generated" && photo.genId && photo.gens && photo.gens[photo.genId] ? photo.genId : "current";
}
/**
 * Approved, with the photo it shows now. Pure. With the product's card row: its
 * own photo must also still be the one approved (pick.shown) — a photo the
 * 05:00 rebuild brought in is never "approved" unseen.
 */
// A New Arrival's pick (src "na") mirrors the New Arrivals item: approved with the photo it pins (na.cjs).
const isApproved = (pick, photo, item = null) => !!pick && pick.state === "approved" && (pick.src === "na" ? !!pick.shown : (pick.sig === sigOf(photo)
  && !(item && pick.sig === "current" && pick.shown && item.photo && item.photo !== pick.shown)));
const isRejected = (pick) => !!pick && pick.state === "rejected";
/** Posted for THIS approval (a re-approval posts again). Pure. */
const postedFor = (pick, posted) => !!posted && !!pick && posted.approvedAt === pick.at;

/** One product row as the card shows it. Pure. */
function viewItem(pid, it, { pick = null, photo = null, posted = null, styles = {}, nowMs = Date.now(), sent = null, repost = null, na = false } = {}) {
  const naPick = !!pick && pick.src === "na";
  const sig = naPick ? "na" : sigOf(photo);
  const gen = sig !== "current" && !naPick ? photo.gens[sig] : null;
  const aiId = latestAiId(photo);
  const latest = aiId ? photo.gens[aiId] : null;
  const source = sourceOf(photo);
  const approved = isApproved(pick, photo, it);
  const kind = it.kind || "clothing";
  // The price that posts: the approved price (as the poster reads it), else the build's stock price.
  const postPrice = pick && pick.state === "approved" ? (pick.price ?? it.price) : it.price;
  return {
    pid, name: it.name || pid, price: it.price, qty: Number(it.qty) || 0, sizes: it.sizes || "", kind,
    big: (Number(it.qty) || 0) >= BIG_QTY, na: na || it.na === true || naPick || (!!pick && pick.section === "newArrivals"),
    ...(naPick ? { src: "na" } : {}),
    photo: it.photo || null, shown: naPick ? pick.shown : gen ? gen.url : (it.photo || null),
    use: naPick ? (pick.useCurrent ? "current" : "generated") : sig === "current" ? "current" : "generated", genId: photo && photo.genId ? photo.genId : null, sig,
    generatedUrl: latest ? latest.url : null, aiGenId: aiId, generations: Object.values((photo && photo.gens) || {}).filter((g) => g && g.url && !isSourceGen(g)).length,
    // His own photo (Replace photo / Find online): what Generate starts from; shownFrom says what the row shows.
    srcId: source ? source.id : null, srcUrl: source ? source.url : null, srcFrom: source ? source.src : null,
    shownFrom: naPick ? "na" : gen ? (isSourceGen(gen) ? gen.src : "ai") : "app",
    gallery: galleryOf(it.photo || null, photo, { extra: naPick && pick.shown && pick.shown !== it.photo ? [{ id: "na", url: pick.shown, label: "Approved in New Arrivals" }] : [] }),
    noPrice: !hasPrice(postPrice),
    generating: !!(photo && photo.generating && nowMs - Number(photo.generating.at) < sched.CLAIM_MS),
    // Kept for older screens only: Generate is offered on EVERY product whatever its kind (Junid, 20 Nov 2026).
    styleApproved: ESTABLISHED_STYLES.includes(kind) || !!(styles[kind] && styles[kind].approvedAt), canGenerate: true,
    // The last Generate failed (photos/{pid}/failed, set by bfGenerate; the next success clears it).
    failed: photo && photo.failed && photo.failed.at ? { at: photo.failed.at, reason: String(photo.failed.reason || "") } : null,
    tab: approved ? "approved" : "review",
    changedSinceApproval: !!pick && pick.state === "approved" && !approved,
    posted: approved && postedFor(pick, posted) ? (posted.at || true) : null,
    // The permanent posting record (the brain's brain/sent/{pid}): how many times and when last; a Repost queued since.
    ...postingOf(sent, repost, posted),
  };
}
/** "Posted n× · last <date>" and a Repost waiting for the next slot. Pure. */
function postingOf(sent, repost, posted) {
  const n = Number(sent && sent.n) || 0;
  const last = Number(sent && sent.last) || (posted && Number(posted.at)) || null;
  const postedN = n || (last ? 1 : 0);
  const queued = !!(repost && Number(repost.at) > 0 && (!last || Number(repost.at) > last));
  return { postedN, postedLast: postedN ? last : null, repostQueued: queued };
}

/** MAIN order: every 30+ product first (one block, highest first), then 13–29 (highest first). UNDER: highest first. Pure. */
function orderRows(rows) {
  return [...rows].sort((a, b) => (Number(b.big) - Number(a.big)) || (b.qty - a.qty) || String(a.name).localeCompare(String(b.name)) || (a.pid < b.pid ? -1 : 1));
}

/**
 * The card for one section. node: { meta, items: { [section]: … }, picks, photos, posted, styles, stats, schedule }.
 * Rejected products are never listed (only in the small "Rejected (n)" list). Pure.
 */
function viewSection(node, section = "main", { postingPaused = false, nowMs = Date.now(), extraApproved = {}, naSet = null, naRows = [] } = {}) {
  const n = node || {};
  // extraApproved: approved products with no row in this section (the other section's, or a New Arrival
  // uploaded after the build) — so the Approved tab always shows every approval.
  const items = { ...extraApproved, ...(((n.items || {})[section]) || {}) };
  const picks = n.picks || {}, photos = n.photos || {}, posted = n.posted || {}, styles = n.styles || {};
  const sent = (n.brain && n.brain.sent) || {}, reposts = n.repost || {};
  const isNa = (pid) => !!(naSet && naSet.has(pid));
  const rows = [];
  for (const [pid, it] of Object.entries(items)) {
    if (!it || isRejected(picks[pid])) continue;
    const row = viewItem(pid, it, { pick: picks[pid], photo: photos[pid], posted: posted[pid], styles, nowMs, sent: sent[pid], repost: reposts[pid], na: isNa(pid) });
    // A product that is both new and 13+ is reviewed ONLY on the New Arrivals tab.
    if (row.tab === "review" && isNa(pid)) continue;
    rows.push(row);
  }
  const ordered = orderRows(rows);
  const m = n.meta || {};
  const idx = n.idx || null;
  const live = (pid) => !idx || !!idx[pid] || isNa(pid);
  const rejected = Object.entries(picks).filter(([pid, p]) => isRejected(p) && live(pid)).map(([pid, p]) => ({ pid, name: p.name || pid, section: p.section || null, at: p.at || null, ...(p.src === "na" ? { src: "na" } : {}) }))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  const review = ordered.filter((r) => r.tab === "review" && !extraApproved[r.pid]);
  const approved = ordered.filter((r) => r.tab === "approved");
  const totals = totalsOf(n, picks, photos);
  // Approved with no price: held back from posting (the poster skips them too) and listed for Junid.
  totals.noPriceApproved = approved.filter((r) => r.noPrice).length;
  if (section === "main") { totals.review = review.length; totals.approved = approved.length; }
  totals.newArrivals = naRows.length;
  totals.approvedNa = approved.filter((r) => r.na).length;
  totals.approvedNormal = approved.length - totals.approvedNa;
  return {
    section,
    newArrivals: naRows,
    review,
    approved,
    totals,
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
    if (!hasPrice(item && item.price)) { out.refusal = NO_PRICE; return undefined; }
    const g = sig === "current" ? null : photo.gens[sig];
    const shown = sig === "current" ? (item.photo || null) : ((g && g.url) || null);
    if (cur && cur.state === "approved" && cur.sig === sig && cur.shown === shown) { out.noop = true; return undefined; }
    return { state: "approved", sig, shown, at: nowMs, by: uid || null, section, price: item.price, kind: item.kind || "clothing", name: item.name || "", sizes: item.sizes || "",
      // Which photo was approved: the app's, an AI photo, or his own (upload / web).
      photoFrom: !g ? "app" : isSourceGen(g) ? g.src : "ai" };
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
function useMutator({ use, genId = null, app = false }, out = {}) {
  return (cur) => {
    const p = cur || {};
    if (use === "current") {
      // "Use app photo": the app's own photo again, and Generate starts from it again (his photos stay kept).
      if (app && p.srcId) { const { srcId, ...rest } = p; return { ...rest, use: "current" }; } // eslint-disable-line no-unused-vars
      if (p.use !== "generated") { out.noop = true; return undefined; }
      return { ...p, use: "current" };
    }
    const id = genId || p.genId;
    if (!id || !p.gens || !p.gens[id]) { out.refusal = "there is no generated photo for it yet — tap Generate"; return undefined; }
    if (p.use === "generated" && p.genId === id) { out.noop = true; return undefined; }
    // Choosing one of his own photos also makes it the source Generate starts from.
    return { ...p, use: "generated", genId: id, ...(isSourceGen(p.gens[id]) ? { srcId: id } : {}) };
  };
}
/**
 * His own photo arrives (Replace photo / Find online): kept in gens, made the
 * source, and shown — unless the product is approved now (keepChoice): then
 * the approved photo keeps posting until he picks the new one. On photos/{pid}. Pure.
 */
function addSourceMutator({ id, entry, keepChoice = false }, out = {}) {
  return (cur) => {
    const p = cur || {};
    if (p.gens && p.gens[id]) { out.noop = true; return undefined; }
    const next = { ...p, gens: { ...(p.gens || {}), [id]: entry }, srcId: id };
    if (!keepChoice) { next.use = "generated"; next.genId = id; }
    return next;
  };
}
/** The permanent approval record (approvals/{pid}/{at}): product, the exact photo approved, when, by whom. Pure. */
function approvalRecord(pid, pick) {
  if (!pick || pick.state !== "approved") return null;
  const r = { pid, at: Number(pick.at) || null, by: pick.by || null, photo: pick.shown || null, sig: pick.sig || null, name: pick.name || "", price: pick.price ?? null, kind: pick.kind || null, section: pick.section || null, ...(pick.src ? { src: pick.src } : {}) };
  for (const [k, v] of Object.entries(r)) if (v === null || v === undefined) delete r[k];
  return r;
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
    if (!hasPrice(p.price)) continue; // no price, no post
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
  ROOT, PID_RE, GEN_RE, SIG_OK, KIND_RE, SECTIONS, BIG_QTY, ALBUM_MAX, CAPTION_MAX, ESTABLISHED_STYLES, KIND_LABEL,
  priceLabel, priceKey, captionPreview, sigOf, isApproved, isRejected, postedFor,
  hasPrice, NO_PRICE, isSourceGen, latestAiId, sourceOf, galleryOf, addSourceMutator,
  viewItem, postingOf, orderRows, viewSection, totalsOf, planView, approvalRecord,
  approveMutator, rejectMutator, resetMutator, restoreMutator, useMutator, withRev,
  toPost, albumsOf, planAlbums, fnv,
  ...sched,
};
