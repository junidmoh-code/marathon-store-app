# RTDB rules hardening — marathon-club (security PR)

Standalone security PR. Replaces the root-cascade RTDB rules with explicit
per-path grants, locks the anonymous TV session down to a narrow surface, and
adds a non-anonymous requirement to every write. **Rules deploy in their own
manually-triggered window — NOT on merge.** Deploy is always
`firebase deploy --only database` (never a bare `firebase deploy`).

Database: `marathon-club-default-rtdb.europe-west1.firebasedatabase.app`
(shared by marathon-store-app, marathon-pos-app, marathon-ai).

---

## 0. The headline finding — committed rules ≠ deployed rules (rollback hazard)

The repo's old `database.rules.json` is **not** what is actually live. I captured
the **real deployed rules** read-only from the RTDB REST `.settings/rules`
endpoint on **2026-06-12** and committed them verbatim as **`rules-rollback.json`**.
That capture — not the old committed file — is the authoritative rollback.

The live rules are:

```json
{
  "rules": {
    ".read": "auth !== null",
    ".write": "auth !== null",
    "users": { "$uid": { "posAccess": {
      ".write": "auth.token.email === 'gunidmoh@gmail.com'",
      "pin": { ".read": "auth.token.email === 'gunidmoh@gmail.com'" } } } },
    "pos": { "pinAttempts": { ".read": false, ".write": false } }
  }
}
```

Two consequences, both important:

1. **Live has a root `.write: "auth !== null"`** that the old committed file did
   **not**. That root write-cascade is why `pos_meta`, `customers_meta`,
   `inventory_meta`, and `marketing` writes work in production despite having no
   write rule in the committed file. **Rolling back to the old committed file
   would BREAK those writes.** Rollback must use `rules-rollback.json` (the live
   capture). This resolves the prior B1 blocker.
2. **The live `.read`/`.write: "auth !== null"` is the vulnerability Firebase
   emails about.** Anonymous sign-in is enabled (the TV uses it), so today *any*
   visitor who hits `#tv` gets an anonymous token that can read/write the entire
   database. The live `pos/pinAttempts: {.read:false}` and
   `users/$uid/posAccess/pin: {.read: super-admin}` protections are **silently
   void** — an ancestor `.read:true` cannot be revoked by a descendant in RTDB,
   so PINs and PIN-attempt data are readable by everyone right now.

---

## 1. Cross-app read/write path inventory

Removing the root cascade means **every client-SDK read path must be granted
explicitly** or that app breaks the moment the rules swap. Admin-SDK access
bypasses rules (cannot break) but is listed for the record. Verified by grepping
each repo's working tree on 2026-06-12.

> Repo states grepped: store-app `security/rtdb-rules-hardening`@origin/main
> (ae9cb4d); pos-app detached @#58 (166abfd); marathon-ai
> `feat/distribute-gender-sections` (04278cd); broadcast-service `main` (da03c58).
> pos-app/marathon-ai were on feature branches, not `main` — re-grep `main` at
> go-live if either has merged RTDB changes since.

### 1.1 marathon-store-app — client SDK (PIN/synthetic-email + Google super-admin; TV = anonymous)

| Top-level path | Read | Write | SDK | Representative site | Anonymous TV? |
|---|---|---|---|---|---|
| `orders` | ✓ | ✓ | client | `App.jsx` useOrders / updateOrder (516) | **READ yes; WRITE yes (auto-collect → `collected`)** |
| `products` | ✓ | ✓ | client | App.jsx | no |
| `products_meta` | ✓ | ✓ | client | App.jsx (txn) | no |
| `insights_log` | ✓ | ✓ | client | App.jsx | no |
| `insights` (`insights/reorderPlan/*`) | ✓ | — | client | App.jsx | no |
| `restock_log` | ✓ | ✓ | client | logRestock push (744) | **WRITE yes (append on auto-collect)** |
| `restock_requests` | ✓ | ✓ | client | App.jsx | no |
| `returns_log` | ✓ | ✓ | client | App.jsx | no |
| `customers` | ✓ | ✓ | client | App.jsx | no |
| `broadcasts` | ✓ | ✓ | client | App.jsx | no |
| `broadcastHistory` | ✓ | ✓ | client | App.jsx | no |
| `orderCounter` | ✓ | ✓ | client | App.jsx (txn) | no |
| `source_onhold_responses` | ✓ | ✓ | client | App.jsx | no |
| `users` / `users/{uid}` | ✓ | super-admin only | client | UserManagement, AuthGate.jsx:98 | no (AuthGate guards anon at :92) |
| **Cloud Functions (admin SDK — bypass rules)** | | | admin | functions/index.js | n/a |
| `aiAssistant`, `users`, `orders`, `insights_log`, `insights`, `returns_log`, `products` | r/w | r/w | admin | functions | n/a |

