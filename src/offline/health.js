import { MIRROR_LEGS } from "./nodes";

// ─── OFFLINE MIRROR — per-leg health ─────────────────────────────────────────
//
// WHY THIS FILE EXISTS ───────────────────────────────────────────────────────
// Ported from marathon-pos-app/src/offline/health.js. Every paragraph below is
// a live incident on the tills, and every one of them can happen here.
//
// The POS mirror shipped reading `/stock/pe` — a path that has never existed.
// It got back zero rows, swapped zero rows in, stamped `lastSyncAt.stock` and
// told the connection tracker it had succeeded. From the outside a broken leg
// and a healthy one were byte-for-byte the same: an empty object store and a
// fresh timestamp.
//
// So `lastSyncAt` is no longer the answer to "can I trust this leg?". It only
// says WHEN something last ran. This file holds the separate, explicit answer:
//
//   mirror.health.<leg> = { ok, path, rows, at }            ← last read was good
//   mirror.health.<leg> = { ok: false, path, reason, detail, at, state,
//                            retryable }
//
// `state` separates the two ways a leg fails — "cannot-run" (its context is
// absent; RTDB was never asked) from a read/verdict failure — and `retryable`
// says whether the failure throttles the next attempt. See sync.js.
//
// A leg with NO health record is unusable too — `isLegUsable` is false unless a
// sync has affirmatively said otherwise. A future reader that falls back to the
// mirror must ask this, never `count() > 0`, because "empty" is precisely the
// state we cannot tell apart from "broken".

export const HEALTH_META_PREFIX = "mirror.health.";

// Meta keys that describe a SNAPSHOT rather than configuration, and so must be
// dropped whenever the snapshot is dropped. db.js's schema purge clears the
// data stores; a health record that outlived its rows would vouch for an empty
// store, which is precisely the bug this module exists to close.
export const SNAPSHOT_META_PREFIXES = Object.freeze([
  HEALTH_META_PREFIX,
  // Where a leg's change feed has got to. Its polarity is the dangerous one:
  // left standing over a purged store it would say "up to date" and the leg
  // would resume from a cursor describing rows that are no longer there.
  "feedCursor.",
  // "This device has completed its setup download." Purged with the rows for
  // the same reason — a setup marker over an empty store sends a device
  // straight past the setup screen into a blank app.
  "setup.",
  // A staged, part-finished snapshot download (staging.js). It describes rows
  // that are about to replace a store, so it goes when the store goes — a
  // resume into a purged mirror would adopt half a catalogue.
  "staging.",
]);

export const healthKey = (leg) => `${HEALTH_META_PREFIX}${leg}`;

// Thrown by a sync leg whose read came back empty when empty is impossible.
// Carries the path it actually asked for — the single most useful fact when
// the cause is a wrong id namespace rather than a wrong query.
export class EmptyMirrorReadError extends Error {
  constructor(leg, path, detail) {
    super(
      `offline mirror: the "${leg}" sync read ZERO rows from "${path}"` +
      (detail ? ` — ${detail}` : "") +
      ". Treating this as a FAILED sync, not an empty mirror.",
    );
    this.name = "EmptyMirrorReadError";
    this.leg = leg;
    this.path = path;
  }
}

// Thrown by a leg that cannot run at all — the context it needs is absent (no
// shift selected) or unusable (a POS store with no canonical /stock location).
// A separate type from EmptyMirrorReadError because it is a different fact: we
// never asked RTDB anything. It carries no path for the same reason.
export class MirrorLegBlockedError extends Error {
  constructor(leg, reason, detail) {
    super(
      `offline mirror: the "${leg}" sync CANNOT RUN (${reason})` +
      (detail ? ` — ${detail}` : "") +
      ". Recorded as a failed leg, not as a leg that is merely not due.",
    );
    this.name = "MirrorLegBlockedError";
    this.leg = leg;
    this.reason = reason;
  }
}

// The meta entries a successful leg stamps. Returned (not written) so callers
// can fold them into the SAME transaction as the data swap — a leg must never
// be able to report healthy without its rows having landed, or vice versa.
export function healthyMeta(leg, { path, rows, at, ...extra }) {
  return { [healthKey(leg)]: { ok: true, path, rows, at, ...extra } };
}

