// ── Reconcile scope: read what CHANGED, not the whole node ───────────────────
// The Mac mini runs `reconcile.mjs --commit` every two minutes, 24/7 (launchd
// `com.marathon.shopifyreconcile`, installed 14 Aug 2026). Until this module
// existed, every one of those ~720 daily ticks read the whole of
// /shopify_publish TWICE — once to build the worklist, once more at the end so
// the search-index sweep could learn which products are live. The node is
// 1.9–2.2 MB. That is ~3.1 GB/day of RTDB download, measured at 45–79% of ALL
// traffic in the database in every profiler hour captured on 3 Sep
// (docs/SHOPIFY-SYNC.md §9; the underlying capture is docs/bandwidth-capture-sept.md,
// which arrives with PR #550), for a shop where the overwhelming majority
// of ticks have nothing to do.
//
// Nothing here changes WHAT the reconciler publishes. It changes only how it
// finds the work:
//
//   WATERMARK. The page stamps `updatedAt` on every write that expresses
//   intent (shopifyPublishStore.js `stamp()`), so a node whose intent changed
//   since the last run is a node whose `updatedAt` moved. An incremental tick
//   asks for exactly those, with an overlap window for clock skew, instead of
//   asking for all of them.
//
//   THE WATERMARK IS NOT TRUSTED ALONE. Three backstops, because a missed
//   intent is a product that silently never publishes:
//     · a FULL scan on a fixed cadence (and always on the first run after the
//       state node is lost), so anything the query could not see — a node with
//       no `updatedAt` at all, a write that landed with a skewed clock, an
//       index that was never pasted — is picked up within one cadence;
//     · a RETRY SET: a product whose apply FAILED usually leaves the node
//       untouched (the reconciler only writes once Shopify agrees), so its
//       `updatedAt` does not move and the next window would not see it. Failed
//       pids are remembered by id and read individually every tick until they
//       succeed;
//     · the watermark only advances to the moment the run STARTED, never to
//       "now" — anything written while the run was in flight lands in the next
//       window rather than being stepped over.
//
//   IT DEGRADES TO TODAY'S COST, NEVER WORSE. The incremental query needs
//   `.indexOn: ["state", "updatedAt"]` on /shopify_publish; live rules today
//   carry only "state". RTDB does NOT quietly sort an unindexed query
//   server-side — it REFUSES it outright ("Index not defined, add
//   .indexOn: \"updatedAt\"..."), verified against the live database on
//   3 Sep 2026. So the refusal is caught and the tick falls back to the whole-
//   node scan it did before: correct, at exactly the old price, and LOUD about
//   why. Paste the index (docs/SHOPIFY-SYNC.md §9.1) and the saving lands with
//   no code change.
//
//   CADENCE APPLIES TO THE EXPENSIVE PART, NOT THE TICK. The tick stays at two
//   minutes: a publish pressed at 23:40 must still go out at 23:42. What backs
//   off overnight is the full scan and the search-index sweep — drift repair,
//   not the primary path. Measured from the mini's own log (18 Aug – 3 Sep),
//   genuine intent between 01:00 and 08:00 SAST is essentially nil; every
//   overnight "working" tick in that window was a stuck retry.
//
// State lives at /shopify_sync/_reconcile. /shopify_sync is `.read: false,
// .write: false` in the live rules — server-only, which is exactly right for a
// bookkeeping node no browser should see, and the Admin SDK bypasses rules.
// The `_` prefix follows the existing `_collections` sibling.
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { shallowKeys } from "../lib/rtdbPaged.mjs";

export const RECONCILE_STATE_PATH = "shopify_sync/_reconcile";

// How far BEFORE the recorded watermark an incremental window starts. Covers
// the gap between a browser's `serverNowMs()` stamp and the moment the write
// lands, plus any residual skew. Cheap insurance: the extra rows a five-minute
// overlap returns are a handful, and every one of them is skipped in a
// microsecond by the desired-vs-confirmed test.
export const WATERMARK_OVERLAP_MS = 5 * 60 * 1000;

// Full-scan cadence. Daytime is the drift-repair interval the search-index
// sweep was really written for; overnight it backs off because there is
// nothing to drift from — no one is publishing.
export const FULL_SCAN_DAY_MS = 30 * 60 * 1000;
export const FULL_SCAN_NIGHT_MS = 3 * 60 * 60 * 1000;

// SAST boundaries of "overnight". 23:00–07:00 is deliberately wider than the
// shop's trading day and narrower than the measured dead window (01:00–08:00),
// so a late evening publish and an early morning one both still get the day
// cadence.
export const NIGHT_START_HOUR = 23;
export const NIGHT_END_HOUR = 7;

// How many failed products the retry set will carry. A failure that outlives
// 50 newer ones is not a transient and needs a person; the full scan still
// sees it, so nothing is lost, it is just no longer read every two minutes.
export const MAX_RETRY_PIDS = 50;

// South Africa is UTC+2 all year — no DST, ever. Doing the arithmetic rather
// than reaching for Intl keeps this a pure function that a unit test can drive
// with a fixed epoch.
export function sastHour(nowMs) {
  return Math.floor(((nowMs / 3600000) + 2) % 24);
}

