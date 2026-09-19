# The store app, read from a local copy

**Status:** BUILT, behind a flag that is off. Measurements taken live on
**2026-09-19**.
**Purpose:** cut this app's Firebase read bandwidth to near zero by giving every
device one full download at setup and nothing but small change records
afterwards.

This document is the map. It names every read site that costs money, says which
local store answers it, which change feed keeps that store current, what the one
download costs, and what a device should cost per trading day once it is done.

Everything here that is a number was **measured**, not estimated, unless it says
"estimate" in the line.

---

## 1. Why

The app reads whole RTDB nodes on every screen mount. The nodes are no longer
small. Measured against the live database on 2026-09-19 (RTDB REST, which does
**not** gzip — see `reference_rtdb_read_costs_measured`):

| node | bytes | children |
| --- | ---: | ---: |
| `/insights_log` | 35,800,960 | 112,968 |
| `/stock_movements` | 31,808,870 | 90,922 |
| `/refill_requests` | 9,029,369 | 27,456 |
| `/restock_log` | 8,002,748 | — |
| `/stock` (10 locations) | 6,888,454 | 10 |
| `/products` | 4,679,403 | 4,945 |
| `/orders` | 2,647,522 | 3,016 |
| `/customers` | 1,808,403 | 9,662 |
| `/restock_requests` | 1,388,860 | — |
| `/settings/hubSneakerCount` | 1,158,028 | — |
| — of which `register`, the only part read whole | 353,404 | — |
| `/returns_log` | 750,814 | — |
| `/settings/displayRows` | 333,910 | — |
| `/settings/displaySlots` | 138,896 | — |
| `/settings/productTaxonomy` | 19,346 | — |
| `/users` | 12,746 | — |
| `/locations` | 927 | — |

Per-location `/stock` (the six active locations; `base`, `studio`, `trophy` and
`in_transit` make up the remainder of the 6.89 MB total):

| location | bytes |
| --- | ---: |
| `marathon-pe` | 1,612,823 |
| `hub2` | 1,546,902 |
| `central` | 1,416,349 |
| `hub1` | 547,179 |
| `marathon-pine` | 304,062 |
| `hub3` | 128,731 |

Product imagery in Cloud Storage:

| object | count | bytes |
| --- | ---: | ---: |
| `products/*/thumb_300.webp` | 5,292 | 111,346,582 |
| `products/*/photo.jpg` | 5,345 | 674,239,666 |

A tablet that opens Insights, then Customers, then the Source screen pays
`/insights_log` once per provider lifetime and `/stock_movements`,
`/refill_requests` and `/products` again on each mount that is not already
subscribed. A parked stale bundle once cost about **$400/month** on its own.

---

## 2. The shape of the answer

```
            ┌───────────────────────── one time, at setup ────────────────────┐
  RTDB  ───▶│ full read of each mirrored node ──▶ IndexedDB  (marathon-store-mirror) │
            │ thumbnails ──────────────────────▶ Cache Storage (no service worker)   │
            └────────────────────────────────────────────────────────────────┘

            ┌───────────────────────── every pass, afterwards ───────────────┐
  RTDB  ───▶│ ranged reads from a stored cursor ──▶ the same stores          │
            └────────────────────────────────────────────────────────────────┘

  screens ──▶ local store  ⊕  outbox (this device's unsent writes)
  writes  ──▶ outbox ──▶ RTDB          (orders, fulfil, transfer, receive, count,
                                        display confirm — unchanged semantics)
```

Two rules hold the whole thing up, and both are lessons paid for on the POS
mirror:

1. **Empty is never success.** A leg that reads zero rows from a node that
   cannot legitimately be empty records a *failure*, keeps the rows it already
   has, and throws. A short page never deletes local data and never stamps
   itself healthy. (The POS mirror once shrank from 4,654 products to 799 and
   reported both legs `ok: true`.)
2. **A local read must include this device's own outbox.** Otherwise a user
   sees a stale number immediately after their own action.

---

## 3. Every read site that costs money

"Local store" is the IndexedDB object store (or meta key) that answers it after
the switch. "Feed" is what keeps that store current — see §4.

### 3.1 The five chokepoints

Almost all of the cost funnels through five functions. Switching these five
switches most of the app.