// Extra fields (the stock leg's storeId, notably) are carried through on
// FAILURE too — stockDue has to tell "a different store" apart from "the same
// store, still broken", and only a failure record that names its store can.
export function failedMeta(leg, { path, reason, detail = null, at, ...extra }) {
  return { [healthKey(leg)]: { ok: false, path, reason, detail, at, ...extra } };
}

// ─── A FAILED ATTEMPT IS NOT A LOST SNAPSHOT ─────────────────────────────────
//
// THE DEFECT THIS CLOSES (Marathon PE, Till 3, 2026-09-18 — see
// docs/offline-mirror-refresh-incident.md). `recordLegFailed` used to overwrite
// the health record wholesale, so the record that vouched for 4,914 complete,
// validated product rows was replaced by `{ ok:false, reason:"timed-out" }` the
// instant one refresh page went over its ceiling. Every reader gates on that
// record, so one slow page took the whole local catalogue — and the barcodes
// and the sale history with it — out of service on a device whose rows had never
// left the disk. The setup panel, reading the same record, could say nothing
// but "not set up", which is how pressing "Refresh prices" appeared to restart
// a finished download from zero.
//
// So the record now carries TWO facts instead of one:
//
//   ok            did the LAST READ succeed? Drives the retry, the staleness
//                 warnings and what the panel prints. Unchanged.
//   vouched       what the last ACCEPTED SWAP put on disk — { path, rows, at,
//                 … }. Survives every failure until a good read replaces it or
//                 the rows are purged, and it is what isLegUsable answers from.
//
// `stale` and `rowsThisPass` are deliberately dropped on the way through:
// they describe a moment, not a snapshot, and a stale mark carried into a
// failure record would outlive the pull that was meant to clear it.
export function vouchedSnapshot(prev) {
  if (!prev || typeof prev !== "object") return undefined;
  if (prev.ok === true) {
    const snapshot = { ...prev };
    // `ok` is about the last READ; `stale` and `rowsThisPass` describe a
    // moment, not a snapshot — a stale mark carried into a failure record
    // would outlive the pull that was meant to clear it.
    delete snapshot.ok;
    delete snapshot.stale;
    delete snapshot.rowsThisPass;
    return Number.isFinite(snapshot.rows) ? snapshot : undefined;
  }
  return prev.vouched;
}

// Merge a failure over whatever the leg last vouched for.
export function failedOver(prev, record) {
  const vouched = vouchedSnapshot(prev);
  return vouched ? { ...record, vouched } : record;
}

// `info.keepVouched === false` — a failure that must NOT leave a snapshot
// vouched for. There is exactly one: the landing check (sync.js
// assertSwapLanded), which runs AFTER the swap has already stamped its own
// ok:true record, so the record it would carry forward describes the very
// snapshot it has just refused. A leg whose rows did not land as counted has
// nothing trustworthy on disk, and must stay unusable until a good read.
export async function recordLegFailed(db, leg, info) {
  const key = healthKey(leg);
  const { keepVouched = true, ...rest } = info;
  const record = failedMeta(leg, rest)[key];
  if (!keepVouched) {
    try { await db.setMetaMany({ [key]: record }); } catch { /* see below */ }
    return;
  }
  // Best effort: a leg that cannot even record its own failure has bigger
  // problems, and the throw that follows is still the loud part. The read and
  // the write share ONE transaction (db.updateMeta), so two till windows
  // failing the same leg cannot lose each other's vouched snapshot.
  try {
    if (typeof db.updateMeta === "function") {
      await db.updateMeta(key, (prev) => failedOver(prev, record));
    } else {
      const prev = await db.getMeta(key);
      await db.setMetaMany({ [key]: failedOver(prev, record) });
    }
  } catch { /* ignore */ }
}

