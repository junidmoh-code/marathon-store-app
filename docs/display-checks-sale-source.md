# Display Checks — Sale-Source Proof

Job 1 of the PR-2 session (2026-07-17). Question: is `/stock_movements` a trustworthy
sale source for the `onClothingSale` trigger, and does it agree with `/pos/sales`?

**Verdict: PROVEN — the sources agree. The trigger fires on `/stock_movements`
`type === "sold"` movements.**

---

## 1. The sale discriminator — ANSWERED, clean

`/stock_movements` carries an explicit, validated movement type. Exactly one value
means "a customer took an item":

- **Writer-side contract (store-app validator):** `src/components/stock/applyMovement.js:39`
  — `VALID_TYPES = new Set(["received", "opening", "sold", "transfer_in", "transfer_out",
  "adjustment", "return"])`. Transfers, receiving, opening balances, adjustments and
  returns each have their own type; **`"sold"` is the only sale type**. `applyMovement.js:108`
  even special-cases it (a sale may drive a cell negative — the sale always wins).
- **POS writer contract (documented in this repo):** `src/utils/clothingSold.js:11-13` —
  marathon-pos-app writes ONE `sold` movement **per (sale, product, size) cell**:
  `{ type:"sold", productId, size /*RAW*/, qty /*+magnitude*/, from /*selling shop*/,
  ts /*ISO*/, link:{ saleId } }`. Returns/voids mirror with `type:"return"`.
- **Reader precedent:** `src/utils/clothingSold.js:183` filters `m.type !== "sold"` — the
  clothing-sold refill worklist already keys the business on this discriminator.
  Functions-side tests exercise the same shape (`functions/test/refill-engine.test.cjs:936`).

No ambiguity, no heuristic: `type === "sold"` ∧ `from === <shopId>`.

## 2. The two-source comparison — AGREES

**Scope:** store `marathon-pe`, SA trading day **2026-07-16** (Africa/Johannesburg).
Window per the repo's own helpers (`saStartIso`, `src/utils/clothingSold.js:70-75`):
`ts ∈ ["2026-07-15T22:00:00.000Z", "2026-07-16T22:00:00.000Z")` /
`createdAt ∈ [1784152800000, 1784239200000)`.

**Queries (both server-scoped — no full-node reads):**
- `/pos/sales`: `orderByKey`, `startAt "-OxaVPF-"`, `endAt "-OxiDms-zzzz"` (push-id keys
  encode creation ms; ±6h key buffer, then precise `createdAt` filtering). Keys are always
  indexed — no `.indexOn` needed. 132KB slice.
- `/stock_movements`: `orderBy ts`, `startAt/endAt` the window ISO bounds. Served by the
  live `.indexOn:["ts"]` (required by `clothingSold.js:46`; REST would have errored if
  missing — it didn't). 417KB slice.
- Clothing classification: **identical rule both sides** — `products/{id}.productType`
  (fetched per-id, 135 tiny reads) with the size-letter fallback, i.e. the repo's
  `inferProductType` (`src/utils/insights.js:25-30`), exactly as `isClothingMovement`
  applies it (`clothingSold.js:126-129`).

**Decode rules established from the data (both structural, both verified per-record):**
1. POS records typed `sale`, `layby`, `exchange` all write `sold` movements (join by
   `link.saleId`: 143 + 2 + 10 = all 155 PE sold movements matched, 0 unmatched).
   `refund` records write none.
2. An exchange's `lineItems` carry BOTH legs: outgoing lines (`L*`, positive `lineTotal`)
   each match a `sold` movement; the returned leg (`ret-*` lineId, negative `lineTotal`)
   each match a `return` movement. Outgoing lines only are sales.
3. One-size vocabulary: POS lines say `"Free Size"`; movements use the `_` no-size
   sentinel (`stockSizeKey`, `src/utils/sizeKey.js:44-47` — the cross-app cell contract).

**Result (clothing only, outgoing only, sizes normalised):**

| Metric | `/pos/sales` | `/stock_movements` | Match |
|---|---|---|---|
| Total units | **106** | **106** | ✅ |
| Distinct {productId, size} | **100** | **100** | ✅ (set-equal, not just count-equal) |
| Rows (line items vs movements) | 106 | 105 | ⚠ see below |
| Per-(saleId, productId, size) unit join | — | — | ✅ **zero residual, both directions** |

**The 106-vs-105 row count is granularity, not a missing sale.** Sale
`-OxeprOTFY5wU6srARjI` rang the same one-size product (`p1783322642153`) as two separate
lines (L1 qty 1 + L2 qty 1); the ledger wrote ONE movement `qty=2` — exactly the
documented per-(sale, product, size)-**cell** contract (`clothingSold.js:8`). Both sources
record 2 units. Every other row pairs 1:1. The unit-level join is exact: **no unit exists
in one source and not the other.**

## 3. Why `/stock_movements` for the trigger (now proven, was conditional)

- Shop-keyed natively (`from:"marathon-pe"`) — no short-id (`"pe"`) mapping to build.
- One movement per (product, size) cell = exactly the dedupe key the trigger wants.
- The clothing classifier and size-sentinel contracts already exist in this repo.
- The comparison above shows it captures sale/layby/exchange outgoing units 1:1 with the
  till, and excludes returns/refunds by type — which is precisely the "customer took an
  item off a display" event the design needs.

**Caveats recorded, not hidden:**
- One store-day proven (PE, 2026-07-16). The design's own PR-2 plan (design §15: dormant
  trigger runs for a few days, output compared against the floor) is the extended proof.
- `sold` movements exist for hubs too (e.g. `from:"hub2"` in test fixtures); the trigger's
  per-store flag gate makes non-shop `from` values a non-issue.
- The layby `sold` movement is written at layby CREATION (2 layby records → 2 sold
  movements same day) — a layby'd item leaves the display then, so that is the correct
  check-trigger moment.
