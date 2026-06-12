# Rules PR — read-path inventory, go-live plan, rollback & smoke test

This is the **separate** security-rules PR (NOT shipped with the feature PR). It swaps
`database.rules.json` to the per-role version (`design/database.rules.draft.jsonc`) in
its own scheduled deploy window. Deliverables below per your adjustments (1)(2).

---

## A. Cross-app read-path inventory (every app on marathon-club RTDB)

Removing the root `.read` cascade means **every client-SDK read path must be granted
explicitly** or that feature breaks. Admin-SDK access bypasses rules (cannot break).

### A.1 marathon-store-app — client SDK (PIN/synthetic-email + Google super-admin; TV = anonymous)

| Top-level path | Read site (representative) | Anonymous TV? |
|---|---|---|
| `products` | App.jsx:271 | no |
| `products_meta` | App.jsx:327 (txn) | no |
| `orders` | App.jsx:463 | **YES — only path TV reads** |
| `insights_log` | App.jsx:530 | no |
| `insights` (`insights/reorderPlan/*`) | App.jsx:7421 | no |
| `restock_requests` | App.jsx:763 | no |
| `restock_log` | App.jsx:944 | no |
| `returns_log` | App.jsx:963 | no |
| `customers` | App.jsx:1012 | no |
| `broadcasts` | App.jsx:1116 | no |
| `broadcastHistory` | App.jsx:1141 | no |
| `orderCounter` | App.jsx:1164 (txn) | no |
| `source_onhold_responses` | App.jsx:5783 | no |
| `users` / `users/{uid}` | UserManagement.jsx:114, AuthGate.jsx:98 | no |

**TV display route** authenticates via `signInAnonymously()` (AuthGate.jsx:82) and reads
**`orders` only** (via `useOrders()` in `TvOnlyShell`). → rules grant anonymous `orders`
read; deny anonymous everywhere else.

### A.2 marathon-pos-app — client SDK (PIN/synthetic-email). Same DB confirmed.

| Path | Reads | Writes |
|---|---|---|
| `customers` | ✓ | ✓ |
| `customers_meta` | ✓ (txn) | ✓ |
| `inventory` | ✓ | ✓ (sales decrement `inventory/{storeId}/{productId}/{sizeKey}`) |
| `inventory_meta` | ✓ | ✓ |
| `pos` | ✓ | ✓ (sales/laybys/refunds/credits/audit/config) |
| `pos_meta` | — | ✓ (receipt-number counters, txn) |
| `products` | ✓ | ✓ |
| `users` / `users/{uid}` | ✓ | — |

### A.3 marathon-ai — **client SDK (NOT admin)**. Same DB confirmed.

Reads (all client-SDK — **will break** if not granted): `products`, `insights_log`,
`returns_log`, `insights/reorderPlan/*`, `marketing/campaigns`.
Writes: `marketing/campaigns/{id}`.

### A.4 marathon-broadcast-service — **no RTDB**. Admin-SDK Firestore only → **unaffected** by this change.

### A.5 Consolidated grant matrix (what the draft rules implement)

- **Anonymous (TV):** `orders` read only.
- **Staff (non-anonymous):** read on all of: products, products_meta, orders, insights_log,
  insights, restock_log, restock_requests, returns_log, customers, customers_meta,
  broadcasts, broadcastHistory, orderCounter, source_onhold_responses, users, inventory,
  inventory_meta, pos, pos_meta, marketing, + new stock paths.
- New stock paths: per-role writes (§5 of design); staff read.

---

## B. ⚠️ Two findings that must be resolved before the swap

### B1. Committed rules are STALE vs deployed (blocking verification) — ✅ APPROVED
**Decision:** the authoritative rollback baseline is the **DEPLOYED rules captured at
deploy time**, NOT the committed `rules-rollback.json`. Capture them in the deploy
window and commit the capture as the rollback artifact before the swap.

`pos_meta`, `inventory_meta`, `customers_meta`, `marketing`, `insights` are used by
marathon-pos-app / marathon-ai but are **absent** from the committed
`database.rules.json` (which relies on the root `.read` for reads and has no `.write`
entry for them — so client writes to them would be *denied* under the committed file).
Yet those features work in production ⇒ **the deployed rules differ from the repo.**

**Action before swap:** capture the ACTUALLY-DEPLOYED rules as the rollback baseline:
```
firebase database:get /.settings/rules --project marathon-club   # or Console → RTDB → Rules
```
Reconcile any deployed path not represented in the draft. `design/rules-rollback.json`
holds the *committed* version as a starting point, but the **deployed** capture is the
authoritative rollback.

### B2. `/inventory` ↔ `/stock` convergence — ✅ RESOLVED (hard sequencing gate)
The POS app implements a competing inventory model at `/inventory/{storeId}/...` that
sales decrement directly. **Decision:** keep `/inventory` in the rules for now (POS V1
depends on it); POS converges onto `/stock` + `applyMovement()`, and that convergence is
a **HARD PRECONDITION (gate G1, design §7.3)** for any of a product's cells reaching
`live`/enforcing — **we never operate two quantity sources for the same product.**
`/inventory` retires entirely in **Phase B** once POS reads/writes `/stock` exclusively
(then removed from the rules, hardening H2). Ordering: **POS-onto-`/stock` → `live` →
`/inventory` removal.**

---

## C. Go-live plan (rules swap)

1. **Deploy mechanism:** `firebase deploy --only database` **only** (never a bare
   `firebase deploy`, which would also touch hosting/functions).
2. **Window:** scheduled **early morning, before store open** (tills idle, TV idle, no
   active sales to break).
3. **Rollback artifact:** the deployed-rules capture (B1) committed as
   `rules-rollback.json` in the PR, so rollback is a single
   `firebase deploy --only database` of that file.
4. **PR contents:** new `database.rules.json` (from the draft), `rules-rollback.json`
   (deployed capture), this document. Branch → PR → CodeRabbit, same as features.

## D. Post-swap smoke test (run immediately after the swap)

One read per app per critical path, plus the anonymous-lockdown check:

| # | App / context | Check | Pass = |
|---|---|---|---|
| 1 | store-app (staff login) | role selector loads; open Insights, Source, Customers | each reads without permission error |
| 2 | store-app **TV route** (anonymous) | open `#tv` | orders render |
| 3 | store-app **TV negative** | from the anonymous TV session, attempt a read of `customers`/`users` | **DENIED** (lockdown works) |
| 4 | pos-app (PIN login) | open till; load products + inventory; ring a test sale to a sandbox product | sale completes; `inventory` decrements |
| 5 | pos-app | layby / refund counter (`pos_meta`) increments | no permission error |
| 6 | marathon-ai (login) | dashboard loads reorder plan; SlowMovers reads `insights_log`/`returns_log` | data renders |
| 7 | broadcast-service | (control) confirm unaffected | still sending (admin-SDK) |
| 8 | any staff | write a `stock_movements` test entry as a stockRole user; confirm a non-stockRole user is denied | per-role gate works |

If any of 1–6 fails → immediate rollback (single `firebase deploy --only database` of
`rules-rollback.json`), investigate, reschedule.

---

## E. Sequencing

- This rules PR is **independent** of the feature PR and deploys in its own window.
- The feature PR (the `/stock` scaffold) can merge first and sit dormant — its writes are
  gated by `stockRole`, which no one has until rollout — so it is inert until both the
  rules are live AND staff are granted `stockRole`.
- Recommended order: (1) feature PR merges (inert), (2) reconcile B1/B2, (3) rules PR
  deploys in window with smoke test, (4) grant `stockRole` to pilot staff, (5) begin
  rollout R0 (§7 of design).
