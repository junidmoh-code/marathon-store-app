# Social content engine — setup

Everything Junid has to do by hand, in the order it has to be done. Each step
says where, and what it looks like when it worked.

Nothing in this feature posts anything until an item has been approved in the
app. That is not a setting; it is `postBlocker()` in
`src/components/social/socialCore.js`, called by the publisher on the machine
that does the posting, immediately before the first platform call.

---

## 0. Before anything: the billing account

**Restored — verified 2026-08-23.** The `marathon-club` project is linked to
billing account `01FCC9-1EF478-90A01C`, and that account's `open` flag is
`true`. Storage serves objects, Gemini answers, and a functions deploy builds.

This section stays because of *how* the outage read when it happened, which was
nothing like a billing problem: Storage returned **HTTP 402** on every object,
Gemini returned **403 PERMISSION_DENIED — "Your project has been denied
access"**, and the scanner looked dead with Cloud Run 500s. Any of those will
send you hunting through code that is fine.

Check it the way that actually answers the question:

```
gcloud beta billing projects describe marathon-club          # billingAccountName
gcloud beta billing accounts describe <THAT ACCOUNT>         # look at: open
```

**`billingEnabled: true` on the project is not the answer** — it stays `true`
while pointing at a *closed* account, which is exactly the state that caused the
2026-08-22 outage. The `open` flag on the **account** is the one that matters.

---

## 1. Paste the database rules — 2 minutes, do this first

The live database has no root rule, so a brand-new top-level path denies
everything. Until these are in, the Social screen loads and says so in plain
words.

```
node scripts/social/print-social-rules.mjs
```

**That script now prints THREE parts, and only Part 1 belongs to this feature.**
PR #421 (Shopify Publishing / photo-generation permissions) added Parts 2 and 3
to the same script because they are pasted into the same console screen. Tell
them apart by their heading:

| part | key(s) | whose |
|---|---|---|
| **PART 1** | `social_posts`, `social_style_refs` | **this feature** — two brand-new keys |
| PART 2 | `shopify_publish` | #421 — *replaces* an existing key |
| PART 3 | `aiAssistant/usage`, `aiAssistant/photoProposals` | #421 — children of an existing key |

Paste Part 1 into **Firebase console → Realtime Database → Rules**, as two new
top-level keys alongside the existing `shopify_publish`. Parts 2 and 3 are
independent of the social engine and can be done whenever.

**Add the keys; do not paste over the whole document, and do not run
`firebase deploy --only database`.** Counted against the running database on
2026-08-23: the live rules carry **59 top-level keys**, the repo's
`database.rules.json` carries **49**, and live is a strict superset — so
deploying that file would **delete these 10 keys outright**:

`duplicate_candidates`, `price_history`, `price_history_index`,
`shopify_publish`, `shopify_sync`, `sneaker_models`, `specials`,
`stock_provenance`, `style_code_captures`, `style_code_index`

Nothing in the repo file is missing from live, so there is no case in which
deploying it adds anything — it can only subtract.

*Worked when:* the Social tile opens the queue instead of a permission error.
Until then the publisher still runs — it uses the Admin SDK and bypasses rules —
it is the *browser* that is locked out, and the `.indexOn` is what stops the
queue's per-status reads from scanning the whole node.

**No Storage rule is needed.** Social media is written under
`aiStudio/social/…`, already covered by the existing `match /aiStudio/{allPaths=**}`
block (public read, super-admin write).

---
## 2. Fill the style library — whenever, and keep going

App → **Social → Style library**. Add photos *and* videos you like the look of,
with an optional note and a few loose tags.

This is not the AI Studio Style Kit. That one is a locked set of at most six
scene references used to re-shoot single products for the catalogue. This is
open and growing, it holds video, and it is what the generator reads to know
what our posts should look like.

Videos cost nothing to browse: a still is captured from the video in your
browser at upload time and the grid only ever loads that. A video body is
fetched only when you tap one to watch it.

*Worked when:* the Generate tab's report says `Style references sent: N`.

---

## 3. Connect Instagram and Facebook — 15 minutes, once

Your Instagram is a Business account with a Facebook Page connected, which is
exactly what the API needs. **No App Review is required** — an app in
Development mode may call the API on behalf of people who hold a role on it,
indefinitely. App Review is for acting on behalf of the public, which this never
does. **Leave the app in Development mode.**

### 3a. In the browser — the exact URLs, in order