// ─── A SNAPSHOT MAY NEVER SHRINK QUIETLY ─────────────────────────────────────
//
// THE DEFECT THIS CLOSES. A live till held 799 of 4,665 products and 2,678 of
// 8,347 stock cells, and reported both legs `ok: true` with a row count that
// matched what was on disk. Every number agreed with every other number; the
// only thing wrong was that the SET was a truncated prefix of the real node.
//
// So a snapshot leg answers one question before it may replace what is held:
// is this smaller than what I have, by more than a rounding?
//
//   within tolerance   swap, silently — products really do get deleted
//   anything more      REFUSE. Keep the last good snapshot, record `shrank`,
//                      and keep refusing until a GOOD read arrives or a person
//                      decides otherwise.
//
// THERE IS DELIBERATELY NO "ADOPT IT IF ENOUGH PASSES AGREE" TIER. There was
// one, and it cost three rounds of review to keep upright: it needed a hard
// floor so a real deletion could not be confirmed away, then a row floor so the
// band did not collapse to zero width on a small leg, and that floor then let a
// 79% drop through on a 120-row leg. The tier was unsound at its root, not in
// its constants — repetition is exactly what a systematic under-read produces,
// so "the same smaller number three times" is evidence FOR a truncation as much
// as against it. The measured incident returned 799 on every read.
//
// What replaces it is not a wedge. A refusal keeps the rows READABLE (see
// isLegUsable below), so a till goes on selling from its last complete copy; a
// good read heals the leg with nobody pressing anything, which is the ordinary
// recovery; and for products the live subscription stays up, so a refused leg
// is not even stale on the sell path. The one case that needs a person — the
// office really did delete more than 2% at once — is "Delete the offline copy"
// in Settings, which empties the store, makes `held` zero and turns the next
// sync into a first sync. The Settings card says so in those words.
export const SHRINK_TOLERANCE = 0.02;   // 2% of what is held…
export const SHRINK_ABS_FLOOR = 25;     // …or 25 rows, whichever is larger

export class MirrorSnapshotShrankError extends Error {
  constructor(leg, held, incoming) {
    super(
      `offline mirror: the "${leg}" snapshot came back with ${incoming} rows ` +
      `over ${held} already held. Keeping the last good snapshot and recording ` +
      "a FAILED sync.",
    );
    this.name = "MirrorSnapshotShrankError";
    this.leg = leg;
    this.held = held;
    this.incoming = incoming;
  }
}

// Pure, and with no memory: the verdict depends on the two counts and nothing
// else. That is the point — the tier that depended on the PREVIOUS verdict is
// what kept springing leaks (a guard keyed on state its own failure writes).
export function shrinkVerdict({ held, incoming }) {
  if (!Number.isFinite(held) || held <= 0) return { accept: true };
  if (!Number.isFinite(incoming)) return { accept: true };
  if (incoming >= held) return { accept: true };
  const drop = held - incoming;
  const allowed = Math.max(SHRINK_ABS_FLOOR, Math.floor(held * SHRINK_TOLERANCE));
  if (drop <= allowed) return { accept: true, drop };
  return { accept: false, drop };
}

export function shrankMeta(leg, info) {
  return failedMeta(leg, shrankInfo(info));
}

// The failure INFO a refusal records, separately from the meta entry it builds,
// so the leg can record it through recordLegFailed and keep the snapshot it is
// still selling from in `vouched` — a refusal is the one failure that is
// CERTAIN the held rows are good.
export function shrankInfo({ path, held, incoming, at, ...extra }) {
  return {
    path,
    reason: "shrank",
    at,
    state: "failed",
    // `retryable: false` means THROTTLED, not "never again": the leg waits out
    // FAILED_LEG_RETRY_MS between attempts rather than trying on every pass. It
    // is still retrying, and a good read is the ordinary way out of this state
    // — but re-pulling a 4 MB catalogue every five minutes to look for one
    // would be a cost with no matching benefit.
    retryable: false,
    heldRows: held,
    incomingRows: incoming,
    detail: `read ${incoming} rows over ${held} already held. The last good `
      + "copy is kept and is still being used. If the catalogue really did "
      + "shrink this much, delete the offline copy in Settings and let it "
      + "download again.",
    ...extra,
  };
}

