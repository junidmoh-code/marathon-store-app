# Duplicate kids' Dunk: investigation (read-only, 28 Nov 2026)

Produced by `node scripts/merge-dunk-grey-kids/investigate.mjs --out scripts/merge-dunk-grey-kids/out/investigation.json`
(full output in `out/investigation.json`). Nothing was written to the database.
Every read was narrow: by product id, by key prefix, or by an indexed query
(`style_code_index.productId`, `refill_requests.productId`,
`duplicate_candidates.status`, `stock_movements.ts` from 19 Nov).

## The two products

| | KEEP (original) | REMOVE (duplicate) |
|---|---|---|
| id | `p1795103464793` | `p1795600675612` |
| name | "Nike SB dunk low grey small" | "Nike dunk low  grey and white" (double **non-breaking** space) |
| style code | 845013-100 (`845013100`, claimed in `/style_code_index`) | none, and no claim |
| category | Footwear / kids-shoes, Nike | Footwear / kids-shoes, Nike |
| sizes | 24–35 | 24–35 |
| created | 19 Nov 2026 | 25 Nov 2026 |
| photo | yes (studio) | yes |
| sold since 19 Nov (ledger) | 27 sold, 2 returned, last sale **28 Nov 14:54 UTC** (today) | **never sold**: its only movements are 12 `received` at Central on 25 Nov |
| price | retail **R300**, stock R250 | retail **R450**, stock R400 |

The brief's "33 orders all-time" for the original: the ledger since its creation
shows 27 sales. `/orders` has no productId index, so it was not scanned. Both
show the original is the live, selling record.

**Same shoe?** Yes, as far as the records can show: same brand, same category
(kids-shoes), same size labels, same Dunk Low profile in `altProfile`
(light-grey/white two-tone leather). Nothing points to adult sizes.

## Stock per location (size: qty)

| Location | Original | Duplicate |
|---|---|---|
| central | 31:2 32:1, all others 0 → **3** | 24:3 25:3 26:4 27:5 28:4 29:3 30:4 31:4 32:5 33:5 34:5 35:5 → **50** |
| hub1 | 24:2 25:1 26:1 27:2 28:1 34:3, others 0 → **10** | none |
| hub3 | 24:1 26:2 28:3 29:1 30:1 32:2 33:1 34:2, others 0 → **13** | 12 empty cells (all qty 0, seeded by the 25 Nov "solve") → **0** |

Combined: 26 + 50 = **76**.

## Size map

Both products use the same labels 24–35, so they map **1:1**. No unmapped sizes.

## Everything that references the duplicate

| Reference | Found | What the merge does with it |
|---|---|---|
| **Open refill requests** | **21 open**, none partly sent | Nothing: the merge does not touch requests. See below. |
| Barcodes (`/barcodes`) | 12 rows, 00040275–00040286 (sizes 24–35) | The merge repoints all 12 to the original, so stuck-on labels keep scanning. |
| Style-code claims | none | — |
| Duplicate-pair row | none | — |
| Display register slots | none at any location | — |
| Hub count records | none (no open count session at Central or Hub 3) | — |
| Stock targets (policy) | none | — |
| Attention lists | none | — |
| Shopify / website listing (`/shopify_publish`) | none | — |
| Online shelf holds | none | — |
| Laybys, sales, customer orders | none: the duplicate has never had a sale or any movement apart from receiving | — |
| Carts | not stored in the database (assistant cart lines are not saved) | — |
| `product_attributes` | yes (what the shoe looks like) | Left in place: it describes a hidden record and does nothing. |
| `label_aliases` | not checked: no productId index, and alias lookups follow the merge pointer | — |
| Missing Products | a screen worked out from stock, not a stored list | The duplicate drops off it once merged. |

### The 21 open refill requests

All were raised by hand from the Missing Sneakers screen, to send the duplicate's
Central box out to the hubs:

- **Hub 3**: 3 pairs of every size 24–35 (36 pairs). Raised by Jafer, 25 Nov 19:57 UTC.
- **Hub 1**: 26×1, 27×2, 28×1, 30×1, 31×1, 32×2, 33×2, 34×2, 35×2 (14 pairs). Raised from Trophy's "2POS", 26 Nov 11:33 UTC.

Together that is exactly the duplicate's 50 pairs at Central, size by size.

The Refill Queue sends with the request's own product id
(`RefillQueue.jsx`: `transfer_out … productId: r.productId`). If the merge ran now,
the duplicate's Central cells would be deleted, and these 21 tasks would point at
a hidden product that has no stock left to send.

Separately, the **original** has 2 open requests of its own from the scan
(Hub 1: size 32×1 at 07:00 and 31×2 at 12:00 today).
