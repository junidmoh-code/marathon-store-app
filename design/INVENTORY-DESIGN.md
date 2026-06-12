# Marathon Inventory & Stock-Movement Design (v2 — for review)

**Status:** DESIGN ONLY. No code written. Precision (counts never drift) is the prime directive; every section names the drift risk and the mechanism that closes it.

**Target DB:** `marathon-club` RTDB, `europe-west1`. Shared by marathon-store-app (staff), the upcoming marathon-pos-app, and eventually the public website. marathon-ai consumes the demand stream.

**v2 changes (from review answers O1–O5):**
- Location registry revised: added `warehouse1` (top-of-chain main receiving) and `hub2b`; sellable stores confirmed as `marathon-pe` / `marathon-pine` / `trophy`.
- **Topology is FLEXIBLE — no hardcoded routing.** Any location → any location. The ledger records what happened; routing stays a human/operational decision.
- Sales decrement the location that *physically fulfilled* the pair.
- **Source-refill chain is first-class and ledger-aware** (§2.4), including explicit **return reversal** (return movement + refill-request cancellation, never a silent decrement).
- Demand stream: extend `insights_log` with a `"sold"` action (O2-A).
- New dedicated `stock_management` permission + `stockRole` (O3).
- **Offline-first POS is mandatory** (§3.4) — sales never block on connectivity; idempotent sync via client-generated movement ids; negative balances allowed only for already-happened `sold` events and alarmed.
- Promotion gate: 14 consecutive days, zero *unexplained* variance (O5).

---

## 0. Drift-prevention thesis (read this first)

Everything rests on six invariants. Each later section maps back to these.

| # | Invariant | Enforced by |
|---|-----------|-------------|
| **I1** | A quantity only ever changes as the result of a movement; the two are written in **one atomic operation**. | Version-guarded multi-path `update()` writing the stock cell **and** the ledger entry together (§1.3). |
| **I2** | Movements are **append-only and immutable**. | Security rules: create-only, no update/delete (§5). |
| **I3** | No concurrent writer can silently clobber another (lost-update = drift). | Monotonic **version counter `v`** on every stock cell; stale writes rejected and retried (§1.3). |
| **I4** | A movement between locations conserves total quantity — stock is never invisible and never double-counted. | Transfers are **paired legs through an explicit `in_transit` location**; reconciler verifies conservation (§2). |
| **I5** | Balances are **independently re-derivable** from the immutable ledger; any divergence is *detectable*. | Scheduled **reconciler** recomputes balances from `/stock_movements` and alerts on mismatch (§5.4, §7.4). |
| **I6** | An offline sale is **never lost and never double-applied**. | Client-generated movement id = idempotency key; existence-check on sync (§3.4). |
| **I7** | A product **never has two quantity sources at once**. | Hard sequencing gate G1 (§7.3): POS converges onto `/stock` before any cell goes `live`; `/inventory` retires only in Phase B. |

The ledger is the source of truth; the balance is a fast cache provably reconstructable from it. That is what makes "money-bearing" defensible on RTDB.

---

## 1. Core schema (for SCHEMA.md)

### 1.1 Location Registry — `/locations/{locationId}` (REVISED)

A single canonical list of every place stock can physically be. This replaces ad-hoc hub/store strings scattered through the code. Every movement's `from`/`to` must validate against this closed set.

```
/locations/{locationId}
  id:        string                       # mirror of key
  label:     string                       # "Warehouse 1", "Hub 2B", "Marathon PE"
  kind:      "warehouse" | "store" | "transit"
  sellable:  boolean                      # true = POS can ring a sale from here
  active:    boolean
```

**Confirmed registry:**

| locationId | label | kind | sellable | Role |
|---|---|---|---|---|
| `warehouse1` | Warehouse 1 | warehouse | false | **Top of chain.** New stock is received and loaded here first, then portions dispatch downstream. |
| `hub1` | Hub 1 | warehouse | false | Currently PE sneakers (some also to hub2). |
| `hub2` | Hub 2 | warehouse | false | Currently Trophy sneakers + PE clothing overflow. |
| `hub2b` | Hub 2B | warehouse | false | Hub 2's informal second physical space — registered so the system matches reality. |
| `hub3` | Hub 3 | warehouse | false | Currently everything for Pine only. |
| `hubC` | Hub C | warehouse | false | Clothing trial routing. |
| `marathon-pe` | Marathon PE | store | true | Sellable store. May hold clothing rack stock when space allows. |
| `marathon-pine` | Marathon Pine | store | true | Sellable store (the former `pine` store mode). |
| `trophy` | Trophy | store | true | Sellable store. |
| `in_transit` | In Transit | transit | false | Dispatched-but-not-received holding. Stock here is *visible*, never a gap (I4). |

> **The "currently" rows describe TODAY's practice and may change anytime.** They are **not** encoded as rules. See §1.5.

> **Legacy string mapping** (for migration only — code today uses `hub1/hub2/hub3/hubC` and store modes `central`/`pine`):
> - `central` store mode → resolves to `marathon-pe` (primary) for sellable-location purposes; confirm whether `central` ever meant a different physical till.
> - `pine` store mode → `marathon-pine`.
> - `trophy` and `marathon-pe` as distinct sellable stores are **new** to the data model.
> - **O1 residual:** confirm whether `central` historically conflated PE + Trophy, since both now split out as separate stores. This affects how legacy `placedStore:"central"` orders are attributed during the cutover.