| # | Do this | Go straight here |
|---|---|---|
| 1 | **Create the app.** Choose use case **"Other"** → type **"Business"**. Name it anything; *Marathon Social* is fine. | <https://developers.facebook.com/apps/create/> |
| 2 | **Add products.** On the app's dashboard, add **Instagram** (Instagram Graph API) *and* **Facebook Login for Business**. | <https://developers.facebook.com/apps/> → your app → *Add product* |
| 3 | **Confirm you are Administrator.** This is the step that makes App Review unnecessary. | App → **App roles → Roles** |
| 4 | **Copy the App ID and App Secret.** You will paste these as environment variables in 3b, never as arguments. | App → **App settings → Basic** |
| 5 | **Generate a user token** with the five scopes below. | <https://developers.facebook.com/tools/explorer/> |
| 6 | **Copy the token.** It lasts about an hour — plenty — and it is the last token you will ever copy. | (same page) |

Steps 2–4 live under your app, so the fastest route is
<https://developers.facebook.com/apps/> → click the app → the left-hand menu.

**The five scopes to grant at step 5** (Graph API Explorer → pick your app
top-right → *Generate Access Token*):

- `instagram_basic`
- `instagram_content_publish`
- `pages_show_list`
- `pages_read_engagement`
- `pages_manage_posts`

Add `ads_management` and `ads_read` **only** if the exchange in 3b complains
about a missing scope — some Pages under a Business Manager require them.

If the Explorer shows no Page, the Instagram account is not connected to one
yet: Instagram app → **Settings → Account type and tools → Share to other apps
→ Facebook**.

### 3b. In a terminal, on the Mac mini

```
ssh marathonclub@100.64.186.78
cd ~/marathon-social

unset GOOGLE_APPLICATION_CREDENTIALS      # ← see the warning below
export META_APP_ID=…
export META_APP_SECRET=…
node scripts/social/meta-token.mjs --short-lived <THE TOKEN FROM STEP 6>
```

> **`unset GOOGLE_APPLICATION_CREDENTIALS` is not optional.**
> Two identities can reach Secret Manager from this machine and they are
> deliberately not the same one:
>
> | identity | may do | used by |
> |---|---|---|
> | `firebase-adminsdk-fbsvc@…` (the SA file) | **read** secrets only | the publisher, every run |
> | your gcloud login (`roles/owner`) | create secrets, add versions | **setup — this step** |
>
> `google-auth-library` prefers `GOOGLE_APPLICATION_CREDENTIALS` over your
> gcloud login whenever it is set, so a shell that inherited it would do the
> entire Meta dance and be refused at the final store — after the one-hour
> token is spent. The script now checks this **first** and stops in two seconds
> with the fix, before contacting Meta at all, so a wrong shell costs you
> nothing. It prints `0/4  checking these credentials can store a secret…`.
>
> If it says **"no usable Google credentials"**, this machine has no
> application-default login yet. Do it once:
>
> ```
> gcloud auth application-default login
> ```
>
> The check only ever *stops* on a definite no. If it cannot reach IAM or
> Secret Manager at all it prints a `⚠` and carries on, because a convenience
> check that blocks setup for unrelated reasons is worse than no check.

It exchanges the one-hour token for a 60-day one, reads your Page from that,
takes the Page token — **which does not expire, because it was minted from a
long-lived user token** — finds the Instagram account connected to that Page,
proves the token can actually reach Instagram publishing, and only then stores
three secrets in Google Secret Manager.

Nothing is ever printed. Not the short-lived token, not the long-lived one, not
the Page token.

*Worked when:*

```
node scripts/social/meta-token.mjs --check
```

prints your Page name and an Instagram account id.

### If it ever breaks

Every post fails with a `[190]` error in `logs/social-publish.log` if the token
is revoked — you change your Facebook password, or remove the app. The fix is
to run 3a step 5 and 3b again.

---

## 3c. Facebook stories — WIRED UP 2026-08-27

Instagram stories always worked. Facebook stories did not, and the failure was
quiet: `publishFacebook` had no notion of format, so every story-format post
went to the **Page feed** as an ordinary timeline post with 9:16 artwork.

Facebook's stories are a separate API, now wired up and confirmed against the
live Page — a photo story and a video story were both published and both read
back from `GET /{page}/stories` as `status: "published"`.

Nothing to do here. It needs no extra scope: the same Page token already in
Secret Manager posts them.

---

## 4. TikTok — honestly, not yet

TikTok is **not** posted by the scheduler, and the queue records it as *skipped*
with the reason on every run rather than claiming otherwise. Two routes exist
and neither is available to an unattended job today:

