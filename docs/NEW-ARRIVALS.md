# New Arrivals — the photo studio

```
upload ─▶ New ─[Junid: Generate]─▶ photo appears on the card ─[Junid: Approve]─▶ Done
Done ─▶ chaining (photo → name → Excellent → publish intent) ─▶ reconciler ─▶ live on Shopify
     ─▶ the WhatsApp queue (posting is PAUSED — a separate job)
```

**Everything is manual.** An image model (Gemini, or OpenAI's gpt-image-1 —
Junid picks per item) is called only when Junid taps Generate or
Regenerate (plus the name suggester after an Approve). There is no checker, no
verdict, no automatic generation, re-check, regeneration or tab move. Junid's
Approve is final.

How the first version worked, and why it was slow, is in
`NEW-ARRIVALS-STUDIO-DISCOVERY.md`.

## The card — `src/components/newArrivals/`

| File | What |
|---|---|
| `NewArrivalsScreen.jsx` | the card: tabs New / Done, the Sneakers ⇄ Clothing switcher, one card per item |
| `newArrivalsView.js` | pure rules: which buttons, what each line says, what a tap shows before the server answers |
| `newArrivalsApi.js` | the only door to the data (callables, the streaming studio call, the admin price save) |
| `studioStream.js` | reads the studio function's stream with `fetch` (the installed Firebase SDK has no streaming callable) |

- **Generate / Regenerate** calls `newArrivalsStudio` and shows, in the photo's
  own place, Gemini's drafts and thought summary as they arrive, then the
  finished photo. Several items can generate at once.
- **Save price, Approve, Skip, Use this one, ❤, the method choice** change the
  card at once and write in the background. A failed write puts the card back
  as it was and says why. No tap reloads the list or locks the screen.
- **Skip** has an 8-second Undo.
- **Prices** are the product's real `stockPrice` / `retailPrice`, written by
  `admin/productPriceSave.js` — the same save the admin price editor uses.
- **Paging**: 30 at a time through `newArrivalsList` ("Load more").

## The pause switches (Junid, 8 Oct)

Two switches at the top of the card, flipped by Junid only (`newArrivalsPause`;
everyone else sees the state):

| Switch | Stored at | While paused |
|---|---|---|
| **Photo generation** | `new_arrivals/pause/generation` | every Cloud Function that makes an image refuses before any model call — `newArrivalsStudio`, `generateSocialPosts`, the 06:00 `socialDailyAutopilot`, `generateProductPhotos` (`functions/newArrivals/pause.cjs`). Generate / Regenerate show **Paused**. |
| **WhatsApp posting** | `new_arrivals/pause/posting` | the Mac mini poster (`marathon-group-poster` `bin/post-window.mjs`) reads the switch at the start of a window and again before EVERY send, and sends nothing. A `PAUSE` file in that repo's root is a second lock. |

Absent = on (deleting the node switches everything back on); a switch that cannot be read counts as paused. The social watchdog treats a paused day as quiet by decision, never as an outage. Browsing, prices,
Approve, Skip and the Shopify chain keep working while paused. Both were set to
Paused at go-live (8 Oct 2026) until the quality in `PHOTO-QUALITY-NEXT.md` is
met. Each flip is logged at `new_arrivals/pause/log/{time}`.

**What was generating by itself (found 8 Oct):** the social autopilot — a
Cloud Function on a 06:00 schedule that makes the day's Instagram/Facebook
photos with `gemini-3-pro-image`. The New Arrivals card made nothing by
itself since 4 Oct; the two generations since 5 Oct (G-0121, G-0122) were
live tests of #693 and #698.

## Data — `/new_arrivals`

| Path | What |
|---|---|
| `items/{pid}` | the item (truth) |
| `by_status/{status}/{pid}` | `enqueuedAt` — the index every reader uses; never a whole-node scan |
| `decisions/{push}` | Junid's ledger: generate, regenerate, approve, pick, love, unlove, reject, skip, restore |
| `genlog/{code}` | the learning log of one generation (no prompt text; its sha) |
| `genSeq` | the G-code counter |
| `stats` | spend so far |
| `fx/{day}` | the day's USD/ZAR rate |
| `rescue/{pid}/{genId}` | a photo that was made but could not be put on its item |

