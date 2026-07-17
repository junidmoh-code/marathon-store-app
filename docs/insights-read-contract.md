# `/insights_log` Read Contract

**Cost-reduction roadmap PR 2 — document only, no code.** This is the contract PR 3 will be
written and verified against. Its promise: after PR 3, **no dashboard number may change** —
and that is only checkable because this document records what every number is, which events
and fields produce it, and how it must be reconciled.

- Evidence base: `marathon-store-app` at `origin/main` (`08a00bb`, 2026-07-16), file:line refs
  throughout; `marathon-pos-app` for the POS writer; live production measurements dated
  2026-07-16 (shallow key count + sampled records, read-only).
- Where evidence is absent this document says **not measured**. It never estimates silently;
  the few derived numbers are labelled *derived* with the arithmetic shown.

## 0. Measured facts (production, 2026-07-16)

| Fact | Value | How measured |
|---|---|---|
| Total events | **43,344** | shallow key count of `/insights_log` |
| Node size | **~12.85 MB** | production profile (840 s window); consistent with 43,344 × ~300 B avg from sampled records |
| Log span | 2026-05-04 → 2026-07-16 (73 days) | first/last push key records sampled |
| Average growth | **~594 events/day** *(derived: 43,344 ÷ 73)* | arithmetic over measured totals |
| Per-action mix | **not measured** | would need a one-off scan; see §4 slice A note |
| Timestamp format | ISO-8601 string, **every writer** (`new Date().toISOString()`) | all 7 writer sites read (§0.2) |
| Keys | Firebase push ids (chronological) | all writers use `push()` / `push().key` |
| Pruning / TTL | **none — append-only, never deleted** | grep + `SCHEMA.md:169` ("never updated or deleted") |
| `.indexOn` | **none** on `/insights_log` | `database.rules.json:114-117` (stale file, but matches the live warning behaviour observed on `/orders` in PR 1) |
| Client read pattern | `onValue` on the **whole node**, no `orderByChild`/`limitToLast` | `useInsightsLog`, `src/App.jsx:683-700` |

### 0.1 The mount map — where the 12.85 MB gets downloaded

The prior audit said four features; **it is five client listeners plus two server one-shot
reads**. None share data; each mount downloads the entire node and re-materialises it on
every append.

| # | Listener | File:line | Feature |
|---|---|---|---|
| 1 | `CustomersView` → `useInsightsLog()` | `src/App.jsx:1660` | Customers view |
| 2 | `AdminView` → `useInsightsLog()` (prop-drilled to `AdminProductDetail`) | `src/App.jsx:4276` → `:4566` → `:4962` | Admin product detail (listener open whole time Admin is open) |
| 3 | `SourceView` → `useInsightsLog()` | `src/App.jsx:11956` | Source view (History + On Hold past days) |
| 4 | `InsightsView` → `useInsightsLog()` | `src/App.jsx:14326` | Insights view (10 tabs) |
| 5 | **`useCustomerIndex()` → `useInsightsLog()`** | `src/App.jsx:1448`, mounted at `:6757` | **Assistant view customer typeahead — omitted from the prior audit.** A full-node live listener open for the entire order-entry session, powering a top-5 prefix autocomplete. |
| 6 | `analyzeReorderNeeds` (server) | `functions/index.js:1446` | one-shot full read per scheduled run |
| 7 | `chatStream` (server) | `functions/index.js:2653` | **one-shot full read per assistant chat invocation** |

The 840 s profile recorded 1 read/listen on this node (~12.85 MB) — i.e. a single mount
during the window. Which of the seven it was: **not measured**. Mount frequency per feature:
**not measured**. This matters for §4's ROI ranking and is flagged there.

### 0.2 Event schema (write contract, for reference)

Seven writers, six `action` values. Full field-by-writer matrix:

| `action` | Writers | Notes |
|---|---|---|
| `placed` | store checkout (`App.jsx:7026`), clothing refill (`App.jsx:7144`, has `qty`), refill engine (`functions/refill-scan.cjs:340`, has `qty` + `autoRefill:true`) | engine events must be excludable (`autoRefill`) |
| `ready` | warehouse `updateStatus` (`App.jsx:8181`), clothing batch fulfil (`App.jsx:8544`, has `qty`) | "net sales" is built on this |
| `out_of_stock` | `updateStatus`, clothing batch reject (`App.jsx:8557`, has `qty`) | |
| `tomorrow` | `updateStatus` only | Source On Hold |
| `collected` | `updateStatus`; POS (`marathon-pos-app/src/sale/logOrderCollection.js:54`, has `source:"pos"`) | |
| `stock_depleted` | display-refill resolution (`App.jsx:8414`, has `displayRefilledBy`) | |

