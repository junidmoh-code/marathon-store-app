# The storefront search service

Shopify's own search cannot find these products. Every brand, sub-label and
silhouette term is stripped before a product is pushed, so **the words a shopper
types are exactly the words the Shopify catalogue does not contain**:

| true name in the app | title on the storefront |
|---|---|
| `Lacoste Gripshot Lace Boot White Navy` | `Lace Boot White Navy` |
| `Adidas Samba White Core Black` | `Sneaker White Core Black` |
| `Nike Air Force 1 Shell Green` | `Boots Shell Green` |

This service matches on the app's **true** data and answers with Shopify
handles. The brand is used to *find* a product and never travels back out.

---

## 1. Why search was only working for a fraction of stock

Junid reported roughly 10%. Measured on 2026-08-17, before any fix:

```text
LIVE on the storefront : 373
IN THE SEARCH INDEX    : 200
live but NOT indexed   : 173      <- 46% of the storefront
```

**Is there anything to match on?** Across all 373 live products:

| | count | |
|---|---:|---|
| parent brand or sub-label in the true name | 354 | 95% |
| only a model / silhouette word | 15 | 4% |
| no term the lexicon recognises | 4 | 1% |

**Could a shopper actually find it?** Querying each live product with its own
identity term:

| | before | |
|---|---:|---|
| **found** | 197 | 53% |
| in the index but the matcher missed it | 0 | 0% |
| **NOT IN THE INDEX (stale)** | **172** | **46%** |
| nothing to query with | 4 | 1% |

**The data was never the problem.** Not one failure was caused by missing
identity, and the matcher missed nothing. The index had been built once, at
16:43 on 2026-08-16 with 200 products live, and never refreshed — while Junid
kept publishing. Everything published after that moment was invisible.

The 10% figure is consistent with measuring against the whole catalogue
(200 indexed ÷ 4,183 records ≈ 5%) or with using the shop's own search box,
which finds a stripped brand term in **0%** of cases. The endpoint was not
deployed yet.

### After

| | before | after |
|---|---:|---:|
| found | 197 (53%) | **369 (99%)** |
| matcher missed it | 0 | **0** |
| not in the index | 172 (46%) | **0** |
| nothing to query with | 4 (1%) | 4 (1%) |

### The residual four

They are not blank — they are *misspelt or unknown brands*, so the lexicon
yields no canonical term to query them by:

| record | brand field |
|---|---|
| `DC Court Graffiti Black White` | `DC` |
| `New bala 1000` | `New` (New Balance) |
| `Dose Gabbana black` | `Dose` (Dolce & Gabbana) |
| `Descent white` | `Descent` (Descente) |

A shopper typing the text as written *does* find them; one typing the correct
brand does not. This is exactly what the vision pass addresses — read the item
off the photo and record its canonical identity.

---

## 2. Freshness — how the index cannot rot again

It rotted because there was only one mechanism: a manual full rebuild. There are
now three, and the middle one is the important one.

| layer | when | cost |
|---|---|---|
| **per-product hook** | the reconciler confirms a product on/off | one write |
| **self-healing sweep** | end of **every** commit run, worklist empty or not | one shallow read |
| **full rebuild** | on demand, `build-search-index.mjs --commit` | one Shopify read per product |

The sweep compares two sets and repairs the difference:

- **live but not indexed** → index it
- **indexed but not live** → remove it (a result leading to an unpublished
  product is worse than no result)

The live set is already in memory — the reconciler read `/shopify_publish` to
build its worklist. The indexed set is one REST `?shallow=true` read: **keys
only**, a few KB, no document bodies. A healthy tick costs one small read and
zero writes.

The reconciler used to `process.exit(0)` on an empty worklist. **That is how the
index got 173 products behind** — an idle shop is precisely when drift
accumulates unnoticed. A commit run now always reaches the sweep.

Additions are capped at 50 per run: each needs a Shopify read, and a
173-product catch-up must not turn a two-minute tick into a rate-limit incident.
The cap is **reported**, never a silent truncation. Removals are uncapped —
they are free and they are the half with a customer consequence.

---

## 3. The true-name field — `/product_identity/{pid}`

**This is load-bearing.** The vision namer is about to rewrite names across the
catalogue. If the brand lives only in the field being rewritten, that run
destroys search for everything it touches, silently, with no way back.

So the searchable identity has its own node, and the rule is structural rather
than a promise: **no renaming path writes here.**

```jsonc
{
  "text":       "Lacoste Gripshot Lace Boot White Navy",  // what search matches
  "source":     "manual" | "record" | "vision",
  "confidence": 0.0–1.0,          // vision only
  "brand":      "Lacoste",        // optional, structured
  "model":      "Gripshot",
  "colourway":  "White Navy",
  "capturedAt": 1786923000000,
  "capturedBy": "script:backfill-search-identity",
  "supersededText": "…"           // what it replaced, so a bad batch reverts
}
```

### Precedence: a guess never beats knowledge

| source | rank | what it is |
|---|---:|---|
| `manual` | 3 | Junid typed or corrected it. Always wins. |
| `record` | 2 | the name the product was received under — supplier data |
| `vision` | 1 | read off the photo by a model. **A guess.** |

Rank, not confidence. Confidence only orders two *vision* guesses against each
other; it can never lift a guess above supplier data, **however sure the model
claims to be**. A model that is confidently wrong — a shopper searching one
brand and being shown another — is the failure this ranking exists to contain.

