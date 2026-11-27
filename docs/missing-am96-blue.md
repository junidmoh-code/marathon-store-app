# The blue/white Nike Air Max 96 DT that Junid can't find (27 Nov 2026)

**Finding: it was never added to the catalogue.** No product record for a
blue/white (or university blue, navy, royal) Air Max 96 / Air DT Max '96
exists in `/products`. The Concrete assistant view can't show a product that
doesn't exist. No code filter is hiding it, and **no product data was
changed** by this investigation.

## What exists

Only two Air Max 96 products exist, and both were created in the same
receiving batch (7 May 2026):

| pid | name | brand | category | style code | price | hubs | photo | deactivated | website |
|---|---|---|---|---|---|---|---|---|---|
| `p1778142998049` | Nike Air Max 96 DT Red White | Nike | Footwear / Sneakers (`sneakers`) | none | R850 | hub2, hub3 | yes, red/white (current and history photo both checked by eye) | no | `shopify_publish.state = awaiting` (not listed) |
| `p1778143066990` | Nike Air Max 96 Black White | Nike | Footwear / Sneakers (`sneakers`) | none | R850 | hub2, hub3 | yes | no | `shopify_publish.state = awaiting` (not listed) |

Stock, read live one cell path at a time (`/stock/{loc}/{pid}`) for central,
hub1, hub2, hub3, marathon-pe, trophy, marathon-pine, concrete, studio, base
and in_transit:

- **Red White** (`p1778142998049`): only `marathon-pe` has cells (size 10 = 0,
  `_` = 0). It has **zero stock everywhere**. That is why its card on
  Concrete reads UNAVAILABLE / "Tap for similar".
- **Black White** (`p1778143066990`): `hub2` sizes 7 = 0 and 8 = 0;
  `marathon-pe` sizes 7 = 0 and 8 = 0. It also has **zero stock everywhere**.
- Neither is in `settings/missingProductsHidden`. Both have a
  `product_identity` record that matches their current name.

No stock for a blue pair is sitting under the red record, either. The red
record holds no units anywhere, so the physical blue pairs were never
received against it.

## How it was searched (all bounded reads, nothing written)

`/products` has **no `name` index** (the REST API refuses
`orderBy="name"`). The search therefore went through:

1. **Local catalogue snapshot** (`.xmas/data/products.json`, 3,979 products,
   pids `p1777895620932` … `p1786028211092`, from 6 Aug 2026). Name, style
   code and altProfile were matched for `max 96`, `max '96`, `dt max`,
   `am96`, `air max dt`, `deion`, `sanders`, and any standalone `96` or `dt`.
   It found only the two records above. Two more names contain "96":
   "Lacoste Storm 96 2K" and "Air More Uptempo '96". Neither is an AM96. Every
   "Air Max … blue/navy" name was also checked: Air Max 95, 1, Artisan, Portal,
   Plus and 270. None is an AM96.
2. **Every product created since that snapshot**, read live by a key-ranged
   scan. Product keys are `p<creation ms>`, so `orderBy="$key"` starting at
   `p1786000000000` in pages of 150 covers it. That is **2,606 products**,
   which overlaps the snapshot, so every product key is covered. The same
   patterns, plus any "max"/"air max" name with blue/navy/white, turned up no
   AM96 at all. The only matches were Air Max 200, Air Max Plus and two
   T-shirts.
3. **No product keys exist outside the `p1…` range**: the queries
   `endAt="p"` and `startAt="p2"` both return nothing.
4. **Style code**: `styleCodeNormalised` *is* indexed. Range queries for the
   Air DT Max '96 codes `316408` (White/Varsity Red), `IF1617`, `HM9236`, and
   the `HM`, `HJ`, `FQ`, `IB`, `IH` and `IF` prefixes found no DT Max. Neither
   AM96 record carries a style code.
5. **Neighbours**: the full key range of the 7 May batch
   (`p1778142000000`–`p1778144000000`, 55 products) was checked, along with
   the 12 stored `alternatives` of both AM96 records. None of them is a blue
   AM96.

One gap is left. A product created **before** 6 Aug could have been renamed
since then to an AM96 name. Ruling that out means reading the current name
of all ~4,000 older products, which is a whole-node read and is not allowed.
It is very unlikely, because that product's original name would have had to
be something other than an AM96 name.

## Why it doesn't show on Concrete: each filter in turn

Each filter would block only a product that exists. The first check fails:
there is no record.

| Check | Result |
|---|---|
| Record exists in `/products` | **No.** This is the cause. |
| Search tokenising ("96" vs "'96", "DT", brand stripping) | Not the cause. "air max 96", "max 96" and "dt" all reach the red record through Fuse, and the brand prefix "nike" narrows to Nike and then fuzzy-matches the rest. A blue record named the same way would match the same way. These were tested against the screen's exact Fuse settings: "dt max 96" and "air dt max 96" match too. The one query that finds nothing is the run-together shorthand **"am96"**. That is a small search gap, not the cause, and this change does not touch it. |
| Category / division / destShop filter | Not the cause. The sibling records (hubs hub2/hub3, category `sneakers`) appear on the Concrete grid, as Junid saw with the red one. |
| Availability | It only sets the badge and never hides a card (see below). |
| Deactivated / hidden | The siblings are not deactivated and not hidden. |
| Missing photo / price | The siblings have both. |
| Duplicate-name collision with the red one | None. No second record exists to collide with. |
| Stale mirror | Ruled out: the server itself has no record. |

## What Junid needs to do

Add the blue/white pair as a new product. Use the same naming pattern so it
sits next to its siblings in search, for example **"Nike Air Max 96 DT
University Blue White"** (or whatever colour the box says), at R850, with
sizes and stock received against it. Fill in the style code from the box
label if it can be read. This session did not create the product, because
the exact colourway, sizes and quantities must come from the physical pairs.

## Related fix shipped with this investigation

The UNAVAILABLE cards now sort to the bottom of the grid. See commit 2 and
`unavailableLast` in `src/components/assistant/divisionAvailability.js`.