Fields always present: `timestamp, productName, productType, size, orderNumber, action,
placedAtHub`. Conditional: `productId` (`null`-able; **absent on ~18.6k pre-2026-06-10
events** — `SCHEMA.md:176`), `qty` (clothing/refill), `destShop` (store-app writers only),
`customerName`/`customerPhone` (real on sneaker orders; `"Shop Refill"`/`null` on refills),
`source` (POS only), `autoRefill` (engine only), `displayRefilledBy` (`stock_depleted` only).

`orderNumber` is the **daily** 001–999 counter — never unique alone; every dedupe below is
`(saDate(timestamp), orderNumber)`.

---

## Part 1 — Widget inventory

Conventions used below:
- **Depth** — the date window the widget's numbers cover (what it *needs*), independent of
  the fact that today every mount downloads all-time.
- **Freshness** — what the widget *needs*, not what the live listener incidentally gives it.
  Marked **live-required** only where the UI's purpose is to reflect events landing while the
  user watches. Everything else is **view-entry snapshot** (recompute on tab/filter change is
  enough; nobody stares at a report tab waiting for a counter to tick).
- **Underlying change rate** — node-wide it is ~594 appends/day *(derived)*; per-action split
  **not measured**. Stated per-widget only where structurally obvious.
- **Cardinality** — records surviving the widget's filters vs the **43,344** downloaded
  today. Survivor counts are **not measured** unless the window bounds them structurally
  (then a *derived* ceiling is given: window-days × 594). The gap between these two columns
  is the entire business case.

### 1.1 InsightsView (`src/App.jsx:14326`; 10 tabs; shared window filter `:14424-14460`, store filter on `destShop`/`placedAtHub` `:14341-14347`)

Window modes: day / week / month / year / **all-time**. Every tab is a view-entry snapshot;
none is live-required (the only "today"-ish surfaces, Clothing Refills and Stock Depleted
today-branches, already read live `/orders`, not the log).

| Widget (file:line) | Fields | Actions | Depth | Aggregation | Survivors vs 43,344 |
|---|---|---|---|---|---|
| Sidebar "N events in view" (`:14574`) | `timestamp`, `destShop`, `placedAtHub` | all | selected window | count | window-bounded; not measured |
| Overview KPI **Net Sales** (`:12962`, selector `readyEventsForPeriod` `:12894`) | `action`, `timestamp`, `orderNumber`, `productType`, `size` | `ready`, minus returns (via `returns_log` join), deduped `(saDate, orderNumber)` | window | count (+delta vs previous equal window `:12926`) | ≤ window×594 *(derived ceiling)*; not measured |
| Overview KPI **Out of Stock** (`:12963`) | same | `out_of_stock`, same dedupe/exclusion | window | count | not measured |
| Overview KPI **Returns** (`:12964`) | — | **reads `returns_log`, not this node** | — | — | — |
| Overview KPI **Top Product** (`:12965`) | `productName` | `ready` (net) | window | group-by, top-1 | not measured |
| "Lost to OOS" strip (`:12978`) | as OOS | `out_of_stock` | window | count + pct (`oos/(net+oos)`) | not measured |
| Sales-vs-OOS chart (`:12990`, buckets `:12912-12924`) | `timestamp` | `ready`, `out_of_stock` | window; **daily bars capped at ~92 most-recent days even in Year/All-Time** | hourly (today) / daily buckets | not measured |
| Top products panel (`:13004`) | `productName` | `ready` (net) | window | group-by, top-7 | not measured |
| Busiest hours panel (`:13008`) | `timestamp` (`getHours()`) | `ready` (net) | window | 24-bucket histogram | not measured |
| **Recent activity list** (`:13027`, `periodLog.slice(0,30)` `:13032`) | `productName`, `size`, `action`, `orderNumber`, `timestamp` | **all actions** | window | raw list, newest-first, top-30 | exactly 30 rendered; not measured pre-slice |
| Sales Summary headline + ranked list + size breakdown (`:13762-13892`) | `action`, `timestamp`, `orderNumber`, `productName`, `size`, `productType` | `ready` net (same selector as Overview — reconciles by construction) | window | sum + group-by product (uncapped) + (product,size) counts | not measured |
| Product Search: orders-by-product, size breakdown (`:13081-13088`) | `productName`, `size`, `action`, `timestamp` | `placed` | window | group-by | not measured |
| Product Search: **Order History raw list** (`:13091-13120`) | `productName`, `size`, `action`, `customerName`, `timestamp` | **all actions** matching name query | window | raw list, uncapped (scroll box) | not measured |
| OOS Tracker: total + per-product + per-size rows (`:13126-13185`) | `action`, `timestamp`, `orderNumber`, `productName`, `size`, `productType` | `out_of_stock` (deduped, returns-excluded) | window | count + nested group-by | not measured |
| Size Popularity charts (`:13223-13335`) | `action`, `timestamp`, `orderNumber`, `size`, `productCategory`, `productType` | `placed` (deduped; **returns deliberately NOT excluded** — demand semantics, comment `:13227`) | window | histogram by size, split sneaker/clothing | not measured |
| Busiest Times (hours + weekdays) (`:13344-13418`) | `action`, `timestamp`, `orderNumber`, `productType` | `placed` (deduped) | window | 24-bucket + 7-bucket histograms | not measured |
| Returns tab (`:13453`) | — | **`returns_log` only** | — | — | — |
| Clothing Refills tab (`:13521`, selector `src/utils/insights.js:180`) | `action`, `productType`, `size`, `placedAtHub`, `timestamp`, `orderNumber`, `productName`, `qty` | past windows: `placed` ∧ clothing ∧ `placedAtHub !== "hubC"`; **today branch reads live `/orders`, not the log** | window | Σ`qty` group-by product → size; distinct products | not measured |
| Stock Depleted tab (`:13618`) | `action`, `timestamp`, `orderNumber`, `productName`, `size`, `displayRefilledBy`∥`placedAtHub` | past: `stock_depleted` (deduped); today branch reads live `/orders` | window | group-by (product,size): count, lastAt, hub set | rare action; not measured |
| AI Reorder tab (`:13922`) | — | **does not read the log** (renders `/insights/reorderPlan/*`; the log read happens server-side, §1.6) | — | — | — |

