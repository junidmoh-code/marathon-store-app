# Display Check System — Phase 1 Design & Architecture

Target repo: `marathon-store-app`. Firebase project `marathon-club`, europe-west1.
Status: design for review. No implementation.
Revision 3 — single confirm result, full Availability tab, static clothing catalog.

---

## 0. Governing constraints

1. **RTDB is 91% of the Firebase bill.** No live listener on `/pos/sales` or `/orders`. No product reads at render time. Everything the UI needs is denormalised into the check record by a server-side trigger, or served static from Hosting.
2. **Root RTDB rules are wide open** and Firebase's cascade means sub-rules cannot revoke a parent grant. So **all mutations go through Cloud Function callables**, and the log is server-written only. Same pattern as the store-credit callable.
3. **RTDB rules are console-managed.** `database.rules.json` is stale and is never deployed.
4. **No existing behaviour changes.** Reads only. Writes exclusively to `displayChecks*`.
5. Feature flag from PR 1.

---

## 1. Core model

A **display check** is a task, not a stock movement. Created by a sale, closed by a human, never edited afterwards.

### 1.1 Two results

```
┌────────────────────────────┐
│     Display Confirmed      │   ← blue   → PIN signing pad
└────────────────────────────┘
┌────────────────────────────┐
│     No Stock Available     │   ← grey   → PIN signing pad
└────────────────────────────┘
```

**Display Confirmed** replaces the old pair of *Display Replenished* / *Display Already Full*. One button covers both: I went and looked, the item is on the display now. Whether they physically put one out or found it already there is not a distinction worth a second button — the outcome is identical and the verification is identical.

The name holds your original principle. It says the person **checked and confirmed a state**. It does not say they refilled it, and it does not promise it stays full. No "Refilled", no "Fulfilled" anywhere in the UI.

**What merging costs:** you lose the count of "displays that were already fine" — i.e. how noisy the suggestions are. If you want that later it's a one-line addition, not a redesign. Everything that matters survives: an item selling again within 30 minutes of a Display Confirmed is still a repeat failure, and that's the whole verification mechanism.

### 1.2 Lifecycle

```
clothing sale written to /pos/sales   (product + colour + SIZE)
        ↓  RTDB onCreate trigger
open check already exists for this exact SKU?
   yes → bump saleCount, lastSoldAt. No new card.
   no  ↓
does that size exist in this store's inventory?
   no  → status = HELD. No card. Waits for stock. No mark, no penalty.
   yes ↓
was there a confirmed check for this SKU today?
   yes → new check, repeatOf set, repeatWithinMinutes = N
   no  → new check
        ↓  status = OPEN
staff opens card     → openedAt, openedBy               (callable)
staff confirms       → completedAt, completedBy, result (callable, write-once)
        ↓
not done by close    → rolls to tomorrow + MARK on the on-duty assignee
```

The dedupe rule is the point. Ten Nike Tech M sales in an hour is one card, not ten. A Nike Tech M sale *after* someone confirmed the display is a second card, flagged as a repeat.

Everything is **size-specific**. Sold M is a check about M. Sold M and L is two checks.

### 1.3 Hold and wake

Sold M, no M in the store → nothing anyone can do. Check is created `held`, not `open`. No feed, no denominator, no mark.

```
held check for {product, colour, size, store}
        ↓  sweep every 5 min (one-shot get, only for stores holding checks)
inventory qty > 0 and stockSeenAt == null
        ↓
stockSeenAt = now,  wakeAt = now + 20 min      ← grace to put stock away
        ↓  next sweep past wakeAt
status = open. Card appears. Assigned to whoever is on duty NOW.
```

Wake delay configurable per store, defaults 20. If the size sells out again before `wakeAt`, it drops back to held and `stockSeenAt` clears.

Held checks stay visible in a muted "Waiting on stock" section. A chronically held product is a buying signal, not a staff problem.

### 1.4 No-stock guard

Tap **No Stock Available** on a check where inventory says the size exists → the callable rejects the first attempt:

> **Medium exists in store.** Inventory shows 3 × M. Check the shelf again.

Second tap overrides. The override is recorded as `no_stock_override` and surfaces in manager analytics.

Soft block, not hard. Inventory is sometimes genuinely wrong here, and a hard block just trains people to tap Display Confirmed to escape — which is worse, because it's a lie you can't see. The override is the data: either a staff problem or a stock-accuracy problem, and you want to know which.

---

