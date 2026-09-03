# The reconciler on the Mac mini — install & operate

**Why this exists.** Pressing **Publish** in the app writes an *intent* only —
the browser can never hold the Shopify client secret, so nothing reaches
Shopify until `scripts/shopify/reconcile.mjs` runs. Until now that was a
command Junid typed on his MacBook, and his laptop's network already failed one
commit run mid-push with `ETIMEDOUT`. Moving it to the always-on Mac mini on a
2-minute schedule is what makes Publish just work.

**Mechanism: launchd, matching the machine's existing marathon job.** The Mac
already runs `com.marathon.photograbber` as a user LaunchAgent
(`~/Library/LaunchAgents/com.marathon.photograbber.plist`: node + a repo
script, logs under the repo). This uses the same mechanism, same naming, same
log placement. **No second scheduler is introduced** — no cron, no pm2.

> **Status: NOT INSTALLED.** The session that wrote this could not reach the
> Mac mini (`ssh` was blocked by its permission policy — Tailscale showed the
> host up, so the wall was local, not the network). Everything below is written
> to be run as-is over SSH; nothing here has been executed on the mini, and the
> round-trip verification in §6 has not been performed.

---

## 1. What gets installed

| Piece | Path on the Mac mini |
|---|---|
| Repo checkout | `/Users/marathonclub/marathon-store-app` |
| Runner (single-flight wrapper) | `scripts/shopify/reconcile-runner.mjs` |
| launchd agent | `~/Library/LaunchAgents/com.marathon.shopifyreconcile.plist` |
| Readable log (rotated) | `logs/shopify-reconcile.log` |
| launchd's last-resort log | `logs/launchd.err.log` |
| Shopify credentials | `.env` at the repo root (git-ignored) |
| Firebase Admin credentials | a service-account JSON outside the repo |

If the repo lives anywhere other than `/Users/marathonclub/marathon-store-app`,
change **both** the `ProgramArguments` path and `WorkingDirectory` in the plist.

---

## 2. Get the code and its dependencies on the mini

```sh
ssh marathonclub@100.64.186.78

# One-time clone (skip if the repo is already there)
git clone https://github.com/junidmoh-code/marathon-store-app.git ~/marathon-store-app

cd ~/marathon-store-app
git checkout main && git pull

# The reconciler loads firebase-admin through functions/package.json,
# so the functions deps must be installed — this is NOT a functions deploy.
npm ci --prefix functions

# Sanity: node must be on the path the plist declares
which node && node --version
```

The plist names `/opt/homebrew/bin/node`, which is where Homebrew puts it on
Apple silicon and where it is on this mini. **If `which node` says anything
else, update the first `ProgramArguments` string in the plist to the real
path** — launchd does not search `PATH`, so a wrong absolute path does not
error: the job loads, appears in `launchctl list`, and silently never runs.
(This file used to name the Intel path, `/usr/local/bin/node`. See the note in
"Cost of an idle tick" below for how long that went unnoticed.)

---

## 3. Credentials — the two that must be present

**Nothing in this repo contains a credential value, and nothing below prints
one.** Only variable NAMES and file PATHS appear here.

### 3a. Shopify — three variables in a git-ignored `.env`

`scripts/shopify/env.mjs` reads these from the environment, topping up from a
`.env` at the repo root:

| Variable | What it is |
|---|---|
| `SHOPIFY_SHOP` | the store host; pinned — `env.mjs` refuses any other value |
| `SHOPIFY_CLIENT_ID` | the "Marathon Catalogue Sync" app's client id |
| `SHOPIFY_CLIENT_SECRET` | that app's client secret |

Copy the file across **without displaying it**, from the MacBook that already
has a working `.env`:

```sh
# run on the MacBook, not the mini
scp ~/Documents/marathon-store-app/.env marathonclub@100.64.186.78:~/marathon-store-app/.env
ssh marathonclub@100.64.186.78 'chmod 600 ~/marathon-store-app/.env'
```

Verify without revealing anything — this prints variable names only:

```sh
ssh marathonclub@100.64.186.78 'cd ~/marathon-store-app && cut -d= -f1 .env'
# expect exactly: SHOPIFY_SHOP / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET
```

### 3b. Firebase Admin — Application Default Credentials