### 1.2 CustomersView (`src/App.jsx:1660`)

| Widget | Fields | Actions | Depth | Freshness | Aggregation | Survivors |
|---|---|---|---|---|---|---|
| Customer list + Total/Opt-in counts (`:1669-1690`, `:1852-1881`, `:1985-2018`) | `customerPhone`, `customerName`, `timestamp` | `placed` | **all-time, genuinely unbounded** | view-entry snapshot | distinct-by-`phoneToKey`; per-customer `orderCount`, `firstOrderAt`, `lastOrderAt`; merged with `/customers` opt-in | distinct customers: not measured |
| Broadcast recipients (`:1888-1948`) | `customerPhone` | `placed` (via list above) | all-time | snapshot | filtered list | not measured |
| Customer Insights KPIs, trend, weekday chart, 4 top-12 leaderboards (`:1743-1820`, `:2038-2154`) | `action`, `customerPhone`, `customerName`, `timestamp`, `orderNumber` | `placed`, deduped `(date, orderNumber)`; returns joined from `returns_log` | **all-time or current-month** (`period` toggle) | snapshot | dedupe + group-by customer; histograms; top-12 ×4 | not measured |
| Customer drill modal (`:1824-1832`, `:2161`) | `action`, `customerPhone`, `customerName`, `timestamp` | `placed` for one customer | all-time | snapshot | raw per-customer list, newest-first | per-customer; not measured |

### 1.3 Admin product detail (`src/App.jsx:4276` → `AdminProductDetail:4962`)

| Widget | Fields | Actions | Depth | Freshness | Aggregation | Survivors |
|---|---|---|---|---|---|---|
| "Last sold … · N orders all-time" activity line (`:5151-5166`) | **`productName` (exact string match — not `productId`)**, `action`, `timestamp` | `placed` count; `collected`∥`ready` as "sold"; relies on newest-first sort for `sold[0]` | **all-time, unbounded** | snapshot | 2 counts + most-recent timestamp | per-product; not measured |

This is the *only* log consumer in Admin — yet the listener at the AdminView level holds the
full node live for the whole Admin session.

### 1.4 SourceView (`src/App.jsx:11956`) — past days only (today = live `/orders`)

| Widget | Fields | Actions | Depth | Freshness | Aggregation | Survivors |
|---|---|---|---|---|---|---|
| On Hold past-day fill (`:12041-12089`, selector `src/utils/insights.js:157`) | `action`, `timestamp`, `orderNumber`, `productName`, `productId`, `size`, `placedAtHub`, `customerName` | `tomorrow` | **rolling 5 SA-days** (`HISTORY_RETENTION_DAYS=5`, `:10905`) | snapshot | deduped list | ≤ ~5×594 pre-action-filter *(derived ceiling ≈ 3.0k)*; post-filter not measured |
| History tab pending counts + hub badges (`:10915-10933`, `:12094-12134`, selector `insights.js:132`) | `action`, `productType`, `size`, `timestamp`, `placedAtHub`, `productName`, `productId`, `orderNumber` | `ready` ∧ sneaker, per SA-day per hub, returns-excluded | same 5-day window | snapshot | group-by (product,size) counts | same ceiling; not measured |