| # | chokepoint | node(s) read today | local store | feed |
| --- | --- | --- | --- | --- |
| 1 | `useProducts()` — `src/App.jsx:579` | `/products` whole | `products` | `changes` |
| 2 | `useOrders(scopeShop)` — `src/App.jsx:911` | `/orders` whole or `destShop`-scoped | `orders` | `changes` |
| 3 | `useCustomersDb()` — `src/App.jsx:1788` | `/customers` whole | `customers` | `changes` |
| 4 | `usePath(path)` / `usePathState(path)` — `src/components/stock/useStock.js` | `/stock`, `/stock/{loc}`, `/stock_movements`, `/refill_requests`, `/transfers`*, `/stock_alerts`*, `/locations`, `/settings/displaySlots`, `/settings/displayRows`, `/settings/hubSneakerCount/register/{hub}`, `/settings/missingProductsHidden`, `/settings/stockHold`, `/config/transit` | `stock`, `movements`, `refills`, `displaySlots`, `displayRows`, `displayRegister`, `docs` | `changes` + `movements` |

**A leg is scoped to what is actually read whole.** `/settings/hubSneakerCount`
is 1.15 MB, but the only part any mirrored read touches is `register/{hub}` at
353 KB — `counted` and `sessions` are reached by one-shot `get()`s and always
will be. Mirroring the parent would have put 800 KB on every device for ever to
serve nothing. The mirrored leg is `/settings/hubSneakerCount/register`, and a
read of a sibling returns MISS and goes live, which is correct.

Two nodes carry **base64 images inline**: `/restock_requests` and
`/restock_log`. That is real weight in the setup download (8.0 MB and 1.4 MB),
and it is weight the app pays on every whole-node read today.
| 5 | `InsightsLogProvider` — `src/insights/InsightsLogProvider.jsx:41` | `/insights_log` whole | `insights` | `insights` |

### 3.2 The rest, by node

| read site | node | local store | feed |
| --- | --- | --- | --- |
| `useTvOrders()` — the always-on kiosk | `/orders` key range `001…999` | `orders`, with the SAME key bound applied locally | `changes` |
| `useInsightsLogRecentDays(days)` `src/App.jsx:1078` | `/insights_log` key range | `insights` (range applied locally) | `insights` |
| `useAllSourceResponses()` | `/restock_requests` whole (1.4 MB, base64 photos inline) | `restockRequests` | `changes` |
| `useClothingOos()` | `/clothing_sold_refills` whole (4 B live) | `docs` | `changes` |
| `useClothingSoldMovements(from)` `src/App.jsx:1586` | `/stock_movements` `orderByChild(ts)` range | `movements` (range applied locally) | `movements` |
| `useRestockLogRaw(date)` | `/restock_log/{date}` | `restockLog` | `changes` |
| `useRestockLogAll()` `src/App.jsx:1732` | `/restock_log` whole | `restockLog` | `changes` |
| `useReturnsLog()` `src/App.jsx:1751` | `/returns_log` whole | `returnsLog` | `changes` |
| `useCustomerIndex()` `src/App.jsx:1822` | derived from `/insights_log` | `insights` | `insights` |
| `useBroadcastHistory()` `src/App.jsx:1892` | `/broadcastHistory` (1.8 KB) | not mirrored — live, trivially small | — |
| `useGroupBroadcastHistory()` `src/App.jsx:1917` | `/broadcasts` (4 B) | not mirrored | — |
| `useNameProposals()` / `usePhotoProposals()` `src/App.jsx:3364,3379` | `/aiAssistant/*` | not mirrored — admin-only, small | — |
| `useTaxonomy()` `src/components/admin/useTaxonomy.js` | `/settings/productTaxonomy` (19 KB) | `docs` | `changes` |
| `RefillHistory` / `MissingFootwear` — one-shot `get()` on a button press | `/refill_requests` whole (9.0 MB) | `refills`, via `readPathOnce` | `changes` |
| `useStyleCodeConfig()` `src/components/admin/useStyleCodeConfig.js:34` | `/settings/styleCodeConfig` | not mirrored — small, admin | — |
| `useLayby()` `src/components/layby/useLayby.js:38` | `/laybys` | not mirrored — POS-owned | — |
| `CardReconScreen` `src/components/cardrecon/CardReconScreen.jsx:187,196` | `/card_batches` | not mirrored — owner-only screen | — |
| Social / Shopify / admin `get()` call sites | per-record | not mirrored — occasional, per-record | — |
| `ensureBarcode()` `src/components/stock/barcodeStore.js` | `/products/{id}/barcodes/{size}`, `/barcodes/{code}` per record | not mirrored — the store app never reads `/barcodes` whole | — |

