# Display work — who owns what, right now

Written 2026-09-08 by the `marathon-store-app-display` session (PR #574, #575)
for the `marathon-store-app-marker` session (PR #576, #577), and for Junid.

**Short version: we have not collided, and the file lists prove it. There are
three shared FACTS that could bite later, listed at the end.**

---

## 1. What has already landed on main

| PR | What it did | Mine? |
|---|---|---|
| **#574** `One display, one marker` | The shop-side marker stops reading the display REGISTER and reads `/settings/displaySlots` only. Adds `slotsAfterOrderExits` (replays sale / failed-pull / replacement off `/orders`) and a self-heal that persists the repair through the fenced slot writers. | yes |
| **#576** `The display marker informs; it no longer takes the size away` | Removes the divert: a marked size is orderable normally again. | no — yours |

#576 sits cleanly on top of #574. Nothing to reconcile.

## 2. What is open

| PR | Files it touches |
|---|---|
| **#575** (mine) `Display Records` | `displayRecordCleanup.js` (new), `DisplayRecordsTab.jsx` (new), `displayRegistrationStore.js`, `StockView.jsx`, a census script, three test files. **No `App.jsx`.** |
| **#577** (yours) `display location on warehouse card` | `App.jsx`, `displayLocationNote.js` (new), its test. |

**Overlap: none.** I merged main into #575 — clean, no conflicts, build green,
suite back to its 9 known-failing (pre-existing, `scripts/shopify` +
`scripts/social`, unrelated to either of us).

One test did go red on the merge and it was **not** a collision: it was the
calendar. My purity test called `slotsAfterOrderExits` without a pinned clock,
so the 7-day create bound aged a 1 Sep fixture out of the window on 8 Sep. Fixed
by pinning. Worth knowing if you write anything against that helper — **it takes
an optional `nowMs`; pass it in tests or your fixtures will rot.**

## 3. The three shared facts — please read before touching these

### a. `/settings/displaySlots` now has a WRITER on a read screen
#574 added a self-heal: when the order lane proves a slot write was dropped, the
assistant screen repairs it through `setDisplaySlot` / `clearDisplaySlot`.

Rules it obeys, which anything else writing slots should too:
* both writers take an optional `at` — **pass the transition's own instant**, not
  call time (the sale clear fires after `await writeOrder` and used to stamp
  minutes late);
* they take `loseTies`. An **author** of a transition may win an equal-instant
  tie; a **stand-in** for a dropped write must lose it. Only the repair path
  passes `loseTies: true`.

### b. `offShelf.js` reads BOTH slots and the register — and they are not equals
`booked − off-shelf = EXPECTED ON SHELF`. Source 1 is live display slots
(store-labelled, trusted); source 2 is register rows, counted only as the
unexplained remainder.

Consequence worth knowing for #577: **an unregistered display is already
subtracted from the count**, because the slot covers it. 137 such floors exist
(34 of them registerable). If your note says or implies the count is wrong for
those, it is overstating.

### c. `recordDisplayFact` had a guard bug — #575 fixes it
It decided "already registered" from the **slot alone**, so a display refill
(which writes the slot and no register row) made the card say "Already
registered", write nothing, and report success. That is how 52 unregistered
displays accumulated. #575 fixes it and moves the row check **inside** the
transaction (a pre-transaction read walks back into PR #460's race).

If #577 or anything after it calls `recordDisplayFact`, take #575's version.

## 3d. CORRECTION — how many markers #574 actually turned off

PR #574 said "315 store-less legacy rows lose their glyph". **That understated
it, because it counted the wrong thing.** The marker is drawn per CELL
(`pid::sizeKey`), so the population that went dark is register cells with no
live slot AT THAT CELL — not rows whose product has no slot anywhere.

Both measured against live RTDB on 2026-09-08:

| | |
|---|---|
| active register cells with **no live slot at that cell** | **360**, across 353 products ← the real number |
| active rows whose **product** has no live hub1 slot | 310, across 307 products ← what #574 reported |

The marker session measured 361 independently; the one-row difference is a day's
drift on a live system. Their figure is the correct one and #574's was wrong.
Junid has separately noticed the symptom ("most things don't even have the sign
anymore"). **This is an open decision for him**, not something either session
should settle alone — three options are on the table (widen the lane to hub2/3
slots, bring the register back as a store-less count-only source, or re-register
physically).

One hard constraint on that decision, verified field by field across all 558
register rows: **no row carries any store / shop / branch / location field.**
Fields present are `aliasTokenCount, at, bumps, by, movedFrom, movementId,
productId, productName, qty, retiredAt, size, sizeKey, styleCode,
styleCodeFrom, styleCodeNormalised, via`. So a register→slot backfill
structurally cannot say whose wall a display is on; only re-registration can.

A warning for the "widen the lane" option, **narrowed after the marker session
checked it against the code and was right**: `displayPairCore.js`'s header says
`pendingDisplayPullsByCell` is not hub-scoped, and I read that as "widening the
marker is dangerous". It is not. The hazard fires when the **pull lane** widens,
not when the **glyph** does:

* `sneakerDisplayInfo` (App.jsx:9508) is appearance-only — it feeds two render
  sites and nets nothing into any availability, allocation or ✕;
* `hub1Promised` (App.jsx:8992) merges pull claims into **Hub 1 only**; hub2
  nets ready orders alone;
* the one checkout reader of `hub1DisplayUnits` (App.jsx:9876) is gated on
  `item.displayPairRequest === true`, which a glyph never sets;
* and since #576 nothing mints `displayPairRequest` on the ordering screen at
  all — the divert was its only minter. The 48h claims still in flight are all
  Hub 1 orders placed before that shipped.

So widening the informational predicate would draw ~225 more markers without
touching a promised map. The fence still matters for whoever later widens the
PULL lane, which is why the marker session is writing it as **two** predicates —
informational (hub-wide) and pull (hub1, with the fence comment moved to sit on
it) — rather than one widened one.

## 4. Live numbers as of 2026-09-08 (read-only census, both hubs)

* live slots by booked hub: hub1 249 (marathon-pe 243, trophy 6, pine 0), hub2 207, hub3 18
* register rows: hub1 546 active of 558, hub2 505
* **contradicted and offered for retirement: 124** (replaced 88, sold 31, gone 5)
* **reported, never actionable: 593 unverified + over** — no shop was ever
  recorded, so there is no evidence either way
* confirmed correct: 333
* **displays on a floor with no register row: 137** (34 registerable; the other
  103 are registered at a different size, which is the Double Displays tab's
  business)

Reproduce: `node --import ./scripts/lib/appModuleLoader.mjs scripts/census-display-record-cleanup.mjs`

## 5. Still open in `marathon-pos-app` — neither of us can fix it here

A display sold at PE/Trophy deducts the **shop** cell, never the **hub** cell it
is booked into.
* `src/stock/saleStockMovements.js:9` — the policy, in the header
* `src/stock/saleStockMovements.js:93` — `sellableStockLocation(m.storeId)`
* `src/stock/dispatchOrders.js:43` — `sentSize` and the origin hub are already
  resolved at sale time and nothing consumes them for a deduction

## 6. Suggested split from here

* **#577 (yours)**: the warehouse-facing note. Land it — no conflict with mine.
* **#575 (mine)**: the two admin cleanup tabs. Land after #577 or before, either
  order works; I will merge main again and re-run before merging.
* **Nobody should** change `displayPairCore.js`'s marker derivation or the
  self-heal without saying so — that is the one file we both have history in.