export function isOvernight(nowMs) {
  const h = sastHour(nowMs);
  return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR;
}

export function fullScanIntervalMs(nowMs) {
  return isOvernight(nowMs) ? FULL_SCAN_NIGHT_MS : FULL_SCAN_DAY_MS;
}

// ── The one decision this module exists to make ──────────────────────────────
// Given the persisted state and the clock, is this tick a full scan or an
// incremental one, and from when? Pure, so every branch is a unit test.
//   → { mode: "full" | "incremental", since: number|null, why: string }
export function planScan({ state, nowMs, force = false }) {
  if (force) return { mode: "full", since: null, why: "--full" };
  const watermark = Number(state?.watermark);
  if (!Number.isFinite(watermark) || watermark <= 0) {
    return { mode: "full", since: null, why: "no watermark recorded" };
  }
  const lastFull = Number(state?.lastFullScanAt) || 0;
  const due = fullScanIntervalMs(nowMs);
  if (nowMs - lastFull >= due) {
    return { mode: "full", since: null, why: `full scan due (${Math.round(due / 60000)} min cadence)` };
  }
  // A watermark from the FUTURE is not a valid window: fall back to a full scan
  // rather than silently skipping everything.
  //
  // Be honest about what this catches. `nowMs` is the reconciler's own clock —
  // the same clock that wrote the watermark — so this sees a discontinuous jump
  // (a corrupted state write, a clock stepped backwards, a state node restored
  // from an older copy) and NOT a steady skew, where both sides drift together
  // and the comparison stays true. Steady skew is covered instead by the thing
  // that does not depend on the clock at all: the full-scan cadence, which
  // bounds the worst case at 30 minutes by day and 3 hours overnight no matter
  // what the clock believes.
  if (watermark > nowMs + WATERMARK_OVERLAP_MS) {
    return { mode: "full", since: null, why: "watermark is ahead of this machine's clock" };
  }
  return { mode: "incremental", since: watermark - WATERMARK_OVERLAP_MS, why: "watermark" };
}

// Retry bookkeeping. `failedPids` are this run's failures; `state.retry` is the
// map carried between runs ({pid: firstFailedAt}). Succeeded/withdrawn pids
// drop out. Pure so the trimming rule is testable.
export function nextRetrySet({ previous = {}, attempted = [], failedPids = [], nowMs }) {
  const next = {};
  for (const [pid, at] of Object.entries(previous || {})) {
    // Anything we tried this run and did NOT fail is resolved — drop it.
    if (attempted.includes(pid) && !failedPids.includes(pid)) continue;
    next[pid] = Number(at) || nowMs;
  }
  for (const pid of failedPids) if (next[pid] == null) next[pid] = nowMs;
  const keys = Object.keys(next);
  if (keys.length <= MAX_RETRY_PIDS) return next;
  // Keep the NEWEST failures: an old one is a standing problem the full scan
  // will keep surfacing anyway, and it must not crowd out today's.
  const kept = keys.sort((a, b) => next[b] - next[a]).slice(0, MAX_RETRY_PIDS);
  const trimmed = {};
  for (const pid of kept) trimmed[pid] = next[pid];
  return trimmed;
}

// ── The watermark must not step over work the cap did not reach ─────────────
// A tick applies at most MAX_APPLY products. Everything else in the worklist is
// deferred — and a deferred node's `updatedAt` did NOT move, so the next window
// would only contain it if the watermark stays behind it.
//
// It used to be carried in the retry set instead, which failed at scale in two
// ways at once. The retry set is capped at MAX_RETRY_PIDS, so a backlog larger
// than the cap plus the retry cap was simply dropped and left to the next full
// scan — up to 3 hours overnight, against 2 minutes before this branch. And
// because the trim keeps the NEWEST entries and every deferred pid shares one
// timestamp, a single bulk deferral evicted every standing failure from the
// retry set at a stroke.
//
// Holding the watermark fixes both, and is the more honest mechanism: the
// watermark's whole job is to say "everything before here is done", and while a
// deferred node exists that is not true. The window re-returns the backlog each
// tick and it drains MAX_APPLY at a time, which is exactly what happened before
// the branch. Retry pids are excluded from the calculation — their `updatedAt`
// is by definition stale, so letting one drag the watermark back would widen
// every subsequent window for as long as it kept failing. Those stay in the
// retry set, which is what it is for.
export function nextWatermark({ runStartedAt, unapplied = [], previousWatermark = null }) {
  if (!unapplied.length) return runStartedAt;
  const stamps = unapplied.map((n) => Number(n?.updatedAt));
  // A node with no usable `updatedAt` cannot be located by any window. Do not
  // advance at all rather than guess a bound that might step over it; a null
  // previous watermark means the next tick takes a full scan, which is the
  // correct, expensive, safe answer.
  if (stamps.some((t) => !Number.isFinite(t))) return previousWatermark;
  // One millisecond before the oldest unfinished node, so that node is inside
  // the next window rather than exactly on its edge.
  return Math.min(runStartedAt, Math.min(...stamps) - 1);
}