**This is the starkest gap in the whole inventory: a hard 5-day window served by an all-time
download.**

### 1.5 Assistant customer typeahead (`useCustomerIndex`, `src/App.jsx:1447-1469`; consumed `:6757`)

| Widget | Fields | Actions | Depth | Freshness | Aggregation | Survivors |
|---|---|---|---|---|---|---|
| Name/phone autocomplete (top-5 prefix matches, `matchCustomers` `:1473`) | `customerPhone`, `customerName`, `timestamp`, `action` (`orderCount` counts `placed` only) | all with a phone | **all-time, unbounded** | snapshot is sufficient (a customer created seconds ago is also inserted into `/customers` by the same flow; typeahead freshness to the minute is not load-bearing) | distinct-by-phone index; top-5 prefix match | distinct customers; not measured |

**Live-required verdict across all widgets: none.** Every consumer is a report or an index.
The two surfaces that genuinely must reflect the current minute (Source today, refill/depleted
today) already read live `/orders`, not this log.

### 1.6 Server-side readers

| Reader | Read | Fields | Depth | Notes |
|---|---|---|---|---|
| `analyzeReorderNeeds` (`functions/index.js:1446`, aggregation `:656-729`) | full node, one-shot, per scheduled run | `action`, `productName`, `timestamp`, `size`, `orderNumber` | all-time read; windows internally to `REORDER_RECENT_DAYS` | writes `/insights/reorderPlan/latest` — already a projection; its *input* read is what costs |
| `chatStream` (`functions/index.js:2653`) | **full node, one-shot, per assistant chat invocation** | whole records (up to `CHAT_CONTEXT_RECENT_LIMIT` recent go to the model) | reads all, uses recent N | a bounded `limitToLast` read would be behaviour-identical here; frequency of chat use: not measured |

### 1.7 Explicit non-consumers (verified, to prevent scope creep in PR 3)

- `src/utils/clothingSold.js` and `ClothingSoldView` — read `/stock_movements`, **not** this
  log (header comment `clothingSold.js:6-9`); only imports the pure `inferProductType`
  classifier.
- Insights Returns tab and Overview Returns KPI — `returns_log`.
- AI Reorder tab client — `/insights/reorderPlan/*` only.

---

## Part 2 — Projection architecture (design only; nothing here is built in this PR)

### 2.0 Design constraints the inventory forces

1. **Returns retroactively mutate history.** "Net sales" for a past day changes when a
   return lands days later (`readyEventsForPeriod` joins `returns_log` at read time). A daily
   projection that bakes returns in is therefore **not** append-only and would need
   mutation-on-return — a consistency trap. **Decision: projections store return-agnostic
   figures; widgets keep applying returns from `returns_log` at read time, exactly as today.**
   `returns_log` is 509 KB / ~$1.4mo — cheap, already subscribed, and this preserves
   number-parity by construction.
2. **Dedupe is `(saDate, orderNumber)`** — projections must dedupe *at write/aggregation
   time* with the same composite, in SA timezone, or counts drift from the legacy selectors.
3. **Admin joins by `productName`, not `productId`** (`App.jsx:5151`), and ~18.6k legacy
   events have no `productId`. A product projection keyed by id would silently diverge for
   renamed products and legacy rows. **Decision: the product projection is keyed by
   `productId` but aggregated from events matched the way the widget matches today
   (name-exact), with the name captured in the node; the reconciliation phase (Part 3) is
   what proves equivalence, and any mismatch there blocks cutover for that widget.**
4. **The engine writer pollutes demand counts** unless `autoRefill:true` handling matches
   the legacy selectors exactly (today the client selectors do *not* exclude it; the server
   reorder aggregation is separately defined). Projections must replicate current inclusion
   semantics per widget, not "fix" them — fixing is a behaviour change and out of scope.
5. **Push keys are chronological and need no index.** An incremental builder can checkpoint
   `lastKey` and resume with `orderByKey().startAt(lastKey)` — no `.indexOn`, no full re-read.
   A `timestamp`-bounded client query, if chosen for any fallback, requires the console index
   (§2.5) — a PR 3 prerequisite pasted by Junid, never a repo rules deploy.

### 2.1 `/insights/daily/{saDate}` — frozen day rollups

**Shape** (one node per SA calendar day; realistic example):

