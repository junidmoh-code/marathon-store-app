# First batch direct to shop — investigation (read-only, 2026-09-17)

Branch `feat/first-batch-direct-to-shop`, off `origin/main` `0eeb6669` (live hosting
`version.json` = `0eeb6669.1789464866344`, built 2026-09-15). Every fact below was
read from the code at that commit or from live RTDB with scoped reads.

## 1. The path today, with file:line

**Entry point — Inventory Health → Missing Products (the "unsolved" tab).**
- `src/components/stock/HealthView.jsx:492-493` builds the chips (`buildChips` /
  `pickActiveTab`) and `:532` mounts `NetworkTransfer` with the card list,
  `/stock_targets`, and the shared undo strip.
- `src/components/stock/missingProductsCore.js:113-145` `computeMissingProducts`:
  a card is **"Only in Central"** (`source: "central"`) when Central holds units,
  Hub 2 does NOT carry the product (no `/stock/hub2/{pid}` node) and neither shop
  carries it (`:127-129`). "Carries" = the stock NODE exists at any qty — the
  engine's `storeCarries` (`functions/lib/refill-engine.cjs:219-222`). Only clothing
  (`isClothing`, `:93-97`) and perfume (`isPerfume`) are admitted; deactivated
  products are dropped (`:121`).
- **How a product leaves the tab:** the moment a shop node exists for it
  (`carriedDownstream`, `:127`). A Solve that seeds a qty-0 shop cell retires the
  card on the next `/stock` snapshot. Confirmed for context item 5: a product whose
  ONLY downstream node is the shop's (Hub 2 not yet seeded) is `carriedDownstream`
  → not a card. It never reappears as "Only in Hub 2" either, because that branch
  also requires `!carriedDownstream` (`:130`).

**The Solve (`src/components/stock/NetworkTransfer.jsx`).**
- Config LIVE via `onValue("config/refillEngine")` `:207-211`; targets handed down
  from HealthView (`:229-230`).
- `runFor` `:258-275` = `resolvedRun` (`solvePlan.js:210-236`), the mirror of
  `resolveTarget`'s priority (explicit row > category policy > rules under the kill
  switch). `qualifyingSizes` `:293-296` → `solvePlan.js:251-255`: a size qualifies
  only with a positive target at EVERY seed location.
- `seedLocations` (`solvePlan.js:52-54`): central-stranded → `["hub2", store]`;
  hub2-stranded → `[store]`.
- `solve()` `:328-380`: ONE atomic `update()` writing qty-0 seed cells
  (`{qty:0, v:0, mv:"seed", lastType:"count", state:"live"}`) at Hub 2 AND the
  store, seed-if-absent (`:352-358`). **It raises no request.** The undo record
  (`:362-367`) carries the exact paths written and the engine locks that existed
  before (`priorOpen`).
- Undo `:148-190`: refuses on any NEW `/refill_engine/open/{loc}/{pid}` lock
  (`solveUndo.js solveUndoBlockers`), then deletes each untouched seed by
  transaction (`undoCellTxn`).
- Panel copy `:663-700` says "seeds Hub 2 + {store} at qty 0 … Hub 2 pulls ~N from
  Central".

**How the hub and shop requests get created today — the engine, not the Solve.**
`functions/refill-scan.cjs` (`refillHealthScan`, scheduled, europe-west1) snapshots
RTDB (`:468-469` reads `/refill_engine/open` and `/refill_requests` whole) and runs
`computeRefillPlan` (`functions/lib/refill-engine.cjs:646`):
- Destinations come from `config.routes` (`:658-664`), ordered downstream-first.
  Live: `hub1→central, hub2→central, marathon-pe→hub2, trophy→hub2`.
- `managedPids(dest)` `:1116-1134`: explicit target rows, category-policy entries
  (unconditional unless `carriedOnly`), and — for clothing under
  `ruleBasedTargets` — only products the dest **carries** (`storeCarries`).
- `resolveTarget` `:526-643`: deactivated → null; explicit row; category policy
  (`categoryPolicyEntry` `:450-465`, `carriedOnly` gate `:460`); footwear rule
  (needs `footwearTargets`, live **null = OFF**); kill switch `:606`; clothing rule
  `:608-641` needs `storeCarries(stock, dest, pid)` and a run entry.