\* `/transfers` (2.2 KB) and `/stock_alerts` (4 B) go through that chokepoint
but are **not legs**, so `legFor` returns MISS and they stay live. That is
correct — both are smaller than the change record that would track them — and
it is listed here because the chokepoint's name would otherwise imply
otherwise.

**Still live, and named rather than left out.** These render product photos or
read small nodes on occasional, admin-or-owner-only screens and were not
switched: `src/components/admin/*` (the bulk-pricing, specials, style-code and
new-product surfaces), `src/components/social/*`, `src/components/shopify/*`,
`src/pages/DisplayChecks/*`, `MarketingView`, `useDisplayChecks`,
`useAttentionLists`, and `armingStore`'s per-hub `get(stock/{hub})`. They are a
real remaining cost on those screens and a short list rather than a silence.

**Not mirrored, and why.** Anything read one record at a time, anything under a
kilobyte, and anything on an owner-only or admin-only screen stays live. The
mirror is for what is read *whole*, *often*, by *staff*. Adding a node to the
mirror costs setup bytes on every device forever; adding a live per-record read
costs a few hundred bytes when someone presses something.

### 3.3 Photos

| surface | object | held where |
| --- | --- | --- |
| every grid, list, picker, order card, refill row | `products/{id}/thumb_300.webp` | Cache Storage, pre-downloaded at setup (trickled, non-blocking), rendered via `<MirroredImg>` |
| product detail, label print, re-shoot compare | `products/{id}/photo.jpg` | Cache Storage, **fetched on demand once** and kept — never pre-downloaded |

**31 render sites are wired**: App.jsx's shared `ProductPhoto` helper (and all
17 of its call sites), its seven grid `<img>`s, and six staff-facing stock
components. A browse screen showing forty products goes from 4.4 MB to nothing.
The admin, social and display-check surfaces are still on the network — see
"Still live" in §3.2.

674 MB of full-size originals is not a thing to put on a phone. The thumbnail
set is 111 MB and is what every browsing surface actually renders. A full-size
photo is fetched the first time a person opens that one product and never
again.

### 3.4 How a screen actually switches

One function answers every screen:

```js
readMirroredPath(db, path)   // exactly what get(ref(database, path)).val() would return
```

The same tree, entered at any height; `null` — never `{}` — for an empty node,
because RTDB cannot store an empty object and every `if (!data)` in this app
depends on that; and `MISS` for a path no leg covers, which is a *different*
answer from null and is what makes a live fallback possible.

Every switched hook keeps its own shaping function and uses it for **both**
sources, so what a screen holds cannot depend on where the rows came from. The
one deliberate exception is the legacy `{items:[…]}` products migration, which
WRITES — a mirrored read must never write to the database it is a copy of.

**The decision is synchronous.** A hook decides on its first render whether to
open a live `onValue`, and opening one costs the whole node. So "is this device
serving locally" cannot be an answer that arrives later: it is a hint in
`localStorage` (`src/offline/serving.js`), refreshed after every pass. It is a
hint and not data — every hook falls back to a live read the moment the local
copy cannot actually answer, so a stale hint costs one check and never a blank
screen.

`src/offline/__tests__/servingSkipsTheSubscription.test.jsx` counts `onValue`
calls, including on the first render. A version of this work that read locally
*and* subscribed would pass every other test and save nothing.

### 3.5 A person never sees their own action undone

On a mirrored device the path from "I pressed Send" to "the screen shows it" is
RTDB → trigger → change record → this device's feed, which is a second or two.
That is long enough to press a button, see the old number, and press it again.

`src/offline/pendingWrites.js` echoes the paths just written until the feed
carries the same fact back round. It is an **echo, not a queue**:

- writes are completely unchanged — orders and the five warehouse actions go
  straight to RTDB with the same transactions and the same failure behaviour;
- it is recorded *after* RTDB accepts, so it echoes what the database took,
  never what we hoped it would;
- it expires, so it can never pin a value on screen after somebody else has
  changed it.