```json
{
  "date": "2026-07-15",
  "cursorEnd": "-OxbQq...lastPushKeyOfDay",
  "counts": { "placed": 412, "ready": 371, "out_of_stock": 44, "tomorrow": 9, "collected": 355, "stock_depleted": 3 },
  "netReadyByProduct": { "p1778839163995": { "name": "Adidas F50 Elite ...", "n": 17, "sizes": { "6": 4, "7": 9, "8": 4 } } },
  "oosByProduct":      { "p1778...": { "name": "...", "n": 3, "sizes": { "9": 3 } } },
  "placedBySizeSneaker": { "6": 40, "7": 88 },
  "placedBySizeClothing": { "M": 31, "L": 22 },
  "placedByHour": { "9": 41, "10": 66 },
  "placedByStore": { "marathon-pe": 210, "trophy": 88, "marathon-pine": 74, "unattributed": 40 },
  "clothingRefill": { "byProduct": { "p123": { "name": "...", "units": 34, "sizes": { "M": 20, "L": 14 }, "lastAt": "2026-07-15T16:02:11.000Z" } } },
  "stockDepleted": { "byProductSize": { "p9::8": { "name": "...", "size": "8", "n": 1, "lastAt": "...", "hubs": ["hub1"] } } },
  "readyOrderNumbers": { "233": true, "234": true },
  "oosOrderNumbers": { "199": true }
}
```

`readyOrderNumbers`/`oosOrderNumbers` (the deduped per-day sets) are what let widgets apply
the read-time returns exclusion **identically to today**: a return referencing
`(saDate, orderNumber)` subtracts iff that composite is in the day's set — same join the
legacy selector performs. ~600 events/day means a few hundred keys/day; *derived* size
estimate ~15–40 KB/day versus 12.85 MB per legacy mount. Store-dimension caveat: the sidebar
store filter slices every tab by `destShop`/`placedAtHub`; the shape above carries
`placedByStore` for placed, but per-store slices of every other aggregate would multiply the
node by the store count. **Whether Insights tabs keep the store filter against projections
(x3 size) or the store filter becomes a bounded-query path is a PR 3 decision — flagged, not
decided here; the reconciliation harness must cover whichever is chosen.**

- **Serves:** every InsightsView tab figure listed in §1.1 except the two raw lists;
  SourceView History + On Hold (which additionally need per-event rows — see §2.4);
  Overview chart buckets (daily; the today-hourly variant comes from the today window, §2.4).
- **Does not serve:** Recent-activity list, Product-Search order-history list (raw event
  rows — §2.4); anything customer-keyed (§2.3); Admin product line (§2.2).
- **Write path:** a scheduled Cloud Function (the repo's proven pattern — cf. PR 1's sweep)
  runs every N minutes:
  1. read `/insights/meta/cursor` (last durably processed push key);
  2. `orderByKey().startAt(cursor)` (no index needed) to fetch the unprocessed range;
  3. read the day nodes those events bucket into (by each event's own `saDate(timestamp)` —
     see the late-event policy below);
  4. compute the new **absolute** day-node values (fold, never blind increments);
  5. commit **one multi-path `update()` writing the folded day nodes AND the advanced
     cursor together** — a single RTDB multi-path update is atomic, so the cursor can never
     advance without its aggregates landing, and a crash anywhere before that commit leaves
     the cursor unmoved and the next run refolds the identical range to identical values.

  What this design does **not** claim (review finding on the earlier draft, corrected): a
  transaction on the cursor alone cannot make the separate day-node read-modify-write
  atomic. Concurrency is handled instead by (a) the scheduled function running with
  `maxInstances: 1` (no overlapping sweeps by configuration), and (b) determinism as the
  backstop — two runs that both started from the same durable cursor read the same range and
  the same prior day-node state and therefore commit byte-identical updates, so even an
  overlap that slips past (a) is benign, and the atomic {aggregates+cursor} commit means
  there is no interleaving in which the cursor and the aggregates disagree.

  Client-side dual-writes were rejected: seven writers across two apps and a Cloud Function
  cannot all be made atomic with their aggregate updates, and one missed writer corrupts a
  counter forever. Eventual consistency is acceptable **only because the open day is never
  served from the projection** (§2.4) — the projection is authoritative where the sweep has
  already durably passed.

- **Late events and the finalization watermark** (review finding on the earlier draft,
  corrected — "closed days are immutable" was too strong): the fold buckets every event into
  the day node of **its own `saDate(timestamp)`**, regardless of when it arrives — so an
  event written late (an offline POS till replaying `collected`, a warehouse tablet syncing
  after midnight) updates its *historical* day node on the sweep that ingests it. Days are
  therefore never structurally closed to the writer. "Frozen" is a serving concept with an
  explicit watermark: a day node gains `finalizedAt` once the cursor has passed
  `dayEnd + 24h` grace; before that, widgets may still see the day's numbers move (exactly
  as they do today on the live listener). After `finalizedAt`, a late event that still
  arrives is folded in all the same and bumps a `lateEvents` counter on the day node — a
  post-finalization change is thus visible, counted, and reconcilable rather than silently
  dropped. The reconciliation fence (Part 3) is on push keys, so both sides always see the
  same event set at comparison time regardless of lateness.
