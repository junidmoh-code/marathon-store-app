// ─── OFFLINE MIRROR — WHAT CHANGED SINCE THE CENSUS WAS TAKEN ────────────────
//
// THE INCIDENT THIS CLOSES (cost watch, 28 Oct – 10 Nov 2026). The census is
// counted ONCE A DAY, at 04:15. A device's own count follows the database all
// day, through the change feed. Comparing the two is comparing this afternoon
// with this morning — and the tolerance for that was max(25 rows, 2%).
//
// On an ordinary day nothing moves that far. On 10 Nov a display re-check
// rewrote 700 /settings/displaySlots rows, 448 displayRows and 272 register
// rows before 16:00, against tolerances of 35, 43 and 31. From late morning
// every device that asked the census was told three healthy legs were wrong,
// downloaded them again, got a copy that matched the DATABASE and so still did
// not match the morning's census, and was told again — until the next census
// at 04:15. On 30 Oct the same thing happened to /products (616 rows changed)
// and /stock. None of those legs had drifted. The census had aged.
//
// So the device keeps a small journal of how many rows of each leg the change
// feed has told it about, by the hour the change was RECORDED (the push key's
// own time — not when this device got round to reading it, so a tablet that
// was shut all night still files last night's changes under last night).
// A census taken at T is then compared with an allowance widened by the rows
// recorded since T: they are the most the count can honestly have moved.
//
// WHAT THIS DOES NOT HIDE. The census exists to catch a change record that was
// NEVER WRITTEN, and a record that was never written is, by definition, not in
// this journal. A real hole still shows as a disagreement beyond the
// allowance. What the journal removes is only the disagreement the feed itself
// explains.
//
// ── CONSERVATIVE IN ONE DIRECTION ONLY ──────────────────────────────────────
//
// Every approximation here over-counts, never under-counts:
//   · a page's rows are all filed under the hour of the page's LAST record;
//   · the hour containing T is counted whole;
//   · the journal is written BEFORE the page commits, so a page that fails and
//     is read again is counted twice.
// Over-counting widens an allowance for a day. Under-counting is a false
// "count-drift", which is the thing this file is here to end.

import { LEG_BY_NODE } from "./nodes";
import { pageEntries, compareKeys } from "./rtdbOrder";

export const TOUCHED_META = "setup.censusTouched";
// Which census a leg has already been repaired for: { [leg]: census `at` }.
export const CENSUS_ACTED_META = "setup.censusActed";

const HOUR_MS = 60 * 60 * 1000;
// Longer than sync.js CENSUS_MAX_AGE_MS (48 h): a census the engine will still
// act on must still be inside the journal.
export const TOUCHED_KEEP_MS = 72 * HOUR_MS;
// The census stamps `at` when its run STARTS and counts for a minute or two
// after; a trigger can also write its record a little after the write it
// describes. Anything recorded this close before `at` may or may not be in
// the count, so it is allowed for.
export const CENSUS_CLOCK_MARGIN_MS = 10 * 60 * 1000;
// How far a missing stretch of journal may be rebuilt from the change log's
// KEYS (no rows are read). 30 pages of 500 is five ordinary days of records
// and about 1.3 MB at the very worst; an ordinary rebuild — a first setup at
// midday — is a quarter of a megabyte, once.
export const BACKFILL_PAGE_SIZE = 500;
export const BACKFILL_MAX_PAGES = 30;

const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";

// The epoch milliseconds a push key encodes. Same arithmetic as
// changeFeed.msFromPushKey; kept here too so this module imports nothing from
// the feed (the feed imports this).
function keyMs(key) {
  if (typeof key !== "string" || key.length < 8) return null;
  let n = 0;
  for (let i = 0; i < 8; i += 1) {
    const d = PUSH_CHARS.indexOf(key[i]);
    if (d < 0) return null;
    n = n * 64 + d;
  }
  return n;
}

// The 8-character key PREFIX for a millisecond: it sorts before every push key
// minted in that millisecond, so it is a lower bound for a key range. The
// inverse of keyMs; pinned against changeFeed.msFromPushKey and the functions'
// lib.cjs in __tests__/censusJournal.test.js.
export function pushKeyPrefixForMs(ms) {
  let n = Math.max(0, Math.floor(Number(ms) || 0));
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out = PUSH_CHARS[n % 64] + out;
    n = Math.floor(n / 64);
  }
  return out;
}

