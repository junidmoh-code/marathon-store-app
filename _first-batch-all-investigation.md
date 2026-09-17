# First batch — every category except sneakers and slides (investigation, read-only, 2026-09-17)

Branch `feat/first-batch-all-categories`, off `main` `effa6335` (PR #607, live: hosting
`effa6335.1789661080312`, function `firstBatchLeg` deployed, 58 functions). Every fact below
was read from the code at that commit or from live RTDB with paged / scoped reads
(`scripts/audit/first-batch-all-census.mjs`, snapshot 2026-09-17T18:16Z, report under `var/`).

## 1. Why PR #607 excluded mapped categories, and what those categories do today

`firstBatchEligible` (`src/components/stock/firstBatchCore.js:70-82`) required, besides
`source === "central"` and `routes[store] === "hub2"`: `isClothing(product)`, NO unscoped Hub 2
category-policy leg, and NO explicit `/stock_targets/hub2/{pid}` row. The reason was #607's
anti-duplication argument for Hub 2: "the engine cannot raise hub2←central while the shop
request is open because Hub 2 has no cell and is therefore not managed". That argument only
holds for the clothing RULE, whose target needs `storeCarries` (`refill-engine.cjs:608`).

For a **mapped category** the engine manages Hub 2 with NO cell at all: `managedPids`
(`refill-engine.cjs:1113-1134`) admits a pid the moment `categoryPolicyEntry` resolves,
`resolveTarget` answers the map before the carriage-gated branches (`:526-560`), and the
deficit loop's class filter passes it (`:1432-1433`). Same for an **explicit row** (`targets[dest]`
keys are added unconditionally, `:1117`). So for these products the engine raises hub2←central
by itself — with no Solve — and #607 simply left their Solve on the old seed-only path.

Live map legs (`/config/refillEngine/categoryPolicy`, read 18:16Z):

| key | Hub 2 leg | shop leg | mode |
|---|---|---|---|
| bags | 4 | trophy 2 | one-size |
| belts | 5 | trophy 1 | perSize |
| caps-beanies | 10 | marathon-pe 5 | one-size |
| fitted-caps | 5 | marathon-pe 2 | perSize |
| gloves | 50 | marathon-pe 30 | one-size |
| perfumes | 10 | marathon-pe 8 | one-size |
| soccer-jerseys | per-size map | marathon-pe per-size map | perSize |
| sunglasses | 5 | trophy 5 | one-size |
| underwear | per-size map | marathon-pe per-size map | perSize |
| sneakers, slides | per-size map, **carriedOnly**, hub1 + hub2 | none | perSize |

None of the clothing/accessory legs is `carriedOnly`; `policyGroups.footwear-all` is disarmed.
Explicit rows: 7,797 hand-made (`project_explicit_rows_are_truth`); exactly **1** Central-stranded
card carries an explicit Hub 2 row today (a suit).

**What the widening changes for them:** the Solve creates the SHOP's Central request (policy
qty) and seeds the shop only; Hub 2's leg still comes from the trigger at fulfil. Because the
engine may hold — or raise — its own hub2←central lock for a mapped product regardless of the
seed, the duplicate guard is the engine's own lock, read by the trigger before it raises
(`functions/lib/first-batch.cjs` `held && held.runId !== runId` → `deferredTo: engine`) and
counted by the engine as inbound when ours lands first (`refill-engine.cjs:672-686`). That
guard exists since #607; the new categories are the first to exercise its "engine got there
first" branch in production (one live card, caps-beanies, has an open engine Hub 2 lock now).

## 2. How sneakers and slides are identified — the exact exclusion

The engine resolves policy through `policyCategoryKey` (`refill-engine.cjs:443-448`): the
assigned `categoryKey` (trimmed) wins; a keyless record whose legacy pair is category
`"Footwear"` + subcategory `"Sneakers"` is `"sneakers"`; anything else has no key. The app's
mirror is `effectiveCategoryKey` (`src/utils/productTaxonomy.js:342-346`), pinned equal by
`functions/test/policy-category-key.test.cjs`. Slides are the key `"slides"` (taxonomy legacy
pair `Footwear` + `"Sandals & Slides"`, `productTaxonomy.js:99`); no keyless slide is admitted
to the sneakers key. The exclusion is therefore **exactly**: effective key `"sneakers"` or
`"slides"`, plus the keyless legacy pair for either leaf. Nothing else is excluded by the
predicate (`isSneakerOrSlide`, commit 2).