- Deficit loop `:1414-1660`: `deficit = target − have − inbound` (`:1429`);
  **actionable-only**: `srcAvail = source on-hand − sourceReserved` (`:1592-1593`);
  source empty → no request, demand parked as `awaitingUpstream` /
  `awaitingSupplier` (`:1594-1637`); otherwise `qty = min(deficit, srcAvail,
  maxUnitsPerIntent)` and an intent is pushed (`:1639-1644`).
- `inbound` = open locks in `/refill_engine/open` (`:672-686`) + human Shop Refill
  orders + held lines. A `/refill_requests` row **without** a lock is invisible to
  the deficit math.
- Apply (`refill-scan.cjs:731-796`): lock `refill_engine/open/{dest}/{pid}/{sizeKey}`
  claimed create-if-absent (`:735-739`), request shape `{productId, size, qty,
  requestingLocation, status:"open", createdFrom:{engine:true, runId, source},
  createdAt}` (`:742-745`), hub legs get a request only; store legs also get an
  R### `/orders` node for the Hub 2 warehouse Clothing tab (`:746-780`); ONE
  atomic update finalises the lock with `refillId` (`:784-793`).
- Reconcile `:775-960` for every lock: `needGone` (`:836`), `unfillable` (`:840`),
  `sourceEmpty` (`:867-868`, uses `entry.source || routes[dest]`), human rejection
  detection (`:878-897`), stale (`:908`), auto-resize to
  `min(target − have − otherInbound, source free)` (`:907-938`), applied by
  `applyResizes` (`refill-scan.cjs:182-236`). Satisfied-by-stock pass
  (`:1002-1075`) withdraws lock-less open rows once the dest cell holds them.

So today, for a central-stranded clothing product Solved at Trophy: seeds at hub2 +
trophy → next scan: hub2 carries → hub2 target (run L3/M3/S2/XL2/XXL2/XXXL1) → src
central has stock → **hub2←central request** (Source → Hub 2 Refill → Clothing);
trophy carries → trophy target (L2/M2/S2/XL1/XXL1/XXXL1) → src hub2 empty → parked
`awaitingUpstream`; once Hub 2 receives, the following scan raises trophy←hub2 as an
R### Shop Refill order (Hub 2 warehouse Clothing tab). This is exactly the
"Hub 2 requests everything, then the shop requests from Hub 2" behaviour the owner
described.

**Source (`src/App.jsx` `SourceView` + `src/components/stock/RefillQueue.jsx`).**
- `SOURCE_TABS` `App.jsx:15661` = Hub 1 Refill / Hub 2 Refill / Refill History;
  `hubTabContent(h)` `:16024-16054` mounts `<RefillQueue dest={h} …>`; content switch
  `:16055-16062`; badges `:15908-15952` (open requests counted for hub1/hub2 only
  `:15943-15947`); tab strips `:16068-16110` (desktop) and `:16136-16160` (mobile),
  both driven by `SOURCE_TABS`.
- `RefillQueue` request rows `:315-329`: `status==="open" &&
  requestingLocation===dest`, grouped **by productId** (`cards` `:642-660`, key =
  `row.productId`), one line per size. Supply source is fixed to Central (`:663`,
  `SOURCE_LOC`).
- Fulfil `fulfilRequest` `:355-500`: live re-read; movement id `rrf_{id}` for the
  first tranche, `rrf_{id}_{alreadySent}` after (`:372`); `applyMovement`
  `transfer_out central→dest reason "{dest}_auto_refill"` (counted) or `received`
  (uncounted) (`:404-418`); **partial** = `qty` becomes the remainder and `sentQty`
  accumulates, status stays open (`:465-483`); final tranche writes
  `status:"fulfilled"`, `fulfilledBy`, `resolvedAt`, `cancelReason:null` (`:488-497`).
