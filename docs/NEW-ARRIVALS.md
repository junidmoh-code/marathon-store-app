# New Arrivals — the photo studio

```
upload ─▶ New ─[Junid: Generate]─▶ photo appears on the card ─[Junid: Approve]─▶ Done
Done ─▶ chaining (photo → name → Excellent → publish intent) ─▶ reconciler ─▶ live on Shopify
     ─▶ the WhatsApp queue (posting is PAUSED — a separate job)
```

**Everything is manual.** Gemini is called only when Junid taps Generate or
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
| `newArrivalsMethod` | Full Gemini / Split for one item |
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
  | `footwearExamples` | all footwear | two of Junid's own finished photos, shown as "composition only" |

  T-shirts get no layer: their prompt is the bare baseline, byte for byte.
- **Two methods per item** (the card's Full Gemini / Split):
  - **Full Gemini** (default): Gemini composes the product onto the plate.
  - **Split** (`studio/split.mjs`): Gemini makes the product only, on plain
    light grey (`split-prompts.mjs`, its own locked prompt); code floods the
    grey away from the edges (`cutout.mjs`), places the cut-out on the real
    plate at the measured layout and adds a soft shadow (`place.mjs`). A
    product too close to the grey in colour cannot be cut out: Gemini's photo
    is kept and the card says to use Full Gemini for that item.
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
Every Monday 08:00 the Mac mini (`com.marathon.newarrivals.learning`) reads the
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
firebase deploy --only functions:newArrivalsStudio --project=marathon-club
```

The card ships with hosting. Run the drift check in `DEPLOY.md` first.
