# Marathon Club storefront — install, preview, publish, revert

Three things live in this folder:

1. **The photo-first storefront** — the grid, the quick view, the category
   navigation and the home page.
2. **The fence identity** — the wall the whole shop now stands in front of, the
   frame every photograph hangs in, the display type, the hero, and the row of
   promises under the catalogue. New in this change; see "The fence identity"
   below for what it is and what it replaces.
3. **The brand-aware search wiring** (`marathon-search.js`) — built earlier,
   unchanged here, **still not installed on the live theme.** Verified
   2026-08-21: the live pages do not reference it.

Install them together. It is one pass through the same editor.

---

## The fence identity — what it is, and the two things it removes

Every Marathon Club product is photographed against the same expanded-metal
mesh, which makes the mesh the one thing every photograph in a catalogue with no
brand names has in common. This change makes it the shop's surface as well: the
page stands in front of the same wall the products were shot against, and every
photograph is inset in a frame hung on it.

The texture is the owner's own photograph, levelled to take the camera's
lighting falloff out and cut to a **447×384 tile that repeats with no seam** —
53 KB, greyscale, one file. It is used **at its own colours**: black mesh on a
near-white field, exactly as photographed. Nothing tints, darkens or recolours
it.

**The wall does not move.** It is painted on a `position: fixed` layer behind
the page, so the shop scrolls across a wall that stays where it is, and
everything else — frames, labels, the navigation, the hero — floats on top as
translucent white glass with the mesh reading through it. It is a fixed
*element* rather than `background-attachment: fixed`, because that one-liner
quietly degrades to a scrolling background on iOS Safari, which is where most
of this traffic is and is the one thing this may not do.

**⚠️ The shop becomes a LIGHT shop.** The wall is near-white, so this file sets
its own near-black type rather than inheriting the theme's near-white
foreground. The marathon sections handle themselves — but **the theme's own
pages do not**: Feather is a dark scheme, so on a light wall its product page,
cart and policy pages would render near-white text on a near-white ground. See
step 3a-ii before you install the layout line.

**Two claims come off the home page, and this is the part to read before
publishing.** The strip under the catalogue made three promises; the shop can
stand behind one:

| claim | what happens | why |
|---|---|---|
| Authentic — Checked & Verified | **removed** | Marathon Club is an independent reseller and is not an authorised dealer for anything, so it cannot vouch for provenance. "Authentic" is already refused everywhere else — `scripts/shopify/compliance.test.mjs` fails the returns page if the word appears in it. |
| Fast delivery — 1–3 working days | **removed** | A courier's promise, not the shop's, stated on the home page as if it were the shop's. |
| Easy returns — 7 days to return | **restated** | The real policy is not a returns policy: it is a **14-day exchange on anything faulty**, and it explicitly does not cover change of mind or the disclosed condition grade (`docs/RETURNS-AND-CONDITION.md`). It now says that, and links to the page that spells it out. |

The row is three theme settings, two of them blank. Leave them blank unless
something else becomes true — a row of one honest promise is the correct result,
not a layout to fix, and the strip centres what it has rather than stretching to
fill a desktop width.

**If the live theme has its own trust bar**, it is not in this folder and this
change cannot remove it. Delete it in the theme editor at step 3d, or the shop
will show both.

---

## ⚠️ READ THIS FIRST — I could not duplicate the theme

The safety rule for this work was: duplicate the live theme, work only on the
copy, never publish, hand over a preview URL. **I could not do the duplication
part, and I did not work around it.**

Re-verified against the live shop on 2026-08-21:

```text
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

**And one file that is not pasted.** `marathon-fence.jpg` is an image, so it is
uploaded rather than typed: **Assets → Add a new asset → Upload a file** →
`theme/assets/marathon-fence.jpg`. Upload it under exactly that name — the
stylesheet asks for it by name and the shop renders as a plain dark page without
it, which is a degrade, not a break, and easy to miss.

### Snippets (Snippets → Add a new snippet)

| create this file | paste from |
|---|---|
| `marathon-card.liquid` | `theme/snippets/marathon-card.liquid` |
| `marathon-nav.liquid` | `theme/snippets/marathon-nav.liquid` |
| `marathon-rail.liquid` | `theme/snippets/marathon-rail.liquid` |
| `marathon-identity.liquid` | `theme/snippets/marathon-identity.liquid` |
| `marathon-promise-mark.liquid` | `theme/snippets/marathon-promise-mark.liquid` |

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

### 3a-ii. The identity — one more line in the layout

**Layout → `theme.liquid`.** Immediately before `</head>`:

```liquid
{% render 'marathon-identity' %}
```

Save. The home page and the category pages carry the identity on their own —
both sections render this snippet — so this line is what extends it to the
**product page, the cart, the search results and the policy pages**. Without it
the shop changes surface halfway through a visit, which is worse than not
changing it at all. Rendering it twice is safe: the stylesheet is the same URL
both times and the custom property is declared with the same value.

**Then switch the theme to a light colour scheme, in the same pass.** The wall
is near-white and the theme is dark, so every page this rebuild does *not* own
would otherwise put near-white text on it. In **Theme editor → Colours**, set
the scheme used by the header, footer and product pages to a light one — a
near-black foreground on a transparent or white background. Check the product
page and the cart before moving on; those two are the ones that will show it.

If you would rather not re-scheme the theme yet, **leave this line out**. The
home page and the category pages still carry the wall on their own, and the
rest of the shop stays exactly as it is today. That is a smaller, safe first
step — it just means the surface changes when a shopper opens a product.

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

### 3d. Remove anything the home page now says twice

`marathon-home` renders its own hero and its own promise row. Whatever the live
home page already had in those two places is **not in this folder** and survives
the `index.json` swap only if it lives in another section — so open the home page
in the theme editor and delete, from the sidebar:

* **the banner above the rails**, if one is left — otherwise there are two
  headlines. (Or keep the theme's own and turn mine off: **Home rails → Hero →
  Show the hero**.)
* **the trust bar** — the row reading *Authentic · Fast delivery · Easy
  returns*. Two of those three claims are not ones this shop can make; see "The
  fence identity" at the top of this file for why, and what replaces them.

Then check **Home rails → What we promise**: it should read *14-day exchange /
On anything faulty*, with the second and third slots blank, and it should point
at `/pages/returns-and-condition`.

---

## 4. Test on the preview

Open the preview URL **on a phone as well as a laptop**. Most of this traffic is
mobile.

> **Please do one check on a real iPhone.** Everything below was verified in
> Chrome, across eleven viewport widths from 360px to 1600px. The one thing I
> could not test is Safari on iOS, and that is where most of this traffic
> actually is. What to look at: open a photograph on a product with a long size
> run (`/products/sneaker-navy-white` has ten sizes) and confirm the panel grows
> to fit — the price, the condition line, every size and the Add to cart button
> all present, nothing cut off at the bottom.

**The identity — look at this first, because it is on every screen**
- **Scroll, and watch the mesh.** It must stay exactly where it is while the
  page moves over it. If it scrolls with the content, the fixed layer is not
  taking effect — that is the single most important check here, and it is the
  one most likely to behave differently on a real iPhone than in a desktop
  browser's phone simulator.
- Everything on the page reads as **floating on** the wall: the mesh is visible
  *through* the card frames, the labels, the navigation bar and the hero panel,
  not just around them.
- The mesh is the colour of the photograph — **black on near-white**. If it is
  grey, dark or tinted, something is recolouring it.
- The mesh is at the same scale on the home page and on a category page, and
  does not restart or jump when you move between them.
- The mesh does not **seam**. Scroll the full length of a category page on a
  phone and look for a repeating line, horizontal or vertical. There should be
  none — the tile was cut to a whole number of cells in both directions — but a
  seam is the one defect that only shows up at real size on a real screen.
- Every photograph sits in a **frame**: a hairline edge, a short lift, and the
  mesh visible through the letterboxing on a photo that is not 3:4.
- **Product names and prices must be readable.** They sit on a small glass chip
  for exactly this reason — 12px type directly over a diamond mesh disappears.
  If any small text is sitting on bare mesh, say so.
- **If the wall is missing** and the shop is a flat light grey page,
  `marathon-fence.jpg` did not upload, or uploaded under a different name.
  Nothing else breaks.
- The row under the catalogue reads **14-day exchange / On anything faulty** and
  nothing else. If the words *Authentic* or *Fast delivery* are anywhere on the
  home page, step 3d was missed.

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

```text
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

