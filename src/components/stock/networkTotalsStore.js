// ─── NETWORK TOTALS — DATA LAYER ──────────────────────────────────────────────
// THIS MODULE READS. IT NEVER WRITES. There is no set/update/push/remove/
// runTransaction import in this file and none in the card that uses it; the
// whole feature is read-only end to end, by construction rather than by care.
//
// ── WHY NOT JUST READ /stock ─────────────────────────────────────────────────
// Because it is 5,361,046 bytes, measured on the live database, and RTDB serves
// it uncompressed (probed: no Content-Encoding, identical Content-Length with
// gzip offered). Nine screens in this app already subscribe to the whole node;
// this one refuses to be the tenth. See NETWORK-TOTALS-INVESTIGATION.md.
//
// Instead: ten one-shot reads of `/stock/{loc}/{pid}` per product, which is
// 1,243 bytes on average across all ten locations (p50 797, p90 2,806). A page
// of 25 products costs ~31 KB; a search costs ~1.2 KB per hit.
//
// ── get(), NEVER onValue ─────────────────────────────────────────────────────
// A live subscription keeps paying for every POS sale and every refill for as
// long as the screen is open. This is a research screen — he opens it to think
// about what to order, not to watch a number tick. One shot, cached, done.
//
// ── THE CACHE IS THE POINT ───────────────────────────────────────────────────
// Totals are memoised per product id for the life of the page. Re-sorting,
// clearing a search, paging back and re-typing the same query all cost zero
// bytes. Without this, flipping the sort direction would re-read the catalogue.

import { ref, get } from "firebase/database";
import { database } from "../../firebase";
import { sumProduct } from "./networkTotalsCore";

// KEY: productId + the exact location set the total was computed over. NOT the
// product id alone. /locations is a live subscription, so an admin flipping a
// location's `active` mid-session changes what "counted" means; keyed by id
// alone, every already-cached number would keep describing the old set while the
// caption on screen described the new one. Keyed by both, a scope change simply
// misses the cache and re-reads. Module scope, so it survives a remount.
const cache = new Map();
const keyFor = (productId, locationIds) => `${productId}::${[...(locationIds || [])].sort().join(",")}`;
// productId -> in-flight promise, so two renders asking at once read once.
const inflight = new Map();
// productId -> true for a read that FAILED. A failure is not a total, so it is
// not cached as one; but it must not look like a slow read either. Without this
// a dropped connection leaves a row saying "counting…" forever, with no error,
// no retry and no way to tell it from a read still in flight.
const failed = new Map();
// Bumped by a full Refresh. A read already in flight when Refresh is pressed
// snapshotted the state he pressed Refresh to get PAST, so its answer is
// discarded rather than cached — and the reason he pressed it (he just moved
// stock) is exactly what makes that race likely.
let generation = 0;
// When the totals on screen were read, so the card can say so. He may move stock
// on another tab and come back; a number with no timestamp invites a reorder
// decision against a figure that is minutes stale.
let lastReadAt = null;

// Approximate bytes this page has pulled for totals — the sum of the JSON length
// of every stock snapshot received. Surfaced on the card so the cost of the
// screen is visible to the person paying for it, not buried in a report.
let bytesRead = 0;
let readsIssued = 0;
// How many times loadTotals has been entered. One per page of rows is correct.
// A screen that re-enters once per ARRIVING ROW still downloads nothing extra
// (inflight dedupes the reads) but multiplies promise chains quadratically, so
// this counter is what a test can hold the screen to.
let batches = 0;

export function totalsBytesRead() { return bytesRead; }
export function totalsReadsIssued() { return readsIssued; }
export function totalsBatches() { return batches; }
export function cachedTotals(productId, locationIds) { return cache.get(keyFor(productId, locationIds)) || null; }
export function cachedCount() { return cache.size; }
export function totalsFailed(productId, locationIds) { return failed.has(keyFor(productId, locationIds)); }
export function totalsReadAt() { return lastReadAt; }

// Forget one product's failure so the next render reads it again. Forget
// everything (no argument) for the card's Refresh — a re-read is one page's
// worth of bytes, which is the price of a number he can trust.
export function forgetTotals(productId, locationIds) {
  if (productId == null) {
    // inflight is cleared too, and the generation moves: otherwise a read still
    // in flight would either be JOINED by the post-refresh request (handing back
    // the pre-refresh answer) or land and cache itself after the clear.
    cache.clear(); failed.clear(); inflight.clear(); generation += 1; lastReadAt = null;
    return;
  }
  const k = keyFor(productId, locationIds);
  cache.delete(k); failed.delete(k); inflight.delete(k);
}

// Test seam only — the card never calls this.
export function __resetTotalsCache() { cache.clear(); inflight.clear(); failed.clear(); bytesRead = 0; readsIssued = 0; batches = 0; generation = 0; lastReadAt = null; }

// One product, every location. Ten small reads, summed by the pure core.
//
// allSettled, not all: if ONE location's read fails the other nine still cost
// what they cost, and throwing them away would mean paying for them twice. But a
// partial answer is NOT reported as a total — a total missing a location is a
// confidently wrong number in front of a reorder decision — so a single failure
// fails the whole product, loudly, and the successful reads stay warm for the
// retry.
async function readOne(productId, locationIds) {
  const byLoc = {};
  const results = await Promise.allSettled(locationIds.map(async (locationId) => {
    const snap = await get(ref(database, `stock/${locationId}/${productId}`));
    readsIssued += 1;
    const val = snap.val();
    if (val != null) { byLoc[locationId] = val; bytesRead += JSON.stringify(val).length; }
  }));
  const rejected = results.find((r) => r.status === "rejected");
  if (rejected) throw rejected.reason;
  return sumProduct(byLoc);
}

// Totals for one product, memoised. Concurrent callers share one read.
export function productTotals(productId, locationIds) {
  const k = keyFor(productId, locationIds);
  if (cache.has(k)) return Promise.resolve(cache.get(k));
  if (inflight.has(k)) return inflight.get(k);
  const gen = generation;
  const p = readOne(productId, locationIds)
    .then((totals) => {
      inflight.delete(k);
      if (gen !== generation) return null;      // a Refresh overtook this read
      cache.set(k, totals);
      failed.delete(k);
      lastReadAt = new Date();
      return totals;
    })
    .catch((err) => {
      inflight.delete(k);
      if (gen !== generation) return null;
      // A denied or failed read is UNKNOWN, never zero. Returning 0 here would
      // put a confident wrong number in front of a reordering decision — and
      // leaving it silent would let it pass for a slow one.
      failed.set(k, true);
      console.warn(`Total Stock read failed for ${productId}:`, err);
      return null;
    });
  inflight.set(k, p);
  return p;
}

// Totals for a list of products, at most `concurrency` products in flight at a
// time so a page of 25 does not open 250 sockets' worth of work at once.
// `onRow(productId, totals)` fires as each lands, so rows fill in progressively
// instead of the screen sitting blank until the slowest read returns.
export async function loadTotals(productIds, locationIds, onRow, concurrency = 6) {
  batches += 1;
  const queue = [...new Set(productIds || [])];
  // A concurrency of 0 would spawn no workers, resolve immediately and leave
  // every row uncounted with no error — a silent no-op that looks like success.
  const workers = Math.max(1, Math.min(concurrency, queue.length));
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const id = queue[cursor++];
      const totals = await productTotals(id, locationIds);
      if (onRow) onRow(id, totals);
    }
  };
  if (!queue.length) return;
  await Promise.all(Array.from({ length: workers }, worker));
}