// ─── HEALTH IS DERIVED, NOT ASSERTED ─────────────────────────────────────────
//
// The object store each leg's rows actually live in. `customers` is absent on
// purpose: its snapshot is one meta key, and customersRead.js checks its length
// itself. `photos` is absent because its rows live in Cache Storage.
// Derived from the node registry, so a leg added there cannot be a leg whose
// rows nothing counts. `docs` legs are absent on purpose: several legs share
// that store, so a bare count() there answers about all of them at once and
// would vouch for rows belonging to something else. They are counted by prefix
// instead — see heldRows.
const LEG_STORES = Object.freeze(Object.fromEntries(
  MIRROR_LEGS.filter((l) => l.store !== "docs").map((l) => [l.name, l.store]),
));

// The `docs` legs, and the key prefix each one's rows live under.
const DOC_LEG_PREFIX = Object.freeze(Object.fromEntries(
  MIRROR_LEGS.filter((l) => l.store === "docs").map((l) => [l.name, l.node]),
));

// How many rows the leg HOLDS, read from IndexedDB. null when the leg keeps no
// object store, or when the store cannot be read at all.
export async function heldRows(db, leg) {
  const prefix = DOC_LEG_PREFIX[leg];
  if (prefix) {
    try { return await db.countPrefixed("docs", prefix); } catch { return null; }
  }
  const store = LEG_STORES[leg];
  if (!store) return null;
  try { return await db.count(store); } catch { return null; }
}

// "Does the store still hold what the record claims?" — AT LEAST, never
// exactly. A second till window part-way through appending a barcode page
// legitimately holds MORE than the last stamped count, and refusing the leg
// for that would be a new bug in the shape of a fix. What must never pass is
// the other direction: a record vouching for rows that are no longer there.
//
// Deliberately NOT memoised against the health record. An earlier draft cached
// the verdict per record to save a count() on hot read paths, and that cache
// answered "usable" for a store that had been emptied since — the record it was
// keyed on had not moved, because a store emptied UNDERNEATH a standing record
// is exactly the failure this check exists to catch. A readonly count() is one
// short transaction, and the caller has already paid one to read the record
// itself; the saving was never measured and the staleness was the whole bug.
export async function claimIsBackedByRows(db, leg, health) {
  const claimed = vouchedRows(health);
  if (!Number.isFinite(claimed)) return true;
  if (!LEG_STORES[leg] && !DOC_LEG_PREFIX[leg]) return true;
  const held = await heldRows(db, leg);
  if (!Number.isFinite(held)) return false;
  return held >= claimed;
}

export function getLegHealth(db, leg) {
  return db.getMeta(healthKey(leg));
}

// On the POS this list holds "stock", because a till mirrors ONE shop's branch
// and serving pe's quantities to a till selling as pine is the same class of
// silent wrongness this file exists to end. The store app is the other side of
// that counter: it moves stock BETWEEN locations, so it mirrors all ten and
// `stock` is a global leg here. The mechanism is kept — a leg that ever becomes
// scoped must be unable to be asked the question without naming its scope.
export const STORE_SCOPED_LEGS = Object.freeze([]);

// The question a mirror READER asks. Never `count(store) > 0` — that is the
// exact test this whole file exists because it cannot answer.
//
//   isLegUsable(db, "products")                 // global node
//   isLegUsable(db, "stock", { storeId: "pe" }) // store-scoped, store required
//
// `expect` fields are compared against the health record, so a reader gets
// false (not a stale true) whenever the mirror belongs to something else.
// ─── A REFUSED READ MUST NOT MAKE THE GOOD ROWS UNREADABLE ───────────────────
//
// The guard above exists to keep a till selling from its last COMPLETE copy
// when a read comes back short. An earlier draft recorded that refusal as
// `ok: false` and stopped there — and every reader gates on `ok === true`
// (every reader in localReads.js), so
// the refusal took the whole snapshot out of service. Measured: 400 rows held,
// `isLegUsable` false. A device that then lost its line held a complete catalogue
// and refused to serve any of it, which is precisely the outcome the guard was
// added to prevent — the fix causing the harm it was written against.
//
// So a refusal ANNOTATES rather than demotes. `ok: false` still says "do not
// believe the last read" — that is what drives the retry and what the card
// prints — while the rows themselves stay usable, because they are the ones
// this same function vouched for at the last accepted swap and they are still
// whole. Every OTHER kind of failure keeps its old meaning exactly: an empty
// read, a wrong path, a transport error and a blocked leg all say the rows
// cannot be trusted, and they still do.
const REFUSED_READ_REASONS = Object.freeze(new Set(["shrank"]));
const isRefusedRead = (health) =>
  health?.ok === false && REFUSED_READ_REASONS.has(health.reason)
  && Number.isFinite(health.heldRows);

