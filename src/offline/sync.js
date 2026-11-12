// ─── OFFLINE MIRROR — the sync engine ────────────────────────────────────────
//
// Keeps the IndexedDB mirror (db.js) current from RTDB. Framework-free and
// fully injected — `adapter` is the transport (rtdbAdapter.js in production,
// a fake tree in tests), timers and clock likewise. That is the insightsLogStore
// precedent in this repo and the sync.js precedent on the tills.
//
// ── THE ONE RULE ────────────────────────────────────────────────────────────
//
// A node is read WHOLE exactly once per device, during setup. After that it is
// never read whole again. Everything below exists to make that true and to
// make it SAFE, which are different problems.
//
// ── TWO KINDS OF LEG ────────────────────────────────────────────────────────
//
// SNAPSHOT legs (eighteen of them) are read whole at setup, staged page by
// page so an interruption costs the pages not yet fetched rather than the ones
// already in hand, validated, and swapped over the live copy in ONE
// transaction. Afterwards they are maintained entirely by /mirror_changes.
//
// APPEND-ONLY legs (/stock_movements, /insights_log — 68 MB of the 104 MB
// between them) have no snapshot at all. Their setup download and their steady
// state are THE SAME forward walk from a stored cursor; setup is that walk
// starting from nothing. A part-finished download of an append-only node is a
// correct prefix of it, so there is nothing to stage and nothing to swap.
//
// ── EMPTY IS NOT SUCCESS ────────────────────────────────────────────────────
//
// This is the failure that cost the POS mirror a shop's worth of tills. A leg
// that reads zero rows from a node that cannot legitimately be empty records a
// FAILURE — no lastSyncAt, no swap, an explicit mirror.health.<leg> naming the
// path it asked for, and a throw. /products, /stock, /locations and /users are
// such nodes. /returns_log and /restock_log genuinely can be empty and are
// exempt, by name, in CAN_BE_EMPTY below — not by accident and not by
// inference from a row count.
//
// ── A SNAPSHOT MAY NEVER SHRINK QUIETLY ─────────────────────────────────────
//
// A live till held 799 of 4,665 products and reported ok with a row count that
// matched what was on disk. Every number agreed; the SET was a truncated
// prefix. So a snapshot swap asks health.js whether the incoming count is
// smaller than what is held by more than a rounding, and REFUSES if it is —
// keeping the last good copy readable while it does.
//
// ── AND A LEG THAT SAYS IT IS FINE MUST BE CHECKED AGAINST THE SERVER ───────
//
// Every guard above is local: it compares a read against what the device
// already had. None of them can see a change record that was never written,
// which is the one way this design can drift silently. The daily census
// (/mirror_counts, written by functions/mirrorChanges) is the outside opinion.
// A leg whose local count disagrees with it beyond the leg's tolerance records
// `count-drift` and downloads again. That is the completeness check, and it is
// the reason the census is computed from the database rather than from the
// trigger stream it is checking.

//
// ── …AND NOTHING MAY DOWNLOAD A LEG AGAIN AND AGAIN ─────────────────────────
//
// The paragraph above used to end the story, and it is how the fleet read
// 23 GB on 30 Oct 2026 and 7 GB on 10 Nov. The census is a day old; the device
// is not. On a day when a node legitimately moves further than the tolerance,
// EVERY device was told its healthy copy was wrong, downloaded it again, was
// told again by the same census, and downloaded it again — every few minutes,
// until the next census at 04:15. Nothing bounded it, because every bound in
// this file counted FAILURES and each of those downloads SUCCEEDED.
//
// Four things now stand between a disagreement and a download, in this order:
//
//   1. The comparison is made FAIR. The allowance is widened by the rows the
//      change feed has carried since the census was taken (censusJournal.js),
//      and nothing is compared until the feed has caught up.
//   2. A census is acted on ONCE per leg. The census taken at 04:15 can send a
//      leg for repair one time; a copy that still disagrees with THAT census
//      afterwards is not sent again.
//   3. A disagreement is repaired by comparing KEYS and fetching the rows that
//      differ (reconcileLegKeys), where the leg's shape allows — not by
//      reading the leg.
//   4. And whatever the reason, a leg starts from its first page at most
//      LEG_DOWNLOADS_PER_DAY times in 24 hours on one device, counted where a
//      reload — and a browser deleting the database — cannot reset it
//      (downloadLedger.js).

import {
  MIRROR_LEGS, LEG_BY_NAME, isAppendOnly, rowKey, storeKey, rowPath, DOC_ROW_KEY,
} from "./nodes";
import {
  EmptyMirrorReadError, healthyMeta, recordLegFailed, getLegHealth, healthKey,
  shrinkVerdict, shrankInfo, heldRows, MirrorSnapshotShrankError,
} from "./health";
import {
  readStaging, appendStagingChunk, loadStagingRecords, clearStaging, stagingKeys,
} from "./staging";
import {
  runChangeFeedPage, changeCursorAtSetupStart, CursorExpiredError, FeedCursorStuckError,
  isPermissionDenied, mapWithLimit, msFromPushKey, ROW_CONCURRENCY,
  FEED_CURSOR_META, COUNTS_ROOT, CHANGES_ROOT,
} from "./changeFeed";
import {
  coverSince, touchedSince, pendingTouched, pushKeyPrefixForMs, TOUCHED_META, CENSUS_ACTED_META,
  CENSUS_CLOCK_MARGIN_MS,
} from "./censusJournal";
import { createDownloadLedger, MirrorDownloadBudgetError } from "./downloadLedger";
import { isCanonicalLocationId } from "./locationIds";
import {
  pageEntries, maxKey, compareKeys, compareChildOrder, compareChildValues,
} from "./rtdbOrder";

export const SETUP_META_PREFIX = "setup.";
export const SETUP_DONE_META = "setup.done";
export const CURSOR_META = (leg) => `feedCursor.${leg}`;
export const LAST_SYNC_META = (leg) => `lastSyncAt.${leg}`;
export const CENSUS_CHECKED_META = "setup.censusCheckedAt";

// How often the census is consulted. It is written once a day; reading it more
// often than that costs a small read and answers the same question.
export const CENSUS_CHECK_MS = 6 * 60 * 60 * 1000;
// A census older than this is not evidence about today's rows. Stale counts
// must never be the reason an estate re-downloads 104 MB.
export const CENSUS_MAX_AGE_MS = 48 * 60 * 60 * 1000;

// Change-feed pages per steady-state pass. A burst clears over a few passes
// rather than monopolising one; nothing here is urgent enough to be worth
// holding the tab.
export const FEED_PAGES_PER_PASS = 4;
// Append-only pages per leg per pass, in the steady state. Setup ignores this
// and walks to the end.
export const RANGE_PAGES_PER_PASS = 2;

// Nodes where zero rows is a REAL state rather than a broken read. Named, not
// inferred: the whole point of the guard is that an empty store and a broken
// leg are indistinguishable from the outside, so the exemption has to be a
// decision someone took about a specific node.
//
//   returnsLog / restockLog / restockRequests / clothingOos — all genuinely
//     empty on a quiet day, and /clothing_sold_refills is empty right now.
//   displaySlots / displayRows / displayRegister — a shop with no displays up.
//   insights / movements — a device syncing an empty window.
//   stockHoldConfig / stockHoldHeld / hiddenProducts / transitConfig /
//     taxonomy — absent means "off"/"none", which is the default these
//     features are written around. `held` is empty on the live database today.
const CAN_BE_EMPTY = new Set([
  "returnsLog", "restockLog", "restockRequests", "clothingOos",
  "displaySlots", "displayRows", "displayRegister",
  "insights", "movements",
  "stockHoldConfig", "stockHoldHeld", "hiddenProducts", "transitConfig", "taxonomy",
]);

// The legs where an empty read is a FAILED read. /products with no products,
// /stock with no cells, /locations with no locations and /users with no users
// are all impossible states of this business, so reading one means the read
// was wrong — a permission change, a renamed path, a truncated response.
export const MUST_NOT_BE_EMPTY = Object.freeze(
  MIRROR_LEGS.filter((l) => !CAN_BE_EMPTY.has(l.name)).map((l) => l.name),
);

// ─── A LEG THAT KEEPS FAILING IS BENCHED, NOT RETRIED FOR EVER ──────────────
//
// The #624 incident was not only a wrong cursor. It was a wrong cursor with
// nothing to stop it: setup retried every five minutes, each retry read the
// same page, and the fleet spent 214 MB in a morning on one row. A failing leg
// now backs off (LEG_RETRY_BASE_MS, doubling, capped at LEG_RETRY_MAX_MS) and
// after LEG_MAX_ATTEMPTS failures in one session it is BENCHED — not attempted
// again until the app is next opened, recorded as `gave-up` in its health and
// therefore named in /mirror_devices.
//
// THE BYTE BOUND. A range leg writes its cursor with every page, and a stuck
// page throws BEFORE it is written, so a failed attempt costs the pages it
// read and a retry resumes where the walk stood — never from the start. A
// stuck snapshot walk KEEPS its staged pages for the same reason. A stuck
// walk therefore costs at most LEG_MAX_ATTEMPTS pages a session. A snapshot
// leg that fails VALIDATION (empty, shrank, did-not-land) clears its staging —
// those pages are the thing in doubt — so it costs at most LEG_MAX_ATTEMPTS ×
// the leg. The change feed is benched the same way (FEED_LEDGER below).
export const LEG_MAX_ATTEMPTS = 3;
export const LEG_RETRY_BASE_MS = 5 * 60 * 1000;
export const LEG_RETRY_MAX_MS = 60 * 60 * 1000;
// The change feed's place in the same ledger. It is not a leg, so a stuck feed
// is not recorded against one: once benched, every change-fed leg stops being
// SERVED (its rows would go stale) and screens read live until the next open.
export const FEED_LEDGER = "changeFeed";

// ─── A COPY TAKEN BY THE OLD PAGER IS NOT TRUSTED ───────────────────────────
//
// Before this version, a paged snapshot leg ended its walk on a page the
// server had sent one row short (see rtdbAdapter.keyPageConstraints), so a
// device could hold a truncated leg whose shortfall was inside the census
// tolerance and was therefore served. A setup marker now records the pager
// that wrote it, and a paged snapshot leg whose marker predates this one is
// downloaded again and stops being served until it is.
export const PAGER_VERSION = 2;
const isPagedSnapshot = (leg) => !isAppendOnly(leg) && leg.depth > 0;

