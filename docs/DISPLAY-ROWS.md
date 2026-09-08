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
/settings/displayRows_meta/{bucket}/processed/{movementId} = { at, done, closed }
    // bucket = the shop for a shop-sourced sale, the HUB for a hub-sourced one
    // — the movement names it, so a redelivery cannot take a second lease
    // under a store the ledger has since changed its mind about.
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
| 3 | Close at sale, server-side, no POS change | `functions/displayRows/closeDisplayRowOnSale.js` + `lib.cjs` — see **Where a sale comes from** below. Plus the app-side close when a Display Partner request is raised (`closeDisplayRowForPartnerSale`), which is the moment this app first learns a display is leaving |
| 4 | Duplicate Displays tab | `DuplicateDisplaysTab.jsx` |
| 5 | Unregistered Displays tab (wall walk + scan) | `UnregisteredDisplaysTab.jsx`. A search also reaches walls that DO have a record (`registeredDisplays`), which is where a returned display or a wrong-size record is corrected |
| 6 | Timeline on every row | `displayRowCore.rowTimeline`, `displayRowUi.RowHistory` |

## Where a sale comes from — the thing that nearly defeated clause 3

A `sold` movement's `from` is **not always the shop**. Measured live 2026-09-08
over the newest 6,000 stock movements:

| `from` | sized | one-size |
|---|---|---|
| marathon-pe | 1,539 | 258 |
| trophy | 267 | 130 |
| hub1 | 761 | — |
| hub2 | 478 | — |
| hub3 (Pine, out of scope) | 273 | — |

So **1,806 in-scope sized sales carry a shop** and close directly, and **1,239
carry a hub and no store at all**. A hub-sourced movement's whole field set is
`{ actor, appliedAt, from, link:{saleId}, productId, qty, size, ts, type }`;
`/sales/{saleId}` is empty for those ids, and `actor` cannot separate PE from
Trophy (the manager account that rings both is scoped to `central`). All
verified against live data.

Ignoring them would leave two in five display sales standing on the record. So
the hub branch **earns** its close from evidence, and a bare hub sale closes
nothing (`resolveHubSale`, `lib.cjs`). Both conditions are required:

1. **Exactly one** open row for this product at this size is booked at that hub,
   across every display store. Two walls claiming a size 9 makes one sale
   ambiguous, and an ambiguous close is a guess.
2. **The hub cell is now empty.** A display unit stays booked at its hub (PR
   #324, "displays are hub stock"), so if the cell is at zero and a row still
   claims a unit of it is on a wall, the unit that sold *is* that unit.

Plus a third condition that the first cut did not have and needed:

3. **The sale is under two minutes old** (`HUB_INFERENCE_MAX_AGE_MS`). The cell
   is read *now* and describes an event that happened *then*, and nothing bounds
   the gap — a cold start, a redelivery, a 60-second timeout retry or an
   offline-queue drain can put minutes between them. Minutes are enough:

   > hub1 size 9 holds two — one on the shelf, one booked as Trophy's display.
   > 10:00 the **shelf** pair sells; cell → 1; the trigger is delayed.
   > 10:04 a counter adjusts the cell, or an operator transfers the remaining
   > unit to hub2; cell → 0.
   > 10:05 the trigger reads 0, sees one open row, and closes Trophy's row —
   > while Trophy's pair is still on the wall.

   An earlier version of this document claimed "the race only ever makes the
   cell look fuller". That covered only the movement's own apply and was wrong
   about every later decrement. A sale with no readable ISO instant, or one
   stamped in the future, is refused for the same reason.

Every refusal is recorded in **both** places a person might look: the log, and
the lease record itself (`refused: "<why>"`), so "why did this display record
not close?" is answerable after the fact.

**The lease is claimed before any adjudication**, not once there is work to do.
A refusal that wrote nothing left the movement to be re-judged against a
different world on redelivery — refused because two walls claimed the size, then
an operator closes one of them as a correction, then the redelivery finds one
candidate and closes it on a premise that was explicitly rejected. A movement is
adjudicated once. Cost: one small write per in-scope sale, ~600/day.

**Return-to-hub is a person's action, not an inference.** A first cut closed on
a shop→hub `transfer_out`. That is wrong by construction: a display stays
*booked at its hub*, so it is not in the shop's cell at all, and a transfer out
of a shop therefore moves ordinary shop stock. It would have closed a real
display every time a shop sent excess back. The person who takes a display down
closes it on the **Unregistered Displays** tab — search for it, or scan it — with
reason `returned`. That surface exists because a returned display is *one* open
row: too few for the Duplicate tab, and excluded from the wall-walk list because
it already has a record, so before it there was no screen that could reach it.

**A duplicated wall never auto-closes.** Two open rows for one size — on one wall
or across two — is ambiguous, and ambiguous is a refusal. So the population the
Duplicate Displays tab exists for is exactly the population whose sales need a
human. That is the correct trade, and it is why the tab exists.

An inferred close records `detail.inferred` on its timeline entry and
`closedVia: "pos_sale_hub"`, so a human can always see it was reasoned rather
than observed.

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

Dry run on 2026-09-08: **460 rows to open** (marathon-pe 347, trophy 113) from
478 live slots — 48 tombstones skipped, 18 Pine slots skipped (booked at hub3,
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
* **Clothing and one-size partner refills.** They mint no display row — their
  size is the order's own and no human picks it, and a shoe-wall ledger full of
  t-shirts is not a wall walk. They keep the display-slot write they always had.
* **The existing Display Registry** (Hub 1 / Hub 2 tabs) and the **Display
  Records** cleanup tab (PR #575's register-vs-floor work). Both unchanged.