**The tab's own gate.** Missing Products admits `isClothing(p) || isPerfume(p)`
(`missingProductsCore.js:118`). That gate excludes the whole footwear group (correct — those
cards live on Missing Sneakers, `missingFootwearCore.js:33` `category === "Footwear"`) but ALSO
excludes any non-footwear record that is neither clothing-typed nor a perfume: today that is
one live card (a suit jacket mis-typed `productType: "sneaker"`, 8 units, invisible on both
tabs) and, structurally, the typeless categories (`iphone`, a keyless typeless record). Under
"no other category may be excluded" the gate becomes the complement of the engine's own
footwear-group predicate (`refill-engine.cjs:2108-2115`: not clothing AND (category Footwear
OR key in the footwear group)). Live effect: +1 card (the suit; greyed — no policy), chips
otherwise identical (263 → 264).

**The other six footwear keys** (boots, soccer-boots, loafers, running-shoes, kids-shoes,
designer-shoes) stay on Missing Sneakers by evidence, not by predicate: the live map gives
none of them a shop leg (`policyGroups.footwear-all` is disarmed), no product under them is
routed shop←hub2 (1 soccer-boot unit at PE, 2 designer-shoe lines at Trophy, nothing else),
and the census finds **0** Central-stranded cards under any of them. Under §4's rule they
would be greyed "no policy" on this tab, so admitting them would add nothing but noise; the
first-batch predicate itself excludes only `sneakers` and `slides`. Every live footwear-keyed
record also carries the legacy `category: "Footwear"` (0 exceptions in the snapshot), so no
record sits on neither tab.

## 3. Location history — what exists, what is readable scoped, and the decision

Census over the 329 live Central-stranded cards (`var/first-batch-all-census-…md`):

| source | what it records | scoped read? | usable |
|---|---|---|---|
| `/stock/{loc}/{pid}` cells | where a product sits NOW; a qty-0 cell = sent before and sold out (cells are never deleted, `refill-engine.cjs:215-222`) | yes — and HealthView already holds `/stock` whole for this screen (`HealthView.jsx:393`) | **yes, zero new reads** |
| `/stock_targets/{loc}/{pid}` | a human seated the product there (7,797 hand-made rows) | yes — already held by HealthView | **yes** |
| style-code siblings (`styleCodeNormalised` on the record; `/style_code_index/{code}/siblings`) | colourway siblings | yes (the stamp is on the record the client holds) | **yes, but nearly empty for clothing**: 55/329 cards carry a code, 4 have a sibling, 3 have one at a shop — all sneakers/slides |
| `/products/{pid}/alternatives` | similarity neighbours, sneakers only (1,382) | yes | no — not siblings, and sneakers are out |
| `/stock_movements` | every transfer, incl. `{shop}_auto_refill` and dispatches | **no**: live `.indexOn` is `["ts"]` only; a per-product query would download the node (banned) | no |
| `/refill_requests` (26,819 rows; fulfilled shop rows PE 6,547 / Trophy 1,868) | past shop requests | **no**: `.indexOn` `["createdAt","resolvedAt"]` only | no |
| category placement | where the category's products are kept today (cells at each shop) | derived from the two nodes above, in memory | **yes — the strongest signal** |

The category prior, live: bags PE 97 / Trophy 356; caps-beanies 295 / 0; soccer-jerseys 189 / 0;
fitted-caps 123 / 0; underwear 37 / 0; suits 0 / 49; watches 1 / 44; ladies-tracksuits 2 / 37;
shirts 3 / 33; belts 2 / 21; sunglasses 0 / 21; dresses 0 / 14; t-shirts 457 / 23; pants 243 / 30;
tracksuits 176 / 88; hoodies 70 / 61; golf-t-shirts 100 / 36; jackets 49 / 26; perfumes 64 / 1.

