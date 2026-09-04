# Excess Inventory — why size 5.5 was carded as excess

Phase 1, read-only. Every number below was produced by running the SHIPPED
modules (`excessComputation.js`, `seatingCore.js`) over the LIVE database on
2026-09-04, in the exact context shape the screen builds — not by reading the
code and reasoning about it.

Product under investigation: **`p1779117430618` "New Balance 1000 Green White"**,
Hub 2. Live cells (`/stock/hub2/p1779117430618`, RTDB keys as stored):
`3:1, 4:1, 5:0, 5_5:1, 6:0, 7:2, 8:0, 9:1, 10:2, 11:1` — exactly the on-hand the
owner reported.

---

## 1. Which surface rendered the card

`src/components/stock/ExcessHubToCentral.jsx` — the Inventory Health
**"Excess Inventory"** tab (`HealthView.jsx`, `case "excess"`). Confirmed from
the component, not assumed:

* it is the only surface that calls `computeHubSneakerExcess`
  (`ExcessHubToCentral.jsx:113-116`), and that is the only function that cards a
  **hub** source for a **sneaker** product;
* the older `MoveExcess.jsx` (Stock → Move Excess) cannot be it twice over: it
  skips every non-clothing product (`MoveExcess.jsx:122`, `if (!isClothing(p))
  continue`) and it only judges cells that hold an **explicit** `/stock_targets`
  row (`MoveExcess.jsx:136`). `/stock_targets/hub2/p1779117430618` is `null`;
* no count/recount card offers a transfer at all.