Statuses: `new`, `ready`, `rejected` (all three are the **New** tab — a lane
never hides an item), `approved`, `chaining`, `done` (the **Done** tab),
`skipped`. `generating` is the retired Mac mini queue's lane.

A generation is `items/{pid}/generations/{genId}`: `url`, `path`, `at`,
`code` (G-0042), `model`, `promptVersion`, `method` (`full` | `split`),
`layers`, `costUsd`, `costZar`, `usdZar`, `costEstimated`, `loved`. The full
record — prompt text, inputs with their sha256, the request, usage, thought
summary, drafts — is stored beside the photo as
`products/{pid}/new_arrivals/{genId}.genlog.json`.

While a photo is being made the item carries
`generateRequest { at, by, studio: true }`. Approve, Skip and Use this one wait
for it. A studio request older than 10 minutes is a run that died and blocks
nothing.

## The functions — `functions/newArrivals/`

| Callable | What |
|---|---|
| `newArrivalsStudio` | ONE generation, streamed (`studio.js`, `studio/*.mjs`) |
| `newArrivalsList` | one page of a tab + group |
| `newArrivalsApprove` | new / ready / rejected with a photo and a stock price → approved |
| `newArrivalsSkip` / `newArrivalsRestore` | Skip and its Undo |
| `newArrivalsSelect` | "Use this one" |
| `newArrivalsLove` | ❤ |
| `newArrivalsReject` | a feedback chip, logged against the photo shown |
| `newArrivalsHow` | "How Gemini did it" for one generation |
| `newArrivalsMethod` | the next photo's engine + method for one item (`items/{pid}/method`, `/provider`) |
| `newArrivalsPause` | the two pause switches (Junid only) |
| `newArrivalsEnqueue` | trigger: an upload lands in New |

All are gated to the super-admin or `permFlags/shopify_publish`. The client
never reads or writes `/new_arrivals`, so **no database rule is needed or
changed.**

### The photo method

- **The locked baseline**: `studio/baseline-prompts.mjs`, `gemini-3-pro-image`
  at 2K, Junid's plates. Pinned by `functions/test/studio-baseline.test.mjs`
  against `studio/config/baseline.lock.json`; changing any of it needs Junid's
  sign-off recorded in that file.
- **Layers** (`studio/prompt.mjs`) add ONE paragraph before the baseline's
  studio brief; `studio/config/generation.json` switches them on. In force:

  | Layer | For | What it adds |
  |---|---|---|
  | `steam` | clothing, except t-shirts | steamed and pressed: creases, fold lines and squashing out; fabric full; studio light; true colour |
  | `footwearBox` | all footwear | ONE box on the rail: its own box photo, else the box in the shoe photo, else the brand's library box; never invented |
  | `footwearPose` | all footwear | one shoe, whole sole on the pedestal |
  | `footwearExamples` | **OFF** | two of Junid's five finished photos shown for the layout only. Switched off after the live test of 4 Oct: with them a footwear request (7 images) got no answer from Gemini in 5 minutes, twice |

  T-shirts (and the jersey tops cut like them: golf shirts, basketball vests,
  baseball shirts, soccer jerseys) get no layer on Full Gemini: their prompt
  is the bare baseline, byte for byte.

  **These four layers are PROVISIONAL** (`baseline.lock.json`): Junid asked
  for them in his brief of 4 Oct, but the wording is the developer's and he had
  not seen a photo made with them when they were switched on (Gemini's credit
  ran out before a test generation). Each layer's exact text is pinned by
  sha256; to switch one off, set it to `false` in `generation.json` and
  `baseline.lock.json` and deploy `newArrivalsStudio`.