- Cancel `rejectRequest` `:502-521`: `status:"cancelled"`, `resolvedAt`,
  `rejectedBy`, **no `cancelReason`** (the engine's human-rejection shape).
- Hold lane `holdActive` (`stockHoldCore.js:36-40`): needs
  `/settings/stockHold/config.enabled === true` — live **false**.
- `applyMovement` (`src/components/stock/applyMovement.js:141-309`): idempotent on
  `movementId` (`:183-184` replays without moving), creates the destination cell if
  absent, refuses a negative source unless `allowNegative`.

**Where the home hub per category is resolved.** Nothing resolves "home hub"
explicitly. It is `config.routes` (shop → hub2) plus whether a target exists at
hub2 for the product: clothing rule (`defaultRunByStore.hub2`) only where hub2
carries a cell; category-policy map legs (`categoryPolicy.<key>.hub2`) regardless
of a cell unless `carriedOnly`; explicit `/stock_targets/hub2/{pid}` rows.

## 2. Wrong-store engine fix (PRs #376–#381) — state

PRs #376/#377/#381/#382/#390 were the **refill provenance cutover**; it was fully
reversed by the owner on 2026-08-20 (PR #395 `61f910c7`, engine redeployed from the
pre-cutover source). The live engine is the old **cell-existence** engine, which is
the code at `functions/lib/refill-engine.cjs` on main today. There is no withheld
engine deploy that this change depends on: the build here relies only on what is
live (`storeCarries`, the actionable-only source gate, the lock table). Last live
scan `2026-09-17T14-00` ran (`intents 19, closes 14, errors none`).

## 3. Scope — who routes shop quantities through Hub 2 on Solve today

Live `/config/refillEngine` (scoped keys): `routes = {hub1→central, hub2→central,
marathon-pe→hub2, trophy→hub2}`, `mode` all four `live`, `enabled true`,
`ruleBasedTargets true`, `footwearTargets null` (sneaker targeting OFF — kill
switch position: OFF before this work), `maxUnitsPerIntent 20`, `maxIntentsPerRun
75`, `defaultRunByStore` for hub2 / marathon-pe / trophy (letters S–XXXL),
`subcategoryRunByLocation` = Watches:2 at all three.

`categoryPolicy` legs (live): bags{hub2,trophy}, belts{hub2,trophy,perSize},
caps-beanies{hub2,marathon-pe}, fitted-caps{hub2,marathon-pe,perSize},
gloves{hub2,marathon-pe}, perfumes{hub2,marathon-pe},
soccer-jerseys{hub2,marathon-pe,perSize}, sunglasses{hub2,trophy},
underwear{hub2,marathon-pe,perSize}, slides/sneakers{hub1,hub2 carriedOnly}.
None of the clothing/accessory legs is `carriedOnly`.

**In scope (the Solve is what makes Hub 2 request first):** a card with
`source === "central"`, a nominated shop whose route is hub2 (both Marathon PE
and Trophy), a product that is clothing in the engine's sense (`isClothing`), whose
`categoryKey` has NO unscoped hub2 category-policy leg, and with NO explicit
`/stock_targets/hub2/{pid}` row. For these products Hub 2 has no target until a
Hub 2 cell exists, and the Solve's seed is the only thing that creates one — so
the Solve is the trigger of the hub2←central request and the shop←hub2 cascade.
That is every plain garment (t-shirts, tracksuits, hoodies, shorts, jerseys not in
the soccer map, watches via the subcategory run, and the 45% of clothing with no
subcategory), at either shop.

**Out of scope, unchanged:** the mapped categories above (bags, belts,
caps-beanies, fitted-caps, gloves, perfumes, soccer-jerseys, sunglasses,
underwear) — for them the engine raises hub2←central with **no Solve at all**
(`managedPids` admits a mapped pid unconditionally), so their Solve does not route
anything and stays on the old seed-only path; perfume (mapped, and not clothing);
sneakers (own tab, `footwearTargets` off); "Only in Hub 2" cards (hub-source
Solve); any product with an explicit hub2 row (the engine already manages hub2
for it); the manual "Move manually" transfer.

## 4. The two duplicate questions, with code evidence

**Q1 — can the engine raise hub2←central for this product while the shop request
is open?** For an in-scope product: **no, structurally.** `managedPids("hub2")`
(`refill-engine.cjs:1116-1134`) admits a clothing pid only if `storeCarries(stock,
"hub2", pid)`; a central-stranded card by definition has no hub2 node
(`missingProductsCore.js:127`), the new Solve does not seed hub2, and
`resolveTarget` (`:608`) returns null for hub2 without a cell. The only ways hub2
becomes managed without a cell are a category-policy leg or an explicit row — both
excluded by the scope predicate. Once the deferred step seeds hub2 (at fulfil /
partial / cancel), the engine CAN raise hub2←central on its next scan — which is
why the deferred request must claim the engine's own lock
`/refill_engine/open/hub2/{pid}/{sizeKey}` (create-if-absent, exactly as
`refill-scan.cjs:735-739`): the engine then counts it as inbound (`:672-686`),
never proposes a second, resizes it against Central's real remainder, and closes it
on fulfil. If the engine got there first (a race with a scan between the seed and
the claim), the claim fails and the deferred step records "deferred to the
engine's request" instead of creating one. **Smaller change chosen: detect via
the shared lock, not suppress the engine** — suppression would touch engine
logic (frozen); the lock is the engine's existing idempotency contract and needs
no engine change.

**Q2 — while the shop request is open, does the engine never raise hub2→shop?**
Today it holds by the source gate alone: the shop's deficit needs `srcAvail > 0` at
hub2 (`:1592-1594`) and hub2 has no cell → 0. It STOPS holding in the partial
case the owner requires: after a partial fulfil the shop request stays open, the
deferred hub2 leg is raised, and once Central fulfils it Hub 2 holds stock while
the shop's Central request still has a remainder — the next scan would then see
`deficit = target − have − 0` (a lock-less row is not inbound) and raise hub2→shop.
**Guard needed (smallest):** claim a lock for the shop request too,
`/refill_engine/open/{shop}/{pid}/{sizeKey}` with `source:"central"`, on creation.
Then the request is inbound (`deficit` ≤ 0 → no hub2→shop), reserves Central for
the shop before the hub (`sourceReserved`, `:684-685`), and the engine manages it
with its normal rules (`needGone`, `sourceEmpty` → withdraw as `awaiting_upstream`
when Central runs dry, resize). The engine never CREATES a shop→Central request —
`routes` is unchanged — it only bookkeeps one that exists.

## 5. Where the deferred Hub 2 request runs, and why

The client cannot claim engine locks: live rules give `/refill_engine` `.write:
false` (only `rejectStreak` is open). `/refill_requests/$id` is writable by any
stockRole holder and `/stock/$loc/$pid/$size` accepts the qty-0 seed shape, so the
Solve itself stays client-side (hosting-only for commits 2–3). The deferred leg
and both locks therefore run **server-side** in a new named function
`firstBatchLeg` — a v2 RTDB trigger on `/refill_requests/{requestId}` (same
`instance`/`region` as `holdAvailabilityNotify`, `functions/index.js:552-573`),
which RE-READS the row (never trusts the event payload), exits unless
`createdFrom.firstBatch` is set, claims the shop lock on creation, and on
`status !== "open"` or `sentQty > 0` raises Hub 2's leg once. Idempotency: a
marker `firstBatch.hub2Leg` on the shop request is written in the SAME atomic
update as the hub2 request and lock; the lock claim is create-if-absent; a re-fire
after a crash finds either the marker (done) or its own pending lock (finishes).
No step depends on a browser. Deploy: `firebase deploy --only
functions:firstBatchLeg` after `npm install` in `functions/` (done in this
worktree). Live function list captured before (57 functions).

## 6. Design summary (what commits 2–6 build)

- **Solve (in scope):** per qualifying size: Central has units → seed the SHOP
  cell only + one `/refill_requests` row `{requestingLocation: shop, qty:
  min(shop target, Central free, maxUnitsPerIntent), createdFrom:{firstBatch:true,
  solveId, source:"central", store, hub:"hub2"}}`; Central has none for the size →
  that size follows today's path (seed hub2 + shop, engine takes over when Central
  restocks). All in ONE atomic update; keys by productId; sizes via
  `encodeSizeKey`; ids differ per leg (`solveId` = `fb_{pid}_{serverNowMs}`; the
  hub2 leg's lock `runId` = `first_batch:{solveId}` and its request key is a new
  push id). Panel copy: "N units go to {store} now · Hub 2's M follow after".