### 1.2 FLEXIBLE topology — the routing rule is "there is no routing rule"

**CRITICAL DESIGN RULE:** the system does **not** encode which location may transfer to which. Any `from` → any `to` is a valid movement as long as both exist in the registry and roles permit the *movement type* (§5). The ledger records what physically happened; **routing remains a manual/operational decision** that can change without a schema or rules change.

- No `allowedRoutes` table. No "hub1 feeds PE" constants. No validation that a transfer follows a "correct" path.
- The flexibility is the feature: when operations rebalance (e.g. hub2 starts feeding Pine), nothing in code needs to change — staff just do the transfer and it records itself.
- Reporting/automation may *describe* observed flows (analytics over the ledger), but never *constrain* them.

> **Drift trap — over-modelling routing:** hardcoding routes would force code changes every time operations shift, and would reject legitimate movements (drift via blocked-but-real transfers staff then do off-book). Recording-not-constraining keeps the ledger == reality.

### 1.3 Stock balances — `/stock/{locationId}/{productId}/{size}`

The current quantity. **One cell = one (location, product, size)** — smallest possible transaction unit, so every movement touches exactly one cell.

```
/stock/{locationId}/{productId}/{size}
  qty:      number  # integer; ≥ 0 normally, may go negative ONLY via a sold movement (§3.4, §5.3)
  v:        number  # version, +1 on every write (optimistic-concurrency guard)
  mv:       string  # push-id of the movement that produced this qty (audit back-link)
  lastType: string  # type of that movement (sold|return|received|transfer_in|transfer_out|adjustment)
                    #   — carried on the cell so the security rule can read it from newData (RTDB
                    #     `root` is pre-write, so the just-written movement is NOT cross-path visible)
  state:    "untracked" | "counting" | "live"   # rollout gating (§7)
  updatedAt: ISO
  updatedBy: uid
```

- `state` is the rollout switch (§7.2). A cell only decrements / participates in stock-aware checks when `state === "live"`.
- `mv` lets you walk from any balance to the movement that set it — and the reconciler uses it as a checksum.

> **Legacy cleanup (drift trap):**
> - `/products/{id}/stock` (per-size object "used by some clothing flows") — migrate values into `/stock` during seeding, then freeze read-only.
> - `/inventory` — **CORRECTION (cross-app audit):** NOT unused. The **POS app reads/writes `/inventory/{storeId}/{productId}/{sizeKey}` LIVE** (sales decrement it). It is a competing inventory model with no ledger — two sources of truth, the exact drift this design prevents. It therefore **cannot be removed yet**: the Phase-A rules KEEP it (POS V1 depends on it). **Hard sequencing (gate G1, §7.3):** POS converges onto `/stock` *before* any of a product's cells reach `live`; we never run both sources for one product; `/inventory` retires in **Phase B** once POS uses `/stock` exclusively. See O8/O9 and `RULES-PR.md` §B2.

### 1.4 Movement ledger — `/stock_movements/{movementId}` (APPEND-ONLY)

```
/stock_movements/{movementId}          # movementId = CLIENT-generated push id (idempotency key, I6)
  type:      "received" | "sold" | "transfer_out" | "transfer_in" | "adjustment" | "return"
  productId: string
  size:      string
  qty:       number                    # always POSITIVE magnitude; sign comes from type
  from:      locationId | null         # null for received
  to:        locationId | null         # null for sold
  actor:     uid
  actorRole: string
  ts:        ISO                       # REAL event time (offline sale time, not sync time) — demand series uses this
  appliedAt: ISO | null                # when the movement hit RTDB (offline: sync time)
  reason:    string | null             # REQUIRED for adjustment; else null
  link: {
    orderId:    string | null          # originating request/order
    transferId: string | null          # pairs transfer_out ↔ transfer_in
    refillId:   string | null          # Source refill request this fulfils/cancels (§2.4)
    saleId:     string | null          # POS sale, post-launch
    deviceId:   string | null          # POS till id
  }
```

**Sign convention (one place, no ambiguity):** `qty` is always a positive magnitude. Effect on a cell comes from `type`:
- `received`, `transfer_in`, `return` → **+qty** to the `to` cell.
- `sold`, `transfer_out` → **−qty** from the `from` cell.
- `adjustment` → signed correction via `to` (+) or `from` (−) with mandatory `reason`.

**The atomic write (I1 + I3) — the single most important mechanism.** Every change is **one** `update(ref(database), {...})` multi-path write:

```
updates["stock_movements/" + mvId]              = movement            # create-only
updates["stock/{loc}/{pid}/{size}/qty"]         = newQty
updates["stock/{loc}/{pid}/{size}/v"]           = baseV + 1
updates["stock/{loc}/{pid}/{size}/mv"]          = mvId
updates["stock/{loc}/{pid}/{size}/updatedAt"]   = now
await update(ref(database), updates)
```

Multi-path `update()` is all-or-nothing atomic across the whole tree — movement and balance commit together or not at all. Rules (§5) reject the cell write unless `newData.v === data.v + 1`. Concurrent writers to one cell:

1. Both read `v=17, qty=5`.
2. Till A commits `v=18, qty=4`.
3. Till B asserts `v=18` (`17+1`) but server `data.v` is now `18` → `18 === 19` false → **rejected**. B re-reads and retries → `v=19, qty=3`.

That version guard makes a blind multi-path write safe as read-modify-write **without** losing the atomic ledger append.

### 1.5 Where movements are written — one helper, no exceptions