const hourOf = (ms) => Math.floor(ms / HOUR_MS);
// { leg: { hour: n } }, copied two levels deep. Not structuredClone: some of
// the tablets this runs on predate it.
const copyLegs = (legs) => Object.fromEntries(
  Object.entries(legs ?? {}).map(([leg, hours]) => [leg, { ...hours }]),
);
const emptyJournal = (from) => ({ from, throughKey: null, legs: {} });
const isJournal = (j) => !!j && typeof j === "object" && Number.isFinite(j.from)
  && j.legs && typeof j.legs === "object";

function prune(journal, nowMs) {
  const horizon = nowMs - TOUCHED_KEEP_MS;
  const firstHour = hourOf(horizon);
  const legs = {};
  for (const [leg, hours] of Object.entries(journal.legs)) {
    const kept = {};
    for (const [h, n] of Object.entries(hours)) if (Number(h) >= firstHour) kept[h] = n;
    if (Object.keys(kept).length) legs[leg] = kept;
  }
  // What was pruned is no longer covered, and the journal must say so.
  return { ...journal, from: Math.max(journal.from, horizon), legs };
}

function add(journal, legName, atMs, n) {
  if (!(n > 0)) return;
  const h = String(hourOf(atMs));
  const hours = journal.legs[legName] ?? (journal.legs[legName] = {});
  hours[h] = (hours[h] ?? 0) + n;
}

/**
 * File one change-feed page's rows in the journal. Called by
 * changeFeed.runChangeFeedPage BEFORE the page commits (see the header).
 *
 * `cursor` is where the page was read FROM and `lastKey` where it ended; the
 * journal is continuous for as long as each page starts at or before where
 * the last one ended. A cursor that has jumped AHEAD of the journal (it was
 * reset to the head of the log) leaves records nobody journaled in between, so
 * the journal starts again from there rather than claim a stretch it has not
 * seen.
 */
export async function noteTouched(db, { cursor, lastKey, rows, now = Date.now }) {
  const nowMs = now();
  const cursorMs = cursor === null || cursor === undefined ? 0 : (keyMs(cursor) ?? nowMs);
  const lastMs = keyMs(lastKey) ?? nowMs;
  await db.updateMeta(TOUCHED_META, (prev) => {
    let journal = isJournal(prev) ? { ...prev, legs: copyLegs(prev.legs) } : null;
    const jumped = journal && journal.throughKey !== null && journal.throughKey !== undefined
      && cursor !== null && cursor !== undefined && compareKeys(cursor, journal.throughKey) > 0;
    if (!journal || jumped) journal = emptyJournal(cursorMs);
    const perLeg = new Map();
    for (const { leg } of rows) perLeg.set(leg.name, (perLeg.get(leg.name) ?? 0) + 1);
    for (const [name, n] of perLeg) add(journal, name, lastMs, n);
    if (journal.throughKey === null || journal.throughKey === undefined
      || compareKeys(lastKey, journal.throughKey) > 0) journal.throughKey = lastKey;
    return prune(journal, nowMs);
  });
}

/** Rows of `leg` recorded since a census taken at `censusAt`, per the journal. */
export function touchedSince(journal, legName, censusAt) {
  if (!isJournal(journal)) return 0;
  const firstHour = hourOf(censusAt - CENSUS_CLOCK_MARGIN_MS);
  let n = 0;
  for (const [h, count] of Object.entries(journal.legs[legName] ?? {})) {
    if (Number(h) >= firstHour) n += count;
  }
  return n;
}

/**
 * A journal that covers everything recorded since `censusAt`, or null when
 * there cannot be one — in which case the census is NOT EVIDENCE about the
 * change-fed legs and must not be acted on.
 *
 * The journal normally covers it already. It does not on a device that has
 * just taken its feed cursor (a first setup at midday starts the feed from the
 * head of the log, hours after the census) or has just upgraded to this build.
 * The missing stretch is then rebuilt from the change log's own records —
 * pointer records of ~85 bytes, read in pages, no row ever fetched — from the
 * census up to where the journal (or the feed cursor) begins.
 */
