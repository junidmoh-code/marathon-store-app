# Lookbook poster — investigation (commit 1)

Read before building the lookbook still. Every path below is in this repo
(`marathon-store-app`, deployed to Firebase project `marathon-club`).

## 1. The paths as they stand (main @ bf3c746f)

| Stage | Where | What it does |
|---|---|---|
| Daily generation | `functions/index.js` `exports.socialDailyAutopilot` (06:00 SAST) | Claims `social_autopilot_log/{saDate}`, loads `/social_policy`, makes one request per policy time, writes approved posts with `scheduledAt`. |
| Live policy | RTDB `/social_policy` | **`{ reels: { times: ["12:00","19:00"] } }` only** (saved by #614). `photos` and `stories` are absent, which RTDB uses to mean empty. So **today there is no daily still at all**: the day is 2 reels + their 2 story twins. |
| One post | `generateOnePost()` in `functions/index.js` | Picks products (`lib/social-select.cjs pickForKind`), builds the scene prompt (`lib/social-caption.cjs buildScenePrompt`), reserves a cap unit, generates, normalises and composites the type (`lib/social-render.cjs` → `lib/social-design.cjs`), uploads to `aiStudio/social/posts/{id}/…`, writes the record, its twin and the album entry in one `update()`. |
| Candidates | `loadSocialGenerationContext()` | One indexed query `shopify_publish` `state == "live"`, then about 80 products read **by pid**, with `/stock/{loc}/{pid}` point reads. `/locations` is the one small whole-node read, and it is already called out in the code. |
| Image model | `generateSocialScene()` | **Nano Banana Pro, `gemini-3-pro-image`**, through `geminiGenerateImage()` (REST `generateContent`, secret `GEMINI_API_KEY`). It falls back to `gemini-3.1-flash-image` on a 5xx. **It accepts reference images**: every product photo is sent as an `inlineData` part with a text label, and up to six style refs follow. Aspect ratios go through `imageConfig.aspectRatio` (`4:5`, `9:16`, …) at `imageSize: "2K"`. |
| Cost per generation | `NBPRO_FLAT_IMAGE_USD = 0.134` (from usage metadata when present) | About $0.134 for a 2K output. Reference inputs are input tokens, a fraction of a cent. `USD_TO_ZAR = 18.0` (`functions/lib/alt-shared/visionNaming.js`). |
| Compositing | `lib/social-render.cjs` + `lib/social-design.cjs` | **sharp 0.33** + librsvg: an SVG overlay rendered by sharp, fonts bundled in `functions/assets/fonts` and found through `FONTCONFIG_PATH` (Archivo). No node-canvas. The model is already told never to draw type. |
| Background removal | `functions/newArrivals/studio/cutout.mjs` `greyMatte()` | A flood fill of the light background from the edges, plus de-fringe. No model call. It exists, so the lookbook reuses it. |
| Approved photo | `functions/newArrivals/sourcePhoto.cjs` | An approved New Arrivals studio photo **replaces `products/{pid}/photoUrl`**, under `products/{pid}/new_arrivals/…`, and the staff photo moves to `photoUrlOriginal`. `isGeneratedPhoto(url)` identifies it. |
| Cap | `lib/social-budget.cjs` `MAX_IMAGE_GENERATIONS_PER_DAY = 4`, `claimImageGeneration()` | An RTDB transaction on `social_generation_budget/{saDate}/count`, reserved **before** the paid call. A 5xx releases the unit (`social-recovery.cjs`). The cap is an owner brief (2026-09-19) and is mirrored in `PolicyCard.jsx`. |
| Twins | `lib/social-twin.cjs` | A `story` record with `artwork.{story,feed}` gets a separate `feed` record (`buildFeedTwin`) on the same slot, using the 1080×1350 file. |
| Publishing | Mac mini, launchd `com.marathon.socialpublish` → `scripts/social/publish-runner.mjs` → `publish.mjs` → `meta.mjs` | Ticks every 2 min from **`~/marathon-social`** (its own clone of main, refreshed by `scripts/social/install-on-mac-mini.sh`). It sends anything approved and due. A story image goes as `media_type=STORIES`, a feed image as a normal post. Nothing is keyed on `kind`. |
| Watchdog | `exports.socialHealthScan` + `lib/social-health.cjs` (pure) | Every 15 min, 07:10–23:55. It writes `social_health/days/{saDate}` and pages (`SOCIAL_ENGINE_ALARM`) only on `silent`. |

## 2. Answers to the questions the brief asked

- **Model and references:** Gemini 3 Pro Image takes the real product photos
  as reference images today. The stop condition does not apply.
- **Renderer:** sharp is in `functions/package.json`, so the poster uses sharp
  plus SVG. Nothing is added.
- **Remove-bg:** `greyMatte` exists, but the first real run showed that the
  shop's photos, the New Arrivals "studio" ones included, are on the mesh
  display wall, not plain grey. The matte is therefore the repo's other
  remover, `@imgly/background-removal-node` (the Mac mini group poster's local
  ONNX model), loaded lazily by the lookbook only, with `greyMatte` second.
- **"Current still style":** there is no live daily still to retire. The
  existing designed still is the `story` format with its 4:5 feed twin, built
  by `generateOnePost` → `compositeSocialDesign`. On a "current" day the still
  is exactly that call, `kind: "single"` (the autopilot's story kind),
  **unmodified**.

## 3. Decisions that follow

1. **Separate scheduled function, `socialStillAutopilot` (07:00 SAST).**
   `socialDailyAutopilot` and the reels are not touched. 07:00 is after the
   06:00 run's own 30-minute ceiling, so the reels always reach the cap first
   and the still can never take a reel's unit.
2. **Rotation:** `STILL_FORMATS` (env JSON, default `["current","lookbook"]`).
   (Superseded 2026-10-18, PR #746: the format is now by weekday from
   `LOOKBOOK_DAYS`, default Mon/Wed/Fri; `social_lookbook/rotation` only
   records the day's `{lastDate, format}`.) `LOOKBOOK_ENABLED=false` drops `"lookbook"`
   from the list, and `STILL_FORMATS=[]` turns the still off.
3. **Slot 15:30 SAST**, 3½ h before the 19:00 reel (the 12:00 reel is off since 2026-10-18).
4. **The lookbook record is a `story`** (1080×1920 letterboxed) with
   `artwork.feed` (the 1080×1350 top crop) and goes through the existing
   `buildFeedTwin`. That gives one feed post and one story post. The publisher
   needs no change.
5. **Cap arithmetic stays inside 4.** A normal day is 2 (reels) + 1 (still) = 3.
   The lookbook regenerates after a failed text check **only when a unit would
   still be left for the current-style fallback**. A failed lookbook must
   never cost the day its post, and the cap is not raised. On a normal day that
   means a hero with text falls straight back to the current style.
6. **No-text gate:** a vision model the pipeline already uses. The first plan
   was `claude-haiku-4-5`. After the first real poster it became
   `claude-sonnet-4-6` (`CHAT_MODEL`), with the garment positions asked
   separately as cells on a labelled grid. Raw x/y wandered by a head-height
   between looks. The text check always sees the clean hero.
7. **Health:** `social_autopilot_log` is unchanged. The still writes
   `social_still_log/{saDate}`. The scan adds the 15:30 story + feed
   obligation, records `still` (planned, posted, fallback, reason) on
   `social_health/days/{saDate}`, flags a fallback as degraded, and pages when
   two lookbook days in a row fell back. The second one is at most 48 h after
   the first.
8. **No rules change.** `social_lookbook` and `social_still_log` are Admin-SDK
   only, like `social_generation_budget`. Nothing in the browser reads them.

## 4. Things found on the way

- `~/marathon-social`, the publisher's clone, was at #706 while main is at
  #735. Nothing social changed in between, apart from a comment in
  `social-select.cjs`. The restart after merge (`install-on-mac-mini.sh`)
  brings it up to date.
- The reference poster named in the brief was **not attached** to the message,
  and no such file exists on this machine. The layout is built from the
  written spec, and `docs/lookbook-compare.jpg` puts the sample beside a
  wireframe of that spec instead.
