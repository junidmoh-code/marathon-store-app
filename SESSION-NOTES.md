# Marathon Club — Session Notes

**Date:** 2026-05-09
**Live URL:** https://marathon-club.web.app
**Project root:** `~/Documents/marathon-store-app`
**Build / deploy:** `npm run build && firebase deploy --only hosting`
**No git repo** — the project isn't initialised under version control. Consider running `git init` and committing baseline next session.

---

## ✅ Done this session (across multiple turns)

### Visual / design
- **Full premium dark redesign** to match `~/Downloads/marathon-v3-FINAL.html` mock-up. All views are mobile-first 430px frame, black background, blue accent `#4A7FFF`.
- **4 hero images extracted** from the HTML mock and served from `public/hero/`:
  - `marathon.jpg` – home circuit hero
  - `warehouse.jpg` – Warehouse Queue cube banner
  - `place-order.jpg` – Place Order bags banner
  - `admin.jpg` – Admin Panel circuit banner
- **RoleSelector** rewritten — 3 grouped sections (Operations / Insights & Display / Administration) with circuit-grid SVG section icons, role cards with blue badge counts.
- **WarehouseView** — new top bar (50px padding-top, blue Switch View, incoming pill), warehouse hero, Hub 1/2 row, "Update order status in real time." subtitle, glass ON HOLD card with collapsible details, glass tab pills, status-tinted order cards (incoming = blue tint, ready = green, OOS = red) with vertical color bars and action button trio.
- **AssistantView** — new top bar, Place Order hero, blue-bordered search bar, 2-column product grid with selection-state glow.
- **AdminView** — top bar + Admin Panel hero, `Products` count + `+ Add Product` button, search/filter row, timeline-dot product list, **Edit Sizes / Delete** glass buttons. Emoji-icon picker removed — Add Product is upload-only.
- **CustomerView** — centered 3-digit input with 10px letter-spacing, blue Check Status button.
- **Source / Returns / Customers / Insights** — mobile-first frames, top bars (left ← Exit, center icon + name, right counter pill).
- **InsightsView Overview** — circuit-decorated legend card with green bag / red cube / blue arrow SVG icons, 2×2 stat cards with subtitles, Busiest Hour card with SVG wave chart and peak-dot glow.

### Logic / data
- **All emojis removed** — replaced with stroke-`#4A7FFF` SVG icons. New helper components: `ProductIcon` and `ProductPhoto`.
- **All yellow `#F59E0B`** colors replaced with `#4A7FFF` / blue. STATUS.INCOMING is now blue.
- **Returns reason field removed** (FIX 4). `submitReturn()` writes `reason: null` so existing return logs aren't broken; UI shows a single "Confirm Return" button.
- **Source view logic rewritten** (FIX 8 / 11):
  - Today's Request: orders with `status === READY || COLLECTED`, `readyAt` is today, **never OOS**.
  - History: same filter, past dates only.
  - On Hold: orders with `status === COMING_TOMORROW`, never OOS.
  - Source home badge: `Today + On Hold` combined, never OOS.
  - All 5 surfaces (Today data, History data, On Hold data, header pill, home badge) apply the OOS exclusion explicitly.
- **`orderReadyDate()` helper** added (line ~431 of `src/App.jsx`) and used everywhere Source counts orders. Strict — returns `null` if `readyAt` is missing (no fallback to `collectedAt`/`updatedAt`). This is what eliminated the previous double-counting where orders ready yesterday but collected today were showing in today's Source.
- **Sales Summary / Net Sales mismatch fixed** (FIX 13). Overview was using `e.action === "placed"` (every order), now uses `e.action === "ready"`. Both Overview and Sales Summary now derive from the same `readyLog` filter, so totals match.
- **Subtitles added** under every Insights stat explaining what it counts (`Net Sales`, `Out of Stock`, `Returns`, `Top Product`, `Refill Requested`).
- **WhatsApp `order_ready` template** call updated to send `[customerName, orderId]` instead of `[orderId]` only — ready for the new no-timer template once Junid updates the body in Meta Business Manager:
  > "Hi {{1}}, your order #{{2}} is ready to collect at Marathon Club. See you soon!"

