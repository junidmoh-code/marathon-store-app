# The social engine stopped on 2026-09-13. This is what happened.

Written 2026-09-19, from production, not from the code.

## One sentence

**Gemini's prepayment credits ran out.** Every image generation since the
06:00 run on **2026-09-13** has been refused with HTTP 429
`RESOURCE_EXHAUSTED — "Your prepayment credits are depleted"`, so the
autopilot made nothing, and Instagram and Facebook went quiet as soon as the
already-generated backlog ran dry.

Nothing in this repository was broken. Nothing on the Mac mini was broken. No
token expired. No launchd job died.

## The evidence

`/social_autopilot_log/{date}`, read from production:

| SA date | created | skipped | run took | cost |
|---|---:|---:|---:|---:|
| 2026-09-08 | 6 | 0 | 244 s | $0.946 |
| 2026-09-09 | 6 | 0 | 260 s | $0.957 |
| 2026-09-10 | 6 | 0 | 211 s | $0.955 |
| 2026-09-11 | 6 | 0 | 221 s | $0.941 |
| **2026-09-12** | **5** | **1** | 191 s | $0.780 |
| **2026-09-13** | **0** | **6** | **7 s** | **$0** |
| 2026-09-14 … 09-19 | 0 | 6 | 5–17 s | $0 |

- **Last good generation:** 2026-09-12 06:00 SAST — five of six made, one
  skipped. That single skip is the credit balance running out mid-run.
- **First total failure:** 2026-09-13 06:00 SAST (`startedAt`
  1789272064792), finished 7.6 seconds later having made nothing.
- A run that makes nothing costs nothing and takes seconds, which is what a
  fast API refusal looks like. A healthy run takes three to four minutes.

The error itself, reproduced against the live `GEMINI_API_KEY` secret on
2026-09-19 (the value was never printed):

```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent
HTTP 429
{"error":{"code":429,"status":"RESOURCE_EXHAUSTED",
  "message":"Your prepayment credits are depleted. Please go to AI Studio …"}}
```

**Last successful post:** 2026-09-18 18:01 SAST — a reel, to both platforms.
`https://www.instagram.com/reel/Ddb0P_tkdps/` and
`https://facebook.com/1081360357835030`. That post was *generated on
2026-09-12*; the publisher has simply been draining what was left.

## The three suspects, each eliminated with evidence

**(a) The Anthropic key rotated on 8 September — NOT the cause.**
The Mac mini reads no Anthropic key at all. Its `~/marathon-social/.env`
carries three keys and all three are Shopify's (`SHOPIFY_SHOP`,
`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`); every platform credential it
uses comes from Google Secret Manager at run time, through the service
account named in the launchd plist. There is no local copy of any key to go
stale.

Anthropic is used in one place — `writeSocialCaption` in `functions/index.js`
— and a failure there is caught by design: the post keeps a plain fallback
caption and is recorded `captionSource: "fallback"`. It cannot cause a skip,
and the skipped runs spent `$0`, which means they never reached the paid
image call, let alone the caption after it.

**(b) The Meta token re-minted under "Di Streda" — NOT the cause.**
`debug_token` against the live token, 2026-09-19:

```
type: PAGE | app: Marathon Social | is_valid: true | expires_at: NEVER (0)
scopes: pages_show_list, ads_management, ads_read, business_management,
        instagram_basic, instagram_manage_insights, instagram_content_publish,
        pages_read_engagement, pages_manage_posts, public_profile
```

A Page token minted from a long-lived user token, so it does not expire, and
it holds all five scopes the publisher needs. **One date worth diarising:**
`data_access_expires_at` is **2026-11-27**. That is not the token expiring,
but it is the day the app's access to this Page's data lapses unless the
owner re-authorises. Section 3a of `SOCIAL-SETUP.md` is the fifteen-minute
fix when it comes.

**(c) A launchd job died or was overwritten — NOT the cause.**
`com.marathon.socialpublish` and `com.marathon.socialwatchdog` are both
loaded. The publisher has ticked every two minutes without a gap —
`logs/social-publish.log` runs continuously to the present, `consecutiveFailures`
is 0, and `/social_health/publisher/lastTickAt` was minutes old when checked.

## Why nobody was told for six days

This is the part that is a defect in this repository, and it is fixed in the
same change as this note.

`socialHealthScan` DID notice, every hour, from the first morning. It wrote
`the 06:00 generator made nothing — all 6 skipped` to
`/social_health/days/{date}` on every one of those days. But it graded that
day **`degraded`**, and only **`silent`** sends an email (owner ruling,
2026-08-31: "the alert should only come when the system is down"). A day was
graded `silent` only when nothing published or the mini stopped ticking —
and neither was true, *because the backlog was still going out*.

So the engine's own backlog hid the engine's death. Two of the six days did
page, and only because they tripped a different check as well.

**A generator that made nothing is down.** Whatever is still leaving
yesterday's queue, it cannot make tomorrow's. That is now the rule:
`assessSocialDay` grades a finished run that created zero, or a run that
errored, as `silent`, and `social-health.test.cjs` replays the real
2026-08-27 day to pin it.

## The second thing this diagnosis could not do, now fixed

The reason lived **only** in Cloud Logging. Reading it needs a Google
identity with `logging.viewer`; the mini's own service account is refused
outright (`Permission denied for all log views`), and the local Firebase CLI
login had expired. So the single field that says *what to do* about a dead
engine was the one field the machine diagnosing it could not reach, and six
mornings of runs were indistinguishable from six quiet days.

The autopilot now writes `skipReasons` onto its own run record in RTDB —
deduped, counted, bounded — and the health scan puts the first of them into
the alarm sentence. The next time this happens the email itself will say
*check Gemini billing*.

## What only the owner can do

Top up the Gemini prepayment balance. Nothing in this codebase can, and no
credential this project holds can:

**<https://aistudio.google.com/app/apikey>** → the `marathon-club` project →
**Billing / prepaid credits** → top up.

At the rates measured below, **$10 buys about two months** of the new
two-reels-a-day rhythm.

Until that is done the autopilot will keep making nothing, keep recording
`skipReasons: ["6x AI credits depleted or rate-limited (429) — check Gemini
billing"]`, and now keep emailing about it once a day.
