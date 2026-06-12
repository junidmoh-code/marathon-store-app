# Stock UI — component scaffold (DRAFT for review)

Contracts only — **no implementation**. This specifies the file tree, each file's
responsibility, exports/props, and the critical `applyMovement` contract. Built as
SEPARATE files under `src/components/stock/` — the `App.jsx` monolith only gains the
small wiring in §0.

Conventions match the existing codebase: React 18 + Vite, inline styles using the
`App.jsx` design tokens (`CARD`, `BLUE`, `RADIUS`, `BORDER`, `FONT`…), Firebase v10
modular SDK (`ref`, `onValue`, `update`, `push`, `runTransaction`), `usePersistedTab`
for tabs, `onExit` callback to return to RoleSelector.

---

## 0. Wiring into App.jsx (minimal monolith change)

```jsx
// ROLES (App.jsx:102)
const ROLES = { …, STOCK: "stock" };

// ROLE_TO_PERMISSION (App.jsx:109)
[ROLES.STOCK]: "stock_management",          // NEW dedicated permission

// import (top of App.jsx)
import StockView from "./components/stock/StockView";

// RoleSelector tile (App.jsx ~1640) — gated
hasPermission("stock_management") &&
  <RoleCard key="stock" icon={RoleIcons.stock} name="Stock"
            desc="Inventory & transfers" onClick={() => onSelect(ROLES.STOCK)} />,

// view cascade (App.jsx ~9200)
else if (role === ROLES.STOCK)
  view = guard(ROLES.STOCK, <StockView onExit={() => setRole(null)} />);
```

That is the entire footprint inside `App.jsx`. Everything else is new files.

---

## 1. File tree

```
src/components/stock/
  applyMovement.js      ← THE ONLY writer to /stock. Online + offline entry point.
  offlineQueue.js       ← IndexedDB queue + background sync (POS).
  useStock.js           ← onValue hooks for the stock paths.
  locations.js          ← registry helpers (labels, sellable filter); NO routing logic.
  StockView.jsx         ← shell: tabs + onExit.
  ReceiveStock.jsx      ← new arrivals → received movements.
  Transfer.jsx          ← deliberate transfer + Source-refill fulfilment.
  Adjust.jsx            ← manual adjustment (admin, mandatory reason).
  StockGrid.jsx         ← per-product × size × location matrix.
  InTransit.jsx         ← in-transit holding + aging alerts.
  MovementHistory.jsx   ← per-product immutable ledger view.
  CountSession.jsx      ← physical-count entry (seeding / recount).
```

---

## 2. `applyMovement.js` — the single source of all stock writes

**The one function every UI and the POS call. No raw `/stock` writes anywhere else.**

```js
// CONTRACT (pseudocode — not implementation)
//
// applyMovement(movement) -> Promise<{ ok: true, movementId } | { ok:false, reason }>
//
//   movement: {
//     type, productId, size, qty(>0),
//     from|null, to|null, reason?, link?, cellState?,
//     ts (real event time), deviceId?,
//     movementId?   // CALLER-SUPPLIED to make the call idempotent (offline queue
//                   //   stamps one id per line at sale time; re-sync is a no-op)
//   }
//
// CELL EFFECTS: received/return → +to; sold → −from; adjustment → +to OR −from
// (whichever side is set). RELOCATIONS (transfer_out / transfer_in) touch TWO cells
// in one atomic op — −from AND +to — so stock moves through the real in_transit
// holding and is never invisible.
//
// STEPS:
//   1. movementId = movement.movementId || push(stock_movements).key  // idempotency key
//   2. if get(stock_movements/{movementId}) EXISTS → return {ok,idempotent} (re-sync no-op)
//   3. read each affected cell {qty, v} once; compute newQty (sign from type)
//   4. build ONE multi-path update object (the movement + EVERY affected cell):
//        updates["stock_movements/"+movementId]            = {…movement, actor, actorRole, appliedAt:now}
//        for each affected cell:
//          updates["stock/{loc}/{pid}/{size}/qty"]         = newQty
//          updates["stock/{loc}/{pid}/{size}/v"]           = (cell ? v+1 : 0)
//          updates["stock/{loc}/{pid}/{size}/mv"]          = movementId
//          updates["stock/{loc}/{pid}/{size}/lastType"]    = movement.type
//          updates["stock/{loc}/{pid}/{size}/updatedAt"]   = now
//          updates["stock/{loc}/{pid}/{size}/updatedBy"]   = uid
//        // optional same-op side effects (sale record, refill request, etc.)
//   5. update(ref(database), updates)
//   6. on failure where data.v advanced (version conflict): re-read, recompute, retry
//      (bounded retries). On persistent failure → surface, do NOT partial-write.
//
// IDEMPOTENCY (offline re-sync): before step 2, if get(stock_movements/{movementId})
// EXISTS → return {ok:true, movementId} without re-applying. The create-only rule is
// the backstop if two devices race the same id.
//
// NEGATIVE qty: allowed to pass through only for type ∈ {sold, return} (already-happened
// events). For transfer_out / adjustment, if newQty < 0 → reject with reason
// "insufficient_stock" (the rule also enforces this).
```

