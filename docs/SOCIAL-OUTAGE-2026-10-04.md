# Social engine silent, 4–7 October 2026

Junid reported on 7 Oct that nothing had posted for two days. This is the
diagnosis, recorded before any fix.

## Classification

**Queue empty, because the generator was switched off.** It was not the
scheduler, the Meta token, a generation failure, or a publish rejection.

PR #682 (merged 3 Oct, 19:29) changed `SOCIAL_AUTOPILOT_ENABLED` in
`functions/index.js` from default-ON (`!== "false"`) to default-OFF
(`=== "true"`). No `functions/.env` exists, so the deployed autopilot has
returned immediately at 06:00 every day since. It writes no posts and no run
record.

The watchdog (`socialHealthScan`) saw every one of those days and paged on
none of them. That is the second defect, covered below.

## Evidence

**Scheduler (Mac mini).** The live checkout is `~/marathon-social`, run by the
user LaunchAgent `com.marathon.socialpublish` (KeepAlive, ThrottleInterval
120). `launchctl print`: state `spawn scheduled`, 902 runs, last exit 0. The
publisher ticked every two minutes for the whole period, and on 7 Oct every
tick logged `tick: nothing approved and due`.

The mini lost its network from about 05:19 to 11:42 on 6 Oct
(`EHOSTUNREACH` / `ENOTFOUND accounts.google.com`, six one-hour runs killed)
and then rebooted. The agent came back on its own at 11:42:53 (auto-login is
on, `pmset autorestart 1`). That outage cost nothing, because there was
nothing to post.

**Last successful posts** (`logs/social-publish.log`):

| When (SAST) | What |
|---|---|
| 3 Oct 12:01 | reel + story twin |
| 3 Oct 19:02 | reel `instagram.com/reel/DeCjF7UFO0B` + story twin, the last reel |
| 5 Oct 18:00 | one leftover photo `instagram.com/p/DeHlqCPF3KZ`, from the backlog |

**Generator.** In Cloud Logging, `socialDailyAutopilot` logged a full run on
2 and 3 Oct (`2 made, 0 skipped, 2 twin(s), ~$0.32`). It was redeployed
3 Oct 17:31 / 17:50, and from then on logged:

```
2026-10-04T04:00:45Z  socialDailyAutopilot: off (runs only when SOCIAL_AUTOPILOT_ENABLED=true)
2026-10-05T04:00:19Z  (same)
2026-10-06T04:00:05Z  (same)
2026-10-07T04:00:05Z  (same)
```

`/social_autopilot_log/2026-10-04` through `2026-10-07` are all absent. The
Cloud Scheduler job `firebase-schedule-socialDailyAutopilot-europe-west1` is
ENABLED at `0 6 * * *` Africa/Johannesburg, so the scheduler fired and the
code declined to run.

**Meta.** `meta-token.mjs --check`: token, page id and IG user id are all
present, and the Page "Marathon Club" and IG 17841427682308196 resolve. The
publisher's last real tick logged `meta: ready`.

**Why no alarm.** `/social_health/days/2026-10-04..07` all read
`severity: "degraded"` with `the 06:00 generator has no record of running
today`. Only `silent` pages. `assessSocialDay` treats a generator that made
nothing as silent *only when a run record exists*. With no record and nothing
in the queue, "nothing has published today" never applied either, because it
counts only posts already queued for today. The policy said two reels were
owed; nothing checked that against what landed. The one email in the period
(6 Oct, about 07:25) was for the dead publisher during the network outage,
not for the generator.

## A note on intent

#682's own commit message says the change was deliberate ("no image is
generated without his tap"). The owner brief of 7 Oct supersedes it for the
social engine: *automated or not at all*, two reels a day, each also posted as
a story, and no fix that needs a manual step on a schedule. A daily
tap-to-approve is that manual step. The fix therefore restores the default-ON
autopilot for social. The other parts of #682 (the new-arrivals photo studio
needs a tap, no unattended "generate next N" sweep) are not touched.

## Fix (7 Oct, PR #706)

- `SOCIAL_AUTOPILOT_ENABLED` is back to default ON (`!== "false"`), and a test pins it.
- The first run after re-enabling made nothing. Nano Banana Pro answered 503 "high demand", and an outfit found no bottom in stock. The generator now:
  - retries a 5xx (30 s, then 90 s) within a run deadline;
  - falls through to the other kinds when stock can't make the requested one;
  - falls back to the Flash image model when Pro returns 5xx;
  - gives back a budget unit that a 5xx never spent.
- 7 Oct 18:19 run: 2 reels + 2 story twins, slotted 19:00 today and 12:00 on 8 Oct.
- Captions fell back to the template line: the Anthropic API credit balance is too low (https://console.anthropic.com/settings/billing).

## The alarm

`socialHealthScan` runs at :10/:25/:40/:55, 07:10–23:55 SAST. Every policy slot (and its story twin) must be matched by a post that actually landed on a platform by 20 minutes after the slot. If one isn't, the day is graded **silent** and the scan logs `SOCIAL_ENGINE_ALARM …`. The message names the missed slot and the cause:
- the generator is switched off;
- no run record by 06:40;
- the generator's own error or skip reasons;
- the publisher heartbeat is stale;
- the newest failed publish's own error text.

Cloud Monitoring policy "Social engine alarm" matches the marker and emails junidmoh@gmail.com. That is email only, delivered by Google, and independent of the Mac mini. Each distinct problem is emailed once per day. Check the setup with `node scripts/social/install-social-alarm.mjs --verify`. Verified live on 7 Oct 18:24: `Social engine SILENT on 2026-10-07. the 12:00 reel has not landed; the 12:00 story has not landed`.

Known limits:
- Posts created more than 21 days ago are outside the scan's key-range read.
- The alert policy auto-closes after 30 min. A second distinct problem inside that window is folded into the open incident rather than emailed again.

## Reboot

The `com.marathon.socialpublish` LaunchAgent is enabled, with KeepAlive and a ThrottleInterval of 120 s. Auto-login (`marathonclub`) and `pmset autorestart 1` bring it back after a power cut. Proven on 6 Oct, when it resumed 53 s after the 11:42 reboot. If it ever stops, the heartbeat check emails within about 30 min.