// The refusal above, recognised. Matched on the two things RTDB always says —
// "index" and the field name — rather than on the whole sentence, which is a
// library string and not a contract.
export function isMissingIndexError(err, field) {
  const m = String(err?.message || err).toLowerCase();
  return m.includes("index") && m.includes(String(field).toLowerCase());
}

// ── RTDB readers ─────────────────────────────────────────────────────────────

// METERED like every other read. It is small, but an idle tick is now mostly
// THIS read, so leaving it out would make the loop's own "rtdb read this run"
// line under-report the very number this work exists to report. A meter that
// quietly omits the biggest remaining item is worse than no meter.
export async function readReconcileState(db, { meter = () => {} } = {}) {
  const val = (await db.ref(RECONCILE_STATE_PATH).get()).val() || null;
  meter("shopify_sync/_reconcile (scan state)", val);
  return val;
}

export async function writeReconcileState(db, patch) {
  await db.ref(RECONCILE_STATE_PATH).update(patch);
}

// The scoped worklist read. Returns the SAME shape readAllPublishNodes does —
// a plain {pid: node} map — so every caller downstream is unchanged.
//
// `meter` is called with each snapshot value so the run can report what it
// actually cost; bandwidth this loop spends is the whole point of the module.
export async function readChangedPublishNodes(db, { since, retryPids = [], meter = () => {}, onUnreadable = () => {} }) {
  const q = db.ref("shopify_publish").orderByChild("updatedAt").startAt(since);
  const snap = await q.get();
  const val = snap.val() || {};
  meter("shopify_publish (updatedAt window)", val);
  const nodes = { ...val };
  // A failed product's node was not written, so its updatedAt did not move and
  // the window above cannot contain it. Read those by id — one small read each,
  // bounded by MAX_RETRY_PIDS.
  //
  // ONE FLAKY POINT READ MUST NOT COST THE WHOLE TICK. Without the catch, a
  // transient error on any single retry pid propagates out of here, is not a
  // missing-index error, and takes down the entire run — including all the
  // work the window already found and could have applied. It also matters that
  // the caller HEARS about it: an unreadable pid was not evaluated, and the
  // caller counts evaluated retry pids as attempted, so a silent skip would
  // drop it from the retry set and it would never be tried again.
  for (const pid of retryPids) {
    if (nodes[pid] !== undefined) continue;
    assertSafeSegment(pid, "productId");   // a bad id is a bug, not a blip
    try {
      const one = (await db.ref(`shopify_publish/${pid}`).get()).val();
      meter(`shopify_publish/${pid} (retry)`, one);
      if (one) nodes[pid] = one;
    } catch (e) {
      onUnreadable(pid, e);
    }
  }
  return nodes;
}

// The live set the search-index sweep needs. `.indexOn: ["state"]` is ALREADY
// on /shopify_publish in the live rules, so this query is server-indexed today
// and downloads only the live nodes rather than the whole node. liveState is
// filtered here because the index is on `state` alone.
export async function readLivePids(db, { meter = () => {} } = {}) {
  let snap;
  try {
    snap = await db.ref("shopify_publish").orderByChild("state").equalTo("live").get();
  } catch (e) {
    // `state` has been indexed for a long time, so this query is safe today.
    // The reason it gets a guard anyway is that §9.1 asks a person to paste an
    // index into the console by hand, and the plausible slip is REPLACING
    // ["state"] with ["updatedAt"] rather than adding to it. That takes the
    // index this query depends on away, and without this branch the failure
    // would be one generic warning line per tick while the search index rots
    // indefinitely — and the publishing page's own `state` queries break too,
    // with nothing connecting the two symptoms to the paste that caused them.
    if (isMissingIndexError(e, "state")) {
      throw new Error(
        'the "state" index is GONE from /shopify_publish — the console rules ' +
        'must list BOTH: ".indexOn": ["state", "updatedAt"]. If "updatedAt" was ' +
        'just pasted, it replaced "state" instead of joining it. The search ' +
        'index cannot be repaired until this is put back'
      );
    }
    throw e;
  }
  const val = snap.val() || {};
  meter("shopify_publish (state=live)", val);
  return Object.entries(val).filter(([, n]) => n?.liveState === "on").map(([pid]) => pid);
}

// ── Location keys, resolved ONCE ─────────────────────────────────────────────
// reconcile.mjs used to do `Object.keys((await db.ref("stock").get()).val())`
// for EVERY product it published — 6,204,009 measured bytes to learn ten
// strings that change perhaps once a year. A shallow REST read returns exactly
// the same key set (that is what shallow means) for a few hundred bytes, and
// the result is memoised for the life of the process.
//
// Deliberately NOT /locations: this must be the key set /stock is actually
// keyed by, and proving those two agree is not this fix's job. Shallow on the
// same path is the same answer by construction.
export function makeStockLocationResolver(adminApp, { meter = () => {} } = {}) {
  let cached = null;
  return async function stockLocationKeys() {
    if (cached) return cached;
    const keys = await shallowKeys(adminApp, "stock");
    meter("stock (shallow keys)", keys);
    cached = keys;
    return cached;
  };
}
