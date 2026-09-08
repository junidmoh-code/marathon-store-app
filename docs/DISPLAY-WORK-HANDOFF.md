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

## 4. Live numbers as of 2026-09-08 (read-only census, both hubs)

* register rows: hub1 546, hub2 505
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