// ─── REPAIRING A COUNT BY ITS KEYS ──────────────────────────────────────────
//
// How many key reads one repair may make (a depth-2 leg costs one per
// top-level child, plus one), and how many ROWS it may then fetch. Past either
// the leg is too wide or too different for a diff to be the cheap way, and the
// repair falls back to the walk — which is budgeted like any other.
export const KEYDIFF_MAX_REQUESTS = 60;
export const KEYDIFF_MAX_ROW_READS = 2000;
export const KEYDIFF_MAX_FRACTION = 0.25;
// A leg holding more keys than this is not diffed: its key list alone is a
// megabyte or more, read by every device that asks. It keeps the walk.
export const KEYDIFF_MAX_LOCAL_KEYS = 20000;
// A KEY comparison cannot see a row whose VALUE is stale (a lost change record
// for an edit). So each one also re-reads a few rows both sides hold, picked
// at random, and compares them. More than KEYDIFF_SAMPLE_TOLERATED stale in
// the sample says the leg's values cannot be trusted, and it is downloaded.
export const KEYDIFF_SAMPLE = 20;
export const KEYDIFF_SAMPLE_TOLERATED = 2;

// However much the feed says a leg has churned, the census allowance is never
// widened by more than this share of the census's own count. The census is
// there to catch LOST rows; an allowance that can grow to half a leg catches
// nothing.
export const CENSUS_CHURN_CAP = 0.10;
// A copy downloaded this recently is "just downloaded" for a forced census.
export const JUST_DOWNLOADED_MS = 30 * 60 * 1000;
// A device with a census-parked leg forces a census on every open. Not more
// often than this.
export const PARKED_CENSUS_EVERY_MS = 30 * 60 * 1000;
// On a pass asked for by the live signal, the two histories are walked only
// if this long has passed since they last were. See runPass.
export const SIGNAL_RANGE_EVERY_MS = 5 * 60 * 1000;
// …but never this long, on a signal pass, once the feed has applied ANYTHING
// since they were last walked. While signals keep arriving the 60-second
// floor pass never gets its turn (each signal reschedules it), so this is the
// floor's promise kept on its behalf.
export const SIGNAL_RANGE_FLOOR_MS = 60 * 1000;

// Structural equality over what RTDB stores, blind to key order.
function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null);
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

class KeyDiffNotPossible extends Error {}

export class MirrorCursorStuckError extends Error {
  constructor(leg, at) {
    super(`offline mirror: the "${leg}" walk cannot advance past "${at}"`);
    this.name = "MirrorCursorStuckError";
    this.leg = leg;
  }
}

export class MirrorSetupIncompleteError extends Error {
  constructor(failed) {
    super(`offline mirror: setup did not finish — ${failed.map((f) => `${f.leg} (${f.reason})`).join(", ")}`);
    this.name = "MirrorSetupIncompleteError";
    this.failed = failed;
  }
}

// ─── FLATTENING A PAGE INTO ROWS ────────────────────────────────────────────

/**
 * One key page of `leg.node`, turned into the rows its object store holds.
 *
 * A page carries each top-level child's WHOLE subtree, so a depth-2 or depth-3
 * leg is flattened here in memory rather than by further reads.
 *
 * `skipped` carries what could not be represented — a /stock location this app
 * does not know, a key containing the row-key separator. Both are refused
 * rather than stored under a key that means something else, and both are
 * surfaced so a pass can record them instead of losing them.
 */
export function flattenPage(leg, page) {
  const rows = [];
  const skipped = [];
  const walk = (value, segments, remaining) => {
    if (remaining === 0) {
      try {
        const key = segments.length ? rowKey(segments) : DOC_ROW_KEY;
        rows.push({ key: storeKey(leg, key), value });
      } catch (err) {
        skipped.push({ segments, why: "unrepresentable-key", detail: err.message });
      }
      return;
    }
    if (value === null || typeof value !== "object") {
      // A node shallower than its declared depth. Not an error — a store with
      // no display rows yet has `{}` where a map of products would be — but it
      // contributes no rows.
      return;
    }
    for (const [k, child] of Object.entries(value)) {
      // RTDB coerces dense integer keys to an ARRAY with null holes; 560 of
      // 5,793 /stock rows are array-coerced today. A hole is `null` and must
      // be skipped, not walked and not stored.
      if (child === null || child === undefined) continue;
      walk(child, [...segments, k], remaining - 1);
    }
  };

  if (leg.depth === 0) {
    if (page !== null && page !== undefined) rows.push({ key: storeKey(leg, DOC_ROW_KEY), value: page });
    return { rows, skipped };
  }

  // pageEntries, not Object.entries: a page from the adapter is a Map, and
  // Object.entries of a Map is [] — every row silently gone.
  for (const [top, subtree] of pageEntries(page)) {
    if (leg.name === "stock" && !isCanonicalLocationId(top)) {
      // See changeFeed.js: /stock's keys ARE the canonical ids, so anything
      // else means a path was written that nothing reads. Storing it under a
      // translated id would file those cells over the real ones.
      skipped.push({ segments: [top], why: "unknown-location" });
      continue;
    }
    walk(subtree, [top], leg.depth - 1);
  }
  return { rows, skipped };
}

// ─── THE ENGINE ─────────────────────────────────────────────────────────────

