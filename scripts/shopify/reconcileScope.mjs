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
//   not the primary path. The window is 01:00–07:00 SAST, measured from the
//   mini's own log (18 Aug – 4 Sep) and NOT assumed from trading hours — see
//   NIGHT_START_HOUR below, where the measurement is set out. 23:00 and 00:00
//   look like night and are two of the busiest publishing hours, so they get
//   the daytime cadence.
//
// State lives at /shopify_sync/_reconcile. /shopify_sync is `.read: false,
// .write: false` in the live rules — server-only, which is exactly right for a
// bookkeeping node no browser should see, and the Admin SDK bypasses rules.
// The `_` prefix follows the existing `_collections` sibling.
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { shallowKeys } from "../lib/rtdbPaged.mjs";

export const RECONCILE_STATE_PATH = "shopify_sync/_reconcile";

// How far BEFORE the recorded watermark an incremental window starts.
//
// A SKEW ALLOWANCE, NOT A JITTER ALLOWANCE — that distinction is why this is an
// hour and not the five minutes it started as. The reconciler's own clock is
// server-corrected now (reconcile.mjs, `serverNowMs`), so the two sides of the
// comparison share a domain. The remaining gap is on the WRITING side, and
// src/utils/serverTime.js names its own limits: the offset is measured once at
// the socket handshake and never resynced, so a device whose clock changes
// mid-session keeps a stale correction, and a press before the handshake
// completes stamps the raw device clock.
//
// That hole is ASYMMETRIC, which is the useful part. A device running FAST
// stamps `updatedAt` in the future: the row sits inside every window from now
// on and costs a microsecond in the desired-vs-confirmed test. A device running
// SLOW stamps it in the PAST, behind the bound, and the window never sees it —
// the press then waits for the next full scan (30 min, 3 h overnight) instead
// of two minutes. Nothing is lost either way; what is lost is the two-minute
// promise, silently.
//
// So the overlap is sized for a wrong clock rather than for a slow write. An
// hour covers every plausible client skew — a tablet on the wrong timezone
// offset is the realistic case — and costs almost nothing: the extra rows are
// the handful of nodes touched in the preceding hour (~20 × 696 B ≈ 14 KB on a
// busy evening), every one discarded immediately. Trading 14 KB for the
// difference between two minutes and three hours is not a close call.
export const WATERMARK_OVERLAP_MS = 60 * 60 * 1000;

// SEPARATE FROM THE OVERLAP, because they are different questions that only
// shared a name. The overlap asks "how far back should the window reach to
// survive a wrong clock on the WRITING side"; this asks "how far into the
// future may a stored watermark be before it is corruption rather than skew".
//
// They were the same constant until the overlap was widened to an hour for the
// first question — which silently widened the second by 12x, so a watermark up
// to an hour ahead was accepted as ordinary instead of triggering an immediate
// full scan. Nothing could be MISSED either way (`since = watermark - overlap`
// is still <= now), but the band of corrupt values that produce a near-empty
// window instead of instant recovery grew from five minutes to an hour, and
// recovery leaned on the full-scan cadence instead. Five minutes here is the
// tolerance that was actually reasoned about.
export const WATERMARK_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

// Full-scan cadence. Daytime is the drift-repair interval the search-index
// sweep was really written for; overnight it backs off because there is
// nothing to drift from — no one is publishing.
export const FULL_SCAN_DAY_MS = 30 * 60 * 1000;
export const FULL_SCAN_NIGHT_MS = 3 * 60 * 60 * 1000;

// SAST boundaries of "overnight" — the window in which drift repair backs off.
// Set from the mini's own log (18 Aug – 4 Sep, ~7,000 ticks), NOT from an
// assumption about trading hours, because the two disagree.
//
// 01:00–06:00 is genuinely dead: of 165 ticks in that window carrying any
// unapplied intent, 164 reported exactly FIVE — the constant floor of a stuck
// record set, not work. One tick in ~800 carried real intent.
//
// 23:00 IS NOT. It is the single BUSIEST publishing hour measured, in both the
// stuck and the pre-stuck period, and its intent counts are a genuine spread
// (1,2,3,4,5,6,7,8,9,11,16) rather than a flat floor. 00:00 is active too.
// An earlier draft of this file started the night at 23:00 and justified it as
// "narrower than the measured dead window" — which was the opposite of true at
// its own start boundary: it backed drift repair off 6× at the exact hour with
// the most work to repair. The window now matches what was measured.
//
// The cost of the correction is ~3.3 extra full scans a night (23:00–01:00 at
// the 30-minute cadence instead of the 3-hour one), ~9.7 MB/night, ~$0.29 a
// month — against a ~$93/month saving, for the backstop being awake during
// peak publishing.
export const NIGHT_START_HOUR = 1;
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