- **Two engines, one interface** (4 Oct — Gemini kept refusing with "high
  demand"): `studio/gemini-stream.mjs` `streamImage` and
  `studio/openai-image.mjs` `openaiImage` take the same
  `(model, parts, imageConfig, opts)` and return the same shape. The card has
  FOUR buttons — Full Gemini (default), Split (Gemini), Full OpenAI,
  Split (OpenAI) — never blended. The prompt, the layers, the box rule, the
  references, the split cut-out, the source-photo rule, approval and posting
  are identical for both. Differences that are OpenAI's own:
  - it takes ONE prompt, so each image's introducing sentence becomes a
    numbered line of the prompt ("IMAGE 1 — SHOE PHOTO — the real shoe");
  - the real product photo is attached FIRST, its box second (gpt-image-1
    keeps the first image most faithfully; `input_fidelity: high`);
  - sizes are 1024×1536 / 1536×1024 / 1024×1024 (not 2K), quality `high`;
  - no thought summary — "How it was made" shows its drafts only;
  - the key is the `OPENAI_API_KEY` secret (shared with the older AI Studio);
    cost from its own token counts (text in $5, image in $10, image out $40
    per 1M) — about three times a Gemini photo on the three live test photos
    of 4 Oct (R7.70–R8.90 against R2.35);
  - its photos are 1024 px wide (Gemini's 2K are 1792); the plate lock lifts
    from that;
  - **it may redraw the product.** On the 4 Oct test it reworded a neck
    label, turned "F50" into "CS" and removed a fade. Junid chose to ship it
    anyway as a fallback he picks himself; the plate lock was tuned on Gemini
    photos and has not been run on OpenAI's.
  Each generation records `provider` (`gemini` | `openai`; absent = Gemini).
- **The footwear plate lock** (Junid, 5 Oct — `studio/correct.mjs`,
  `studio/lift.mjs`; `generation.json` `footwearCorrection`): in the final
  footwear photo EVERYTHING except the shoe and its box comes from the one
  fixed plate (`footwear-plate.png`) — pedestal, fence, rails, lighting, crop
  — the same pixels in every corrected photo (the plate, encoded as a JPEG
  the same way each time). Gemini repaints the pedestal differently every
  time (wear, marks, a different size), so its pedestal and background are
  discarded. What is kept of Gemini's photo is the two cut-outs. After a Full
  footwear generation:
  1. **Lift** — the shoe and the box are found in Gemini's photo with no model
     call. Where Gemini kept the backdrop, by comparing with the plate (a
     colour no nearby plate pixel has; smooth where the plate is mesh). Where
     it redrew the backdrop, from the photo alone (coloured, or smooth and not
     a rail) — trusted only for a coloured shoe. The pedestal is cut away at
     the **sole line**, read from the photo's own pedestal (walking up from
     its black front panel through its white).
  2. **Scale and place** — each is scaled uniformly to the layout measured
     from G-0102 (`config/layout-spec.json` → `footwear`) and placed on the
     untouched plate with code-drawn shadows (`place.mjs`). Never warped,
     never recoloured. A tall shoe is fitted by height under the box.
  3. Gemini's own photo is kept as `gen_<n>-uncorrected.jpg`; the card shows
     it as a thumbnail (`generations/{g}/uncorrected`, `corrected: true`).
  If the shoe cannot be lifted (Gemini changed the pedestal so its panel is
  gone; a white / grey / black shoe on a redrawn backdrop; no shoe found),
  Gemini's photo is kept, `corrected: false`, and the card says so; so does a
  corrected photo whose box could not be found. Run by hand on the 31 Full
  footwear photos of 4 Oct (5 Oct, not a repo fixture): 26 were lifted and 5
  kept as made; the lifted ones were looked at as a contact sheet, not
  measured one by one.
  **Known limits.** A box that TOUCHES the shoe is refused when the pair is
  taller than long or has a waist; a box resting flat on the shoe with no
  waist is cut with it — the card then says the box could not be found on
  its own and to check the photo. A cut-out is a filled outline: the wall seen through a
  strap's opening comes with the shoe. Scaling is uniform to the pixel
  (width and height are rounded separately: under 0.5%). A shoe is placed by
  its length; a tall one (a boot) is fitted by height under the box, so it
  stands shorter than the layout's length. Earlier footwear photos, made
  before 5 Oct, are as Gemini made them and carry no note. A white shoe on the white pedestal is separated by its
  outline and the dark line where it touches; a faint sliver of pedestal can
  stay at the heel. A shelf Gemini draws under the box can come with the box.
  Junid sees every photo — and the thumbnail of what it was made from.
- **The footwear layout and reference** are G-0102's (Boss slide white): the
  reference image is G-0102 placed on the untouched plate
  (`footwear-reference-g0102.jpg`, locked in `plates.lock.json`), and the
  placement text says its numbers outright — shoe length 72.4% of the
  pedestal's width, sole 2.1% of the frame behind the pedestal's front edge,
  box centred above and no larger than 34% × 40% of the frame. Recorded in
  `baseline.lock.json` → `footwearLayout`.
- **Two methods per item** (the card's Full Gemini / Split):
  - **Full Gemini** (default): Gemini composes the product onto the plate.
  - **Split** (`studio/split.mjs`): Gemini makes the product only, on plain
    light grey (`split-prompts.mjs`, its own locked prompt); code floods the
    grey away from the edges (`cutout.mjs`), places the cut-out on the real
    plate at the measured layout and adds a soft shadow (`place.mjs`). A
    product too close to the grey in colour cannot be cut out: Gemini's photo
    is kept and the card says to use Full Gemini for that item.
    **Known limits of the cut-out.** The Mac mini used a trained background
    remover; a Cloud Function shared by 86 functions should not carry one, so
    this is a colour flood. It is exact on coloured, dark and white products.
    It can nibble a light-grey or silver part that touches the background (a
    grey sole, a silver logo at the edge), it treats a patch inside the product
    that is exactly the background's grey as a gap (so a panel of that very
    grey would show the backdrop through), and it keeps a hard dark shadow as
    part of the product. Junid sees every photo before it goes anywhere; for
    such a product, Full Gemini is the method.
    Split's prompt asks for "steamed and pressed" on every garment, t-shirts
    included — tees are only guaranteed the unchanged baseline on Full Gemini.
- **Plates, references, examples, boxes**: Storage `new_arrivals/assets/plates`
  (plates verified against `plates.lock.json`, examples against
  `examples.lock.json`) and `new_arrivals/assets/boxes`.
- **Cost**: from the API's own token counts at `studio/config/prices.json`
  list prices, in rand at the day's rate. Real only when the image's own
  tokens were reported; otherwise the marked estimate.
- **Measurements** (`studio/measure.mjs`): sharpness, background noise, crease
  and difference from the plate — pixels only, no model call — kept on every
  generation for the weekly report.

## The weekly learning report

`scripts/newArrivals/learningCore.mjs` (pure) + `learningReport.mjs` (runner).
The Mac mini's LaunchAgent `com.marathon.newarrivals.learning` (installed by
hand at deploy — it is not in this repo; it runs the script from `~/msa-runtime`,
which must be at a commit that has it) runs it every Monday 08:00. It reads the
last decisions and learning-log rows, compares the photos Junid loved with the
ones he marked not right, gives up to three findings that cite their numbers,
and PROPOSES prompt changes — it never applies one. The email goes from the
mini because the business's sending mailbox lives there.

## After Approve (unchanged, on the Mac mini)

`com.marathon.groupposter.naming` suggests the name; `…chain` runs
`scripts/newArrivals/chainCore.mjs`: photo → name → condition Excellent →
publisher approval; the Shopify reconciler publishes. WhatsApp posting is
PAUSED.

## Deploy (by name, never a bare `--only functions`)

```
firebase deploy --only functions:newArrivalsStudio,functions:newArrivalsList --project=marathon-club
```

The card ships with hosting. Run the drift check in `DEPLOY.md` first.