The **deployed** bundle was checked too, not just the working tree:
`https://marathon-club.web.app/assets/index-vdlukYGN.js` contains
`computeHubExcess` and `resolveTarget` minified but expression-for-expression
identical to `main` (`git log` also shows `excessComputation.js` untouched since
#547). So live behaviour == the code in this repo.

## 2. Target for every size 3-13 at Hub 2, for this product

Resolved through `resolveTarget` in the shape the screen feeds it (see §4):

| size | resolved | level | armed? |
|---|---|---|---|
| 3 | 2 | category policy (`categoryPolicy/sneakers/hub2/sizes/3`) | armed, value 2 |
| 4 | 2 | category policy | armed, value 2 |
| 5 | 2 | category policy | armed, value 2 |
| **5.5** | **0** | category policy — **row says 2**, dead-size rule overrode it | armed, value WRONG |
| 6 | 0 | category policy, dead-size rule (genuinely 0 units network-wide) | armed, value 0 |
| 7 | 2 | category policy | armed, value 2 |
| 8 | 2 | category policy | armed, value 2 |
| 9 | 2 | category policy | armed, value 2 |
| 10 | 2 | category policy | armed, value 2 |
| 11 | 2 | category policy | armed, value 2 |
| 12, 13 | — | policy row exists at hub2, product declares no such size | no row found |

Nothing resolves from an explicit per-product row (there is none for this
product at any location), nor from the footwear rule or a size run — the
category policy answers first and wins.

## 3. Is Hub 2 armed? Yes.

`config/refillEngine/categoryPolicy/sneakers` (live):

* `perSize: true`
* `hub1`: `carriedOnly: true`, 10 size rows — `3,4,5,5_5,6,7,8,9,10,11`
* `hub2`: `carriedOnly: true`, 12 size rows — `3,4,5,5_5,6,7,8,9,10,11,12,13`

Size by size for this product, Hub 1 vs Hub 2, the answers are the same shape and
come from the same level; the only value differences are **owner-entered
policy**, not drift: sizes 7 and 8 keep 3 at Hub 1 and 2 at Hub 2, and Hub 2
additionally carries 12 and 13. (This product holds no Hub 1 cells at all, so
Hub 1 shows nothing for it — that is carriage, not arming.)

**The Hub 2 arm landed.** The 5.5 fault is not an arming gap; it is a key-shape
fault that hits Hub 1 and Hub 2 identically (§6 — 106 bad rows at Hub 1, 101 at
Hub 2).

## 4. The half-size key shape — where the two spellings meet

| where | shape for five-and-a-half |
|---|---|
| `/stock` cells (as stored) | `"5_5"` — `stockCellPath` → `stockSizeKey` (`src/utils/sizeKey.js:50`) |
| `/stock_targets` rows | `"5_5"` (encoded; `useStockTargets` does **not** decode) |
| category policy `sizes` map | `"5_5"` |
| `product.sizes` (catalogue) | `"5.5"` — raw, with the dot |
| **what the excess loop iterates** | **`"5.5"`** — `useStockCells()` DECODES every cell key on the way in (`useStock.js:81-90` `decodeByProduct`, used at `:99-102`) |

So the loop hands a **decoded** `"5.5"` into engine-keyed lookups, and one of
those lookups is not re-encoded consistently:

* `resolveTarget` re-encodes for the **row** lookup — `entry.sizes[engineSizeKey(size)]`
  (`seatingCore.js:204`) — so it *finds* the `5_5` row holding target 2. Good.
* `sizeUnitsAnywhere(stock, pid, size)` (`seatingCore.js:179-184`) also encodes
  the key — `k = engineSizeKey(size)` → `"5_5"` — but then indexes the **stock
  map it was given**, which the hook already decoded to `"5.5"`. The key misses.
  It reports **0 units of size 5.5 anywhere on the network**, while a cell
  holding 1 sits right there under the other spelling.

The policy screen's "5.5 carried by only some categories" is NOT involved: `5_5`
is present in both the hub1 and hub2 sneaker runs. Whole sizes are unaffected
because `engineSizeKey("3") === "3"` — encode and decode agree, and only a half
size (`digit_digit`) is rewritten by `decodeSizeKey`.

## 5. The line where a real target becomes 0

`src/components/stock/seatingCore.js:207`

```js
return shape(sizeUnitsAnywhere(stock, pid, size) > 0 ? row.target : 0, row.minQty, row.reorderPoint);
```

(the same dead-size rule again at `:215` for a uniform per-size policy).

The rule itself is correct — a size the network holds none of is targeted at 0 —
but it is being fed a falsified reading. For 5.5 the true answer is "1 unit at
Hub 2", the lookup says "none anywhere", so the branch returns **0** instead of
the row's **2**.

Then `src/components/stock/excessComputation.js:151`:

```js
const excess = onHand - t.target - reservedQty;   // 1 - 0 - 0 = 1
```

`t` is truthy and `t.source` is `"category_policy"`, so neither the unarmed
guard (`:146`) nor the explicit-row guard (`:147`) fires. A cell holding 1
against a Keep of 2 is carded for 1 unit of excess.

Traced end to end for the reported product, live:
`5.5 → resolveTarget = {target:0, minQty:1, reorderPoint:1, source:"category_policy"}
→ onHand 1, reserved 0 → excess 1 → one card row.`
Every other size of this product resolves its true Keep and emits nothing, so
today this product cards **1 unit (size 5.5)**, not 9. The 9-unit/7-size shape
the owner saw is what the screen shows when a product's carded sizes are *all*
half sizes; on this product only 5.5 is wrong. The defect and the fix are the
same either way.

## 6. Blast radius, right now, before the fix

Computed over the whole live `/stock`, both hubs, through the shipped modules:

| | Hub 1 | Hub 2 |
|---|---|---|
| products carded | 256 | 216 |
| size-rows carded | 467 | 414 |
| units offered | 972 | 1010 |
| **rows carded with target 0** | **106** | **101** |
| **units in those rows** | **217** | **225** |
| of those, rows that are a HALF size | 106 (100%) | 101 (100%) |

Every single zero-target row at both hubs is a half size: **207 rows, 442 units
carded by this bug alone.** Of those rows, **153 hold at-or-below their true
Keep (227 units)** — cards that must disappear completely. The remaining 54 rows
are genuinely above Keep but their offer is overstated by the Keep value.

## 7. Wrong moves already executed

`/stock_movements` where `reason == "excess_rebalance"`: 245 records overall
(the older Move Excess screen included). The new Hub → Central screen stamps
`exchc_` movement ids: **110 movements, 328 units, 2026-09-03T11:35:10Z →
2026-09-04T09:06:04Z.** Six of them touched a half size (15 units):

| movement id | product | size | units | from → to | when (UTC) | verdict |
|---|---|---|---|---|---|---|
| `exchc_mtlg7h6c_p1778234845372_5_5_hub2_central` | Dr. Martens Adrian Tassel Loafer Black | 5.5 | 4 | hub2 → central | 2026-09-03T11:35:12Z | already undone |
| `exchc_mtlg7mda_p1778234845372_5_5_central_hub2` | (the Undo of the row above) | 5.5 | 4 | central → hub2 | 2026-09-03T11:35:18Z | — |
| `exchc_mtljq100_p1778143219401_5_5_hub2_central` | Air Jordan 4 Retro Sylvester Red | 5.5 | 1 | hub2 → central | 2026-09-03T13:13:34Z | **all 1 wrong** |
| `exchc_mtlkipxs_p1778142338746_5_5_hub2_central` | Adidas Campus Black White | 5.5 | 3 | hub2 → central | 2026-09-03T13:35:54Z | **2 of 3 wrong** |
| `exchc_mtlknwxo_p1777974765700_5_5_hub2_central` | Adidas Samba White Core Black | 5.5 | 2 | hub2 → central | 2026-09-03T13:39:55Z | **all 2 wrong** |
| `exchc_mtlkq8ly_p1778144026228_5_5_hub2_central` | Adidas Samba Classic Black White | 5.5 | 1 | hub2 → central | 2026-09-03T13:41:44Z | **all 1 wrong** |

Verdict method: Hub 2 Keep for 5.5 is 2. Each of those four cells still carries
the `exchc_` movement as its `mv`/`lastType`, so nothing has touched them since
and the pre-move on-hand is exactly `0 + units moved`. Correct excess would have
been `max(0, before - 2)`; everything above that was taken below Keep.

**6 units across 4 products to reverse** (Campus keeps 1 — it was genuinely one
unit above Keep). Every non-half-size `exchc_` move resolved its true Keep and
is left alone.

---

### What Phase 2 must therefore fix

Not the arm (it landed), and not the dead-size rule (it is right). The fault is
that one lookup asks a decoded map an encoded question. The normalisation
belongs in ONE shared helper on the seating/target path, so targets, cells, the
size run and the excess loop cannot disagree again — plus explicit invariant
guards in the excess loop, so even a future bad target can never card a cell at
or below its Keep, and a kill switch that hides every card with one RTDB write.
