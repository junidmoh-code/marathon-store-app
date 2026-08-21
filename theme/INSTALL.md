# Marathon Club storefront — install, preview, publish, revert

Two things live in this folder:

1. **The photo-first storefront** — the grid, the quick view, the category
   navigation and the home page. New in this change.
2. **The brand-aware search wiring** (`marathon-search.js`) — built earlier,
   unchanged here, **still not installed on the live theme.** Verified
   2026-08-21: the live pages do not reference it.

Install them together. It is one pass through the same editor.

---

## ⚠️ READ THIS FIRST — I could not duplicate the theme

The safety rule for this work was: duplicate the live theme, work only on the
copy, never publish, hand over a preview URL. **I could not do the duplication
part, and I did not work around it.**

Re-verified against the live shop on 2026-08-21:

```
GraphQL  { themes { … } }                → ACCESS_DENIED
                                           "Required access: `read_themes` access scope"
REST     /admin/api/2026-07/themes.json  → 403
                                           "[API] This action requires merchant approval for read_themes scope"
```

The app **Marathon Catalogue Sync** holds `write_files`, `write_inventory`,
`read_inventory`, `read_locations`, `read_products`, `write_products`,
`read_publications`, `write_publications`, `read_files`. No theme scope, and no
navigation scope either. The Shopify CLI is not installed on this machine and
holds no session, so `shopify theme push` was not an option either. The admin's
theme editor renders in a cross-origin iframe that browser automation cannot
reach.

**So there is no preview URL yet.** Creating one is step 1 below and takes about
a minute. **Nothing in this change has been applied to the live theme.**

### What was tested, and how

Not being able to install it is not a reason to hand over untested code, so:

* Every `.liquid` file here was rendered by a **local Liquid engine** against
  the **live catalogue** — all 703 published products, their real variants,
  real availability, real photographs — and inspected in a real browser at
  desktop and phone widths. The CSS and JS under test are the shipped files,
  byte for byte. That caught three real bugs that reading the code did not:
  a filter chained onto `image_tag`'s output that would have printed raw
  `<img>` markup to shoppers; `has_only_default_variant` being the wrong test
  for a one-size product on this shop; and `{% render %}` arguments silently
  not accepting filters.
* **Add to cart was tested against the live shop**, not a mock. An in-stock
  variant returns `200` and the cart count moves; a sold-out variant returns
  `422` with `"The product '…' is already sold out."`, which is the message the
  panel shows. The test cart was cleared afterwards.
* Every one of the 20 URLs the navigation generates was requested against the
  live storefront. All 20 return `200` with real products.

What was **not** testable without theme access: how these sections behave inside
Feather's own `theme.liquid`, header and footer. That is what the preview in
step 1 is for, and step 4 says exactly what to look at.

---

## 1. Duplicate the theme — never work on the live one

1. **Online Store → Themes**
2. On **Feather** (live, id `150249734293`) → **⋯ → Duplicate**
3. Rename the copy to **`Feather — photo-first`**
4. On the copy → **⋯ → Preview**. That preview URL is what you test on, and it
   is the URL to send back.

The live theme is untouched by everything below.

---

## 2. Add the files

On **the copy** → **⋯ → Edit code**.

### Assets (Assets → Add a new asset → Create a blank file)

| create this file | paste from |
|---|---|
| `marathon-storefront.css` | `theme/assets/marathon-storefront.css` |
| `marathon-storefront.js` | `theme/assets/marathon-storefront.js` |
| `marathon-search.js` | `theme/assets/marathon-search.js` |

### Snippets (Snippets → Add a new snippet)

| create this file | paste from |
|---|---|
| `marathon-card.liquid` | `theme/snippets/marathon-card.liquid` |
| `marathon-nav.liquid` | `theme/snippets/marathon-nav.liquid` |
| `marathon-rail.liquid` | `theme/snippets/marathon-rail.liquid` |

### Sections (Sections → Add a new section)

| create this file | paste from |
|---|---|
| `marathon-grid.liquid` | `theme/sections/marathon-grid.liquid` |
| `marathon-home.liquid` | `theme/sections/marathon-home.liquid` |

Save each one.

---

## 3. Wire them up

### 3a. The search script — one line in the layout

**Layout → `theme.liquid`.** Immediately before `</body>`:

```liquid
<script src="{{ 'marathon-search.js' | asset_url }}" defer="defer"></script>
```

Save. That covers every entry point — header search, search modal, mobile
drawer, empty-state form — because they all submit to `/search` and the script
acts on the results page rather than on any one form.

### 3b. The collection page — swap the grid section

**Templates → `collection.json`.** Find the section whose `"type"` is
`"main-collection-product-grid"` and change that one value to
`"marathon-grid"`:

```json
"main": {
  "type": "marathon-grid",
  "settings": { "per_page": 24 }
}
```

Leave the rest of the file alone. Save.

> Keep the old section in the file if you would rather compare: add a second
> entry and reorder in the theme editor. The old one can simply be removed
> again from the editor's sidebar.

