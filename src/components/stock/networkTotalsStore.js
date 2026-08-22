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

// productId -> the sumProduct() result. Module scope so it survives a remount.
const cache = new Map();
// productId -> in-flight promise, so two renders asking at once read once.
const inflight = new Map();

// Approximate bytes this page has pulled for totals — the sum of the JSON length
// of every stock snapshot received. Surfaced on the card so the cost of the
// screen is visible to the person paying for it, not buried in a report.
let bytesRead = 0;
let readsIssued = 0;

export function totalsBytesRead() { return bytesRead; }
export function totalsReadsIssued() { return readsIssued; }
export function cachedTotals(productId) { return cache.get(productId) || null; }
export function cachedCount() { return cache.size; }

// Test seam only — the card never calls this.
export function __resetTotalsCache() { cache.clear(); inflight.clear(); bytesRead = 0; readsIssued = 0; }

// One product, every location. Ten small reads, summed by the pure core.
async function readOne(productId, locationIds) {
  const byLoc = {};
  await Promise.all(locationIds.map(async (locationId) => {
    const snap = await get(ref(database, `stock/${locationId}/${productId}`));
    readsIssued += 1;
    const val = snap.val();
    if (val != null) { byLoc[locationId] = val; bytesRead += JSON.stringify(val).length; }
  }));
  return sumProduct(byLoc);
}

// Totals for one product, memoised. Concurrent callers share one read.
export function productTotals(productId, locationIds) {
  if (cache.has(productId)) return Promise.resolve(cache.get(productId));
  if (inflight.has(productId)) return inflight.get(productId);
  const p = readOne(productId, locationIds)
    .then((totals) => { cache.set(productId, totals); inflight.delete(productId); return totals; })
    .catch((err) => {
      inflight.delete(productId);
      // A denied or failed read is UNKNOWN, never zero. Returning 0 here would
      // put a confident wrong number in front of a reordering decision.
      console.warn(`Network totals read failed for ${productId}:`, err);
      return null;
    });
  inflight.set(productId, p);
  return p;
}

// Totals for a list of products, at most `concurrency` products in flight at a
// time so a page of 25 does not open 250 sockets' worth of work at once.
// `onRow(productId, totals)` fires as each lands, so rows fill in progressively
// instead of the screen sitting blank until the slowest read returns.
export async function loadTotals(productIds, locationIds, onRow, concurrency = 6) {
  const queue = [...new Set(productIds || [])];
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const id = queue[cursor++];
      const totals = await productTotals(id, locationIds);
      if (onRow) onRow(id, totals);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}