### Insight tab redesigns
- **Size Popularity** — horizontal blue gradient bars `rgba(60,110,255,.6) → .2`, peak size has glow, no emojis.
- **Busiest Times** — vertical hourly bars (24 hours), peak hour glows blue. Below: 7 daily bars.
- **OOS Tracker** — single summary card + collapsible product list (replaces the old by-product / by-size split).

---

## ⚠️ Pending / open questions

### 🚨 The 7 ghost orders (most important)
**Symptom:** Today's `#001` → `#196` = 196 orders created, but reconciliation only sums to 189 across READY + COLLECTED + OUT_OF_STOCK + COMING_TOMORROW + INCOMING. **7 orders are unaccounted for.**

**Status:** Diagnostic UI deployed. **No fix applied yet** — waiting on Junid to run the audit and report findings.

**Where the audit lives:**
- `src/App.jsx` line ~3635 → `audit` `useMemo` inside `InsightsView`
- `src/App.jsx` line ~3850 → `AuditModal` component
- A "**Run Order Audit**" button is rendered just below the Insights date picker. If diff ≠ 0, the button shows a red "· N unaccounted" badge.
- Modal is admin-protected via the existing Insights password gate (same session-key auth).

**Modal contents:**
- Reconciliation table (status counts, sum, diff, returns, Net Sales)
- Status distribution — today + all orders (catches `undefined`, `(empty)`, legacy values)
- Order number gaps + duplicates
- Orders with NO status / UNKNOWN status / soft-delete flags
- Multi-timestamp anomalies
- Full table of every UNACCOUNTED order (the 7 ghosts)

**Hypotheses to verify with the audit output:**
1. Some orders saved with `status === undefined` / empty string / legacy value (most likely).
2. Counter incremented but order doc never wrote to Firebase → gaps in `#001`-`#196`.
3. Two orders share an order number (duplicate).
4. Orders flagged `deleted`/`removed`/`archived === true` not visible to filters.
5. Orders with both `readyAt` AND `outOfStockAt` (warehouse changed mind) — counted in neither bucket.

**Next-session fix path (once audit results are in):**
- If undefined/empty status → backfill based on whichever timestamp is set (`readyAt`/`outOfStockAt`/`comingTomorrowAt`/`collectedAt`).
- If legacy status string → add a status-normalize map.
- If duplicates → dedupe by `orderNumber`.
- If soft-deleted → decide explicitly (count or hide everywhere).
- Add the invariant check to a permanent banner in dev/admin mode.

### 🚨 Pending external action (FIX 12) — actively breaking in production
- Update WhatsApp `order_ready` template body in Meta Business Manager to:
  > "Hi {{1}}, your order #{{2}} is ready to collect at Marathon Club. See you soon!"
- Two parameters: `{{1}}` = customer name, `{{2}}` = order number. No timer / minutes.
- React side already passes both args.
- **Confirmed broken 2026-05-11** during Phase 4 testing: Meta returned `code 132000 "Number of parameters does not match... expected number of params (1)"` when called with 2 params. **Every `order_ready` send today is failing silently** — Meta rejects, our function returns HTTP 200 with `success: false`, browser doesn't surface the error, customers don't get the WhatsApp. Update the template body in Meta Business Manager ASAP and we're back in business with no further code changes needed.

### 📡 WhatsApp Broadcast — multi-phase status

**Phase 1 — Cloud Functions proxy:** ✅ Deployed 2026-05-11, smoke test green. Two Gen 2 callable functions live in **us-central1**:
- `getBroadcastGroups` → proxies `GET http://34.59.92.37/api/groups`
- `sendBroadcast` → proxies `POST http://34.59.92.37/api/broadcast`
- Admin gate: `request.auth.token.email === "gunidmoh@gmail.com"` → else `permission-denied`.
- Bearer token sourced from Secret Manager (`broadcast-service-token`), bound via `defineSecret`. Never logged or returned.
- Smoke test (no auth) returns `HTTP 403 { "status": "PERMISSION_DENIED" }` from both — gate confirmed working.