// The window is [NIGHT_START_HOUR, NIGHT_END_HOUR) in SAST. It is written to
// survive BOTH shapes, because the boundaries are measured numbers and a later
// measurement may move them back across midnight: a window that wraps (start >
// end, e.g. 23→7) is the OR of its two halves, one that does not (start < end,
// e.g. 1→7) is the AND. The single `>= start || < end` form the earlier draft
// used is only correct for the wrapping shape — with start=1 it is true for
// every hour of the day, which would have put the loop on the 3-hour drift
// cadence permanently and silently.
export function isOvernight(nowMs) {
  const h = sastHour(nowMs);
  return NIGHT_START_HOUR > NIGHT_END_HOUR
    ? (h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR)
    : (h >= NIGHT_START_HOUR && h < NIGHT_END_HOUR);
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
  if (watermark > nowMs + WATERMARK_FUTURE_TOLERANCE_MS) {
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

// ── Remove a stale ID map, and ONLY if it is still the one we checked ────────
// The deleted-product path proves a Shopify product is gone and then clears the
// record's mapping. Between the proof and the delete the record can be
// re-adopted onto a live product (round-trip.mjs and adopt.mjs both do that by
// hand, outside the scheduled run's single-flight lock), so the condition and
// the delete have to be ONE operation.
//
// The verdict comes from `result.committed`, never from a flag set inside the
// callback. RTDB may invoke that callback more than once — the first time
// against a local cache — so a flag set on an early invocation survives into an
// outcome that later aborted. An earlier version of this did exactly that and
// was wrong in both directions:
//
//   · a COLD cache aborted on the first invocation, and an abort is one-shot —
//     the server is never consulted. The flag stayed false, the caller reported
//     "changed mid-run", and the stale mapping was never removed: the same tick
//     repeated every two minutes for ever, which is the 1,367-tick loop this
//     branch exists to end;
//   · a WARM BUT STALE cache matched on the first invocation and set the flag,
//     the real value then aborted the transaction, and the flag survived. The
//     caller confirmed the record OFF on a removal that had not happened —
//     leaving a live, published product with the system recording it as off.
//
// AND IT NEVER ABORTS, which is the part a "confirm the abort with a read"
// retry could not deliver. The first version of this function aborted whenever
// the local value did not match, then read the server and retried "against a
// warmed cache". There is no such warming. Checked against the SDK actually
// installed here (@firebase/database, index.node.cjs.js):
//
//   · `runTransaction` attaches a value listener and then IMMEDIATELY runs the
//     callback against `repoGetLatestState()` — the local cache, synchronously,
//     before any server data can arrive. On `undefined` it calls
//     `transaction.unwatcher()` and completes with committed=false. The server
//     is never asked (index.node.cjs.js:14381, 11633-11643).
//   · `get()` does NOT leave the value behind to warm it. `repoGetValue` adds a
//     registration, applies the server overwrite, and then calls
//     `syncTreeRemoveEventRegistration` — "only active queries are cached", and
//     after the read there is no active query (11364-11400).
//
// So on a fresh process — which is EVERY tick, launchd spawns a new node — the
// callback saw `cur == null`, aborted, read the server, saw the gid still
// there, retried, saw `null` again, and returned "changed". The caller then
// declined to confirm off, the pid went back in the retry set, and the same
// futile unpublish went out every two minutes for ever: the exact 1,367-tick
// loop this branch exists to end, rebuilt inside its own fix.
//
// The rule that actually holds, and the one ensureClaimIndex's backfill in
// idMap.mjs already followed: AN ABORT MUST BE UNREACHABLE FROM `cur == null`.
// Returning `cur` instead writes the value back unchanged, which forces the
// server round trip and re-invokes the callback with the real value. It is the
// property releaseClaim's comment calls "accidentally safe" — it is not an
// accident, it is the only mechanism RTDB gives you.
//
// The verdict then comes from the COMMITTED SNAPSHOT, not from `committed`
// alone and not from a flag: after a removal the node is gone, after a decline
// it still holds someone else's mapping.
//
// AN ALREADY-ABSENT NODE IS ITS OWN ANSWER, not "removed". A first version of
// this collapsed the two, reasoning that there is no mapping left so confirming
// off is correct, and that answering otherwise would make the caller retry for
// ever. The second half was simply false — the caller would finish on the NEXT
// tick, where `mapNode.shopifyProductId` is absent and the record confirms off
// through its own branch — so the collapse bought one tick.
//
// What it cost is a divergence, through a window the strict version closed.
// Someone repairing a bad mapping by hand does `delete /shopify_sync/{pid}`
// and then re-adds it, outside this loop's single-flight lock, which is what
// round-trip.mjs, adopt.mjs and the console are all for:
//
//   1. the tick reads mapNode (old gid) and Shopify says that product is gone;
//   2. the person deletes /shopify_sync/{pid};
//   3. this sees `cur == null` and, collapsed, answers "removed";
//   4. the caller confirms the record OFF and unindexes it;
//   5. the person's re-adoption onto a LIVE product lands.
//
// The record now maps a live, published product while /shopify_publish records
// it off with its intent satisfied, so no later tick revisits it. That is the
// divergence this branch is not allowed to cause, traded for one tick.
//
//   → "removed"   the mapping this run checked was there, and is now gone
//     "changed"   the record maps something else — do NOT confirm off
//     "absent"    there was no mapping to remove; also do NOT confirm off, and
//                 the next tick resolves it through the no-mapping branch
//     "contended" the write did not land (see below) — nothing changed
export async function removeMappingIfUnchanged(db, productId, expectedGid) {
  assertSafeSegment(productId, "productId");
  const ref = db.ref(`shopify_sync/${productId}`);
  // The latch is legitimate here for the same reason it is in releaseClaim: with
  // no abort, the callback's last invocation is the committed one. It only ever
  // separates two outcomes that BOTH commit with the node absent, and the
  // verdict that could cost something ("changed") is read off the snapshot.
  let sawAbsent = false;
  const res = await ref.transaction((cur) => {
    sawAbsent = cur == null;
    return (cur == null || cur.shopifyProductId === expectedGid) ? null : cur;
  });
  // Belt and braces: with nothing returning `undefined`, a resolved
  // committed:false is unreachable — the SDK REJECTS on max-retry, permission
  // and disconnect (repoRerunTransactionQueue resolves committed:false only for
  // abortReason "nodata", i.e. a callback that returned undefined). So the real
  // failure here is a THROW, which the caller's per-product catch turns into
  // "retry next tick". This branch is kept because it costs nothing, not
  // because it is expected.
  if (!res.committed) return "contended";
  if (res.snapshot.val() != null) return "changed";
  return sawAbsent ? "absent" : "removed";
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