- **Source:** `SOURCE_TABS` gains Trophy and Marathon; each mounts the existing
  `RefillQueue` with `dest` = the shop (request rows only, Central supply, the
  same Fulfil / Out of Stock, partial tranches, `rrf_` ids). Hub 2's deferred
  request lands in Hub 2 Refill → Clothing like every engine request.
- **Deferred leg:** seed hub2 cell for that size (seed-if-absent), size
  `qty = min(hub2 target − hub2 on-hand, Central on-hand − open reservations,
  maxUnitsPerIntent)`; `qty ≤ 0` → marker `{none:"central_empty"}` and the seeded
  cell hands the size to the engine; engine lock already held → marker
  `{deferredTo:"engine", refillId}`; Solve undone (`cancelReason:"solve_undone"`)
  → marker `{none:"solve_undone"}`, nothing seeded.
- **Cutover:** rows without `createdFrom.firstBatch` are ignored by the trigger;
  pre-deploy Solves (hub2 + shop seeded, no rows) are untouched by construction.

## 7. Cutover — Solves made before this deploy (commit 6)

A pre-deploy Solve wrote qty-0 seeds at Hub 2 AND the shop and raised no
request; the engine has been managing both legs since. Nothing here touches
that state, by construction:

- The trigger acts only on `/refill_requests` rows with `createdFrom.firstBatch
  === true` (`functions/lib/first-batch.cjs processFirstBatchRequest`); every
  other row — engine, Missing Sneakers, holds, MoveExcess — returns
  `not_first_batch` without a write. Pinned by test.