**Decision — which shop.** The Solve's default nomination (`NetworkTransfer.jsx:417`
`defaultStoreFor`, today "the first store with qualifying sizes") becomes history-ranked among
the stores with qualifying sizes: (1) the product's own positive explicit row at a shop;
(2) a style-code sibling carried at a shop (more sibling cells wins, units break ties);
(3) the category prior — the shop carrying more of the product's category (cells, any qty).
No signal, or a tie → today's default, unchanged. The panel prints the reason in one line
("Trophy — where 356 of 453 bags are kept"). The operator can still tap the other shop; nothing
is typed. Sizes, quantities and requests are keyed by productId only — the history score is
a default, never an identity, and duplicate-name twins are never grouped by name.

**Decision — the shop / Hub 2 split.** It is fixed by the two policies and Central's count and
history cannot durably move it: the shop's request is `min(shop target, Central free, cap)`
now, Hub 2's leg `min(hub2 target − on hand, Central remainder, cap)` after. The engine's own
reconcile (`refill-engine.cjs:905-935`: `desired = min(target − have − otherInbound, cap)`,
`availForMe`, `expected`) grows every locked open request to exactly that number on the next
scan, so a history-shrunk first batch would be resized up within 15 minutes — and the brief
requires the request to be right AS CREATED (store-leg resizes are the known silent-failure
path). Policies are the owner's and stay as they are. What history DOES fix about the split is
Central's "free": units the engine has already promised out of Central for the same
product/size (an open hub2←central lock for a mapped product, a sibling shop's first-batch
lock) are subtracted before the shop's quantity is sized (commit 4), so the created request
never books a unit twice.

Not built, and why: a movement-ledger signal ("sent before" for the product itself) needs
`/stock_movements` `.indexOn` to include `productId` — console-managed rule, printed in §7 for
the record; the cell map already carries "sent before" for every sibling and the category, so
nothing here waits on it.

## 4. Policies per in-scope category (does each have a shop AND a Hub 2 policy?)

Asked of the REAL `resolveTarget` over each card with a hypothetical seed at the destination:

- **Every clothing-run category** (t-shirts 105 cards, pants 61, hoodies 42, golf-t-shirts 26,
  tracksuits 10, jackets 5, shorts 4, watches 6 via the subcategory run, keyless 1): Hub 2 AND
  both shops — `default` / `subcategory_default`.
- **Mapped categories**: Hub 2 by the map; the mapped shop by the map; the OTHER shop by the
  letter run where the product is sized and clothing-typed (belts, fitted-caps, soccer-jerseys,
  underwear), or nothing where the product is one-size (bags, caps-beanies, gloves, perfumes,
  sunglasses → that shop simply has no qualifying sizes and cannot be nominated). One live card
  today (caps-beanies): Hub 2 `category_policy`, PE `category_policy`.
- **Explicit-row product** (the suit): Hub 2 `explicit`, Trophy `explicit`, PE `default`.
- **No policy anywhere — reported, NOT armed** (the Solve stays greyed with its existing
  sentence; nothing invents a number): `chains-bracelets` (2 cards, 10 units — no map leg, no
  rows, one-size); `p1787388957279` t-shirt "GLFS T1013" (3 non-run sizes); `p1787931171527`
  suit jacket FF1070 (`productType: "sneaker"` — the clothing rule refuses; a data fix).
- Sneakers 59 / slides 5 cards: Hub 2 by the carriedOnly map, no shop policy — out by rule.

## 5. Duplicate check for the newly included categories

1. **hub2←central twice?** No. Whoever locks `refill_engine/open/hub2/{pid}/{sizeKey}` first
   wins: the engine (`refill-scan.cjs:735-739`, create-if-absent) or the trigger (same
   transaction shape). The trigger records `deferredTo` when it loses; the engine counts our
   lock as inbound (`refill-engine.cjs:672-686`) and proposes nothing (`:1429`). Pinned by the
   existing tests and exercised for mapped / explicit-row products in commit 5.
2. **hub2→shop while the shop's Central request is open?** The shop lock (claimed at creation)
   is inbound; with the request sized `min(target, Central free, cap)` the deficit is ≤ 0
   whenever Central covered the target. For a mapped category the engine can fulfil ITS OWN
   hub2 request while the shop's is still open, so Hub 2 may hold stock earlier than in #607;
   the engine then serves only a REMAINDER the Central request could not cover (Central short
   at Solve time): total live inbound to the shop never exceeds the target, and no unit is
   asked for twice. Fuzz invariant in commit 5.
