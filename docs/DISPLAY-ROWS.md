# Display rows — a display record with a life

**Built 2026-09-08, on `fix/display-record-cleanup` (PR #575).**

## The rule that governs everything here

> **Nothing ever picks, guesses, suggests or pre-selects a display size.**
> No default, no last-used, no most-available, no auto-fill. The 15-minute
> timer raises a REQUEST only; it never selects a size and never sends.

Pinned by `src/components/stock/displaySizeNeverPreselected.test.js`, which
reads the source of every surface that can put a size on the record. It is a
source test because there is no input that demonstrates the *absence* of a
default — and because this rule has already been broken twice on this feature:

1. before 2026-08-26 the sheet never appeared, so the **sent** size was silently
   recorded as the display size;
2. the fix left the sent size **preselected**, which is the same mistake wearing
   a smaller hat — a preselected answer is the answer that gets confirmed.

## Why a new node at all

The display work had two records and neither could answer *"what is on this
shop's wall, and what was there before?"*

| | scope | tombstones | can hold two? |
|---|---|---|---|
| `/settings/hubSneakerCount/register/{hub}/{pid}__{sizeKey}` | **hub** — no store field on any of the 558 live rows | yes (`qty 0` + `retiredAt`) | yes, but per size, and it cannot say whose wall |
| `/settings/displaySlots/{store}/{productId}` | store + product | yes (`sizeKey: null`) | **no — one record per product per store** |

Measured live on 2026-09-08: **479 live slots, and 0 store+product pairs with
more than one.** That number could never have been anything else. A second send
*overwrote* the first, so a wall that physically holds two pairs of the same
shoe had a record that held one — and the pair that stayed was invisible.

`/settings/displayRows/{store}/{productId}/{rowId}` gives the record a life:
many rows per wall per shoe, each opened and closed with a reason, a timestamp
and a timeline.

## Shape

```
/settings/displayRows/{store}/{productId}/{rowId} = {
  rowId, store, productId, productName,
  size, sizeKey, bookedHub,
  status: "open" | "closed",
  openedAt, openedBy, openedVia,   // send | wall_walk | registration | seed
  requestOrderId,
  closedAt, closedBy, closedReason, closedVia, closedRef,
  events: { eventId: { at, what, by, detail } },
}
/settings/displayRows_meta/{store}/processed/{movementId} = { at, done, closed }
```

`closedReason` ∈ `replaced | sold | returned | corrected | cancelled`.
**A closed row is never deleted.** Event ids are *derived*, not pushed, so a
replayed transition rewrites the same timeline entry instead of appending it
twice.

## The slot is a mirror, not a replacement

`/settings/displaySlots` stays exactly as it is and keeps every reader:
`offShelf`'s expected-on-shelf, the shop marker, the count card,
`displayPairCore`'s replay. Opening a row also writes the slot; closing the
**last** open row clears it; closing one of several re-points it at the
survivor. The rows are the ledger; the slot is current state.

The one thing deliberately **not** inside the atomic update is the slot write —
`setDisplaySlot`/`clearDisplaySlot` are *transactions* carrying a staleness
fence, a multi-path update cannot carry a transaction, and that fence is
load-bearing. So the rows and the order move together in one write; the mirror
follows, fenced, and its failure is **reported**, never swallowed.

## The six clauses, and where each lives

| # | | Where |
|---|---|---|
| 1 | ≤1 open display request per product per store | `displayRowCore.hasOpenDisplayRequest`, enforced in `App.jsx` checkout and in `displayRequestStore.raiseDisplayRequest` |
| 2 | Send = ONE atomic write (close old, open new, clear request) | `displayRowCore.sendPlan` → `displayRowStore.sendDisplayRow`, called from `setDisplayRefillStatus` |
| 3 | Close at sale, server-side, no POS change | `functions/displayRows/closeDisplayRowOnSale.js` + `lib.cjs` |
| 4 | Duplicate Displays tab | `DuplicateDisplaysTab.jsx` |
| 5 | Unregistered Displays tab (wall walk + scan) | `UnregisteredDisplaysTab.jsx` |
| 6 | Timeline on every row | `displayRowCore.rowTimeline`, `displayRowUi.RowHistory` |

## Deploy

Hosting as usual. The function is **scoped by name** — functions are shared with
`marathon-pos-app` and a bare `--only functions` would redeploy everything:

```
firebase deploy --only functions:closeDisplayRowOnSale
```

## The seed

```
node --import ./scripts/lib/appModuleLoader.mjs scripts/seed-display-rows.mjs          # dry run
node --import ./scripts/lib/appModuleLoader.mjs scripts/seed-display-rows.mjs --apply
```

Dry run on 2026-09-08: **461 rows to open** (marathon-pe 348, trophy 113) from
479 live slots — 44 tombstones skipped, 18 Pine slots skipped (booked at hub3,
outside `GATED_SNEAKER_HUBS`). Re-runnable: a wall+product that already has any
row is skipped.

The seed produces **zero duplicates**, and not because the walls are clean — the
old record could not hold a second one. Duplicates surface from here on, as
sends open a second row beside one that was already there and as the wall walk
registers what is actually seen.

## RULES TO PASTE (console, by hand — `database.rules.json` is not touched)

Both new subtrees live under `/settings`, which the live rules already allow a
signed-in non-anonymous user to write, so **nothing here is blocking**. The
hardening rule to paste when convenient, alongside the one `displaySlots` is
still waiting for:

```json
"displayRows": {
  ".read":  "auth != null",
  ".write": "auth != null && auth.provider != 'anonymous'"
},
"displayRows_meta": {
  ".read":  "auth != null",
  ".write": "auth != null && auth.provider != 'anonymous'"
}
```

placed inside the existing `"settings"` node.

## What is out of scope, and stays out

* **Hub 3 / Pine.** `GATED_SNEAKER_HUBS` is `["hub1", "hub2"]`. Pine's 18
  displays are booked at hub3: not seeded, not shown on either tab, not closed
  by the trigger. Widening that gate is an owner decision, not a code change.
* **`marathon-pos-app`.** Untouched. The sale close fires off the
  `/stock_movements` record the till already writes.
* **The existing Display Registry** (Hub 1 / Hub 2 tabs) and the **Display
  Records** cleanup tab (PR #575's register-vs-floor work). Both unchanged.
