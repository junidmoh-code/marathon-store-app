# Sky phone order grid: before / after (28 Nov 2026)

These captures come from the offline harness (`dev/sky-harness.html?screen=phone&bulk=1500`). It renders the real `AssistantPhone` with **1,500 synthetic products**, about the size of the Marathon PE sneaker list. The photos are synthetic JPEGs averaging about 136 KB; the live originals average 108.8 KB, so these figures are conservative. Nothing in the captures is real data.

- The photos come from a second origin that behaves like Firebase Storage does for `products/{id}/photo.jpg`: CORS allowed, `Cache-Control: public, max-age=604800`. So "before" gets the browser HTTP cache it has on live.
- The browser is headless Chromium on a **mid-range phone profile**: DevTools CPU throttling 4x, and DevTools' own **Slow 3G** preset (2 s latency, about 50 KB/s) or **offline**.
- Two viewports: **phone 390x844**, **iPad 820x1180**.
- **Before** is `46f82e68` (the branch before this work). **After** is `4be146c2`.
- To reproduce:
  - `node scripts/sky-perf/gen-photos.mjs`
  - then `node scripts/sky-perf/phone-scroll.mjs --label X [--viewport phone|ipad] [--net slow3g|offline] [--warm] [--video]`

**Cold** is a first visit with nothing on the device. **Warm** is a reload after one earlier visit; that visit was unthrottled and stayed open 20 s, so prefetch could run. **First photo** and **first screen** are measured from the list's first render. The **fling** is 150 px per frame, about 9,000 px/s: down for 2.5 s, then up for 1.2 s.

The "No photo" column counts card-frames during the fling where a card in view showed no photo. Its denominator is the number of card-frames sampled. "Bare" means no photo and no placeholder.

| case | first photo | whole first screen | fling frames | p50 / p95 frame (ms) | frames >50 ms | No photo | photos held after |
|---|---|---|---|---|---|---|---|
| before phone cold Slow 3G | 21.4 s | 29.2 s | 149 | 26.4 / 30.6 | 0 | 670 / 692 | 0 |
| **after** phone cold Slow 3G | **15.5 s** | 28.9 s | 142 | 25.5 / 38.6 | 3 | **110** / 132 (placeholder shown) | 8 |
| before phone warm Slow 3G | 1.90 s | 1.90 s | 137 | 27.6 / 38.4 | 1 | 398 / 420 | 0 |
| **after** phone warm Slow 3G | **0.40 s** | **0.40 s** | **167** | **18.5** / 36.8 | 3 | **0** / 210 | 1,500 |
| before phone warm offline | 2.13 s | 2.13 s | 94 | 37.8 / 58.3 | 28 | 372 / 394 | 0 |
| **after** phone warm offline | **0.66 s** | **0.66 s** | **195** | **17.7** / 31.8 | **1** | **0** / 214 | 1,500 |
| before iPad cold Slow 3G | 21.8 s | 62.5 s | 100 | 42.7 / 60.6 | 20 | 618 / 653 | 0 |
| **after** iPad cold Slow 3G | **15.5 s** | 64.3 s | 87 | 44.9 / 58.4 | 14 | **106** / 150 (placeholder shown) | 21 |
| before iPad warm Slow 3G | 2.36 s | 2.36 s | 93 | 48.2 / 58.0 | 32 | 618 / 653 | 0 |
| **after** iPad warm Slow 3G | **0.75 s** | **0.90 s** | **106** | **26.9** / 66.4 | 24 | **0** / 200 | 1,500 |
| before iPad warm offline | 2.26 s | 2.26 s | 81 | 45.6 / 71.5 | 31 | 618 / 653 | 0 |
| **after** iPad warm offline | **0.90 s** | **0.90 s** | **150** | **21.3** / 49.9 | **7** | **0** / 232 | 1,500 |

What a cold first screen costs on Slow 3G is the line itself. Eight photos of about 110 KB at about 50 KB/s take about 20 s whatever the order. "After" puts the first one up about 6 s sooner (first screen first, four at a time) and shows a placeholder in every other card meanwhile.

## WebKit (the iPhone engine), unthrottled, 1,500 cards

Card-frames with **no text** during the fling went from **64 to 0**. That was the blank-card bug: `content-visibility: auto` on `.sky-card` skipped a card's insides until it was nearly on screen. The fling went from 89 frames (p50 42 ms) to **117–133 frames (p50 17 ms)**.

## Captures

Each pair has the same setup and is about 12 s long:

- `before-phone-cold-slow3g.mp4` / `after-phone-cold-slow3g.mp4`
- `before-phone-warm-slow3g.mp4` / `after-phone-warm-slow3g.mp4`
- `before-phone-warm-offline.mp4` / `after-phone-warm-offline.mp4`
- `before-ipad-cold-slow3g.mp4` / `after-ipad-cold-slow3g.mp4`
- `before-ipad-warm-slow3g.mp4` / `after-ipad-warm-slow3g.mp4`
- `before-ipad-warm-offline.mp4` / `after-ipad-warm-offline.mp4`
- `before-phone-fling.mp4`: the unthrottled-network fling before the change. Cards slide under the brand logos.

## Not measured here

- **Real devices.** Headless Chromium does not model an iPhone GPU compositing many backdrop blurs. The WebKit runs are software-rendered.
- **The preview channel itself.** The bucket's CORS allows `marathon-club.web.app` and localhost, but not preview origins. On the preview, the device cache cannot read photo bytes, so cards fall back to a plain `<img>` (the "before" photo behaviour). The grid, header and pill fixes still apply there.