- **Backfill:** one script (owner-run, dry-run first) reads the full log once —
  ~12.85 MB ≈ **~$0.02 one-time** at RTDB egress rates *(derived)* — folds per-day nodes,
  writes them, sets the cursor. Rerunnable: it recomputes and overwrites, never increments.
- **Missing/stale day:** widgets treat an absent `/insights/daily/{date}` inside their window
  as **loud fallback** — fetch that day's events via the bounded key-range query (§2.4) and
  compute the legacy way, plus a `console.warn` and a visible "recomputed" marker in dev
  builds. Never render zero for a day that simply lacks a node. The open (today) day is
  *always* served by the bounded query, so projection lag can never show a stale today.

### 2.2 `/insights/products/{productId}` — product activity summary

```json
{
  "name": "Adidas F50 Elite Laceless Blue/Lime Soccer Boots",
  "placedAllTime": 214,
  "soldAllTime": 187,
  "lastSoldAt": "2026-07-16T15:09:38.779Z",
  "lastPlacedAt": "2026-07-16T14:58:02.101Z",
  "cursor": "-OxfTT..."
}
```

- **Serves:** the Admin activity line (§1.3) — its exact three needs (`placed` count,
  `collected`∥`ready` count, most-recent sold timestamp).
- **Does not serve:** Insights product tabs (window-scoped — daily nodes serve those);
  Product-Search raw history.
- **Write path:** same cursor-sweep function as §2.1 folds these in the same pass (one
  reader, many projections — one bandwidth bill).
- **Name-match caveat** restated from §2.0(3): aggregation groups by the same
  `productName`-exact match the widget uses, then keys the node by the *current* product id
  holding that name (name recorded alongside). Legacy no-`productId` rows participate via
  name. If reconciliation shows a product whose numbers can't be made to match (rename
  collisions), that product's line item **stays on the legacy path** and is listed in the PR 3
  cutover notes — silently-wrong is the one prohibited outcome.
- **Backfill:** same single full read as §2.1 (shared pass). **Missing node:** widget falls
  back to bounded per-product query? **No bounded per-product query exists without an index
  on `productName`** — so the fallback for a missing product node is the legacy full-log path
  behind the rollout flag, and a missing node after cutover is treated as a bug (loud
  console error + the activity line renders "—", never a fabricated zero).

### 2.3 `/insights/customers/{phoneKey}` — customer index + summary

```json
{
  "name": "Oluhle",
  "phone": "+27677798955",
  "orderCount": 9,
  "firstOrderAt": "2026-05-11T09:12:44.001Z",
  "lastOrderAt": "2026-07-16T15:09:38.779Z",
  "recentOrders": [
    { "at": "2026-07-16T15:09:38.779Z", "orderNumber": "191", "productName": "Adidas F50 ...", "size": "6", "saDate": "2026-07-16" }
  ]
}
```

`recentOrders` capped (e.g. last 20) — serves the drill modal's list for typical use; a
"show all" drill beyond the cap is a **bounded key-range walk** (§2.4) filtered client-side,
which is the one place a per-customer unbounded need survives; its frequency of use: not
measured, expected rare (manual drill).

