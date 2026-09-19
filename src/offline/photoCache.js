// ─── OFFLINE MIRROR — photo thumbnail cache (Cache Storage, NO service worker)
//
// Ported from marathon-pos-app/src/offline/photoCache.js.
//
// NO SERVICE WORKER, DELIBERATELY. This app once had one and it caused the iOS
// zero-data incident (src/update/updateChecker.js says so at the top, and the
// SW has been gone ever since). Hosting sends no-cache/no-store almost
// everywhere on purpose. So this module uses `caches.open()` directly from the
// page — no fetch interception, no SW registration, no SW lifecycle to get
// wrong. It is a cache the page fills and reads, and nothing else.
//
// WHY NOT IndexedDB: db.js's stores exist for small structured records read
// back inside a query; a ~21 KB WebP blob per product is exactly what Cache
// Storage's Request/Response shape is for, and keeping it in a separate API
// means a photo-cache quota problem can never abort an in-flight products or
// stock transaction (different IDB transactions AND a different storage API).
//
// QUOTA DISCIPLINE — the hard constraint this file exists to satisfy: quota
// pressure must evict PHOTOS first, never the data legs.
//   1. A hard byte budget (PHOTO_CACHE_BYTE_BUDGET) is enforced on every write
//      via oldest-write-first eviction BEFORE the new blob is stored, so the
//      photo cache can never grow to threaten the shared origin quota that
//      IndexedDB draws from — and IndexedDB is where the 104.5 MB of DATA
//      lives, which is the part that must never be evicted for a picture.
//   2. `clearPhotoCache` is the one thing sync.js's disable("quota") calls before
//      anything else if the browser reports QuotaExceededError anyway — dropping
//      the whole photo cache is pure upside (it is a re-downloadable image
//      cache) and is tried before the mirror disables itself.
//   3. The index that drives eviction lives in the SAME "meta" IDB store the
//      other legs already use, under a "photoCache." prefix that
//      db.js's PURGED_META_PREFIXES does NOT include — a products/stock/sales
//      schema bump must not evict photos (investigation §9.2 point 3), and it
//      doesn't, because this file never touches db.js.

import { getBlob, ref as storageRef } from "firebase/storage";
import { productPhotoThumbPath, productPhotoObjectPath, photoContentMarker } from "../utils/productPhotoPaths";

export const PHOTO_CACHE_NAME = "marathon-store-photo-mirror-v1";
export const PHOTO_CACHE_INDEX_META_KEY = "photoCache.index";
// MEASURED against the live bucket on 2026-09-19: 5,292 thumbnail objects,
// 111,346,582 bytes, mean 21.0 KB. (Full-size originals are 5,345 objects and
// 674 MB, which is why they are NEVER pre-downloaded — see fetchFullPhoto.)
//
// A budget BELOW the real set is the worst possible value: a full catalogue
// would sit permanently over the ceiling, evicting its own oldest entries to
// make room for the next fetch and re-downloading them for ever. 200 MB clears
// the measured set with room for catalogue growth and for the handful of
// full-size photos a person opens by hand, and QUOTA_SAFETY_RATIO below still
// protects a genuinely small device.
export const PHOTO_CACHE_BYTE_BUDGET = 200 * 1024 * 1024; // ~200 MB
// Above this fraction of the DEVICE'S total origin quota, stop growing the
// photo cache even if under PHOTO_CACHE_BYTE_BUDGET — a small-disk device must
// not let photos crowd out the data legs' much smaller, much more important
// share of the same quota.
export const QUOTA_SAFETY_RATIO = 0.85;
// A product with no thumbnail object yet (nothing has generated one yet, or
// the product has no photo) is re-checked, not hammered, every pass.
export const PHOTO_MISSING_RETRY_MS = 6 * 60 * 60 * 1000;