3. **Central double-booked at Solve time?** Yes, possible before this work: the Solve sized the
   shop's request from Central's raw cell, ignoring an engine lock already reserving those
   units (live now for the caps-beanies card: 1 unit, 1 engine lock). Commit 4 nets open
   Central reservations out; the trigger already does the same for Hub 2's leg
   (`centralReservations`).
4. **Map legs after the first batch**: unchanged — the shop's cell exists once Central fulfils,
   the engine refills it from Hub 2 by the map (`routes` untouched), Hub 2 from Central.
5. **The engine already holding the SHOP's lock at Solve time** (a mapped shop leg is managed
   with no cell): unreachable for a stranded card — the engine only raises hub2→shop when
   Hub 2 can supply (`srcAvail > 0`, `:1592-1594`), and a Central-stranded card has no Hub 2
   node; live: 0 open shop locks over 329 cards. If it ever happens, `claimShopLock` loses,
   records `heldBy`, never writes `claimedAt`, and retries on every later write; the engine's
   lock is never touched (pinned in `first-batch-categories.test.cjs`).

## 6. Kill switches / live state (before)

`enabled true`, `ruleBasedTargets true`, `footwearTargets` absent (= OFF), `maxUnitsPerIntent 20`,
`maxIntentsPerRun 75`, modes all `live`, last scan `2026-09-17T17-00` (intents 0, closes 0).
`/refill_requests` rows tagged `firstBatch`: **0** — no Solve has used the #607 path yet. Open
rows by location: PE 113, hub1 24, hub2 132, trophy 112. Live functions: 58 (captured to the
scratchpad before deploy).

## 7. Rules

Nothing in this build needs a rule: the Solve writes `/refill_requests` rows and qty-0 seeds
exactly as #607 does; the trigger writes with the Admin SDK. For the record, the ONE rule that
would enable a future per-product movement-history signal (NOT required, NOT relied on):

```json
"stock_movements": { ".indexOn": ["ts", "productId"] }
```

## 8. Build plan (commits 2–6)

- **2 — widen**: `firstBatchEligible` = Central-stranded + shop routed via Hub 2 + not
  sneakers/slides (`isSneakerOrSlide`); the tab admits everything outside the footwear group.
  Mapped and explicit-row products keep their own policies through `resolvedRun` (unchanged);
  the trigger needs no category logic (it already resolves through the real `resolveTarget`
  with Central's and the shop's cells in view).
- **3 — history**: `firstBatchHistory` / `firstBatchStoreChoice` (pure), the default
  nomination and its reason line.
- **4 — guard**: Central free nets out open Central reservations at Solve time.
- **5 — tests** (real functions, numbers not titles) + mutation proof; **6** build + suite.

## 9. Addendum from the build (commit 5) — the hub2→shop guard is structural