It is fed at `applyMovement.js`, which every fulfil, transfer, receive, count
and adjust in this app goes through, rather than at all fifty-odd write sites.

---

## 4. The change feeds

Three mechanisms, chosen per node by what the node *is*. No feed is a
whole-node read, and every feed resumes from a cursor persisted in `meta`.

### 4.1 `insights` — append-only, push keys, no index

`/insights_log` keys are Firebase push keys, which encode write time.
`orderByKey().startAfter(<last key held>)` is therefore a complete forward feed
and needs **no `.indexOn`**. `src/insights/insightsLogRange.js` already owns the
key arithmetic and the measured ±48 h skew padding; callers keep filtering on
`timestamp`, exactly as they do today, so the range can change what is
downloaded and never what is rendered.

### 4.2 `movements` — append-only, indexed on `ts`

`/stock_movements` rows are immutable once written and carry an ISO `ts`.
`orderByChild("ts").startAt(<last ts held>)` is a complete forward feed. The
index **already exists live**: `/stock_movements` `.indexOn: ["ts"]`. No paste
needed.

### 4.3 `changes` — everything mutable, via one change log

The mutable nodes (`/products`, `/stock`, `/customers`, `/orders`,
`/refill_requests`, `/restock_log`, `/restock_requests`, `/returns_log`,
`/settings/*`) have no field that reliably moves on every write, so there is
nothing to range over. Rather than add an `updatedAt` to dozens of write sites
in two repos — and trust that none is ever missed — one Cloud Function trigger
per node appends a tiny record to a single log:

```
/mirror_changes/{pushKey} = { n: "<node>", k: "<child key>", t: <serverNowMs> }
```

Push keys again, so the client reads `orderByKey().startAfter(cursor)` and needs
**no `.indexOn`**. For each record the client re-reads that one child
(`/products/p123…` is about 950 bytes) and upserts it; a child that reads back
`null` was deleted and is removed locally. Deletes therefore propagate, which a
timestamp cursor could never do.

**Retention and the honest failure.** A sweeper keeps 30 days of
`/mirror_changes`. A device whose cursor is older than the oldest record kept
**cannot** catch up, and must not pretend to: it records the leg failed with
reason `cursor-expired` and runs that leg's setup download again. This is the
only path back to a full read after setup, it is deliberate, and it is visible
on the status dot.

**Cost of the feed itself.** One small RTDB write and one function invocation
per mutation. Measured mutation volume over the 7 days to 2026-09-19:
`/stock_movements` +1,868,227 bytes and `/insights_log` +2,024,392 bytes, which
bound the mutation rate at roughly 6,000 rows/week on the two busiest nodes.
A `/mirror_changes` record is about 60 bytes.

### 4.3a How fast it is

A cadence alone makes every screen as stale as the cadence, and a minute
between one device's write and another's screen is not "what it displays
today". So the 60-second pass is a **floor**, and on top of it sits an
`onChildAdded` over `/mirror_changes` **from the cursor** — it streams the
records themselves, about 60 bytes each, never a node.

It is a **signal, not a source**: the callback does not carry the record into
the mirror, it asks the engine to run a pass, which reads the page properly and
commits it with its cursor. One path applies changes and it is the tested one.
A burst is debounced, so a refill run costs one pass rather than hundreds.

### 4.3b The `/stock_movements` cursor is a PAIR

`ts` is not unique — one transfer writes several movements with an identical
ISO string — so the bound must be inclusive or every movement of a multi-size
transfer but one is lost. Inclusive on `ts` alone, though, means every pass
re-reads every row sharing the newest timestamp, for ever: fifty movements at
one timestamp × 1,440 passes a day is about 25 MB per device per day, against
a budget of 267 KB.

RTDB's two-argument `startAt(value, key)` is the answer. The cursor carries
`{ ts, key }`, resumes at the exact row last consumed, and re-reads **one** row
instead of a timestamp's worth. The duplicate is an upsert and costs nothing.

### 4.4 What is NOT a feed

Nothing re-reads a whole node after setup. Nothing polls. There is no
"re-sync everything every four hours" cadence, which is what the POS mirror does
for `/products` and which would defeat the purpose here.

---

## 5. Setup download, per device

Measured, 2026-09-19.

### 5.1 Data — blocking

