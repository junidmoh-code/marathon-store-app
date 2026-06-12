# SCHEMA.md additions — Inventory (DRAFT for review)

These are the blocks to merge into the live `SCHEMA.md` once approved. Nothing here is implemented yet.

---

## /locations/{locationId} — canonical location registry

The closed set of every place stock can physically be. Every movement's `from`/`to`
validates against this. **No routing is encoded** — any location may transfer to any
other (flexible topology); the registry only defines *which ids are valid*.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Mirror of node key. |
| `label` | string | yes | Human label, e.g. "Warehouse 1", "Hub 2B", "Marathon PE". |
| `kind` | `"warehouse" \| "store" \| "transit"` | yes | `store` = sellable floor; `transit` = in-transit holding. |
| `sellable` | boolean | yes | `true` → POS may ring a sale from this location. |
| `active` | boolean | yes | Inactive locations reject new movements (read-only history). |

**Seed values:** `warehouse1` (top-of-chain receiving), `hub1`, `hub2`, `hub2b`, `hub3`,
`hubC` (all warehouse, not sellable); `marathon-pe`, `marathon-pine`, `trophy` (store,
sellable); `in_transit` (transit, not sellable).

---

## /stock/{locationId}/{productId}/{size} — balance cells

Current on-hand quantity. **One cell = one (location, product, size)** — the smallest
unit, so every movement touches exactly one cell. Cells are a CACHE; the ledger
(`/stock_movements`) is the source of truth and can fully re-derive every cell.

| Field | Type | Required | Notes |
|---|---|---|---|
| `qty` | number (integer) | yes | On-hand. ≥ 0 normally; may be negative **only** when set by a `sold`/`return` movement (offline oversell — alarmed, never hidden). |
| `v` | number (integer) | yes | Version. **+1 on every write.** Optimistic-concurrency guard against lost updates; the security rule requires `newData.v === data.v + 1`. |
| `mv` | string | yes | Push-id of the movement that produced this qty. Audit back-link; reconciler checksum. |
| `lastType` | string | yes | `type` of that movement. Carried on the cell so the security rule can enforce the negative-allowance from `newData` (RTDB `root` is pre-write, so the just-written movement is not cross-path visible). |
| `state` | `"untracked" \| "counting" \| "live"` | yes | Rollout gate. Only `live` cells decrement and participate in stock-aware checks. Absent ≡ `untracked`. |
| `updatedAt` | ISO string | yes | |
| `updatedBy` | uid | yes | |

**Write discipline:** never write a cell directly. All changes go through the single
`applyMovement()` helper, which writes the cell **and** the movement in one atomic
multi-path `update()` (see component scaffold).

---

## /stock_movements/{movementId} — APPEND-ONLY ledger