- **The Higgsfield connection can genuinely publish** — but only through the
  Higgsfield MCP tools inside a Claude session. There is no HTTP endpoint a
  script on the Mac mini can call. On top of that, **no TikTok account is
  connected to the workspace at all** (checked 2026-08-22: `tiktok_accounts`
  returned an empty list). Connecting one is a browser OAuth you do once, from a
  Claude session, via `tiktok_connect`. Note that TikTok only accepts media from
  a verified source domain, so each post's images must be imported to Higgsfield
  first — our JPEGs are the right format (TikTok rejects PNG).
- **TikTok's own Content Posting API** is the right long-term answer and needs
  an app on TikTok for Developers with the `video.publish` scope. That scope is
  granted only after an **audit** — a real review with a demo video and a
  privacy policy, not a credential to paste.

In the meantime:

```
node scripts/social/tiktok-handoff.mjs
```

lists exactly what is approved, due and waiting for TikTok, in a form a Claude
session can publish. Mark one done with `--mark <postId> --url <permalink>`, and
the publisher stops listing it.

---

## 5. Install the schedule on the Mac mini — DONE 2026-08-23

Three posts a week: **Monday, Wednesday and Saturday at 18:00 SAST**. Those three
times are in the plist AND in `SLOT_DAYS` / `SLOT_HOUR_SAST` in
`src/components/social/socialCore.js` — the queue shows those slots and the
generator assigns them. A test pins the plist and the code to the same days and
hour, so they cannot drift apart silently.

**Installed and loaded on 2026-08-23.** Nothing to do here unless you are
re-installing after a new merge.

### Install or update it — one command

```
ssh marathonclub@100.64.186.78
bash ~/marathon-social/scripts/social/install-on-mac-mini.sh
```

It is idempotent: run it again after any merge to pull the new code and reload
the agent. Re-running posts nothing.

> **Do not install this by hand with `cp` + `launchctl load`.**
> The committed plist names `/Users/marathonclub/marathon-store-app` — the
> **Shopify reconciler's** checkout, which runs against the live shop every two
> minutes. Copying it verbatim would point the publisher's `WorkingDirectory`
> at that directory. The installer exists to rewrite every path to
> `~/marathon-social` and to resolve the node interpreter on the machine
> itself, and it refuses rather than installing something wrong.

### Where it actually lives

| what | where |
|---|---|
| the clone | `~/marathon-social` (**not** `~/marathon-store-app`) |
| the agent | `~/Library/LaunchAgents/com.marathon.socialpublish.plist` |
| node | `/opt/homebrew/bin/node` — Apple silicon; `/usr/local/bin/node` does not exist |
| the readable log | `~/marathon-social/logs/social-publish.log` |
| launchd's own capture | `~/marathon-social/logs/social-launchd.{out,err}.log` |

`RunAtLoad` is deliberately **false**: loading the agent must never fire a post.
A missed fire (the mini was asleep) runs as soon as it wakes, so an approved
post goes out late rather than being skipped for the week.

**Why it survives a reboot:** the plist is in `~/Library/LaunchAgents`, which
launchd loads at GUI login; the mini has `autoLoginUser = marathonclub`, so that
login happens by itself; and the job is `enabled` in launchd's override database
(a *disabled* override persists across reboots and would silently kill it).

The service account at `GOOGLE_APPLICATION_CREDENTIALS` needs
**`roles/secretmanager.secretAccessor`** to read the Meta token — **granted**,
confirmed 2026-08-23. It is the same service account the Shopify reconciler
already uses.

### Check on it any time

```
ssh marathonclub@100.64.186.78 'launchctl print gui/$(id -u)/com.marathon.socialpublish | head -20'
```

`state = not running` between fires is correct — this is a scheduled tick, not a
server. What you want to see is `program = /opt/homebrew/bin/node` and the three
`calendarinterval` entries for Weekday 1, 3 and 6 at Hour 18.

More:

```
ssh marathonclub@100.64.186.78 'tail -f ~/marathon-social/logs/social-publish.log'
ssh marathonclub@100.64.186.78 'cd ~/marathon-social && node scripts/social/publish.mjs --status'
ssh marathonclub@100.64.186.78 'cd ~/marathon-social && node scripts/social/publish.mjs --dry-run'
```

`--status` prints `meta: ready` once step 3 is done and lists what is queued.
`--dry-run` says exactly what it would post, and posts nothing.

A quiet tick is one line in the log. A failure is bannered `✗✗ RUN FAILED`, and
consecutive failures are counted so an outage reads as an outage rather than a
quiet night.

### Stop it

```
ssh marathonclub@100.64.186.78 'launchctl bootout gui/$(id -u)/com.marathon.socialpublish'
```

---