// ─── WHY THE CATALOGUE NEVER FINISHED ────────────────────────────────────────
//
// (Ported verbatim from the POS, where it was measured. The same arithmetic
// applies here against a slightly larger catalogue.)
//
// The first field test had 25 thumbnails of 5,016 after several hours. 25 is
// not a coincidence: it was MAX_ITEMS_PER_PASS, and the whole pass finished in
// about three seconds of measured work — after which the leg sat idle for the
// remaining 297 seconds of the engine's five-minute cadence. The ceiling was
// never the network or the device; it was this budget against that cadence:
//
//     25 photos / 5 min  =  300 per hour  =  16.7 HOURS for 5,016
//
// and that is the BEST case, with every pass running. The trickle was so slow
// that a device would be re-imaged before it finished.
//
// Three changes, and none of them is "try harder":
//
//   1. FETCH IN PARALLEL. A thumbnail is ~19.7 KB and the cost is round-trip
//      latency, not bandwidth. Six at a time saturates nothing and cuts the
//      wall clock by roughly that factor.
//   2. WORK FOR A SLICE OF THE PASS, NOT A HANDFUL OF ITEMS. The budget is now
//      wall-clock (PHOTO_PASS_BUDGET_MS) with a generous item cap behind it, so
//      a pass uses ~90 s of its budget and then hands the device back. A full
//      catalogue completes in well under an hour on a machine left running.
//   3. YIELD PER BATCH, NOT PER ITEM. The old loop awaited an idle slot before
//      every single fetch; requestIdleCallback's own turnaround was being paid
//      5,016 times. The busy signal is still honoured — a write in flight
//      still stops the batch — it is just asked once per batch, not per photo.
//
// COMPETING WITH THE PERSON is what `isBusy` exists to prevent, and it is
// checked before every batch. Here that means an outbox write in flight — an
// order being placed, a transfer being sent — never merely a screen being
// open.
export const PHOTO_CONCURRENCY = 6;
export const PHOTO_PASS_BUDGET_MS = 90 * 1000;
// How often a batch held behind a write re-asks. An outbox write is a
// milliseconds-to-seconds thing, so this is coarse on purpose — it exists to
// stay out of the person's way, not to poll for it.
export const PHOTO_BUSY_POLL_MS = 30 * 1000;
const MAX_ITEMS_PER_PASS = 600;
// How many products a single pass EXAMINES (cheap marker checks, no network)
// before giving up for this pass — separate from MAX_ITEMS_PER_PASS, which
// caps actual network fetches. Without a cap here, a fully-primed catalogue
// still walks every one of 4,500+ products on every 5-minute pass forever,
// just to find nothing left to do. The resume cursor (below) means the whole
// catalogue is still covered — just spread across many passes instead of
// rescanned whole every time.
const MAX_SCAN_PER_PASS = 3000;
const SCAN_CURSOR_META_KEY = "photoCache.scanCursor";

const cacheKeyUrl = (productId) => `https://marathon-store-mirror.local/products/${productId}/thumb`;
export const photoCacheRequest = (productId) => new Request(cacheKeyUrl(productId));

export function isPhotoCacheApiAvailable() {
  return typeof caches !== "undefined";
}

export function openPhotoCache() {
  return caches.open(PHOTO_CACHE_NAME);
}

// "There is no thumbnail for this product" — the only failure that may set the
// six-hour `missing` marker. Firebase raises a StorageError carrying `.code`;
// the message is also checked because the SDK has moved that field before and
// getting this predicate wrong is the difference between a re-checked product
// and one suppressed for six hours.
export function isObjectNotFound(err) {
  if (!err) return false;
  if (err.code === "storage/object-not-found") return true;
  return typeof err.message === "string" && err.message.includes("object-not-found");
}

async function readIndex(db) {
  return (await db.getMeta(PHOTO_CACHE_INDEX_META_KEY)) ?? {};
}

function writeIndex(db, index) {
  return db.setMeta(PHOTO_CACHE_INDEX_META_KEY, index);
}

