// ─── BLACK FRIDAY 2026 — THE CARD'S PRECOMPUTED LIST (Junid, 21 Nov 2026) ────
// Junid waited 5–9 seconds every time he opened the card on his iPhone: each
// open asked bfCampaignList to read every campaign node (items, picks, photos,
// posted, the New Arrivals window …) and send 1.7 MB back. Now the server keeps
// the card's list ready, already split into what the first screen needs and
// pages for the rest:
//   cardIndex/main/head          JSON { at, pageSize, counts, first: { tab: [page 0] },
//                                       totals, rejected, styles, schedule, plan,
//                                       postingPaused, meta }
//   cardIndex/main/pages/{tab}/{i}  JSON { at, rows: [PAGE rows] }   (tab: newArrivals|review|approved)
//   cardIndex/main/at            when the list was computed (the build's start)
//   cardIndex/dirtyAt            the last change seen in the campaign's data
//   cardIndex/lease              { until } — one rebuild at a time
// KEPT UP TO DATE BY THE SERVER: a write to picks/{pid}, photos/{pid},
// items/{section}/{pid}, repost/{pid}, brain/sent/{pid}, posted/{pid}, web/{pid} or a New
// Arrivals status marks the list dirty and rebuilds it once the burst settles
// (one at a time; changes that land during a rebuild get one more rebuild).
// Every 10 minutes bfCardIndexTick rebuilds a dirty list, or any list older than
// 30 minutes (what no trigger watches; a lost trigger).
// The rows are EXACTLY the rows bfCampaignList computes (list() in
// blackFriday.js) — this file reads nothing new and changes no campaign data:
// no generation, captions, posting, approvals or Signal Studio.
// Deploy BY NAME:
//   firebase deploy --only functions:bfCampaignList,functions:bfCardIndexPick,functions:bfCardIndexPhoto,functions:bfCardIndexItem,functions:bfCardIndexRepost,functions:bfCardIndexSent,functions:bfCardIndexPosted,functions:bfCardIndexNa,functions:bfCardIndexWeb,functions:bfCardIndexTick
"use strict";

const { onValueWritten } = require("firebase-functions/v2/database");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const core = require("./core.cjs");

if (!admin.apps.length) {
  admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
}

const IDX = `${core.ROOT}/cardIndex`;
const TABS = Object.freeze(["newArrivals", "review", "approved"]);
const PAGE = 25;            // rows per page; page 0 of every tab rides in the head (the first screen)
const PAGES_MAX = 8;        // pages per request
const LEASE_MS = 120_000;   // a rebuild that died frees the lease after this
const MAX_ROUNDS = 4;       // rebuilds in a row while changes keep landing
const STALE_MS = 30 * 60 * 1000; // the tick rebuilds a clean list this old anyway (what no trigger watches)
const QUIET_MS = 2500;      // a rebuild waits until no change has landed for this long (a burst = one rebuild)…
const QUIET_MAX_MS = 15_000; // …but never longer than this
const SKEW_MS = 2000;       // a change this close before a rebuild's start counts as not in it (clocks differ)
/** Is the stored list older than the last change? Pure. */
const isDirty = (at, dirtyAt) => !at || Number(dirtyAt || 0) >= Number(at) - SKEW_MS;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

const val = async (db, path) => (await db.ref(path).once("value")).val();
const parse = (s) => { try { return typeof s === "string" ? JSON.parse(s) : null; } catch { return null; } };

/** The Approved tab in the order the card shows its blocks: no price, New Arrivals, Normal. Pure. */
function approvedInBlocks(rows) {
  const a = rows || [];
  return [...a.filter((r) => r.noPrice), ...a.filter((r) => r.na && !r.noPrice), ...a.filter((r) => !r.na && !r.noPrice)];
}

