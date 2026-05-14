# Deploying Marathon Store to Firebase Hosting

Everything in this folder is ready. You'll run a handful of commands in Terminal on your Mac. Each step shows what to expect.

The whole sequence takes about 5 minutes the first time (most of it is `npm install`), under a minute on subsequent deploys.

---

## 0. Open Terminal in this folder

Open the **Terminal** app (Spotlight → "Terminal"), then:

```bash
cd ~/Documents/marathon-store-app
```

You can confirm you're in the right place with `ls` — you should see `package.json`, `firebase.json`, `src/`, etc.

---

## 1. Verify Node.js is installed

```bash
node --version
```

If you see something like `v18.x` or higher, you're set — skip to step 2.

If you see "command not found", install Node first. The simplest path:

```bash
# Install Homebrew if you don't have it (one-time, takes ~3 min):
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Then install Node:
brew install node
```

Re-run `node --version` to confirm.

---

## 2. Install project dependencies

```bash
npm install
```

This downloads React, Firebase, and Vite. Expect 30–60 seconds and a long wall of output. A few `npm warn` lines about deprecated transitive packages are normal — only `npm error` matters.

When it finishes you should see something like `added 200+ packages in 30s`.

---

## 3. Build the app

```bash
npm run build
```

Vite compiles your React code into static files in `dist/`. Expect 5–10 seconds. Output ends with a table of bundle sizes — that's good.

If you get a syntax error here, copy the error message back to me and I'll fix it.

---

## 4. Install the Firebase CLI (if you don't have it)

```bash
firebase --version
```

If you see a version number, skip to step 5.

If "command not found":

```bash
npm install -g firebase-tools
```

(If that fails with a permissions error, prefix it with `sudo`.)

Re-run `firebase --version` to confirm.

---

## 5. Log into Firebase

```bash
firebase login
```

This opens your browser. Sign in with the Google account that owns the **marathon-store** project (probably junidmoh@gmail.com — double-check it's the same account you used in the Firebase Console). Click "Allow", then come back to Terminal — you should see "Success! Logged in as ...".

If you get logged in to the wrong account, run `firebase logout` and try again.

---

## 6. Confirm the project link

```bash
firebase projects:list
```

You should see `marathon-store` in the list. The `.firebaserc` in this folder already points to it, so no `firebase use` needed.

> **If you don't see `marathon-store`** in the list, the project ID is different from what we assumed. Check the Firebase Console URL: it'll say `console.firebase.google.com/project/<the-real-id>`. Then edit `.firebaserc` in this folder and replace `marathon-store` with the real ID.

---

## 7. Deploy database rules + hosting

```bash
firebase deploy
```

This uploads two things:

1. **Realtime Database rules** from `database.rules.json` — currently set to public read/write so the app works out of the box. (See the security note at the bottom.)
2. **Hosting** — uploads everything in `dist/` to Firebase's CDN.

Expect 30–60 seconds. The last line will say:

```
Hosting URL: https://marathon-store.web.app
```

That's your live URL. Open it in any browser, on any device — orders, products, and status changes sync live across all of them.

You'll also have a second URL: `https://marathon-store.firebaseapp.com` (same site, alternate domain).

---

## Subsequent deploys

After the first time, redeploying is just:

```bash
npm run build
firebase deploy --only hosting
```

(Use `--only hosting` if you don't want to re-upload the database rules every time.)

---

## What's wired up

- **`src/firebase.js`** — your Firebase config (apiKey, databaseURL, etc.)
- **`src/App.jsx`** — same store-queue UI, with two changes:
  - `useFirebaseState` hook replaces the local `useState` for `products` and `orders`. Any device's change is mirrored to Realtime Database under `/products/items` and `/orders/items` and pushed to every other connected device.
  - Order numbers (#001 → #999) now come from a Firebase **transaction** at `/orderCounter`, so two assistants placing orders simultaneously get unique numbers instead of colliding.

---

## Security note (read this!)

The current `database.rules.json` allows anyone with your `databaseURL` to read or write all data:

```json
{ "rules": { ".read": true, ".write": true } }
```

This is fine for an internal store-staff prototype but **not** for production with sensitive data. To lock it down later, options include:

1. **Anonymous auth + role check** — sign every device in anonymously and gate writes behind a custom claim.
2. **Email/password** — register accounts for staff and require auth.
3. **IP allowlist via Cloud Functions** — wrap writes in an HTTPS function that checks origin.

Happy to wire any of those up when you're ready — they each take 10–20 minutes.

---

## Troubleshooting

**"Permission denied" when the app tries to read/write:** Your database rules didn't deploy or were overridden. Re-run `firebase deploy --only database`, or paste the contents of `database.rules.json` directly into the Realtime Database → Rules tab in the Firebase Console.

**App loads but no orders sync between devices:** Open the browser DevTools console — Firebase logs the actual issue. Most common: the `databaseURL` in `firebase.js` doesn't match the one in your Firebase Console (Project Settings → General → Web app config).

**`firebase deploy` says "Error: Failed to get Firebase project marathon-store":** Wrong account, or the project ID in `.firebaserc` is wrong. Run `firebase projects:list` to see what you have access to.

**Realtime Database doesn't exist:** In the Firebase Console, go to Build → Realtime Database → Create Database (choose a location, start in test mode if asked).
