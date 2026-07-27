# Deploy Tracker — live-behaviour findings that outlive their investigation

Findings about how the LIVE system behaves that are not obvious from the code, and
that would cost something real if a future change forgot them. One entry per
finding: what's true, why it's true, and what a change would have to do first.

This is a notes file, not a runbook — except for the deploy-scoping rule below,
which IS binding. `DEPLOY.md` is stale; it predates the multi-site hosting split.

---

## ⚠️ ALWAYS SCOPE A FUNCTIONS DEPLOY — a bare `--only functions` offers to delete the POS app's functions

**Rule: never run `firebase deploy --only functions`. Always name the function:**

```bash
firebase deploy --only functions:<functionName>
```

### Why — two repos, one Firebase project

`.firebaserc` here pins project **`marathon-club`**, and `firebase.json` declares
`functions` source `functions/` under codebase `default`. **marathon-pos-app is a
SEPARATE repo that deploys into the SAME project and the SAME `default` codebase.**
Neither repo's source contains the other's functions.

The Firebase CLI treats "in the project but not in my local source" as *deleted*.
A bare `--only functions` therefore lists the other repo's functions for removal
and asks to proceed. It is a prompt, not a silent wipe — but `--force`, a CI run,
or one reflexive `y` destroys them.

### Measured 2026-07-27 — exactly what is at risk

25 functions live in `marathon-club`. The runtime is a clean discriminator:
**17 × nodejs22 = this repo. 8 × nodejs20 = marathon-pos-app.**

A bare `--only functions` from this repo would offer to delete all 8:

| Function | Trigger | Why it hurts |
|---|---|---|
| `issueStoreCredit` | callable | mints store credit — money |
| `sweepStoreCreditQueue` | scheduled | store-credit reconciliation |
| `verifyManagerPin` | callable | manager auth on the till |
| `assignCustomerCode` | RTDB created | customer identity |
| `createPosUser` / `updatePosUser` / `removePosUser` / `migratePosUser` | callable | POS staff accounts |

That is the POS app's money path and its auth path. Losing them takes the tills
down, and they cannot be restored from this repo — only by redeploying the other
one.

### How to check before deploying

```bash
firebase functions:list          # anything nodejs20 belongs to the POS repo — do not touch
```

If a change touches shared library code, deploy each affected function by name in
one scoped command rather than reaching for the bare form:

```bash
firebase deploy --only functions:refillHealthScan,functions:onClothingSale
```

### Known scoped commands

| Change | Command |
|---|---|
| Refill engine (`lib/refill-engine.cjs` → `refill-scan.cjs`) | `firebase deploy --only functions:refillHealthScan` |
| Display Checks trigger | `firebase deploy --only functions:onClothingSale` |
| Display Checks wake sweep | `firebase deploy --only functions:wakeHeldChecks` |

Hosting is a separate axis with its own scoping rule (`--only hosting:<target>`);
this repo's `firebase.json` declares the `marathon-club` target. Verify the target
list before a hosting deploy — do not assume it from this note.

---

## 🔔 TRIPWIRES — the reorder-point gate (PR #281)

Two behaviours that are **dormant today and wake up on a specific action**. Both
were found by independent review (Kimi, 2026-07-27) and then reproduced against
the engine, so the numbers below are measured, not predicted.

**Both are unreachable while Marathon PE is the only armed store and only
perfume rows carry a `reorderPoint`.** Neither blocks anything now. They are
written as trigger conditions so that whoever performs the action recognises the
moment, instead of debugging the symptom cold months later.

### TRIPWIRE 1 — the moment you put a `reorderPoint` on a CLOTHING target row

**You have tripped this if:** you add `reorderPoint` to any `/stock_targets` row
for a product that `isClothing()` returns true for (explicit `productType:
"clothing"`, or letter sizes S–XXXL).

**What starts happening:** a gated cell — one sitting quietly above its point —
no longer appears in `belowTarget`. `deficitBySize` is built *from*
`belowTarget`, and it is what tells Move-Excess to route surplus toward a
location that needs it. Invisible demand means the surplus is routed to Central
instead.

Measured, same product and stock, only the row armed:

| | `toHub` | `toCentral` |
|---|---|---|
| unarmed | 8 | 0 |
| armed | 7 | 1 |

The unit goes store → Central, then Central → hub2 when hub2 later drops to its
point — instead of store → hub2 directly. This bypasses the Cortez protection
("deficit-covering units go to Hub 2, never Central") for exactly as long as the
cell sits in its point..target band, which is the policy's normal resting state.

**Severity: physical churn, never starvation.** Stock consolidates at Central and
is pulled back; nothing is lost and no shop runs dry. Do not treat it as an
incident — but do not let it be mistaken for a Move-Excess bug either.

**Why perfume is exempt:** the excess / `onlyInCentral` / `onlyInHub2` loop is
gated by `if (!isClothing(products[pid])) continue`. Perfume produces **zero**
excess cards, so there is no routing decision to get wrong. Verified.

**If you need clothing rows armed:** make gated deficits visible to
`deficitBySize` (track them in a parallel list, or push to `belowTarget` with a
`gated: true` flag and let only the excess allocator read it) *before* arming.

### TRIPWIRE 2 — the moment you arm a SECOND store

**You have tripped this if:** you add `reorderPoint` rows for Trophy, Pine, or
any store beyond Marathon PE, while hub2 is also armed.