### 3c. The home page

**Templates → `index.json`.** Replace the `sections` and `order` with:

```json
{
  "sections": {
    "main": { "type": "marathon-home", "settings": {} }
  },
  "order": ["main"]
}
```

Save. Everything currently on the home page — "Own Your Stride", the three
"Example product title / R 19.99" placeholder cards, "In the heart of the city,
where dreams collide" — is Shopify's default demo content and goes with it.

---

## 4. Test on the preview

Open the preview URL **on a phone as well as a laptop**. Most of this traffic is
mobile.

**The grid**
- Tap a photograph. Price, condition and sizes appear over it, and **the address
  bar becomes that product's own URL**.
- Tap it again, or tap the ×, or press Back. It closes and the address bar goes
  back to the list.
- **Copy the URL while a photo is open and paste it into a new tab.** It must
  load the full product page. This is the thing that keeps product pages
  existing for Google and for anything anyone shares.

**Sold-out sizes — check this one carefully**

Open `/products/seattle-mariners-cap-navy` from the grid. It has six sizes and
only two are in stock. All six must be visible; **S, XL, XXL and XXXL must be
struck through and refuse to be picked**; M and L must work. That is exactly how
the product page already behaves, and the two must never disagree.

**Condition**

The grade must appear **above** the size picker and **above** Add to cart, never
below it. On the theme's own product template it currently renders *below* Add
to cart — see "Known issues" at the end.

**Add to cart**
- Pick a size, add, and keep browsing. The page must not navigate. The cart
  count in the header must go up.
- Press Add without picking a size: it should say "Pick a size first." and put
  the cursor on the first available size.

**Navigation**

Every row must lead somewhere with products in it. Check `Footwear` and
`Clothing` open, and that `Bags`, `Perfume` and `Under R500` all land on real
listings.

**Search** — type each of these:

```
adidas   adizero   lacoste   samba   air max   gripshot
adidos   lacosteh  sambba
```

Expected, verified against live data 2026-08-21:

| query | products | | query | products |
|---|---:|---|---|---:|
| adidas | 34 | | gripshot | 12 |
| adizero | 3 | | adidos *(typo)* | 34 |
| lacoste | 48 | | lacosteh *(typo)* | 48 |
| samba | 12 | | sambba *(typo)* | 12 |
| air max | 2 | | | |

And the thing that is easy to miss: **the word you typed must not appear
anywhere** — not on the page, not in the browser tab.

---

## 5. Publish

**Online Store → Themes** → on **`Feather — photo-first`** → **⋯ → Publish** →
confirm.

---

## 6. Revert

Two ways, both instant.

**Undo the publish.** The old theme is still in the list, unmodified:
Themes → on **Feather** → **⋯ → Publish**. That is the whole rollback. Nothing
was deleted and nothing needs restoring.

**Or turn one piece off without switching themes.** Edit code, then:

| to disable | do this |
|---|---|
| the search wiring | delete the one `<script>` line from `theme.liquid` |
| the new grid | set `collection.json`'s `"type"` back to `"main-collection-product-grid"` |
| the new home page | restore `index.json` from the un-duplicated **Feather** theme |

Each is independent; none of them needs the others.

---

## If something is slow or down

**The search script fails soft on purpose.** If the Cloud Function is
unreachable, the shopper keeps whatever Shopify rendered — worse results, but a
working page, never a blank screen because of a cold start.

**The grid has nothing to fail.** The quick-view panel is rendered on the server
with the page and only un-hidden by JavaScript, so there is no endpoint behind
it, no loading state, and no way for sizes to arrive late or wrong. With
JavaScript off entirely, every photograph is still a plain link to a real
product page.

---

## Known issues, in this theme, not fixed here

**The product template shows the condition grade below Add to cart.** The grade
is a public claim about used goods and belongs above the buy button. The new
grid does it correctly; the product page does not, and fixing it means editing
`sections/main-product.liquid`, which was not part of this change. In that file,
move the block that renders `{{ product.description }}` (or the `description`
block in the section's block order) so it sits **before** the
`buy_buttons` block. It is a reorder in the theme editor's block list — no code
needed: **Theme editor → Product pages → Product information → drag
"Description" above "Buy buttons".**

**Nine categories are missing from their collections.** Measured 2026-08-21:
559 of 703 live products are in no category collection at all, including all 64
tracksuits and all 34 bags. The navigation is unaffected — it addresses
categories by tag and reaches every product — but the **home page rails** are
filled from collections, so those categories get no rail. Repair is one
idempotent command, dry-run by default:

```
node scripts/shopify/sync-collections.mjs             # plan only, writes nothing
node scripts/shopify/sync-collections.mjs --commit    # apply
```

It writes Shopify collection membership only. Nothing is created, archived,
deleted or unpublished, and no RTDB node is touched. Expect it to take a while —
it reads current membership for 3,457 products before it plans anything.