Immutable. `movementId` is a **client-generated push id** = the idempotency key (an
offline sale carries its id from creation; re-sync is a no-op if the id already exists).

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `"received" \| "sold" \| "transfer_out" \| "transfer_in" \| "adjustment" \| "return"` | yes | Sign comes from type (received/transfer_in/return = +; sold/transfer_out = −; adjustment = signed). |
| `productId` | string | yes | Must exist in `/products`. |
| `size` | string | yes | |
| `qty` | number | yes | **Positive magnitude always.** |
| `from` | locationId \| null | type-dep | null for `received`. Must exist in `/locations`. |
| `to` | locationId \| null | type-dep | null for `sold`. Must exist in `/locations`. |
| `actor` | uid | yes | Must equal `auth.uid` (rule-enforced; can't be forged). |
| `actorRole` | string | yes | Snapshot of stockRole at write time. |
| `ts` | ISO string | yes | **Real event time** (offline sale time, not sync time). The demand series keys off this. |
| `appliedAt` | ISO string \| null | no | When it hit RTDB (offline: sync time). |
| `reason` | string \| null | adj-req | **Required & non-empty for `adjustment`**; null otherwise. |
| `link` | object | yes | `{ orderId, transferId, refillId, saleId, deviceId }` — any/all null. Provenance; never orphaned. |

**Write authorization (per role, from `/users/{uid}/stockRole`):**

| type | who may write |
|---|---|
| `received` | warehouse, admin |
| `transfer_out`, `transfer_in` | warehouse, store, admin |
| `sold`, `return` | pos, store, admin |
| `adjustment` | admin only (and must carry a `reason`) |

---

## /transfers/{transferId} — deliberate-transfer documents

Bulk rebalancing lifecycle. **Stock is moved by the paired movements, not by this node.**

| Field | Type | Notes |
|---|---|---|
| `status` | `"dispatched" \| "received" \| "discrepancy"` | |
| `from`, `to` | locationId | Any → any (flexible topology). |
| `lines` | `[{ productId, size, qtyDispatched, qtyReceived }]` | Receive-time `qtyReceived ≠ qtyDispatched` ⇒ a signed `adjustment` movement (`reason:"transfer_discrepancy"`) + `status:"discrepancy"`. |
| `createdBy`, `createdAt`, `receivedBy`, `receivedAt` | | |

---

## /refill_requests/{refillId} — Source refill chain (ledger-aware)

Durable replacement-record for the auto-created Source refill (§2.4). **During rollout
this is written ALONGSIDE the existing `/restock_log` dual-write (O6); the Source card
keeps reading `/restock_log` until a later phase.**

| Field | Type | Notes |
|---|---|---|
| `productId`, `size` | string | |
| `requestingLocation` | locationId | The hub/store that lost the pair and needs replenishment. |
| `qty` | number | Usually 1 (per sold pair); bulk allowed. |
| `createdFrom` | `{ movementId, orderId }` | The sold/transfer_out that triggered it. |
| `status` | `"open" \| "fulfilled" \| "cancelled"` | |
| `fulfilledBy` | `{ transferId } \| null` | The transfer (any upstream → requesting location) that satisfied it. |
| `cancelledBy` | `{ movementId } \| null` | The `return` movement that voided it. |
| `createdAt`, `resolvedAt` | ISO | |

**Return reversal (§2.4c) — never a silent decrement:** a logged return writes BOTH
(1) a `return` movement (+qty crediting the re-entry location) and (2) the matching open
request set to `cancelled` with `cancelledBy`.

---

## /sales/{saleId} — POS sale records

Create-only (a rung sale isn't editable). Effectively a projection of `sold` movements
— rebuildable from the ledger, so receipt and stock count can never disagree.

| Field | Type | Notes |
|---|---|---|
| `lines` | `[{ productId, size, qty, unitPrice, fulfillingLoc, movementId }]` | One `movementId` per line (the idempotency key). |
| `total`, `tenderType` | number / string | |
| `deviceId` | string | Till id. |
| `ts` | ISO | Real sale time. |
| `syncedAt` | ISO \| null | Set when an offline-queued sale reaches RTDB. |

---

## /stock_alerts/{alertId} — accuracy + reconciler alerts

| Field | Type | Notes |
|---|---|---|
| `kind` | `"phantom_stock" \| "negative_balance" \| "reconcile_mismatch" \| "stale_in_transit"` | |
| `locationId`, `productId`, `size` | | |
| `detail` | object | Context (expected vs actual, movement range, age, …). |
| `createdAt`, `resolvedAt`, `resolvedBy` | | |

---

## /config/posCutover/{locationId} — analytics cutover (§3.3)

`ISO string` (absent = still pre-POS). Per-location boundary between the legacy
`insights_log` `ready` sale-proxy and post-POS `sold` movements. Admin-only flip.

---

## insights_log — extend the `action` enum (O2-A)

Add **`"sold"`** as a first-class action alongside the existing values. POS writes
demand events in the existing `insights_log` shape, keyed on `productId` (always present
since commit #55), name-match only as legacy fallback, gated by `posCutover`.

```
action: "placed" | "ready" | "out_of_stock" | "tomorrow" | "collected" | "stock_depleted" | "sold"   ← NEW
```

New optional field on POS-origin events: `locationId` (the fulfilling/selling location).

---

## Legacy `central` attribution rule (O1-residual) — for the cutover

Legacy `placedStore:"central"` orders genuinely mixed PE + Trophy. Attribute by routed
destination hub:

- **Sneakers:** `hub1`-bound ⇒ **Marathon PE**; `hub2`-bound ⇒ **Trophy**. Clean, deterministic.
- **Clothing routed to `hub2`:** **ambiguous** (hub2 also held PE clothing overflow).
  **Do NOT guess.** Place these in a `legacy_unattributed` bucket and surface them in a
  report for manual attribution if it ever matters.

```
/reports/legacy_unattributed/{id}
  orderId, productId, productName, size, placedStore:"central", routedHub:"hub2", productType:"clothing", ts
```

---

## Retire before go-live (drift prevention)

- **`/products/{id}/stock`** (legacy per-size object) — migrate values into `/stock`
  during seeding, then freeze read-only. Not a quantity source post-go-live.
- **`/inventory`** (pre-declared, open, unused) — removed from rules entirely.
