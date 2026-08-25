# Deactivate Leftovers — Investigation (Commit 1, 2026-08-25)

## 1. Does an active/inactive concept already exist?

**No live one on `/products`.** Every nearby concept, and why none is reusable as-is:

| Concept | Where | What it gates | Reusable? |
|---|---|---|---|
| `depletedAt`/`depletedBy` | `/products` (inert) — SCHEMA.md:54-70, src/App.jsx:802-807 | NOTHING today. Was exactly this feature (blur + un-orderable + "Bring Live") and was **deliberately retired**; writers gone, readers gone | **No** — stale values still sit on old records; resurrecting the field would instantly deactivate products nobody chose. New field required |
| `mergedInto` | `/products/{pid}` — src/utils/mergedProducts.js | Client visibility (dropped at the `useProducts` chokepoint, App.jsx:498-543); engine never reads it | No — destructive semantics (loser of a merge), not reversible one-tap |
| `settings/missingProductsHidden` | own node — hiddenProductsCore.js | **UI-only by proof** (functions/test/refill-hidden-invariance): a hidden product still refills | No — its contract is the opposite of ours; but its patterns (reason'd entries, never auto-purge) are reused |
| `stock_targets` target 0 `source:"excluded"` | per (loc,pid,size) | Engine + ordering, one cell at a time | No — per-cell, not product-global; rows are hand-made truth (never deleted) |
| `stock_targets_decisions` | per (loc,pid) | Temporary engine suppression (snooze/until_change) | No — deliberately impermanent |
| Shopify `state`/`liveState` | `/shopify_publish/{pid}` | Storefront only — zero effect on stock/engine/ordering | No |
| `storeCarries` (cell existence) | `/stock/{loc}/{pid}` | Engine + ordering de-facto | No — deleting cells is destructive and against the applyMovement contract |
| `active:false` | categories + locations registries | Pickers / new assignment only | Pattern endorsed, wrong scope |

**Decision:** new field `products/{pid}/deactivated = { at, by, byName }` (removal = reactivation; `reactivated = { at, by, byName, reason }` records the reverse). One key, atomic multi-path toggle, nothing deleted. `depletedAt` is left untouched and inert.

## 2. What the engine consults before raising a refill request

Driver `functions/refill-scan.cjs` (`refillHealthScan`, every 15 min 07:00–19:00): run lock :337, kill switch `config.enabled` :368, receiving-session pause :377. Snapshot built at :391-406 — **includes the full `/products` node**, so a product flag costs zero extra I/O.

Pure core `functions/lib/refill-engine.cjs` — per-cell path to an intent:
- universe: `managedPids` :1037, `sizesFor` :1060 (explicit rows ∪ category policy ∪ rule/footwear × `storeCarries` :205 — cell PRESENCE, so zero-qty cells arm the engine);
- class filter :1355; **`resolveTarget` :467** (explicit row → category policy :508 → footwear rule :519 → clothing kill switch :543 → subcategory :565 → default run :570); `!t` skip :1360;
- deficit :1366, reorder point :1390, confirmed-out :1398, unfillable :1432, inbound :1442, reject streak :1460, retry window :1477, cooldown :1487, source-actionable :1514, `intents.push` :1562, caps :1620/:1668.

**Every intent goes through `resolveTarget`** — the deactivation guard goes there (first line), so: no intent, no belowTarget/missingSizes noise, and the reconcile pass (:775-790) auto-withdraws in-flight requests as `no_longer_needed`. Extra guards on the clothing-only Decision Queue loops keep the plan fully silent. Consequences accepted and reported: a deactivated product also leaves Move Excess (:1720, `!t` skip) and Solve/seed surfaces — covered by the Deactivated list (§5) and by auto-reactivation on any stock arrival.

Non-engine request writer: `src/components/stock/MissingFootwear.jsx:145,240` writes `/refill_requests` directly — gets its own guard.

Client mirror `src/components/stock/solvePlan.js` (`resolvedRun`) is NOT given a guard: the engine skip + arrival auto-reactivation closes the loop (seeding a deactivated product transfers stock in → reactivates it), and touching the mirror for no behavioural need risks drift.

## 3. Screens that render size availability for ordering

**All ordering UI with stock-gated sizes is in THIS app.** marathon-pos-app is a separate repo; no checkout/till UI here (only the dormant `offlineQueue.js` it imports).

In this app, selectable-vs-greyed for ORDERING:
- Assistant phone/sheet order — size chips `src/App.jsx:9545-9561` (predicate :9551), inline note :9524.
- Assistant desktop — hover quick-add `src/App.jsx:8117-8138` (:8122), quick-view row :8270-8281 (:8272).
- Today only clothing greys (zero at serving CR hub); sneakers never grey. Deactivated products now grey on all three, any product type.

Not stock-greyed (sizes always selectable — unchanged): CR refill steppers App.jsx:8329/:7404, CR fulfil :11779 (stock is pre-fill not cap), warehouse dispatch :10990, display refills :11450, Transfer.jsx :627 (filters to in-stock), MissingFootwear steppers :383 (now blocked for deactivated).

**marathon-pos-app**: sells by barcode scan; it has no read of any product-level active flag. If the POS should refuse to sell/lay-by a deactivated product's sizes, it needs its own check of `products/{pid}/deactivated` — NOT changed here, reported only. (A POS sale of a deactivated product is a `sold` movement — a deduction — so it does NOT auto-reactivate; only arrivals do.)

## 4. Census (live, 2026-08-25, `scripts/leftovers-deactivate-census.mjs`, read-only)

- hub1: **21 leftovers holding 40 units** — 2 sum to zero network-wide (negative cells elsewhere), 17 hold stock ONLY at hub1.
- hub2: **90 leftovers holding 498 units** — 1 sums to zero network-wide, 51 hold stock ONLY at hub2.
- The tab REQUIRES stock at the hub (`buildLeftovers` hubQty>0), so "leftovers with zero stock everywhere" barely exist by construction. The products matching the brief — zero stock anywhere yet still engine-armed through their empty cells — are **182 unregistered footwear products visible in NO list today** (cell presence: PE 91, hub3 65, pine 59, hub2 38, hub1 37, trophy 28, central 6, base 3). The build adds them to the Leftovers tab as a "Finished lines" section with the same one-tap Deactivate (hub1/hub2 scope, per the tab's owner spec; the PE/pine/hub3-only ones are reachable through product search once deactivation ships, and are listed by the census).

## 5. Where a deactivated product holding stock stays visible

A "Deactivated" section at the bottom of the Leftovers tab lists EVERY deactivated product, stock-holding ones first with per-location chips, each with one-tap Reactivate. Merge picker and product search keep finding them, marked "deactivated". Receiving stock anywhere auto-reactivates (applyMovement, arrival types: received / return / transfer_in / +adjustment / opening) and says so on screen.