- A pre-deploy Solve's product is carried at a shop, so it is not a card and
  cannot be Solved again. A hub-stranded card ("Only in Hub 2") still takes the
  old path (`firstBatchEligible` requires `source === "central"`).
- Undo records from before the deploy carry no `firstBatch` field; the undo
  strip runs the old path for them byte-for-byte (the `u.firstBatch` branches
  are the only additions).
- **Deploy order is the one cutover rule:** `functions:firstBatchLeg` FIRST,
  hosting SECOND. A shop request fulfilled while the trigger does not yet exist
  would never receive its Hub 2 leg (triggers fire on writes, not on history).
  With the function live before any client can write a tagged row, every
  tagged row is seen from its first write.
- Rollback: redeploy the previous hosting bundle (`0eeb6669`). Rows already
  tagged keep working — the function is independent of the client — but that
  bundle has NO shop tabs, so an open shop request could only be closed by a
  script or by the engine's own withdrawal. Keep the function deployed and, if
  rolling back, first drain the shop tabs on THIS bundle (open
  `refill_requests` whose `requestingLocation` is a shop), then roll hosting
  back; delete the function last.

## 8. Build and test results (commit 8, this worktree)

- `npm run build`: clean.
- New tests, all green: `functions/test/first-batch.test.cjs` 18/18 (trigger core
  over the fake RTDB + the REAL `computeRefillPlan` over the resulting tree);
  `firstBatchCore.test.js` 19/19; `firstBatchSolve.render.test.jsx` 10/10;
  `firstBatchSourceTab.render.test.jsx` 8/8; `solveUndo*.test.js` updated.
- Mutation proof `scripts/mutation-proof-first-batch.mjs`: **22/22 guards
  proven** (the first run found 2 unprotected — the lock race and the undo's
  own-lock exemption — both now pinned).
- Full vitest: 6364 pass / 10 fail; full functions `node --test`: 2028 pass /
  11 fail. Every failure predates this branch and lives in files it does not
  touch: `hubIsolation.test.js` pins a Hub 2 `hubQty` line that #600 changed on
  main (verified: `origin/main` already carries the `decodedCellKey` form the
  pin rejects), and the Shopify theme / social schedule / social caption tests
  read theme and launchd assets outside this diff. `git diff origin/main
  --name-only` for those subjects is empty.

## 9. Review round 1 (PR #607) — what was found and what changed

Provenance: CodeRabbit (in progress at the time of writing), a Sonnet
senior-architect pass, a Fable-vs-spec pass, and — Kimi being out on its
monthly quota (403) and Codex excluded by the spec — the standing substitute:
a seeded property fuzz over 600 random worlds through the REAL trigger core and
the REAL `computeRefillPlan` (`functions/test/first-batch-fuzz.test.cjs`), plus
a second adversarial architect pass.

Fixed at the cause:
- **Seed overwrite (Sonnet, HIGH):** the Hub 2 seed was a blind `set` from a
  stale "no cell" read; a real quantity landing meanwhile would have been
  zeroed. Now `seedIfAbsent`, a create-if-absent transaction, in every branch.
- **Marker before seed (Sonnet, HIGH):** three branches wrote the "done" marker
  first; a crash between the writes stranded the size. Now the seed lands
  first in every branch, and the marker only after.
- **Own pending lock counted as a reservation (crash-recovery test):** a
  re-fire after a crash read its own pending Hub 2 lock as Central being fully
  reserved, recorded `central_empty`, and never raised the leg.
  `centralReservations` now skips this solve's own run id.
- **Undo raced a fulfil (Fable-vs-spec, MEDIUM):** the undo cancelled the
  shop's requests with a blind patch; a fulfil landing in the gap would have
  marked a moved batch `solve_undone` and Hub 2 would never get its leg. The
  cancel is now a CAS (`firstBatchUndoCancelTxn`): a row Central got to first
  stands, and its cell is kept by `undoCellTxn`.
