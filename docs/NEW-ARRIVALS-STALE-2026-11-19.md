# Why the New Arrivals card looked stale (diagnosis, 19 Nov 2026)

Junid's report: the card at `#new-arrivals` is stale; new stock is not on it.

## What was checked (live RTDB, read-only, keyed or key-range reads only)

| Check | Result |
|---|---|
| Newest entry in `new_arrivals/by_status/new` | `p1795091316459` (Timberland), enqueued **19 Nov 2026 12:28 UTC** — the same minute it was uploaded |
| Products created since 25 Sep 2026 (`products` orderByKey from `p1790294400000`) | 1,361 |
| …of those already in the queue (any status) | **1,359**. The two that are not are from 25 Sep, before the card existed (go-live 2 Oct) |
| Products carrying the upload marker `newArrivalAt` | 1,302; the other 59 came in through the `createdBy.at` fallback (devices on an older bundle) |
| Other paths that create a product | none — `addProductOnce` (`src/App.jsx`) is the only writer of a new `products/{pid}`, and it stamps `newArrivalAt` |

**The feed never stopped.** Nothing was ever missed because the item was priced first: `newArrivalsEnqueue` does not look at price (the 3 Oct "Missing price" rule is gone from the code). The marker on the upload write path (`newArrivalAt`, written with `serverNowMs()`) fires on every upload.

## The real cause: the card's order, and what it listed

1. **Oldest first.** `newArrivalsList` ordered each group photo-ready → generating → no photo, then **by key, oldest upload first**. With 1,474 items in New and generation paused since 8 Oct, the top of the card has been the same early-October items for six weeks. Today's uploads were on page 5 of Sneakers and page 45 of Clothing.
2. **Sold-out and deleted items were listed.** 56 of the 1,474 had nothing in stock at any counted location, and 4 pointed at products that were deleted. They filled the card with things that cannot be sold.

## The fix (19 Nov 2026, rebuilt card)

- **The upload marker needed no change.** `newArrivalAt` (written with
  `serverNowMs()` by `addProductOnce`, the one upload write path) already puts
  every upload in New, priced or not. `scripts/newArrivals/backfillNew.mjs`
  (bounded key-range read, idempotent) was run anyway, to prove nothing was missed.
- **New = the last 20 days.** `listLive` reads the New lanes with
  `orderByKey().startAt("p" + (now − 20 days))`. The key IS the upload time, so
  this is an indexed read on the upload timestamp, never a whole lane. Only items with stock
  above zero are listed. Deleted and sold-out products are counted apart, not moved.
- **Newest upload first**, and each card says "Uploaded 12 Nov" before any
  generation. The date comes from `newArrivalAt`, else `createdBy.at`, else the
  creation write (the id).
- Tabs **New / Approved / Done**, "Use current photo", Un-approve and "Post all
  approved": see `NEW-ARRIVALS.md`.
