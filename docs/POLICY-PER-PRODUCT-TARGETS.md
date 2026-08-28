# Per-product targets and per-size arming — findings

Read-only investigation, 2026-08-28, against **live** RTDB
(`marathon-club-default-rtdb.europe-west1`). Nothing in this commit changes
behaviour. Every claim below is either a `file:line` or a number this
investigation measured; where the brief and reality disagree, reality wins and
the disagreement is named.

---

## 1. Where an explicit per-product target row lives, and its exact shape

`/stock_targets/{loc}/{pid}/{encodedSizeKey}` — read by the engine at
`functions/lib/refill-engine.cjs:496`:

```js
const explicit = targets?.[dest]?.[pid]?.[encodeSizeKey(size)];
```

Shape actually honoured (`refill-engine.cjs:497-509`):

| field | required | meaning |
|---|---|---|
| `target` | yes — the branch is entered on `typeof explicit.target === "number"` | units to keep |
| `minQty` | read through `num()` (garbage → 0) | top-up floor |
| `reorderPoint` | optional; **not** `num()` — a non-number becomes `null`, and `0` survives | ask only at/below this on hand |

Anything else on the row is provenance and the engine ignores it. Writers add
their own: `source`, `batchId`, `approvedBy`, `approvedAt` (Decision Queue),
`source`/`offAt`/`offBy`/`prevRow`/`prevAbsent` (Seating switch-off).

The **live rule** on that node requires `target` and `minQty` to be present and
numeric (seatingStore.js:198 records the check against `/.settings/rules.json`,
2026-08-24). Admin-SDK scripts bypass it, so shapes that the rule would refuse
do exist on the node.

Size keys are the **stored** form: `5.5` is `5_5` (`encodeSizeKey`,
refill-engine.cjs:31); one-size is `_`.

## 2. Does `resolveTarget` already honour a NON-ZERO explicit row?

**Yes — proven, not assumed.** Run against the real engine export:

```
explicit {target:9} vs category policy {target:2}  → {"target":9,…,"source":"explicit"}
explicit {target:0} vs category policy {target:2}  → {"target":0,…,"source":"explicit"}
```

The branch is unconditional on the value: any numeric `target`, zero or not,
returns before the category policy is consulted (`refill-engine.cjs:496-510`).
**No functions change is required to make per-product targets work** — the
mechanism has always been there. (A functions change *is* made in this branch,
but for preview/history/validation of the new write path, not for resolution.)

Precedence, as shipped: explicit row → category policy (`:513`) → footwear rule
(`:537`) → clothing kill switch (`:561`) → subcategory run → size run.
`storeCarries` gates only the last two branches.

## 3. How `NoTargetQueue` writes the row, and how it deletes it

- **Writes** — `saveTargets` (NoTargetQueue.jsx:289) writes
  `{target, minQty: ceil(t/2), source:"manual", batchId:"decision-queue",
  approvedBy:"decision-queue", approvedAt}` per size, per enabled location.
- **Off switch** — `excludeHere` (NoTargetQueue.jsx:333) writes the same shape
  with `target:0, minQty:0, source:"excluded"`.
- **Deletes** — it never does. There is no delete path in that file.
- Both iterate `card.sizes`, which are **cell** sizes, so a declared size with
  no cell is left armed. That gap is documented at seatingStore.js:23 and is why
  Seating uses `seatingSizes()` (the full union) instead.

This branch does **not** touch NoTargetQueue.

## 4. How Re-seat clears the row

`reseatPlan` / `reseat` (seatingStore.js:206-247). It touches **only** rows
stamped `source === "seating_off"`, and it does not delete them blindly:

- `prevAbsent === true` → write `null` (a real delete).
- `prevRow` present and rule-writable → restore that exact row.
- `prevRow` missing or a shape the live rule would refuse → reported as *stuck*
  and left alone.

So "clear" is already **restore-what-was-there**, not "delete". That matters for
the brief's wording — see §8.

## 5. What the arming tab writes today, given its single quantity

It writes a **category** entry at
`/config/refillEngine/categoryPolicy/{categoryKey}`, not per-product rows:

```jsonc
{ "perSize": true?, "<loc>": { "target": N, "minQty": N, "reorderPoint": N? } }
```

One aggregate row per location. Per-size is possible in the data model
(`{"<loc>":{"sizes":{…}}}`) and in the server validator, but the **UI gate**
that offers it is:

```js
// EnginePolicyCard.jsx:967
const canPerSize = c.perSize && sizeRun.length > 0;   // c.perSize = the STORED entry's flag
```

`c.perSize` comes from the census as `effEntry?.perSize === true`
(category-policy-write.cjs:546). A category that has never been armed per-size
has no entry, so `c.perSize` is `false`, so the "Size by size" button is never
rendered — **the reported defect, reproduced.**

### …and the defect is worse than "only one quantity"

`perSize` is not a shape marker. For a **uniform** leg it decides *which cells
the one number governs* (`refill-engine.cjs:479-495`):

- `perSize` absent → the leg speaks for the `"_"` cell **only**; every letter
  size falls through.
- `perSize: true` → the leg speaks for every declared catalogue size.

Measured against the real engine with a soccer-jersey-shaped product:

```
policy {trophy:{target:3}}                → S null   M null   L null      ← arms NOTHING
policy {perSize:true, trophy:{target:3}}  → S 3      M 0      L 0
policy {perSize:true, trophy:{sizes:{…}}} → S 2      M 0      L null
```

