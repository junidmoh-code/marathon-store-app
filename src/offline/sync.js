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
  isPermissionDenied,
  FEED_CURSOR_META, COUNTS_ROOT, CHANGES_ROOT,
} from "./changeFeed";
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

  function legGate(legName) {
    const f = failures.get(legName);
    if (!f) return { ok: true };
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

  // ── one leg's snapshot download ───────────────────────────────────────────
  async function downloadSnapshotLeg(leg, { onPage = () => {} } = {}) {
    const at = now();
    let manifest = await readStaging(db, leg.name, {
      scope: leg.node, buildVersion, now,
    });

    // Resume from the last page that actually landed, not from page one.
    for (;;) {
      const page = leg.depth === 0
        ? await adapter.readPath(leg.node, { big: true })
        : await adapter.readKeyPage(leg.node, {
          after: manifest.afterKey, limit: leg.pageSize, big: true,
        });

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
    // A keyRange cursor is a key. A tsRange cursor is a PAIR — { ts, key } —
    // because `ts` is not unique and a bare ts cursor makes every pass re-read
    // every row sharing the newest timestamp, for ever. See rtdbAdapter's
    // childPageConstraints. A cursor stored by an older build is a bare
    // string, which reads as { ts, key: null } and heals on the first page.
    let cursor = (await db.getMeta(cursorMeta)) ?? null;
    if (leg.feed === "tsRange" && typeof cursor === "string") cursor = { ts: cursor, key: null };
    let total = 0;
    let pages = 0;

    for (; pages < maxPages; pages += 1) {
      const page = leg.feed === "keyRange"
        ? await adapter.readKeyPage(leg.node, { after: cursor, limit: leg.pageSize, big: true })
        : await adapter.readChildPage(leg.node, leg.tsField, {
          from: cursor?.ts ?? null, fromKey: cursor?.key ?? null,
          limit: leg.pageSize, big: true,
        });
      const entries = pageEntries(page);
      if (entries.length === 0) break;

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
      if (entries.length < leg.pageSize) { pages += 1; break; }
    }

    const rowsNow = (await heldRows(db, leg.name)) ?? 0;
    if (rowsNow === 0 && !CAN_BE_EMPTY.has(leg.name)) {
      await recordLegFailed(db, leg.name, {
        path: leg.node, reason: "empty", at: now(), state: "failed", retryable: true,
      });
      throw new EmptyMirrorReadError(leg.name, leg.node);
    }
    await db.setMetaMany({
      ...healthyMeta(leg.name, { path: leg.node, rows: rowsNow, at: now() }),
      [`${SETUP_META_PREFIX}${leg.name}`]: { at: now(), rows: rowsNow },
    });
    return { rows: rowsNow, added: total, caughtUp: pages < maxPages };
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
      for (const leg of MIRROR_LEGS) {
        if (!force && await legIsSetUp(leg)) continue;
        todo.push(leg);
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
      if (failed.length) {
        const first = failed.find((f) => f.err)?.err ?? new MirrorSetupIncompleteError(failed);
        try { first.failedLegs = failed.map(({ err, ...f }) => f); } catch { /* frozen */ }
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
  async function runPass() {
    const report = { feed: null, range: [], census: null, errors: [] };

    // 1. The change feed, which is what keeps eighteen legs true — unless it
    // is backing off or benched after stuck pages (FEED_LEDGER).
    const feedGate = legGate(FEED_LEDGER);
    if (!feedGate.ok) {
      report.feed = { applied: 0, deleted: 0, paths: [], skipped: feedGate.benched ? "benched" : "backing-off" };
    } else try {
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
    } catch (err) {
      if (err instanceof CursorExpiredError) {
        // The honest wall. Every change-fed leg is marked for a fresh download
        // and the cursor is dropped, so the next setup run takes a new one.
        await markChangeFedLegsForResetup(err);
        report.errors.push({ where: "feed", reason: "cursor-expired" });
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
    for (const leg of MIRROR_LEGS.filter(isAppendOnly)) {
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
    try { report.census = await checkCensus(); }
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
      report.repaired = mayRepair() ? await repairOneLeg() : null;
    } catch (err) {
      report.errors.push({ where: "repair", reason: err.name, message: err.message });
    }

    return report;
  }

  // The legs that have lost their setup marker, in the order that gets a
  // device working again soonest: the catalogue and the shelf before the
  // history. Returns what it repaired, or null.
  async function repairOneLeg() {
    for (const leg of MIRROR_LEGS) {
      if (await legIsSetUp(leg)) continue;
      // A leg that is backing off or benched is passed over, so one broken leg
      // cannot hold every other repair behind it.
      if (!legGate(leg.name).ok) continue;
      const res = await attemptLeg(leg, () => (isAppendOnly(leg)
        ? runRangeLeg(leg)
        : downloadSnapshotLeg(leg)));
      if (res === null) continue;
      // Re-stamp the whole-device marker only when every leg is back — and
      // ask the census FIRST. A device that becomes complete through repairs
      // reaches exactly the state the download path forces a census for, and
      // it would otherwise not be asked again for six hours.
      if ((await setupState()).ready) {
        await checkCensus({ force: true }).catch(() => {});
        if ((await setupState()).ready) {
          await db.setMeta(SETUP_DONE_META, { at: now(), legs: MIRROR_LEGS.length });
        }
      }
      return { leg: leg.name, rows: res.rows };
    }
    return null;
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

  async function markChangeFedLegsForResetup(err) {
    const keys = [FEED_CURSOR_META];
    for (const leg of MIRROR_LEGS.filter((l) => !isAppendOnly(l))) {
      keys.push(`${SETUP_META_PREFIX}${leg.name}`);
      await recordLegFailed(db, leg.name, {
        path: leg.node, reason: "cursor-expired", at: now(), state: "failed",
        retryable: false, keepVouched: false, detail: err.message,
      });
    }
    keys.push(SETUP_DONE_META);
    await db.deleteMetaMany(keys);
  }

  // ── THE CENSUS CHECK ──────────────────────────────────────────────────────
  //
  // The only check in this file that is not local. See the header.
  async function checkCensus({ force = false } = {}) {
    const lastChecked = (await db.getMeta(CENSUS_CHECKED_META)) ?? 0;
    const at = now();
    if (!force && at - lastChecked < CENSUS_CHECK_MS) return { skipped: "not-due" };

    const counts = await adapter.readPath(COUNTS_ROOT);
    // NO CENSUS IS NOT A VERDICT. Before the functions are deployed, or if the
    // census failed last night, this node is absent — and treating that as
    // "every leg is wrong" would send the whole estate back to a 104 MB
    // download at once, which is the opposite of the point.
    if (!counts || typeof counts !== "object") return { skipped: "no-census" };

    const drifted = [];
    const checked = [];
    for (const leg of MIRROR_LEGS) {
      const entry = counts[leg.name];
      if (!entry || !Number.isFinite(entry.rows) || !Number.isFinite(entry.at)) continue;
      if (at - entry.at > CENSUS_MAX_AGE_MS) continue;    // stale: not evidence
      // A benched leg is already failed and named; a census verdict over the
      // top would hide WHY (it is short because it was benched).
      if (legGate(leg.name).benched) continue;
      // Not mirrored for this account: there is nothing local to count.
      if (await notPermitted(leg)) continue;
      // NOT DOWNLOADED YET is not DRIFT. A download that gave up part-way used
      // to census every leg, found 0 rows where the server has 38 users, and
      // painted "does not match the server's count" on legs it had simply not
      // reached. Only a leg this device claims to hold is judged.
      if (!(await db.getMeta(`${SETUP_META_PREFIX}${leg.name}`))) continue;
      const held = (await heldRows(db, leg.name)) ?? 0;
      checked.push(leg.name);
      const allowed = Math.max(25, Math.floor(entry.rows * leg.censusTolerance));
      if (Math.abs(held - entry.rows) <= allowed) continue;
      drifted.push({ leg: leg.name, held, census: entry.rows, allowed });
    }

    for (const d of drifted) {
      const leg = LEG_BY_NAME[d.leg];
      await recordLegFailed(db, d.leg, {
        path: leg.node, reason: "count-drift", at, state: "failed",
        retryable: false, keepVouched: false,
        detail: `this device holds ${d.held} rows where the server counted ${d.census} `
          + `(tolerance ${d.allowed}). A change record was probably never written. `
          + "Downloading this leg again.",
      });
      // Dropping the setup marker is what makes the next runSetup() re-download
      // just this leg. The rows stay on disk until the replacement lands.
      await db.deleteMetaMany([`${SETUP_META_PREFIX}${d.leg}`, SETUP_DONE_META]);
    }
    await db.setMeta(CENSUS_CHECKED_META, at);
    return { checked, drifted };
  }

  return {
    runSetup, setupState, legIsSetUp, runPass, runRangeLeg,
    downloadSnapshotLeg, checkCensus, repairOneLeg, legFailures, retireOldPagerCopies,
    clearNotPermitted, checkAccess,
  };
}