## Refreshing what the home page leads on

The home page's running order is POS sell-through, measured once and stored in a
theme setting so the page has no runtime dependency on anything. To refresh it:

```shell
node scripts/shopify/sell-through.mjs
```

It reads only, prints the measured order, and then prints a **paste-ready**
value for **Theme editor → Home rails → "Rail order"**. Paste that line in
whole. Do not hand-type it: each row is `Label~tag~collection-handle`, the three
are different strings (the tag "Tracksuits & Sets" belongs to the collection
"tracksuits"; "Perfume" belongs to "fragrance"), and a row in any other shape is
skipped silently.

Sell-through moves over months, so once or twice a year is plenty.

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

**Shopify's filter panel is not carried over; sorting is.** The old collection
page had Shopify's facet sidebar (availability, price) and a sort control. The
new grid has **sort** — Newest, Price low to high, Price high to low, as three
plain links that work with JavaScript off — but **no facet filters**, and that
is a deliberate trade, not an oversight.

The reason is measured, not assumed. Storefront facet filters and tag-addressed
URLs are mutually exclusive on Shopify: verified against the live shop
2026-08-21, `/collections/all/sneakers?filter.v.availability=1` returns **zero**
products, while the same filter on `/collections/sneakers` works normally. Since
the navigation reaches categories by tag — which is the only way to reach all 703
products while 559 of them sit in no collection — facets cannot come with it.

What is lost is mostly covered elsewhere: sold-out products are badged in the
grid and their sizes are visible-but-unbuyable in the overlay, so "in stock only"
matters less than it did; price is served by the **Under R500** collection and
by price sorting. If you want the full facet panel back, the trade is the
opposite one — repair the collections (below), then point the navigation rows at
`/collections/{handle}` instead of `/collections/all/{tag}` in
`snippets/marathon-nav.liquid`.

**Nine categories are missing from their collections.** Measured 2026-08-21:
559 of 703 live products are in no category collection at all, including all 64
tracksuits and all 34 bags. The navigation is unaffected — it addresses
categories by tag and reaches every product — but the **home page rails** are
filled from collections, so those categories get no rail. Repair is one
idempotent command, dry-run by default:

```shell
node scripts/shopify/sync-collections.mjs             # plan only, writes nothing
node scripts/shopify/sync-collections.mjs --commit    # apply
```

It writes Shopify collection membership only. Nothing is created, archived,
deleted or unpublished, and no RTDB node is touched.

**The dry run was already done** — 2026-08-21, took roughly an hour because it
reads current membership for all 3,457 products before it plans anything:

```text
would-change: 515 · already-correct: 154 · failed: 49 · live-drift: 3
```

The 49 failures are all `fetch failed` — transient network, not refusals — and
the script is idempotent, so a second run picks them up. The 3 drift rows are
pre-existing and are reported, never touched: three products that
`/shopify_publish` believes are live but that Shopify does not publish to the
Online Store (`Jean black Y8105`, `JEAN Y8161`, `JEAN BLUE Y8161`). Switching
each off and on again in the publishing page reconciles them.

**I did not run `--commit`.** The storefront does not need it — the navigation
reaches all 703 products by tag either way — and 515 membership writes on a live
shop is a change worth watching happen rather than finding done. Run it when you
have a few minutes to look at the result.