export function createSyncEngine({
  db,
  adapter,
  now = Date.now,
  buildVersion = null,
  // Called with { phase, leg, done, total, rows, bytes } as setup progresses,
  // so the blocking screen can show something honest rather than a spinner.
  onProgress = () => {},
  // "Is the app doing something a person is waiting on?" The engine defers to
  // it, but never indefinitely — see runPass.
  isBusy = () => false,
  // "May this device re-download a leg that has lost its setup marker?"
  // FALSE on a device whose staff have never agreed to hold a copy, because
  // on such a device EVERY leg is missing its marker and the repair step is
  // therefore a complete, unasked, unverified download of the whole shop.
  // (Fable-vs-spec review, PR #624.)
  mayRepair = () => true,
  // How many times a leg may be downloaded whole in a day, counted where a
  // reload cannot reset it. See downloadLedger.js.
  downloadLedger = createDownloadLedger({ now }),
  // Picks the rows a key-diff re-reads to check VALUES. Injected for tests.
  random = Math.random,
} = {}) {
  let setupRunning = null;

  // ── the per-session retry ledger (see LEG_MAX_ATTEMPTS) ───────────────────
  // In memory ON PURPOSE: "per session" is the promise, and a reload is the
  // one thing that should give a benched leg another go.
  const failures = new Map();   // leg -> { attempts, nextAt, reason }
  // ONE WALK OF A LEG AT A TIME. The setup download and the pass loop's repair
  // can both reach the same leg; two concurrent walks of a snapshot leg stage
  // over each other (StagingIncompleteError on the fleet) and two range walks
  // read the same pages twice. The second caller waits for the first.
  const inFlight = new Map();
  // append-only leg -> when its forward walk last reached the end of the node.
  const rangeEndAt = new Map();
  // When the two histories were last walked by a pass (SIGNAL_RANGE_EVERY_MS).
  let rangeWalkedAt = null;
  // Has the feed applied a row since then? (SIGNAL_RANGE_FLOOR_MS)
  let appliedSinceRangeWalk = false;
  // leg -> key reads that THREW in a row this session. See repairByKeys.
  const keyReadFailures = new Map();

  function legGate(legName) {
    const f = failures.get(legName);
    if (!f) return { ok: true };
    // Out of whole downloads for today: benched until the ledger frees a slot.
    // Asked of the ledger each time (it is a synchronous read), so the leg
    // comes back by itself when the window moves on — no reload needed.
    if (f.budget) {
      if (downloadLedger.remaining(legName) > 0) { failures.delete(legName); return { ok: true }; }
      return { ok: false, benched: true, reason: f.reason };
    }
    if (f.attempts >= LEG_MAX_ATTEMPTS) return { ok: false, benched: true, reason: f.reason };
    if (now() < f.nextAt) return { ok: false, benched: false, reason: f.reason, nextAt: f.nextAt };
    return { ok: true };
  }

  async function noteLegFailure(leg, err) {
    const prev = failures.get(leg.name);
    const attempts = (prev?.attempts ?? 0) + 1;
    const wait = Math.min(LEG_RETRY_MAX_MS, LEG_RETRY_BASE_MS * 2 ** (attempts - 1));
    const reason = err?.name ?? "Error";
    failures.set(leg.name, { attempts, nextAt: now() + wait, reason, message: err?.message ?? String(err) });
    if (attempts >= LEG_MAX_ATTEMPTS && !leg.pseudo) {
      await recordLegFailed(db, leg.name, {
        path: leg.node, reason: "gave-up", at: now(), state: "failed", retryable: false,
        // An append-only leg has no change feed behind it: benched, its copy
        // stops growing, so it stops being SERVED (screens read live) rather
        // than answer from a history that is missing today. A snapshot leg
        // keeps its last good copy — the change feed keeps that current.
        keepVouched: !isAppendOnly(leg),
        detail: `failed ${attempts} times this session (last: ${reason}: ${err?.message ?? err}). `
          + "Not attempted again until the app is next opened.",
      }).catch(() => {});
    }
  }

  // Every walk of a leg goes through here: the gate, the one-at-a-time rule,
  // and the ledger. `null` means "not attempted" (backing off, or benched).
  async function attemptLeg(leg, run) {
    if (!legGate(leg.name).ok) return null;
    if (inFlight.has(leg.name)) return inFlight.get(leg.name);
    const p = (async () => {
      try {
        const res = await run();
        failures.delete(leg.name);
        return res;
      } catch (err) {
        // NOT A FAILURE: this account may not read this node (see
        // markNotPermitted). Nothing to retry, nothing to bench.
        if (isPermissionDenied(err)) {
          await markNotPermitted(leg, err);
          return { rows: 0, added: 0, caughtUp: true, notPermitted: true };
        }
        // NOT A FAILURE EITHER, and not retried on a timer: the leg has had
        // its whole downloads for today. Named in its health record (and so on
        // the fleet screen); whatever it still vouches for, it keeps.
        if (err instanceof MirrorDownloadBudgetError) {
          failures.set(leg.name, {
            attempts: LEG_MAX_ATTEMPTS, nextAt: err.nextAt, reason: err.name,
            message: err.message, budget: true,
          });
          await recordLegFailed(db, leg.name, {
            path: leg.node, reason: "download-budget", at: now(), state: "failed",
            retryable: false, detail: err.message,
          }).catch(() => {});
          throw err;
        }
        await noteLegFailure(leg, err);
        throw err;
      }
    })().finally(() => { inFlight.delete(leg.name); });
    inFlight.set(leg.name, p);
    return p;
  }

  // ── A LEG THIS ACCOUNT MAY NOT READ ─────────────────────────────────────
  // A shop-bound account (users/{uid}/destShop) may read /orders only through
  // its own destShop query, so the whole-node download is refused — on every
  // Marathon PE and Pine tablet, every time. That is a RULE, not a fault: the
  // leg is recorded as not mirrored for this account, is never served (the
  // screens read it live, exactly as they always have), is not censused and
  // does not hold the rest of the setup back. The marker is dropped at every
  // start (clearNotPermitted), so a different account on the same device is
  // asked again — one refused request, no bytes.
  async function markNotPermitted(leg, err) {
    await recordLegFailed(db, leg.name, {
      path: leg.node, reason: "not-permitted", at: now(), state: "skipped",
      retryable: false, keepVouched: false,
      detail: `this account may not read /${leg.node} whole (${err?.message ?? err}). Read live instead.`,
    });
    await db.setMeta(`${SETUP_META_PREFIX}${leg.name}`, {
      at: now(), rows: 0, notPermitted: true, pager: PAGER_VERSION,
    });
  }
  const notPermitted = async (leg) =>
    !!(await db.getMeta(`${SETUP_META_PREFIX}${leg.name}`))?.notPermitted;

  // ── A LEG THE CENSUS STILL REFUSES AFTER ITS ONE REPAIR ─────────────────
  // It keeps its marker — with `censusRefused` on it, naming the census — so
  // that NOTHING downloads it again for that census: not the pass's repair
  // step, not the setup download on the next open. It is not "set up" (the
  // device is not complete, and the leg is not served); it simply waits for a
  // census that agrees with it or a newer one that sends it for repair again.
  const censusParked = (marker) => Number.isFinite(marker?.censusRefused);
  async function parkedLegs() {
    const out = [];
    for (const leg of MIRROR_LEGS) {
      if (censusParked(await db.getMeta(`${SETUP_META_PREFIX}${leg.name}`))) out.push(leg.name);
    }
    return out;
  }

  // ── WHO IS SIGNED IN DECIDES WHAT MAY BE SERVED ─────────────────────────
  // A tablet is shared. If an admin's account downloaded /orders whole and a
  // shop account signs in next, the local copy holds every shop's orders — more
  // than the rules would ever hand that account — and the feed, re-reading
  // /orders rows as the shop account, is refused on every one, so the copy
  // would also stop updating. (Sonnet review, PR #629.)
  //
  // So, for the account now signed in, every leg this device HOLDS is asked
  // once: one limitToFirst(1) read — a few hundred bytes — and a refusal marks
  // the leg not mirrored for this account, which stops it being served.
  async function checkAccess() {
    const refused = [];
    const unchecked = [];
    for (const leg of MIRROR_LEGS) {
      const marker = await db.getMeta(`${SETUP_META_PREFIX}${leg.name}`);
      if (!marker || marker.notPermitted) continue;
      try {
        if (leg.depth === 0) await adapter.readPath(leg.node);
        else await adapter.firstKey(leg.node);
      } catch (err) {
        // A slow line is not a refusal — but it is not an answer either, so
        // the caller must not treat this account as checked.
        if (!isPermissionDenied(err)) { unchecked.push(leg.name); continue; }
        await markNotPermitted(leg, err);
        refused.push(leg.name);
      }
    }
    return { refused, unchecked };
  }

  async function clearNotPermitted() {
    const cleared = [];
    for (const leg of MIRROR_LEGS) {
      if (await notPermitted(leg)) cleared.push(`${SETUP_META_PREFIX}${leg.name}`);
    }
    if (cleared.length) await db.deleteMetaMany([...cleared, SETUP_DONE_META]);
    return cleared.length;
  }

  // What the device reports: every leg that is failing this session.
  function legFailures() {
    return [...failures.entries()].map(([leg, f]) => ({
      leg, attempts: f.attempts, reason: f.reason, message: f.message ?? null,
      benched: f.attempts >= LEG_MAX_ATTEMPTS, nextAt: f.nextAt,
    }));
  }

  // ── THE DAILY BOUND ON WHOLE DOWNLOADS (downloadLedger.js) ────────────────
  //
  // Asked in two halves around a leg's FIRST page. Before it: is there a slot
  // at all? If not, nothing is read. After it has arrived: take the slot. The
  // slot is taken only once bytes have actually come back, so a read the rules
  // refuse (a shop account asking for /orders, on every start) or a line that
  // is down never spends one.
  function refuseIfOutOfDownloads(leg) {
    if (downloadLedger.remaining(leg.name) > 0) return;
    throw new MirrorDownloadBudgetError(leg.name, {
      max: downloadLedger.max, windowMs: downloadLedger.windowMs, nextAt: downloadLedger.nextAt(leg.name),
    });
  }
  function takeDownloadSlot(leg) {
    if (downloadLedger.consume(leg.name)) return;
    refuseIfOutOfDownloads(leg);
  }

  // ── one leg's snapshot download ───────────────────────────────────────────
  async function downloadSnapshotLeg(leg, { onPage = () => {} } = {}) {
    const at = now();
    let manifest = await readStaging(db, leg.name, {
      scope: leg.node, buildVersion, now,
    });
    // A walk with nothing staged starts from page one: that is a whole
    // download. A walk with pages staged is the same download carrying on.
    let fromPageOne = (manifest.chunks ?? 0) === 0
      && (manifest.afterKey === null || manifest.afterKey === undefined);
    if (fromPageOne) refuseIfOutOfDownloads(leg);

    // Resume from the last page that actually landed, not from page one.
    for (;;) {
      const page = leg.depth === 0
        ? await adapter.readPath(leg.node, { big: true })
        : await adapter.readKeyPage(leg.node, {
          after: manifest.afterKey, limit: leg.pageSize, big: true,
        });
      if (fromPageOne) { takeDownloadSlot(leg); fromPageOne = false; }

      if (leg.depth === 0) {
        const { rows } = flattenPage(leg, page);
        manifest = await appendStagingChunk(db, leg.name, {
          manifest, rows, afterKey: leg.node, now,
        });
        break;
      }

      const keys = pageEntries(page).map(([k]) => k);
      if (keys.length === 0) break;
      const { rows, skipped } = flattenPage(leg, page);
      // The page's LARGEST key by RTDB key order — never its last entry, and
      // never a JS string comparison, which puts "99" after "123" and walked
      // /customers backwards into pages it had already staged.
      const lastKey = maxKey(keys);
      if (manifest.afterKey !== null && manifest.afterKey !== undefined
        && compareKeys(lastKey, manifest.afterKey) <= 0) {
        // Staging is KEPT: every chunk in it ended before this page, so a
        // retry resumes from the last good one rather than from page one.
        await recordLegFailed(db, leg.name, {
          path: leg.node, reason: "cursor-stuck", at: now(), state: "failed", retryable: false,
          detail: `a page after "${manifest.afterKey}" ended on "${lastKey}", which is not past it.`,
        });
        throw new MirrorCursorStuckError(leg.name, manifest.afterKey);
      }
      manifest = await appendStagingChunk(db, leg.name, {
        manifest, rows, afterKey: lastKey, now,
      });
      // `staged`, NOT `rows`. The setup screen counts a leg DONE when it sees
      // `rows`, and emitting it per page marked /products complete after page
      // one of thirteen — the bar sprinting and then sitting still, which is
      // the exact thing MirrorSetupScreen's header says it was built to
      // avoid. (Fable-vs-spec review, PR #618.)
      onPage({ leg: leg.name, staged: manifest.rows, skipped });
      if (keys.length < leg.pageSize) break;
    }

    const records = await loadStagingRecords(db, leg.name, manifest);

    // EMPTY IS NOT SUCCESS. Checked before anything is written, so a leg that
    // reads nothing from a node that cannot be empty never touches the copy
    // that is already there.
    if (records.length === 0 && !CAN_BE_EMPTY.has(leg.name)) {
      await clearStaging(db, leg.name, manifest);
      await recordLegFailed(db, leg.name, {
        path: leg.node, reason: "empty", at: now(), state: "failed", retryable: true,
        detail: "This node cannot legitimately be empty. Treating the read as failed, "
          + "not the mirror as empty.",
      });
      throw new EmptyMirrorReadError(leg.name, leg.node);
    }

    // A SNAPSHOT MAY NEVER SHRINK QUIETLY.
    const held = (await heldRows(db, leg.name)) ?? 0;
    const verdict = shrinkVerdict({ held, incoming: records.length });
    if (!verdict.accept) {
      await clearStaging(db, leg.name, manifest);
      await recordLegFailed(db, leg.name,
        shrankInfo({ path: leg.node, held, incoming: records.length, at: now() }));
      throw new MirrorSnapshotShrankError(leg.name, held, records.length);
    }

    // The swap, the health record and the staging drop, in ONE transaction.
    // The health record is stamped from the records being written because it
    // has to ride this very transaction; the count that comes back is
    // established independently, inside it.
    const meta = {
      ...healthyMeta(leg.name, { path: leg.node, rows: records.length, at }),
      [LAST_SYNC_META(leg.name)]: at,
      [`${SETUP_META_PREFIX}${leg.name}`]: { at, rows: records.length, pager: PAGER_VERSION },
    };
    const deleteMetaKeys = stagingKeys(leg.name, manifest);
    const landed = leg.store === "docs"
      ? await db.replacePrefixed("docs", leg.node, records, meta, { deleteMetaKeys })
      : await db.replaceAll(leg.store, records, meta, { deleteMetaKeys });

    // "The record says N" and "the store holds N" are two facts, and this is
    // where they are compared. A leg whose rows did not land as counted has
    // nothing trustworthy on disk and must not stay vouched for.
    if (landed !== records.length) {
      await recordLegFailed(db, leg.name, {
        path: leg.node, reason: "did-not-land", at: now(), state: "failed",
        retryable: true, keepVouched: false,
        detail: `wrote ${records.length} rows and the store holds ${landed}`,
      });
      throw new Error(
        `offline mirror: the "${leg.name}" swap wrote ${records.length} rows but the store holds ${landed}`,
      );
    }
    return { rows: landed };
  }

  // ── one leg's forward walk (the append-only legs) ─────────────────────────
  //
  // The SAME code for setup and for steady state. `maxPages` is the only
  // difference: setup walks to the end, a pass takes a couple.
  async function runRangeLeg(leg, { maxPages = Infinity } = {}) {
    const cursorMeta = CURSOR_META(leg.name);
    // Was this leg already vouched for before this walk? See the end.
    const wasSetUp = !!(await db.getMeta(`${SETUP_META_PREFIX}${leg.name}`));
    // A keyRange cursor is a key. A tsRange cursor is a PAIR — { ts, key } —
    // because `ts` is not unique and a bare ts cursor makes every pass re-read
    // every row sharing the newest timestamp, for ever. See rtdbAdapter's
    // childPageConstraints. A cursor stored by an older build is a bare
    // string, which reads as { ts, key: null } and heals on the first page.
    let cursor = (await db.getMeta(cursorMeta)) ?? null;
    if (leg.feed === "tsRange" && typeof cursor === "string") cursor = { ts: cursor, key: null };
    let total = 0;
    let pages = 0;
    // Did the walk SEE the end (an empty or short page)? Not "did it stop
    // before maxPages": a short final page on the last allowed read is the
    // end too. (CodeRabbit, PR #631.)
    let reachedEnd = false;
    let startsFromNothing = cursor === null
      || (leg.feed === "tsRange" && (cursor.ts === null || cursor.ts === undefined) && !cursor.key);
    // Out of whole downloads for today: nothing is read at all.
    if (startsFromNothing) refuseIfOutOfDownloads(leg);

    for (; pages < maxPages; pages += 1) {
      const page = leg.feed === "keyRange"
        ? await adapter.readKeyPage(leg.node, { after: cursor, limit: leg.pageSize, big: true })
        : await adapter.readChildPage(leg.node, leg.tsField, {
          from: cursor?.ts ?? null, fromKey: cursor?.key ?? null,
          limit: leg.pageSize, big: true,
        });
      const entries = pageEntries(page);
      if (entries.length === 0) { reachedEnd = true; break; }
      // A history read from NO cursor is this leg's whole download (35 MB of
      // it), and it is counted like one — once rows have actually come back,
      // so an empty node asked every pass spends nothing. A walk from a stored
      // cursor is the same download carrying on.
      if (startsFromNothing) { takeDownloadSlot(leg); startsFromNothing = false; }

      const records = entries.map(([key, value]) => ({ key, value }));
      // THE NEXT CURSOR IS THE PAGE'S MAXIMUM IN THE QUERY'S OWN ORDER, found by
      // comparing, never by position. Taking "the last entry" is the #624
      // fleet download loop: the page arrived in key order, its last entry was
      // the row it had started from, and fifteen devices read the same 670 KB
      // page 319 times. See rtdbOrder.js.
      let nextCursor;
      let isAfter;
      if (leg.feed === "keyRange") {
        nextCursor = maxKey(records.map((r) => r.key));
        isAfter = (next, prev) => prev === null || prev === undefined || compareKeys(next, prev) > 0;
      } else {
        const pos = (r) => ({ value: r.value ? r.value[leg.tsField] : null, key: r.key });
        const top = records.map(pos).reduce((a, b) => (compareChildOrder(b, a) > 0 ? b : a));
        if (top.value !== null && typeof top.value === "object") {
          // RTDB orders objects last and startAt cannot name one. Refused
          // rather than turned into a cursor that re-reads from the start.
          throw new Error(`offline mirror: the "${leg.name}" row ${top.key} has an object for "${leg.tsField}" and cannot be a cursor`);
        }
        nextCursor = { ts: top.value ?? null, key: top.key };
        isAfter = (next, prev) => {
          const p = typeof prev === "string" ? { ts: prev, key: null } : prev;
          if (!p || !p.key && (p.ts === null || p.ts === undefined)) return true;
          // A cursor stored by an older build has no key: it means "from this
          // ts, inclusive", so anything at or after the ts is progress.
          if (!p.key) return compareChildValues(next.ts, p.ts) >= 0;
          return compareChildOrder({ value: next.ts, key: next.key }, { value: p.ts, key: p.key }) > 0;
        };
      }

      // A CAUGHT-UP LEG DOES NOT ADVANCE, AND THAT IS NORMAL. The ts bound is
      // inclusive, so a leg with nothing new gets back exactly the one row the
      // cursor names and the cursor legitimately stands still. That is the
      // steady state, not a fault.
      //
      // What IS a fault is a FULL page that does not advance: there is more to
      // read and the walk cannot reach it, so it would either loop for ever or
      // skip. With the cursor taken as the page's maximum that can only happen
      // if the server is not honouring the bound. Named, rather than hung —
      // and it throws BEFORE the page is written, so the next attempt resumes
      // from the same stored cursor rather than from the start.
      if (cursor && entries.length >= leg.pageSize && !isAfter(nextCursor, cursor)) {
        const where = leg.feed === "keyRange" ? `"${cursor}"` : `"${cursor.ts}"/"${cursor.key}"`;
        await recordLegFailed(db, leg.name, {
          path: leg.node, reason: "cursor-stuck", at: now(), state: "failed", retryable: false,
          detail: `a page from ${where} came back without advancing `
            + "the cursor. The walk cannot continue without either looping or skipping rows.",
        });
        throw new MirrorCursorStuckError(leg.name, leg.feed === "keyRange" ? cursor : cursor.ts);
      }

      const at = now();
      await db.putPage(leg.store, records, {
        cursorKey: cursorMeta,
        cursorValue: nextCursor,
        isAfter,
        metaEntries: { [LAST_SYNC_META(leg.name)]: at },
      });
      // Rows that were already held are not NEW. Counting them would make
      // every pass look like it found work and wake every reader for nothing.
      //
      // ONLY THE tsRange LEG HAS AN OVERLAP. Its bound is inclusive, so a
      // resumed page re-reads exactly the one row the cursor names. The
      // keyRange leg's bound is EXCLUSIVE (startAfter), so it has none — and
      // subtracting one there made a page of exactly ONE new row report zero,
      // which is the commonest case /insights_log has (one row per sale). The
      // reader signal then never fired and a screen sat on yesterday's total
      // until some later pass happened to bring two rows at once.
      // (Sonnet verification review, PR #618.)
      const overlap = leg.feed === "tsRange" && cursor?.key
        ? records.filter((r) => r.key === cursor.key).length : 0;
      total += records.length - overlap;
      cursor = nextCursor;
      onProgress({ phase: "range", leg: leg.name, rows: total });
      if (entries.length < leg.pageSize) { pages += 1; reachedEnd = true; break; }
    }

    const rowsNow = (await heldRows(db, leg.name)) ?? 0;
    if (rowsNow === 0 && !CAN_BE_EMPTY.has(leg.name)) {
      await recordLegFailed(db, leg.name, {
        path: leg.node, reason: "empty", at: now(), state: "failed", retryable: true,
      });
      throw new EmptyMirrorReadError(leg.name, leg.node);
    }
    const caughtUp = reachedEnd;
    // When this leg's walk last SAW the end of its node — what lets the census
    // check tell a history that has kept up from one still walking forward.
    if (caughtUp) rangeEndAt.set(leg.name, now()); else rangeEndAt.delete(leg.name);
    // A PARTIAL WALK NEVER VOUCHES FOR A LEG THAT WAS NOT SET UP. The pass
    // loop walks two pages at a time; it used to stamp the leg healthy and set
    // up after those two pages, so a history that had never been completely
    // downloaded was SERVED, the census then called it drift, and the repair
    // step never ran because the leg claimed to be set up. (Rashid and Asanda,
    // Pine, 21 Sep: "stock movements do not match" that never cleared.) Only a
    // walk that reached the end may set a leg up; a leg already set up keeps
    // its stamp as it moves forward.
    if (!caughtUp && !wasSetUp) return { rows: rowsNow, added: total, caughtUp };
    await db.setMetaMany({
      ...healthyMeta(leg.name, { path: leg.node, rows: rowsNow, at: now() }),
      [`${SETUP_META_PREFIX}${leg.name}`]: { at: now(), rows: rowsNow },
    });
    return { rows: rowsNow, added: total, caughtUp };
  }

  // ── THE SETUP DOWNLOAD ────────────────────────────────────────────────────
  //
  // One forced full download per device, blocking, automatic. No toggle, no
  // manual step.
  //
  // THE CHANGE CURSOR IS TAKEN FIRST, before any leg is read. A 104 MB
  // download takes minutes and anything written during it may or may not be in
  // what was read; starting the feed from the log's head AT THE START means
  // those writes are replayed afterwards — an upsert of a value that may
  // already be correct — where starting from the end would skip them silently
  // and for ever. Re-read what you might already have; never skip what you
  // might not.
  // `keepGoing` is asked BETWEEN LEGS, and it is what makes a 104 MB download
  // abandonable. The fleet kill switch can arrive in the middle of one, and a
  // device that has been told to stop mirroring must stop DOWNLOADING too —
  // otherwise the one control that is supposed to end an incident goes on
  // spending money on it for several minutes. Between legs rather than
  // mid-leg, so a leg is never half-swapped: the worst overrun is one leg.
  async function runSetup({ force = false, keepGoing = () => true } = {}) {
    if (setupRunning) return setupRunning;
    setupRunning = (async () => {
      const startedAt = now();
      const todo = [];
      // Parked by the census (censusParked): not complete, and not downloaded
      // again by a setup run either — that would be the storm with a reload in
      // the loop instead of a pass.
      const parked = force ? [] : await parkedLegs();
      for (const leg of MIRROR_LEGS) {
        if (parked.includes(leg.name)) continue;
        if (!force && await legIsSetUp(leg)) continue;
        todo.push(leg);
      }
      if (todo.length === 0 && parked.length) {
        throw new MirrorSetupIncompleteError(parked.map((leg) => ({ leg, reason: "count-drift" })));
      }
      if (todo.length === 0) {
        await db.setMeta(SETUP_DONE_META, { at: startedAt, legs: MIRROR_LEGS.length });
        return { alreadyDone: true, legs: [] };
      }

      // Only when the change feed has never run: re-taking it would rewind a
      // working cursor to the head of the log and skip everything between.
      if ((await db.getMeta(FEED_CURSOR_META)) === undefined) {
        await db.setMeta(FEED_CURSOR_META, await changeCursorAtSetupStart({ adapter }));
      }

      await retireOldPagerCopies();

      // ONE LEG FAILING NO LONGER STOPS THE OTHERS. A failed leg is recorded
      // and the download moves on; the setup is not done until every leg is,
      // and the error names every leg that is not.
      const done = [];
      const failed = [];
      for (let i = 0; i < todo.length; i += 1) {
        const leg = todo[i];
        if (!keepGoing()) return { alreadyDone: false, abandoned: true, legs: done, failed };
        onProgress({ phase: "setup", leg: leg.name, done: i, total: todo.length });
        let res;
        try {
          res = await attemptLeg(leg, () => (isAppendOnly(leg)
            ? runRangeLeg(leg)
            : downloadSnapshotLeg(leg, {
              // `staged`, never `rows` — see downloadSnapshotLeg. A page in
              // flight must not be reported in the field that means "finished".
              onPage: ({ staged }) => onProgress({
                phase: "setup", leg: leg.name, done: i, total: todo.length, staged,
              }),
            })));
        } catch (err) {
          failed.push({ leg: leg.name, reason: err?.name ?? "Error", message: err?.message ?? String(err), err });
          continue;
        }
        if (res === null) {
          const gate = legGate(leg.name);
          failed.push({ leg: leg.name, reason: gate.benched ? "gave-up" : "backing-off" });
          continue;
        }
        done.push({ leg: leg.name, rows: res.rows });
        onProgress({ phase: "setup", leg: leg.name, done: i + 1, total: todo.length, rows: res.rows });
      }
      // The FIRST real error is what is thrown — it is the one a caller (and
      // a test) can act on — carrying the full list of every leg that failed.
      for (const leg of parked) failed.push({ leg, reason: "count-drift" });
      if (failed.length) {
        const first = failed.find((f) => f.err)?.err ?? new MirrorSetupIncompleteError(failed);
        try { first.failedLegs = failed.map(({ err, ...f }) => f); } catch { /* frozen */ }
        // What this run DID download, for a caller that must verify it.
        try { first.downloadedLegs = done.map((d) => d.leg); } catch { /* frozen */ }
        throw first;
      }

      await db.setMeta(SETUP_DONE_META, { at: now(), legs: MIRROR_LEGS.length });
      return { alreadyDone: false, legs: done };
    })().finally(() => { setupRunning = null; });
    return setupRunning;
  }

  // A copy the old pager took stops being served NOW, not when its
  // replacement lands: it may be short, and the census could not see it.
  // Local only — it reads IndexedDB and writes health records, never RTDB — so
  // bootstrap runs it at start, before the serving hint is trusted.
  async function retireOldPagerCopies() {
    const retired = [];
    for (const leg of MIRROR_LEGS) {
      if (!isPagedSnapshot(leg)) continue;
      const marker = await db.getMeta(`${SETUP_META_PREFIX}${leg.name}`);
      if (!marker || marker.pager === PAGER_VERSION) continue;
      await recordLegFailed(db, leg.name, {
        path: leg.node, reason: "re-paging", at: now(), state: "failed",
        retryable: true, keepVouched: false,
        detail: "this copy was taken by a pager that could stop one page early. Downloading it again.",
      });
      await db.deleteMetaMany([`${SETUP_META_PREFIX}${leg.name}`, SETUP_DONE_META]);
      retired.push(leg.name);
    }
    return retired;
  }

  // A leg counts as set up only if BOTH its setup marker and its health record
  // stand, and the health record is backed by rows actually in the store. A
  // marker alone is how a device walks past the setup screen into a blank app.
  async function legIsSetUp(leg) {
    const marker = await db.getMeta(`${SETUP_META_PREFIX}${leg.name}`);
    if (!marker) return false;
    // Decided, not missing: see markNotPermitted.
    if (marker.notPermitted) return true;
    // Held, repaired once, and still short of the census: not set up, and not
    // to be downloaded again for it either. See censusParked.
    if (censusParked(marker)) return false;
    if (isPagedSnapshot(leg) && marker.pager !== PAGER_VERSION) return false;
    const health = await getLegHealth(db, leg.name);
    if (!health) return false;
    const rows = (await heldRows(db, leg.name)) ?? 0;
    if (rows === 0 && !CAN_BE_EMPTY.has(leg.name)) return false;
    return true;
  }

  async function setupState() {
    const marker = await db.getMeta(SETUP_DONE_META);
    const legs = [];
    for (const leg of MIRROR_LEGS) legs.push({ leg: leg.name, ready: await legIsSetUp(leg) });
    const ready = legs.every((l) => l.ready);
    return { done: !!marker && ready, ready, legs };
  }

  // ── THE STEADY-STATE PASS ─────────────────────────────────────────────────
  //
  // `signal` — was this pass asked for by the live change signal? Then it is
  // here for the CHANGE FEED: something was just written to a mutable node.
  // The two histories have their own forward cursors and nothing in a signal
  // says they moved — EXCEPT WHEN IT DOES. A sale writes a /stock row, an
  // /insights_log row and a /stock_movements row together, and the screens
  // that show it ("sold, refill it", Movement History, Insights) read the
  // histories. So a signal pass walks them:
  //   · at once, if this pass's feed applied a /stock row — that is a sale, or
  //     a transfer, and its movement is waiting;
  //   · within SIGNAL_RANGE_FLOOR_MS, if the feed has applied anything at all
  //     since they were last walked (the 60-second floor, which signals would
  //     otherwise starve);
  //   · and every SIGNAL_RANGE_EVERY_MS regardless.
  // What is left to skip is the signal pass whose records were other nodes'
  // edits — a display re-check, a refill run, an order status — thousands of
  // them on a busy afternoon, each of which used to pay two range reads that
  // came back with the one row the cursor already named. The floor-cadence
  // pass (no signal) walks them every time, as before.
  async function runPass({ signal = false } = {}) {
    const report = { feed: null, range: [], census: null, errors: [] };

    // 1. The change feed, which is what keeps eighteen legs true — unless it
    // is backing off or benched after stuck pages (FEED_LEDGER).
    // Has the feed read to the END of the log in this pass? The census is only
    // comparable with a copy that has (checkCensus).
    let feedCaughtUp = false;
    const feedGate = legGate(FEED_LEDGER);
    if (!feedGate.ok) {
      report.feed = { applied: 0, deleted: 0, paths: [], skipped: feedGate.benched ? "benched" : "backing-off" };
    } else try {
      // NO CURSOR AT ALL is not "start from the beginning". It means the
      // cursor was lost (an older build dropped it on expiry; a browser emptied
      // the database under a running tab), and reading the log from its first
      // record would replay thirty days of changes row by row — and then find
      // that first page's own cursor already past retention. See
      // resetFeedCursor.
      if ((await db.getMeta(FEED_CURSOR_META)) === undefined) {
        const marked = await resetFeedCursor("cursor-lost",
          "this device had no change cursor, so changes may have been missed.");
        if (marked.length) report.errors.push({ where: "feed", reason: "cursor-lost" });
      }
      let applied = 0;
      let deleted = 0;
      let caughtUp = false;
      const paths = [];
      const refusedLegs = [];
      for (let i = 0; i < FEED_PAGES_PER_PASS; i += 1) {
        const res = await runChangeFeedPage({ db, adapter, now });
        applied += res.applied;
        deleted += res.deleted;
        paths.push(...res.paths);
        for (const sk of res.skipped ?? []) {
          if (sk.why === "not-permitted" && sk.leg) refusedLegs.push(sk.leg);
        }
        caughtUp = res.done;
        if (res.done) break;
      }
      report.feed = { applied, deleted, paths };
      failures.delete(FEED_LEDGER);
      // A row this account was refused means the leg's copy can no longer be
      // kept current FOR THIS ACCOUNT: it stops being served, never deleted.
      for (const name of new Set(refusedLegs)) await markNotPermitted(LEG_BY_NAME[name], new Error("permission_denied (change feed)"));
      // A feed that works again has replayed everything since the cursor it
      // was stuck on (the cursor never moved while it was stuck), so the legs
      // it had to stop serving are current again and are vouched for again —
      // once it has read to the END, not after four pages of a longer backlog.
      if (caughtUp) await reserveChangeFedLegs();
      feedCaughtUp = caughtUp;
    } catch (err) {
      if (err instanceof CursorExpiredError) {
        // The honest wall. Every change-fed leg this device holds is marked
        // for a fresh download, and the feed starts again from the head of the
        // log — taken NOW, before any of those legs is read.
        try {
          await resetFeedCursor("cursor-expired", err.message);
          report.errors.push({ where: "feed", reason: "cursor-expired" });
        } catch (resetErr) {
          // Could not reach the log to take a new cursor: nothing has been
          // changed, and the next pass meets the same wall and tries again.
          report.errors.push({ where: "feed", reason: resetErr.name, message: resetErr.message });
        }
      } else if (err instanceof FeedCursorStuckError) {
        // Counted like a leg; a timeout is not (it costs no page, and the
        // pass backoff already spaces it).
        await noteLegFailure({ name: FEED_LEDGER, node: CHANGES_ROOT, pseudo: true }, err);
        if (!legGate(FEED_LEDGER).ok && legGate(FEED_LEDGER).benched) await unserveChangeFedLegs(err);
        report.errors.push({ where: "feed", reason: err.name, message: err.message });
      } else {
        report.errors.push({ where: "feed", reason: err.name, message: err.message });
      }
    }

    // 2. The two forward walks.
    const feedPaths = report.feed?.paths ?? [];
    if ((report.feed?.applied ?? 0) + (report.feed?.deleted ?? 0) > 0) appliedSinceRangeWalk = true;
    const stockPrefix = `${LEG_BY_NAME.stock.node}/`;
    const sinceWalk = rangeWalkedAt === null ? Infinity : now() - rangeWalkedAt;
    const walkRanges = !signal
      || feedPaths.some((path) => path.startsWith(stockPrefix))
      || (appliedSinceRangeWalk && sinceWalk >= SIGNAL_RANGE_FLOOR_MS)
      || sinceWalk >= SIGNAL_RANGE_EVERY_MS;
    if (walkRanges) { rangeWalkedAt = now(); appliedSinceRangeWalk = false; }
    else report.rangeSkipped = "signal";
    for (const leg of (walkRanges ? MIRROR_LEGS.filter(isAppendOnly) : [])) {
      if (await notPermitted(leg)) continue;
      try {
        const res = await attemptLeg(leg, () => runRangeLeg(leg, { maxPages: RANGE_PAGES_PER_PASS }));
        if (res === null) continue;            // backing off, or benched this session
        report.range.push({ leg: leg.name, added: res.added });
      } catch (err) {
        report.errors.push({ where: leg.name, reason: err.name, message: err.message });
      }
    }

    // 3. The outside opinion.
    const fresh = { feedCaughtUp };
    try { report.census = await checkCensus(fresh); }
    catch (err) { report.errors.push({ where: "census", reason: err.name, message: err.message }); }

    // 4. ANYTHING THAT NEEDS DOWNLOADING AGAIN, DOWNLOADED AGAIN.
    //
    // A census drift and an expired cursor both drop a leg's setup marker and
    // say "downloading this leg again" — and nothing did. runSetup was only
    // ever called by the setup screen at gate time, so a drifted leg fell back
    // to whole-node LIVE reads (the expensive path this work exists to remove)
    // and stayed there until the next reload, which would then block the whole
    // app behind a 35 MB download, possibly mid-trade.
    // (Fable-vs-spec review, PR #618.)
    //
    // Repairing inside the pass fixes both halves: the leg comes back without
    // anyone pressing anything, and it never becomes a blocking screen in the
    // middle of a trading day. ONE leg per pass, smallest first, so a repair
    // cannot monopolise a device.
    try {
      report.repaired = mayRepair() ? await repairOneLeg(fresh) : null;
    } catch (err) {
      report.errors.push({ where: "repair", reason: err.name, message: err.message });
    }

    return report;
  }

  // The legs that have lost their setup marker, in the order that gets a
  // device working again soonest: the catalogue and the shelf before the
  // history. Returns what it repaired, or null.
  async function repairOneLeg(fresh = {}) {
    for (const leg of MIRROR_LEGS) {
      if (await legIsSetUp(leg)) continue;
      // A leg that is backing off or benched is passed over, so one broken leg
      // cannot hold every other repair behind it.
      if (!legGate(leg.name).ok) continue;
      // Already repaired once for the census it disagrees with: not again —
      // EXCEPT by its keys, once. A key comparison is stricter than a count:
      // if the copy's keys match the server's, the census is what is wrong,
      // and the leg is served again (reconcileLegKeys stamps `keysAt` and the
      // parking goes with the old marker). Tried once per parking, so a leg
      // that cannot be diffed does not cost a key list on every pass.
      const parkedMarker = await db.getMeta(`${SETUP_META_PREFIX}${leg.name}`);
      if (censusParked(parkedMarker)) {
        if (parkedMarker.keysTried === parkedMarker.censusRefused || inFlight.has(leg.name)) continue;
        // No key read on this device at all: nothing was tried, nothing is spent.
        if (typeof adapter.shallowKeys !== "function") continue;
        const attempt = await repairByKeys(leg, fresh);
        if (attempt.deferred) continue;                        // not asked yet: asked on a later pass
        const unparked = attempt.res;
        if (unparked === null) {
          // Asked, and not possible: that was this parking's one try.
          await db.setMeta(`${SETUP_META_PREFIX}${leg.name}`, { ...parkedMarker, keysTried: parkedMarker.censusRefused });
          continue;
        }
        await stampDeviceCompleteIfWhole(fresh);
        return { leg: leg.name, rows: unparked.rows, via: unparked.via, added: unparked.added, removed: unparked.removed };
      }
      // A COUNT THAT DISAGREES IS REPAIRED BY ITS KEYS FIRST. The census said
      // "you hold the wrong NUMBER of rows", and the cheap answer to that is
      // to compare key sets and fetch the rows that differ. Only when the leg
      // cannot be repaired that way (too deep, too different, no key read on
      // this device) is it downloaded — and that is the budgeted path.
      let res = null;
      if (!inFlight.has(leg.name)
        && (await getLegHealth(db, leg.name))?.reason === "count-drift") {
        const attempt = await repairByKeys(leg, fresh);
        // Deferred — the feed is still catching up, or the key read failed and
        // will be asked again. The leg waits for the next pass; it does NOT
        // fall through to the walk.
        if (attempt.deferred) continue;
        res = attempt.res;
      }
      if (res === null) {
        res = await attemptLeg(leg, () => (isAppendOnly(leg)
          ? runRangeLeg(leg)
          : downloadSnapshotLeg(leg)));
      }
      if (res === null) continue;
      // NOT censused here, one leg at a time, and deliberately so. A repaired
      // leg is served on its own vouch (and the shrink guard, which compares
      // it to what was held) until the device is whole again — censused just
      // below — or the next scheduled census. Forcing the census after EVERY
      // repair was tried (Fable-vs-spec review, PR #639) and is a byte bomb:
      // a leg that still disagrees with /mirror_counts loses its marker again
      // and is re-downloaded on the next pass, every minute, instead of once
      // per CENSUS_CHECK_MS.
      // Re-stamp the whole-device marker only when every leg is back — and
      // ask the census FIRST. A device that becomes complete through repairs
      // reaches exactly the state the download path forces a census for, and
      // it would otherwise not be asked again for six hours.
      await stampDeviceCompleteIfWhole(fresh);
      return {
        leg: leg.name, rows: res.rows,
        ...(res.via ? { via: res.via, added: res.added, removed: res.removed } : {}),
      };
    }
    // NOTHING LEFT TO REPAIR, AND THE DEVICE MARKER STILL MISSING. A history
    // leg that lost its marker is put back by its own forward walk (step 2 of
    // the pass), not by this step — so this step found nothing to do, never
    // re-stamped the device, and it reported "not complete" for ever with
    // every leg in place.
    if ((await db.getMeta(SETUP_DONE_META)) === undefined) await stampDeviceCompleteIfWhole(fresh);
    return null;
  }

  // Can this leg be repaired by its keys AT ALL? Asked without reading
  // anything, so that a leg which cannot is never made to wait for one.
  const keyDiffShape = (leg) => typeof adapter.shallowKeys === "function"
    && leg.store !== "docs" && leg.depth >= 1 && !isAppendOnly(leg);

  // One attempt at a key repair, and what the caller should do about it:
  //   { res }             repaired — or, with res null, NOT POSSIBLE for this
  //                       leg (too deep, too big, too different, refused by
  //                       the rules): the budgeted walk is next.
  //   { deferred: true }  not now. Either the feed has not caught up — a row
  //                       still in the backlog would read as "stale" in the
  //                       value sample, or as "missing", and neither is true —
  //                       or the key read THREW (a timeout, a dropped line).
  //                       A fault on the line is a reason to ask again, not a
  //                       reason to download 6 MB over the same line.
  // A read that keeps throwing is not asked for ever: after LEG_MAX_ATTEMPTS
  // in a row this session the leg goes to the walk, which has its own bound.
  async function repairByKeys(leg, fresh = {}) {
    if (!keyDiffShape(leg)) return { res: null };
    if (!fresh.feedCaughtUp) return { deferred: true };
    try {
      const res = await reconcileLegKeys(leg);
      keyReadFailures.delete(leg.name);
      return { res };
    } catch (err) {
      if (isPermissionDenied(err)) return { res: null };       // refused: that is an answer
      const failures = (keyReadFailures.get(leg.name) ?? 0) + 1;
      keyReadFailures.set(leg.name, failures);
      if (failures >= LEG_MAX_ATTEMPTS) { keyReadFailures.delete(leg.name); return { res: null }; }
      return { deferred: true };
    }
  }

  async function stampDeviceCompleteIfWhole(fresh = {}) {
    if (!(await setupState()).ready) return;
    await checkCensus({ force: true, ...fresh }).catch(() => {});
    if ((await setupState()).ready) {
      await db.setMeta(SETUP_DONE_META, { at: now(), legs: MIRROR_LEGS.length });
    }
  }

  // ── A COUNT REPAIRED BY ITS KEYS ──────────────────────────────────────────
  //
  // Returns what it did, or null when this leg cannot be repaired this way —
  // never a half-repair: the one write is a single transaction at the end.
  //
  // WHAT MAKES IT SAFE TO DELETE A ROW HERE. Nothing is deleted because a key
  // list came back without it. A row the server's key list does not name is
  // READ, by its own path, and deleted only if that read answers null — the
  // same rule, and the same evidence, the change feed deletes on. A key list
  // that was somehow short would cost reads, never rows.
  async function reconcileLegKeys(leg) {
    if (typeof adapter.shallowKeys !== "function") return null;
    if (leg.store === "docs" || leg.depth < 1) return null;      // small shared-store legs: the walk is a few KB
    // NOT THE TWO HISTORIES, and not any leg too big for its key list to be
    // cheap. /insights_log is ~160,000 keys — 4–5 MB of keys alone, a
    // whole-node read in all but name — and a history is repaired by its own
    // forward walk anyway. Decided BEFORE anything is read.
    if (isAppendOnly(leg)) return null;
    const heldCount = (await heldRows(db, leg.name)) ?? 0;
    if (heldCount === 0) return null;                            // nothing to repair: that is a download
    if (heldCount > KEYDIFF_MAX_LOCAL_KEYS) return null;
    const localKeys = await db.getAllKeys(leg.store);

    let requests = 0;
    const serverKeys = [];
    const walk = async (path, segments, remaining) => {
      requests += 1;
      if (requests > KEYDIFF_MAX_REQUESTS) throw new KeyDiffNotPossible();
      const keys = await adapter.shallowKeys(path);
      for (const k of keys) {
        // The same refusals flattenPage makes, so the two agree on what a row is.
        if (leg.name === "stock" && segments.length === 0 && !isCanonicalLocationId(k)) continue;
        if (remaining === 1) {
          try { serverKeys.push(rowKey([...segments, k])); } catch { /* unrepresentable: not a row here either */ }
        } else {
          await walk(`${path}/${k}`, [...segments, k], remaining - 1);
        }
      }
    };
    try { await walk(leg.node, [], leg.depth); }
    catch (err) {
      if (err instanceof KeyDiffNotPossible) return null;
      throw err;
    }

    const onServer = new Set(serverKeys);
    const held = new Set(localKeys.map(String));
    const missing = serverKeys.filter((k) => !held.has(k));
    const extra = [...held].filter((k) => !onServer.has(k));
    const differing = missing.length + extra.length;
    const most = Math.min(KEYDIFF_MAX_ROW_READS,
      Math.max(50, Math.floor(serverKeys.length * KEYDIFF_MAX_FRACTION)));
    if (differing > most) return null;                           // too different: the walk is cheaper

    const NOT_READABLE = Symbol("not-readable");
    const readRow = (key) => adapter.readPath(rowPath(leg, key)).catch((err) => {
      if (isPermissionDenied(err)) return NOT_READABLE;
      throw err;
    });

    // ── ARE THE VALUES STILL TRUE? ──────────────────────────────────────────
    // A few rows both sides hold, picked at random, re-read and compared. See
    // KEYDIFF_SAMPLE: this is the only thing left that can notice a lost EDIT.
    const both = serverKeys.filter((k) => held.has(k));
    const sample = [];
    for (let i = 0; i < KEYDIFF_SAMPLE && both.length > 0; i += 1) {
      const at = Math.min(both.length - 1, Math.floor(random() * both.length));
      sample.push(both.splice(at, 1)[0]);
    }
    const sampleValues = await mapWithLimit(sample, ROW_CONCURRENCY, readRow);
    const stale = [];
    for (let i = 0; i < sample.length; i += 1) {
      if (sampleValues[i] === NOT_READABLE) continue;
      const local = await db.get(leg.store, storeKey(leg, sample[i]));
      if (!sameValue(local ?? null, sampleValues[i] ?? null)) stale.push({ key: sample[i], value: sampleValues[i] });
    }
    // Too many: the copy's VALUES are in doubt, and no key list can fix that.
    if (stale.length > KEYDIFF_SAMPLE_TOLERATED) return null;

    const keys = [...missing, ...extra];
    const values = await mapWithLimit(keys, ROW_CONCURRENCY, readRow);
    const records = [];
    const deleteKeys = [];
    // The stale rows the sample did find are put right while we are here.
    for (const { key, value } of stale) {
      if (value === null || value === undefined) deleteKeys.push(storeKey(leg, key));
      else records.push({ key: storeKey(leg, key), value });
    }
    for (let i = 0; i < keys.length; i += 1) {
      const value = values[i];
      if (value === NOT_READABLE) continue;
      if (value === null || value === undefined) deleteKeys.push(storeKey(leg, keys[i]));
      else records.push({ key: storeKey(leg, keys[i]), value });
    }

    const at = now();
    const rowsAfter = held.size
      + records.filter((r) => !held.has(r.key)).length
      - deleteKeys.filter((k) => held.has(k)).length;
    // An empty result for a node that cannot be empty is a broken read, here
    // as everywhere else. Nothing has been written; the walk decides.
    if (rowsAfter === 0 && !CAN_BE_EMPTY.has(leg.name)) return null;
    await db.putPage(leg.store, records, {
      deleteKeys,
      metaEntries: {
        ...healthyMeta(leg.name, { path: leg.node, rows: rowsAfter, at }),
        [LAST_SYNC_META(leg.name)]: at,
        // `keysAt`: this copy's key set was compared with the server's at this
        // moment. A census taken BEFORE it has nothing to add (checkCensus).
        [`${SETUP_META_PREFIX}${leg.name}`]: { at, rows: rowsAfter, pager: PAGER_VERSION, keysAt: at },
      },
    });
    const landed = (await heldRows(db, leg.name)) ?? 0;
    if (landed !== rowsAfter) {
      await db.setMetaMany(healthyMeta(leg.name, { path: leg.node, rows: landed, at }));
    }
    return {
      rows: landed, via: "key-diff",
      added: records.filter((r) => !held.has(r.key)).length,
      removed: deleteKeys.length,
      ...(stale.length ? { refreshed: stale.length } : {}),
    };
  }

  // A benched feed: the change-fed legs keep their rows and their setup
  // markers (nothing re-downloads) but stop VOUCHING, so no screen is served a
  // copy nobody is keeping current. The next open tries the feed again.
  async function unserveChangeFedLegs(err) {
    for (const leg of MIRROR_LEGS.filter((l) => !isAppendOnly(l))) {
      // A leg already failing for its own reason keeps that reason — it is
      // the more useful one on the fleet screen — but it may still be vouched
      // for (a refused shrink keeps its last good copy), so the vouch goes.
      // The vouch is PARKED on the record, not thrown away, so the feed coming
      // back can restore exactly what was there (reserveChangeFedLegs).
      const prior = await getLegHealth(db, leg.name);
      if (prior?.ok === false) {
        if (prior.feedParked) continue;
        // `heldRows` vouches too, on a refused-shrink record (health.js
        // isRefusedRead), so it is parked with the vouch.
        const { vouched, heldRows: held, ...rest } = prior;
        await db.setMetaMany({
          [healthKey(leg.name)]: {
            ...rest, feedParked: true, parkedVouch: vouched ?? null, parkedHeldRows: held ?? null,
          },
        });
        continue;
      }
      await recordLegFailed(db, leg.name, {
        path: leg.node, reason: "feed-stuck", at: now(), state: "failed",
        retryable: false, keepVouched: false, detail: err.message,
      });
    }
  }

  async function reserveChangeFedLegs() {
    for (const leg of MIRROR_LEGS.filter((l) => !isAppendOnly(l))) {
      const health = await getLegHealth(db, leg.name);
      if (health?.feedParked) {
        // Its own failure stands; only the vouch the feed took away comes back.
        const { feedParked, parkedVouch, parkedHeldRows, ...rest } = health;
        await db.setMetaMany({
          [healthKey(leg.name)]: {
            ...rest,
            ...(parkedVouch ? { vouched: parkedVouch } : {}),
            ...(parkedHeldRows !== null && parkedHeldRows !== undefined ? { heldRows: parkedHeldRows } : {}),
          },
        });
        continue;
      }
      if (health?.reason !== "feed-stuck") continue;
      const rows = (await heldRows(db, leg.name)) ?? 0;
      if (rows === 0 && !CAN_BE_EMPTY.has(leg.name)) continue;
      await db.setMetaMany(healthyMeta(leg.name, { path: leg.node, rows, at: now() }));
    }
  }

  // ── THE FEED STARTS AGAIN FROM THE HEAD OF THE LOG ────────────────────────
  //
  // A cursor that has fallen off the back of retention, or is simply not
  // there, cannot be resumed: changes may have been swept that this device
  // never saw. Every change-fed leg it holds is marked for a fresh download.
  //
  // AND THE NEW CURSOR IS TAKEN HERE, FIRST — not left for "the next setup
  // run". It used to be dropped, and that was a trap with no way out (fleet,
  // 19 Oct – 11 Nov 2026, one handset for two weeks): the pass loop repairs
  // legs itself and never runs the setup that would have taken a cursor, so
  // the next pass read the log from its FIRST record, stored that page's last
  // key as the cursor — a key thirty days old, inside the one-day safety
  // margin by construction — and the pass after that found the cursor
  // "expired" again and marked every leg again. Each lap re-read the same 500
  // records and their rows and repaired one leg (always the first), for ever;
  // and with no cursor the live signal subscribed to the whole log.
  //
  // Taken BEFORE the legs are re-read, for the reason runSetup takes it first:
  // whatever is written while they download is replayed afterwards rather
  // than skipped. If the log cannot be reached, this throws having changed
  // nothing, and the next pass meets the same wall.
  async function resetFeedCursor(reason, detail) {
    const head = await changeCursorAtSetupStart({ adapter });
    const marked = [];
    for (const leg of MIRROR_LEGS.filter((l) => !isAppendOnly(l))) {
      const marker = await db.getMeta(`${SETUP_META_PREFIX}${leg.name}`);
      // Decided (not readable by this account): nothing to redo.
      if (marker?.notPermitted) continue;
      // EVERY LEG THAT HOLDS ROWS, marker or not. A leg waiting for a
      // count-drift repair has already lost its marker, and if it were passed
      // over here it would keep that reason and be repaired by its KEYS — which
      // puts back missing rows and leaves every value that changed in the gap
      // stale, then stamps the leg healthy. With its reason replaced it takes
      // the walk like the rest.
      if (!marker && ((await heldRows(db, leg.name)) ?? 0) === 0) continue;
      await recordLegFailed(db, leg.name, {
        path: leg.node, reason, at: now(), state: "failed",
        retryable: false, keepVouched: false, detail,
      });
      marked.push(leg.name);
    }
    // One transaction: the new cursor, and the markers it invalidates. The
    // journal of what the feed has carried describes the old cursor's run and
    // goes with it (censusJournal.js starts a new one from the new cursor).
    await db.setMetaMany({ [FEED_CURSOR_META]: head }, {
      deleteKeys: [
        ...marked.map((name) => `${SETUP_META_PREFIX}${name}`),
        ...(marked.length ? [SETUP_DONE_META] : []),
        TOUCHED_META,
      ],
    });
    return marked;
  }

  // How many of an append-only leg's rows were written at or after `ms`. The
  // key (a push key) or the indexed `ts` IS the write time, so this is a count
  // over the tail of the store. Zero when it cannot be asked: the allowance is
  // then the leg's plain tolerance, as it was before.
  // Has an append-only leg's forward walk got as far as `ms`? Its cursor is
  // the newest row it holds, and that row's key (or `ts`) is a time.
  async function walkedPast(leg, ms) {
    const cursor = await db.getMeta(CURSOR_META(leg.name));
    if (cursor === null || cursor === undefined) return false;
    const at = leg.feed === "keyRange"
      ? msFromPushKey(cursor)
      : Date.parse(typeof cursor === "string" ? cursor : cursor.ts);
    return Number.isFinite(at) && at >= ms;
  }

  async function rowsNewerThan(leg, ms) {
    try {
      if (leg.feed === "keyRange") return await db.countFrom(leg.store, pushKeyPrefixForMs(ms));
      return await db.countFrom(leg.store, new Date(ms).toISOString(), { index: leg.tsField });
    } catch { return 0; }
  }

  // ── THE CENSUS CHECK ──────────────────────────────────────────────────────
  //
  // The only check in this file that is not local. See the header — both
  // halves of it: what the census is for, and what it did to the fleet when a
  // day-old count was compared with a live one.
  //
  // `feedCaughtUp` — did this pass read the change feed to its end? A device
  // opened after a night has a backlog, and until it has applied it the copy
  // is YESTERDAY's being compared with this morning's count.
  //   · A SCHEDULED check simply waits for a pass that has caught up. It costs
  //     nothing to wait: nothing is read.
  //   · A FORCED check — straight after a download, so that a first copy is
  //     verified before it is served — cannot wait. It reads what the feed
  //     has not applied yet (pointer records only) and allows for it.
  //
  // The two histories answer the same question for themselves: one whose walk
  // has not reached the end in the last few minutes (`rangeEndAt`), and has
  // not yet walked past the moment the census was taken, is behind by
  // construction and is not judged.
  //
  // `afterDownload` — this is THE forced census that verifies a download that
  // has just finished. It always runs; no rate limit applies to it.
  async function checkCensus({ force = false, feedCaughtUp = false, afterDownload = false } = {}) {
    const lastChecked = (await db.getMeta(CENSUS_CHECKED_META)) ?? 0;
    const at = now();
    if (!force && at - lastChecked < CENSUS_CHECK_MS) return { skipped: "not-due" };
    if (!force && !feedCaughtUp) return { skipped: "feed-behind" };
    // A device with a parked leg is never "complete", so every open forces a
    // census. The census is written once a day; it is not asked more than
    // twice an hour on that account.
    if (force && !afterDownload && at - lastChecked >= 0 && at - lastChecked < PARKED_CENSUS_EVERY_MS
      && (await parkedLegs()).length > 0) return { skipped: "parked-checked-recently" };

    const counts = await adapter.readPath(COUNTS_ROOT);
    // NO CENSUS IS NOT A VERDICT. Before the functions are deployed, or if the
    // census failed last night, this node is absent — and treating that as
    // "every leg is wrong" would send the whole estate back to a 104 MB
    // download at once, which is the opposite of the point.
    if (!counts || typeof counts !== "object") return { skipped: "no-census" };

    const usable = (leg) => {
      const entry = counts[leg.name];
      if (!entry || !Number.isFinite(entry.rows) || !Number.isFinite(entry.at)) return null;
      if (at - entry.at > CENSUS_MAX_AGE_MS) return null;      // stale: not evidence
      return entry;
    };

    // What the change feed has carried since the census — and, when the feed
    // has not caught up, what it has yet to carry — asked for once, and only
    // if a change-fed leg is actually going to be judged.
    let journal;
    let pending = {};
    const journalFor = async () => {
      if (journal !== undefined) return journal;
      const ats = MIRROR_LEGS.filter((l) => !isAppendOnly(l)).map((l) => usable(l)?.at)
        .filter((t) => Number.isFinite(t));
      journal = null;
      if (ats.length) {
        const feedCursor = await db.getMeta(FEED_CURSOR_META);
        journal = await coverSince(db, adapter, {
          censusAt: Math.min(...ats), feedCursor, changesRoot: CHANGES_ROOT, now,
        }).catch(() => null);
        if (journal && !feedCaughtUp) {
          pending = await pendingTouched(adapter, { feedCursor, changesRoot: CHANGES_ROOT }).catch(() => null);
          // A backlog too long to count: the copy is too far behind to judge.
          if (!pending) journal = null;
        }
      }
      return journal;
    };

    const acted = { ...((await db.getMeta(CENSUS_ACTED_META)) ?? {}) };
    const drifted = [];
    const checked = [];
    // Disagrees with a census this leg has ALREADY been repaired for.
    const unresolved = [];
    // A change-fed leg with no journal behind it: the census is not evidence.
    const unjudged = [];
    const agreed = [];
    const censusAtOf = new Map();
    for (const leg of MIRROR_LEGS) {
      const entry = usable(leg);
      if (!entry) continue;
      // A benched leg is already failed and named; a census verdict over the
      // top would hide WHY (it is short because it was benched).
      if (legGate(leg.name).benched) continue;
      // Not mirrored for this account: there is nothing local to count.
      if (await notPermitted(leg)) continue;
      // NOT DOWNLOADED YET is not DRIFT. A download that gave up part-way used
      // to census every leg, found 0 rows where the server has 38 users, and
      // painted "does not match the server's count" on legs it had simply not
      // reached. Only a leg this device claims to hold is judged.
      const marker = await db.getMeta(`${SETUP_META_PREFIX}${leg.name}`);
      if (!marker) continue;
      // A COPY WHOSE KEYS WERE COMPARED WITH THE SERVER'S AFTER THIS CENSUS
      // WAS TAKEN has been checked against something newer and stricter than
      // the census. An older count has nothing to add about it.
      if (Number.isFinite(marker.keysAt) && marker.keysAt > entry.at) continue;

      let churn = 0;
      let newer = 0;
      let band = 0;
      if (!isAppendOnly(leg)) {
        const j = await journalFor();
        if (j) {
          // Never more than a tenth of the leg, whatever the feed says.
          churn = Math.min(
            touchedSince(j, leg.name, entry.at) + (pending[leg.name] ?? 0),
            Math.floor(entry.rows * CENSUS_CHURN_CAP),
          );
        } else if (!(force && Number.isFinite(marker.at) && at - marker.at >= 0 && at - marker.at <= JUST_DOWNLOADED_MS)) {
          // No journal, and not a copy that has just been downloaded: the
          // census is not evidence about it.
          unjudged.push(leg.name);
          continue;
        }
        // …but A COPY JUST DOWNLOADED IS ALWAYS CHECKED, journal or no. On a
        // day too busy to rebuild a journal for, "not judged" would serve a
        // first download nobody had verified — the one moment the census is
        // the only guard there is. It is held to the plain tolerance: a false
        // alarm costs one repair (by keys, where the leg allows), and a
        // truncated catalogue is not served.
      } else {
        // A history still walking forward is behind by construction — unless
        // its walk has already passed the moment the census was taken.
        const endedAt = rangeEndAt.get(leg.name);
        const justCaughtUp = Number.isFinite(endedAt) && at - endedAt <= CENSUS_CLOCK_MARGIN_MS;
        if (!justCaughtUp && !(await walkedPast(leg, entry.at - CENSUS_CLOCK_MARGIN_MS))) {
          unjudged.push(leg.name);
          continue;
        }
        // An append-only leg needs no journal: every row it holds that is
        // NEWER than the census is, exactly, what has been added since. It is
        // counted off the tail of the store without loading a row — and TAKEN
        // OFF what is held, not added to the allowance: 1,400 held against a
        // census of 1,300 looks close, and is 300 short if 400 of them are
        // today's.
        //
        // A row's time here is the clock of the till that wrote it, so rows
        // stamped within the margin either side of the census may or may not
        // have been counted. Those SURELY newer are taken off; the ones in
        // the band are allowed for, in the one direction they can err.
        newer = await rowsNewerThan(leg, entry.at + CENSUS_CLOCK_MARGIN_MS);
        band = Math.max(0, (await rowsNewerThan(leg, entry.at - CENSUS_CLOCK_MARGIN_MS)) - newer);
      }
      const held = ((await heldRows(db, leg.name)) ?? 0) - newer;
      checked.push(leg.name);
      // The leg's own tolerance, PLUS every row the feed has carried since the
      // census was taken: the most the count can honestly have moved.
      const base = Math.max(25, Math.floor(entry.rows * leg.censusTolerance)) + churn;
      const allowed = held > entry.rows ? base + band : base;
      if (Math.abs(held - entry.rows) <= allowed) { agreed.push({ leg: leg.name, marker }); continue; }
      censusAtOf.set(leg.name, { censusAt: entry.at, marker });
      const verdict = { leg: leg.name, held, census: entry.rows, allowed };
      // ONE REPAIR PER LEG PER CENSUS. This census has already sent this leg
      // for repair once. A copy that still disagrees with the SAME census will
      // disagree after a third download too, and a fourth — that is the storm.
      if (acted[leg.name] === entry.at) { unresolved.push(verdict); continue; }
      acted[leg.name] = entry.at;
      drifted.push(verdict);
    }

    for (const d of drifted) {
      const leg = LEG_BY_NAME[d.leg];
      await recordLegFailed(db, d.leg, {
        path: leg.node, reason: "count-drift", at, state: "failed",
        retryable: false, keepVouched: false,
        detail: `this device holds ${d.held} rows where the server counted ${d.census} `
          + `(allowance ${d.allowed}). A change record was probably never written. `
          + "Repairing this leg.",
      });
      // Dropping the setup marker is what makes the pass repair just this leg.
      // The rows stay on disk until the repair lands.
      await db.deleteMetaMany([`${SETUP_META_PREFIX}${d.leg}`, SETUP_DONE_META]);
    }

    // STILL DISAGREEING AFTER ITS ONE REPAIR. Not downloaded again. What it
    // may still do depends on which way it disagrees:
    //   · it holds MORE than the census counted — it cannot be a truncated
    //     copy, and it is what the server sent: it goes on being served;
    //   · it holds FEWER — that is the shape of a download that stopped short
    //     (the POS mirror's 799 of 4,665), so it is NOT served: the screens
    //     read live until the next census can judge it again. Its marker
    //     stays, so nothing re-downloads it meanwhile.
    for (const u of unresolved) {
      if (u.held >= u.census) continue;
      // A history is never downloaded again by its repair (the walk carries
      // on from its cursor), so there is no storm to park it against; it is
      // served as it was, and named in `unresolved`.
      if (isAppendOnly(LEG_BY_NAME[u.leg])) continue;
      const { censusAt, marker } = censusAtOf.get(u.leg);
      if (marker.censusRefused === censusAt) continue;         // already parked for this census
      await recordLegFailed(db, u.leg, {
        path: LEG_BY_NAME[u.leg].node, reason: "count-drift", at, state: "failed",
        retryable: false, keepVouched: false,
        detail: `still ${u.held} rows where the server counted ${u.census} after one repair `
          + "for this census. Not downloaded again; read live until the next census.",
      });
      await db.setMetaMany(
        { [`${SETUP_META_PREFIX}${u.leg}`]: { ...marker, censusRefused: censusAt } },
        { deleteKeys: [SETUP_DONE_META] },
      );
    }
    // …and a leg parked that way comes back the moment a census agrees.
    let unparked = 0;
    for (const { leg: name, marker } of agreed) {
      if (!censusParked(marker)) continue;
      unparked += 1;
      const { censusRefused, ...rest } = marker;
      const rows = (await heldRows(db, name)) ?? 0;
      await db.setMetaMany({
        ...healthyMeta(name, { path: LEG_BY_NAME[name].node, rows, at }),
        [`${SETUP_META_PREFIX}${name}`]: rest,
      });
    }

    await db.setMetaMany({ [CENSUS_CHECKED_META]: at, [CENSUS_ACTED_META]: acted });
    // The leg that was holding the device back from "complete" is back.
    if (unparked && (await setupState()).ready) {
      await db.setMeta(SETUP_DONE_META, { at, legs: MIRROR_LEGS.length });
    }
    return { checked, drifted, unresolved, unjudged };
  }

  return {
    runSetup, setupState, legIsSetUp, runPass, runRangeLeg,
    downloadSnapshotLeg, checkCensus, repairOneLeg, legFailures, retireOldPagerCopies,
    clearNotPermitted, checkAccess, reconcileLegKeys, resetFeedCursor, parkedLegs,
  };
}