## 5b. The alarm — INSTALLED 2026-08-27, nothing to do

The engine's worst failure is not an error, it is a quiet day. On 2026-08-27
every part reported success and the day's reel and three stories were never
made: Gemini answered 429 "prepayment credits are depleted" six times into a
log nobody was reading. The launchd agent was alive, the token was valid, no
post was marked failed, and one leftover post published at 11:00 — so
"did anything post today?" would have said yes.

`socialHealthScan` (Cloud Function, hourly 07:25–22:25 SAST) now assesses the
day on four independent questions, any one of which raises the alarm:

| # | question | catches |
|---|---|---|
| 1 | did the 06:00 generator run, and make what the policy asked for? | the 2026-08-27 failure |
| 2 | is anything approved, due and 20+ minutes late? | a publisher that has stopped |
| 3 | was anything owed today, and did nothing publish? | total silence |
| 4 | has the Mac mini ticked in the last 15 minutes? | a dead launchd agent, *before* the day is lost |

**The alarm arrives as an email to junidmoh@gmail.com**, sent by Google Cloud
Monitoring off a log-based metric — not by this project, and not by the Mac
mini. That separation is the point: an alarm running on the same machinery as
the thing it watches is not an alarm.

One email per distinct problem per day, not one per hourly run — the day's
record carries the signature of what was last alerted on, so a day that gets
*worse* sends a second email and a day that stays the same does not.

Check it, or reinstall it after a change:

```
node scripts/social/install-social-alarm.mjs --verify   # assert, change nothing
node scripts/social/install-social-alarm.mjs            # create / update (idempotent)
node scripts/social/install-social-alarm.mjs --test     # send a real test email
```

The full verdict for any day is in RTDB at `/social_health/days/<date>`, and
the publisher's heartbeat at `/social_health/publisher`. Both are written by
the Admin SDK and need **no database rule** — nothing in the browser reads
them today. If a screen is ever built on them, this is the rule and it goes in
**Firebase console → Realtime Database → Rules**, as one new top-level key:

```json
"social_health": {
  ".read": "auth != null && root.child('users').child(auth.uid).child('stockRole').val() === 'admin'",
  ".write": false
}
```

`".write": false` is deliberate: only the Admin SDK writes here, and it bypasses
rules. A browser must never be able to forge a healthy day.

### Why not WhatsApp

It was the first choice and it cannot carry this. Meta accepts a free-form
WhatsApp message only inside a 24-hour window the *recipient* opens, which no
unattended alarm can depend on. The alternative — a new approved template —
needs the WhatsApp Business Account id, and checked on 2026-08-27: the
whatsapp system-user token holds `whatsapp_business_management` but not
`business_management`, and the Meta Page token holds `business_management` but
not `whatsapp_business_management`. Neither can enumerate the WABA, so no
combination of the credentials this project already has can create one.

---

## 5c. Every story is on the feed too — LIVE 2026-08-27

Owner brief: *"post all the stories on feeds as well, same picture should be
posted both places."*

Every story now writes a **second post record** with format `feed`, carrying
**the identical picture** — the same Storage URL, not a re-render — scheduled
at the same minute, going to Instagram and Facebook both.

With the default policy that makes a day look like this:

| policy slots | on the feed | on stories |
|---|---|---|
| 2 reels | 2 reels | — |
| 1 photo | 1 photo | — |
| 3 stories | **3 photos** (the twins) | 3 stories |
| **6 slots** | **6 posts** (4 photos + 2 reels) | **3 stories** |

**Six slots, nine posts.** The cost does not change: the autopilot makes one
image per slot, and a twinned story's image is paid for once and used twice.
(Slots, not "images paid for": the *manual* Generate tab can also make a "new
arrivals" post, which reuses photographs the storefront already has and
generates nothing. The autopilot never picks that kind.) The twin adds one caption call, a few
hundredths of a cent — a story shows no caption and skips the model entirely,
but a feed post does show one, so the twin gets a real one and the story keeps
its plain line.

This is why the **Policy tab still reads "1 photo"**. It counts *slots*, not
what lands. The screen now spells out what those slots produce, underneath the
total — and if the twin is ever switched off, that sentence changes with it
rather than promising copies nobody is making.

### Why the same picture and not a 4:5 re-render

Instagram's feed used to refuse anything narrower than 4:5, which would have
forced a crop of the 9:16 story artwork and could have cut a product in half.
Measured against the live account on 2026-08-27: a 9:16 feed container is
**accepted**, and Instagram's own CDN serves the published image back at
**1072x1920** — not cropped. So there is nothing to re-render.