// ─── A FAILED ATTEMPT MUST NOT MAKE THE GOOD ROWS UNREADABLE EITHER ──────────
//
// The block above closed this for the shrink refusal. Till 3 (2026-09-18) found
// the same hole under every OTHER failure: one page of a "Refresh prices" press
// going past its ceiling replaced the record vouching for 4,914 complete
// products with `{ ok:false, reason:"timed-out" }`, and every reader gates on
// this function — so a complete, validated, on-disk catalogue went out of
// service across the whole app while the rows sat there untouched.
//
// "Did the last read succeed" and "are the rows on disk complete" are different
// questions. `ok` answers the first and drives the retry, the freshness
// warnings and what the setup card prints. THIS answers the second, from the
// last ACCEPTED SWAP — `health` itself on a good read, `health.vouched` after a
// failure (recordLegFailed carries it through) — and it is checked against the
// object store, never merely believed.
//
// What still reads as unusable, unchanged: a leg that has never synced, a leg
// whose rows have gone from the store beneath the record, and a snapshot that
// belongs to another shop (`expect`, compared against the vouching record).

// The record that DESCRIBES THE ROWS ON DISK, or null when nothing does.
// Exported because every surface that reports WHAT THE TILL HOLDS — the setup
// card, the freshness banner, the customers and sales reader statuses — has to
// answer from this and not from the last attempt, or a failed refresh would
// have them all report "never synced" over a full copy.
export const vouchingRecord = (health) => {
  if (health?.ok === true) return health;
  // THE VOUCHED SNAPSHOT FIRST, EVEN FOR A SHRINK REFUSAL (CodeRabbit). The
  // refusal record carries `heldRows`, not `rows`, and its `at` is the moment
  // of the refusal — so a customers or sales status built from it would report
  // a full book as zero rows and claim a sync that was the failure. The vouched
  // block is the accepted swap's own record, with its rows, its time and its
  // storeId, which is what every one of those surfaces is asking for.
  if (Number.isFinite(health?.vouched?.rows)) return health.vouched;
  // A refusal recorded before the vouched block existed still describes what is
  // held; `vouchedRows` reads `heldRows` for exactly this case.
  if (isRefusedRead(health)) return health;
  return null;
};

// What that record vouches for having on disk — `rows` on an accepted swap,
// `heldRows` on a refusal (which is the count that survived it).
const vouchedRows = (health) => {
  if (health?.ok === true) return health.rows;
  if (isRefusedRead(health)) return health.heldRows;
  return health?.vouched?.rows;
};

export async function isLegUsable(db, leg, expect = null) {
  if (STORE_SCOPED_LEGS.includes(leg) && !expect?.storeId) {
    throw new Error(
      `offline mirror: isLegUsable("${leg}") needs the store it is being asked ` +
      "about — a stock mirror is only usable for the store it synced",
    );
  }
  const health = await getLegHealth(db, leg);
  const snapshot = vouchingRecord(health);
  if (!snapshot) return false;
  // A leg is usable when the ROWS are there, not when a record says they are.
  // #276 stamped success over an empty store; this is the same failure with a
  // number on it, and it is answered from IndexedDB rather than from meta.
  if (!(await claimIsBackedByRows(db, leg, health))) return false;
  // Compared against the record that VOUCHES for the rows, not against the last
  // attempt: a stock leg that failed this morning still holds the branch it
  // swapped in yesterday, and it is yesterday's storeId that describes it. A
  // failure record carries no storeId at all, so asking `health` would have
  // refused a perfectly good branch.
  if (expect) {
    for (const [field, value] of Object.entries(expect)) {
      if (snapshot[field] !== value) return false;
    }
  }
  return true;
}
