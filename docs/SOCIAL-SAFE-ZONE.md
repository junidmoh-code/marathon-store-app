# Social artwork: the 4:5 safe zone

## 1. How the graphic is actually produced (finding, before any change)

**(a) is true. The photo comes from the image model and all type is composited in code.**

The code path from generation to upload (`functions/index.js`, `generateOnePost`):

1. `generateSocialScene()` — Nano Banana Pro (`NBPRO_MODEL`) returns a photograph at
   aspect `9:16` for a story/reel, `4:5` for a feed post. The scene prompt
   (`socialCaption.buildScenePrompt`) forbids the model from rendering any lettering.
2. `normalizeSocialImage()` — sharp, `fit: "inside"`, to at most 1080x1920.
3. `compositeSocialDesign()` — sharp composites an SVG built by
   `functions/lib/social-design.cjs` → `buildOverlay()` → `buildVerticalOverlay()`
   (story/reel) or the rail layout (feed). Rendered by librsvg with the bundled
   Archivo font. Every word — wordmark, product name, price, CTA, URL — is here.
4. `uploadSocialImage()` — the composited JPEG to
   `aiStudio/social/posts/{postId}/0_{token}.jpg`.
5. `socialTwin.buildFeedTwin()` — the feed twin record copies the story's `media`,
   i.e. **the same 1080x1920 file** goes to the feed.
6. `scripts/social/publish.mjs` (Mac mini) sends `post.media` to Instagram/Facebook.

### The coordinate constants (story, `social-design.cjs` on `main` f0a27eda)

```
CANVAS.story = { w: 1080, h: 1920, safeTop: 250, safeBottom: 260 }
CANVAS.reel  = { w: 1080, h: 1920, safeTop: 250, safeBottom: 320 }
x = 72
MARATHON        y = safeTop + 46                     (40px, 700, ls 9)
CLUB            y = safeTop + 82                     (21px, 400, ls 14)
footTop         = max(safeTop + 200, h - safeBottom - stackH),  stackH = n*104 + (n>1 ? 150 : 60)
brand           y = footTop                          (21px, wrap(brand, 24, 1))
name            y = footTop + 27                     (19px, wrap(rest, 26, 1)  ← the ellipsis)
price           y = footTop + 66                     (27px)
SHOP IT ONLINE  y = h - safeBottom + 42
storefront      y = h - safeBottom + 78
```

### Measured pixel boxes (rasterised, the 4 Sep NIKE NOCTA R850 story)

| element | x | y | vs the 4:5 feed crop (keeps y 285..1634) |
|---|---|---|---|
| MARATHON | 74..363 | **266..296** | **sliced** |
| CLUB | 72..169 | 316..332 | inside |
| NIKE | 73..130 | 1481..1495 | inside |
| NOCTA TRACKSUITS HOT CURR… | 73..427 | 1509..1523 | inside, **truncated** |
| R850 | 74..134 | 1542..1562 | inside |
| SHOP IT ONLINE | 72..293 | **1686..1702** | **entirely cut off** |
| MARATHONCLUB.CO.ZA | 73..341 | **1724..1738** | **entirely cut off** |

The live file (`-P0_QigylnR1O3IiD1m8`, twin `-P0_QpEXxR2GTAEXUVYc`) is 1072x1920 and
was published to both surfaces.

The truncation: `splitName` gives brand `NIKE`, rest
`NOCTA TRACKSUITS HOT CURRY FN 9868-717`; `wrap(rest, 26, 1)` keeps
`NOCTA TRACKSUITS HOT CURRY` (26 chars), sees more words, and replaces the last
character with `…`. A character count, not a measured width.

## 2. The fix (branch on (a))

- One vertical layout spec (`verticalLayout`) whose every text element lies inside
  **y 345..1575** of the 1080x1920 canvas. Rendered twice from the same spec:
  story at 1080x1920, feed at a native 1080x1350 (the same photograph's central
  1350 rows, the same elements translated up by 285).
- The story record gains `artwork: { story, feed }`; its feed twin's `media` is the
  1080x1350 file, and the publisher picks the variant for the surface
  (`mediaForSurface`), falling back to `media` for every older record.
- Product names are measured against Archivo's real advance widths and shrink,
  then wrap, to fit. There is no ellipsis anywhere in the design layer.
