# Seating discrepancies — investigation + the fix (2026-08-24)

Trigger, from the owner:

> Lacoste tracksuits light gray s-99068 seeded at Marathon but the stock is in
> Trophy. And Essentials tracksuit black:#669 seeded at Trophy and Marathon —
> it should have been only seeded at Marathon, no stock exists at Trophy.

Two instances of one bug class. This document is what "seeded" means in this
database, every route that can seed a location, why neither case was fixable
from any screen, and what now exists to fix them.

---

## a) What "seeded" is, exactly

There is no `seeded` field anywhere. **A location is seated for a product when
the node `/stock/{loc}/{productId}/{size}` EXISTS — regardless of its quantity.**
The refill engine says so in one function, and it is the only definition that
matters because it is the one that spends money:

```js
// functions/lib/refill-engine.cjs:202
// Store carries a product if the stock node exists (regardless of qty).
function storeCarries(stock, loc, pid) {
  return !!stock?.[loc]?.[pid] && Object.keys(stock[loc][pid]).length > 0;
}
```

`storeCarries` gates `managedPids(dest)` (`refill-engine.cjs:1037-1055`), which
is the set of products the engine will resolve targets for and raise refills
against at that destination. So a bare cell — `qty: 0`, no history, nothing
behind it — is a standing instruction: *this shop stocks this product, keep it
filled.*

Two properties turn that into the reported symptom:

1. **Seating is created by a dozen routes** (below), several of them incidental
   to some other action.
2. **Nothing has ever deleted a cell.** `applyMovement` writes `qty`; it has no
   delete path, and the comment above `storeCarries` states the consequence
   plainly — *"Zero-qty cells persist indefinitely."* Seating was create-only.

## b) Every route that seats a location

| # | Route | Code | Shape it leaves |
|---|---|---|---|
| 1 | **Health → Missing Products → "Solve"** | `NetworkTransfer.jsx:410` | `{qty:0, v:0, mv:"seed", lastType:"count", state:"live"}` |
| 2 | **Count session, counting a size as zero** | `CountSession.jsx:79` → `setCellState` | same seed shape (`applyMovement.js:219`) |
| 3 | **Product-add / edit receive** | `App.jsx:5948` → `setCellState` | same seed shape |
| 4 | **Any movement *into* the location** | `applyMovement` | a real cell; **survives at 0** after it drains |
| 5 | **Counted tab → "Move"** | `CountedStockReview.jsx` (before this change) | transfers the units, **leaves the source cell at 0** |
| 6 | **Set Qty** typed at the wrong location, then corrected to 0 | `SetQuantity.jsx` | a real cell at 0 |

Routes 4, 5 and 6 are the quiet ones: nobody "seeded" anything, they moved or
sold stock, and the claim is the residue.

### Route 1 is the prime suspect, and it prefers Marathon PE

The Solve button seeds `qty: 0` carriage cells so the engine will start
refilling a stranded product. Its destination is chosen for the operator:

```js
// NetworkTransfer.jsx:30
const STORES = ["marathon-pe", "trophy"];
// NetworkTransfer.jsx:379
const defaultStoreFor = (card) => STORES.find((s) => qualifyingSizes(card, s).length > 0) || STORES[0];
```

With a symmetric refill policy — the normal case — both stores qualify, so
`.find` returns the first: **Marathon PE, always.** One tap on a row whose stock
is really at Trophy seats Marathon PE and nothing says otherwise afterwards.

And for a **central-stranded** product it seats *two* locations at once:

```js
// solvePlan.js:57
export function seedLocations(source, store) {
  return source === "central" ? ["hub2", store] : [store];
}
```

So one Solve on the Essentials tracksuit seats Hub 2 **and** a store; a second
Solve on the same product with the other store chosen (or an earlier
transfer that later drained, route 4) seats both stores. That is the
"seeded at Trophy and Marathon" shape.

**This has happened before and is on record.** `solveUndo.js:3-5`:

> Born from a real incident (2026-08-13): a Louis Vuitton bag solved to
> Marathon PE by mistake, reversed by hand with precisely these guards — this
> makes that reversal a button.

An undo exists for it. It is **session-scoped** by deliberate design
(`solveUndo.js:31-36`): it lives in HealthView's React state and dies when you
leave Inventory Health. Both products reported here are older than the session
that seated them, so that undo was never reachable for either.

## c) Why neither case was fixable from any screen

The claim was **writable from six routes and visible from none**:

- **Counted tab** built one card per product×location, then dropped it unless a
  size held a quantity: `if (!countedSizes.length) continue`
  (`CountedStockReview.jsx`, before this change). A seating with no stock is by
  definition all zeros, so it was filtered out of the one screen built to review
  cells.
- **Where is it (Locator)** drops any location whose sizes all read 0:
  `.filter(x => Object.values(x.sizeMap).some(n => n !== 0))` (`Locator.jsx:47`).
- **Health → Missing Products** shows the *opposite* condition (stranded
  upstream, missing downstream) — a wrongly-seated product looks handled there.
- **Counted tab → Move** transferred the units and left the source cell sitting
  at 0. The stock went to Trophy; the seating stayed at Marathon PE, which went
  on being refilled. **That is a copy, not a move** — and it is very likely how
  at least one of these two products came to be seated in both shops.

So the honest summary of "how did this happen": *a one-tap action seeded the
default store, or a move copied the seating instead of relocating it, and then
nothing in the app could show you either.*

## d) Reading the two reported products off the live data

The forensics are per-cell and need no tooling — read
`/stock/marathon-pe/{pid}` and `/stock/trophy/{pid}` and compare each cell:

| Cell reads | What seated it |
|---|---|
| `mv:"seed"`, `v:0`, `lastType:"count"` | Route 1, 2 or 3 — a direct seed, **no ledger row exists**. `updatedBy` is the uid, `updatedAt` the timestamp. |
| `mv:"<movement id>"`, `v>0` | Routes 4–6 — a real movement. Look the id up in `/stock_movements/{mv}`: its `type`, `actor`, `ts`, `from`/`to` and `before`/`after` name exactly who moved what, when. |
| `qty:0` with `lastType:"transfer_out"` | Stock left and the claim stayed — route 4 or the old Move (route 5). |

For the Essentials tracksuit specifically, check whether Hub 2 is also seated:
if it is, and the Trophy/Marathon cells carry `mv:"seed"`, that is Solve on a
central-stranded card (`seedLocations` seats hub2 + a store) and the second
store came from a separate tap or an earlier drained transfer.

Note the size key: `#` is illegal in an RTDB key and is encoded to `_`
(`src/utils/sizeKey.js`), so "black:#669" keys as `black:_669`.

**No live database read was available from this session**, so the table above is
the recipe rather than the answer for those two specific products. The Counted
tab's new *Seated, no stock* view (below) now answers it on screen in one tap,
for these two and for every other case in the network.

---

## e) What was built

### 1. The seating is visible — Stock → **Counted** → *Seated, no stock*

The Counted tab now has two views. *Has stock* is exactly what it always was —
unchanged, and still the default. *Seated, no stock* lists every product×location
claim with nothing behind it: the products a shop is on the hook to be refilled
for but holds none of. The toggle carries a count, so the size of the mess is
visible before you go looking. Search, the location chips and the category chips
all work the same in both views.

### 2. **Unseat** — remove one location's seating for one product

On a seated-but-empty row. Deletes the empty `/stock` cells at that location, so
`storeCarries` goes false and the engine stops managing the product there.

- **It can never remove stock.** Any size holding a non-zero quantity blocks the
  whole gesture with a readable sentence pointing at Move or Clear — both of
  which are reversible ledger movements. A negative cell (a broken balance)
  blocks too; that is evidence, not an empty claim.
- **It refuses under a live refill.** If the engine already has an open lock on a
  size being removed, the panel names the order and tells you to reject it in the
  queue first — deleting a cell under a live intent would orphan the lock.