**Phase 1 E2E test — ✅ done 2026-05-11.** Signed in as `gunidmoh@gmail.com` via Google Sign-In (added in Phase 1.5 same day), grabbed the ID token, called `getBroadcastGroups` → HTTP 200 with 16 WhatsApp groups returned (7 broadcast-capable with `isAdmin: true`, ~8,500 total participants). Full chain verified: Firebase Auth → admin gate → Secret Manager token → VM fetch → transparent passthrough. `sendBroadcast` deliberately NOT exercised in test (it would actually send) — will be exercised when Phase 3 UI lands.

**Phase 2 — Storage setup:** ✅ Done 2026-05-11, both tests green.
- `storage.rules`: public-read + auth-required-write rule added for `/broadcast-media/**`. `/products/**` rule untouched (flagged with a TODO for hardening after Phase 1.5).
- `src/broadcastStorage.js`: `uploadBroadcastMedia(file) → { url, path }`. Path format: `broadcast-media/{YYYY-MM-DD}-UTC/{uuid}.{ext}`. Validates JPG/PNG/WEBP/MP4 and ≤ 16 MB before upload.
- `scripts/test-broadcast-upload.mjs`: two-part verification — (1) anonymous client SDK write denied with `storage/unauthorized`, (2) authenticated upload via gcloud OAuth lands at expected path and the public Firebase download URL returns matching bytes.
**Phase 2 storage rule tightening — ✅ done 2026-05-11 (bundled into Phase 1.5).** `/broadcast-media/**` write now requires `request.auth.token.email == "gunidmoh@gmail.com"`. Anonymous-write denial confirmed by re-running `scripts/test-broadcast-upload.mjs` post-tightening.

