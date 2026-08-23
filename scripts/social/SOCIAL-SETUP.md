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
`firebase deploy --only database`** — the live rules carry **59 top-level keys**
(counted against the running database on 2026-08-23) that the repo's
`database.rules.json` has never held, and either would delete them.

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
ssh marathonclub@100.64.186.78 'launchctl print gui/501/com.marathon.socialpublish | head -20'
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
ssh marathonclub@100.64.186.78 'launchctl bootout gui/501/com.marathon.socialpublish'
```

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