`applyMovement` is imported unchanged by the POS app, so online and offline sale paths
share one idempotent code path (drift control §1.5 of the design doc).

---

## 3. `offlineQueue.js` — POS offline-first (§3.4)

```js
// enqueueSale(sale)         // writes sale + its line movement ids to IndexedDB; resolves
//                           // immediately so the till NEVER blocks on connectivity.
// startBackgroundSync()     // on 'online' / interval: drain queue via applyMovement()
//                           // (idempotent). Keeps selling while syncing.
// useSyncStatus() -> { pending: number, syncing: boolean, lastSyncedAt }
//                           // drives the small "syncing N" indicator (O7: never blocks sales).
```

Sales sync in the background while the till keeps ringing. A returning till shows a
small syncing indicator; new sales continue to enqueue. Version guard + idempotency make
interleaved queued-offline and live-online sales on one cell safe.

---

## 4. `useStock.js` — read hooks (mirror existing `useProducts`/`useOrders` pattern)

```js
useStockCells(locationId?)     // onValue(/stock[/loc]) -> nested {loc:{pid:{size:cell}}}
useMovements(productId?)       // onValue(/stock_movements) filtered
useTransfers(status?)          // onValue(/transfers)
useRefillRequests(status?)     // onValue(/refill_requests)
useLocations()                 // onValue(/locations) -> registry array
useStockAlerts()               // onValue(/stock_alerts)
```

---

## 5. `locations.js` — registry helpers, NO routing

```js
labelFor(locationId)                 // "hub2b" -> "Hub 2B"
sellableLocations(locations)         // filter kind==='store' && sellable
warehouseLocations(locations)        // filter kind==='warehouse'
// Deliberately NO allowedDestinations()/routeFor() — topology is flexible (§1.2).
// Any from→any to is valid; the UI offers ALL active locations as transfer targets.
```

---

## 6. Screen contracts (props + behavior)

```jsx
StockView({ onExit })
  // tabs: Grid · Receive · Transfer · In-Transit · Adjust · History · Count
  // usePersistedTab("stock", "grid"); renders the child for the active tab.

ReceiveStock({ locations })
  // pick destination (default warehouse1) → product → per-size qty → confirm.
  // each size => applyMovement({ type:"received", from:null, to:dest, … }).

Transfer({ locations, refillRequests })
  // mode A — deliberate: from + to (ANY active locations) + lines → Dispatch
  //   (transfer_out per line to in_transit) → … → Confirm Receive
  //   (transfer_in per line; qtyReceived≠qtyDispatched ⇒ adjustment + status:"discrepancy").
  // mode B — fulfil refill request: pick an open /refill_requests row, choose any
  //   upstream source location, run it as a transfer with link.refillId; on receive
  //   set request status:"fulfilled".

Adjust({ locations })             // ADMIN ONLY (guarded). location+product+size+signed qty
  // + MANDATORY non-empty reason → applyMovement({ type:"adjustment", reason, … }).

StockGrid({ locations })          // product × size × location matrix; click cell → history.
  // shows state badge (untracked/counting/live); negative qty flagged red (alert link).

InTransit({})                     // every in_transit cell with age; stale (> threshold) → alert/task.

MovementHistory({ productId })    // reverse-chron immutable ledger for a product; read-only.

CountSession({ locations })       // seeding/recount: location → walk sizes → enter counted qty
  // => for each size, delta = counted − current; apply an adjustment that targets the
  //    counted location (to=loc when delta>0, from=loc when delta<0, reason
  //    "initial_count"/"recount", cellState:"live"). A zero delta flips state via
  //    setCellState(loc,pid,size,"live") — no movement. Partial coverage is normal.
```

---

## 7. What this scaffold deliberately does NOT do

- No `/stock` write outside `applyMovement` (enforced by review).
- No routing/topology constraints (any → any).
- No enforcement of stock floors during rollout R1 ("inform, not enforce") — the UI shows
  warnings; hard blocking lands at R2 after the 14-day zero-unexplained-variance gate (O5).
- No reading of the new `/refill_requests` by the Source card yet (O6 dual-write phase).
