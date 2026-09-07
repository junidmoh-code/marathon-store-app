# The duplicate display marker — where it comes from

Investigation, 7 September 2026. Symptom on the owner's screenshot: **Diesel Big
D Green Orange** carries the small monitor glyph on **both size 6 and size 8** in
the assistant/ordering size grid. One product, one display, two markers.

All figures below were read live off `marathon-club-default-rtdb` with
`scripts/census-display-marker-sources.mjs` (read-only, zero writes).

---

## 1. Where the glyph is drawn — three render sites, one data map

| # | File : line | Surface |
|---|---|---|
| 1 | `src/App.jsx:8434` | Hover size grid (`ad-sz` chips) — 7×7 SVG, `aria-hidden` |
| 2 | `src/App.jsx:8649-8650` | Quick-view size chips — 8×8 SVG |
| 3 | `src/App.jsx:10760-10761` | Phone order sheet size chips — 9×9 SVG |

All three read the same two derived values, and nothing else:

* `sneakerDisplayInfo(p, s)` — `src/App.jsx:9469` — the **quiet tier** (glyph, no
  tint) on any available size that is on a display.
* `sneakerDisplayOnly(p, s)` — `src/App.jsx:9442` — the **amber tier** (glyph +
  amber chip + "Request display pair" prompt) when the display pair is the last
  availability.

Both index the single map

```
hub1DisplayUnits   src/App.jsx:9056
  = displayUnitsByCell(displaySlots, "hub1", hub1DisplayRegister)
    src/components/stock/displayPairCore.js:68
```

## 2. The two RTDB paths that map reads

`displayUnitsByCell` was deliberately built with **two** sources (comment block,
`displayPairCore.js:44-67`):

| Source | Path | Subscribed at | Shape | Lifecycle |
|---|---|---|---|---|
| **A — slots** | `/settings/displaySlots/{store}/{productId}` | `App.jsx:9037` via `useDisplaySlotsState` | one record per product **per store**, `{size, sizeKey, bookedHub, source, at}` | **current state.** Set at registration, **replaced** on a display refill, **tombstoned** (`sizeKey: null`) when the display sells |
| **B — the register** | `/settings/hubSneakerCount/register/hub1/{pid}__{sizeKey}` | `App.jsx:9044` via `useDisplayRegisterState` | one row per product **per size**, `{qty, size, sizeKey, at, bumps}` | **write-only-upward history.** Never replaced, never decremented on a sale, key includes the size so a new size is a NEW row |

The legacy `/settings/displayRegister` node that PR #324 orphaned is **not** one
of them — see §6.

## 3. Source B is the entire bug

The register is keyed `pid__sizeKey`. A display that changes size does not
overwrite its row — it gets a **second** row. `displayUnitsByCell`'s double-count
guard subtracts live slots from register qty **within one cell key**
(`displayPairCore.js:86-88`), and two different sizes are two different keys, so
the guard never fires across a size change. Both rows survive. Both draw a glyph.

**Diesel Big D Green Orange (`p1778150021679`), live payloads:**

```
SLOT  marathon-pe  { size: "6", sizeKey: "6", bookedHub: "hub1",
                     source: "display_refill", orderId: "206",
                     at: "2026-09-05T11:40:12.985Z" }          ← the real display

REG   p1778150021679__8 { qty: 1, size: "8", sizeKey: "8",
                     movementId: "dispreg_hub1_p1778150021679_8",
                     styleCodeFrom: "label_alias",
                     at: "2026-08-22T10:41:40.893Z" }          ← the ghost
```

Registered at size 8 on 22 Aug. Replaced on 5 Sep by a display refill that
correctly moved the slot to size 6. The size-8 register row was never touched,
because nothing decrements it. Marker on 6 **and** 8.

Twenty further products with 2+ markers show the identical shape — slot moved by
a `display_refill`, register row stranded at the old size. Full payload dump:
`scripts/census-display-marker-sources.mjs`. Samples:

| Product | Slot (truth) | Stranded register row |
|---|---|---|
| Nike AF1 Low CPFM Moss `p1777896002434` | 8, `display_refill`, 2026-09-05 | `__7`, 2026-08-07 |
| Nike AF1 Low CPFM White Red `p1777896054649` | 9, `display_refill`, 2026-08-29 | `__6`, 2026-08-07 |
| Nike AF1 White Black `p1777896597672` | 6, `display_refill`, 2026-09-06 | `__10`, 2026-08-07 |
| Nike Zoom Alphafly Next% Green `p1777906110799` | 9, `display_refill`, 2026-09-06 | `__8`, 2026-08-07 |

## 4. Is anything still being written?

**Yes — the register is live and growing.**

* newest register row: **`2026-09-07T08:27:33.458Z`** (today) —
  `p1787218274779__6`, "Supreme x Nike air force 1 purple",
  `via: "display_registration_card"`
* register rows carrying a timestamp **after 2026-08-06: 556 of 556.** The whole
  node post-dates PR #324; it is a *newer* record, not #324's leftover.
* newest slot write: `2026-09-07T09:19:48.838Z` (today).

## 5. Every writer to source B still in this repo

All in `src/components/stock/hubCleanupStore.js` — the **Display Registration
card**, which is the register's legitimate home:

| Line | Function | Write |
|---|---|---|
| `hubCleanupStore.js:201, 356` | `registerDisplayUnit` | creates `{pid}__{sizeKey}` (create-once transaction) |
| `hubCleanupStore.js:381, 411` | `addExtraDisplayUnit` | bumps `qty` / `bumps` on an existing row |
| `hubCleanupStore.js:125` | `loadRegister` | read |

Other readers of the register, **both legitimate and left alone**:

* `src/components/stock/DisplayRegistrationView.jsx:57` — the card's own list.
* `src/components/stock/offShelf.js:14` — the hub count's "booked here, standing
  on a floor" evidence.

`registerDisplayPair` and `/settings/displayRegister` have **no writer anywhere
in this repo** — grep returns only test files and the comment in
`docs/COUNT-INTEGRITY.md`. PR #324's removal held.

## 6. The legacy node PR #324 orphaned

`/settings/displayRegister` still exists in production:

```
marathon-pe    94 entries
marathon-pine  14 entries
trophy         23 entries
              131 total
newest entry:  2026-08-06T08:58:55.890Z      ← the day PR #324 landed
```

Entries carry `{orderId, productId, productName, size, source:
"display_partner_send", registeredAt, registeredBy, photoUrl}`.

**Dead data.** Nothing in this repo reads or writes it, and nothing has written
it since 6 Aug 2026. Safe to delete by hand in the console — it is not the cause
of the reported bug and deleting it changes nothing on screen.

## 7. The counts

| Measure | Live value |
|---|---|
| Register rows (hub1) | 556 (547 with `qty > 0`) |
| Live display slots | 467 — hub1 **243**, hub2 206, hub3 18 |
| Tombstoned (sold/cleared) slots | 42 |
| **Marked cells drawn today** (slots + register) | **610** |
| **Products carrying 2+ display markers today** | **51** of 555 |
| Register rows whose pid has **no** live hub1 slot | 315 |
| Register rows whose live slot is the **same** size (redundant) | 180 |
| Register rows whose live slot is a **different** size (**ghost**) | **52** |
| Marked cells if the marker reads **slots only** | 243 |
| **Products with 2+ markers if the marker reads slots only** | **0** |

## 8. The verdict

The register cannot be made to replace. Its key *is* the size, it is a
stock-integrity high-water record that the hub count depends on, and decrementing
it on a sale would corrupt the count it exists to protect. So it cannot be the
marker's source.

The slot already is everything the marker needs and the register is not:

* **one slot per product per store** — a replacement overwrites the record, so
  accumulation is impossible *by construction*, not by cleanup;
* it carries the size captured at **send** time (`sentSize` → `displayRefillSize`
  → `setDisplaySlot`, `App.jsx:11917`);
* it **clears itself** when the display sells (`clearDisplaySlot`,
  `App.jsx:9982`), and reinstates on a failed pull (`App.jsx:11512`);
* it names the store, which the request flow needs anyway.

**The marker reads the slot and nothing else.** 51 products stop lying today; 315
store-less legacy register rows stop drawing an unverifiable glyph that nothing
in the system could ever have cleared.