Nothing ever blanks an identity out.

### The chokepoint

Exactly two paths rename a product, and both go through `updateProductName()` in
`App.jsx`: the Review-Names approve button, and the admin product page's name
field. That one function now **seeds the outgoing name into
`/product_identity` before the new name lands** — so even an unmigrated product
keeps its identity the moment someone renames it. Seed first, then rename: the
other order races a rebuild into reading the new public name as the identity.

Best effort by design. A rename must not fail because the identity write did —
losing one seed costs a rebuild; refusing the rename costs Junid his edit.

### Migration

`node scripts/backfill-search-identity.mjs --commit` — **4,148 identities
seeded** on 2026-08-17, source `record`. Never overwrites, so re-running is free
and a manual correction made in between survives.

---

## 4. Matching strategy, and why

Reused from the app's own product search (`src/utils/productSearch.js`), so a
shopper gets the same forgiveness a colleague gets typing into the stock picker.
No dependency: it is bounded-Levenshtein string maths over a few hundred
documents, which is microseconds.

A token match returns a **quality, not a boolean**, so results can be ranked:

| | quality |
|---|---:|
| exact whole word | 1.00 |
| word prefix (still typing) | 0.85 |
| substring, including across a word join | 0.70 |
| word-initial acronym (`af1`) | 0.55 |
| rescued by edit distance | 0.40 |

The typo budget scales with token length: 1–2 characters must be near-exact (a
budget there matches almost anything), 3–5 tolerate one edit, longer tolerate
two.

**Every query token must hit something** — an AND, not an OR. `samba white`
finds the Samba; `samba brown` finds *nothing*, rather than every brown shoe.

Fields are weighted so a hit on the true identity outranks one on a category,
or every query for "boots" would rank the whole Boots lane above the product
actually called a boot:

| field | weight | |
|---|---:|---|
| `name` | 1.00 | the true identity |
| `extras` | 0.90 | brand/model/colourway a vision pass read off the photo |
| `aliases` | 0.85 | canonical spellings — see below |
| `title` | 0.80 | the compliant Shopify title |
| `colour` | 0.50 | dominant colours |
| `category` | 0.30 | |

### Aliases: how a correct spelling finds a misspelt record

The trigger lexicon was built from a census of how *this* catalogue misspells
brands, folding `Timbalend`, `Guccie`, `Kelvin Klein`, `Lacoster` onto one
label. The index stores that canonical label.

The live case that forced it: `Timbalend motion creem`. `timberland` is three
edits away — beyond any typo budget worth having. With the alias it is found.
This closed the last matcher miss: 99% → **0 matcher failures**.

Ties break on `handle`, never insertion order: the same query must return the
same order on every instance, or a shopper who reloads sees results shuffle.

---

## 5. The endpoint

```
GET https://europe-west1-marathon-club.cloudfunctions.net/storefrontSearch?q=samba&limit=12
→ { "results": [ { handle, title, price, currency, image, sizes[], inStock, collection, score } ] }
```

**Deploy — scoped, by name, never a bare deploy:**

```sh
firebase deploy --only functions:storefrontSearch
```

### Assume the response is public, because it is

No auth, browser-callable. The response is built by `publicResult`, an
**allow-list** that constructs each field by name — never a stored document with
fields deleted from it, because a delete-list silently leaks whatever gets added
later. (`extras` and `aliases` *were* added later. They do not leak; there is a
test.)

**Never leaves:** the true brand-carrying identity, `aliases`, `extras`,
`stockPrice`, cost, supplier, SKU, barcode, the internal product id, or any
per-location quantity. Availability is a **boolean per size** — never a
quantity: "3 left in size 8" is inventory intelligence.

**The query is not echoed.** The results page must not print the search term on
screen, and the surest way is to give it nothing to print.

Verified on the live wire, every result of every query: **0 brand leaks.**

### Read cost per query

| | RTDB reads |
|---|---|
| warm instance, steady state | **0** |
| freshness check | one `meta/version` read, at most 1 per 60s per instance |
| cold start | one read of the corpus — 373 docs ≈ 90 KB |
| repeated query, same shopper | **0** — `Cache-Control: public, max-age=60` |

The index lives in instance memory and is reloaded only when `meta.version`
actually changes.

### Rate limiting

A token bucket per IP in instance memory: burst 30, sustained 1/sec, bucket map
capped at 5,000 entries (a limiter that leaks memory is worse than no limiter).

Deliberately **not** distributed — a shared limiter needs a store, and a read
per request is precisely the cost this endpoint exists to avoid. The real
backstop is that a query costs no reads at all, so the worst a flood buys is
CPU, which `maxInstances: 5` and `concurrency: 40` already bound. Non-GET is
405; queries under 2 characters return empty without touching the index.

---

## 6. The rule to paste

`/product_identity` and `/search_index` are **Admin-SDK only**. No client reads
or writes either: `/product_identity` is the brand in plain text, and
`/search_index` carries it too. Both are served to the public exclusively
through the endpoint's allow-list.

Paste into the **console** rules (not `database.rules.json`), alongside the
existing `/shopify_sync` block:

```json
"product_identity": {
  ".read": false,
  ".write": false
},
"search_index": {
  ".read": false,
  ".write": false
}
```

Admin SDK writes bypass rules, so the migration, the reconciler hook, the sweep
and the endpoint all keep working. Until this is pasted the node inherits
whatever the parent allows — check it.