/** One list view (list("main")) → { head, pages: { tab: [json] }, at }. Pure. */
function splitView(v, at) {
  const lists = { newArrivals: v.newArrivals || [], review: v.review || [], approved: approvedInBlocks(v.approved) };
  const review = lists.review, approved = lists.approved;
  const counts = {
    newArrivals: lists.newArrivals.length,
    review: review.length,
    approved: approved.length,
    big: review.filter((r) => r.big).length,
    mid: review.filter((r) => !r.big).length,
    apprNoPrice: approved.filter((r) => r.noPrice).length,
    apprNa: approved.filter((r) => r.na && !r.noPrice).length,
    apprNormal: approved.filter((r) => !r.na && !r.noPrice).length,
  };
  const pages = {};
  for (const tab of TABS) {
    pages[tab] = [];
    for (let i = 0; i * PAGE < lists[tab].length; i++) pages[tab].push(JSON.stringify({ at, rows: lists[tab].slice(i * PAGE, (i + 1) * PAGE) }));
  }
  const head = {
    at, pageSize: PAGE, counts,
    first: Object.fromEntries(TABS.map((t) => [t, lists[t].slice(0, PAGE)])),
    section: "main", totals: v.totals || {}, rejected: v.rejected || [], styles: v.styles || {}, schedule: v.schedule || null,
    plan: v.plan || [], postingPaused: !!v.postingPaused, meta: v.meta || {},
  };
  return { head: JSON.stringify(head), pages, at };
}

/** Compute the list now and store it (one atomic write). → at */
async function build(db, nowMs) {
  const { list } = require("./blackFriday.js")._internals;
  const v = await list(db, "main", nowMs);
  const s = splitView(v, nowMs);
  const pages = Object.fromEntries(TABS.map((t) => [t, s.pages[t].length ? Object.fromEntries(s.pages[t].map((p, i) => [String(i), p])) : null]));
  await db.ref(`${IDX}/main`).set({ at: nowMs, head: s.head, pages });
  return nowMs;
}

/** Take the rebuild lease (null when another rebuild holds it). */
async function takeLease(db, nowMs) {
  const r = await db.ref(`${IDX}/lease`).transaction((cur) => (cur && Number(cur.until) > nowMs ? undefined : { until: nowMs + LEASE_MS, at: nowMs }));
  return r.committed ? r.snapshot.val() : null;
}
async function freeLease(db, lease) {
  // The first callback sees null (no local cache): answer null there, never undefined (that would abort unasked).
  await db.ref(`${IDX}/lease`).transaction((cur) => (cur === null ? null : lease && Number(cur.at) === Number(lease.at) ? null : undefined));
}

/**
 * Rebuild while the list is dirty, one rebuild at a time. A change that lands while another rebuild runs
 * is picked up by that rebuild: it re-reads dirtyAt after each build and once more after freeing the lease.
 * now: a clock (tests pass their own). → { built: n }
 */
async function refresh(db, { now = () => Date.now(), force = false, quietMs = QUIET_MS, sleep = sleepMs } = {}) {
  let built = 0;
  // Wait for a burst (a bulk approve, the 05:00 build) to settle, so it costs one rebuild, not one per write.
  const settle = async () => {
    for (let waited = 0; quietMs > 0 && waited < QUIET_MAX_MS; waited += 500) {
      const d = Number((await val(db, `${IDX}/dirtyAt`)) || 0);
      if (now() - d >= quietMs) return;
      await sleep(500);
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const lease = await takeLease(db, now());
    if (!lease) return { built, busy: true };
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const [at, dirtyAt] = await Promise.all([val(db, `${IDX}/main/at`), val(db, `${IDX}/dirtyAt`)]);
        if (!(force && built === 0) && !isDirty(at, dirtyAt)) break;
        await settle();
        await build(db, now());
        built++;
      }
    } finally { await freeLease(db, lease); }
    // A change that came in while the lease was held, after the last check: one more pass.
    const [at, dirtyAt] = await Promise.all([val(db, `${IDX}/main/at`), val(db, `${IDX}/dirtyAt`)]);
    if (isDirty(at, dirtyAt)) continue;
    break;
  }
  return { built };
}

/** Something the card shows changed: mark the list dirty and rebuild it. */
async function changed(db, nowMs = Date.now(), opts = {}) {
  await db.ref(`${IDX}/dirtyAt`).transaction((cur) => (Number(cur || 0) >= nowMs ? undefined : nowMs));
  return refresh(db, opts);
}

/** The first screen: counts and page 0 of every tab. Builds the list first if there is none yet. */
async function readHead(db) {
  let [head, dirtyAt] = await Promise.all([val(db, `${IDX}/main/head`), val(db, `${IDX}/dirtyAt`)]);
  let h = parse(head);
  if (!h) {
    await refresh(db, { force: true });
    [head, dirtyAt] = await Promise.all([val(db, `${IDX}/main/head`), val(db, `${IDX}/dirtyAt`)]);
    h = parse(head);
    if (!h) throw new Error("the card's list is being made — try again in a moment");
  }
  return { ...h, dirty: isDirty(h.at, dirtyAt) };
}