## 2. Warnings and marks

### 2.1 During the day

Escalating banner for the on-duty assignee, on every screen of the store app:

| When | Banner |
|---|---|
| 2h before close, outstanding > 0 | blue — "6 display checks outstanding" |
| 1h before close | amber — "6 outstanding. Finish before close." |
| 30 min before close | red — "6 outstanding. These become marks at close." |

Dismissible per session, returns on the next escalation.

### 2.2 Marks

At 03:00 rollover, every check still `open` marks **the person who was on duty that day** — not whoever inherits it.

```
/displayChecks_marks/{storeId}/{uid}/{YYYY-MM}/{markId}
  checkId, forDate, productName, colour, size, reason: "not_completed", createdAt
```

- Held checks never mark.
- One mark per check, not per day it lingers. Three days open is one mark, at first miss.
- Visible to the staff member **on their own profile** and to managers. Never to other staff. No leaderboard, no public ranking, anywhere.

Staff view: a plain line in the Today header — `2 marks this month` — tapping opens the list of which checks, which days. Honest, not theatrical.

---

## 3. Roster, lock and cover

### 3.1 Staff

Phase 1 goes live at **Marathon PE and Trophy**. Pine is built but its store flag stays off — the roster schema exists, the feed is dark. Flipping it later is one config value, no code.

| Store | Staff | Proposed username |
|---|---|---|
| marathon-pe | Lihle | `lihle` |
| marathon-pe | Zinhle | `zinhle` |
| marathon-pe | Ayanda | `ayanda` |
| marathon-pe | Sphe | `sphe.pe` ⚠ |
| trophy | Amanda | `amanda` |
| trophy | Sphe | `sphe.trophy` ⚠ |
| marathon-pine | Zama | `zama` — dark in Phase 1 |
| marathon-pine | Xoli | `xoli` — dark in Phase 1 |
| marathon-pine | Asanda | `asanda` — dark in Phase 1 |

⚠ **Blocker: two Sphes.** Sphe appears at both PE and Trophy. Synthetic emails are `{username}@marathon.internal` and that address can only belong to one person, so this has to be resolved before seeding, not after:

- **Same person, works both stores** → one account, one uid, `sphe`, with membership in both stores. The roster can name her on different days at different stores. Marks follow the uid across both.
- **Two different people** → two accounts, `sphe.pe` and `sphe.trophy`, two uids, two sets of marks. They must never be merged later — you can't unpick attribution once it's in an append-only log.

Get this wrong at seed time and every record signed by "Sphe" from that day forward is ambiguous. The whole attribution layer rests on it.

Also confirm whether these people already exist as users from the Phase 1 staff auth work. If they do, map to existing uids — do not create second accounts.

**PINs:** set in `scripts/seedUsers.cjs`, which you run yourself, before `firebase deploy` — otherwise staff land on an empty login. The PIN transform stays byte-identical between `seedUsers.cjs` and `Login.jsx`. Don't put PINs in a chat, a PR, or a comment.

### 3.2 Decide once, then lock

Settings shows the week as a draft. Seven rows, one dropdown each, nothing is live yet:

```
────────────────────────────────────────
 MARATHON PE · ROSTER · DRAFT
────────────────────────────────────────
 MONDAY      [ Lihle          ▾ ]
 TUESDAY     [ Zinhle         ▾ ]
 WEDNESDAY   [ Ayanda         ▾ ]
 THURSDAY    [ Sphe           ▾ ]
 FRIDAY      [ Lihle          ▾ ]
 SATURDAY    [ Zinhle         ▾ ]
 SUNDAY      [ — unassigned — ▾ ]
────────────────────────────────────────
        ┌──────────────────────┐
        │     LOCK ROSTER      │
        └──────────────────────┘
```

You review the whole week at once, then one action locks it. Confirm dialog states plainly what locking means. After that:

```
────────────────────────────────────────
 MARATHON PE · ROSTER · 🔒 LOCKED
 LOCKED BY JUNID · 17 JUL 2026 · 09:14:22
────────────────────────────────────────
 MONDAY      LIHLE
 TUESDAY     ZINHLE
 ...
```

Rows go read-only, ledger type, no dropdowns. Managers cannot edit a locked roster. **Only super-admin can unlock**, and unlocking is logged with the full before/after of every day that changes. The roster becomes a standing rule, not a suggestion — which is the point, because a roster anyone can quietly edit at 17:55 is not a roster.

Per store. PE and Trophy lock independently.

