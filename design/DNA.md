# Sky DNA — how Marathon Club looks

The spec is the three images in this folder — `home.png`, `assistant-phone.png`,
`assistant-desktop.png` — and the room photo `public/assets/sky-room.jpg`. Where a
word here and an image disagree, the image wins. Code: `src/styles/sky.css`
(tokens + components), `src/styles/sky-theme.css` (the rest of the app),
`src/components/sky/` (React pieces).

## 1. The room
- One background, everywhere: `sky-room.jpg`, `cover`, centred, **untouched** — no
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
- **SkyPlus** — round solid-white button, navy plus.
- **SkyBottomBar** — slim (48px) glass bar: cart icon, divider, item count,
  solid white pill CTA. It appears only once the cart holds something.
- **Admin hub** — ONE layer of glass per card: the live cards (Hub Count,
  Shipment Release, Display Registration) draw their own glass, with no glass
  frame around them; their buttons and the tool cards' icon tiles are light
  rims, not white slabs.

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
