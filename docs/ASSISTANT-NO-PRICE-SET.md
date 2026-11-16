# "No price set" on the assistant view for priced products — diagnosis

Reported by Junid, 16 Nov 2026: on the Concrete store assistant view (the
order cards, including the sky-wall phone layout) Manchester City soccer
jersey black (SKU 6080) and blue (SKU 6082) showed "No price set" with "Tap to
add". The admin price editor showed Stock R250 / Retail R300 for both. Older
jerseys at R200 (SKUs 1882, 1883, 3266) showed their price on the same screen.

## Two candidate causes

(a) **Field mismatch.** Missing Prices / the price editor writes one field and
the card reads another.

(b) **Stale device copy.** The card renders from the device's offline mirror,
which never received the price change.

## Evidence

### The live records (targeted reads by key, 16 Nov 2026)

| SKU  | id               | `retailPrice` | `stockPrice` | `price` |
|------|------------------|---------------|--------------|---------|
| 6080 | `p1793455269367` | `300` (number) | `250` (number) | absent |
| 6082 | `p1793455822491` | `300` (number) | `250` (number) | absent |
| 1882 | `p1782464018261` | `200` (number) | `200` (number) | absent |
| 1883 | `p1782464117738` | `200` (number) | `200` (number) | absent |
| 3266 | `p1784450740350` | `200` (number) | `200` (number) | absent |

The new and the old jerseys hold their price in exactly the same field, with
the same type. No product carries a legacy `price` field.

The price batches: `price_history/pb_1794602498651_dfgdyj` (blue) and
`pb_1794602504745_5ocwzk` (black), `single_edit`, label "Missing Prices: …",
by jafer@marathon.internal, 13 Nov 2026 20:41 UTC (22:41 SAST), each
`to: { retailPrice: 300, stockPrice: 250 }`. (The report said 15/11; the
stored `atMs` is 13 Nov.)

### The write path: Missing Prices and the price editor

- `src/components/admin/missingPriceSave.js:24-28`: Missing Prices builds only
  the missing fields and hands them to `saveProductPrices`.
- `src/components/admin/productPriceSave.js:16-37`: the one product price
  save. Fields are `stockPrice` and `retailPrice` (`PRICE_FIELDS`).
- `src/utils/priceBatch.js:153`: `updates["products/${pid}/${field}"] = v`, a
  number (`asStoredPrice`, `priceBatch.js:59`).
- `src/components/admin/priceStore.js:96`: one atomic `update()` at the root.

So both editors write `products/{id}/retailPrice` as a number.

### The read path: every "No price set" on the assistant view

Every site reads `retailPrice` and requires a positive number:

- `src/App.jsx:9225` and `src/App.jsx:9265`: `AssistantDesktop` grid card
  (`priced = typeof p.retailPrice === "number" && p.retailPrice > 0`).
- `src/App.jsx:9422-9424`: quick-view / sky-wall popup.
- `src/App.jsx:12098-12103`: `AssistantView` phone grid card (the "Tap to add →"
  card).
- `src/components/assistant/OrderLinesPanel.jsx:32,43` and
  `src/components/assistant/assistantOrderModel.js:66`: order lines and total.

**(a) is ruled out.** The editors write the field the card reads, with the type
the card requires. Searching this Mac's local mirror (all 6,216 products,
local IndexedDB, no database reads) found 0 products with a non-number
`retailPrice`, 0 with a price only in a legacy field, and exactly 1 unpriced
product in the whole catalogue (not a jersey).

### Where the card's `products` come from

`AssistantView` (`src/App.jsx:21436`) and `AdminView` (`src/App.jsx:21336`)
both take `products` from `useProducts()` (`src/App.jsx:640-717`). On a device
serving the offline mirror, that is `useMirroredPath("products")`
(`src/offline/useMirroredPath.js`), read from IndexedDB, not from RTDB.

A device's copy of a row moves only when the change feed carries it:

- server: `functions/mirrorChanges/mirrorChanges.js:99-125`. One trigger per
  node appends `{ n, k, t }` to `/mirror_changes`.
- client: `src/offline/changeFeed.js` `runChangeFeedPage` re-reads the row and
  upserts it. Then `mirrorSignal.bumpLegs` wakes `useMirroredPath`.

For these two saves the server side did its job. `/mirror_changes` holds
`-P6LdEh7lwwQOa-fCq2W` (`p1793455822491`, t=1794602498894) and
`-P6LdGBltmt5OJWvzs7X` (`p1793455269367`, t=1794602505015), 0.24 s and 0.27 s
after the saves. A device whose feed read those records holds R300. This Mac's
mirror does.

### Why a device can stay stale indefinitely: the gap this fixes

**(b) is the cause.** A device that missed those two records holds the
pre-price row, and nothing ever corrects it:

- The only self-heal is the daily census
  (`functions/mirrorChanges/mirrorChanges.js:128-180`). It compares **row
  counts**. A price edit on an existing row changes no count, so a missed price
  edit is invisible to it.
- The count-drift repair goes by keys. Its own comment
  (`src/offline/sync.js`, `resetFeedCursor`) says a keys-only repair "puts back
  missing rows and leaves every value that changed in the gap stale".
- Benched or backing-off feeds (`/mirror_devices` shows Concrete tablets
  timing out on `/mirror_changes (key page)`, serving 13–15 of 21 legs) skip
  passes. Wherever a record goes unapplied, the row it names stays stale.
- In admin, both cards come from the same array on one device. So Junid's R300
  in the editor and "No price set" on the assistant view were two different
  copies of the catalogue: the editor on a device that had the row, the
  assistant view on a device that did not.

The device that rendered "No price set" could not be identified from
`/mirror_devices`. It reports health, not row contents. So the fix does not
depend on knowing which device it was.

## Fix (next commit)

1. One reader, `retailPriceOf(p)` (`src/utils/retailPrice.js`): canonical
   `retailPrice`, then a defensive fallback to a legacy `price`. Every assistant
   site above uses it.
2. A targeted backstop on the device, using the existing mechanism. When the
   assistant view would render a product as unpriced while serving the mirror,
   it re-reads that **one row** (`products/{id}`) once per session. If the
   server has a different row, it patches the local copy and bumps the
   products leg (`mirrorSignal.bumpLegs`). That is the same signal the change
   feed uses, so `useMirroredPath` re-reads and the price appears. Cost is one
   child read per unpriced product per session (1 in the whole catalogue
   today). No whole-node read, no polling.
3. The price save notes its write in the existing pending-write echo
   (`src/offline/pendingWrites.js`), so the saving device shows the new price
   at once.

## Data check (16 Nov 2026)

`scripts/audit/assistant-no-price-census.mjs`, read-only and bounded (a key
range of `/price_history_index`, then batches and product fields by key). Full
output: `docs/assistant-no-price-census-2026-11-16.txt`.

- **Field mismatch: 0 products.** Across the 1,227 products touched by the
  1,759 price batches of the last 30 days, none holds a price in the editor's
  field that the old card logic would refuse. That fits the 6,216-row local
  mirror check above (0 string prices, 0 legacy-only prices).
- **First priced in the window: 943 products** (`retailPrice` went from not
  set to a price): 747 by mc@, 167 by jafer@, the rest by others. The big days
  were 30 Oct (378), 31 Oct (129), 1 Nov (80), 2 Nov (75) and 13 Nov (171,
  6080 and 6082 among them). These are the rows a device that missed the
  change record would still show as "No price set". Which devices missed which
  records cannot be read from the server. With this fix, any such card heals
  itself the first time it is on screen.

No data was rewritten. The fix needs none: the server rows were right all
along.