### 3.3 Cover — the exception that keeps the lock honest

The first time someone is sick, a locked roster becomes a problem. So the lock protects the *standing rule*, and a **cover** handles a single date without touching it.

A manager sets a cover for one day: `TODAY · ZINHLE COVERING FOR LIHLE`. The roster is untouched and still locked. The cover applies to that date only and expires at rollover.

Consequences, all deliberate:

- Checks that go open during a cover are assigned to the **cover**, and marks go to the cover. Whoever is actually on the floor carries it.
- The cover is on the record. The store card shows `COVER · ZINHLE (FOR LIHLE)` in amber, all day, to everyone. Not hidden in a settings screen.
- Every cover is logged with who set it, when, and for whom.
- Covers are counted. `Lihle: 6 covers this month` in manager analytics is a number worth having, because a roster that's covered half the time isn't a roster either.

```
/displayChecks_settings/{storeId}/roster
  locked        true
  lockedBy      { uid, name }
  lockedAt      ts
  days/{mon…sun}  → { uid, name, setBy, setAt }

/displayChecks_settings/{storeId}/cover/{YYYY-MM-DD}
  uid, name, forUid, forName, setBy, setAt, reason?
```

Assignment resolution, in order: **cover for today → locked roster day → unassigned.** Resolved server-side at the moment a check goes open, then frozen onto the check. Never recomputed. A check that opened under Zinhle's cover stays Zinhle's forever, even if the cover is deleted an hour later.


## 4. Database design (RTDB)

All new. Nothing existing is touched.

### 3.1 Live checks — the only thing the UI listens to

```
/displayChecks/{storeId}/{YYYY-MM-DD}/{checkId}
  productId, productName, colour, size
  imageUrl         thumbnail, denormalised
  triggerSaleId, firstSoldAt, lastSoldAt, saleCount
  status           "open" | "held" | "completed"
  result           "confirmed" | "no_stock" | null
  noStockOverride  true | null
  assignedTo       { uid, name }     ← roster owner at the moment it went OPEN
  heldAt, stockSeenAt, wakeAt, activatedAt
  openedAt, openedBy
  completedAt, completedBy
  repeatOf, repeatWithinMinutes
  carriedFrom, markedAt
```

One store's clothing sales in a day collapse to ~20–60 distinct SKUs. At ~380 bytes that's a **~25KB day node**. One `onValue`, per device, no index needed. That is the entire read cost of the checks feed.

### 3.2 Audit log — append-only, server-written

```
/displayChecks_log/{storeId}/{YYYY-MM}/{eventId}
  checkId, type, at, actor: { uid, name }, payload
```

`type` ∈ `suggested | held | stock_seen | activated | opened | confirmed | no_stock | no_stock_override | repeat_detected | carried_over | marked`.

Never updated, never deleted by the app. Monthly buckets so it archives without touching live paths. Clients never read it.

### 3.3 Roster and config — per store

```
/displayChecks_settings/{storeId}/roster/{mon…sun}   → uid, name, setBy, setAt
/displayChecks_settings/{storeId}/config
  wakeDelayMinutes 20, repeatWindowMinutes 30, closeTime "18:00"
```

Three stores, three independent rosters and configs.

### 3.4 Counters — written by functions, read by Analytics

```
/displayChecks_stats/{storeId}/{YYYY-MM}/staff/{uid}
  assigned, completed, outstanding, marks
  completionMsTotal, completionCount, responseMsTotal
  repeatFailures, noStockOverrides
  resultCounts: { confirmed, no_stock }

/displayChecks_stats/{storeId}/{YYYY-MM}/products/{productId}
  productName, checksGenerated, repeats, heldCount, noStockCount

/displayChecks_stats/{storeId}/today
  assigned, completed, outstanding, held, assignee: { uid, name }
```

`today` is a tiny denormalised node so the store toggle can show all three stores without subscribing to three day nodes.

### 3.5 Retention

Day nodes > 90 days and log months > 12 export to Storage as newline JSON and prune on a schedule. Prevents the append-only growth problem already identified elsewhere in this project.

### 3.6 Indexes

None. Every query is a direct path read of a small node. Deliberate. Any future `.indexOn` goes in the console, not the repo.

---

## 5. Static clothing catalog — Hosting, not RTDB

The Availability tab needs name search and barcode lookup. Doing either against RTDB means either downloading a catalog on every session or adding indexed queries — both are exactly the cost pattern you're trying to kill.