**TV display route**: `AuthGate` mounts `TvOnlyShell` on `#tv`, which signs in
anonymously and reads `orders` via `useOrders()`. Its `TvWithAutoCollect` timer
**writes**: flips an existing order's `status → collected` (`updateOrder`,
`orders/{id}`) and appends a `restock_log` entry (`logRestock`). Those are the
**only** two paths the anonymous session touches. `AuthGate`'s `users/{uid}` read
is already guarded (`if (!user || user.isAnonymous) return`, AuthGate.jsx:92), so
scoping `/users` away from anonymous does not break it.

### 1.2 marathon-pos-app — client SDK (PIN/synthetic-email)

| Top-level path | Read | Write | SDK | Notes |
|---|---|---|---|---|
| `customers` | ✓ | ✓ | client | + `customers/{id}/storeCredit`, `/laybyHoldings` |
| `customers_meta` | ✓ | ✓ | client | `lastCode` counter (txn) |
| `inventory` | ✓ | ✓ | client | sales decrement `inventory/{store}/{pid}/{size}` |
| `inventory_meta` | ✓ | — | client | low-stock thresholds |
| `pos` | ✓ | ✓ | client | sales / storeCredits / audit / config |
| `pos_meta` | — | ✓ | client | receipt-number counters (txn) |
| `products` | ✓ | — | client | whole-node read |
| `users` / `users/{uid}` | ✓ | — | client | list + own record |
| `pos/pinAttempts` | r/w | r/w | **admin** | functions/posUsers.js — lockout state, no client access |
| `users/{uid}/posAccess` | r/w | r/w | **admin** | functions/posUsers.js |
| `pos/audit` | — | ✓ | admin | functions/posUsers.js push |
| `alerts` (`alerts/sent`, `alerts/lowStock`) | r/w | r/w | **admin** | functions/lowStockAlerts.js — no client access |

> pos-app uses **no Firestore** — RTDB only.

### 1.3 marathon-ai — **client SDK** (frontend-only Vite/React, Google sign-in; no functions, no admin SDK)

All reads are client-SDK → **will break** if not granted.

| Top-level path | Read | Write | Notes |
|---|---|---|---|
| `insights` (`insights/reorderPlan/{status,latest}`) | ✓ | — | live `onValue`; a denied read hangs the dashboard |
| `products` | ✓ | — | `onValue` + one-time `get` |
| `insights_log` | ✓ | — | demand/slow-mover analysis |
| `returns_log` | ✓ | — | |
| `marketing` (`marketing/campaigns/*`) | ✓ | ✓ | only write in the app |

### 1.4 marathon-broadcast-service — **no RTDB**

Uses `@google-cloud/firestore` only (collection `whatsapp_outbox`). No
`firebase/database`, no `databaseURL`, zero RTDB signals. **Unaffected** by this
change. (Control row in the smoke test.)

### 1.5 Consolidated grant matrix (what the new rules implement)

- **Anonymous (TV):** read `orders`; write `orders/{id}` only when result
  `status === 'collected'` and the order already exists; append-only to
  `restock_log`. Denied everywhere else.
- **Staff (non-anonymous):** read + write on every legacy path above; read-only
  on `insights`; `users` write stays super-admin-only.
- **New stock paths** (`locations, stock, stock_movements, transfers,
  refill_requests, sales, stock_alerts, reports, config`): staff read; per-role
  writes gated on `users/{uid}/stockRole`; inert until staff are granted a role.

### 1.6 Paths with no client owner found (would be denied — by design)

Every **client** read/write path above maps to an explicit grant. The only paths
with **no** explicit grant are admin-SDK-only (`aiAssistant`, `alerts`,
`pos/pinAttempts`, `users/{uid}/posAccess`, `pos/audit`) — admin bypasses rules,
so denying client access to them is correct, not a breakage. **No orphan
client-read path was found that I could not attribute to an owning app.**

---

## 2. Anonymous hardening (per the brief)

- The anonymous TV gets exactly: `orders` read, the narrow `orders/{id}` collect
  write, and append-only `restock_log`. This was an explicit product decision
  ("scope it") to keep the TV auto-collect feature working while closing the
  hole — the alternative (block all anon writes) would have stopped auto-collect
  until it moved to a scheduled Cloud Function.
