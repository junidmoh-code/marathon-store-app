# Sky DNA — how Marathon Club looks

The spec is the three images in this folder — `home.png`, `assistant-phone.png`,
`assistant-desktop.png` — and the room photo `public/assets/sky-room.jpg`. Where a
word here and an image disagree, the image wins. Code: `src/styles/sky.css`
(tokens + components), `src/styles/sky-theme.css` (the rest of the app),
`src/components/sky/` (React pieces).

## 1. The room
- One background, everywhere: `sky-clear.jpg` (Junid 5 Nov: the plain sky of
  his mock-ups replaces the room photo, which stays in the repo unused),
  and on phones / portrait tablets the tall `sky-clear-phone.jpg`,
  `cover`, centred, **untouched** — no
  overlay, gradient, tint, blur or darkening over it, ever.
- It is a `position:fixed` div at `z-index:0` in `index.html` (never
  `background-attachment:fixed`, which iPad Safari ignores). `#root` is
  `z-index:1`.
- Modal scrims do not darken the photo either. A popup is glass in its own box.
- A screen with its own world (the customer TV board) calls `useSkyOff()`, which
  sets `html[data-sky="off"]` and hides the room and the theme layer.

## 2. Glass (one recipe, `src/styles/sky.css`)
- **Standard**: `rgba(255,255,255,.40)`, `backdrop-filter: blur(28px) saturate(1.6) brightness(1.05)`
  (with the `-webkit-` prefix), 1px rim at 75% white, inset top highlight
  `0 1px 0 rgba(255,255,255,.9)`, outer shadow `0 12px 32px rgba(10,60,140,.22)`.
  A light strip in the photo behind it drops to a soft glow, never a hard line.
- **Strong** `.58`: popovers, modals, sheets, sidebars, anything dense with text.
- **Active** = brighter glass (`.86`) with bold navy, not a solid fill. Solid navy
  is only for primary buttons and the chosen size.
- **Write the backdrop filter literally, never through `var()`**: WebKit (Safari,
  iPad) computes `-webkit-backdrop-filter: var(--x)` as `none`.
- **Popovers render in a portal at `<body>`** (`SkyPopover`): a backdrop filter
  does not run under an ancestor with its own backdrop filter or transform +
  overflow clipping. No `filter: blur()` on content, ever.
- Glass only inside an object's own box. Between objects the photo is raw.

