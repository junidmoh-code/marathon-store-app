# PostHog on marathonclub.co.za

What is measured, where it comes from, and the one paste that only an admin
can do.

PostHog project: **Default project** (id 702977) on `https://us.i.posthog.com`.
Key `phc_AF6N3oHUSnSVfKqKxKDVvYgZKkmd3cY244Ww6qo334hP` is PostHog's **public**
project key. It can only send events, not read them, so it is fine in page
source.

## What fires where

| event | fired by | when |
|---|---|---|
| `$pageview`, `$pageleave`, `$autocapture`, `$rageclick`, `$web_vitals` | posthog-js (`snippets/posthog.liquid`) | every storefront page |
| session replay (`/s/`) | posthog-js | every storefront page; inputs masked (PostHog defaults) |
| `product_viewed` `source: product_page` | `snippets/posthog.liquid` | product page load |
| `product_viewed` `source: grid_panel` | `assets/marathon-storefront.js` `open()` | shopper taps a photo and the quick-view panel opens (not when Back/Forward reopens it) |
| `size_selected` `source: grid_panel` / `wishlist` | `marathon-storefront.js` | size tapped in the panel / in the Loved list |
| `size_selected` `source: product_page` | `assets/marathon-posthog.js` | Dawn's `variantChange` after a size is picked on the product page |
| `add_to_cart` `source: grid_panel` | `marathon-storefront.js` `addToCart()` | `cart/add.js` succeeded |
| `add_to_cart` `source: wishlist` | `marathon-storefront.js` `performWishlistAdd()` | `cart/add.js` succeeded, including the size pick that adds and closes the size pop-out |
| `add_to_cart` `source: product_page` | `marathon-posthog.js` | Dawn's `cartUpdate` from `product-form` (success only) |
| `cart_viewed` | `snippets/posthog.liquid` | `/cart` page (cart type is "notification", so there is no drawer) |
| `checkout_started`, `checkout_contact_info_submitted`, `checkout_address_info_submitted`, `checkout_shipping_info_submitted`, `payment_info_submitted`, `checkout_completed` | `theme/posthog-pixel.js` (custom pixel, **pasted in admin**) | Shopify checkout steps |

`add_to_cart` properties (`handle`, `title`, `variant`, `variant_id`, `price`,
`qty`, `currency`) come from **Shopify's own response** to the add, so they
describe what actually went into the cart. A refused add, such as a sold-out
size, sends nothing.

`product_viewed`: `handle`, `title`, `price`, `available_sizes` (the number of
sizes that can be bought right now).

`checkout_completed`: `total`, `revenue`, `currency`, `subtotal`, `shipping`,
`order_id`, `item_count`, `handles`. No email, name, phone or address is sent
from checkout.

**Not counted:** the shop's own automated shoppers (marathon-site-agents, user
agent `MarathonShopperAgent` / `MarathonSiteAgents`). PostHog is never started
for them.

## The paste: 4 steps, one time only (an admin must do this; there is no API or CLI for it)

The checkout pages belong to Shopify, not the theme, so the theme snippet
cannot see them. Shopify's **Customer events** run a pixel there instead.

1. **Shopify admin → Settings → Customer events → Add custom pixel.** Name it
   `PostHog` → **Add pixel**.
2. In the code box, **delete the placeholder code** and paste the **whole** of
   `theme/posthog-pixel.js` from this repo.
3. In **Customer privacy** on the same page, set **Permission → Not required**
   and **Data sale → Data collected does not qualify as data sale**.
4. Click **Save**, then **Connect** and confirm.

Check that it worked: open the store, add something to the cart, press
**Check out** and fill in the contact step. Then look at
[PostHog → Activity → Live events](https://us.posthog.com/project/702977/activity/explore).
`checkout_started` and `checkout_contact_info_submitted` should show up within
a minute, on the **same person** as your storefront `$pageview`s.

### Why the checkout events join the storefront visitor

The storefront's posthog-js keeps its identity in the first-party cookie
`ph_<key>_posthog` (`distinct_id`, plus `$sesid[1]` = the session id). Checkout
is on the same domain, and the pixel reads that cookie through Shopify's
`browser.cookie.get`. It then starts posthog-js with
`bootstrap: { distinctID, sessionID }` and `persistence: "memory"`. Checkout
events therefore land on the same person and the same session as their
storefront browsing and replay, instead of a new anonymous visitor. Verified on
2026-11-01 in real posthog-js on the live domain: the bootstrapped instance
reports the storefront's exact distinct_id and session id.

## Troubleshooting

| symptom | cause / fix |
|---|---|
| No storefront events at all | Open the site and check DevTools → Network for `us.i.posthog.com/i/v0/e/` (events) and `/s/` (replay). Nothing there: check `{% render 'posthog' %}` is still just before `</head>` in `layout/theme.liquid` of the **published** theme. A theme published since then (for example by the marathon-site-agents pipeline) only carries PostHog if it was duplicated from a theme that had it. |
| Requests show but are blocked (`ERR_BLOCKED_BY_CLIENT`) | An ad blocker on that browser. Expected for a share of visitors. The fix is a PostHog reverse proxy (posthog.com/docs/advanced/proxy). It is not set up. |
| Events arrive but no replays | PostHog → Settings → Replay → "Record user sessions" must be on. It was on 2026-11-01. Replays under the minimum duration are dropped by design. |
| No checkout events | The pixel isn't connected. Settings → Customer events → PostHog must say **Connected**. If it does, open a checkout with DevTools: the pixel runs in an iframe named `web-pixel-sandbox-CUSTOM-…`, and its console shows any error. If step 3 was left at "Required"/"Analytics", the pixel only runs after a shopper gives consent; set **Not required**. |
| Checkout events on a different person from the storefront | The pixel could not read the `ph_…_posthog` cookie (blocked third-party/first-party cookies, or a shopper who went straight to a checkout link). The events still count, just unjoined. Expected to be rare. |
| `checkout_completed` counted twice | Shopify can resend it if the thank-you page is reloaded. Count distinct `order_id` for revenue and orders. |
| Too many `$autocapture` events | Turn autocapture down in PostHog → Settings → Autocapture (no code change), or set `autocapture: false` in `snippets/posthog.liquid`. |

## Turning it off

- **Whole thing:** remove `{% render 'posthog' %}` from `layout/theme.liquid` and
  push. Every custom event goes through `window.MarathonAnalytics`, which then
  never exists, so the grid, wishlist and product page keep working untouched.
- **Or roll back the theme:** Online Store → Themes → **"Marathon — photo-first
  (pre-PostHog)"** → Publish. That is the exact live theme from before PostHog.
- **Checkout only:** Settings → Customer events → PostHog → **Disconnect**.
