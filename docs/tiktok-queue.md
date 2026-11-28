# TikTok handoff queue (Higgsfield, until the audit passes)

TikTok refuses every post from Signal Studio's app to a public account until
the Direct Post audit passes (submitted 28 Nov 2026, ref 20261128074550, 2–4
weeks). Until then Marathon Club's TikTok posts go out **through Higgsfield**,
approved by Junid in his Claude chat. This queue is what that chat pulls from.

Nothing here posts to TikTok. Signal Studio's own TikTok connection stays
private until the audit passes; then automatic direct posting replaces this
queue (a separate build).

## The queue URL

```
https://mac-mini-von-marathon-3.tail5a5180.ts.net/studio/tiktok-queue/latest.json
```

Public, no auth, `cache-control: no-store`. Any earlier batch:
`.../studio/tiktok-queue/batches/<YYYY-MM-DD>-<morning|evening>.json`.

| Batch   | Built at (launchd) | Ready by   |
|---------|--------------------|------------|
| morning | 09:00 SAST         | 09:15 SAST |
| evening | 17:30 SAST         | 17:45 SAST |

### What a batch looks like

```json
{
 "batch_id": "2026-11-28-evening",
 "slot": "evening",
 "date": "2026-11-28",
 "ready_by": "2026-11-28 17:45 SAST",
 "generated_at": "2026-11-28T15:30:41.120Z",
 "stale": false,
 "pending": 3,
 "posts": [
  {
   "post_id": "-P-oWga5XwgZ4cnW2LJm",
   "media_type": "PHOTO",
   "media_urls": ["https://mac-mini-von-marathon-3.tail5a5180.ts.net/studio/tiktok-queue/media/-P-oWga5XwgZ4cnW2LJm/1.jpg"],
   "caption": "Court Cage on feet, Emporio Armani tracksuit on the body, Louis Vuitton California Dream on the skin.",
   "hashtags": ["#Lacoste", "#EmporioArmani", "#MarathonClub", "#OOTD", "#SouthAfrica"],
   "slot": "evening",
   "date": "2026-11-28",
   "kind": "outfit",
   "is_aigc": true,
   "offers_before": 1,
   "rolled_over": true,
   "status": "pending"
  }
 ],
 "mark_posted": { "method": "POST", "url": ".../mark-posted", "auth": "Authorization: Bearer <token>", "body": { "post_id": "<post_id>", "tiktok_url": "<optional>" } }
}
```

- `status`: `pending` (still to post), `posted` (confirmed), `skipped` (Junid declined it).
- `stale: true` means a build was missed (the batch is over 13 hours old). Check the logs below.
- `rolled_over: true`: this post was in the previous batch and nobody confirmed it.
- `is_aigc`: the art is AI-generated (everything except New Arrivals posts). Declare it in the TikTok form.

### Media guarantees

- **PHOTO**: JPEG, exactly 1080x1920, at most 20 MB. 9:16 story renders are used as they are. Other art sits on a blurred, darkened fill of itself, the Instagram story look. Up to 10 images per post.
- **VIDEO**: MP4, H.264/AAC, 3–600 s, 23–60 fps, at least 360 px on both sides, at most 50 MB (Higgsfield's import limit). Videos off spec are re-encoded at 30 fps; ones that can't be fixed are never offered (`rejects.json`).
- Media URLs download directly: no auth, correct `content-type`, byte ranges supported.

### Captions

These come from the post's Instagram caption, using its first two paragraphs only. Later paragraphs hold the CTA tail and, on some older posts, a leaked internal styling note. Rules: at most 150 characters (Higgsfield's `title` limit), at most 2 emoji, and no sentence that carries a phone number, an address, a link, an email, "call/WhatsApp us" or "link in bio". Plus 3–5 hashtags: up to 2 of the post's own, then `#MarathonClub`, a style tag (`#OOTD` or `#SneakerTok`) and `#SouthAfrica`.

## Publishing a post from Junid's Claude chat

1. Fetch `latest.json`. Work through the posts with `status: "pending"`.
2. Higgsfield only publishes Higgsfield-hosted media, so import each media URL with `media_import_url`.
3. `tiktok_accounts`: use the **marathon-club** account (connector `e9002774-6f8b-4860-b24c-86c0beb53aca`, connected 28 Nov 2026). Never use `concrete-world`.
4. `tiktok_prepare_publish` with `mode: "DIRECT_POST"`, `media_type`, the imported URL(s) (`photo_images` or `video_url`), `title` = `caption`, `description` = caption + a blank line + the hashtags joined by spaces, and `is_aigc` from the post. Junid reviews and submits the form himself.
5. Once TikTok shows the post as live (`tiktok_publish_status`), **mark it posted** (next section). Only then: a post that was never confirmed rolls into the next batch.