**What starts happening:** with two armed stores pulling on one armed hub2, the
first store's request can reserve every unit hub2 holds. The second store then
sees `srcAvail = 0` and is parked with:

> `awaitingUpstream: "waiting for hub2 to receive stock from central"`

**That sentence is wrong.** hub2 is above its own reorder point, so its gate
keeps it silent — no central→hub2 leg exists, and none will be created until
hub2 drains below its point. Reproduced: hub2 armed 10/5 holding 6, PE and
Trophy both armed 8/3 at zero → PE gets an intent for 6, Trophy is parked with
the message above, and hub2 creates no intent at all.

The cause is that the "chain is flowing" test (`srcCanPull`, plus the `srcParked`
checks for rejection / streak / confirmed-out) has no knowledge of the gate. This
is the same mislabel class the `srcCanPull` guard was originally added to close,
reopened along a new dimension.

**Severity: wrong words on a card, for one or two scan cycles.** It self-heals —
the reserved units move, hub2 drops below its point, and the real leg appears.
No starvation, no deadlock: a gated source always satisfies `have > reorderPoint
≥ 0`, so it still has stock to give.

**If you need a second store armed:** teach `srcCanPull` (or `srcParked`) that a
gate-silenced source is not "flowing", so the demand is labelled blocked rather
than falsely reassured.

---

## 2026-07-27 — One-size Accessories carry `productType: "clothing"` DELIBERATELY

**Status: intentional. Do not "clean up" these 22 records.**

22 one-size (`sizes: ["_"]`) Accessories carry `productType: "clothing"`. It looks
like the same stray tag that the Add Product form put on two perfume records, and
it is not. Stripping it flips **22 of 22 Display Checks off**, silently.

### Why the tag is load-bearing

Display Checks classify a sale in `functions/displayChecks/lib.cjs`,
`isClothingSale()`:

```js
if (product.category === "Perfume") return true;   // perfume's own signal
const pt = product.productType;
if (pt) return pt === "clothing";                  // accessories' ONLY signal
return /^(S|M|L|XL|XXL|XXXL)$/i.test(rawSize);     // "_" never matches
```

A **perfume** carries `category: "Perfume"` and matches on the first line, so it
keeps firing display checks with or without `productType`. An **accessory**
carries `category: "Accessories"`, which that function has nothing to match on.
`productType: "clothing"` is the only thing making it return true. Delete the
field and the size heuristic runs against `"_"`, matches nothing, and the check
stops firing — with no error and nothing in any queue to notice.

Affected records are the highest-value display stock: Rolex, TAG Heuer, Chanel and
Daniel Wellington watches, 14 designer glasses lines (Ray-Ban, Gucci, Dior,
Versace, Prada, Hermès, Balenciaga, …), Necklace, Bracelet, Belt, Belt Premium.

`src/utils/productTaxonomy.js:112-121` records this as a deliberate owner decision
and names its cost explicitly: the engine sees these as clothing, can never resolve
a target for `"_"`, and so they surface in the refill No-Target queue as
dismissible entries. **That noise is the accepted price of keeping the checks.**

### The cost is only noise — verified against live data (2026-07-27)

- **0 of 78** one-size products hold a refill target, so clothing-lane membership
  costs no real refill behaviour, only dismissible No-Target entries.
- Trading a live display check on a Rolex for a quieter queue is a bad trade.

### If you DO want the No-Target noise gone

Order matters, and getting it backwards is the silent-failure case:

1. **FIRST** teach `isClothingSale()` to recognise `category === "Accessories"` the
   same way it already recognises `"Perfume"`, so the category carries the signal.
2. **THEN** the 22 `productType` tags become safe to strip.

Step 1 alone is a change to a live trigger on frozen-architecture code — it needs
the full review pipeline, not a data edit. Never do step 2 first.

---

## 2026-07-27 — The stray-`productType` perfume class is CLOSED

Two perfume records carried a `productType` the other 54 did not, both because
they were created through the Add Product form (which always writes the field):

| Record | id | Was | Now | Effect of the fix |
|---|---|---|---|---|
| Creed absolute aventus | `p1784882828665` | `"clothing"` | *removed* | **Real fix** — `isClothing()` true → false, left the clothing refill lane |
| Catwalk | `p1782762651779` | `"sneaker"` | *removed* | Cosmetic — already classified not-clothing, no behaviour change |

Display Checks were unaffected for both (category `"Perfume"` matches first).
Verified before writing that neither held any refill target, No-Target decision,
open refill request or active display check, so nothing was orphaned.

**A full catalog sweep on 2026-07-27 confirmed the class is closed.** All 78
one-size products are either the **56 perfumes** (now all clean, zero carrying
`productType`) or the **22 Accessories** above (deliberately tagged). There is no
third case, and no further perfume record to fix.

### Root cause, still open

The live Add Product form cannot produce a clean one-size record: it offers no
one-size option at all, auto-mints over any supplier barcode, and always writes a
`productType`. The in-progress `feat/product-taxonomy` work is the fix — it adds a
`perfumes` category with `SIZES_ONE` and `productType: null`, and
`/settings/productTaxonomy` is already seeded v1 in RTDB — but no live code reads
the registry yet. Until it ships, perfume records must be written directly to
`/products` plus the `/barcodes` index.
