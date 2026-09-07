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
