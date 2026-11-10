# Social outage, 5–10 Nov 2026: Gemini credits again, and the alarm mailed the wrong inbox

Diagnosed 10 Nov 2026 from the Cloud Functions logs, the Mac mini publisher
log, Secret Manager, the Meta Graph API and the Monitoring API.

## What Meta Business Suite showed

- Wed 4 Nov 15:31: the last photo post, a plain shoe still on a lookbook day.
- Thu 5 and Fri 6 Nov: no photo post. Reels still posted.
- Fri 6 Nov 19:02: the last reel.
- Sat 7 Nov onward: nothing on Instagram or Facebook.
- No failure email reached Junid.

## Ruled out

| Suspect | Evidence | Verdict |
|---|---|---|
| Meta token expired | `debug_token`: type PAGE, `is_valid: true`, `expires_at: 0` (never expires). Publisher preflight logged "meta: ready" on every run through today. | Not the cause. The token has a data-access expiry on **14 Jan 2027 18:17 SAST**, now watched (see below). |
| launchd not reloaded after reboot | Last reboot Mon 2 Nov 17:35, before the outage. `com.marathon.socialpublish` (KeepAlive) is running and logged a tick every 2 minutes, 3 to 10 Nov, without a gap. | Not the cause. |
| Lookbook/stylist code killing the slot | Every lookbook day logged "lookbook failed the models-pending gate — posting the current style instead". The fallback ran each time. The fallback then failed on the provider (below). | Not the cause. The fallback already wraps any lookbook throw (`socialStillAutopilot`). |
| Generation provider | `GEMINI_API_KEY` answers **HTTP 402 "Your prepayment credits are depleted"** to every call from **5 Nov 06:00 SAST** through today (re-checked live on 10 Nov). | **The cause.** |

## Photo slot (from Thu 5 Nov)

The 15:30 still is generated the same morning by `socialStillAutopilot` (07:00).

- 4 Nov (Wed, lookbook day): the lookbook was refused by the models-pending
  gate (Junid has not yet approved the new house models). This is the designed
  behaviour, so the day posted the current style. That is the plain still seen
  in Business Suite.
- 5, 7, 8, 10 Nov: "planned current, posted NOTHING". Gemini 402.
- 6, 9 Nov (lookbook days): models-pending gate, then the current-style
  fallback also hit Gemini 402. "posted NOTHING".

## Reel slot (from Sat 7 Nov)

`socialDailyAutopilot` (06:00) has made 0 of 1 every day since 5 Nov, with
the skip reason "AI credits depleted or rate-limited (429) — check Gemini
billing". That text is misleading because the provider actually answered 402.
The publisher still posted on 5 and 6 Nov at 19:02 from reels generated
earlier (the queue held "4 approved" on 5 Nov and "2 approved" on 6 Nov).
Once that buffer drained, the 19:02 slot had nothing to post from 7 Nov.

## Why no email reached Junid

`socialHealthScan` worked. It raised `SOCIAL_ENGINE_ALARM` at 07:10 on 5 Nov
and three or four more times each day after. The Cloud Monitoring policy
"Social engine alarm" emailed it to its only notification channel,
**junidmoh@gmail.com**. Junid reads **gunidmoh@gmail.com**. The write-off
digest found and fixed the same mismatch on 1 Nov by moving to Gmail SMTP
from the Mac mini. The social alarm was never moved.

This is the third Gemini-credits outage: 27 Aug, 13 Sep (see
`SOCIAL-OUTAGE-2026-09-13.md`), and 5 Nov.

## What only Junid can do

Top up the Gemini prepaid balance and turn on auto-reload, so it cannot run dry
a fourth time: <https://aistudio.google.com/app/billing> (project
`marathon-club`). No credential this project holds can do that.
