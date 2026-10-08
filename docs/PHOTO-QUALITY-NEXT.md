# Photo quality — the brief for when generation resumes

**Status: PARKED (Junid, 8 Oct 2026). Nothing here is built.** Photo
generation and WhatsApp posting are paused from the New Arrivals card
(`docs/NEW-ARRIVALS.md` → "The pause switches") until the quality below is
met. This file is the brief to build against when they resume.

## What Junid wants

### Clothing — retouched like a Photoshop studio
- Steamed and pressed: no creases, fold lines or packing marks.
- Straightened and symmetrical on the hanger; full, natural shape — never
  squashed, never inflated.
- No lint, dust, loose threads or hanger marks.
- The garment's own cut, length, volume, ribbing, quilting and finishes
  exactly as made.

### Sneakers — retouched as if shot by Nike's own studio
- Glue marks and residue gone; scuffs on the midsole gone; dust and loose
  threads gone.
- Crisp laces, clean edges; the sole's texture and every panel sharp.
- High resolution: the photo must hold up at full size on the storefront.

### Both
- Studio lighting, true colour (darks not lifted, colours not boosted).
- Every piece of text, every logo, label, print, stitch line and seam
  **exactly unchanged**. Any change to these fails the photo, however
  beautiful the rest.
- Footwear stays on the one fixed plate at the measured layout (the plate
  lock, #693); clothing on its fence.

## What exists today (so nothing is rebuilt)

| Piece | Where | State |
|---|---|---|
| Full Gemini (gemini-3-pro-image, 2K) with the locked baseline prompt + layers (steam, footwearBox, footwearPose) | `functions/newArrivals/studio/` | live, paused |
| Full / Split OpenAI (gpt-image-1, 1024 px) | same, `openai-image.mjs` | live, paused; redraws products (4 Oct test) |
| The footwear plate lock (lift + place by code) | `lift.mjs`, `correct.mjs` | live |
| Pixel measurements per photo (sharpness, crease, background noise) | `measure.mjs` | live, feeds the weekly report |
| The weekly learning report | `scripts/newArrivals/learningReport.mjs` | live (Mondays 08:00, the mini) |

## Options to test, side by side, on the same three items

Use the three test items of 4 Oct (the black long-sleeve tee, the denim
shirt, the Adidas F50 boot) plus one white sneaker and one hoodie. One photo
per option per item; Junid judges on the card; the cost column is real
(from the API's own token counts), not estimated.

| # | Option | What changes | Cost per photo (rand, at R16.73/$) | Time |
|---|---|---|---|---|
| A | **Today's Full Gemini at 2K** (the control) | nothing | **R2.35** (measured, 4–6 Oct) | 30–300 s |
| B | **Gemini at 4K** | `imageSize: "4K"` in `generation.json`; the plate lock lifts from a 4K photo | about **R4.70** — 4K is billed at roughly twice 2K's image tokens (to be measured; the first 4K photo gives the real figure) | longer; expect timeouts at 5 min |
| C | **A dedicated retouch pass** — a second model call that takes TODAY's photo and only cleans it (creases, lint, glue, scuffs), with the text/logo rule | a new layer after generation; Gemini edit at 2K | about **R2.35 on top** (one more 2K call) → **R4.70** per finished photo | +30–100 s |
| D | **OpenAI gpt-image-1, Full** (already on the card) | nothing | **R7.70** (measured, 4–6 Oct) | 70–90 s |
| E | **OpenAI, with the plate lock** for footwear (lift from its photo) | nothing — it already runs; untested on OpenAI output | R7.70 | 70–90 s |
| F | **Retouch pass by OpenAI** (C, but the second call to gpt-image-1 with `input_fidelity: high`) | as C | about **R2.35 + R7.70 = R10.05** | +70 s |

Notes for whoever builds the test:
- Options B and C can be switched on in config with no new code path: B is
  a config value; C is one new layer in `prompt.mjs` plus one more call in
  `studio.mjs`, recorded on the generation as `retouch`.
- Keep the text/logo rule in EVERY prompt of every option; a retouch pass
  that is told only "clean" will "clean" a logo.
- Judge with Junid's ❤ and "Not right" chips on the card so the weekly
  report counts it; do not judge by the pixel measurements alone.
- The three-way email of 4 Oct is the format: original | option | option.
- A 4K photo is about 4× the bytes: check the card's load time and the
  storefront's image pipeline before making it the default.

## What "done" looks like
Junid approves five consecutive clothing photos and five consecutive
sneaker photos on the card without a "Not right" chip, and the storefront
shows them at full size with no visible flaw. Then the switches go back
to On.
