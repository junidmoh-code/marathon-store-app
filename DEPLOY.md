# Deploying Marathon Store

**The whole thing is one command.** Everything below it is explanation you only
need if something goes wrong.

Open the **Terminal** app (Spotlight → type "Terminal"), paste this, press enter:

```bash
cd ~/Documents/marathon-store-app && git pull origin main && npm install && npm run build && firebase deploy --only hosting
```

The first time, add `firebase login` before the deploy step — a browser window
opens, sign in as the Google account that owns the **marathon-club** project, click
Allow, come back to Terminal:

```bash
cd ~/Documents/marathon-store-app && git pull origin main && npm install && npm run build && firebase login && firebase deploy --only hosting
```

It takes about a minute and ends with:

```
Hosting URL: https://marathon-club.web.app
```

That's it. Open the URL on your phone and pull down to refresh. If it still looks
old, close the tab completely and reopen — the app caches itself.

---

## ⛔ Three things never to run

These are not style preferences. Each one has destroyed or can destroy live data.

### 1. Never run bare `firebase deploy`

It deploys hosting **and functions and database rules** in one go. The functions
part is the dangerous half — see below. Always scope it:

```bash
firebase deploy --only hosting
```

### 2. Never run `firebase deploy --only functions`

**marathon-pos-app is a separate repo that deploys into the SAME Firebase
project.** The CLI treats "in the project but not in my local source" as *deleted*,
so a bare functions deploy from this repo offers to delete the POS app's
functions — `issueStoreCredit` (mints store credit — money), `verifyManagerPin`
(manager auth on the till), and others. It asks first, but one reflexive `y`
destroys them, and they cannot be restored from this repo.

Always name the function:

```bash
firebase deploy --only functions:refillHealthScan
```

Full detail and the current known-scoped-commands table: **`DEPLOY-TRACKER.md`**.
That file is binding; this one defers to it.

### 3. Never deploy database rules casually

`database.rules.json` is 563 lines of per-role, per-shop access control built up
over many iterations (see `RTDB-RULES-HARDENING.md` and the `rules-live-backup-*`
files). It is **not** the open `{".read": true, ".write": true}` starter this doc
used to describe. Pushing rules is a deliberate act with a backup taken first, not
part of a routine deploy — which is exactly why the command above says
`--only hosting`.

---

## If something goes wrong

**`firebase: command not found`**
```bash
sudo npm install -g firebase-tools
```
Then paste the deploy line again.

**`cd: no such file or directory`**
The project folder is somewhere else. Find it:
```bash
ls ~/Documents
```
and use whatever the folder is actually called.

**"Failed to authenticate" / "Failed to get Firebase project"**
Wrong Google account, or the login expired. Run:
```bash
firebase logout && firebase login
```
and sign in as the account that owns **marathon-club**. Confirm with
`firebase projects:list` — you should see `marathon-club` in the list.

**The build stops with a red error**
Nothing has been deployed at that point — the live site is untouched. Copy the
error message and hand it to Claude.

**Deploy succeeded but the phone shows the old screen**
Close the tab entirely and reopen it. The app is a PWA and holds its own cache;
a pull-to-refresh alone sometimes isn't enough.

---

## What the command actually did

| Step | What it means |
|---|---|
| `cd ~/Documents/marathon-store-app` | move into the project folder |
| `git pull origin main` | download the latest merged code |
| `npm install` | fetch any new libraries that code needs |
| `npm run build` | compile React into plain files in `dist/` |
| `firebase deploy --only hosting` | upload `dist/` to Firebase's CDN |

`npm warn` lines during install are normal and can be ignored. Only `npm error`
matters.

---

## Where things live

- **Project:** `marathon-club` (pinned in `.firebaserc`)
- **Hosting site:** `marathon-club` → https://marathon-club.web.app
  (`firebase.json` declares this one target; verify the target list before any
  hosting deploy rather than assuming it from this note)
- **Firebase config:** `src/firebase.js`
- **Database rules:** `database.rules.json`
- **Cloud Functions:** `functions/` — shared with marathon-pos-app, see the
  warning above