Instead, a nightly Cloud Function writes a static file and deploys it to Hosting:

```
https://marathon-club.web.app/data/clothing-catalog.v{n}.json

[ { id, name, colour, barcode, thumb }, … ]
```

Clothing only, a few hundred entries, ~150KB gzipped. CDN-cached, versioned filename so it busts cleanly, fetched once per session, **zero RTDB reads**. Name search and barcode lookup both run entirely client-side against it.

This also removes the barcode-index prerequisite entirely — barcode → productId is just a map lookup in the catalog.

Live quantities are never in the catalog. Once a product is identified, sizes and quantities come from **one `get()`** on that product's inventory node. One read per lookup, cached in memory for the session.

---

## 6. Availability tab

Replaces the old Scan Item tab and absorbs it. One tab, three ways in, one result.

```
┌─ Scan ─┬─ Barcode ─┬─ Name ─┐      ← segmented control
```

- **Scan** — camera opens immediately, decode, result. Mobile default. Reuses the existing scanner component from scan-to-transfer.
- **Barcode** — big numeric keypad, large digits, auto-lookup the moment the length is valid. For when the camera won't focus or the label is scuffed.
- **Name** — search field, live results as you type, against the static catalog. Fuzzy on name + colour. Desktop default.

**Desktop also listens for a USB wedge scanner.** Store desktops with a handheld scanner type barcode digits as keystrokes — a hidden always-focused capture catches a fast burst ending in Enter and fires the lookup with no tab switch and no click. Free feature, feels like magic.

### Result card

```
   ┌──────────────┐   Nike Tech Fleece Hoodie
   │              │   Black
   │   [ image ]  │   ─────────────────────────
   │              │     S    1
   └──────────────┘     M    3
                        L    0        ← muted red
                        XL   2
                        XXL  1
                      ─────────────────────────
                      Marathon Pine · floor
                      ▸ Other stores
```

Zero rows in muted red, never hidden — "L is zero" is the answer to the question just as much as "M is 3".

`Other stores` is collapsed, and expanding it fires two more `get()`s. Customer asks for L, you don't have it, Trophy does. Cheap and obviously useful.

No writes. No live listeners. Pure read.

### Desktop layout

Two panes. Left: the segmented input, search field prominent, recent lookups beneath it. Right: the result card, large, image at ~400px. Marathon Glass — frosted panel on pitch black, electric blue accents, size table monospaced numerals so the columns line up.

### Mobile layout

Full-bleed. Segmented control pinned to the top, camera or keypad or search fills the rest. Result slides up as a full sheet — image, name, then the size table at 56px rows because you're reading it at arm's length holding a garment in the other hand. `Scan again` as a fixed bottom button.

### Entry points

The tab itself, plus a floating scan button on the Today feed so someone mid-check can look up stock without losing their place, and a `Check availability` action inside the check drawer/sheet for the same product — one tap, pre-filled, no scanning. That's the toggle you wanted: from a display check straight into availability and back.

---

## 7. Permission model

| Capability | Clothing staff | Manager | Super-admin |
|---|---|---|---|
| See Display Checks card | own store | own store | all stores |
| Open / confirm a check | own store | own store | any |
| Availability tab | yes | yes | yes |
| Store toggle | no | no | yes |
| See own marks | yes | yes | yes |
| See others' marks / analytics | no | yes | yes |
| Settings (roster, config) | no | yes | yes |

Non-clothing staff, warehouse, and POS users see no card and no route.

Enforcement, honestly: **UI gating is cosmetic.** Real enforcement is in the callables — every mutation re-derives role and store from the auth token server-side. `context.auth.uid` is the only trusted input. Console rules (`.write: false` for clients on `/displayChecks`, `_log`, `_stats`, `_marks`) go in now so the module is already correct when the root audit lands.

---

## 8. Navigation

```
Store App Home
  └─ Dashboard card: "Display Checks"      ← badge = your store's outstanding
       └─ /display-checks
            ├─ Today          ── store toggle (super-admin)
            ├─ Availability
            ├─ Analytics      (manager)
            └─ Settings       (manager)
```

### Store toggle

Three stores run separately — separate rosters, separate feeds, separate marks. A switcher, not a merge. No combined view.

Reads `/displayChecks_stats/{store}/today` ×3 — three tiny nodes, no day-node subscriptions:

```
┌─────────────────────────────┐  ┌─────────────────────────────┐
│ ● MARATHON PINE     ← live  │  │ ⚠ TROPHY                    │
│ [av] Nomusa                 │  │ [av] Zee                    │
│ 12 / 18   ●●●●●●○○○         │  │ 3 / 21   ●○○○○○○○○          │
│ 6 outstanding · 2 held      │  │ 18 outstanding · red        │
└─────────────────────────────┘  └─────────────────────────────┘
```

Same warning colours as the feed. Switching swaps the listener — old day node detaches first. Only one day node is ever subscribed.

---

## 9. Attribution and the strict register

You want it to feel like someone is watching. Agreed on the goal. One correction on the method, because it changes the design.

### 8.1 Scary doesn't work. Precise does.

A red skull, a warning siren, a big angry banner — staff laugh at it in week two and it stops working forever. Theatre has a half-life. Worse, fear optimises for the wrong thing: if the interface is frightening, the cheapest way to make it stop is to tap **Display Confirmed** from the stock room without walking to the display. Now you don't have a forgetful staff member, you have false data, and false data is worse than no data because you'll act on it.

So the register is not horror. It's **flight recorder**. Cold, exact, permanent, and visibly ahead of you. The feeling to produce is not *this app is angry at me*, it's *this thing already knows*.

That's the difference between looking strict and being strict. Below is how each one is built.

### 8.2 The one change that makes every name real

The iPad is shared. If sign-in is a session, then Nomusa signs in at 09:00, leaves her session open, Zee taps confirm at 14:00, and the permanent record says **Nomusa**. Every name in your audit log is then a guess. All the attribution design in the world is decoration on top of a lie.

So: **PIN to sign.** Confirming a check requires the 4-digit PIN they already have. Two seconds, one thumb, on the sheet itself. Not to open a card, not to browse — only to sign a result, because that's the consequential write.

```
┌──────────────────────────────────┐
│  SIGN AS                         │
│  NOMUSA MKHIZE                   │
│                                  │
│      ●   ●   ●   ○               │
│                                  │
│   1     2     3                  │
│   4     5     6                  │
│   7     8     9                  │
│         0     ⌫                  │
│                                  │
│  17 JUL 2026 · 14:41:07          │  ← live, ticking
└──────────────────────────────────┘
```

This is the whole feature. Everything after it is presentation. A signature that costs two seconds and can't be borrowed is what makes a name mean something — and staff understand signing. Everyone has signed for something.

The callable verifies the PIN server-side against the same transform as login (`pin-${pin}`, byte-identical to `seedUsers.cjs` and `Login.jsx`), rate-limits to 5 attempts per uid per minute, and records `signedAt` separately from `completedAt`. A wrong PIN is logged too.

### 8.3 Identity is always on screen

Top-right of every screen in the module, desktop and mobile:

```
● ON DUTY · NOMUSA MKHIZE · 14:32:07
```

Monospaced, uppercase, seconds ticking. A slow pulse on the dot. Not a warning — a fact. You are identified, right now, on the record, and the clock is running. Idle 90 seconds on the iPad and it drops to a lock card: `TAP TO IDENTIFY`. Nobody acts anonymously, ever.

### 8.4 Typography does the work

Marathon Glass stays: pitch-black glossy, frosted panels, electric blue. Layer one thing on top — **ledger type** for anything the system recorded.

- Metadata in monospace (JetBrains Mono), uppercase, wide tracking.
- Timestamps to the **second**, always. `14:41:07`, never `2:41 PM`, never "a few minutes ago". Precision to the second reads as machine, and machines don't forget.
- Product names and human copy stay in the normal sans. The contrast is the point: warm where a person is talking, cold where the record is.

That single typographic split does more work than any colour ever will.

### 8.5 Every card carries its own record

Completed cards don't say "Nomusa completed this." They read like a receipt:

```
────────────────────────────────
 NIKE TECH FLEECE HOODIE
 BLACK · M
────────────────────────────────
 SUGGESTED   14:32:07
 OPENED      14:39:12   NOMUSA
 CONFIRMED   14:41:07   NOMUSA
 SIGNED      PIN VERIFIED
 ELAPSED     00:08:55
────────────────────────────────
```

Permanent, uneditable, and visible to everyone in the store. Not because it shames anyone — most of these say the person did their job in nine minutes — but because the record existing *at all*, in plain sight, is the deterrent. Nobody needs to be told it's being kept.

### 8.6 The clock is the pressure

Every open card carries a live counter, ticking, since the check was suggested:

```
 ⏱ 00:14:22
```

Blue under 30 minutes. **Amber** past 30. **Red** past 60. It counts up, it doesn't stop, and it's on the card, not buried in analytics. No copy, no exclamation marks, no telling anyone off. Just elapsed time, in public, refusing to stop.

Time is the most honest pressure there is, and it never gets old the way a scary icon does.

### 8.7 "The system already knows"

The strongest moment in the whole design is the repeat card. It doesn't accuse. It puts two facts next to each other and stops talking:

```
┌ REPEAT ────────────────────────┐
│ NIKE TECH · BLACK · M          │
│                                │
│ CONFIRMED    14:41:07  NOMUSA  │
│ SOLD AGAIN   14:53:31          │
│ INTERVAL     00:12:24          │
│                                │
│ SECOND CHECK ISSUED            │
└────────────────────────────────┘
```

No "you failed to replenish." No red. Amber and flat. The unsettling part is that nobody told it — it reconstructed what happened from a sale, on its own, and wrote it down. That's the *I'm watching you* you asked for, and it lands harder than a skull because it's true and it's specific.

Same energy in the no-stock guard, and it's already in the design:

```
 INVENTORY SHOWS 3 × M
 CHECK THE SHELF AGAIN
```

The system contradicting a person, calmly, with a number. Never raise the voice. The number is the voice.

### 8.8 End of day, on the record

At close, one card, permanent, in the feed:

```
────────────────────────────────
 17 JUL 2026 · MARATHON PINE
 ON DUTY   NOMUSA MKHIZE
────────────────────────────────
 ASSIGNED  18
 CONFIRMED 16
 NO STOCK   0
 MARKED     2
 AVG TIME  00:11:04
────────────────────────────────
 RECORDED
```

`RECORDED` is the last word on the screen every day. Not "well done", not "try harder". Just: this happened and it's kept.

### 8.9 Keep red scarce

If everything is red, red is wallpaper. Discipline in the palette is what preserves the threat:

- **Blue** — normal, on time, confirmed.
- **Amber** — late, repeat, override. Something to look at.
- **Red** — marks only. The permanent stuff.

Red appears maybe twice a week. That's exactly why it works when it does.

### 8.10 What this deliberately does not do

No countdown timers with alarms. No sad faces. No "3 STRIKES" banners. No leaderboard, no public ranking — that stays out, as you specified from the start, and it's also the single fastest way to teach people to game a system.

The design makes honesty cheap and lying expensive. `No Stock Available` is one tap and carries no penalty when it's true — held checks never mark, and a genuine no-stock is a buying signal, not a failure. Confirming a display you never walked to costs a PIN, a signature, a timestamp to the second, and a coin-flip that the next sale exposes you within 12 minutes in front of everyone.

That's what makes a system strict. Not the colour of the buttons.


## 10. Desktop UI — Today

Marathon Glass: pitch-black glossy ground, frosted panels, electric blue accents.

- **Header strip** (frosted, full width): `Good Morning, Lihle` / `Today's Display Checks` / date. Right: three tiles — *Assigned to* (avatar + name), *Completion* `12 / 18` with a thin blue progress arc, *Outstanding* `6`. Warning banner directly beneath when live. Own marks as a quiet line under the greeting.
- **Left rail**: filter chips — All / Outstanding / Confirmed / Repeats / Waiting on stock. Store toggle above, super-admin only.
- **Main grid**: cards, 3 across, outstanding first then newest sale.
- **Right drawer** on click: large image, full detail, the two confirm buttons, the PIN signing pad, `Check availability`, and the check's own timeline (suggested → held → stock seen → activated → opened → confirmed).

**Check card**

```
┌──────────────────────────────┐
│  [ product image, 1:1 ]      │
│                              │
│  Nike Tech Fleece Hoodie     │
│  Black · M                   │
│  Sold 14:32   ·  ×3          │  ← ×N only when saleCount > 1
│  ┌────────────────────────┐  │
│  │     Check Display      │  │  ← electric blue, full width
│  └────────────────────────┘  │
└──────────────────────────────┘
```

**Completed cards** dim to 40% and the button swaps for a result tag:

```
  ✓ Confirmed · Nomusa · 14:41        ← blue tag
  ✗ No Stock · Zee · 15:02            ← grey tag
  ✗ No Stock · overridden · Zee       ← amber tag, manager sees the flag
```