- **It cannot lose a race.** Each cell is deleted through its own guarded
  transaction: a sale, count or transfer landing between the preview and the tap
  makes that cell abort and survive, and the toast says how many stayed. This is
  the TOCTOU guard `solveUndo` was fixed for (PR #361), widened to cells a Solve
  did not write.
- **It is audited.** A cell delete leaves no `/stock_movements` row — it is the
  one stock-shaped action the ledger structurally cannot record — so each gesture
  writes `/settings/carriageLog/{id}` (`action, loc, pid, name, sizes, at, by`).

### 3. **Move** now moves the seating, not just the units

The Move panel gained two things:

- **Per-size units.** Blank moves all of that size (the common case, no typing);
  a number moves exactly that many. This is the "quantity moves automatically, or
  we move it manually" the owner asked for.
- **"Move the seating too"**, ticked by default. The destination is seated for
  every size (including sizes with no units to send — a seated-but-empty product
  can now be relocated at all, where the old Move dead-ended with "nothing to
  move"), and every source cell that ends at 0 is deleted. **The source stops
  carrying the product.** Untick it for the real case it serves: splitting stock
  across two shops that should both carry it.

Ordering is fixed and load-bearing — transfer, then seat, then unseat. A failed
transfer stops the unseat and says so: the units are still at the source, so its
claim is still correct and must stay. A **partly**-moved size keeps its seating,
because the source genuinely still stocks it; the panel says so before you tap.

## f) What this does NOT change

- **No security-rules deploy.** `/stock/$loc/$pid/$size` `.write` is already
  "signed in and has a `stockRole`", and RTDB does not evaluate `.validate` on a
  delete (`newData` is null). This is the same door `solveUndo` already deletes
  through in production. The audit log lives under `/settings`, whose live rule
  already grants non-anonymous write (the node `missingProductsHidden`,
  `stockHold` and `displaySlots` share).
- **No functions deploy.** `storeCarries` reads node presence; deleting the node
  is the change, and it is true the moment it is written. (A `carried:false`
  field would have needed a deploy, and until it landed the engine would have
  kept refilling a shop the UI showed as unseated.)
- **No product, barcode or ledger change.** Unseat touches empty cells only.
- **The counting view is unchanged** — same rows, same counts, same default.
  Pinned by a render test.

## g) Where it lives

| File | What |
|---|---|
| `src/components/stock/carriageCore.js` | Pure: classification, unseat plan + blockers, the transaction decision, move plan, audit entry |
| `src/components/stock/carriageStore.js` | The writes: guarded per-cell deletes, seed-if-absent, the audit row, the move sequence |
| `src/components/stock/CountedStockReview.jsx` | The two views, the Unseat confirm, the extended Move panel |
| `src/components/stock/carriageCore.test.js` | 32 tests — every guard |
| `src/components/stock/countedCarriage.render.test.jsx` | 11 tests — the wiring, incl. the counting-view regression guard |

## h) Worth deciding separately

These are causes this change does not remove, only makes correctable:

1. **Solve still defaults to Marathon PE** (`STORES[0]`) whenever both stores
   qualify. Every symmetric-policy Solve seats Marathon PE unless the operator
   changes the chip. Options: no default (force a choice), or default to the
   store that already holds stock of the product.
2. **The Solve undo is still session-scoped.** With the carriage log now written,
   a durable undo has a node to read from — the objection recorded in
   `solveUndo.js:31-36` (a whole-tree seed scan) no longer applies.
3. **`/stock_targets` is a second, independent kind of seating.**
   `introduceExistingCore.js` writes explicit target rows flat at
   `marathon-pe`, `trophy` and `hub2`, and an explicit row **outranks the kill
   switch and the size run** (`solvePlan.js:96-118`). Unseating a `/stock` cell
   does not remove a `/stock_targets` row. If either reported product still gets
   refilled at the unseated shop after this, that row is why — and it needs the
   same treatment.