## 3. Colour
| Token | Use |
|---|---|
| `--sky-ink #0b2a52` | ALL text on glass — names, labels, icons |
| `--sky-ink-2 #1f3d66` | secondary text (the spec's `#3b5f8f` measured 3.7:1 on glass) |
| `--sky-ink-deep #04122b` | text sitting on the bare sky (the "Place order" heading) |
| `--sky-navy #0026c2` | prices, key numbers, plus icons, active labels, primary fills (`#0033f5` measured 4.1:1) |
| white | ONLY the wordmark and the four home tiles, with `--sky-text-shadow` |

No orange, no accent colour. Red survives only where it means something (the
shop-switch alarm, a refusal), as deep red text on light glass; green likewise.

**The contrast gate** (`npm run contrast`, `scripts/sky-contrast.mjs`, CI on this
branch): every route at 1440×900 and 390×844 in Chromium and WebKit; every text
element is measured against the pixels actually behind it; anything under 4.5:1
fails. Text over the deep-blue top of the room cannot reach 4.5:1 in ANY dark
ink — such text must sit on glass.

## 4. Type
Inter (Google Fonts, loaded in `index.html` the way the TV board loads Archivo).
Wordmark: "marathon" Inter 900 italic, slightly skewed; "CLUB" 800 italic,
letter-spaced ~1em, under it. Headings 800, names 700 (phone) / 500 (desktop),
prices 700–800 tabular, "R" and no decimals.

## 5. Components (`src/components/sky/Sky.jsx`)
- **SkyHeader** — round glass grid button left (home), wordmark centred, round
  glass user button right, a small glass pill under the logo naming the screen
  (ASSISTANT) or the device/store (2POS). Every screen gets it: home and the
  order view draw their own; `AppInner` puts it above every other screen.
- **SkyStorePill** — on the Store Assistant order view the pill under the logo
  is the STORE and the PRODUCT TYPE ("TROPHY · SNEAKERS", bold caps + chevron);
  tap → body-level glass popover: "Order for" (the account's stores, current
  one brighter; a pick goes through the red switch-confirm) then "Products"
  (Sneakers / Clothing — the same mode setter). One store = Products only.
  There is no Sneakers/Clothing toggle on the page. Pulses once (600ms) when the store
  differs from this device's last-used store; none under reduced motion.
  Desktop: the Stores nav tab opens the same list; one open at a time.
- **SkySegmented** — glass pill toggle; the active segment is solid white with navy text.
- **Chip row** — glass pills; brand chips show a simple-icons mark in navy
  (`brandLogos.js`), or the name in bold caps when simple-icons has no mark.
- **Phone brand strip** (`SkyBrandStrip`, below 768px only) — under the search: one
  full-bleed row of 44px round glass logo pills, scroll-snap, no scrollbar, "All"
  first, then every brand by count (`components/assistant/brandFilter.js`, the same
  options and the same `brand` value as the desktop chip row, held by
  AssistantView). Tap the active chip again = All. iPad portrait has no picker.
- **SkySearch** — big glass pill, search icon left, divider + camera (scan) or
  filter button right.
- **ProductStage** — CUT-OUTS ARE OFF (Junid, 3 Nov: `SHOW_CUTOUTS = false` in
  Sky.jsx): every product shows its original photo. When on: the shoe's cut-out on a glass podium, only for footwear
  whose cut-out passed the gate (`category === "Footwear"`,
  `photoCutoutQuality === "shoe"`, `photoCutoutFor === photoUrl`; see
  tools/cutouts/README.md); otherwise the ORIGINAL full-resolution photo
  (HiResPhoto, same source and cache), rounded, contained, never cropped, on a
  faint translucent surface. Never a whole-object cut-out.
- **Unavailable size** (Junid 5 Nov, a defect fix) — on the phone sheet, the
  desktop quick view and the hover quick-add alike: the square at 35% (surface
  and size number), a navy diagonal strike corner to corner, and the on-hand
  count as a full-strength navy "0". Still tappable: the tap raises the live
  why-note and "Available now instead". `scripts/sky-availability.e2e.mjs`
  proves it in Chromium and WebKit; the contrast gate checks the "0".
- **Barcode Studio** (Junid 5 Nov mock-up, "exactly what I want") — desktop:
  three columns on the bare room — a glass sidebar (white wordmark, Home,
  LOCATION / CATEGORY selects, PRINTER), the white "Barcode Studio" heading,
  subtitle, clear search pill, white product count and a two-up grid of
  compact cards; on the right a "Print tray" glass card (white title, white
  count pill, Clear, items, navy Print button) and a "Label preview" card.
  Card (`BcsCard`, also on phone): 54px white-framed photo, the name on one
  line, "N sizes", a chevron that turns down when open; open, the sizes are
  glass tiles (size, "on hand N" in dark red/amber/green) and a picked tile
  goes solid navy with a white copies stepper. FIXED FRAME (Junid 5 Nov,
  >=1024px): the page never scrolls — header, sidebar, title/search/count
  and the right cards hold still; only the product list scrolls (hidden
  scrollbar), a wheel over the title scrolls it too; the tray scrolls inside
  itself. `scripts/sky-barcode-scroll.e2e.mjs` proves it (CI). Below 1024px
  the stacked layout stays with a sticky header. White text there carries the
  sky text shadow and `data-contrast-exempt`, as the home tiles do.
- **SkyPlus** — round solid-white button, navy plus.
- **SkyBottomBar** — slim (48px) glass bar: cart icon, divider, item count,
  solid white pill CTA. It appears only once the cart holds something.
- **Admin hub** (Junid 5 Nov mock-up) — one flat grid of clear glass tiles
  (the home-tile recipe): white line icon, white bold name, the badge a white
  pill with navy number; no group headings, no descriptions (they are the
  tooltip), no ADMIN pill. 4-up from 900px, 2-up on the phone with the badge
  in the tile's corner. Desktop tiles are 84px tall and the wordmark is the
  ordinary (not large) one here. NO live cards on this screen (Junid 5 Nov:
  Hub Count & Displays, Shipment Release, Display Registration removed; the
  code stays, `SHOW_HUB_LIVE_CARDS = false` in App.jsx brings them back).

- **Phone Store Assistant — FROZEN** (Junid 5 Nov). The approved layout is
  `design/assistant-phone-approved-390.png` / `-430.png` (his minimal mock-up:
  bare white header icons, the store line as plain white caps, a faint glass
  search with camera, a white "All" pill then bare white brand logos, pale
  glass cards 172 wide with a centred photo, white name, white price and a
  glass plus). `scripts/sky-phone-visual.e2e.mjs` fails CI on more than 1%
  pixel drift (photos and prices masked). ANY change to the phone assistant
  layout needs Junid's say-so; only then re-run it with `--update`.
  **Re-frozen 6 Nov (sky-wall v3, Junid's six changes):** type and brand
  logos up ~11% (names 12.75, prices 17.25, chips 32 tall); the header sits
  14px below the real safe-area inset (`--sky-sat`/`--sky-sab`/`--sky-sal`/
  `--sky-sar` in sky.css wrap `env(safe-area-inset-*)` so a test can simulate
  a notch); the top band (logo, store line, search, brands) is sticky and only
  the grid scrolls under it, its glass fading in once scrolled; no back-to-top
  button; no three-dot on the tiles (the admin actions moved into the sheet);
  the size picker is `SkySheet` (src/components/sky/SkySheet.jsx): dimmed,
  blurred grid; a solid glass sheet with handle and close; drag down, close,
  Escape or the dimmed area dismiss it; size pills (chosen = white), counts
  behind a long press; stepper; the Display Partner (Optional) row; a white
  full-width Add to Cart. `scripts/sky-wall-v3.e2e.mjs` proves all of it.
- **Laptop Store Assistant** (Junid's mock-up, 6 Nov, revised the same day):
  no nav pill; ONE small "STORE · TYPE" pill beside the account round (no
  search round, no pills under the wordmark); the search bar is 82vw; the
  brand row is bare white logos on no background, every brand (no "…"),
  sliding sideways, and it FLOATS — the sneakers scroll up under it; four-up
  LANDSCAPE cards (photo left on a plain background, white name, white price
  behind a hairline), no three-dot on the cards (the actions are in the
  popup). Only the sneakers scroll (`.ad-scroll`). All in vw.
- **THE ONE OVERLAY** (Junid, 6 Nov — popup readability): `SkyOverlay`
  (src/components/sky/SkyOverlay.jsx) — a body-level portal, a scrim that dims
  and blurs (rgba(10,40,100,.42), 6px), the panel on strong glass with navy
  text; anchored on a laptop, a bottom sheet on a phone (handle, drag down,
  max 70vh), centred dialogs; Escape closes only the top one; focus trapped
  and returned to the anchor; page scroll locked and restored. Option rows are
  56px glass cards, the current one white with a navy check. `SkyConfirm` is a
  message card + two button cards (Cancel navy outline, the action solid
  navy) — no red. Every `SkyPopover` runs through it. The legacy dark
  overlays still inside the page get the same scrim on the sky (sky.css).
  The panels are more opaque than the 0.62 brief (0.86, cards 0.9) so they
  stay readable where a device draws no blur.
- **ONE HEADER, PINNED** (Junid, 6 Nov): every screen but home, the order
  view and the TV board wears the shell's `SkyShellHeader` (grid, wordmark, the
  screen pill whose chevron opens the view switcher, account). It is sticky at
  the top; everything under it scrolls; its glass fades in once scrolled; it
  publishes `--sky-shell-h` so 100vh workspaces fit under it and top-sticky
  rails stick below it. Barcode Studio opts out (its own fixed frame). Legacy
  per-screen headers — the italic "marathon CLUB" rail wordmarks and the
  "← Switch View · Viewing as:" bars — carry `data-legacy-header` and are
  hidden on the sky (kept for the sky-off look). `scripts/sky-shell.e2e.mjs`
  counts exactly one wordmark per screen and sweeps src/ for untagged ones.
- **Warehouse, phone** (Junid, 6 Nov): `WarehouseTop` draws no header and no
  "Switch View · Viewing as · Incoming" strip — the hub pill and Switch Hub,
  the live line, the tabs as tiles. ONE GLASS LEVEL PER NESTING: the hub pill,
  Switch Hub, tiles, chips and the Today group are standard glass (0.40) with
  navy ink; the order cards inside are a 1px rim on the same surface; Mark as
  Sent solid navy, Mark as Out of Stock soft red glass with navy text, the rest
  navy outlines; the selected chip solid navy.
- **No zoom** (Junid 5 Nov): the viewport meta forbids scaling, html/body are
  `touch-action: manipulation`, `src/device/zoomLock.js` cancels WebKit pinch
  gestures, every field is ≥16px on touch screens (the phone search is drawn
  at 79.7% so it looks 12.75px). The only thing that zooms is the photo
  viewer (`ZoomImage`: pinch 1–4×, pan, double-tap 1 ↔ 2.5, own transform).
  `scripts/sky-zoom-lock.e2e.mjs` proves both.
- **One screen on a laptop**: the home and the admin view never scroll; the
  admin unit `--u` shrinks with the window height and the number of rows.

## 6. Layout
- Phone (reference 426px wide): 16–18px gutters; home = 2×2 tiles of ≈183×180
  starting about a third of the way down so the floor reflection shows below;
  order view (compact top band, Junid 5 Nov) = header with the store pill
  (store + product type), search, brand strip — 12px apart — then 2-up cards
  (3-up ≥600px, 4-up ≥820px), the bar only with a cart. No store row, no
  toggle, no "Place order" heading: at 390x844 two full card rows show. Desktop:
  the card stage shrinks with the viewport height so three full rows fit at 1440x900.
- Desktop/iPad landscape (reference 1672px): sizes in `vw` with px clamps so
  1280–1680 keep the reference proportions. Home = one row of four tiles whose
  bottoms sit on the room's horizon (58% down). Order view = nav pill
  (Products · Orders · Stores) · wordmark · search + account; centred search
  pill at ≈48% width; logo chips; 4-up cards in an ≈81% wide grid (3-up < 1180px).
- `prefers-reduced-motion` turns every transition and lift off.

## 7. The rest of the app (`sky-theme.css`)
Screens without a reference keep their markup; the theme layer re-maps the old
dark palette as the browser serialises it into `style=""`: page blacks →
transparent, dark panels → glass, faint surfaces → visible glass, dim greys and
dim whites → navy, the old `#4A7FFF` → navy text / navy solid buttons (white
text kept only on solid fills), orange/amber → navy, header bands drawn as
gradients over the photo → glass, the old `/hero/*` photos hidden, sidebars →
strong glass, form fields → white with navy ink. To extend: add the
serialised value (`rgb(r, g, b)` with spaces) to the matching block. Never add a
rule that paints over the room.

## 8. Admin, Shopify, Social (Junid, 6 Nov) — `src/styles/sky-admin.css`

**The overlap bug, and the rule that stops it coming back.** On Shopify and
Social the page's sticky search/tab bar was drawn 103px below its own slot
(measured: flow top 102.5px, rendered 205.5px = the shell's height), leaving a
band under the header and lying on the counts and first rows. Two causes
together: the page wrapper's `overflow-x:hidden` made it a scroll container
that never scrolls (so the bar stuck to it, not the window), and the shell
rewrote every sticky `top:0` to `top:var(--sky-shell-h)` — inside a box that
never scrolls, a sticky offset is just a shift. Fixed once for every screen
(`sky.css`): page wrappers under the shell CLIP (`overflow-x:clip`, not a scroll
container), a page sticky bar pins under the shell at `top:var(--shell-h)` with
the shell's glass, a sticky bar inside a REAL scroller keeps `top:0`, and the old
44–50px status-bar paddings are gone (content starts under the header). The check:
`scripts/sky-admin.e2e.mjs` — no two visible text boxes intersect and the first
content starts within 24px of the header, per admin route, 390x844 and 1440x900,
Chromium and WebKit, on the REAL App over an offline synthetic database
(`dev/sky-app.html`, `dev/vite.harness.config.mjs`, `dev/fake-firebase/`).

**The admin design system** (on while an admin screen is open —
`html[data-sky-admin="on"]`): one surface level (sections are standard glass;
glass inside glass keeps only its rim); inputs 0.18 white with a 1px navy-tinted
rim, navy text, 16px minimum, placeholder navy 60%; read-only = plain navy text
with a lock; one primary (solid navy) — per-row actions are secondary (navy
outline); destructive = navy outline + a red ICON, never red text; chips are
glass pills, selected solid navy; status chips `[data-status]` live/approved navy
outline, awaiting/draft neutral glass, blocked red outline with navy text; chip
and tab rows are ONE scrolling line (`.sky-row1`); notices are slim inline glass
with an icon and their action inline (`.sky-notice`); empty thumbnails are
neutral glass with a line icon (`.sky-thumb-empty`); list rows are thumb 56 ·
one-line bold title · one secondary line · status chip right (`.sky-li`).
Disabled controls keep full-strength ink with a dashed rim (they must still be
read). Admin ink is `#000a1c` — `#04122b` measured 4.36:1 for titles on the
phone's mid-blue sky. The Admin home cards are navy ink on standard glass (the
5 Nov mock-up's white names broke "navy on glass, never white").
Contrast: `node scripts/sky-contrast.mjs --admin --webkit` judges every admin
route including field values, disabled and destructive controls.

**Navigation: the grid button goes up ONE level** (`src/components/sky/skyNav.js`,
explicit hierarchy, never browser history):
Home → Admin (the Admin panel on Home) → card (Products / any section, Shopify,
Social, every Admin card or `#admin/…` screen) → item (`#product/{id}` → Products;
`#shopify/{pid}` → Shopify; `#admin/users/{uid}` → Users). Store Assistant,
Warehouse and Display Check sit directly under Home. Off Home the button shows a
small navy back chevron left of the grid; a 500ms long-press goes Home. Browser
/ OS back is unchanged.