// Oldest-write-first eviction (by write time, not last-READ time — a true LRU
// would need every render-path cache hit to also write back to IndexedDB,
// which is more IDB traffic than the eviction policy is worth). The whole
// function's blast radius is `cache` + the photo index; it is never handed
// the mirror db's data stores, so it is structurally incapable of touching
// them.
export async function evictOldestUntil(cache, db, freeBytesNeeded) {
  const index = await readIndex(db);
  const entries = Object.entries(index)
    .filter(([, v]) => !v.missing)
    .sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0)); // oldest first
  let currentUsage = entries.reduce((sum, [, v]) => sum + (v.bytes || 0), 0);
  const toDelete = [];
  for (const [productId, entry] of entries) {
    if (currentUsage <= freeBytesNeeded) break;
    toDelete.push(productId);
    currentUsage -= entry.bytes || 0;
  }
  for (const productId of toDelete) await cache.delete(photoCacheRequest(productId));
  if (toDelete.length > 0) {
    // db.updateMeta, not a plain read-then-write of the snapshot taken above
    // — a concurrent tab's setEntry (also updateMeta) landing between our
    // read and our write would otherwise be silently overwritten by this
    // eviction re-saving its now-stale copy of the index.
    await db.updateMeta(PHOTO_CACHE_INDEX_META_KEY, (cur) => {
      const next = { ...(cur ?? {}) };
      for (const productId of toDelete) delete next[productId];
      return next;
    });
  }
  return toDelete.length;
}

// The quota-disable recovery action. Pure upside: everything here is
// a re-downloadable cache, never an unsent write.
// Returns whether the thumbnails were ACTUALLY dropped, so the caller can say
// so rather than assume it. Both steps stay best-effort — a failure here must
// never stop a delete — but "best effort" and "it happened" are different
// claims, and the status dot prints one of them.
export async function clearPhotoCache(db) {
  let cleared = false;
  try {
    // caches.delete answers whether a cache of that name EXISTED. A device
    // that never mirrored a photo gets `false`, and the settings card must not
    // then print ", along with the product photos" — the same over-claim this
    // return value was added to remove, in the other direction.
    if (isPhotoCacheApiAvailable()) cleared = (await caches.delete(PHOTO_CACHE_NAME)) === true;
  } catch { /* best effort */ }
  // The index is the record of what is held; clearing it is what makes the
  // terminal stop believing it has photos, so it counts either way.
  try { await writeIndex(db, {}); } catch { cleared = false; }
  return cleared;
}

// How many thumbnails this device HOLDS — the number the status dot wants,
// and emphatically not the number a single pass happened to fetch. The photos
// leg used to stamp `rows: summary.cached`, so a device holding 1,345 pictures
// reported "0" on every pass that found nothing new to do, and the card said
// "Pictures download in the background once the rest is done" for ever. That
// read as "photos never download" on a machine where they demonstrably had.
// `missing` entries are the six-hour "there is no thumbnail for this product"
// markers, so they are counted out — they are not pictures.
export async function heldPhotoCount(db) {
  const index = await readIndex(db);
  return Object.values(index).filter((v) => !v.missing).length;
}

async function totalCachedBytes(db) {
  const index = await readIndex(db);
  return Object.values(index).reduce((sum, v) => sum + (v.bytes || 0), 0);
}