/** Pages [from, from + n) of one tab. → { tab, from, at, pages: [{ at, rows }] } (a missing page = past the end). */
async function readPages(db, tab, from, n) {
  if (!TABS.includes(tab)) throw Object.assign(new Error("Which tab?"), { code: "invalid-argument" });
  const f = Math.max(0, Math.floor(Number(from) || 0));
  const k = Math.max(1, Math.min(PAGES_MAX, Math.floor(Number(n) || 1)));
  // The pages are separate reads: a rebuild between them would mix two versions. Read again once; still
  // mixed → "rebuilt" (the card refreshes). A missing page ends the run (past the end of the tab).
  for (let tryNo = 0; tryNo < 2; tryNo++) {
    const raw = await Promise.all(Array.from({ length: k }, (_, i) => val(db, `${IDX}/main/pages/${tab}/${f + i}`)));
    const pages = [];
    for (const r of raw) { const p = parse(r); if (!p) break; pages.push(p); }
    // Past the end: the list's own version, so the card can tell "this tab ended" from "the list changed".
    if (!pages.length) return { tab, from: f, at: Number(await val(db, `${IDX}/main/at`)) || null, pages };
    if (pages.every((p) => p.at === pages[0].at)) return { tab, from: f, at: pages[0].at, pages };
  }
  return { tab, from: f, at: null, pages: [], rebuilt: true };
}

// ── what keeps it up to date ────────────────────────────────────────────────
// One instance at a time does the work (the lease); a burst (a bulk approve, the 05:00 build) only marks dirty.
const TRIGGER = { instance: "marathon-club-default-rtdb", region: "europe-west1", memory: "512MiB", cpu: 1, concurrency: 20, maxInstances: 3, timeoutSeconds: 300, retry: false };
/** The write's own time (so a change already inside a rebuild that started after it is not built twice). */
const eventMs = (event) => { const t = Date.parse(event && event.time); return Number.isFinite(t) ? t : Date.now(); };
const onChange = (ref) => onValueWritten({ ...TRIGGER, ref }, async (event) => {
  try { await changed(admin.database(), eventMs(event)); } catch (e) { console.error(`bfCardIndex (${ref}): ${e.message}`); }
});
const bfCardIndexPick = onChange(`/${core.ROOT}/picks/{pid}`);
const bfCardIndexPhoto = onChange(`/${core.ROOT}/photos/{pid}`);
const bfCardIndexItem = onChange(`/${core.ROOT}/items/{section}/{pid}`);
const bfCardIndexRepost = onChange(`/${core.ROOT}/repost/{pid}`);
const bfCardIndexSent = onChange(`/${core.ROOT}/brain/sent/{pid}`);
const bfCardIndexPosted = onChange(`/${core.ROOT}/posted/{pid}`);
// The New Arrivals tab is the New Arrivals queue: a new upload or a status change there changes it (a new
// New Arrivals photo with no status change shows within STALE_MS, or at once after his own Generate).
const bfCardIndexNa = onChange("/new_arrivals/items/{pid}/status");
// The website status on each approved row (the Mac mini's runner writes web/{pid} only when it changes).
const bfCardIndexWeb = onChange(`/${core.ROOT}/web/{pid}`);
const bfCardIndexTick = onSchedule({ schedule: "every 10 minutes", region: "europe-west1", memory: "512MiB", timeoutSeconds: 300, retryCount: 0 }, async () => {
  const db = admin.database();
  const [at, dirtyAt] = await Promise.all([val(db, `${IDX}/main/at`), val(db, `${IDX}/dirtyAt`)]);
  const old = !at || Date.now() - Number(at) > STALE_MS;
  if (old || isDirty(at, dirtyAt)) await refresh(db, { force: old });
});

module.exports = {
  bfCardIndexPick, bfCardIndexPhoto, bfCardIndexItem, bfCardIndexRepost, bfCardIndexSent, bfCardIndexPosted, bfCardIndexNa, bfCardIndexWeb, bfCardIndexTick,
  readHead, readPages,
  _internals: { isDirty, SKEW_MS, eventMs, splitView, approvedInBlocks, build, refresh, changed, takeLease, freeLease, readHead, readPages, PAGE, PAGES_MAX, TABS, IDX },
};
