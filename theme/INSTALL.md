# Wiring the storefront search — install, preview, publish, revert

## What this does

The search box stops using Shopify's search and uses the app's own index.

| query | Shopify's search | ours |
|---|---|---|
| `gripshot` | **No results** | **12** correct products |
| `adidas` | unrelated sneakers | **34** |
| `adizero` | nothing useful | **3 of 3** |
| `lacoste` | unrelated | **48** |
| `samba` | unrelated | **12** |
| `adidos` *(typo)* | nothing | **34** |

Shopify searches the compliant titles, and every brand, sub-label and model term
is stripped out of those before a product is pushed — so the words a shopper
types are exactly the words Shopify cannot see.

**Two files. Nothing else changes.**

---

## ⚠️ I could not do this part myself

The app has **no theme API access** — `read_themes` is not granted, and both
`themes` (GraphQL) and `/admin/api/…/themes.json` (REST) return
`ACCESS_DENIED`. The admin's theme editor renders inside a cross-origin iframe
that browser automation cannot reach: the page loads, the DOM is empty, the
screen is blank.

So the theme was **not** duplicated and there is **no preview URL yet.** Both are
in step 1 below and take about a minute.

What I *could* do, and did: write the code against the live theme's real markup
(it is a Dawn derivative — `#ProductGridContainer`, `#product-grid`,
`.template-search__results`), then **run it against the live storefront in a
browser** and fix what broke. Three real bugs came out of that testing:

1. the 12 cards rendered as a 5,000px unstyled column, because the empty-state
   template ships the `<ul>` without the theme's grid classes;
2. the "No results found for …" sentence survived, because it is a *sibling* of
   the grid container, not inside it;
3. the **browser tab title** still read `Search: 0 results found for "gripshot"`
   — rendered server-side, so it survives everything done to the DOM and leaks
   the term into history and shared links.

All three are fixed in the file. None would have been found by reading the
template.

---

## 1. Duplicate the theme — never work on the live one

1. **Online Store → Themes**
2. On **Feather** (the live theme, id `150249734293`) → **⋯ → Duplicate**
3. Rename the copy to **`Feather — search wiring`** so it is obvious which is which
4. On the copy → **⋯ → Preview**. That preview URL is what you test on.

The live theme is untouched by everything below.

## 2. Add the file

On **the copy** → **⋯ → Edit code**

1. In the **Assets** folder → **Add a new asset → Create a blank file** →
   name it `marathon-search.js`
2. Paste the whole of `theme/assets/marathon-search.js` from this repo
3. **Save**

## 3. Include it

Still in **Edit code**, open **Layout → `theme.liquid`**.

Immediately before the closing `</body>` tag, add:

```liquid
<script src="{{ 'marathon-search.js' | asset_url }}" defer="defer"></script>
```

**Save.**

That is the whole install. It covers **every** entry point — the header search,
the search modal, the mobile drawer and the empty-state form — because they all
submit to `/search`, and the script acts on the `/search` page rather than on any
one form.

## 4. Test on the preview

Open the preview URL and search each of these:

```
adidas      adizero    lacoste    samba    air max    gripshot
adidos      lacosteh   sambba
```

Expected, verified against live data on 2026-08-17:

| query | products |
|---|---:|
| adidas | 34 |
| adizero | 3 |
| lacoste | 48 |
| samba | 12 |
| air max | 2 |
| gripshot | 12 |
| adidos *(typo)* | 34 |
| lacosteh *(typo)* | 48 |
| sambba *(typo)* | 12 |

And check the thing that is easy to miss: **the word you typed must not appear
anywhere** — not in the page, not in the browser tab.

## 5. Publish it

**Online Store → Themes** → on **`Feather — search wiring`** → **⋯ → Publish** →
confirm.

## 6. Revert

Two ways, both instant.

**Undo the publish** — the old theme is still in the theme list:
Themes → on **Feather** → **⋯ → Publish**. That is the whole rollback; nothing
was deleted.

**Or disable the wiring without switching themes** — Edit code →
`theme.liquid` → delete the one `<script>` line → Save. The search box returns to
Shopify's own results immediately.

---

## If the endpoint is down

The script **fails soft on purpose.** If the Cloud Function is unreachable or
slow, the shopper keeps whatever Shopify rendered — worse results, but a working
page. It never leaves a blank screen because of a cold start.

## What it never sends

The endpoint is read-only and public, and returns only what a result card needs:
handle, title, price, image, per-size availability as booleans, and the
collection. Never the true brand name, `stockPrice`, cost, supplier, SKU,
barcode, the internal product id, or any per-location quantity. The query is not
echoed back in the response either.
