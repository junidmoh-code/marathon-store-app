// ─── OFFLINE MIRROR — staged, resumable snapshot downloads ───────────────────
//
// WHY THIS FILE EXISTS (ported; Marathon PE, Till 3, 2026-09-18) ─────────────
// ported from marathon-pos-app, where it was written after Marathon PE Till 3
// lost a finished download to one slow page. `/insights_log` here is 35.8 MB,
// which is far more pages than the ~8 MB that caused it there, and a snapshot leg used to hold every page in a JavaScript
// array until the last one landed. Page thirteen timing out on a shop line
// therefore threw away the twelve that had succeeded, and the NEXT attempt
// started again at page one — so a device on a line that could not get through
// every large read consecutively could never finish the download at all, no
// matter how many times it tried.
//
// A snapshot leg now writes each completed page into STAGING — the meta store,
// one record per page — and resumes from the last chunk that actually landed.
// Only when the whole part has arrived AND passed its validation (non-empty,
// not shrunk) is it swapped over the live copy, in ONE IndexedDB transaction
// that also drops the staging keys. Two properties fall out of that, and they
// are the two the incident needed:
//
//   - a refresh can never empty the working copy. The live store is untouched
//     until a complete, validated replacement is in hand.
//   - a refresh is never a restart. An interrupted download costs the pages it
//     had not yet fetched, not the ones it had.
//
// WHY THE META STORE AND NOT A NEW OBJECT STORE. The IDB structural version is
// fixed at 1 by design (db.js: bumping it fires versionchange and is blocked by
// any other open tab), so a staging object store cannot be added
// without a schema purge that would re-download the mirror on every device in
// the shop. The customers leg already keeps its whole snapshot in one meta key
// for exactly this reason; this is the same trade, chunked.
//
// SCOPE. A staged download is only resumable into the thing it was started for.
// `scope` is the leg's scope where it has one, `buildVersion` the bundle — a
// staged half must never be adopted under a record shape that has changed, and a record shape that changed with a deploy must not be resumed
// into the new one. Either mismatch discards the staging and starts clean, and
// so does staging older than STAGING_TTL_MS: a half-download from last week is
// stale catalogue data, not progress.

export const STAGING_META_PREFIX = "staging.";

export const stagingKey = (leg) => `${STAGING_META_PREFIX}${leg}`;
export const stagingChunkKey = (leg, index) => `${STAGING_META_PREFIX}${leg}.chunk.${index}`;

// A half-finished download older than this is catalogue data, not progress.
export const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

// Every meta key one staged download occupies — the manifest and its chunks.
// Used both to clear staging and to drop it inside the swap's own transaction.
//
// `highWater`, NOT `chunks`. A run that resumed and then wrote FEWER chunks than
// the one before it (the retry ladder halves the page size, so a resumed walk
// legitimately produces a different number of chunks) would otherwise leave the
// tail of the earlier run on disk for ever — meta keys nothing reads and nothing
// ever deletes. The high-water mark is the highest index this staging has ever
// held, so clearing it clears all of it.
export function stagingKeys(leg, manifest) {
  const keys = [stagingKey(leg)];
  const upTo = Math.max(manifest?.chunks ?? 0, manifest?.highWater ?? 0);
  for (let i = 0; i < upTo; i += 1) keys.push(stagingChunkKey(leg, i));
  return keys;
}

const emptyManifest = (leg, { scope, buildVersion, at }) => ({
  leg,
  chunks: 0,
  // The highest chunk index this staging has ever held — see stagingKeys.
  highWater: 0,
  rows: 0,
  afterKey: null,
  // The key each chunk ENDS on, in order. The assembly checks every chunk
  // against it — see loadStagingRecords.
  chunkEnds: [],
  scope: scope ?? null,
  buildVersion: buildVersion ?? null,
  startedAt: at,
  at,
});

// What is already staged for this leg, or a fresh empty manifest. Anything
// staged for another shop, another bundle or another day is DROPPED here
// rather than resumed — see the scope note above. Never throws: staging is an
// optimisation, and a leg whose staging cannot be read must still be able to
// download from the beginning.
// `notBefore` — THE MOMENT THAT MAKES STAGED ROWS STALE RATHER THAN PARTIAL.
//
// A leg may stamp a cursor saying "this snapshot covers every
// price edit up to key K". A resumed download's first chunks were fetched
// hours before the rest, so if a price changed in between, adopting them and
// stamping the newer key would mark PRE-SIGNAL rows as post-signal — a stale
// shelf price presented as current, which is the 2026-09-01 incident this
// mirror's price signal exists to end. A resume is only sound while nothing has
// happened that the staged rows cannot be vouching for, so the caller passes
// the last such moment and staging older than it is re-read rather than
// resumed. Correct over cheap, and only on the pass where a price actually
// moved.
export async function readStaging(db, leg, {
  scope = null, buildVersion = null, now = Date.now, ttlMs = STAGING_TTL_MS,
  notBefore = null,
} = {}) {
  const at = now();
  let held;
  try { held = await db.getMeta(stagingKey(leg)); } catch { held = null; }
  if (!held || typeof held !== "object" || !Number.isFinite(held.chunks)) {
    return emptyManifest(leg, { scope, buildVersion, at });
  }
  const sameScope = (held.scope ?? null) === (scope ?? null);
  const sameBuild = (held.buildVersion ?? null) === (buildVersion ?? null);
  const fresh = Number.isFinite(held.startedAt) && at - held.startedAt < ttlMs
    && !(Number.isFinite(notBefore) && held.startedAt < notBefore);
  if (!sameScope || !sameBuild || !fresh) {
    await clearStaging(db, leg, held);
    return emptyManifest(leg, { scope, buildVersion, at });
  }
  return held;
}

