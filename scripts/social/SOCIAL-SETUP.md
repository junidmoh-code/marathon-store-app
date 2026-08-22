# Social content engine — setup

Everything Junid has to do by hand, in the order it has to be done. Each step
says where, and what it looks like when it worked.

Nothing in this feature posts anything until an item has been approved in the
app. That is not a setting; it is `postBlocker()` in
`src/components/social/socialCore.js`, called by the publisher on the machine
that does the posting, immediately before the first platform call.

---

## 0. Before anything: the billing account

**As of 2026-08-22 the Google Cloud billing account for `marathon-club` is
disabled, state `delinquent`.** While that is true:

- Firebase Storage returns HTTP 402 for every object, so the generator cannot
  read a product photo and the app cannot show one.
- The Gemini API returns `403 PERMISSION_DENIED — "Your project has been denied
  access"`, so no image is generated regardless of credit balance.
- A Cloud Functions deploy will fail (Cloud Build and Artifact Registry both
  need billing).

The queue, the style library and the publisher do not depend on it and work
either way. **Step 3 onwards is blocked until billing is restored.**

Check it: <https://console.cloud.google.com/billing> → the `marathon-club`
project → make sure the linked account is active and the card is good.

---

## 1. Paste the database rules — 2 minutes, do this first

The live database has no root rule, so a brand-new top-level path denies
everything. Until these are in, the Social screen loads and says so in plain
words.

```
node scripts/social/print-social-rules.mjs
```

Copy the two blocks it prints into **Firebase console → Realtime Database →
Rules**, alongside the existing `shopify_publish` key.

**Add the two keys. Do not paste over the whole document, and do not run
`firebase deploy --only database`** — the live rules hold nodes the repo's
`database.rules.json` has never held, and both would delete them.

*Worked when:* the Social tile opens the queue instead of a permission error.

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
does.

### 3a. In the browser — developers.facebook.com

1. **My Apps → Create App → type "Business".** Call it anything; "Marathon
   Social" is fine.
2. In the app: **Add Product** → add **Instagram** (Instagram Graph API) and
   **Facebook Login for Business**.
3. **App Roles → Roles** — confirm your own account is listed as
   **Administrator**. This is the step that makes App Review unnecessary.
4. **Settings → Basic** — copy the **App ID** and **App Secret**. You will paste
   these into a terminal in a moment, as environment variables, not as
   arguments.
5. **Tools → Graph API Explorer.** Pick your app top-right. Click **Generate
   Access Token** and grant:
   - `instagram_basic`
   - `instagram_content_publish`
   - `pages_show_list`
   - `pages_read_engagement`
   - `pages_manage_posts`

   (Add `ads_management` and `ads_read` only if the exchange in 3b complains
   about a missing scope — some Pages under a Business Manager require them.)
6. Copy the token it shows. It lasts about an hour, which is plenty, and it is
   the last token you will ever have to copy.

### 3b. In a terminal, on the Mac mini

```
export META_APP_ID=…
export META_APP_SECRET=…
node scripts/social/meta-token.mjs --short-lived <THE TOKEN FROM STEP 6>
```

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

## 5. Install the schedule on the Mac mini — 5 minutes, once

Three posts a week: **Monday, Wednesday and Saturday at 18:00 SAST**. Those three
times are in the plist AND in `SLOT_DAYS` / `SLOT_HOUR_SAST` in
`src/components/social/socialCore.js` — the queue shows those slots and the
generator assigns them. A test pins the plist and the code to the same days and
hour, so they cannot drift apart silently.

```
cp scripts/social/com.marathon.socialpublish.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.marathon.socialpublish.plist
```

Paths in the plist assume the repo is at `/Users/marathonclub/marathon-store-app`
— change both `ProgramArguments` and `WorkingDirectory` if not.

`RunAtLoad` is deliberately **false**: loading the agent must never fire a post.
A missed fire (the mini was asleep) runs as soon as it wakes, so an approved
post goes out late rather than being skipped for the week.

The service account at `GOOGLE_APPLICATION_CREDENTIALS` needs
**`roles/secretmanager.secretAccessor`** to read the Meta token. It is the same
service account the Shopify reconciler already uses.

*Worked when:*

```
node scripts/social/publish.mjs --status
```

prints `meta: ready` and lists what is queued. Then:

```
node scripts/social/publish.mjs --dry-run
```

says exactly what it would post, and posts nothing.

Read the log with:

```
tail -f ~/marathon-store-app/logs/social-publish.log
```

A quiet tick is one line. A failure is bannered `✗✗ RUN FAILED`, and consecutive
failures are counted so an outage reads as an outage rather than a quiet night.

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