All writes to `/stock` go through a single shared helper `applyMovement(movement)` (in `src/components/stock/applyMovement.js`, §6). Raw `update()` on `/stock` is forbidden by code review. This guarantees: exactly one code path can change a quantity, and it always writes the paired movement (I1).

---

## 2. Transfers — flows record themselves

**Principle:** a movement is a side effect of work staff already do. No one "books a transfer." The buttons they already tap emit the ledger entries.

### 2.1 Flow-driven (the big one) — riding the existing request lifecycle

Existing state machine (`updateStatus`, `App.jsx:3769`): `incoming → ready → collected` (+ `out_of_stock`, `coming_tomorrow`), already firing behind warehouse/store buttons and already writing `insights_log`. We **add an `applyMovement()` call inside the same handlers** — same tap, now also moves stock.

Customer orders *leave the system*; refills *relocate within it* — this distinction drives the mapping:

| Existing transition | Code site | Customer order → movement | Refill / display-partner → movement |
|---|---|---|---|
| `incoming → ready` ("Mark as Sent/Available") | `App.jsx:4244` → `updateStatus(o, READY)` | `transfer_out`: `from = fulfilling hub → to = in_transit`, link.orderId | `transfer_out` hub → `in_transit` |
| `ready → collected` ("Mark as Collected") | `App.jsx:4307` | **pre-POS:** `sold` from `in_transit` (terminal — pair leaves to customer). **post-POS:** `transfer_in` `in_transit → store`, sale deferred to till (§3). | `transfer_in`: `in_transit → store`/hub (lands on shop floor) |
| `out_of_stock` | `App.jsx:4249` | **no stock movement** — emits demand-sensor event only (§4). If ledger says stock exists here → inventory-accuracy alert (§4.4). | same |
| display-partner `stockDepleted` | `setDisplayRefillStatus`, `App.jsx:3855` | — | `adjustment` (−), `reason:"display_depleted"`, with existing `products/{id}/depletedAt` write folded into the same atomic update |
| clothing refill `refilled` | `App.jsx:3959` | — | `transfer_in` to store/hub |

**Fulfilling location** (which cell decrements): the flow already knows it — for sneakers it's the hub that clicked "sent" on the request (`order.placedAtHub` / the resolving hub). For clothing it's the store cell (rack sale) or the hub cell (warehouse-fulfilled). No routing inference needed; the action carries the location.

> **Drift trap — double counting at cutover:** pre-POS, `collected` on a *customer* order is the sale (stock leaves). Post-POS, `collected` only lands stock at the store and the *till* rings the sale. The per-location cutover timestamp (§3.3) governs which meaning applies — exactly one counts a given pair. Never both.

> **Drift trap — abandoned in-transit:** a pair marked `ready` (now in `in_transit`) but never `collected` would sit forever, understating the hub and overstating transit. The in-transit view (§6) lists every `in_transit` cell with age; items aging past threshold raise a reconciliation task. Stock is *visible*, never lost (I4).

### 2.2 Deliberate transfers (bulk rebalancing)

For "move 50 pairs hub1 → marathon-pine." Dedicated UI (§6), three states, each an atomic movement:

```
/transfers/{transferId}
  status: "dispatched" | "received" | "discrepancy"
  from, to: locationId                 # ANY → ANY (flexible topology, §1.2)
  lines: [{ productId, size, qtyDispatched, qtyReceived }]
  createdBy, createdAt, receivedBy, receivedAt
```

1. **Dispatch** → per line, `transfer_out` `from → in_transit`, `transfer.status="dispatched"`, all movements share one `transferId`.
2. **In transit** → quantities live in `in_transit` (visible, never a gap).
3. **Confirm receive** → per line, `transfer_in` `in_transit → to`. If `qtyReceived ≠ qtyDispatched`, the difference is written as an **`adjustment` with `reason:"transfer_discrepancy"`** and `status="discrepancy"` flags it.

> **Drift trap — discrepancy hiding:** received ≠ dispatched must surface as an explicit signed `adjustment`, never a quiet overwrite. dispatched − received == sum of discrepancy adjustments → conservation provable (I4).

### 2.3 Receiving new stock

New arrival is loaded at **`warehouse1`** (top of chain) → `received` movement per (product, size), `from = null`, `to = warehouse1`, `+qty`. (Direct receipt at a hub is permitted too — flexible topology — but the default and intended entry point is `warehouse1`.) Entered through the Receive UI (§6). This is the only type that creates quantity from outside the system, so it is the most access-controlled (warehouse + admin, §5).

### 2.4 Source-refill chain as first-class, ledger-aware (NEW)

**Existing behavior:** when a pair leaves a hub to a customer, the system auto-creates a refill request for that exact variant+size on the **Source card** so the hub gets replenished (today via `logRestock()` → `/restock_log/{date}`, with Source responses at `/restock_requests/{date}/{productKey}/{size}`; `App.jsx:739`, `:793`). A logged **return** currently *reverses* that refill request.

This design makes both halves explicit and ledger-linked. A durable refill-request record replaces the ephemeral date-bucketed structure:

```
/refill_requests/{refillId}
  productId, size
  requestingLocation                   # the hub/store that lost the pair and needs replenishment
  qty:        number                   # usually 1 (per sold pair); bulk allowed
  createdFrom: { movementId, orderId } # the sold/transfer_out that triggered it
  status:     "open" | "fulfilled" | "cancelled"
  fulfilledBy: { transferId } | null   # the transfer that satisfied it
  cancelledBy: { movementId } | null   # the return movement that voided it
  createdAt, resolvedAt
```

