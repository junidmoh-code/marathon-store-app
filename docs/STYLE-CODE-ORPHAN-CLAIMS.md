# Style-code orphan claims — findings (2026-11-09)

"This style code is reserved, but the product it points at doesn't exist" —
CW3398-105 → p1782003441156.

## Where the claim is written

`addProduct` in `src/App.jsx` writes the product first, then the claim. It has
done so since #318 (5 Aug 2026), and the live rule forces it:

    /style_code_index/$code .validate:
      !newData.exists() || (… && root.child('products').child(newData.child('productId').val()).exists())

`root` is the database **before** the write, so a claim for a product that does
not already exist is refused. Two consequences:

- A failed save cannot leave a claim. If the product write fails the claim is
  never attempted; if the claim fails there is no claim.
- One multi-location update of product + claim is **impossible** for a new
  product: the claim would validate against a root that does not yet hold it.
  Claim-after-product is the only order the rule allows.

## What actually orphans a claim

The **Delete product** button (`deleteProductFromFirebase`, `src/App.jsx`)
removes `/products/{id}` and nothing else. It is the only code path that removes
a product record. The claim stays, naming a product that no longer exists.

Evidence: every one of the 25 dead claims was written on or after 5 Aug 2026
(earliest 2026-08-05), so the rule above held for each: **all 25 products existed
when claimed and were removed afterwards.** CW3398-105's product id was minted
2026-06-21 and claimed 2026-08-08, so that claim was stamped onto an existing
product later rather than written by Add Product. The server-side claim writers
(`processCapture`, the `styleCodeSibling` bootstrap) bypass the rule but read the
product first, so they too only claim for a product that exists.

## Census, live, 2026-11-09 (read-only)

Per-key reads of `/style_code_index` and per-id shallow reads of `/products`.

| | Count |
|---|---|
| Claims in the index | 933 |
| Primary owner live | 908 |
| Primary owner merged away | 0 |
| **Primary owner absent from `/products`** | **25** |
| Malformed claim | 0 |
| Live primary with a dead sibling | 0 |

None of the 25 is a hidden or deactivated product. Deactivation is a flag on the
`/products` record, there is no second product node, and all 25 ids hold no
`/stock` cells. Some still have `product_identity`, `product_attributes`,
`product_size_ranges` or `shopify_publish` rows; those are derived data keyed by
id, not product records.

| Code | Dead product id | Id minted | Claimed | Other carriers / siblings |
|---|---|---|---|---|
| 00018969 | p1778148262032 | 2026-05-07 | 2026-08-24 | — |
| 132984370 | p1778919280540 | 2026-05-16 | 2026-08-08 | — |
| 305050801 | p1786001882268 | 2026-08-06 | 2026-08-06 | — |
| 734CAM0018231 | p1784642971106 | 2026-07-21 | 2026-08-09 | — |
| 741SMA0021286 | p1783756063446 | 2026-07-11 | 2026-08-22 | — |
| 748SFA0106BL6 | p1789570353406 | 2026-09-16 | 2026-09-16 | — |
| 7738 | p1788944003038 | 2026-09-09 | 2026-09-09 | 10+ live product(s) carry the code, none owns the claim |
| AO4606100 | p1784633513949 | 2026-07-21 | 2026-08-07 | — |
| CW3398105 | p1782003441156 | 2026-06-21 | 2026-08-08 | — |
| EG7597 | p1788348578099 | 2026-09-02 | 2026-09-02 | — |
| FN6040400 | p1781006928023 | 2026-06-09 | 2026-08-21 | — |
| FV5582001 | p1786609354490 | 2026-08-13 | 2026-08-13 | live carrier p1785165107924 |
| HQ8707 | p1788356934424 | 2026-09-02 | 2026-09-02 | — |
| HQ8708 | p1778142008332 | 2026-05-07 | 2026-08-10 | — |
| JI0349 | p1790253981910 | 2026-09-24 | 2026-09-24 | — |
| KK1988005 | p1785936389183 | 2026-08-05 | 2026-08-05 | — |
| L11M9 | p1783154193951 | 2026-07-04 | 2026-08-24 | — |
| M1000CN | p1788354423014 | 2026-09-02 | 2026-09-02 | — |
| MR530QA | p1778147319175 | 2026-05-07 | 2026-08-10 | — |
| PO7548922 | p1783251345522 | 2026-07-05 | 2026-08-10 | **keeps live siblings** p1777987185458, p1778483629142 |
| S16015051E6100 | p1789997664769 | 2026-09-21 | 2026-09-21 | — |
| SOFTFOOTBEDC | p1778842748224 | 2026-05-15 | 2026-08-22 | — |
| XL1979101 | p1786013410242 | 2026-08-06 | 2026-08-06 | — |
| Y02636 | p1778144705339 | 2026-05-07 | 2026-09-01 | — |
| YO3363 | p1784209295595 | 2026-07-16 | 2026-08-10 | — |

**PO7548922 is not a dead claim.** Its primary is gone but two live colourway
siblings still own the code, so releasing it would detach two real products. It
stays in the index. `resolveStyleCode` answers with the live owners only.

## The rule

| Owners of the claim | Action |
|---|---|
| Primary live | Nothing |
| Primary merged away | Answer with the survivor (read-only) |
| Every owner absent | **Dead**: release it and record `/style_code_orphans/{code}` |
| Primary absent, a sibling lives | Keep the claim; answer with the live owners |
| Redirect that dangles or loops | Keep the claim; lookup reports "try again" |

Shared by `resolveStyleCode` and `scripts/sweep-style-code-orphans.mjs` through
`functions/lib/style-code-orphans.cjs`.
