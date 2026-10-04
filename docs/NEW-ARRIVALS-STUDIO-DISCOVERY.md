# New Arrivals photo studio — discovery (4 Oct 2026)

What exists today, where it is slow, and what the rebuild keeps. Read before
`docs/NEW-ARRIVALS.md`, which describes the first version.

## The card today

- `src/components/newArrivals/NewArrivalsScreen.jsx` (card), `newArrivalsView.js`
  (pure view rules), `newArrivalsApi.js` (the only door to the data).
- Twelve callables in `functions/newArrivals/newArrivals.js` over the pure core
  `functions/newArrivals/core.cjs`. The client never reads `/new_arrivals`.
- Generate does **not** generate. `newArrivalsGenerate` writes
  `items/{pid}/generateRequest` and `requests/{pid}`; the Mac mini's
  `com.marathon.groupposter.queue` LaunchAgent polls that index every 60 s,
  takes **one** request per run, calls Gemini, and writes the result back. The
  card finds out on its 30-second refresh.

## Why Generate, Save and Approve feel slow

| Tap | What happens | Cost |
|---|---|---|
| Generate | request written → mini's next 60 s tick → one item per tick → Gemini (60–180 s) → card's next 30 s refresh | 1.5–5 min, longer with several taps queued; nothing is shown meanwhile |
| Save price | two keyed reads + `/specials` read + the batch write (a direct write — fine) **then a full list reload** | the reload |
| Approve / Skip / Use this one / ❤ | callable (cold start possible), sequential per-pid reads, **then a full list reload** | callable + the reload |

The reload is `newArrivalsList`: 8 status indexes, two category reads per item
in the whole lane, a bucket read per item, then item + product + one stock read
per location for each of the 30 shown. Every action waits for it, and `busy`
disables every button on the screen until it returns. Nothing goes through the
mini for Save or Approve — the delay is the reload and the screen-wide lock.

## The mini pipeline (`marathon-group-poster`, checkout `~/marathon-group-poster`)

| LaunchAgent | Job | After this rebuild |
|---|---|---|
| `groupposter.queue` | generation (and, before 4 Oct, checker / re-judge / calibration) | **unload** |
| `groupposter.learning` | learning report email | **unload** (replaced by the weekly function) |
| `groupposter.naming` | name suggester after Approve | keep |
| `groupposter.chain` | post-approval chain (`scripts/newArrivals/chainCore.mjs`) | keep |
| `groupposter.window`, `.setup`, `.awake`, `.daily` | WhatsApp posting (PAUSED), setup, keep-awake, daily email | keep, untouched |

There is no separate checker or re-judge agent: both ran inside the queue job.

## The Gemini key

It is **not** in `~/.marathon-group-poster/.env` (no such file). The mini reads
`GEMINI_API_KEY` from Secret Manager at run time (`src/fb.mjs secret()`), the
same secret `functions/index.js` already binds with `defineSecret`. Nothing to
copy: the new function binds the existing secret.

## The locked baseline (found)

- `config/baseline.lock.json` + `config/generation.json` in the poster repo:
  model `gemini-3-pro-image`, size `2K`, prompt `src/baseline-prompts.mjs`
  (sha256 `5046bbe1…e36ad`), the store's `CONDITION_CLAUSE`
  (sha256 `0c60e00a…3175`), one layer on: `packaging` (footwear only, signed
  off 4 Oct). Default method `full`.
- Request shape (2 Oct, c16080e): prompt, plate, reference, layout diagram, the
  product photo, the box — `responseModalities: ["IMAGE","TEXT"]`, aspect =
  closest supported ratio to the plate, thought summaries on.
- The cream knit vest `p1790934565270`: first generation 2 Oct, ledger row 1,
  $0.1524.
- Split prompt `split-product-2026-10-04.1` (`config/split.lock.json`).

## Plates and boxes (found)

`~/.marathon-group-poster/plates/junid/` holds the six locked files
(`lock.json` pins each sha256; `config/layout-spec.json` was measured from
them) and `inbox/` holds Junid's originals. `~/.marathon-group-poster/boxes/`
holds 28 brand boxes + `sources.json`.

## What is broken or missing

1. Generation waits on a poll and shows nothing while it works.
2. Every action reloads the whole list and locks the screen.
3. The split method's cut-out uses a local ONNX model
   (`@imgly/background-removal-node`) that does not belong in a Cloud Function.
4. `new_arrivals/stats` (the card's spend line) is written by the queue job's
   calibration step — it stops when that job is unloaded.
5. The footwear baseline refuses a shoe with no own box photo unless the item
   is manual; the brand-library box path was never proven.
6. Cost falls back to a list-price estimate whenever the meter was not running.

## Decisions for the rebuild

- One streaming callable, `newArrivalsStudio`, calls Gemini's
  `streamGenerateContent` and forwards thought text, draft images and the final
  photo to the card as they arrive. The card reads the stream with `fetch`
  (the installed Firebase JS SDK 10.14 has no streaming callable; functions
  6.6 does).
- The poster's generation modules are vendored unchanged where they are locked
  (`baseline-prompts.mjs` byte-for-byte, pinned by test).
- Plates, references and boxes are read from Storage under
  `new_arrivals/assets/`, cached per instance.
- The card applies each action to its own state at once and writes in the
  background; a failed write rolls the card back and says so.