| node | bytes |
| --- | ---: |
| `/insights_log` | 35,800,960 |
| `/stock_movements` | 31,808,870 |
| `/refill_requests` | 9,029,369 |
| `/restock_log` | 8,002,748 |
| `/stock` | 6,888,454 |
| `/products` | 4,679,403 |
| `/orders` | 2,647,522 |
| `/customers` | 1,808,403 |
| `/restock_requests` | 1,388,860 |
| `/settings/hubSneakerCount/register` | 353,404 |
| `/returns_log` | 750,814 |
| `/settings/displayRows` | 333,910 |
| `/settings/displaySlots` | 138,896 |
| `/settings/productTaxonomy` | 19,346 |
| `/users` | 12,746 |
| `/locations` | 927 |
| **total** | **103,664,632 (≈ 103.7 MB)** |

### 5.2 Photos — background, non-blocking

| | count | bytes |
| --- | ---: | ---: |
| thumbnails | 5,292 | 111,346,582 (≈ 111.3 MB) |

The setup screen blocks on the data legs only. Thumbnails trickle afterwards, a
few per pass, and a missing thumbnail degrades to the placeholder the app
already shows — it never blocks a screen. A device is *usable* after ≈ 103.7 MB
and *complete* after ≈ 215 MB.

### 5.3 What that replaces

A single staff tablet that opens Insights, Customers, the Source screen and the
Refill Queue during a shift pays, today, on the order of
35.8 + 1.8 + 31.8 + 9.0 + 4.7 + 2.6 MB ≈ **86 MB per cold pass**, and pays it
again on each reload, each forced update and each provider release. The setup
download is paid **once, ever, per device**.

---

## 6. Steady state, per device per day

Derived from the measured 7-day mutation volume above, divided by 7:

| feed | bytes/day |
| --- | ---: |
| `insights` (`/insights_log` deltas) | ≈ 289,000 |
| `movements` (`/stock_movements` deltas) | ≈ 267,000 |
| `changes` log itself (≈ 60 B × mutations) | ≈ 60,000 (estimate) |
| re-read of changed children (products/stock/orders/refills) | ≈ 400,000 (estimate) |
| version poll (`/version.json`, 1 × 5 min) | ≈ 15,000 |
| the pass itself (3 bounded reads a minute, mostly empty) | ≈ 120,000 (estimate) |
| the live change signal (`onChildAdded`, ≈ 60 B a record) | ≈ 60,000 (estimate) |
| **total** | **≈ 1.15 MB per device per day** |

Against ≈ 86 MB per cold pass today, several times a day, per device.

These are the numbers to hold the rollout to: **the flag goes on for one device,
a trading day is measured with the RTDB profiler, and the measured figure
replaces the estimate in this table before the flag goes on for everyone.**

---

## 7. Two id namespaces

The same shop has two ids and they are not interchangeable:

| meaning | POS / shift header | `/stock` and `/orders.destShop` |
| --- | --- | --- |
| Marathon PE | `pe` | `marathon-pe` |
| Marathon Pine | `pine` | `marathon-pine` |

The mirror maps this **explicitly**, in one place, and refuses an id it does not
know rather than guessing a path. A guessed path is exactly how the POS mirror
came to read `/stock/pe`, get zero rows, and stamp itself healthy.

The hub locations (`central`, `hub1`, `hub2`, `hub3`) have one id each.

---

## 8. Writes

Writes do not change semantics. Orders and the five warehouse actions — fulfil,
transfer, receive, count, display confirm — keep working exactly as they do
today. What changes is that they go through an **outbox**: the write is recorded
locally, applied to the local stores immediately so the screen shows the truth
the person just created, and sent to RTDB. The local read path is
`store ⊕ outbox`, so a number can never regress between pressing a button and
the write landing.

Timestamps on fields the rules validate use `serverNowMs()`, never `Date.now()`.

---

## 9. Forced update

A parked stale bundle once cost about $400/month, and a mirrored device makes
that worse rather than better: it has no whole-node subscriptions to make a
wrong bundle obvious, so it can sit on an old build for days reading a schema
the new build has moved on from.

So on a device serving from its local copy the reload is **forced** rather than
advisory: no three-minute idle requirement, and no once-per-version latch —
that latch would mean "busy at that moment" equals "never takes this build at
all".

Forced never means rude. Two things hold it off, and the first is absolute:

- **busy** — the same registry the cart and the count screens already use, plus
  "there are unsent writes", which the mirror registers;
- **a 30-second grace** after the update is first seen, so nobody is reloaded
  mid-sentence.

A device not serving from the mirror keeps exactly the old behaviour.

## 9a. The photo cache had to be spared by name

`main.jsx` cleared Cache Storage wholesale on every boot. That line predates the
photo mirror and would have deleted 111 MB of thumbnails on each load, which the
photos leg would then re-download for ever — the exact opposite of the point.

It now spares the photo cache by name, with a literal fallback so a failed
dynamic import cannot mean "spare nothing", and `photoCacheName.pin.test.js`
pins the two together. This restores nothing of the 2026-05-09 service-worker
rollback: that was a fetch-intercepting worker; this is a cache the page fills
and reads by hand.

---

## 10. Rules and indexes to paste

**`database.rules.json` is not edited by this work.** These are printed for the
owner to paste in the console.

### 10.1 New nodes `/mirror_changes` and `/mirror_counts`

There is **no live block for either** — neither node exists yet, so there is
nothing to place beside the new ones. Both inherit the database root, which
denies read and write.

`/mirror_counts` is as load-bearing as `/mirror_changes`: it is the daily
census, and it is the ONLY check this design has against a change record that
was never written. Without its read rule every census attempt is
permission-denied and the completeness backstop never runs at all.

Add, as siblings of `"insights_log"`:

```json
"mirror_changes": {
  ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
  ".write": "false"
},
"mirror_counts": {
  ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
  ".write": "false"
}
```

`.write: "false"` is deliberate: only the Cloud Function (admin SDK, which
bypasses rules) appends to this log. No client may.

For comparison, the live block for the node it sits beside, unchanged:

```json
"insights_log": {
  ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
  ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'"
}
```

### 10.2 Indexes

**None needed.** Every feed avoids an index by construction:

| feed | query | index |
| --- | --- | --- |
| `insights` | `orderByKey().startAfter(k)` | key order — never needs `.indexOn` |
| `changes` | `orderByKey().startAfter(k)` | key order — never needs `.indexOn` |
| `movements` | `orderByChild("ts").startAt(iso)` | `.indexOn: ["ts"]` — **already live** |

The live `/stock_movements` block, for the record:

```json
"stock_movements": {
  ".indexOn": ["ts"]
}
```

---

## 11. Rollout

The flag is `localStorage["marathon-store.offlineMirror"] = "on"`, per device.
There is deliberately **no UI anywhere in this app that writes it** — a
per-staff "work offline" switch is how half a shop ends up on one code path and
half on the other with nobody able to say which. It is a rollout control, and
once it is on the download starts by itself on the next open.

1. Build behind `mirrorFlag` — off for everyone. **Done: merged, flag off.**
2. Paste the `/mirror_changes` rule. Deploy the change-log functions, scoped by
   name.
3. Turn the flag on for **one** device. Watch the setup screen finish. Trade a
   day.
4. Measure that day with the RTDB profiler, **summing both billing accounts**
   (they were split on 22 Aug — see `project_bandwidth_capture_sept`).
5. Replace the estimates in §6 with the measured figures.
6. Turn the flag on for everyone.

---

## 12. Failure patterns this design is built against

Each of these happened on the POS mirror. Each has a named guard here.

| failure | guard |
| --- | --- |
| a short page read as end-of-node shrank the mirror and stamped itself healthy | every snapshot leg counts its rows against the server's count, refuses a shrink beyond 2% / 25 rows, keeps the last good copy, and records `shrank` |
| a leg that could not run wrote nothing, and looked identical to a leg not yet due | every leg leaves a verdict in `mirror.health.<leg>`, including "blocked" |
| an empty read wiped a good snapshot | `EmptyMirrorReadError` — empty is a failure on any node that cannot be empty |
| a failed refresh took a complete on-disk copy out of service | health carries `vouched`: what the last *accepted swap* put on disk, separate from whether the last *read* succeeded |
| `pe` vs `marathon-pe` | one explicit map, strict, returns null rather than guessing |
| a price change never reached a mirrored till | price is a field like any other, it arrives on the `changes` feed, and the end-to-end test asserts a price edit lands in the local store |
| a user saw a stale number right after their own action | every local read is `store ⊕ outbox` |
