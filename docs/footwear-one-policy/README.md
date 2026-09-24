# One footwear policy — investigation (24 Sep 2026)

Census: `census-before-2026-09-24.json`, produced by
`scripts/audit/footwear-one-policy-census.mjs` (read-only, paged). Live read
2026-09-24 16:17 UTC.

## Timberland Premium 6-Inch Wheat (`p1777990658712`)

Junid's report was that Hub 1 showed "Category policy" with 6 keep 0, 7/8 keep 3,
9–11 keep 2, 12/13 "Not carried" (13 holding 2 units), and no 3/4/5/5.5.

- **The product is a Sneaker, not a Boot.** Its `categoryKey` is `sneakers`;
  "Boots" is the legacy `subcategory` text. The policy in force at Hub 1 was the
  **Sneakers category's own Hub 1 entry**, written 25 Aug: sizes 3–11 only.
- **12 and 13 "Not carried"**: that Hub 1 entry never got 12 and 13. The 3 Sep
  extension went into two other places — the `footwear-all` group (which was
  **disarmed**, so the edit did nothing) and the Sneakers **Hub 2** entry.
- **6 keep 0** is not a product row. It is the dead-size rule: size 6 has zero
  units anywhere in the network, so the policy resolves 0 until a unit exists.
- **3/4/5/5.5 absent**: the product record declares only 6–13. The engine never
  arms a size the product does not come in.
- At 13:57 UTC today Junid wrote product rows on Hub 1 (6→2, 12→2, 13→2) from the
  Targets editor. Those rows outrank any policy and are left alone.

## Why only some categories drifted

Footwear numbers lived in **four** places, each its own copy:

| Where | Hub 1 | Hub 2 |
|---|---|---|
| Sneakers own entry | 3–11 (6/7/8 keep 3) — **no 12/13** | 3–13 but **7/8 keep 2** |
| Slides own entry | 3–11, **all keep 3**, no 12/13 | same |
| `footwear-all` group | 3–13, 7/8 keep 2 — **disarmed, inert** | same |
| Footwear rule (`footwearRunByLocation`) | 3–11, 11 keep 1 — **switched off** | same |

Designer Shoes and Soccer Boots had no policy at all; Soccer Boots and Slides were
not even members of the group. Boots, Loafers, Running Shoes and Kids Shoes hold
**no products** today. Each edit reached only the copy it was typed into.

## What governs footwear now

The `footwear-all` group, armed, holding all eight categories, the standing run at
Hub 1 and Hub 2 identically, `carriedOnly: true` on both legs. No footwear category
carries its own entry; the write path refuses one, and any that appears anyway
(console edit, revert) is flagged as drift on the Engine Policy card and in the
scan's Health output.

## Kids Shoes

0 products live. The registry declares sizes 26–33, none of which the standing
run names — so nothing is armed and nothing is invented.