The one real consequence: Instagram's **grid thumbnail** is at most 4:5, so a
9:16 post is centre-cropped in the grid and whole when opened. That is
inherent to putting a story-shaped picture on a feed, not a fault in the code.

### Turning it off

Set `STORY_ALSO_POSTS_TO_FEED=false` in `functions/.env`, then redeploy
`functions:socialDailyAutopilot` and `functions:generateSocialPosts`. A
build-time flag, the same convention as `SOCIAL_AUTOPILOT_ENABLED`.

`socialCore.js` carries a **mirror** of the same flag, which is what the Policy
tab reads to describe the day — the browser never creates a twin. Turn the
backend off and flip the mirror too; `socialFormat.test.js` pins the two
literals together and fails until you do.

### The two records are independent

They share the picture, the slot, the products and the platforms. They do NOT
share the caption, the status, or the retries — either can be edited, held or
thrown away in the queue without touching the other. The twin carries
`twinOf` and the story carries `twinId`, so the pair is always findable.

---

## 5d. Reel length — 15 seconds, four moves (2026-08-27)

Reels were **6 seconds**. Six seconds is a GIF, not a reel: watch time is the
signal Instagram's discovery system reads, and six seconds accumulates almost
none of it.

**Now 15 seconds**, with four distinct camera moves instead of one slow creep:
push in → hold and drift up → pull back to the full scene → settle low on the
price.

### Why 15 and not 45

The published numbers disagree, and the headline one is the wrong one for us.
Socialinsider's 2026 study of ~140,000 business reels put the **45–60s** bracket
top for engagement and median views; most other guidance says **15–30s**. Both
are measuring videos with something *happening* — cuts, speech, a story.

**Ours is one photograph.** A minute of slow pan on a still gets abandoned, and
**completion rate** is the signal underneath both studies: a short clip most
people finish outranks a long one most people quit. So the number is chosen
against what we can actually fill — the floor of the 15–30s band, 2.5x what it
was, with enough movement to earn the extra nine seconds.

**This is a guess with a plan to stop guessing.** Once
`instagram_manage_insights` is on the token, reel retention is readable per
post and `REEL_SECONDS` should be set from our own completion numbers. It is
one constant in one place for exactly that reason.

### The move is bounded by the design's own safe area

`social-design.cjs` reserves `safeTop` 250px and `safeBottom` 320px on a reel
and draws the wordmark and the shop line there. A zoom of Z crops
`h*(1-1/Z)/2` per edge; a y offset crops `h*|y|` more from one of them. At the
deepest point (1.14 with y −0.05) the bottom loses 214px — inside the 320px the
design left empty, which is why the drift goes **up**: the space below the shop
line is the only room on this canvas. A test enforces this; a reel that crops
its own branding is worse than one that moves less.

### Measured on the mini

`1080x1920 · h264 High · yuv420p · color_range tv · 30fps · 450 frames ·
15.000s · AAC · 2.9 MB · 5.1s to encode` — well inside the 120-second tick.

`npm run proof:social` runs all three social mutation proofs, including
`mutation-proof-reel-motion.mjs` (17/17).

---

## 6. Day to day

App → **Social**.

- **Generate** — tick the post types, tap once. Every button shows what it
  costs. Your painted backdrop is the default; clean white has to be chosen and
  is for advertising.
- **Queue** — each item shows its picture, caption, platforms and slot. Approve,
  edit the caption, change platforms, reschedule, or throw it away. Approving
  does not post: it makes the item eligible for the next scheduled run.
- **Style library** — keep adding things you like.

### Cost per post

| post type | what is generated | cost |
|---|---|---:|
| Single product | one Nano Banana Pro scene | **~$0.134** |
| Flat-lay (3–5 products) | one scene | **~$0.134** |
| Full outfit (shoe/top/cap/fragrance) | one scene | **~$0.134** |
| New arrivals (carousel) | nothing — existing photos | **~$0.0004** |

The caption is a few hundredths of a cent on every type and is included above.
Three posts a week, all generated, is about **$1.60 a month**.

### Where things live

| what | where |
|---|---|
| Posts awaiting approval | RTDB `/social_posts` |
| Style reference index | RTDB `/social_style_refs` |
| Sell-through ranking cache | RTDB `/social_signal` (Admin-SDK only, no rule) |
| Style reference media | Storage `aiStudio/social/style-refs/` |
| Generated post images | Storage `aiStudio/social/posts/{postId}/` |
| Meta Page token, Page id, IG id | Google Secret Manager |
| Publisher log | `logs/social-publish.log` on the Mac mini |