Repeats carry a thin amber left border and a `Repeat` chip — amber, not red; a signal, not a punishment. Held cards go greyscale with a `Waiting on stock` chip and no button.

---

## 11. Mobile UI — Today

Same functionality, different shape. One hand, walking the floor.

- **Sticky top card**: greeting, big `12 / 18`, progress bar, outstanding, marks line. Collapses to a slim bar on scroll. Warning banner pins under it.
- **Feed**: single column, 88px image left, name/colour/size/time right, full-width `Check Display` beneath. 56px minimum touch targets.
- **Confirm = bottom sheet.** Image, then two fat stacked buttons — `Display Confirmed`, `No Stock Available` — plus a text link `Check availability`. Either button pushes the sheet to the PIN signing pad (§9.2) before anything is written. The no-stock warning replaces the sheet contents in place: big, red, `Medium exists in store · 3 × M`, with `Check again` and a smaller `Still not there`. Swipe to dismiss.
- **Bottom tabs**: Today · Availability · (Analytics) · (Settings). Floating scan button on the feed.
- Completed animate into a collapsed `Confirmed (12)` section; held into `Waiting on stock (2)`. The feed only shows work you can do.

---

## 12. Component architecture

```
src/pages/DisplayChecks/
  index.jsx                 route shell + tab router + role gate
  StoreToggle.jsx
  TodayView.jsx
  CheckCard.jsx
  CheckDrawer.jsx           desktop
  CheckSheet.jsx            mobile
  NoStockWarning.jsx
  SignPad.jsx               PIN signing pad
  OnDutyBadge.jsx           persistent identity strip
  CheckLedger.jsx           per-check receipt / timeline
  ElapsedClock.jsx          live ticking counter
  DayRecordCard.jsx         end-of-day RECORDED card
  MyMarks.jsx
  Availability/
    index.jsx               segmented control
    ScanInput.jsx           camera
    BarcodeInput.jsx        keypad
    NameSearch.jsx          static catalog
    WedgeCapture.jsx        desktop USB scanner listener
    ResultCard.jsx
  Analytics.jsx  →  StaffTable.jsx, ProductTable.jsx
  Settings.jsx

src/hooks/
  useDisplayChecks.js       ← the ONLY listener: onValue /displayChecks/{store}/{today}
  useStoreSummaries.js      ← get() ×3, refresh on focus
  useClothingCatalog.js     ← fetch static JSON, session cache
  useAvailability.js        ← one get() per product, memoised
  useDisplayRoster.js, useDisplayStats.js   ← get()
  useDisplayActions.js      ← wraps callables

functions/displayChecks/
  onClothingSale.js         RTDB onCreate /pos/sales — dedupe, hold, repeat detect
  wakeHeldChecks.js         scheduled, 5 min
  openDisplayCheck.js       callable
  completeDisplayCheck.js   callable — includes the no-stock guard
  setDisplayRoster.js       callable
  rolloverAndMark.js        scheduled 03:00 SAST
  buildClothingCatalog.js   scheduled nightly → Hosting
  archiveDisplayLogs.js     scheduled monthly
```

`useDisplayChecks` detaches on `visibilitychange → hidden`, reattaches on visible. Store devices sit on this screen all day; a detached listener on a backgrounded tab is free money.

No new business logic. Category, sizing, inventory and sales come from existing sources. This module classifies and tracks; it does not compute stock.

---

## 13. Tracking model

Every state change writes a mutation on the check and an append-only log event in the same server-side operation.

| Field | Written by | When |
|---|---|---|
| firstSoldAt, saleCount, lastSoldAt | trigger | sale detected |
| heldAt | trigger | size not in store inventory |
| stockSeenAt, wakeAt | wake sweep | size reappears |
| activatedAt, assignedTo | sweep / trigger | check goes open |
| openedAt, openedBy | callable | staff taps Check Display |
| completedAt, completedBy, result | callable | staff confirms |
| signedAt, pinVerified | callable | PIN accepted server-side |
| pinFailures | callable | wrong PIN — logged, not silent |
| noStockOverride | callable | staff overrides the guard |
| repeatOf, repeatWithinMinutes | trigger | sale after a confirmed check |
| carriedFrom, markedAt | rollover | 03:00 |

`result` is write-once. The callable rejects any mutation where `completedAt` is set. Corrections are a new check, not an edit.

---

## 14. Analytics model

Every question in the proposal maps to a counter. No scans.