- **Every other `.write` in the file** carries
  `auth.token.firebase.sign_in_provider != 'anonymous'`. (`users` write is gated
  on the super-admin email, which is inherently non-anonymous.) Verified
  mechanically: 27/28 writes contain the guard; the 1 exception is `users`
  (email gate).

---

## 3. Diff summary vs the live rules (`rules-rollback.json` → `database.rules.json`)

| Change | Live (rollback) | New |
|---|---|---|
| Root `.read` | `auth !== null` (everyone incl. anon) | **removed** — explicit per-path |
| Root `.write` | `auth !== null` (everyone incl. anon) | **removed** — explicit per-path |
| Anonymous reach | entire DB r/w | `orders` read + scoped collect-write + `restock_log` append |
| Non-anon write guard | none | on every write except super-admin `users` |
| `pos/pinAttempts`, `users/.../pin` protections | present but **void** (root override) | root override gone (see residuals re: staff scope) |
| Legacy staff paths | inherited root | 18 explicit read+write grants |
| New inventory paths | none | 9 per-role nodes (inert pre-rollout) |

---

## 4. Residual findings (documented, not silently changed)

- **H1 — staff can read PINs.** `users/.read` is staff-wide, so any non-anon
  staff token can read `users/$uid/posAccess/pin`. This is a **net improvement**
  over live (where *everyone incl. anonymous* can read it), but not a full fix.
  A true fix needs per-child `users` reads (so the parent read doesn't return
  the `pin` subtree) plus app changes in store-app/pos-app that currently read
  whole user nodes. Out of scope for this pass.
- **H2 — staff can read `pos/pinAttempts`** for the same reason (`pos/.read` is
  staff-wide). Low sensitivity (lockout counters, not PINs).
- I deliberately did **not** re-add child `.read:false` rules under `pos`/`users`
  — under the new per-path grants an ancestor staff `.read` still overrides them,
  so they would be **false security** (the exact bug live had).

---

## 5. Deploy & rollback plan

**Deploy is manual, in a window you trigger** (early morning, tills + TV idle).
Never bundled with feature code; never a bare `firebase deploy`.

Pre-flight (do this in the window, immediately before swap):
1. **Re-capture live rules** and diff against the committed `rules-rollback.json`
   to confirm nothing changed since 2026-06-12:
   ```
   TOKEN=$(gcloud auth print-access-token)
   curl -s "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app/.settings/rules.json?access_token=$TOKEN"
   ```
   If it differs, update `rules-rollback.json` first.

Deploy (one command):
```
firebase deploy --only database
```

Rollback (one command, if any smoke check 1–6 fails):
```
firebase deploy --only database   # after copying rules-rollback.json over database.rules.json
```
i.e. restore `rules-rollback.json` → `database.rules.json`, redeploy, investigate,
reschedule.

---

## 6. Post-swap smoke test (run immediately after the swap)

| # | App / context | Check | Pass = |
|---|---|---|---|
| 1 | store-app (staff login) | role selector loads; open Insights, Source, Customers | reads succeed, no permission error |
| 2 | store-app **TV** `#tv` (anon) | open the TV display | orders render |
| 3 | store-app **TV auto-collect** (anon write) | leave a READY order > 8 min on the TV | it flips to `collected`; a `restock_log` entry appears |
| 4 | store-app **TV negative** (anon) | from the anon TV session attempt to read `customers` / `users` | **DENIED** |
| 5 | pos-app (PIN login) | open till; load products + inventory; ring a test sale to a sandbox product | sale completes; `inventory` decrements |
| 6 | pos-app | layby/refund counter (`pos_meta`) increments | no permission error |
| 7 | marathon-ai (Google login) | dashboard loads reorder plan; SlowMovers reads `insights_log`/`returns_log` | data renders |
| 8 | broadcast-service | (control) confirm still sending | unaffected (admin Firestore) |
| 9 | stock per-role (optional) | as a `stockRole` user write a `stock_movements` entry; as a non-stockRole user attempt the same | first allowed, second denied |

If any of **1–7** fails → immediate rollback, investigate, reschedule.

---

## 7. Sequencing

This rules PR is independent of the inventory feature PR. Recommended order:
(1) feature PR merges (inert — writes gated by `stockRole` nobody holds),
(2) this rules PR merges (no deploy), (3) rules deploy in window with smoke test,
(4) grant `stockRole` to pilot staff, (5) begin rollout.