// Read-side: a cache HIT returns an object URL for an <img src>; a MISS (or
// the API being unavailable) returns null so the caller falls back to the
// existing network photoUrl — never a broken image.
export async function readCachedPhotoUrl(cache, productId) {
  try {
    const res = await cache.match(photoCacheRequest(productId));
    if (!res) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

// One trickle pass: cache thumbnails for products that don't have a current
// one yet, capped at MAX_ITEMS_PER_PASS (network fetches) AND MAX_SCAN_PER_PASS
// (products examined at all) so a pass returns quickly and the caller's own
// idle/busy loop (mirroring sync.js's idleSlot) stays in control. Resumes from
// a persisted cursor rather than rescanning the whole catalogue every pass —
// full coverage happens over several passes instead of on every single one.
// `products` is the ALREADY-MIRRORED products array (this leg runs after the
// data legs, per the goal) — no extra RTDB read.
export async function primePhotoCachePass({
  db,
  storage,
  cache,
  products,
  isBusy = () => false,
  estimate = () => (typeof navigator !== "undefined" && navigator.storage?.estimate
    ? navigator.storage.estimate()
    : Promise.resolve(null)),
  now = Date.now,
  maxItemsPerPass = MAX_ITEMS_PER_PASS,
  maxScanPerPass = MAX_SCAN_PER_PASS,
  byteBudget = PHOTO_CACHE_BYTE_BUDGET,
  concurrency = PHOTO_CONCURRENCY,
  passBudgetMs = PHOTO_PASS_BUDGET_MS,
  busyPollMs = PHOTO_BUSY_POLL_MS,
  setTimeoutFn = setTimeout,
}) {
  const startedAt = now();
  // Waits for an outbox write to finish, and GIVES UP if it does not.
  // An unbounded wait here is not merely a slow photo pass: the engine's pass
  // awaits it and the next pass is only scheduled once the current one
  // settles, so a busy signal stuck on would take the whole mirror down with
  // it. Resolves `false` when it gives up, and the caller ends the pass rather
  // than barging into a write.
  // THE SAME TRAP AS sync.js's idleSlot, and this leg is where it was measured.
  // Going through requestIdleCallback once per BATCH — to find out that nothing
  // was busy — cost ~30 s per batch in a background window, so a 90-second pass
  // bought 18 thumbnails instead of the ~240 the network can deliver (6 in
  // 2.16 s, measured live). That is the whole reason a catalogue "never
  // downloaded": not bandwidth, not the thumbnail size, and not the data legs
  // gating it. The commit gate is a synchronous counter; ask it directly, and
  // only a batch that is genuinely contended waits on a timer.
  const idleSlot = () => new Promise((resolve) => {
    const attempt = () => {
      if (!isBusy()) { resolve(true); return; }
      if (now() - startedAt >= passBudgetMs) { resolve(false); return; }
      // Injected like `now` and `estimate`, and for the same reason: it was a
      // hard-coded 30-second setTimeout inside a function whose clock is
      // otherwise entirely injectable, so a test that wanted to exercise the
      // busy path had to wait out thirty real seconds of CI to do it.
      setTimeoutFn(attempt, busyPollMs);
    };
    attempt();
  });

  const summary = { cached: 0, skipped: 0, missing: 0, evicted: 0, stopped: null };
  let processed = 0;
  let scanned = 0;

  // Resume where the LAST pass left off rather than rescanning the whole
  // catalogue from the top every ~5 minutes forever. A missing/removed
  // cursor product (or none stamped yet) just starts from the top — self-
  // correcting, and full coverage still happens, just spread over several
  // passes instead of walked whole every time.
  const cursor = await db.getMeta(SCAN_CURSOR_META_KEY);
  const cursorIdx = cursor ? products.findIndex((p) => p?.id === cursor) : -1;
  const ordered = cursorIdx === -1
    ? products
    : [...products.slice(cursorIdx + 1), ...products.slice(0, cursorIdx + 1)];

  // ONE read for the whole pass's skip-checks — a snapshot slightly behind a
  // concurrent window's write only costs a harmless redundant getBlob(), never
  // a correctness problem (unlike the WRITE side below, which must be atomic).
  const index = await readIndex(db);

  // Each mutation below goes through db.updateMeta — the SAME atomic
  // read-modify-write db.js built for exactly this ("two tabs mutating the
  // same key serialize instead of clobber") —
  // rather than one read-mutate-locally-write-once-at-the-end snapshot. A
  // second tab's photos leg running concurrently would otherwise
  // silently lose this pass's entries when both write their full snapshot
  // back. It also means totalCachedBytes(db) always reflects everything
  // committed so far in THIS pass too, not just prior passes.
  const setEntry = (productId, entry) =>
    db.updateMeta(PHOTO_CACHE_INDEX_META_KEY, (cur) => ({ ...(cur ?? {}), [productId]: entry }));

  let lastScannedId = cursor ?? null;

  // ── the work list for this pass: cheap, local, no network ──
  // Built first so the fetches below can run in BATCHES. The skip-checks are
  // marker comparisons against the index snapshot; walking them costs nothing
  // and bounds itself on maxScanPerPass, exactly as before.
  let lastAttemptedId = null;
  const todo = [];
  for (const product of ordered) {
    if (todo.length >= maxItemsPerPass || scanned >= maxScanPerPass) break;
    const productId = product?.id;
    if (!productId) continue;
    scanned += 1;
    lastScannedId = productId;
    const marker = photoContentMarker(product);
    const existing = index[productId];
    if (existing && existing.marker === marker) {
      if (!existing.missing || now() - (existing.at ?? 0) < PHOTO_MISSING_RETRY_MS) continue;
    }
    todo.push({ productId, marker });
  }
  // What this pass did NOT get to. The engine uses it to decide whether the
  // catalogue is complete or whether there is still work waiting, so "nearly
  // done" and "barely started" stop looking the same from outside.
  // ── fetch in batches ──
  for (let i = 0; i < todo.length; i += concurrency) {
    if (now() - startedAt >= passBudgetMs) { summary.stopped = "pass-budget"; break; }
    // The commit gate, asked ONCE PER BATCH rather than once per photo. A write
    // in flight still stops the batch dead; what it no longer does is charge
    // the device a requestIdleCallback turnaround 5,000 times over.
    if (!(await idleSlot())) { summary.stopped = "busy"; break; }

    // Quota headroom, also once per batch (it was once per item, and
    // navigator.storage.estimate() is not free).
    const est = await estimate();
    if (est && est.quota && (est.usage ?? 0) >= est.quota * QUOTA_SAFETY_RATIO) {
      const evicted = await evictOldestUntil(cache, db, byteBudget / 2);
      summary.evicted += evicted;
      if (evicted === 0) { summary.stopped = "quota-headroom"; break; }
    }

    const batch = todo.slice(i, i + concurrency);
    // FETCHES in parallel; everything that touches the cache or the index is
    // applied SERIALLY below, so the byte accounting and the eviction ceiling
    // stay exactly as correct as they were when this was one item at a time.
    const fetched = await Promise.all(batch.map(async ({ productId, marker }) => {
      try {
        return { productId, marker, blob: await getBlob(storageRef(storage, productPhotoThumbPath(productId))) };
      } catch (err) {
        return { productId, marker, err };
      }
    }));

    for (const { productId, marker, blob, err } of fetched) {
      processed += 1;
      // WHERE THE NEXT PASS RESUMES. The scan above walks ahead of the work —
      // up to maxScanPerPass products — so stamping the cursor at the last
      // SCANNED id after a pass that stopped early on its budget would skip
      // every product it never fetched, for a whole lap of the catalogue.
      // The cursor follows the work, not the scan.
      lastAttemptedId = productId;
      if (err) {
        // A FAILED FETCH IS NOT A MISSING PHOTO. The old code marked every
        // failure `missing`, which suppressed the retry for six hours — so one
        // pass that ran while the line was down poisoned that slice of the
        // catalogue for the rest of the day. Only the storage API saying the
        // object is not there means the object is not there; anything else is
        // a transport problem and is simply left for the next pass.
        if (isObjectNotFound(err)) {
          await setEntry(productId, { bytes: 0, marker, at: now(), missing: true });
          summary.missing += 1;
        } else {
          summary.failed = (summary.failed ?? 0) + 1;
        }
        continue;
      }

      const bytes = blob.size ?? 0;
      // A single blob bigger than the WHOLE budget (a mis-generated thumbnail,
      // say) must never be cached at all — byteBudget - bytes would be
      // negative, and evictOldestUntil would try to shrink existing usage down
      // to an impossible ceiling and wipe the entire cache trying, only to then
      // still store the oversized blob anyway.
      if (bytes > byteBudget) { summary.skipped += 1; continue; }
      const currentTotal = await totalCachedBytes(db);
      if (currentTotal + bytes > byteBudget) {
        // evictOldestUntil's contract is "bring the EXISTING total down to this
        // ceiling," not "free this many bytes" — passing the overflow amount
        // here (currentTotal + bytes - byteBudget, typically tiny) was read as
        // a near-zero ceiling and evicted almost the whole cache instead of
        // just enough to fit the new blob. The ceiling that actually leaves
        // room for `bytes` more within `byteBudget` is byteBudget - bytes.
        summary.evicted += await evictOldestUntil(cache, db, byteBudget - bytes);
      }

      try {
        await cache.put(photoCacheRequest(productId), new Response(blob, {
          headers: { "Content-Type": blob.type || "image/webp" },
        }));
        await setEntry(productId, { bytes, marker, at: now(), missing: false });
        summary.cached += 1;
      } catch {
        summary.skipped += 1;
      }
    }
  }
  summary.remaining = Math.max(0, todo.length - processed);
  // A pass that got through its whole work list may safely resume past
  // everything it examined (the rest were already current). A pass that
  // stopped early must resume at the first thing it did not do.
  if (summary.stopped) {
    // …and a pass that stopped before fetching ANYTHING — a device writing
    // continuously through the whole budget, so the very first idle slot gave
    // up — must not move the cursor at all. The scan phase has already walked
    // ahead of the work by up to maxScanPerPass products, so stamping it here
    // would skip a page of up to maxItemsPerPass thumbnails that were never
    // fetched, for a whole lap of the catalogue. `null` leaves the cursor
    // exactly where the previous pass left it.
    lastScannedId = lastAttemptedId;
  }

  if (lastScannedId != null) {
    try { await db.setMeta(SCAN_CURSOR_META_KEY, lastScannedId); } catch { /* best effort */ }
  }
  return summary;
}


// ─── FULL-SIZE PHOTOS: ON DEMAND, ONCE, NEVER PRE-DOWNLOADED ────────────────
//
// The originals are 5,345 objects and 674 MB against the thumbnails' 111 MB,
// measured 2026-09-19. Putting them on a device is not a thing to do. But the
// product detail, the label preview and the re-shoot comparison all render the
// original, and "nothing is ever re-downloaded" has to be true of those too.
//
// So an original is fetched the FIRST time a person opens that one product and
// kept in the same cache under its own key. It costs 109 KB once, ever, per
// photo a person actually looks at — instead of 109 KB every time anyone
// opens it, which is what happens today.
//
// It shares the byte budget with the thumbnails, and it is stored LAST in the
// eviction order by virtue of being written last, so ordinary browsing
// reclaims originals before it reclaims the thumbnail set that every grid
// needs. That is the right priority and it falls out of oldest-write-first
// without a second policy.

const fullCacheKeyUrl = (productId) => `https://marathon-store-mirror.local/products/${productId}/photo`;
export const fullPhotoCacheRequest = (productId) => new Request(fullCacheKeyUrl(productId));
export const FULL_PHOTO_INDEX_PREFIX = "full:";

/**
 * The original photo for one product, from the cache if it is held and from
 * Storage otherwise — in which case it is kept.
 *
 * Returns an object URL, or null. NULL IS A LEGITIMATE ANSWER and the caller
 * falls back to the network url it already has, exactly as it does today: a
 * photo mirror that could break an image would be worse than no photo mirror.
 */
export async function fetchFullPhoto({ db, storage, cache, product, now = Date.now, byteBudget = PHOTO_CACHE_BYTE_BUDGET }) {
  const productId = product?.id;
  if (!productId || !cache) return null;
  const marker = photoContentMarker(product);
  const indexKey = `${FULL_PHOTO_INDEX_PREFIX}${productId}`;

  try {
    const index = await readIndex(db);
    const held = index[indexKey];
    // A HIT IS ONLY A HIT IF IT IS THE SAME PHOTO. Without the marker check a
    // re-shot product would serve last month's picture from cache for ever,
    // which is the silent half of this whole problem restated in images.
    if (held && held.marker === marker && !held.missing) {
      const url = await readCachedFullPhotoUrl(cache, productId);
      if (url) return url;
    }
  } catch { /* fall through to the fetch */ }

  let blob;
  try {
    blob = await getBlob(storageRef(storage, productPhotoObjectPath(productId)));
  } catch (err) {
    if (isObjectNotFound(err)) {
      try {
        await db.updateMeta(PHOTO_CACHE_INDEX_META_KEY,
          (cur) => ({ ...(cur ?? {}), [indexKey]: { bytes: 0, marker, at: now(), missing: true } }));
      } catch { /* best effort */ }
    }
    return null;
  }

  const bytes = blob.size ?? 0;
  try {
    if (bytes <= byteBudget) {
      const currentTotal = await totalCachedBytes(db);
      if (currentTotal + bytes > byteBudget) await evictOldestUntil(cache, db, byteBudget - bytes);
      await cache.put(fullPhotoCacheRequest(productId), new Response(blob, {
        headers: { "Content-Type": blob.type || "image/jpeg" },
      }));
      await db.updateMeta(PHOTO_CACHE_INDEX_META_KEY,
        (cur) => ({ ...(cur ?? {}), [indexKey]: { bytes, marker, at: now(), missing: false } }));
    }
  } catch { /* the blob is still usable even if we could not keep it */ }
  return URL.createObjectURL(blob);
}

export async function readCachedFullPhotoUrl(cache, productId) {
  try {
    const res = await cache.match(fullPhotoCacheRequest(productId));
    if (!res) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}