`reconcile.mjs` calls `admin.initializeApp({ databaseURL })` with no explicit
credential, so firebase-admin uses ADC. A **service-account JSON** is the right
choice for an unattended machine (a `gcloud auth application-default login`
session is tied to a human and can expire):

```sh
# on the mini
mkdir -p ~/.config/marathon && chmod 700 ~/.config/marathon
# copy the service-account key here as:
#   ~/.config/marathon/shopify-reconciler-sa.json
chmod 600 ~/.config/marathon/shopify-reconciler-sa.json
```

The plist already points `GOOGLE_APPLICATION_CREDENTIALS` at that path. The
account needs **read** on `/products` and `/stock`, and **read+write** on
`/shopify_publish` and `/shopify_sync` (Admin SDK bypasses rules, so in
practice: the project's default service account, or any key with Firebase
Database access).

> **This is the step that needs Junid.** A service-account key cannot be minted
> or moved without him — it is not in this repo and must not be. If a key is
> not available, the alternative is running `gcloud auth application-default
> login` on the mini once, interactively, and dropping the
> `GOOGLE_APPLICATION_CREDENTIALS` line from the plist.

---

## 4. Install the schedule

```sh
ssh marathonclub@100.64.186.78
cd ~/marathon-store-app

# launchd does NOT create the parent directory of StandardOutPath /
# StandardErrorPath — if logs/ is missing the job fails to start, before the
# runner (which would have created it) ever gets to run. Make it first.
mkdir -p logs

cp scripts/shopify/com.marathon.shopifyreconcile.plist ~/Library/LaunchAgents/
plutil -lint ~/Library/LaunchAgents/com.marathon.shopifyreconcile.plist   # expect: OK

launchctl unload ~/Library/LaunchAgents/com.marathon.shopifyreconcile.plist 2>/dev/null
launchctl load  ~/Library/LaunchAgents/com.marathon.shopifyreconcile.plist
launchctl list | grep shopifyreconcile     # expect a line ending in the label
```

`RunAtLoad` fires the first tick immediately; `StartInterval 120` fires every 2
minutes thereafter.

**Reboot survival:** a LaunchAgent in `~/Library/LaunchAgents` is loaded
automatically at every login of that user — the same property that keeps
`com.marathon.photograbber` alive across reboots. Because it is a *user* agent
(not a system daemon), the mini must reach a logged-in desktop session for the
user `marathonclub`; that is already true for photograbber, so it holds here
too. **Confirm it after installing** by rebooting and running the log command
below — this session could not test it.

---

## 5. Reading the log

**The command Junid types:**

```sh
ssh marathonclub@100.64.186.78 'tail -40 ~/marathon-store-app/logs/shopify-reconcile.log'
```

Follow it live while testing a publish:

```sh
ssh marathonclub@100.64.186.78 'tail -f ~/marathon-store-app/logs/shopify-reconcile.log'
```

What the lines mean:

| Line | Meaning |
|---|---|
| `tick — no unapplied intent` | healthy idle tick; nothing to publish. Zero Shopify calls were made. |
| `── run start ── … ── run end: OK ──` | a real run; the reconciler's own output is indented inside, streamed as it happens |
| `── run end: completed, N product(s) REFUSED ──` | the run finished, but the apply-time validator refused N products. They are **blocked in the app with a reason** and their publish intent is cleared — retrying changes nothing until the cause is fixed there. Everything else in the run went live. Not an outage. |
| `tick skipped — a reconcile run is still in progress` | single-flight held; the previous run is still going |
| `✗✗ RUN FAILED (exit N)` | the run stopped before finishing. Whatever it had already applied **is live**; the rest is untouched and the next tick picks it up |
| `⚠⚠ N FAILED RUNS IN A ROW` | an outage, not a blip — check network and credentials before publishing again |
| `⚠ run pid … has been going N min` | a run has passed 30 minutes and is **still alive**, so this tick stood down rather than overlapping it. Nothing is reclaimed while a run lives; if it is genuinely stuck, kill the pid the line names |
| `⚠ stale lock from pid … (owner gone) — reclaimed` | a previous run died without cleaning up (crash, power cut); its lock was taken over |
| `── run end: STOPPED before finishing ──` | the runner was deliberately stopped mid-run (`launchctl unload`, reboot). Not counted as a failure |