// One page, committed with the manifest that describes it in ONE transaction.
// The manifest is never allowed to claim a chunk that did not land, which is
// what makes `afterKey` a cursor a resume can trust — the same guarantee
// db.putPage gives the delta legs.
export async function appendStagingChunk(db, leg, { manifest, rows, afterKey, now = Date.now }) {
  const index = manifest.chunks;
  const next = {
    ...manifest,
    chunks: index + 1,
    highWater: Math.max(manifest.highWater ?? 0, index + 1),
    rows: manifest.rows + rows.length,
    afterKey: afterKey ?? manifest.afterKey,
    // The page key this chunk ends on. The assembly checks it — see
    // loadStagingRecords: two tabs share one IndexedDB profile and both
    // run an engine (bootstrap.js says so deliberately), and the retry ladder
    // means the second one's pages need not line up with the first one's.
    chunkEnds: [...(manifest.chunkEnds ?? []).slice(0, index), afterKey ?? null],
    at: now(),
  };
  await db.setMetaMany({
    // SELF-DESCRIBING, not a bare array. The stock leg's rows are transformed
    // cells ("<productId>|<sizeKey>"), so the rows themselves cannot say which
    // PAGE of the node they came from; the chunk carries the page cursor it was
    // written for and the assembly checks that, not a row key.
    [stagingChunkKey(leg, index)]: { end: afterKey ?? null, rows },
    [stagingKey(leg)]: next,
  });
  return next;
}

// The staged download, reassembled in the order it was fetched.
//
// A MISSING CHUNK IS A FAILED DOWNLOAD, NOT A SHORT ONE. Reassembling around a
// hole would hand the swap a truncated snapshot with a manifest vouching for
// the full count — the #276 failure in a new place — so it raises, the leg
// records a failure, and the staging is cleared by the caller so the next
// attempt starts clean.
// TWO TILL WINDOWS SHARE ONE STAGING AREA. bootstrap.js runs an engine in every
// tab on purpose, and each `stagedWalk` holds its manifest in memory
// after reading it. If both stage the same leg and their pages do not line up —
// which the retry ladder makes possible the moment one of them halves its page
// size — the later writer's chunk `i` covers a different range from the earlier
// one's, and assembling by index alone would splice a hole or a duplicate into
// a snapshot that then passed every count check. So each chunk is checked
// against the key the manifest says it ends on. A mismatch is a failed
// download, not a short one: it raises, the staging is cleared, and the next
// attempt reads the node again.
export class StagingIncompleteError extends Error {
  constructor(leg, index, detail) {
    super(`offline mirror: the staged "${leg}" download cannot be assembled — chunk ${index} ${detail}.`);
    this.name = "StagingIncompleteError";
    this.leg = leg;
  }
}

export async function loadStagingRecords(db, leg, manifest) {
  const records = [];
  const ends = manifest?.chunkEnds ?? [];
  for (let i = 0; i < (manifest?.chunks ?? 0); i += 1) {
    const chunk = await db.getMeta(stagingChunkKey(leg, i));
    if (!chunk || !Array.isArray(chunk.rows)) throw new StagingIncompleteError(leg, i, "is missing");
    if (chunk.end !== ends[i]) {
      throw new StagingIncompleteError(leg, i,
        `was written for page "${chunk.end}" where the manifest says "${ends[i]}" — another tab staged over it`);
    }
    records.push(...chunk.rows);
  }
  return records;
}

// Best effort by design: staging that cannot be cleared is wasted space, and
// the next `readStaging` drops it on the TTL anyway. It must never be the
// reason a leg reports failure.
export async function clearStaging(db, leg, manifest) {
  try {
    if (typeof db.deleteMetaMany === "function") {
      await db.deleteMetaMany(stagingKeys(leg, manifest));
    } else {
      await db.setMetaMany(Object.fromEntries(
        stagingKeys(leg, manifest).map((k) => [k, undefined])));
    }
  } catch { /* see above */ }
}
