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

## 2. Glass
- Translucent white, blur **inside the object's own box**, a 1px brighter rim, a
  lit hairline on the top edge (`.sky-sheen`, from home.png), a soft blue shadow.
- Between objects the photo is raw. Never a full-width glass sheet behind a page.
- Strengths, measured off the references: soft pills/search ≈ 16% white, desktop
  cards ≈ 30%, phone cards a bright gradient to ≈ 85% at the bottom, solid
  pills/active segments ≈ 96%.
- Performance: blur is for the big objects (cards, bars, popups). Small rows get
  plain translucent white without `backdrop-filter` — the till's GPU is weak.

## 3. Colour
| Token | Use |
|---|---|
| white `#fff` | text on glass, icons, the wordmark |
| `--sky-ink #001431` | product names on bright (phone) cards, text in white fields |
| `--sky-navy #0033f5` | price on bright cards, the active segment/chip label, plus icons, the chosen size, primary buttons |
| `--sky-navy-deep #0a2a8f` | pressed primary |

No orange, no accent colour. Red survives only where it means something (the
shop-switch alarm, a refusal); green only for a success state. Nothing decorative.

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
- **SkySegmented** — glass pill toggle; the active segment is solid white with navy text.
- **Chip row** — glass pills; brand chips show a simple-icons mark in navy
  (`brandLogos.js`), or the name in bold caps when simple-icons has no mark.
- **SkySearch** — big glass pill, search icon left, divider + camera (scan) or
  filter button right.
- **ProductStage** — the product's cut-out (`photoCutoutUrl`, only while
  `photoCutoutFor === photoUrl`) standing on a glass podium with a drop shadow;
  otherwise the full-resolution photo (HiResPhoto, same source and cache) in a
  white rounded frame filling the stage, no podium.
- **SkyPlus** — round solid-white button, navy plus.
- **SkyBottomBar** — glass bar: cart icon, divider, item count, solid white pill CTA.

## 6. Layout
- Phone (reference 426px wide): 16–18px gutters; home = 2×2 tiles of ≈183×180
  starting about a third of the way down so the floor reflection shows below;
  order view = header, toggle, store chips, "Place order", search, 2-up cards
  (3-up ≥600px, 4-up ≥820px), bottom bar.
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
dim whites → white, the old `#4A7FFF` → white text / navy solid buttons,
orange/amber → white, form fields → white with navy ink. To extend: add the
serialised value (`rgb(r, g, b)` with spaces) to the matching block. Never add a
rule that paints over the room.