So today, arming a sized category from the card with its "single general
quantity" writes an entry that resolves **nothing at all** for that category's
real sizes. It is not merely coarse; it is silently inert. (The `M 0` / `L 0`
above are the dead-size rule: a size with zero units anywhere resolves an
explicit stop, and arms itself when real units arrive.)

## 6. Live size runs per category — measured, not assumed

Read-only census over `/products` (4,533 records), `/stock/*`,
`/stock_targets/*`, `/settings/productTaxonomy`, using the shipped
`sizeRunForCategory`. Destinations live today: `hub1, hub2, marathon-pe, trophy`
(all mode `live`).

| category | products | registry | derived run | outside the run |
|---|---|---|---|---|
| sneakers | 1242 | list 3–13 (+5.5) | 3 4 5 5.5 6 7 8 9 10 11 12 13 | S, XXL, 6.5 |
| soccer-boots | 80 | list 3–13 (+5.5) | 3 4 5 5.5 6 7 8 9 10 11 | — |
| slides | 51 | list 3–13 (+5.5) | 3 4 5 5.5 6 7 8 9 10 11 | — |
| designer-shoes | 4 | list 3–11 (+5.5) | 3 4 5 6 7 8 9 10 11 | — |
| **kids-shoes** | **0** | list 26–33 | **(empty)** | — |
| boots / loafers / running-shoes | **0** each | list 3–13 | **(empty)** | — |
| soccer-jerseys | 189 | list S–XXXL | S M L XL XXL XXXL | 4XL |
| t-shirts / hoodies / pants / … | — | list S–XXXL | S M L XL XXL XXXL | 4XL |
| fitted-caps | 97 | list 55–63 | 55 56 57 58 59 60 61 62 63 | letters, 28 |
| bags, belts, caps-beanies, perfumes, watches, sunglasses | — | **one** `["_"]` | (empty, `oneSize`) | legacy letter cells |

### Where the brief is wrong, and what this builds against instead

1. **"Adult footwear size run is 3-11 plus 5.5 only."** Not in this catalogue.
   The registry declares 3–13 for sneakers, boots, loafers, running-shoes,
   slides and soccer-boots, and sneakers really do declare/stock/row 12 and 13.
   designer-shoes is the only footwear category registered 3–11. The editor
   therefore derives the run **per category** and never assumes 3–11.
2. **"KIDS SHOES USE A DIFFERENT RUN (26-33 in this catalogue)."** The
   *registry* says 26–33; the *catalogue* holds **zero kids-shoes products**, so
   the derived run is empty and the shipped code treats an empty run as a STOP.
   Arming kids-shoes with adult numbers would indeed arm nothing — but so would
   arming it with kids numbers, because there is nothing to arm. This build
   makes the registry run the editor's fallback when live data is silent, so the
   group is armable ahead of the first delivery, and says so on screen.
3. **"Hub 1 sneaker policy currently armed … Hub 1 only; Hub 2 has no policy."**
   Correct, and confirmed byte-for-byte:
   `categoryPolicy.sneakers = {perSize:true, hub1:{carriedOnly:true, sizes:{3:2,
   4:2, 5:2, 5_5:2, 6:3, 7:3, 8:3, 9:2, 10:2, 11:2}, reorderPoint 1 on every
   size}}`. Note the **separate** disarmed `policyGroups.footwear-all` policy,
   which carries *different* numbers (7=2, 8=2, 11=1) for hub1 **and** hub2. It
   governs nothing: `armed: false`, and `sneakers` has its own entry, which
   beats a group unconditionally.
4. **"Consolidated category 'Sneakers' covers boots, designer shoes, kids
   shoes, loafers, running shoes, slides, sneakers."** Correct — that is
   `policyGroups.footwear-all`, label "Sneakers", `armed: false`. Soccer boots
   are excluded, as stated. Three of its seven members hold no products.
5. **"Clothing runs S-XXXL."** Correct as the registered run. 4XL exists in live
   data for most clothing categories and is reported as *outside the run* — it
   refills off its own explicit rows and is edited there.
6. **"The existing off switch is NoTargetQueue.jsx:325."** The line is 333 in
   this revision (`excludeHere`); the mechanism is exactly as described.
7. **One-size is real and must not grow a fake grid.** Six live categories are
   registry one-size; their derived run is empty with `oneSize: true`, which is
   a *different* answer from "no run could be worked out" and is already
   distinguished in `sizeRunForCategory`.

## 7. Armed today (unchanged by this branch)

`categoryPolicy`: bags, belts, caps-beanies, fitted-caps, gloves, perfumes,
sneakers. `policyGroups`: `footwear-all` only, disarmed.

## 8. One deliberate deviation from the brief

> "Clear override and Re-seat become the same action: delete the rows."

They become **one action, one code path, one button** — but the action restores
provenance rather than deleting blindly. A row this card wrote carries the row
it replaced (`prevRow` / `prevAbsent`); clearing restores exactly that, which
for a row created by this card *is* a delete, and for a row that replaced a
hand-made one puts the hand-made numbers back. Deleting unconditionally would
destroy part of the 7,797 hand-made rows that are the source of truth for the
products carrying them. Where the editor is asked to remove a row it did not
write, it says whose numbers they are and asks first, and the removal is
recorded in the policy history with the full previous row, so one tap puts it
back.

## 9. No `database.rules.json` change is needed

Every write this branch adds goes through the `setCategoryPolicy` callable
(Admin SDK), which is already the writer for `/stock_targets` row edits
(`setRows`) and for `/engine_policy_history`. No new client-visible path is
introduced. The console rule this card has always owed (an `.indexOn: ["at"]`
on `/engine_policy_history`) is unchanged and still owed.
