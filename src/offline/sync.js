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
  runChangeFeedPage, changeCursorAtSetupStart, CursorExpiredError,
  FEED_CURSOR_META, COUNTS_ROOT,
} from "./changeFeed";
import { isCanonicalLocationId } from "./locationIds";

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
//   stockHold / hiddenProducts / transitConfig / taxonomy — absent means
//     "off"/"none", which is the default these features are written around.
const CAN_BE_EMPTY = new Set([
  "returnsLog", "restockLog", "restockRequests", "clothingOos",
  "displaySlots", "displayRows", "displayRegister",
  "insights", "movements",
  "stockHold", "hiddenProducts", "transitConfig", "taxonomy",
]);

// The legs where an empty read is a FAILED read. /products with no products,
// /stock with no cells, /locations with no locations and /users with no users
// are all impossible states of this business, so reading one means the read
// was wrong — a permission change, a renamed path, a truncated response.
export const MUST_NOT_BE_EMPTY = Object.freeze(
  MIRROR_LEGS.filter((l) => !CAN_BE_EMPTY.has(l.name)).map((l) => l.name),
);

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

  for (const [top, subtree] of Object.entries(page ?? {})) {
    if (subtree === null || subtree === undefined) continue;
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
} = {}) {
  let setupRunning = null;

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

      const keys = Object.keys(page ?? {});
      if (keys.length === 0) break;
      const { rows, skipped } = flattenPage(leg, page);
      const lastKey = keys.reduce((a, b) => (b > a ? b : a));
      manifest = await appendStagingChunk(db, leg.name, {
        manifest, rows, afterKey: lastKey, now,
      });
      onPage({ leg: leg.name, rows: manifest.rows, skipped });
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
      [`${SETUP_META_PREFIX}${leg.name}`]: { at, rows: records.length },
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
    let cursor = (await db.getMeta(cursorMeta)) ?? null;
    let total = 0;
    let pages = 0;

    for (; pages < maxPages; pages += 1) {
      const page = leg.feed === "keyRange"
        ? await adapter.readKeyPage(leg.node, { after: cursor, limit: leg.pageSize, big: true })
        : await adapter.readChildPage(leg.node, leg.tsField, {
          from: cursor, limit: leg.pageSize, big: true,
        });
      const entries = Object.entries(page ?? {});
      if (entries.length === 0) break;

      const records = entries.map(([key, value]) => ({ key, value }));
      let nextCursor;
      if (leg.feed === "keyRange") {
        nextCursor = records.reduce((a, r) => (r.key > a ? r.key : a), records[0].key);
      } else {
        // The LARGEST ts in the page. The query is inclusive of the cursor
        // because `ts` is not unique — one transfer writes several movements
        // with an identical ISO string — so an exclusive bound would skip
        // every movement sharing the cursor's timestamp but the one that set
        // it. The overlap is re-read and upserted, which costs nothing.
        nextCursor = records.reduce((a, r) => {
          const t = r.value && r.value[leg.tsField];
          return typeof t === "string" && t > a ? t : a;
        }, String(cursor ?? ""));
      }

      // A ts page that cannot advance its cursor would loop for ever. This
      // happens when more rows share one timestamp than fit in a page — real,
      // for a bulk transfer — so it is a named failure, not a hang.
      if (leg.feed === "tsRange" && cursor !== null && nextCursor === cursor
        && entries.length >= leg.pageSize) {
        await recordLegFailed(db, leg.name, {
          path: leg.node, reason: "cursor-stuck", at: now(), state: "failed", retryable: false,
          detail: `${entries.length} rows share the timestamp "${cursor}", which is at or over `
            + `the page size of ${leg.pageSize}. The walk cannot advance without skipping rows.`,
        });
        throw new Error(
          `offline mirror: the "${leg.name}" walk cannot advance past "${cursor}"`,
        );
      }

      const at = now();
      await db.putPage(leg.store, records, {
        cursorKey: cursorMeta,
        cursorValue: nextCursor,
        metaEntries: { [LAST_SYNC_META(leg.name)]: at },
      });
      total += records.length;
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
  async function runSetup({ force = false } = {}) {
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

      const done = [];
      for (let i = 0; i < todo.length; i += 1) {
        const leg = todo[i];
        onProgress({ phase: "setup", leg: leg.name, done: i, total: todo.length });
        const res = isAppendOnly(leg)
          ? await runRangeLeg(leg)
          : await downloadSnapshotLeg(leg, {
            onPage: ({ rows }) => onProgress({
              phase: "setup", leg: leg.name, done: i, total: todo.length, rows,
            }),
          });
        done.push({ leg: leg.name, rows: res.rows });
        onProgress({ phase: "setup", leg: leg.name, done: i + 1, total: todo.length, rows: res.rows });
      }

      await db.setMeta(SETUP_DONE_META, { at: now(), legs: MIRROR_LEGS.length });
      return { alreadyDone: false, legs: done };
    })().finally(() => { setupRunning = null; });
    return setupRunning;
  }

  // A leg counts as set up only if BOTH its setup marker and its health record
  // stand, and the health record is backed by rows actually in the store. A
  // marker alone is how a device walks past the setup screen into a blank app.
  async function legIsSetUp(leg) {
    const marker = await db.getMeta(`${SETUP_META_PREFIX}${leg.name}`);
    if (!marker) return false;
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

    // 1. The change feed, which is what keeps eighteen legs true.
    try {
      let applied = 0;
      let deleted = 0;
      for (let i = 0; i < FEED_PAGES_PER_PASS; i += 1) {
        const res = await runChangeFeedPage({ db, adapter, now });
        applied += res.applied;
        deleted += res.deleted;
        if (res.done) break;
      }
      report.feed = { applied, deleted };
    } catch (err) {
      if (err instanceof CursorExpiredError) {
        // The honest wall. Every change-fed leg is marked for a fresh download
        // and the cursor is dropped, so the next setup run takes a new one.
        await markChangeFedLegsForResetup(err);
        report.errors.push({ where: "feed", reason: "cursor-expired" });
      } else {
        report.errors.push({ where: "feed", reason: err.name, message: err.message });
      }
    }

    // 2. The two forward walks.
    for (const leg of MIRROR_LEGS.filter(isAppendOnly)) {
      try {
        const res = await runRangeLeg(leg, { maxPages: RANGE_PAGES_PER_PASS });
        report.range.push({ leg: leg.name, added: res.added });
      } catch (err) {
        report.errors.push({ where: leg.name, reason: err.name, message: err.message });
      }
    }

    // 3. The outside opinion.
    try { report.census = await checkCensus(); }
    catch (err) { report.errors.push({ where: "census", reason: err.name, message: err.message }); }

    return report;
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
    downloadSnapshotLeg, checkCensus,
  };
}