§5(2) above expected the engine to serve a REMAINDER from Hub 2 while the shop's
Central request is open when Central was short at Solve time. Driving the real
`computeRefillPlan` shows it does not: the deficit loop skips any cell with inbound at
all (`refill-engine.cjs:1519` `if (inb > 0) continue;`), whatever the lock's quantity.
So while the shop's first-batch request is open — and locked, which the trigger does on
creation — the engine raises NO hub2→shop for that cell, for every category, at any
quantity. The remainder comes from Hub 2 only after the shop's request has closed
(`functions/test/first-batch-categories.test.cjs`, "Central was short at Solve time").
The mapped-category fuzz (`first-batch-world.cjs`, a third of 600 worlds are bags /
belts maps, with the engine sometimes holding Hub 2's lock first) holds the same
invariants as #607's: at most one Hub 2 request of ours, none beside the engine's,
re-fires change nothing, and never a shop intent beside an open shop lock unless the
engine withdrew it because Central ran dry.

## 10. Build and test results (commit 6, this worktree)

- `npm run build`: clean (`index-BgTxYacs.js`).
- New / changed tests, all green: `functions/test/first-batch-categories.test.cjs` 13/13
  (real trigger core + real `computeRefillPlan` over mapped, explicit-row, perfume and
  one-size products); `first-batch.test.cjs` 26/26 unchanged (PR #607 behaviour for plain
  clothing); `first-batch-fuzz.test.cjs` 600 worlds, a third mapped, all invariants;
  `firstBatchCore.test.js` 40/40; `firstBatchSolve.render.test.jsx` 21/21;
  `missingProductsCore.test.js` 35/35; `solveUndo.gate.test.js` re-pinned for both write
  paths.
- Mutation proof `scripts/mutation-proof-first-batch.mjs`: **55/55 guards proven** (the two
  #607 mutations that pinned the exclusions this change removes were deleted; 20 new).
- Full vitest: 6395 pass / 10 fail; full functions `node --test`: 2051 pass / 11 fail.
  Every failure predates this branch and lives in subjects it does not touch —
  `git diff origin/main --name-only` over them is empty: `hubIsolation.test.js` (pins an
  `App.jsx` line #600 changed on main), `scripts/shopify/{homeRails,priceHearts,themeStrings}`,
  `scripts/social/socialSchedule`, `functions/test/social-{select,caption}` (theme and
  launchd assets outside this diff). Identical to the list recorded for PR #607.
- "PR #607 behaviour for plain clothing unchanged" means the SERVER leg and the write shape:
  `first-batch.test.cjs` and the #607 render tests pass untouched. The client's default shop
  nomination (history) and Central's free (reservations netted) changed for plain clothing
  by design — a shirt now defaults to Trophy (33 of 36 lines) where #607 defaulted to PE.
- Kill switches re-read after the build: unchanged (`ruleBasedTargets true`,
  `footwearTargets` absent = sneakers OFF).

## 11. Review round (PR #608) — provenance and what changed

CodeRabbit (see the PR), a Sonnet senior-architect pass, a Fable-vs-spec pass, and — Kimi
being out on its monthly quota (`403` on a two-word prompt, 2026-09-17) and Codex excluded by
the brief — the standing substitute: an adversarial Opus pass that constructed inputs and ran
the real functions, plus the mapped-category property fuzz (600 worlds).

Fixed at the cause, each pinned by a test and a mutation:
- **Dead locks counted as Central reservations** (Sonnet LOW, Opus MEDIUM-HIGH): an undone
  solve's lock (the undo cannot touch `/refill_engine`) or a fulfilled sibling's lock (Central's
  cell already decremented) reserved Central until the next scan, so a re-solve asked Central
  for 1 where the policy said 2 and Central held 3. `pruneClosedLocks`: one scoped read per
  lock's request; gone / fulfilled / cancelled → not a reservation.
- **Per-location SIZE MAPS invisible to the client mirror** (Opus MEDIUM): `soccer-jerseys` and
  `underwear` are live as `{ sizes: { S: {target…} } }` per location; `categoryRun` read only
  `entry.target`, so their Solve stayed greyed (0 live cards today, both categories stocked).
  Mirrored from `locationPolicyFor` (perSize only, usable row, dead-size 0), pinned by a
  size-by-size differential against the real `resolveTarget`.
- **A clothing-typed record with a sneakers/slides key fell to the seed-Hub 2 path** (Opus LOW,
  unreachable today — 0 such records): the Hub 2 seed would arm its carriedOnly policy. Solve
  is now blocked for it with a sentence; nothing is written.
- **Lock-key encoder mismatch for padded/blank sizes** (Opus LOW, unreachable): `lockKeyFor`
  trims and maps blank → "_" like the engine's encoder.
- **Vacuous assertion** (Fable MEDIUM): the bag test asserted the PE chip was absent after the
  confirm, when the result view had replaced the chips. Now: the chip is offered, its confirm is
  blocked with the no-policy sentence, nothing is written.
- **History line vs the operator's tap** (Fable MEDIUM): after tapping the other shop the line
  reads "Trophy was suggested — …; You chose Marathon PE."
- **History counted retired / merged records** (Opus LOW): the index skips them; the sentence
  says "lines", not units.
- Stale comments (`first-batch.cjs` header, `solvePlan.js` "cards list applies isClothing")
  corrected; §2, §5 and §10 amended (six footwear keys by evidence; the engine-held shop lock
  branch; mutation count; what "unchanged for plain clothing" means).

Noted, not changed: the shop / Hub 2 split remains policy-fixed (§3) — the engine's reconcile
makes any other split self-undoing; the owner's two bullets ("use policies as they are" and
"history informs the split") are reconciled in favour of the first, stated plainly in the PR
and the final report. Newly admitted typeless cards land in the Clothing chip (cosmetic). An
armed policy GROUP is not mirrored by `categoryRun` (none armed live).