| Question | Source |
|---|---|
| Fastest completer | `completionMsTotal / completionCount` |
| Consistently leaves displays empty | `marks` + `repeatFailures` |
| Products that repeatedly go empty | `products/{id}.repeats` |
| Products chronically out | `products/{id}.heldCount` ← buying signal |
| Products generating most checks | `products/{id}.checksGenerated` |
| Displays never checked | open records with `openedAt == null` at rollover |
| Average response time | `responseMsTotal / count` (activated → opened) |
| Completion rate | `completed / assigned` (held excluded) |
| Repeat check rate | `repeats / checksGenerated` |
| Inventory trust | `noStockOverrides` — stock data wrong, or nobody looking |

**Display Accuracy** = `1 − (repeatFailures / resultCounts.confirmed)`. How often "confirmed" held up. Merging the two positive results actually makes this cleaner — one denominator, no judgement call about which button they should have pressed.

**Display Availability Rate** = share of the day no *open* check sat longer than 60 minutes. Held time excluded — you can't be penalised for stock you don't have. Computed at rollover, stored as one daily number.

---

## 15. Verify before PR 1

- Shape of `/pos/sales` — store-scoped? does a line item reliably carry category and size?
- **Where store clothing inventory lives, and whether it's readable per `{product, colour, size, store}` in one `get()`.** Hold/wake, the no-stock guard, and Availability all depend on this. If it isn't shaped that way, that's a prerequisite PR before anything else.
- Role and store fields on the staff auth record.
- Product thumbnail derivative — full-size images on a 60-card grid is a bandwidth problem, not a Firebase one, but still a problem.
- Whether clothing products carry a barcode field at all, and whether it's populated.

PR 2 deploys the trigger **writing only, no UI**. Let it run a few days and compare what it generated against what actually happened on the floor — especially the hold decisions. Cheapest possible way to find out the design is wrong. PR 7 is the first thing staff feel.

Deploy per standing rule: `git fetch origin && git checkout origin/main && rm -rf dist && npm run build && firebase deploy`. Rules by hand in the console.

---

## 16. PR breakdown

| PR | Scope | Risk |
|---|---|---|
| 0 | Resolve the two-Sphe question. Seed/map staff for PE + Trophy via `seedUsers.cjs`, run by you. | **blocker** |
| 1 | Feature flag (per store), route, shell, role gate, schema doc. No data. | none |
| 2 | `onClothingSale` trigger — dedupe, size-scoped, hold-when-no-stock, log writes. Dormant. | low — new namespace |
| 3 | `wakeHeldChecks` sweep + grace window. No UI. | low |
| 4 | `buildClothingCatalog` nightly → Hosting. Standalone, useful on its own. | none |
| 5 | `useDisplayChecks` + Today view, desktop, read-only. | none |
| 6 | Mobile layout + bottom sheet, read-only. | none |
| 7 | `openDisplayCheck` + `completeDisplayCheck` callables + wiring. **Module goes live.** | medium |
| 8 | PIN signing pad + server-side verify + rate limit. **Makes attribution real.** | medium |
| 8b | No-stock guard + override + warning UI. | low |
| 9 | Availability tab — scan, keypad, name search, result card, desktop + mobile. | low |
| 10 | Wedge-scanner capture + `Other stores` expansion. | low |
| 11 | Settings — roster draft + LOCK, super-admin unlock, cover-for-a-day, wake delay, repeat window, close time. | low |
| 12 | `rolloverAndMark` + escalating banners + My Marks. | medium |
| 13 | Stats counters + Analytics tab. | low |
| 14 | Store toggle + assistant cards + `stats/today`. | low |
| 14b | Ledger register — mono type, on-duty strip, per-check receipt, elapsed clock, RECORDED card. | none |
| 15 | Log archiving + retention. | low |
| 16 | *Optional, later:* WhatsApp warning push to assignee, close-of-day summary to manager. | low |

PR 4 and PR 9 together are the availability feature and are independent of everything else — they could ship first if you want something on the floor sooner.

---

## 17. Still open

1. **Close time per store** — Settings has the field; confirm the three actual times.
2. **Held check wakes at 16:40, sale was 09:00 — whose is it?** Design says whoever's on duty at activation, since that's who can act.
3. **No assignee for a weekday** — checks still generate, `assignedTo` null, no marks possible, manager sees "Unassigned" on the store card.
4. **`Other stores` on the availability card** — in or out? It's two extra reads and obviously useful at the counter, so it's in by default.