- **Central's "Out of Stock" taught the engine a shop-level "no" (Fable-vs-spec,
  MEDIUM):** a human cancel with no `cancelReason` is, to the engine, a
  rejection at the shop's cell with a 24h retry and a streak — throttling the
  shop's ordinary hub2→shop refill for a "no" about Central's shelf. The trigger
  now stamps `cancelReason: first_batch_central_declined` in the same write as
  the leg it raises; the engine treats the row as a withdrawal, and Hub 2's
  own leg carries the real question to Central (a "no" there learns at Hub 2's
  cell as always). Pinned against the real engine's `closes`/`retryOps`.
- **Empty tab icons (Fable-vs-spec, HIGH/UI):** `SOURCE_TAB_ICON` had no
  glyph for the two shop tabs on the desktop rail. Added.
- Copy: the Solve panel now says the batch is picked "at the next release"
  (requests are release-window gated like every row) and names the Source tab
  as it is labelled ("Source › Marathon").

Fuzz finding kept as an invariant, not a bug: when Central runs dry with the
shop's Central request still open, the engine withdraws that request
(`awaiting_upstream`) and — in the same plan, with the lock closed — may serve
the shop from Hub 2 if Hub 2 holds stock. That is the normal route taking over
and is what the owner asked for; the fuzz asserts "never both live at once".

Noted, not changed:
- `firstBatchLeg` fires on every write to every `/refill_requests` row (the
  engine's own writes included); each untagged fire is one scoped read and an
  early return.
- The hold lane (`/settings/stockHold/config.enabled`, live false) would park a
  Central→shop fulfil under a shipment keyed by the shop; the release card was
  built for hub destinations. Flag before that lane is ever switched on.
- `product_missing` / `no_hub2_target` markers are terminal for that row (the
  size was not a qualifying size at Solve time in either case).

## 10. Review round 2 — the adversarial architect pass (the Kimi substitute's second half)

Fixed at the cause, each pinned by a test and a mutation:
- **Hub 2's target resolved over a Hub 2-only stock view (HIGH):** the
  per-size category rule asks for units ANYWHERE; with only Hub 2's seed in
  view it answered 0 — a dead size — and the marker was terminal. The view now
  carries Central's cell and the shop's row too (one more scoped read).
- **`no_hub2_target` was terminal with no way back (HIGH):** the kill switch
  off at the moment of fulfil, or a deactivated product, would strand the leg
  forever. The seed now lands on that branch (and on `engine_off`), so Hub 2
  carries the size and the engine raises hub2←central itself when a target
  returns — the same "let the engine take over" as `central_empty`.
- **A lost shop-lock claim was recorded as done and never retried (HIGH):**
  Solve → undo → re-solve left the undone solve's lock in place (clients
  cannot write `/refill_engine`), so the new request lost the claim and would
  have run unguarded once the scan closed the stale lock. The short-circuit now
  keys on `claimedAt` only, and a stale first-batch lock whose request is no
  longer open is taken over by CAS on its refillId. An engine-held lock is
  never touched.
- **Engine switches ignored (MEDIUM):** with `enabled !== true` or Hub 2 not
  `live`, a real lock and request would have been written that nothing
  reconciles. Seed only, marker `engine_off`.
- **Array-coerced rows (LOW):** a null hole read as "cell present"; `== null`.
- Undo blocker wording distinguishes an engine withdrawal from Central's
  answer.

Accepted, documented: the engine may RESIZE the shop's Central request (up to
the shop's own policy target, never above) and may withdraw it when Central
runs dry — the ordinary bookkeeping of a locked request. The residual of a
crash between the pending lock claim and the atomic update is that the pending
lock reserves Central for up to an hour before the engine's self-heal.

## 11. Review round 2b — Sonnet on the round-1 delta

One open finding, closed at the writer: the decline stamp was written by the
trigger AFTER Source's bare cancel, so a scan landing in that window (trigger
latency, normally sub-second) would still have read a human rejection at the
shop's cell. Source's Out of Stock now stamps `first_batch_central_declined`
in the SAME write as the cancel for a first-batch SHOP leg
(`isFirstBatchShopLeg`); Hub 2's own leg keeps the human shape; the trigger's
stamp remains as the backstop for any other cancel writer. Pinned by a render
test on the queue and a mutation. The undo strip's partial-abort path (a
request Central got to first "stands") now has a rendered test too.