## Marking posts (token-protected)

The token is in **`~/.config/marathon/tiktok-queue.token`** on the Mac mini
(chmod 600, created by the installer). Junid copies it into his Claude chat's
project instructions. To read it: `cat ~/.config/marathon/tiktok-queue.token`.
To rotate it: write a new 64-hex value to the file (`openssl rand -hex 32 >
~/.config/marathon/tiktok-queue.token`). The server reads it on every request,
so no restart is needed.

```bash
BASE=https://mac-mini-von-marathon-3.tail5a5180.ts.net/studio/tiktok-queue
TOKEN=$(cat ~/.config/marathon/tiktok-queue.token)

# confirmed live on TikTok
curl -s -X POST "$BASE/mark-posted" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"post_id":"-P-oWga5XwgZ4cnW2LJm","tiktok_url":"https://www.tiktok.com/@marathon.club7/photo/..."}'

# Junid does not want this one: never offered again
curl -s -X POST "$BASE/mark-skipped" -H "Authorization: Bearer $TOKEN" -d '{"post_id":"..."}'

# undo a mistaken mark (posted or skipped)
curl -s -X POST "$BASE/unmark" -H "Authorization: Bearer $TOKEN" -d '{"post_id":"..."}'
```

`X-Queue-Token: <token>` works in place of the Authorization header. For chat
tools that can only fetch URLs, each endpoint also takes a GET with query
parameters: `$BASE/mark-posted?post_id=<id>&token=<token>` (plus optional
`&tiktok_url=`). Marks are idempotent: a second mark returns `already: true`.
An unknown `post_id` (not in any batch) returns 404, a bad token 401.

## How the posts are chosen

- **Source:** the same family queue as the Signal Studio poster (`tiktokQueue.buildQueue`). That is every post that really went out on Instagram or Facebook, once per family (a feed post, its story twin and its reel count as one), with no stories. `post_id` is the family key.
- **Order:** photo posts first, oldest first, then videos (Junid, 28 Nov 2026).
- **Never a repeat:** a family is never offered again once it is marked posted or skipped, rejected for unusable media, or recorded in the poster's ledger as having reached TikTok (`~/.marathon-tiktok/ledger.json`).
- **Rollover:** the previous batch's unconfirmed posts come first in the next batch, with the same `post_id` and the same files. After 4 offers without a confirmation, a post goes behind every never-offered family so it can't block the queue.
- **When the audit passes:** the Signal Studio poster (`tiktok-poster.mjs`) reads `posted.json` and never reposts what went out through Higgsfield.

## Running it

| Piece | Where |
|---|---|
| Builder | `scripts/social/tiktok-queue-build.mjs`, launchd `com.marathon.tiktokqueue.build` |
| Server | `scripts/social/tiktok-queue-server.mjs` on 127.0.0.1:8798, launchd `com.marathon.tiktokqueue.server` (KeepAlive) |
| Funnel | `/studio/tiktok-queue` → 127.0.0.1:8798 (the rest of `/studio` stays with Signal Studio on 8797) |
| State | `~/.marathon-tiktok-queue/`: `batches/`, `media/`, `latest.json`, `rejects.json` (builder); `posted.json`, `skipped.json` (server only) |
| Logs | `logs/tiktok-queue.log`, `logs/tiktok-queue.err.log`, `logs/tiktok-queue-server.log` |
| Pure logic + tests | `tiktokHfQueue.mjs`, `tiktokHfQueue.test.mjs`, `tiktokQueueServer.test.mjs` |

```bash
bash scripts/social/install-tiktok-queue.sh                       # install / refresh jobs, token, Funnel path
node scripts/social/tiktok-queue-build.mjs --dry-run              # show the next picks, write nothing
node scripts/social/tiktok-queue-build.mjs --slot evening --force # rebuild a batch by hand
```

A batch that already exists is never rebuilt without `--force`. That makes a launchd catch-up after sleep safe. If Storage is briefly down, the batch is built from the posts that could be prepared, and the others stay in the queue.