**Phase 1.5 — Google Sign-In:** ✅ done 2026-05-11.
- `src/firebase.js`: added `GoogleAuthProvider` + `googleProvider` export; added `functionsUS = getFunctions(app, "us-central1")` export (preempts the Phase 3 region trap — see below); exposes `window.auth` for debug parity.
- `src/App.jsx`: added `AdminSignInScreen` + `AdminIndicator` components, `ADMIN_EMAIL` constant, hash-based `#admin` trigger, `authUser`/`hash` state hooks, `handleAdminSignOut` (drops to anonymous, doesn't fully sign out). Also fixed 4 pre-existing `letterSpacing` duplicate-key warnings in DisplayView so the build is clean.
- Sign-in flow: visit `/#admin` → Google popup → email allowlist (`gunidmoh@gmail.com` only; any other account is signed out + error shown) → hash clears → indicator pill in top-right.
- Customer-facing UI: unchanged. No sign-in button anywhere visible without the `#admin` hash.
- Existing custom password gates (Internal Insights, Customers DB, password `"1551"`): untouched.

**Phase 3 (Broadcast UI) wire-up note:** when calling the broadcast Cloud Functions from the PWA, use the new `functionsUS` export, NOT the existing `functions` export (which is europe-west1 for `sendWhatsApp`). Example:
```js
import { httpsCallable } from "firebase/functions";
import { functionsUS } from "./firebase";
const getGroups = httpsCallable(functionsUS, "getBroadcastGroups");
```

### Other small items
- The PrivacyPage still uses the `'Bebas Neue'` font reference (system fallback works).
- ~~The token in `functions/index.js` (`WA_TOKEN`) is committed in plaintext~~ — ✅ resolved 2026-05-11 (Phase 4). Token now in Secret Manager as `meta-whatsapp-token`, bound to sendWhatsApp via `defineSecret`. **One step remaining (Junid action):** the old token is still in git history; rotate it in Meta Business Manager → System Users → Generate New Token, then update Secret Manager with `gcloud secrets versions add meta-whatsapp-token --data-file=<file> --project=marathon-club` and redeploy with `firebase deploy --only functions:sendWhatsApp`.

---

## 🧪 Temporary debug code (cleanup before going to production)

| File | Lines | What | When to remove |
|---|---|---|---|
| `src/App.jsx` | ~2570–2605 (inside `SourceView`) | Window-attached `window.__sourceDebug()` console helper that logs candidate / counted / leaked orders by status. | Remove once Source counts are confirmed correct in production. |
| `src/App.jsx` | ~3852 (inside App `useEffect`) | Window-attached `window.__orderAudit()` console helper + auto-warning when today's orders don't reconcile. | Replace with the in-app modal once UI is confirmed working. |
| `src/App.jsx` | ~3635–3690 (inside `InsightsView`) | `audit` `useMemo` block — heavy in-memory audit running every render. | Keep only if you decide to ship the audit modal as a permanent admin feature. Otherwise delete after the 7-ghost issue is solved. |
| `src/App.jsx` | ~3782 (inside Insights JSX) | "Run Order Audit" button + `AuditModal` mount. | Remove or hide behind a hidden tab once audit is no longer needed. |
| `src/App.jsx` | `AuditModal` component (~lines 3848–3970) | The full modal markup. | Delete with the button. |

Search for `// DEBUG —` and `// ── ORDER AUDIT —` comments to find all blocks quickly.

---

## 📐 Key code locations

| What | File · line range |
|---|---|
| Design tokens (`BG`, `CARD`, `BLUE`, `BLUE_L`, `RADIUS`, `GLOW`, button presets) | `src/App.jsx` ~55–95 |
| `STATUS_CONFIG` | `src/App.jsx` ~97–103 |
| `ProductIcon`, `ProductThumb`, `ProductPhoto` helpers | `src/App.jsx` ~31–88 |
| `orderCollectedDate` / `orderReadyDate` (strict, no fallback) | `src/App.jsx` ~415–435 |
| `RoleSelector` + role icons + `RoleCard` + `GroupSection` | `src/App.jsx` ~795–965 |
| `AdminView` (no emoji picker) | `src/App.jsx` ~970–1290 |
| `AssistantView` | `src/App.jsx` ~1295–1545 |
| `WarehouseView` | `src/App.jsx` ~1580–1900 |
| `CustomerView` | `src/App.jsx` ~1965–2050 |
| `DisplayView` (TV) | `src/App.jsx` ~2105–2240 |
| `SourceTodayTab` (premium card design) | `src/App.jsx` ~2253–2350 |
| `SourceHistoryTab` | `src/App.jsx` ~2355–2435 |
| `SourceOnHoldTab` | `src/App.jsx` ~2440–2530 |
| `SourceView` (data filters) | `src/App.jsx` ~2540–2655 |
| `ReturnsView` (no reason picker) | `src/App.jsx` ~2660–2760 |
| `InsightOverviewTab` (uses `readyLog`) | `src/App.jsx` ~2925–3055 |
| `InsightOOSTrackerTab` (single summary + collapsible) | `src/App.jsx` ~3140–3210 |
| `InsightSizePopularityTab` (horizontal blue bars) | `src/App.jsx` ~3215–3275 |
| `InsightBusiestTimesTab` (vertical bars) | `src/App.jsx` ~3280–3380 |
| `InsightSalesSummaryTab` (uses `readyLog`) | `src/App.jsx` ~3490–3620 |
| `InsightsView` + audit button + modal | `src/App.jsx` ~3625–3990 |
| `App()` + global audit + `useOrders()` | `src/App.jsx` ~3995–4150 |

Line numbers are approximate — searches by function name are reliable.

---

## ✅ Live-site smoke test (run before next session ends)

```
$ curl -sI https://marathon-club.web.app | head -3
HTTP/2 200
cache-control: max-age=3600
content-type: text/html; charset=utf-8

$ curl -s https://marathon-club.web.app/hero/marathon.jpg -o /dev/null -w "%{http_code}\n"
200
```

Last verified at session end: **all 4 hero images return 200**, root HTML returns 200, no broken bundle.

---

## 🔜 Suggested next session opening prompt

> "Resuming Marathon Club from `SESSION-NOTES.md`. Junid ran the in-app Order Audit and the result is: [paste reconciliation + status distribution + ghosts table]. Diagnose and fix the 7 ghost orders, then strip the debug helpers (`window.__sourceDebug`, `window.__orderAudit`, the audit button + modal) listed in the Temporary Debug Code section."
