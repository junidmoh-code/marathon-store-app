# The display marker is informational only

**Branch:** `fix/display-marker-informational` · off `origin/main` @ `9876524` (#574)

## The complaint

In the assistant / ordering product view, a size whose only remaining Hub 1
availability is a registered display pair was **marked amber and diverted**:
tapping it did not select the size, it opened a "Size N — on display / Request
display pair" panel instead.

That is wrong whenever the size has more than the display unit — and the amber
tier's own rule (`displayOnly(avail, units)`) fires on `avail <= units`, so a
cell reading 1 available with 1 slot registered blocked the size outright even
though the shelf may hold ordinary pairs the resolver has not caught up with.
More importantly it is wrong *in principle*: the marker's job is to tell an
assistant that a unit of this size is standing on a floor. It is not an
availability gate. Availability is `qty`, and it already has a gate (`sneakerOut`).

## COMMIT 1 — LOCATE

Everything below is on `src/App.jsx` unless named otherwise. Line numbers are as
of `9876524`.

### The flag, and the two readers built on it

| Line | What |
|---|---|
| `9527–9547` | `sneakerDisplayOnly(p, s)` — **the behavioural reader.** Returns `{ stores }` when `displayPairCore.displayOnly(available, d.units)` says the resolver's whole remaining Hub 1 count is display units. This is the amber tier and the divert. |
| `9554–9555` | `sneakerDisplayInfo(p, s)` — **the appearance reader.** Any available Hub-1-served size with a live slot. Drives the glyph only. Correct as it stands; kept. |
| `9086–9088` | `hub1DisplayUnits` — the `{ units, stores }` map both read, from `displayUnitsByCell(displaySlotsLive, "hub1")`. |

### Where `sneakerDisplayOnly` changed behaviour — every site

**Surface 1 — desktop hover quick-add grid** (`AssistantDesktop`)

| Line | Effect |
|---|---|
| `8381` | `const dOnly = … sneakerDisplayOnly?.(p, sz)` |
| `8404` | `title` → "Only the display pair remains at Hub 1 — tap to request it" |
| `8412` | amber `style` branch (border / background / colour) |
| `8425` | **onClick interception:** `if (dOnly) { openQv(p); setQvDisplayPrompt({…}); return; }` — never reaches `onQuickAdd` |
| `8437` | glyph stroke switched to amber `#FBBF24` |

**Surface 2 — desktop quick-view sheet** (`AssistantDesktop`)

| Line | Effect |
|---|---|
| `8008–8009` | state `qvDisplayPrompt` (the divert panel) and `qvDisplayPair` (the pull claim it mints) |
| `8107` | both cleared by `openQv` |
| `8619` | `const dOnly = … sneakerDisplayOnly?.(qv, sz)` |
| `8632` | amber `style` branch |
| `8640` | `if (qvDisplayPair) setQvDP(false)` on deselect |
| `8648` | **onClick interception:** `if (dOnly) { setQvNa(null); setQvDisplayPrompt({…}); return; }` — never reaches `setQvSize` |
| `8654` | `aria-label` "only the display pair remains" |
| `8657` | glyph stroke amber |
| `8666–8694` | the divert panel itself ("Request display pair" / "Cancel") |

**Surface 3 — phone size sheet** (`AssistantView`)

| Line | Effect |
|---|---|
| `9215` | state `displayPrompt` |
| `10800` | `const dispOnly = … sneakerDisplayOnly(selected, s)` |
| `10841` | **onClick interception:** `if (dispOnly) { setNaNote(null); setDisplayPrompt({…}); return; }` — never reaches `setPendingSize` |
| `10855` | amber `style` branch |
| `10859` | `aria-label` "only the display pair remains" |
| `10861` | glyph stroke amber |
| `10748–10776` | the divert panel itself |

**Surface 4 — the "not available, but these are" alternatives sheet**

| Line | Effect |
|---|---|
| `9645` | `return !sneakerOut(p, sz) && !sneakerDisplayOnly(p, sz);` — a display-marked size was **never offered as an alternative** |
| `9644` | `if (hub === "hub1" && !displayLaneReady) return false;` — a readiness gate that exists *only* to make that exclusion trustworthy |

**Prop plumbing:** `7990` (`AssistantDesktop` signature) and `10311` (the call site) pass `sneakerDisplayOnly` down.

### Is the flag read anywhere else that changes behaviour rather than appearance?

Yes — in exactly one place, and it is **not the marker**:

* `9900–9934` the checkout pre-flight, and `9001`/`pendingDisplayPullsByCell`,
  read `hub1DisplayUnits` to verify a cart line that **already carries
  `displayPairRequest: true`**, and to block a cell that a *pending pull order*
  has claimed. That is the display-**pair-pull contract** (#456), not the size
  marker. It fires on a line's own flag, never on "this size has a slot". Left
  alone.

And two places that are appearance only and stay: `sneakerDisplayInfo` (the
glyph) and the order-card `DISPLAY PAIR — it is ON THE DISPLAY` banner (`12483`).

`availabilityCore` does **not** subtract display units from availability
(its own header, lines 17–19, #324 "displays are hub stock") — so removing the
marker's gate leaves quantity as the single governor, which is the required
behaviour, with no second change needed.

### One consequence, stated plainly

The divert panel was the **only** minter of `pendingDisplayPair` / `qvDisplayPair`,
i.e. the only way a cart line on this screen ever got `displayPairRequest: true`.
Deleting the divert therefore means the ordering screen no longer mints a
display-**pull**. That is the owner's instruction (a marked size adds like any
other size; requests go through the "Request Display Partner" button, whose flow
is untouched).

Everything downstream of that flag — the allocation pin, the checkout pre-flight,
the warehouse "take it off the display" banner, the slot clear on placement, the
refill replay and the OOS reinstate — is **left standing, untouched**. It is the
contract orders already in flight are governed by, it is the write path this
change is explicitly fenced out of, and it is what the separate display
source-of-truth job will re-attach to.

---

## COMMIT 2 — WHAT SHIPPED

Every behavioural effect above is removed. A marked tile selects, adds, steps
and orders on the same code path and with the same styling as an unmarked one;
the glyph and its "this size is on a display" label are the whole difference.

`sneakerDisplayOnly` is deleted, and so is `displayPairCore.displayOnly` — the
marker rule itself. A dormant copy of a deleted rule is how the rule comes back.

**Stated accurately, because the first draft of these notes overstated it:** the
old predicate was `0 < available <= displayUnits`, so four units against one
registered slot did **not** divert. What did divert was every case where the
display units covered the whole remaining count — one unit with one slot, two
units with two slots — and, because `available` is the resolver's live remaining
number rather than the shelf count, a cell physically holding four also diverted
the moment three of them were promised or already in a cart. The size then
offered nothing at all, with a pair standing right there.

### The display-pair claim was deleted from the composer

`pendingDisplayPair`, `qvDisplayPair`, the `addToCart` branch that stamped
`displayPairRequest: true`, and `addDisplayPartner`'s third argument are all
gone. The divert was their only minter, cart state is in memory and never
persisted, and dead state on the **write** side re-arms silently — three
independent reviewers landed on the same call.

Everything on the **read** side stays and is pinned: the warehouse "take it off
the display" banner, the slot clear at placement, the refill replay, the
out-of-stock reinstate. Orders placed before this shipped still carry the flag
and are still governed by it. The checkout pre-flight stays too, for the same
reason in reverse — it can only *refuse*, never write, and the display
source-of-truth job that re-attaches a minter will want it standing on the day
it does.

### One defect fixed beyond the letter of the spec

The desktop quick-add (`quickAdd`) had a zero check and **no quantity clamp**, so
a stepper set to five against a cell holding one added five lines. It is
pre-existing — documented as a KNOWN GAP on 2026-09-05 and deliberately left —
but this change widens it: a display-only size used to divert into a request
that forced quantity 1, and now takes the ordinary path with the stepper live.
The worst case was five orders against one pair standing on a shop floor.

`quickAdd` now runs the same belt `addToCart` has always run (the resolver's own
remaining count, which already has the cart in it). The two surfaces agree, and
the stale KNOWN GAP comment is gone.

---

## KNOWN RESIDUALS — for the owner, not fixed here

These follow from the instruction, are fenced out of this change by it, and are
the substance of the separate display source-of-truth job.

### 1. A plain sale of the display pair leaves the slot standing

An ordinary cart line carries no flag, so placement runs no `clearDisplaySlot`
and `slotsAfterOrderExits` replays no exit. Sell the sole displayed size 9: the
cell goes to 0 and the tile is a plain ✕ (correct — the ✕ is authoritative), but
the `/settings/displaySlots` row survives. Receive an ordinary size 9 into Hub 1
later and the glyph returns, asserting a display that is not there. Reloading
does not fix it.

The app cannot know which physical pair a picker took off a shelf that holds
several. Closing this needs an explicit fulfilment event carrying the actual
source store — the source-of-truth job.

### 2. The warehouse is no longer told where the last pair is

When the last Hub 1 unit is physically on a shop's display, the order that asks
for it is now an ordinary one: `displayPairRequest: false`, no store, and no
"it is ON THE DISPLAY" banner. A picker who checks the shelf, finds it empty and
marks the line out of stock is the failure mode. Before, that one case diverted
into a flagged pull that carried the location.

This is the direct cost of "requests happen only via the Request Display Partner
button" and is worth the owner's explicit attention.

### 3. An ordinary order does not reserve the unit until it is Ready

Two assistants can each order the last unit; the first order is `incoming` and
nets nothing until it reaches ready status (the 20-minute promise lane). That is
how **every** sneaker size on this screen has always behaved — the display-only
size was the single exception, because its pull claim netted for 48 hours. The
spec's "governed by quantity alone, through the normal stock path" is exactly
this, so it is conformance, not regression. Named here because the exception
going away is a real change in behaviour for that one case.