**(a) Creation** — auto, riding the existing trigger. When the existing refill-creation site fires (the hub "sent"/collected event), it now also writes a `/refill_requests/{refillId}` with `status:"open"`, linked to the originating movement. No new staff step.

**(b) Fulfilment = a transfer.** When Source/operator satisfies the request by sending stock to the requesting location, that is a **normal deliberate transfer** (§2.2): `transfer_out` from the chosen upstream location (`warehouse1` or an upstream hub — operator's choice, flexible topology) → `in_transit` → `transfer_in` at `requestingLocation`. The transfer carries `link.refillId`; on receive, the refill request flips to `status:"fulfilled"`, `fulfilledBy.transferId`. **The refill request itself never moves stock — only the transfer does.** This keeps one source of truth (no double-decrement).

**(c) Return reversal — modeled explicitly, never a silent decrement.** Today a logged return reverses the refill request. In this design a return produces **two recorded effects in one logical operation**:
   1. A **`return` movement** (`+qty`) crediting the location the pair physically re-enters (store floor or hub — operator's choice; carries `link.orderId`). The returned pair becomes real stock again, with a ledger entry.
   2. The matching **open refill request is cancelled** (`status:"cancelled"`, `cancelledBy.movementId = <return movement>`) — because the pair came back, so no replenishment is needed.

   Both are written together; the return movement is the audit trail for the stock credit, and the cancellation is the audit trail for voiding the refill. Nothing decrements invisibly.

> **Drift trap — silent refill reversal:** if a return just deleted the refill request and bumped a counter, the +1 to stock and the −1 demand-for-refill would be invisible and unauditable. Forcing a `return` movement + an explicit `cancelled` record makes both reconstructable from the ledger (I1, I5).

> **Migration note:** `/restock_log` + `/restock_requests` (date-bucketed, ephemeral) are the current implementation of (a)/(b). This formalizes them into durable, ledger-linked `/refill_requests`. During rollout both can co-exist (the new record written alongside the old) until the Source card reads the new path. **O6 (new): confirm whether Source UI should be re-pointed at `/refill_requests` in the same phase, or run dual-write first.**

---

## 3. POS = the only sale truth

### 3.1 The terminal event

Post-launch, a sale is real **only** when rung at the till. One pair = one chain: `received → transfer_out → transfer_in → sold`. The `sold` movement is terminal and atomic with the sale record:

```
# ONE atomic multi-path update (online) OR queued+synced (offline, §3.4):
stock_movements/{mvId}            = { type:"sold", from: fulfillingLoc, qty:1, link:{ saleId, orderId? } }
stock/{fulfillingLoc}/{pid}/{size}= { qty: qty-1, v: v+1, mv: mvId }
sales/{saleId}                    = { lines:[...], total, tenderType, deviceId, ts, ... }
```

- **Fulfilling location** = the location that physically had the pair: the hub that clicked "sent" for an order-driven sale, or the store cell for a walk-in rack sale.
- **Linked to its originating request** where one exists (`link.orderId`).
- **Walk-in rack sales**: no order; `sold` decrements the store-floor cell directly, `link.orderId = null`.
- `sales/{saleId}` is effectively a projection of `sold` movements — rebuildable from the ledger, so the till receipt and the stock count can never disagree.

### 3.2 Refill/display re-trigger off sales (post-launch)

Post-POS, refill and display replenishment **re-key off `sold` events**, not warehouse status. A `sold` on a fulfilling location auto-creates the §2.4 refill request (and, where remaining qty crosses a threshold, the display refill). A sale pulls stock forward — replacing today's "warehouse marks ready" trigger. Consumed from the movement stream; schema already carries everything needed.

### 3.3 Analytics cutover — one continuous demand series, no overlap

Today's sale proxy is `insights_log` `action:"ready"` (~52–66% name-match attribution). Post-POS the truth is `sold` movements. Risk: a window where both count the same sale → demand drift.

**Mechanism — per-location cutover timestamp:**

```
/config/posCutover/{locationId} = ISO timestamp   # absent = still pre-POS
```

Unified demand series (§4), per location:
- events **before** `posCutover[loc]` → from `insights_log` `ready`.
- events **at/after** `posCutover[loc]` → from `sold` movements.

Single mutually-exclusive boundary per location → no pair counted twice, none dropped. At cutover, `ready`-as-sale-proxy emission for that location is **suppressed** (preferred, keeps the raw log clean). Rollout is per-location (§7), so cutover is per-location too.

### 3.4 OFFLINE-FIRST POS (mandatory, non-negotiable) (I6)

Load shedding is routine; the till **must keep ringing sales with no internet**. Money capture never blocks on connectivity; stock decrements may lag until sync.

**Model:**

1. **Sale time (offline-capable):** the till captures the sale to a **local queue** (IndexedDB). At capture it generates, client-side:
   - `saleId` (client push id),
   - one `mvId` (client push id) **per line** — these are the **idempotency keys** (I6),
   - `ts` = the **real sale time**.
   Money is captured immediately. No RTDB call is required to complete a sale.

2. **The queued item carries only relative intent:** `(fulfillingLoc, productId, size, qty, mvId, saleId, ts)`. It does **not** snapshot a cell version — because a sale is a *relative* decrement (−qty), not an absolute set. So a till being **hours behind is irrelevant to correctness**; the version is read fresh at sync.

3. **Sync (on reconnect):** for each queued line, in order:
   - **Idempotency check (I6):** if `stock_movements/{mvId}` already exists → **skip** (already applied; a prior partial sync or another device handled it). Never double-applies.
   - Else run the §1.4 version-guarded atomic update: read current `v`/`qty`, write `sold` movement (`ts` = real sale time, `appliedAt` = now) + decrement + `v+1`. On version conflict (another writer raced), retry with fresh read.
   - Write `sales/{saleId}` in the same atomic update (also idempotent via `saleId`).

4. **Oversell handling (precision-preserving):** offline, the till cannot check stock, so concurrent tills may sell more than exists. On sync the true `sold` movement is still recorded (the sale *happened*). The cell qty is allowed to go **negative for `sold` movements only** (§5.3) — negative is a loud **inventory-accuracy alert** state, not a hidden clamp. This keeps **balance == ledger replay exactly** (I5 intact) and makes oversell *visible* (real signal: sold more than system believed). Deliberate online movements (`transfer_out`, `adjustment`) keep the hard `qty ≥ 0` floor.

5. **Demand accuracy:** the demand series uses movement `ts` (real sale time), so load-shedding gaps never distort analytics even though `appliedAt` lags.

> **Drift trap — double-apply on flaky sync:** without the `mvId` existence check, a retried/duplicated sync would decrement twice. The client-generated id + existence check makes sync exactly-once regardless of how many times it runs (I6).

> **Drift trap — clamping oversell to zero:** if offline oversell clamped qty at 0, balance would diverge from ledger replay and the reconciler would chase phantom mismatches forever. Allowing negative for already-happened events keeps I5 exact and turns oversell into an actionable alert instead of silent drift.

> **O7 (new):** confirm whether a returning till should sync **before** it can ring new sales (briefly), or sync in the background while continuing to sell. Background sync is the load-shedding-friendly default; it means a cell can receive both queued-offline and live-online sales interleaved — the version guard + idempotency handle it, but confirm the UX expectation.

---

## 4. Combined demand — two complementary streams

POS captures **fulfilled** demand. The order app's OOS flow uniquely captures **unfulfilled** demand (~35% of true demand per audit). Both feed one model, no special cases.

### 4.1 Unified event shape — extend `insights_log` (O2-A)

POS mirrors the existing `insights_log` shape; `sold` is added as a first-class `action` alongside `ready`. marathon-ai's `aggregatePerProduct` (`functions/index.js`) keeps reading `insights_log`, keyed on `productId` (always present since commit #55) with name-match only as legacy fallback, gated by the §3.3 cutover timestamp.

```
insights_log event (existing shape; new action value):
  action: "placed" | "ready" | "out_of_stock" | "tomorrow" | "collected" | "stock_depleted" | "sold"  ← NEW
  productId, productName, size, placedAtHub/locationId, customerName, orderNumber, timestamp, ...
```

### 4.2 OOS request flow stays first-class forever

The assistant `out_of_stock` action (`App.jsx:4249` → `logInsight action:"out_of_stock"`) **remains the demand sensor**, never removed — the only capture of demand we couldn't fulfil. Tagged as unfulfilled demand.

### 4.3 "Requested but unavailable" at the POS

New lightweight till action: one-tap "couldn't sell — no stock" → writes an `out_of_stock`-class demand event (productId + size + location), **no stock movement**. POS now captures both halves (sold + wished-for) so the two streams together approximate true demand.

### 4.4 Stock-aware OOS (ledger as audit signal)

With real quantities, every OOS request validates against the ledger:
- Mark (product, size) OOS at a location → read `/stock/{loc}/{pid}/{size}`.
- If `qty > 0` and `state === "live"` → **inventory-accuracy alert** (`/stock_alerts`): system says stock exists but staff can't find it → miscounted, misplaced, or theft. The OOS stream doubles as continuous physical-vs-system audit, surfacing drift the moment it manifests at point of sale (I5).

---

## 5. Security rules (blocking requirement — must ship BEFORE go-live)

Current rules (`database.rules.json`): root `.read = auth !== null`, nearly all writes `auth !== null`, `/users` gated to super-admin email. **Unacceptable for money-bearing stock** — any authenticated token can write any quantity.

### 5.1 Rules-readable role model (prerequisite, O3 approved)

RTDB rules can't test array membership, and `/users/{uid}/permissions` is a `string[]`. Add a rules-friendly mirror + a new dedicated permission:

```
/users/{uid}/stockRole: "warehouse" | "store" | "pos" | "admin" | null
# plus the new "stock_management" string in the existing permissions[] for UI gating (§6)
```

Maintained by the same super-admin user-management flow that already writes `/users`.

### 5.2 `/stock_movements` rules — append-only, validated (I2)

```jsonc
"stock_movements": {
  ".read": "auth != null",
  "$mvId": {
    ".write": "!data.exists() && newData.exists() && auth != null",   // create-only; no edit/delete
    ".validate":
      "newData.hasChildren(['type','productId','size','qty','actor','ts']) &&
       newData.child('qty').isNumber() && newData.child('qty').val() > 0 &&
       newData.child('actor').val() === auth.uid &&
       root.child('products').child(newData.child('productId').val()).exists() &&
       (newData.child('from').val() === null || root.child('locations').child(newData.child('from').val()).exists()) &&
       (newData.child('to').val()   === null || root.child('locations').child(newData.child('to').val()).exists())",
    "reason": { ".validate": "newData.parent().child('type').val() !== 'adjustment' || newData.isString()" },
    "type": {
      ".validate":
        "(newData.val() === 'received'     && root.child('users').child(auth.uid).child('stockRole').val().matches(/warehouse|admin/)) ||
         (newData.val() === 'transfer_out' && root.child('users').child(auth.uid).child('stockRole').val().matches(/warehouse|store|admin/)) ||
         (newData.val() === 'transfer_in'  && root.child('users').child(auth.uid).child('stockRole').val().matches(/warehouse|store|admin/)) ||
         (newData.val() === 'sold'         && root.child('users').child(auth.uid).child('stockRole').val().matches(/pos|store|admin/)) ||
         (newData.val() === 'return'       && root.child('users').child(auth.uid).child('stockRole').val().matches(/pos|store|admin/)) ||
         (newData.val() === 'adjustment'   && root.child('users').child(auth.uid).child('stockRole').val().matches(/admin/))"
    }
  }
}
```

Movements are immutable, `qty` strictly positive, `actor` can't be forged, `from`/`to` must exist in the registry, **adjustments are admin-only and require a reason**. Note: rules do **not** constrain which `from`→`to` pairs are allowed (flexible topology, §1.2) — only the *type* is role-gated.

### 5.3 `/stock` rules — version-guarded, gated, only `sold` may go negative (I1, I3, §3.4)

```jsonc
"stock": {
  ".read": "auth != null",
  "$loc": { "$pid": { "$size": {
    ".write": "auth != null && root.child('users').child(auth.uid).child('stockRole').exists()",
    ".validate":
      "newData.hasChildren(['qty','v','mv','lastType']) &&
       newData.child('qty').isNumber() && newData.child('qty').val() % 1 === 0 &&   // integer
       newData.child('v').isNumber() &&
       // version advances by exactly 1 (optimistic concurrency — blocks lost updates)
       (!data.exists() ? newData.child('v').val() === 0 : newData.child('v').val() === data.child('v').val() + 1) &&
       // a fresh movement back-link must be attached (paired-write discipline)
       newData.child('mv').val() !== data.child('mv').val() &&
       newData.child('lastType').val().matches(/^(received|sold|transfer_in|transfer_out|adjustment|return)$/) &&
       // non-negative EXCEPT when the producing movement is a real already-happened event
       (newData.child('qty').val() >= 0 || newData.child('lastType').val() === 'sold')"
  }}}
}
```

The clauses that prevent drift:
- `newData.v === data.v + 1` → **lost-update protection** (I3).
- `mv` must change on every write + `lastType` is required → no balance write without a movement back-link (paired-write discipline, I1).
- Negative allowed **only** when `lastType === 'sold'` → offline oversell is recorded truthfully and alarmed, never hidden. Returns add stock (always positive), so they get no negative allowance; deliberate movements keep the ≥0 floor (§3.4). (Rule and `applyMovement` agree: sold-only.)

> **RTDB-correctness note:** the rule reads `lastType`/`mv` from `newData` (the cell's own write), **not** cross-path from `/stock_movements`. RTDB evaluates `root`/`data` as the *pre-write* state, so a movement created in the same atomic multi-path update is **not** visible to the cell's rule. Carrying `lastType` on the cell is what makes the negative-allowance and type checks enforceable at write time.
>
> **Honest limitation:** rules guarantee version-safety, integer/shape, and type-gated negativity, but **cannot** verify that a real movement with matching `qty`/sign was written in the same op (no cross-path `newData`). That last invariant is held by: (a) the single `applyMovement()` writer (§1.5), (b) role-gated write access (§5.2), and (c) the reconciler (§5.4) which re-derives every balance from the immutable ledger nightly. For money-bearing stock this layered defense — not a single rule — is the guarantee.

### 5.4 The reconciler (I5) — integrity backstop

Scheduled Cloud Function (admin SDK, bypasses rules), nightly + on-demand:
1. Replays all `/stock_movements` per cell into expected balances.
2. Compares to live `/stock` `qty`.
3. Mismatch (including any negative cell) → `/stock_alerts` + push to admin, with the offending movement range.

Makes any drift — bug, race rules missed, or tampering — detectable within 24h and re-derivable. Balances are a cache; the ledger is truth.

### 5.5 Write primitive — no non-atomic fallback

The **only** sanctioned write is the version-guarded multi-path `update()` of §1.4 (every affected cell **and** the movement in one atomic op). We deliberately do **NOT** use a `runTransaction`-then-append-movement pattern: appending the movement *after* the cell transaction commits would break **I1** — a crash or rejection between the two leaves a balance change with no ledger entry (silent drift). The implemented `applyMovement()` does read → compute → **single atomic multi-path write**, with bounded retries on version conflict (a rejected attempt writes nothing, so retry is safe). There is no code path that writes a balance separately from its movement.

### 5.6 Ship-before-go-live checklist (blocking)

- [ ] `/stock` and `/stock_movements` rules deployed (§5.2, §5.3).
- [ ] `/locations` registry seeded; rules reference it.
- [ ] `/users/{uid}/stockRole` populated for all staff (§5.1).
- [ ] `/products/{id}/stock` frozen read-only (§1.3). (`/inventory` removal is Phase B, post-POS-convergence — NOT this go-live; see O8/O9.)
- [ ] Reconciler deployed and green on seed data (§5.4).
- [ ] Root `.read` tightened or confirmed acceptable for stock paths.
- [ ] `applyMovement()` is the **only** writer to `/stock` (code-review gate).
- [ ] Offline queue + idempotent sync verified on the POS (§3.4).

---

## 6. UI plan — admin-gated Stock section (separate component files)

Lives **inside marathon-store-app** (staff already live here; POS shares the same RTDB). **Not** in the `App.jsx` monolith — new files under `src/components/stock/`, mounted via the existing role cascade (`App.jsx:9184`).

**Wiring (matches established pattern):**
- Add `STOCK: "stock"` to `ROLES`; map `[ROLES.STOCK]: "stock_management"` in `ROLE_TO_PERMISSION`.
- RoleSelector tile gated by `hasPermission("stock_management")`.
- `else if (role === ROLES.STOCK) view = guard(ROLES.STOCK, <StockView onExit={() => setRole(null)} />);`
- `import StockView from "./components/stock/StockView";`

**Component files** (self-contained, inline-style design tokens, read via `onValue`, write via shared `applyMovement()`):

| File | Purpose |
|---|---|
| `stock/StockView.jsx` | Shell + tabs (`usePersistedTab`) + `onExit`. |
| `stock/ReceiveStock.jsx` | New arrivals at `warehouse1` → `received` movements per size. |
| `stock/Transfer.jsx` | Deliberate transfer (any → any): dispatch → in-transit → confirm-receive, discrepancy capture (§2.2). Also the fulfilment UI for Source refill requests (§2.4b). |
| `stock/Adjust.jsx` | Manual adjustment with **mandatory reason** (admin only). |
| `stock/StockGrid.jsx` | Per-product, per-size, per-location quantity matrix. |
| `stock/InTransit.jsx` | Everything in `in_transit`, with age + aging alerts (§2.1). |
| `stock/MovementHistory.jsx` | Per-product immutable ledger view (audit trail). |
| `stock/CountSession.jsx` | Physical-count entry for seeding/recount (§7). |
| `stock/applyMovement.js` | **The one and only** stock writer (version-guarded atomic helper; also the offline-queue entry point for the POS app). |
| `stock/useStock.js` | `onValue` hooks for `/stock`, `/stock_movements`, `/transfers`, `/refill_requests`. |

> Centralizing every write in `applyMovement.js` is itself a drift control (§1.5). The POS app imports the same helper so online and offline sale paths share one idempotent code path.

---

## 7. Seeding & rollout

### 7.1 Initialization — physical count entry

`CountSession.jsx`: pick a location → walk products/sizes → enter counted qty. Each entry is a seed movement (`type:"adjustment"`, `reason:"initial_count"`, `from:null`) so even opening balances have a ledger origin (no balance without a movement — I1 from t=0).

**Partial coverage** is first-class via cell `state`:
- Uncounted → `state:"untracked"` (or absent).
- Mid-count → `state:"counting"`.
- Committed → `state:"live"`.

Coverage is per-cell, so "some products counted, some not" is normal, not an error.

### 7.2 Transition behavior for uncounted products

A non-`live` cell:
- **Decrement:** skipped. POS still rings the sale (money captured) but writes **no `sold` movement** for that cell — only a demand event. Counts can't drift for untracked items.
- **Analytics:** untracked products keep flowing through existing `insights_log`/demand path unchanged.
- **OOS audit (§4.4):** suppressed (no count to compare).

Analytics-only until a cell goes live, then count-authoritative. The flip is per-cell, one-way (untracked → live).

### 7.3 Incremental rollout

Schema frozen before rollout; rollout itself phased.

> **🚦 GATE G1 — single quantity source (HARD PRECONDITION, blocks every R-phase).**
> A product's cells may reach `live` / enforcing state **only after** the POS app
> reads *and* writes `/stock` (via `applyMovement()`) for that product — i.e. POS no
> longer touches `/inventory` for it. **We never operate two quantity sources for the
> same product.** Concretely:
> - While POS still uses `/inventory` for a product, that product's `/stock` cells stay
>   `untracked`/`counting` (analytics-only, no decrement, no enforcement) — §7.2.
> - Flipping any of a product's cells to `live` is gated on POS-convergence for that product.
> - `/inventory` retires entirely in **Phase B**, once POS reads/writes `/stock`
>   exclusively across all products. Only then is it removed from the rules (H2).
>
> This makes the convergence ordering unambiguous: **POS-onto-`/stock` first, `live` second, `/inventory` removal last.**

1. **R0 — one warehouse or category.** Seed e.g. `warehouse1` (or `hub1` sneakers) only; set those cells `live` **(only for products already past G1)**. Everything else untracked.
2. **R1 — parallel-run / verification window.** Movements fire for the live subset but **inform, not enforce** — POS does not yet block sales on insufficient stock. Daily: reconciler output + manual physical recount vs system qty; investigate every variance.
3. **R2 — enforce.** Promote a subset only after **14 consecutive days with every variance explained (zero unexplained variance)** (O5). Then enable hard rules (block negative on deliberate movements; require transfers for movement).
4. **R3 — expand** location-by-location / category-by-category, repeating R1→R2. Per-location POS cutover (§3.3) flips as each store's stock goes live.

> **Drift trap — enforcing too early:** blocking sales on counts before the parallel-run proves accuracy turns every miscount into a refused sale. The "inform not enforce" window is mandatory before R2.

### 7.4 Verification artifact

`MovementHistory` + the reconciler give continuous system-vs-physical comparison per live cell. Expansion to the next subset is gated on the current subset's reconciler being clean for the full 14-day window (O5).

---

## 8. Open questions (status)

| # | Question | Status |
|---|---|---|
| O1 | Location model | **Resolved** — registry §1.1. Residual: confirm whether legacy `central` conflated PE + Trophy (affects cutover attribution). |
| O2 | Stream unification | **Resolved** — extend `insights_log` with `"sold"` (A). |
| O3 | Permission model | **Resolved** — new `stock_management` permission + `stockRole`. |
| O4 | Offline POS | **Resolved** — mandatory; §3.4. |
| O5 | Promotion gate | **Resolved** — 14 consecutive days, zero unexplained variance. |
| O6 | Source card: re-point to `/refill_requests` same phase, or dual-write first? | **Resolved** — dual-write to `/restock_log` first, migrate read later. |
| O7 | Returning till: sync-before-sell, or background sync while selling? | **Resolved** — background sync while selling, small syncing indicator, never block. |
| O8 | **POS `/inventory` ↔ `/stock` convergence.** | **Resolved** — POS migrates onto `/stock` + `applyMovement()`. `/inventory` is KEPT in the rules for now (POS V1 depends on it) and **retires in Phase B once POS reads/writes `/stock` exclusively.** |
| O9 | Run `/stock` and POS `/inventory` in parallel, or gate? | **Resolved** — **NO parallel operation for the same products.** Hard sequencing gate (G1, §7.0): POS convergence onto `/stock` is a *precondition* for any cell of those products reaching `live`/enforcing. We never operate two quantity sources for one product. |

---

## 9. Every drift point and its guard

| Drift point | Guard |
|---|---|
| Concurrent sells on same cell (lost update) | Version `v` guard (§1.4, §5.3) |
| Balance changed without a movement | `mv` back-link + reconciler + single `applyMovement()` writer (I1, §5.4, §6) |
| Movement edited/deleted | Append-only rules (I2, §5.2) |
| Transfer loses/duplicates stock | Paired legs through explicit `in_transit`; conservation reconciled (I4, §2) |
| Receive ≠ dispatch hidden | Mandatory signed `adjustment` on receive (§2.2) |
| Abandoned in-transit | Aging view + reconciliation task (§2.1, §6) |
| Hardcoded routing rejecting real moves | Flexible topology — record, don't constrain (§1.2) |
| Source refill double-decrements | Refill request never moves stock; only the transfer does (§2.4b) |
| Return silently reverses refill | Explicit `return` movement + `cancelled` record (§2.4c) |
| Sale counted by both `ready` and POS at cutover | Per-location cutover timestamp, suppress `ready` (§3.3) |
| Offline sale lost or double-applied | Client-gen `mvId` idempotency + existence check on sync (I6, §3.4) |
| Offline oversell hidden by clamp | Negative allowed for `sold` only, alarmed; balance == ledger replay (§3.4, §5.3) |
| Demand under/over-counted across streams | Mutually exclusive timestamp boundary; `sold` action (§3.3, §4.1) |
| Phantom stock (system says have, floor doesn't) | Stock-aware OOS accuracy alerts (§4.4) |
| Any unanticipated divergence | Nightly reconciler re-derives balances from ledger (I5, §5.4) |
| Untracked product mishandled | Per-cell `state`; no decrement until `live` (§7.2) |
| Two competing quantity sources | Retire `/inventory` + `/products/{id}/stock` before go-live (§1.3) |

---

---

## 10. Hardening follow-up list (named — do not forget)

Deferred items that must NOT be lost. Each gets its own ticket/PR after go-live.

| ID | Item | Why deferred | Trigger to do it |
|---|---|---|---|
| **H1** | Scope `/users` read to **own uid + super-admin**, and exclude anonymous auth. | Today read is `auth != null && !anonymous` (Phase-A) to avoid breaking AuthGate/UserManagement, but any staffer can still read all user records. | After confirming AuthGate only needs `users/{ownUid}` and UserManagement runs as super-admin. |
| **H2** | Remove `/inventory` from rules (Phase B). | POS app reads/writes it live (O8); gate G1 keeps both apart until then. | After POS reads/writes `/stock` EXCLUSIVELY for ALL products (G1 fully satisfied system-wide). |
| **H3** | Tighten existing legacy write rules (`orders`, `customers`, `pos`, …) from blanket `auth != null` to role-scoped. | Out of scope for the inventory go-live; broad change touching every app. | Dedicated security pass post-inventory. |
| **H4** | Reconcile committed `database.rules.json` with the actually-deployed rules. | Committed file is stale (B1 / RULES-PR.md). | During the rules PR — capture deployed rules as rollback baseline. |
| **H5** | Add cross-path movement↔delta verification (beyond what RTDB rules can express). | Rules can't read another path's `newData`; reconciler is the backstop. | If reconciler ever flags tampering, consider a CF-authoritative balance write model. |
| **H6** | Public-website read access to `/stock` (availability). | Website is a later consumer; Phase-A stock read is staff-only. | When the public site needs live availability — add a sanitized read path. |

---

*v3 — registry, Source-refill model, and O1–O7 confirmed. Implementation proceeding on the feature scaffold. Rules swap is a SEPARATE PR + scheduled window. Open: O8/O9 (POS `/inventory` convergence) — does not block the `/stock` feature code, but blocks Phase-B `/inventory` removal and parallel-run safety.*