- **Serves:** Customers list + Total/Opt-in counts, Broadcast recipients, Assistant
  typeahead (`name/phone/orderCount/lastOrderAt` are exactly `useCustomerIndex`'s output),
  leaderboards' per-customer inputs, drill modal (within cap).
- **Does not serve fully:** Customer-Insights month/all-time *cohort* stats (new-in-period,
  weekday histogram, trend) — these need per-day new-customer counts: added to
  `/insights/daily/{date}` as `newCustomers: n` + `firstSeenPhones` being too heavy, the
  cohort trend instead derives from `firstOrderAt` across the customer index (a full index
  read — see size note below), which is how the legacy code effectively computes it too
  (all-time scan). **Reconciliation decides whether index-derived cohort stats match; if not,
  the Customer-Insights panel stays legacy in the first cut.**
- **Size honesty:** distinct-customer count **not measured**. If it is (say) 3–6k customers ×
  ~1 KB with recentOrders, the index is 3–6 MB — *better than 12.85 MB but not small*, and it
  no longer grows with events, only with customers. If measurement during PR 3 shows this
  index is too large for the Assistant mount, the typeahead switches to reading `/customers`
  (already mounted in CustomersView; carries name+phone) + `orderCount` lookups on demand —
  flagged as the alternative, decided by measurement then, not guessed now.
- **Write path / backfill / missing:** same cursor sweep, same single backfill pass;
  missing node → legacy path behind the flag pre-cutover; post-cutover a missing customer in
  the index means "new customer with zero placed events", which is correct-by-meaning
  (they're inserted on their first `placed` fold).

### 2.4 What projections cannot serve — bounded queries (specified)

| Consumer | Query shape | Bound |
|---|---|---|
| Overview Recent-activity (top-30, all actions) | `orderByKey().startAt(windowStartKey).endAt(windowEndKey).limitToLast(K)` — the window bound comes FIRST (synthetic keys from the selected window's SA-day edges), then newest-K **within** it; K≈200 *(30 needed; headroom for the store/category filters — K tuned in PR 3 by measurement; if filters exhaust K, page backward with `endAt(oldestFetchedKey)`)*. Plain `limitToLast` without the range is only valid in all-time mode — newest-K-global returns the wrong rows for any historical window (review finding, corrected) | newest K inside the window (~60 KB *derived*) |
| Insights "today" figures + hourly chart (open day) | `orderByKey().startAt(todayStartKey)` where `todayStartKey` is a **synthetic push key built from SA-midnight epoch ms** (push ids encode their timestamp in the first 8 chars — derivable client-side, no index) | one day (~600 events / ~180 KB *derived*) |
| Source History + On Hold (5-day, needs event rows) | `orderByKey().startAt(fiveDaysAgoKey)` — same synthetic-key trick | 5 days (~3k events / ~0.9 MB *derived*; vs 12.85 MB today) |
| Product-Search order-history list | window-bounded key-range (as above) filtered client-side by name; for all-time searches this remains a **full read — kept behind an explicit user action** ("search all history" button), never on view mount | user-invoked only |
| Customer drill "show all" | same key-range walk pattern, user-invoked | user-invoked |
| `chatStream` recent context | `orderByKey().limitToLast(CHAT_CONTEXT_RECENT_LIMIT)` server-side | exactly what it uses today |
| `analyzeReorderNeeds` | cursor-fold like §2.1, or key-range bounded to its `REORDER_RECENT_DAYS` | its own window |

**Index prerequisite note:** every query above uses **key ordering — no `.indexOn` needed.**
If PR 3 instead opts for `orderByChild("timestamp")` anywhere (ISO strings are
lexicographically sortable, so it is semantically valid), that requires
`".indexOn": ["timestamp"]` on `/insights_log` **pasted into the console by Junid, by hand,
before that query ships** — exactly the PR 1 sequencing lesson: the deploy without the index
silently kept full-node downloads (observed live in the function log until the index landed).
This document's recommendation is the key-range form specifically so PR 3's first slices have
**no** console prerequisite. `database.rules.json` is stale and is not to be touched or
deployed under any circumstances.

---

## Part 3 — Reconciliation plan

PR 3 runs legacy and projection paths in parallel per widget and cuts over per widget only
on sustained equality.

**What is compared: the intermediate dataset, not the rendered number.** Each legacy selector
already returns a comparable value (`readyEventsForPeriod` → deduped event list;
`groupCount` → ordered pairs; customer index → array of `{phone, orderCount, lastOrderAt}`).
The harness serialises both sides to canonical JSON (sorted keys, sorted arrays by a stated
sort key) and diffs. Comparing rendered numbers alone would pass while composition drifted
(e.g. equal totals from different event sets); comparing datasets catches that.

**Independence — the PR 1/#233 lesson, designed against explicitly.** CodeRabbit caught a
test in #233 that passed without ever reaching the code under test (the fake returned live
references, so the guard short-circuited before the claim transaction). The equivalent
failure here is a harness where both "sides" read the same source or the new side silently
falls back to the old. Preventions, all three required:
1. **Distinct sources by construction:** the legacy side computes from the `useInsightsLog`
   array; the projection side computes from `/insights/daily/*` + bounded queries in a module
   that **does not import the legacy selectors' data path** (sharing pure per-event
   classifiers like `inferProductType` is allowed and desirable — identical classification is
   part of the contract; sharing *data acquisition* is not).
2. **Fallback poisoning:** during comparison runs, the projection side's loud-fallback (§2.1)
   is **disabled and replaced with a hard failure** — a missing day node must surface as
   `MISSING_PROJECTION`, never as a silently-equal recompute from the log (which would be
   #233 all over again: a comparison that passes because it never exercised the projection).
3. **Self-test mismatch:** the harness ships with a canary that *deliberately* perturbs one
   projection value in memory and asserts the comparator reports a diff — proving the
   comparator can fail. A comparator that has never been seen to fail is treated as broken.

**Match rules:**
- All compared values are **integer counts, string ids, and ISO timestamps** — exact
  equality. There are only two float-derived figures (OOS `lostPct`, repeat-rate) — compare
  their integer numerators/denominators, never the formatted float.
- **Timezone:** both sides bucket days with the same `saDateOf` helper (SA timezone) — the
  helper is shared (pure classifier rule above); day-boundary drift is thereby impossible by
  construction rather than tolerated.
- **Events landing mid-comparison:** every comparison run is **fenced on a push key**: the
  harness records `K = last key` at start; the legacy side computes over events `≤ K`
  (client-side filter on the already-loaded array); the projection side must have
  `cursor ≥ K` for closed days plus a today-window bounded to `≤ K`. If the cursor lags K,
  the run is `INCONCLUSIVE` (not a mismatch, not a match) and re-runs later. No comparison
  ever mixes fence states.
- **Returns:** both sides apply the same read-time `returns_log` join (per §2.0-1), from the
  same returns snapshot captured at fence time.

**Cutover threshold:** per widget, **7 consecutive fenced runs on 7 distinct days with zero
diffs** (spanning a weekend and at least one returns-landing day), executed on real
production data via a dev-flagged build (`?insightsRecon=1`) used during normal trading, with
results exported to console/downloadable JSON (no new RTDB writes for the harness itself).
The Customers all-time widgets additionally require one run compared against the **backfill
recomputation** (script-side, offline) to validate history, since their window includes
pre-cursor data.

**Rollback:** cutover is per-widget behind a flag (module-level constant per widget in the
first cut — no remote config, keep it boring); rollback is flipping the flag back to the
legacy path in a one-line PR. The legacy selectors and the full-log hook are **not deleted
until every widget has been cut over for 30 days** — deletion is its own final PR. The log
itself is untouched throughout (projections are derived, disposable, and rebuildable from
the backfill script at any time), so no rollback ever loses data.

---

## Part 4 — PR 3 sequencing

Ordered smallest/safest/highest-certainty first; each slice independently reviewable and
revertable (its own flag, its own reconciliation gate). Only one slice carries a console
prerequisite (none, if the key-range recommendation is followed).

| # | Slice | Change | Saving | Measured or guessed? |
|---|---|---|---|---|
| A | **Source view → bounded 5-day key-range query** | swap `useInsightsLog` for the `startAt(fiveDaysAgoKey)` query; no projection, no backfill, no new nodes | per Source mount: 12.85 MB → ~0.9 MB *(node size measured; 5-day volume derived from measured daily average)*. Monthly $: **guessed** — mount frequency not measured | mixed — labelled per figure |
| B | **`chatStream` → `limitToLast(CHAT_CONTEXT_RECENT_LIMIT)`** | one-line server change, behaviour-identical by inspection (it already discards all but recent N) | full-node read per chat → ~N events. Monthly $: **guessed** (chat frequency not measured) | guessed |
| C | **Assistant typeahead + Customers view → `/insights/customers` index** (backfill + cursor sweep ship here) | removes the 2 heaviest-dwell listeners | **guessed** until the distinct-customer count is measured during the slice; bounded by index size §2.3 | guessed, with the measurement task named |
| D | **Insights view → `/insights/daily` + today window + recent-list `limitToLast`** | the widest widget surface; longest reconciliation | per Insights mount 12.85 MB → ~tens of KB + today window *(derived)*; $: **guessed** | guessed |
| E | **Admin product line → `/insights/products`** | smallest widget, riskiest parity (name-match, §2.0-3) — deliberately last of the client slices | **guessed**; small | guessed |
| F | **`analyzeReorderNeeds` → cursor fold** | server-only; removes a scheduled full read | run cadence known from its schedule; per-run 12.85 MB → delta-only. $: **guessed** (shares the node's cost pool) | guessed |

Honest framing, stated once for all slices: the only *measured* dollar figure is the node's
allocated ~$35.8/mo from the 840 s profile, and that profile captured **one** mount without
identifying which feature. The per-slice ROI ranking above is therefore ordered by
**certainty and blast radius, not by verified dollars** — A and B are near-zero-risk
mechanical bounds; C removes the listeners with the longest expected dwell time (order-entry
and customer management are all-day screens — expected, not measured); D is the big surface;
E is small but parity-hardest; F is server hygiene. Re-profiling after A+C ships is the
checkpoint that turns the remaining guesses into measurements before D is attempted.

---

*Prepared 2026-07-16 against `origin/main` @ `08a00bb`. No code was changed for this
document. `/insights_log` production reads used for measurement: one shallow key scan and
two single-record samples.*
