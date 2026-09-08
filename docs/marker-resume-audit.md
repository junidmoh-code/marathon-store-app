# Display-marker resume audit — 2026-09-08

Commissioned as "COMMIT 0 — audit what the killed session left" before finishing the
"monitor icon is informational only" job. The short answer is that the job asked for
was finished and merged the day before, and the branch this worktree sits on carries a
follow-on to it.

## Where the work actually is

`fix/display-marker-informational` has **zero commits beyond `origin/main`**. It was
merged on 2026-09-07 as **PR #576** — `0a608bd The display marker informs; it no longer
takes the size away`. There is nothing left on it to continue.

The live branch is **`feat/display-marker-all-hubs`**, one commit ahead of
`origin/main`:

    fc28a23  Every hub's walls draw a marker; only Hub 1 may pull

That commit is pushed, and **PR #578** is open for it. Working tree is clean — no
staged, unstaged or untracked change, so the killed session left nothing half-written
on disk. `git diff origin/main HEAD --stat`, **as the audit found the branch** (one commit,
`fc28a23`; the branch has grown since):

    src/App.jsx                                        | 69 +++++--
    src/components/stock/displayMarkerAllHubs.test.js  | 135 +++++++++++
    src/components/stock/hubIsolation.test.js          | 48 ++++--

## The required end state, item by item

| Requirement | State | Evidence |
|---|---|---|
| Monitor icon is informational only — icon + accessible label, nothing else | **done** | the three size grids, each an `aria-label="this size is on a display"` span holding one 7px SVG, absolutely positioned, with no other effect: the desktop **hover grid** (`{szs.map…}`, `src/App.jsx:8378`, glyph inline at `8444`), the desktop **quick-view** (`{sizesOf(qv).map…}`, `8611`, glyph at `8653`) — both inside `AssistantDesktop` — and the **phone sheet** (`{selectedSizes.map…}`, `10796`, glyph at `10860`) inside `AssistantView`. An earlier draft of this row had the hover grid and the phone sheet the wrong way round (CodeRabbit, 2026-09-08); the line numbers here are as at the tip of this branch, not at `fc28a23`. |
| Tapping a marked size behaves like any unmarked size | **done** | none of the three `onClick` bodies mentions a display term; asserted per-surface in `displayMarkerInformational.test.js` PART 2 by slicing the handler out of `App.jsx` and requiring it to match nothing display-shaped |
| Requests only via the "Request Display Partner" button, unchanged | **done** | both surfaces still render it (`App.jsx:8676` desktop, `10895` phone); its toggles, its ✕ exemption and its size-optional rule are pinned in PART 3 |
| The auto-divert is deleted outright, not flagged off | **done** | `sneakerDisplayOnly`, `displayOnly`, `pendingDisplayPair`, `qvDisplayPair`, both divert panels and their prompt state are all absent from `App.jsx`; the only surviving hit for "Request display pair" is the comment recording why it went |
| Availability governed by quantity alone; zero behaves as before | **done** | PART 1 is a real differential: the same cell composed once with its slot node and once with it emptied, over qty 0/1/2/3/4/10, agreeing on booked/promised/available/out and differing only in the glyph |
| No display registration write path changed | **held** | `displayRegistrationStore.js` and `displaySlots.js` untouched by `fc28a23`; only the marker's *read* moved hub |

Nothing is half-done and nothing is untouched. There is no dangling import, no partial
refactor and no broken build: `vite build` succeeds and the three display test files
(`displayMarkerInformational`, `displayMarkerAllHubs`, `displaySlots`) pass.

## Test suite at the moment of the audit

`npx vitest run` — **5521 passed, 10 failed** across 281 files.

Nine of the ten are pre-existing on `origin/main` and belong to other subsystems: this
branch touches only `App.jsx` and two `src/components/stock` test files, so those
suites are byte-identical to main.

- `scripts/shopify/homeRails.test.mjs` (3) — theme rail order / `/collections/all` sorts
- `scripts/shopify/priceHearts.test.mjs` (2) — card price markup
- `scripts/shopify/themeStrings.test.mjs` (2) — brand triggers in theme strings
- `scripts/social/socialSchedule.test.mjs` (2) — no `StartInterval` in the launchd plist

The tenth **is** in this subsystem and is fixed on this branch:
`displayPairCore.test.js > slotsAfterOrderExits … is a pure projection`. It was a
date time-bomb, not a regression. The prototype-safety assertion needs the projection
to actually change something, which needs `exitWins(ev, null, now)` to pass the
seven-day create bound (`DISPLAY_EXIT_CREATE_MAX_AGE_MS`, `displayPairCore.js:274`).
The fixture's event is stamped `2026-09-01T08:00:00.000Z`; the suite started failing
once wall-clock passed 2026-09-08T08:00Z, roughly four hours before this audit ran.
The assertion is about `__proto__` being data, which has nothing to do with the clock,
so the fix pins `nowMs` at the call rather than moving the bound.

## What the audit did NOT catch, and the reviews did

Recorded here because the audit above says "nothing is half-done", and on one
count that was too generous. `fc28a23` claimed to make **every** hub's displays
draw a glyph, Pine's hub3 rows included, and it does not. Three independent
reviewers reached the finding separately.

The glyph reads the map of the hub the size resolves to, that hub comes from
`sneakerHubOf` → `gatedSneakerHub`, and `GATED_SNEAKER_HUBS` is
`["hub1", "hub2"]` — so `sneakerHubOf` can never return `"hub3"` and the hub3
map was unreachable. Independently, a Pine device never subscribes to the slots
node at all (`useDisplaySlotsState(effectiveStoreMode !== "pine")`), so there
would be nothing in it to read even if the gate allowed it.

The real win is Trophy's 228 hub2-booked rows, which is what the change
delivers. Pine needs a wider sneaker gate plus a new listener on a Pine device —
a stock-routing decision and a data-cost one, neither of them a glyph change.
The maps are now built from `GATED_SNEAKER_HUBS` rather than a hand-written
list, so the marker cannot again be claimed wider than the availability lane it
hangs off, and the residual is pinned by tests in `hubIsolation.test.js` and
`displayMarkerAllHubs.test.js`.