Logs rotate at 5 MB, keeping 5 generations (`…log.1` … `…log.5`), so the disk
cannot fill. `logs/launchd.err.log` is the last-resort capture for anything the
runner itself could not handle (node missing, a syntax error).

---

## 6. Verify the round trip end to end

The queued cap **`p1782730181929`** already carries an unapplied publish
intent. Leave that intent in place and let the schedule pick it up.

```sh
# 1. Confirm the intent is still queued. The dry run writes nothing and makes
#    no Shopify call (it never mints a token) — but it DOES read
#    /shopify_publish and /shopify_sync, so §3b's Firebase credentials must
#    already be in place for it to work.
ssh marathonclub@100.64.186.78 'cd ~/marathon-store-app && node scripts/shopify/reconcile.mjs --pids p1782730181929'
#    expect a table row: CREATE+PUBLISH or PUBLISH

# 2. Wait one tick (≤ 2 minutes), then read the log
ssh marathonclub@100.64.186.78 'tail -40 ~/marathon-store-app/logs/shopify-reconcile.log'
#    expect: ▶ p1782730181929 → ON … LIVE on the Online Store — "<name>" + an admin URL
```

Then in the app: the row moves out of *"waiting for the reconciler"* to
**live + on**, and the product's page shows its went-live date and Shopify
admin link. (The page refetches pending rows on window focus, so switching back
to the tab is enough — no reload needed.) Finally, open the storefront URL and
confirm the product is publicly visible.

---

## 7. Operating notes

**Stop the schedule** (e.g. before maintenance):

```sh
launchctl unload ~/Library/LaunchAgents/com.marathon.shopifyreconcile.plist
```

Intent written while it is stopped simply waits — nothing is lost, and the
first tick after `launchctl load` applies it.

**Run one tick by hand** (safe at any time — the lock prevents overlap with a
scheduled run):

```sh
cd ~/marathon-store-app && node scripts/shopify/reconcile-runner.mjs
```

**Cost of an idle tick.** This paragraph used to say the read "is small today
… but grows with the catalogue. If it ever matters, the fix is an indexed query
rather than a longer interval — worth revisiting past a few thousand reviewed
products, not before." It got there: **3,832 nodes, ~2.2 MB, read TWICE per
tick**, measured on 3 Sep 2026 at 45–79% of all traffic in the database
(`docs/SHOPIFY-SYNC.md` §9; the raw capture is `docs/bandwidth-capture-sept.md`,
which lands with PR #550). The indexed query it predicted is now
built — see `docs/SHOPIFY-SYNC.md` §9.

`reconcile.mjs` still exits *before* minting a Shopify token when there is no
unapplied intent, so an idle tick is a node boot plus:

- **~8 bytes**, once `".indexOn": ["state", "updatedAt"]` is on
  `/shopify_publish` in the console rules (§9.1 of that doc);
- **~2.2 MB** until then — RTDB *refuses* an unindexed query rather than
  sorting it, so the tick falls back to the old whole-node read and logs a line
  saying so on every tick. That line is the reminder; it goes away when the
  index is pasted, with no code change.

The expensive drift-repair passes (full scan, search-index sweep) run every
30 minutes, and every 3 hours between 23:00 and 07:00 SAST. The **tick** stays
at two minutes: a publish pressed at 23:40 still goes out at 23:42.

**A trap worth knowing about, found 3 Sep 2026.** The plist committed in this
repo named `/usr/local/bin/node` — the Intel Homebrew location. The mini is
Apple silicon and has node at `/opt/homebrew/bin/node`; nothing is at the Intel
path. The agent ran anyway only because the *installed* copy in
`~/Library/LaunchAgents` had been corrected by hand at some point, after which
the two copies drifted and the repo's version was never right. The repo copy is
corrected now. **launchd has no PATH of its own**, so a wrong absolute path in
`ProgramArguments` does not error — the job loads, appears in `launchctl list`,
and simply never runs. Check `which node` on the target before installing this
anywhere else.

**Updating the code on the mini:**

```sh
ssh marathonclub@100.64.186.78 'cd ~/marathon-store-app && git pull && npm ci --prefix functions'
```

No launchd reload is needed — each tick spawns a fresh node process, so the
next tick picks the new code up. **There is no auto-pull**: on 3 Sep 2026 the
mini was found sitting on `main` at #540 while `main` was at #549, nine merged
PRs behind. If a fix is not visible on the mini, this command is why.
