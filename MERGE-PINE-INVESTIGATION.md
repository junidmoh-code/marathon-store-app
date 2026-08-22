# Merge / Pine guard — investigation (2026-08-22)

Trigger: merging "Lacoste Audyssor White Gray" into "Lacoste Audysol White"
(745SFA000521G) is refused with

> Merge refused: a product holds stock at marathon-pine. Pine is out of scope
> for merges — resolve its Pine stock first.

Survivor holds Hub 1 · 17, Central · 16, Pine · 7, Hub 3 · −2. Loser holds Hub 1 · 13.

## a) Where the guard is

- `functions/lib/product-merge.cjs:55` — `const PINE_LOCATIONS = ["marathon-pine", "hub3"];`
- `functions/lib/product-merge.cjs:162-168` — the refusal loop, run after the
  per-location reads and before the update is built:

      for (const loc of PINE_LOCATIONS) {
        if (loserNodes[loc] || survivorCells[loc]) throw new MergeRefused("failed-precondition", …);
      }

- `functions/lib/product-merge.cjs:41-47` — the header paragraph that justifies it.
- `functions/test/product-merge.test.cjs:300-311` — the test that pins it.

**Where it came from.** It is a copy of the HEADWEAR one-size collapse scope
decision. The reasoning is recorded in `scripts/model-headwear-onesize-policy.mjs:40-51`:
Pine's cap cells were all qty 0, `lastType: "transfer_out"`, stamped by a
2026-08-01 reconciliation run — empty husks that would have built bogus
`/stock_targets` rows. So `SHOPS` there defaults to `marathon-pe` only. The same
"Pine is out of scope" phrasing was carried into `hubCleanupCore.js:10,21,30`
(display register / hub count, where hub3 is Pine's warehouse lane) and then into
the merge module. Nothing in the merge module's own history derives the exclusion
from anything a merge does.

**Note on the two locations.** In `/locations`, `marathon-pine` is labelled "Pine"
and `hub3` is labelled "Hub 3" (`src/components/stock/locations.js:34,38`). Both
are in `PINE_LOCATIONS`.

## b) Every condition that refuses a merge

Callable gate — `functions/productMerge/mergeProducts.js`:

| # | Line | Code | Condition |
|---|------|------|-----------|
| 1 | 29-31 | `unauthenticated` | no auth, or anonymous sign-in provider |
| 2 | 37-39 | `permission-denied` | `/users/{uid}.stockRole !== "admin"` and not the verified super-admin email |

Merge core — `functions/lib/product-merge.cjs`:

| # | Line | Code | Condition |
|---|------|------|-----------|
| 3 | 111-112 | `invalid-argument` | `loserId` / `survivorId` missing or blank |
| 4 | 113-115 | `invalid-argument` | either id is not a legal RTDB key (`/ . # $ [ ] whitespace`) |
| 5 | 116 | `invalid-argument` | `loserId === survivorId` |
| 6 | 117 | `invalid-argument` | no actor uid |
| 7 | 123 | `not-found` | loser `/products` record missing |
| 8 | 124 | `not-found` | survivor `/products` record missing |
| 9 | 125 | `failed-precondition` | loser already carries `mergedInto` |
| 10 | 126 | `failed-precondition` | survivor already carries `mergedInto` |
| 11 | 141-144 | `aborted` | a fresh `/product_merges_locks/{loserId}` lock is held (< 10 min old) |
| 12 | 150 | `failed-precondition` | `/locations` unreadable or empty — never guessed |
| 13 | **162-168** | `failed-precondition` | **the Pine guard — ANY node at `marathon-pine` or `hub3`, either party, even qty 0** |
| 14 | 330-338 | `aborted` | drift fence: a touched survivor cell's `qty` or `v` changed between the reads and the commit |

Nothing else refuses. There is no per-location condition other than #13, no
quantity condition, and no sign condition.

**Was the Hub 3 · −2 cell also a blocker?** Yes — independently. `hub3` is the
second entry in `PINE_LOCATIONS`, and the guard triggers on node *existence*, not
on quantity or sign. Removing `marathon-pine` alone would have left this merge
refused on Hub 3. Negative quantity plays no part: #13 is the only reason either
cell blocked.

## c) Does the guard protect anything real for merges?

**No.** A merge is location-agnostic by construction:

- Cells are read per location and each loser cell is added into the survivor's
  cell **at the same location and size** (`product-merge.cjs:175-186`). No path
  in this module ever writes a cell at a location other than the one it read from.
- The Pine-specific hazards that justified the exclusion elsewhere do not exist
  here. The headwear collapse **rewrote size keys** on Pine's zero-qty
  reconciliation husks, minting `/stock_targets` rows off phantom carriage. A
  merge rewrites no size keys and writes no targets.
- Pine's hub3 pairing (`scripts/sweep-shop-sneakers.mjs:39-52`) is keyed by
  *location*, not by product id, so it is unaffected by which record owns a cell.
- Negative cells already transfer with their sign intact (`product-merge.cjs:181`,
  `199-207` — `from`/`to` flip on sign and `qty` is `Math.abs`). No
  `applyMovement` change is needed, and there is an existing test at
  `functions/test/product-merge.test.cjs:243-252`.

The guard's stated worry — "skipping the Pine cells would leave stock stranded on
a hidden record" — describes a *skip*, which the merge never does. Applied to a
merge it is not a safety net; it is a refusal of the one operation that would
correctly join those cells.

Conclusion: safe to remove from the merge path. The headwear collapse scope
(`scripts/model-headwear-onesize-policy.mjs:99`) is untouched.

## Behaviour that changes at Pine as a side effect (flagged, not changed)

A merge deletes the loser's whole stock node at each location it holds, including
qty-0 cells (`product-merge.cjs:222-225`), and a qty-0 cell produces no survivor
cell. That is existing, deliberate behaviour at every location — zero cells arm
the refill engine, and a duplicate record should not arm demand. Removing the
guard extends it to Pine and hub3. It is uniform treatment, which is what a merge
is supposed to be, and the full before-state (including qty-0 cells and `_meta`)
is recorded under `/product_merges/{mergeId}` for reversal.
