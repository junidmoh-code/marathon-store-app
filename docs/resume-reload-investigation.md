# Leaving the app and coming back: why it reloaded (27 Nov 2026)

Junid's report: leave the app (switch app, lock the phone, change tab), come
back, and Source shows a loading state and downloads everything again. Most
other cards do the same. Every re-download is database egress, which is most of
the Firebase bill (target $2/day).

Written before any code changed. Figures marked **measured** come from single,
bounded REST reads made on 27 Nov 2026 (a single child or a `shallow=true`
listing, never a whole big node). Figures marked **profiler** come from earlier
captures already recorded in the code (`src/utils/sharedLiveRead.js`, `docs/firebase-cost-sept19.md`,
the 26 Nov `useHubOrders` note in `src/App.jsx`).

## 1. What happens on return: the three causes, separated

### (a) The browser threw the page away (`document.wasDiscarded`)

iOS Safari (and installed PWAs) and Android Chrome discard backgrounded pages
under memory pressure. This app holds several MB of parsed data in memory, so
it gets discarded often. When the page comes back it is a **cold start**:

1. `AuthGate` renders **"Loading…"** until Firebase auth restores *and* the
   `/users/{uid}` permission record has answered over a fresh socket
   (`src/components/AuthGate.jsx`, `if (!authReady)` and `if (!permLoaded)`). On a shop
   line that is 1–3 s of black screen. **This is the "loading state" Junid sees.**
2. The last card is restored from `localStorage.marathon_role`, so Source mounts
   again. Its mirrored reads answer from IndexedDB (no egress). Its non-mirrored
   reads download again in full.

Nothing in the app can stop a discard. What the app can do is (i) not cause
reloads of its own, (ii) paint from saved copies instead of a "Loading…" screen,
and (iii) never re-download what the device already holds.

### (b) The app reloaded itself: the main cause

`src/update/updateChecker.js` polls `/version.json`. **main had 9–17 deploys a day this
week** (`git log --first-parent`: 20 Nov 9, 21 Nov 7, 22 Nov 4, 23 Nov 12,
24 Nov 17, 25 Nov 6, 26 Nov 17). After each one:

* **Mirrored devices (the whole fleet since #624) were in "forced" mode.** The
  checker reloaded the page **30 seconds after it first saw the new build**,
  whatever the person was doing, as long as nothing was registered busy. Source,
  Health, Missing Products and most cards register nothing as busy. The check runs
  every 5 minutes *and on every `focus` / `visibilitychange→visible`*. So coming
  back to the app after a deploy found the new build, and the device reloaded
  30 s later, in the person's hands.
* **Non-mirrored devices** reloaded **the moment the tab went hidden** (the
  `visibilitychange→hidden` branch: "invisible moment to swap builds"), once per
  version. The person comes back to a cold start, and so to cause (a)'s
  "Loading…" plus a full re-download.

Everything else on the (b) list was checked and is **not** a cause:

| Suspect | Finding |
|---|---|
| Service worker update + reload | No caching SW is registered. `main.jsx` unregisters every SW except the push worker, which has no fetch handler. `PWAUpdateBanner` only reacts to a `pwa-update-available` event nothing fires. |
| Auth listener re-firing and resetting state | `onAuthStateChanged` only fires on a **uid change** (firebase v10 `lastNotifiedUid`). `AuthGate`'s `[user]` effect, `useAuthReady`, `identityChange.js` (uid-compared) and `MirrorGate` therefore do nothing on return. A token refresh fires `onIdTokenChanged`, which sets claims without passing through `undefined`, so there is no loading flash. |
| Mirror "Download" gate re-arming | Gone since 21 Sep (owner decision). The gate renders children always. |
| Route/key remounts | The only keyed wrapper is `<AppErrorBoundary key={role}>`, which changes only when the card changes. `ActiveStoreLayer.checkDayRollover` on visible switches shop only across SA midnight, by design. |
| `deepLink.js` reload | Only when a push notification is tapped, which is an explicit tap. Kept. |

### (c) Listeners torn down and re-attached

* `src/utils/sharedLiveRead.js` holds one listener per path, shared and kept for
  10 min (big nodes) or 25 s after the last screen leaves. **But it dropped every
  idle (lingering) listener the instant the page was hidden** (`releaseIdle` on
  `visibilitychange→hidden`) and on every connection drop (`connectionLost`;
  iOS drops the socket as soon as the app is backgrounded). So: open Source, go
  Home, switch to WhatsApp for 20 seconds, come back, open Source again, and
  every non-mirrored path Source reads downloads again in full.
* Listeners still **in use** by the visible card were kept. The SDK re-syncs them
  on reconnect, sending only what changed. So the card you were on did not
  re-download on a plain hide/show **unless (b) reloaded the page**.
* `src/offline/idleSuspend.js` (fully mirrored devices, hidden ≥ 15 min) calls `goOffline`. On
  return, `goOnline` re-sends the open listens, the server answers with
  compound-hash diffs, and the mirror catches up from its stored cursor. This is
  changes-only and it stays.
* Raw `onValue` in a component effect (no sharing) re-downloads on every
  remount. The remaining ones are listed per card below.

## 2. Every top-level card

M = offline mirror (IndexedDB, change feed, zero egress on mount). S = shared
held live listener. R = raw `onValue`/`get` torn down on unmount.
"Return cost" is the egress for **one return to that card**, mirrored device,
**before** this work, when (b) has reloaded the page. After a deploy that was
*every* return.

| Card | (a) | (b) | (c) | Non-mirrored reads on load (bytes) | Mirrored already |
|---|---|---|---|---|---|
| App shell (always mounted) | yes | yes | – | `users/{uid}` ~1 KB, `network` 4 B **measured**, `push_mutes/{uid}`, `config/cardTerminals`, `mirror_switch` 127 B **measured**, mirror catch-up (changes since cursor) | products, orders, returns_log |
| **Source** | yes | yes | yes (idle drop) | `refill_engine/open` **390,292 B measured**, `config/refillEngine` **6,911 B measured**, `stock_targets/{dest}/{pid}` gets (small), `settings/stockHold/config` 149 B **measured** → **≈ 0.40 MB** | refill_requests, restock_log ×6, restock_requests, insights_log range, stock/{dest}, locations |
| Health | yes | yes | yes | `stock_exceptions/latest` **571,648 B measured**, `refill_engine/shadow`, `/runs` (whole), `/retryState`, `stock_targets` whole, `transfers`, `receiving_session` → **≥ 0.6 MB** | refill_requests, stock |
| Missing Products | yes | yes | yes | `stock_targets` whole, `refill_engine/seats/*`, `settings/concreteOnlyIndex`, `settings/marathonOnlyIndex`, `config/refillEngine` → **≥ 0.1 MB** | stock, refill_requests, hidden, stockHold/held |
| Warehouse | yes | yes | yes | `laybyPulls` **287,615 B measured**, `laybys` | orders (hub query) |
| TV (in-app DISPLAY) | yes | no (TV rule) | yes | `laybyPulls` 288 KB, `specials` 4 B **measured** (R), `settings/tv*` (R) | orders |
| Hub Count | yes | yes | R | raw `get` of whole `orders` (~4.4 MB **profiler**), `stock/{hub}`, `laybyPulls`. **These bypass the mirror on purpose: the count acts on them.** | – |
| Home | yes | yes | – | `config/cardTerminals`, displayChecks leaves, Shopify shallow count (cached), StockHoldCard `get` | restock_log/today, refill_requests |
| Insights | yes | yes | – | rollup days (bounded, `rollupStore` cached) | orders (**unscoped**), products, returns_log, insights_log |
| Customers | yes | yes | – | rollup all-time (cached), `broadcasts` 4 B (R) | customers |
| Admin | yes | yes | – | `shopify_publish` live query, `config/styleCode` (R) | locations, taxonomy |
| AI Studio | yes | yes | R | `aiAssistant/nameProposals`, `aiAssistant/photoProposals` (R, whole; photo list opened twice) | – |
| Assistant | yes | yes | – | `config/assistantView` (R, small) | stock/{hub}, displaySlots, customers |
| Super-admin cards (Users, Online Orders, Mirror Fleet, Cost Watch, Push) | yes | yes | R | `users` whole (R), `online_escalations` whole (R), `mirror_devices` (get) | – |

A device **not** serving from the mirror (switch off, setup unfinished, or a
leg fallen back) pays the mirrored columns too. For Source that is
refill_requests ~15.6 MB (**profiler**, 10–11 Nov) + products 4.7 MB + orders
2.6–4.4 MB + restock_requests 1.4 MB + restock_log 6 days ≈ 0.8 MB (today
135,023 B, yesterday 171,234 B **measured**) + stock/{dest} up to 1.6 MB +
insights range, **≈ 27–30 MB per return**.

## 3. Ranked: card, cause, bytes per return, fix

Ranked by egress per return × how often the return happens.

| # | Card | Cause | Bytes per return before | Fix |
|---|---|---|---|---|
| 1 | **Every card** | (b) forced reload 30 s after a deploy (mirrored) / reload on hide (live) | card's non-mirrored reads + shell + mirror catch-up. Source ≈ 0.40 MB mirrored, ≈ 27–30 MB live. Plus the "Loading…" screen | Commit 1: no self-reload while trading. New build on cold start, on a tap, or 03:00–05:00 when idle |
| 2 | **Source** | (c) idle listeners dropped on hide / socket drop; (a) "Loading…" on cold start | 0.40 MB on re-entry after any hide | Commits 2–3: hold idle listeners through a hide grace; paint the permission record from a saved copy; "Updating" marker while the copy catches up |
| 3 | Health | (c), (a) | ≥ 0.6 MB | Commit 2 hold (generic). `HealthView.jsx` itself is a guarded file, so no per-card edit |
| 4 | Warehouse / TV | (c) | 288 KB `laybyPulls` | Commit 2 hold (already S) |
| 5 | AI Studio | R remount | whole proposals nodes each mount | Move to the shared held read |
| 6 | Super-admin Users / Online Orders | R remount | `users` whole, `online_escalations` whole | Move to the shared held read |
| 7 | TV `specials`, Customers `broadcasts` | R remount | 4 B each (empty today) | Move to the shared held read (consistency, near-zero bytes) |
| – | Missing Products, Refill Queue, Health, Stock Hold Release, Transfer | (c) | as above | **No per-card edit.** These files are on the `junid-approved` guard list (refill engine / Refill Queue / policy), and this task has no approval for them. They get the generic fixes (1, 2, saved permission record, marker) without being edited |
| – | Hub Count | R by design | ~4.4 MB per open | **Skipped.** The count acts on orders and stock, so its reads must be live. Serving them from a saved copy would show stale stock as live |

## 4. What "safe" means here

* Mirrored data is current as of the mirror's last feed read. When that read is
  older than the safe limit (2 min) or has not happened yet since a cold start,
  the app shows a small **"Updating…"** marker until the catch-up pass lands. A
  catch-up pass is now run on every return.
* A saved copy (the permission record) is shown only for the **same uid**, and
  only until the live answer arrives. It is never treated as "settled" by
  anything that acts.
* Every action that moves stock or changes a request (fulfil, send, solve,
  out-of-stock) already re-reads live inside a `get`/`runTransaction` before it
  writes (`RefillQueue.jsx` `get(stockCellPath…)`, `runTransaction(refill_requests/…)`).
  None of that is changed.

## 5. Rules

No rule or `.indexOn` change is needed.