export async function coverSince(db, adapter, {
  censusAt, feedCursor, changesRoot, now = Date.now,
  pageSize = BACKFILL_PAGE_SIZE, maxPages = BACKFILL_MAX_PAGES,
}) {
  const nowMs = now();
  const needFrom = censusAt - CENSUS_CLOCK_MARGIN_MS;
  if (needFrom < nowMs - TOUCHED_KEEP_MS) return null;      // older than the journal ever keeps

  const held = await db.getMeta(TOUCHED_META);
  let journal = isJournal(held) ? held : null;
  if (journal && journal.from <= needFrom) return journal;

  // Where the stretch to rebuild ENDS: where the journal begins, or — with no
  // journal at all — where the feed will begin. A feed that has never taken a
  // cursor has nothing behind it to rebuild from.
  if (!journal && feedCursor === undefined) return null;
  // A null cursor reads the log from its first record: nothing is missing.
  if (!journal && feedCursor === null) {
    journal = emptyJournal(0);
    await db.setMeta(TOUCHED_META, journal);
    return journal;
  }
  const untilMs = journal ? journal.from : (keyMs(feedCursor) ?? null);
  if (untilMs === null) return null;

  const found = emptyJournal(needFrom);
  const seen = new Set();
  let after = pushKeyPrefixForMs(needFrom);
  let reachedEnd = false;
  for (let page = 0; page < maxPages && !reachedEnd; page += 1) {
    const entries = pageEntries(await adapter.readKeyPage(changesRoot, { after, limit: pageSize }), { keepNull: true });
    if (entries.length === 0) { reachedEnd = true; break; }
    let last = after;
    for (const [changeKey, rec] of entries) {
      if (compareKeys(changeKey, last) > 0) last = changeKey;
      const ms = keyMs(changeKey);
      // Past the stretch: the journal (or the feed) has this one itself.
      if (ms !== null && ms > untilMs) { reachedEnd = true; continue; }
      const leg = rec && typeof rec === "object" ? LEG_BY_NODE[rec.n] : null;
      if (!leg || typeof rec.k !== "string") continue;
      const id = `${leg.name}\u0000${rec.k}`;
      if (seen.has(id)) continue;
      seen.add(id);
      add(found, leg.name, ms ?? untilMs, 1);
    }
    if (entries.length < pageSize) reachedEnd = true;
    // A page that does not move forward would be read for ever.
    if (compareKeys(last, after) <= 0) break;
    after = last;
  }
  // Could not reach the journal inside the page budget: the stretch is too
  // long to vouch for, and half a journal is a wrong allowance.
  if (!reachedEnd) return null;

  const merged = await db.updateMeta(TOUCHED_META, (prev) => {
    const base = isJournal(prev) ? { ...prev, legs: copyLegs(prev.legs) } : emptyJournal(untilMs);
    for (const [name, hours] of Object.entries(found.legs)) {
      for (const [h, n] of Object.entries(hours)) {
        const into = base.legs[name] ?? (base.legs[name] = {});
        into[h] = (into[h] ?? 0) + n;
      }
    }
    base.from = Math.min(base.from, needFrom);
    return prune(base, nowMs);
  });
  return merged.from <= needFrom ? merged : null;
}

/**
 * Rows named by change records the feed has NOT applied yet — everything in
 * the log after `feedCursor` — per leg, or null when that cannot be counted
 * inside the page budget.
 *
 * A census asked for straight after a download (it is forced, so that a first
 * copy is verified before it is served) cannot wait for the feed to catch up.
 * But a device opened after a night holds legs that are missing every change
 * still in its backlog, and each of those is a row its count may be off by.
 * They are read here as pointer records only — the same pages the next pass
 * will read to apply them — and added to the allowance. Nothing is journaled:
 * the feed files them itself when it applies them.
 */
export async function pendingTouched(adapter, {
  feedCursor, changesRoot, pageSize = BACKFILL_PAGE_SIZE, maxPages = BACKFILL_MAX_PAGES,
}) {
  if (feedCursor === undefined) return null;
  const perLeg = {};
  const seen = new Set();
  let after = feedCursor;
  for (let page = 0; page < maxPages; page += 1) {
    const entries = pageEntries(await adapter.readKeyPage(changesRoot, { after, limit: pageSize }), { keepNull: true });
    if (entries.length === 0) return perLeg;
    let last = after;
    for (const [changeKey, rec] of entries) {
      if (last === null || compareKeys(changeKey, last) > 0) last = changeKey;
      const leg = rec && typeof rec === "object" ? LEG_BY_NODE[rec.n] : null;
      if (!leg || typeof rec.k !== "string") continue;
      const id = `${leg.name}\u0000${rec.k}`;
      if (seen.has(id)) continue;
      seen.add(id);
      perLeg[leg.name] = (perLeg[leg.name] ?? 0) + 1;
    }
    if (entries.length < pageSize) return perLeg;
    if (after !== null && compareKeys(last, after) <= 0) return null;
    after = last;
  }
  return null;
}
