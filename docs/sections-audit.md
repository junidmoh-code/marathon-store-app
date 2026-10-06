# Sections audit — Central + two sections, one registry

Audit only; no behaviour change. Taken at store-app `7db4d910` and POS `05ad595`
(2026-10-01). Line numbers come from `grep -n` on those commits.

This file has a summary (sections 1–7) followed by four appendices, one per
swept area, each a full `file:line | what it does | change needed` inventory:

- Appendix A — store app `src/components/stock/**`, `src/print/**`
- Appendix B — store app, everything else under `src/`
- Appendix C — `functions/**` in both repos
- Appendix D — POS `src/**`

## 1. Target model

| id | name | type | section | live at ship |
|---|---|---|---|---|
| `central` | Central | central | — (supplies both) | true |
| `marathon-pine` | Marathon Pine | store | 1 | false |
| `concrete` | Concrete (2 tills) | store | 1 | false |
| `hub3` | Hub 3 | hub | 1 | false |
| `concrete-stockroom` | Concrete Stockroom | hub (serves Concrete only) | 1 | false |
| `marathon-pe` | Marathon PE | store | 2 | true |
| `trophy` | Trophy | store | 2 | true |
| `hub1` | Hub 1 | hub (sneakers) | 2 | true |
| `hub2` | Hub 2 | hub (shoes, clothing) | 2 | true |

Back stock per store per category: PE and Trophy as today; Pine → Hub 3 for
every category; Concrete → Hub 3 by default, any category switchable to
Concrete Stockroom from the settings card, with an optional per-product
override.

## 2. What already exists in live data (read 2026-10-01, keys/small nodes only)

- `/locations` holds `central`, `hub1`, `hub2`, `hub3`, `marathon-pe`,
  `marathon-pine`, `trophy`, `in_transit`, and the deactivated `studio` and
  `base`. No `concrete`, no `concrete-stockroom`.
- `/stock/hub3` and `/stock/marathon-pine` both already hold product rows. Nothing
  under `/stock/concrete` or `/stock/concrete-stockroom`.
- `/config/refillEngine/routes` = `{hub1: central, hub2: central,
  marathon-pe: hub2, trophy: hub2}` and `/config/refillEngine/mode` marks the
  same four `live`. Pine and Hub 3 are in neither, so the engine does not
  route to them today.
- `/config/refillEngine/defaultRunByStore`, `footwearRunByLocation` and
  `subcategoryRunByLocation` have entries only for Section 2 locations.
- `/config/cardTerminals` has six terminals; one is labelled "Pine Till 1".
  None for Concrete.
- `/pos_meta` holds five global counters (sale, layby,
  refund, exchange, no-receipt return). `/orderCounter` and `/refillCounter`
  are single global daily counters.
- `/push_hub_audience` already has `hub1`, `hub2`, `hub3`.

## 3. Vocabularies the registry must resolve

| vocabulary | examples | where |
|---|---|---|
| canonical location id | `marathon-pe`, `trophy`, `marathon-pine`, `hub1..3`, `central` | `/locations`, `/stock`, `orders.destShop` |
| POS short store id | `pe`, `pine`, `trophy` | POS `src/shared/stores.js`, `card_batches`, `pos/cashups` |
| routing universe | `central`, `pine` | store app `src/utils/stores.js` |
| insights keys | `pe`, `trophy`, `pine`, `other` | `rollupCodec` (client + functions copy) |
| display names | "Marathon", "Marathon PE", "Hub 2", "Pine" | about 12 private label maps |
| retired trial hub | `hubC` | `App.jsx:870`, `order-push.cjs`, `deepLink.js` |

The registry holds one canonical id per location plus every alias above;
every read resolves through it. No historic record is rewritten.

## 4. Structural findings that shape the build

1. **Every human stock move is a client write.** The store app funnels them
   through `applyMovement` (`src/components/stock/applyMovement.js:143`); the
   POS funnels them through `toStockIntents`
   (`src/stock/saleStockMovements.js:302-425`). No callable moves stock
   between locations. The server-side wall for these is therefore an RTDB
   rule on `/stock_movements` and `/transfers` reading the registry, printed
   for the console, with the same check in both client chokepoints.
2. **Transit hides the destination.** A cross-building send writes
   `to = in_transit` (`Transfer.jsx:440`); the wall must be checked at
   dispatch against the real destination and again on the `/transfers` doc.
3. **Engine routing is one source per destination, category-blind**
   (`refill-engine.cjs:680-687`, `:1611`). The per-store per-category
   back-stock mapping generalises that lookup.
4. **The scan reads a whole `stock/{loc}` per routed location per run**
   (`refill-scan.cjs:523-541`). Filtering the location list on `live` keeps
   non-live locations out of routing and out of the read bill.
5. **`hub3` is used as a synonym for Pine** in five places (Appendix B §8.2).
   All break once Hub 3 also serves Concrete.
6. **About 15 defaults fall back to Section 2** (`|| "hub2"`, `|| "hub1"`,
   `shopUniverse()` → `central`). Each would silently route an unmapped
   Section 1 record into Section 2.
7. **First batch is hard-wired to Hub 2** in a client/server twin pinned
   equal by test (`firstBatchCore.js:64`, `first-batch.cjs:52`).
8. **Footwear policy drift assumes exactly Hub 1 + Hub 2**
   (`policy-resolve.cjs:186, 240-252`).
9. **POS store/till selection is browser localStorage**, and
   `posAccess.storeIds` only filters pickers. Empty or missing means all
   stores, and RTDB drops empty arrays, so a section scope cannot reuse
   "empty = all".
10. **POS numbering is global** with no store in the format
    (`receiptNumber.js:74`, `numberBlocks.js`).
11. **Credit spend has no server check**, and the customer mirror the till
    spends against carries no store. Phone-issued credit has no store at all.
12. **The offline mirror has a closed location list**
    (`src/offline/locationIds.js:41-44`); rows for unknown ids are skipped.

## 5. Write paths where the section wall must be enforced

Rule = RTDB rule (printed, console-pasted). Fn = Cloud Function check.
Client = check in the shared writer, so the UI fails early with a clear
message.

| # | path | where | enforcement |
|---|---|---|---|
| 1 | every store-app stock move (`applyMovement`) | `applyMovement.js:143` | Rule on `/stock_movements` + Client |
| 2 | transit dispatch and receive | `Transfer.jsx:355, 440`, `InTransit.jsx`, `/transfers` | Rule on `/transfers` + Client at dispatch |
| 3 | manual transfer screens | `Transfer.jsx:355`, `NetworkTransfer.jsx:668`, `NoTargetQueue.jsx:348`, `CountedStockReview.jsx:177`, `seatingStore.js:345/382` | via #1; pickers filtered to the section + Central |
| 4 | Source queue fulfil (pick location is any warehouse) | `RefillQueue.jsx:629` | via #1; picker filtered |
| 5 | Clothing Sold refill (user-chosen source) | `App.jsx:1651`, picker `15865-15870` | via #1; picker filtered |
| 6 | order dispatch, CR fulfil and undo | `App.jsx:12669-12745`, `1709-1761`, `13077-13206` | via #1; `|| "hub2"` defaults replaced by the mapping |
| 7 | order and refill request placement | `App.jsx:10663-10975`, `12404-12436` | Rule on `/orders` and `/refill_requests` hub/shop pair + Client |
| 8 | display-pair request (hub ↔ store) | `displayRequestStore.js:113` | via #7 |
| 9 | Solve and first batch (client half) | `solvePlan.js`, `firstBatchCore.js`, `NetworkTransfer.jsx` | via #1 and #7; plan built from the mapping |
| 10 | Move Excess, excess hub → Central | `MoveExcess.jsx`, `ExcessHubToCentral.jsx` | via #1; deficit pool split per section |
| 11 | engine intents and shadow sync | `refill-engine.cjs:1609`, `refill-scan.cjs:816`, `371-425` | Fn |
| 12 | first-batch hub leg | `first-batch.cjs:240-537` | Fn |
| 13 | stranded-transit release | `transit-sweep.cjs:266-274` | Fn |
| 14 | POS sale deduction, incl. sneaker hub choice | `saleStockMovements.js:302-425`, `saleRouting.js:116-136` | Rule on `/stock_movements` + Client |
| 15 | POS returns, exchanges, void, refund, no-receipt return | `returnRouting.js:200-225`, `returnPicker.js:163` | via #14 |
| 16 | POS layby cancel restock and layby pulls | `engine.js:1541-1560`, `requestLaybyPull` | via #14; pull checked against the layby's origin section |

Single-location writes (receive, adjustment, refusal write-off, product
merge) cross nothing and need no wall; they do need the `live` filter where
they enumerate locations.

## 6. Known open defects and how this work touches them

Not fixed here unless they block; none may be made worse.

| defect | where | interaction |
|---|---|---|
| name-keyed source queue collisions | `sourceGroupKey` name fallback and legacy name dual-reads (`refillQueueCore.js`, `sourceMovementDedupe.js`, `sourceResponseWrites.js`, `RefillQueue.jsx:773`); movement-id seed has no destination term; shadow key `SHDWrr-{pid}-{size}` has no dest (`refill-scan.cjs:387`) | **Interacts.** A second section's hub asking Central for the same product, size and day can collide. Section 1 stays non-live, so no new rows are raised until a flip; the keys need a destination term before the first flip. |
| store-leg refill resize failures | `refill-scan.cjs:189-240`, `refill-engine.cjs:751-800, 966-1008`; recycled `R###-n` ids | **Interacts.** More store legs mean more id reuse. Unchanged while Section 1 is non-live. |
| refill requests not clearing after manual transfer | `Transfer.jsx:482` (only closes when `refillId` is set, and the UI never sets it); `satisfiedClosures` `refill-engine.cjs:1011-1145` | **Interacts.** A request left open after a manual move could later be fulfilled from a source the wall now forbids; the wall refuses the move, the stale request remains. |
| layby cancel restocking to the wrong location | POS `engine.js:1541-1560` + `returnRouting.js`; never reads the parcel's `storageHub`; five `"hub1"` defaults | **Interacts.** A wrong restock location could be in the other section. The wall refuses a cross-section restock; the choice of location within the section is unchanged. |

## 7. Order of work

1. This audit.
2. Registry node, resolver (client, functions, POS copies pinned equal by
   test), seed, owner-only settings card.
3. Section 2 before/after routing snapshot tests.
4. Section wall: both client chokepoints, the three function paths, printed
   rules.
5. Refill engine and health scan read the mapping and the `live` flag.
6. Solve screen and first-batch-direct, generalised from the Hub 2 path.
7. Hub policies for Hub 3 and Concrete Stockroom; drift check generalised.
8. Excess back to Central per section.
9. Missing products.
10. Store tabs and order screens.
11. Central dispatch cost recording.
12. Credit, layby and owed stamping; `creditScope`.
13. Card recon and cash-up, including Concrete's two tills.
14. Reports per store and section; owner combined view.
15. Numbering.
16. Section-scoped staff access and hub-scoped notifications.
17. POS store and till selection.

## 8. Decisions taken in the audit

- New ids: `concrete` (store) and `concrete-stockroom` (hub). POS short id
  for Concrete is `concrete`.
- Lists that keep Pine and Hub 3 out by earlier owner decision (online
  availability, stock audit, refusal write-off, display rows and checks)
  stay as they are. The registry makes them data-driven; it does not switch
  them on. Appendix C §11 lists them.
- Credit records with no section stamp are treated as spendable in any
  section, under both `creditScope` values, so no historic record is
  rewritten.
- `hubC` is left in place; removing it is not part of this work.

---


# Appendix A

## Audit — hardcoded locations in `src/components/stock/**` and `src/print/**`

Read-only audit, 2026-10-01, branch `feat/sections-network`. Non-test files only. Paths are relative to
`/Users/junidmohammed/Documents/marathon-store-app-sections/`. Line numbers were taken from `grep -n` / numbered reads.

Legend for "change needed":
- **REG** = replace with a registry read (location list / role / label / route / section).
- **WALL** = a section-wall check is needed here (or at the chokepoint it calls).
- **none** = comment, label fallback already registry-backed, or not a location.

What the registry needs to answer, judging by what the code hardcodes today (each is a separate hardcoded fact somewhere below):
1. kind (store / hub / central / transit), active, label — partly in `/locations` already.
2. **section** of each location (new).
3. **back-stock hub for a store, per line** (clothing-and-everything-else hub vs sneaker hub) — today `config/refillEngine.routes` (store → hub2, hub2 → central) plus literals.
4. **"reactive" hubs** (take sale-driven / on-hold / tomorrow lines) — `REACTIVE_REFILL_HUBS`.
5. **gated sneaker hubs** and their alternate (hub1 ⇄ hub2 rerouting) — `GATED_SNEAKER_HUBS`.
6. **display-pair hub** — `DISPLAY_PAIR_HUB = "hub1"`.
7. **first-batch hub** — `FIRST_BATCH_HUB = "hub2"`.
8. **building** (transit lanes) — `BUILDING` map.
9. cleanup/excess/arming hub scope, display stores, history stores, "counted" exclusions.

---

### 1. Per-file inventory

#### locations.js (the seed registry)
| file:line | what it does | change needed |
|---|---|---|
| locations.js:29-40 | `DEFAULT_LOCATIONS` seed: studio, central, base, hub1, hub2, hub3, marathon-pe, trophy, marathon-pine, in_transit. Only `kind/sellable/active/label` — no section, no hub role, no "feeds" relation. Used as fallback whenever `/locations` is empty (`asArray`, :54-57). | REG — add `concrete`, `concrete-stockroom`; add `section`, hub role, store→hub fields. This is the natural home of the one registry. |
| locations.js:59-64 | `activeLocations / sellableLocations / warehouseLocations / transferTargets`. `transferTargets` is deliberately "ALL of them — no routing" (header :3-6, :62-64). `warehouseLocations` = kind==="warehouse" so it mixes Central with hubs. | REG + WALL — add section-aware helpers (`sameSection`, `canMove(from,to)`); pickers built on `transferTargets` currently offer cross-section destinations. |
| locations.js:64, :78 | `"in_transit"` literal / `IN_TRANSIT` | none (keep; but in_transit is section-less — see wall notes) |
| locations.js:83 | `RECEIVING_DEFAULT = "central"` | REG (central role) |
| locations.js:73-76 | `allLocationIds` — registry keys, seed fallback | none |

#### transitLanes.js
| file:line | what it does | change needed |
|---|---|---|
| transitLanes.js:32-42 | `BUILDING` map: central/studio/base=A; marathon-pe/trophy/hub1/hub2=B; marathon-pine/hub3=C | REG — add `concrete`, `concrete-stockroom`; unmapped id resolves to "instant" (:27-29, :46-48), so new locations silently skip transit and the hold lane. |
| transitLanes.js:45 | `TRANSIT_ORIGIN_BUILDINGS = {"A"}` — only Central-origin sends go via in_transit | REG; note building ≠ section (B is exactly Section 2, C is half of Section 1 today). |
| transitLanes.js:52-57 | `isTransitLane(from,to)` | WALL-adjacent: it is the only routing predicate in the folder; a `sectionWall(from,to)` belongs beside it. |

#### reactiveRefillHubs.js
| file:line | what it does | change needed |
|---|---|---|
| reactiveRefillHubs.js:15 | `REACTIVE_REFILL_HUBS = Object.freeze(["hub2"])` | REG (hub role flag; hub3 must be reactive for Section 1) |
| reactiveRefillHubs.js:17-19 | `isReactiveRefillHub(hub)` — no in-scope non-test caller found besides the constant's import in onHoldRefill.js | REG |

#### onHoldRefill.js
| file:line | what it does | change needed |
|---|---|---|
| onHoldRefill.js:71-72 | `VALID_HUBS = new Set(REACTIVE_REFILL_HUBS)` | REG |
| onHoldRefill.js:155-156 | `hub = order.placedAtHub || order.hub`; refuses anything not in VALID_HUBS (`unroutable_hub_*`) — a hub3 / concrete-stockroom hold raises nothing today | REG |
| onHoldRefill.js:164 | request id `onhold_{saDate}_{order.id}` — order ids are daily counters; unclear from this folder whether they are unique across stores/sections | unclear — verify id uniqueness across sections |
| onHoldRefill.js:169, :174 | record `requestingLocation: hub`, `createdFrom.source: "central"` literal | REG (source = Central role) |

#### firstBatchCore.js
| file:line | what it does | change needed |
|---|---|---|
| firstBatchCore.js:3-52 (header), :123-156 | comments describing Hub 2 as THE hub for PE/Trophy | none (rewrite when generalised) |
| firstBatchCore.js:64 | `FIRST_BATCH_HUB = "hub2"` | REG — must become "the back-stock hub of the nominated store" (hub3 for pine/concrete) |
| firstBatchCore.js:86 | `isFirstBatchShopLeg`: `requestingLocation !== FIRST_BATCH_HUB` — any hub other than hub2 with `createdFrom.firstBatch` would be treated as a SHOP leg | REG (use "is a store") |
| firstBatchCore.js:94-99 | `sourceQueueLists(r, shopLocs)` / `countsTowardSourceQueue` — shop set is passed in (RefillQueue `SHOP_DESTS`, App.jsx `SOURCE_SHOP_LOCS`) | REG at callers |
| firstBatchCore.js:115-121 | `EXCLUDED_KEYS = ["sneakers","slides"]` — category, not location | none |
| firstBatchCore.js:176-215 | `hub2PresenceSignals({hub2Node, hub2Locks, hub2OpenRequestIds, sinceIso, heldLines, pid})`, `hub2Present` — hub-agnostic logic, hub2-named params; signal string `"open_hub2_request"` (:202). CJS twin `functions/lib/first-batch.cjs` pinned equal by test | REG (rename/parameterise; twin must change in lockstep) |
| firstBatchCore.js:219-227 | `firstBatchEligible`: `source !== "central"` (:222) and `routes?.[store] !== FIRST_BATCH_HUB` (:223) | REG — compare against the store's own hub; a Pine/Concrete card can never be eligible today |
| firstBatchCore.js:273 | `HISTORY_STORES = ["marathon-pe","trophy"]` — default for `buildPlacementIndex` (:282) and `firstBatchHistory` (:315) | REG (stores of the card's section) |
| firstBatchCore.js:418 | `centralReservedBySize({openByLoc, routes, source = "central"})` | REG (Central role) |
| firstBatchCore.js:476, :483 | user-facing strings "stays at Hub 2 first … from Hub 2" | REG (label of the store's hub) |
| firstBatchCore.js:550-552 | `buildFirstBatchSolveUpdate` seeds `FIRST_BATCH_HUB` + store | REG |
| firstBatchCore.js:557-575 | writes `/refill_requests/{id}` with `requestingLocation: store`, `createdFrom: {firstBatch, source:"central", store, hub: FIRST_BATCH_HUB, hub2Seeded}` | REG; field name `hub2Seeded` is hub2-specific (the server trigger reads this record) |
| firstBatchCore.js:632 | `firstBatchEstimate` reads `run[FIRST_BATCH_HUB]` | REG |

#### solvePlan.js
| file:line | what it does | change needed |
|---|---|---|
| solvePlan.js:59-61 | `seedLocations(source, store)` → `source === "central" ? ["hub2", store] : [store]` | REG — hub of `store` |
| solvePlan.js:292-296 | `qualifyingSizes(sizes, source, store, std)` — positive target at every `seedLocations` loc | REG via seedLocations |
| solvePlan.js:301, :308-312 | `solvePlan`: `source === "hub2"` branch, `at("hub2", sz)`, `coverLoc: "Hub 2"` | REG |
| solvePlan.js:315-319 | `hubRun = std.hub2`, `at("central", sz)`, `coverLoc: "Central"` | REG |
| solvePlan.js:48-54, :190-280 | `ruleTargetsEnabledFor`, `categoryPolicyLocs`, `categoryRun`, `resolvedRun` — location-keyed but data-driven (config keys) | none |

#### missingProductsCore.js
| file:line | what it does | change needed |
|---|---|---|
| missingProductsCore.js:29 | `STORES = ["marathon-pe","trophy"]` | REG |
| missingProductsCore.js:134 | candidate pids = `allStock.central` ∪ `allStock.hub2` | REG (Central ∪ each section's non-sneaker hub) |
| missingProductsCore.js:146-150 | `ce = sumAt("central")`, `h2 = sumAt("hub2")`; `carriedDownstream = carries("marathon-pe") || carries("trophy")`; card `source` is `"central"` or `"hub2"`, `kind` "Only in Central"/"Only in Hub 2" | REG — must be evaluated per section: a product carried at PE is not "carried downstream" for Section 1 |
| missingProductsCore.js:157 | `missing = source === "central" ? ["hub2", ...STORES]… : STORES` | REG |

#### NetworkTransfer.jsx (Missing Products list: Solve, manual transfer, undo)
| file:line | what it does | change needed |
|---|---|---|
| NetworkTransfer.jsx:35 | `STORES = ["marathon-pe","trophy"]` — used at :442, :443, :463-464, :524, :661, :825, :832, :930 | REG |
| NetworkTransfer.jsx:36 | `LOC_LABEL` map (PE, Trophy, hub2, central) — used throughout for messages | REG (`labelFor`) |
| NetworkTransfer.jsx:38 | `SOURCE_TAB_LABEL = {"marathon-pe":"Marathon", trophy:"Trophy"}` (mirrors App.jsx `SOURCE_SHOP_TABS`, App.jsx:16147) | REG |
| NetworkTransfer.jsx:44-48 | `STD_FALLBACK` runs keyed hub2 / marathon-pe / trophy (pre-load placeholder only) | REG or delete |
| NetworkTransfer.jsx:454-459 | `hub2PresentFor(pid, openByLoc)` reads `allStock[FIRST_BATCH_HUB][pid]`, `openByLoc.hub2Raw`, `.openHub2Requests`, `.heldHub2` | REG (per-store hub) |
| NetworkTransfer.jsx:460-461 | `eligibleAt(card, store, openByLoc)` → `firstBatchEligible({routes: cfg.routes,…})` | REG |
| NetworkTransfer.jsx:462-471 | `storeChoiceFor / defaultStoreFor / storeFor` — WHICH shop is nominated | REG (candidates = stores of the section) |
| NetworkTransfer.jsx:486-515 | `readOpenLocks(pid)`: one read per `Object.keys(cfg.routes)`; reads `settings/stockHold/held/hub2`, queries open `/refill_requests` where `requestingLocation === FIRST_BATCH_HUB` | REG |
| NetworkTransfer.jsx:548 | `qtyAt("central", …)` | REG |
| NetworkTransfer.jsx:583, :599, :700-701 | strings "(via Hub 2)", "Hub 2 is seeded now…" ; `u.locs.includes("hub2")` (:701) | REG |
| NetworkTransfer.jsx:596 | `locs = firstBatch ? [FIRST_BATCH_HUB, store] : seedLocations(card.source, store)` | REG |
| NetworkTransfer.jsx:661 | `destOptions(card)` = `card.source === "central" ? ["hub2", ...STORES] : STORES` — manual transfer destinations | REG + WALL (source hub2 → only Section-2 stores; Central → that section's hub/stores) |
| NetworkTransfer.jsx:668-691 | `transfer(card)`: `applyMovement transfer_out from card.source → dest` | WALL |
| NetworkTransfer.jsx:930-974 | Solve panel copy: "Hub 2 is seeded now", "Hub 2 pulls ~N from Central", "Hub 2 has all N" | REG (labels) |

#### MissingFootwear.jsx / missingFootwearCore.js
| file:line | what it does | change needed |
|---|---|---|
| MissingFootwear.jsx:57 | `HUBS = ["hub1","hub2"]` — detection scope ("missing" = zero at BOTH hubs), also the reservation scope (:200) | REG (sneaker-holding hubs; per section) |
| MissingFootwear.jsx:65 | `REQUESTABLE_HUBS = HUBS` — where a human may raise; `[0]` is the default dest (:129, :196, :305) | REG |
| MissingFootwear.jsx:70 | `LOC_LABEL = {hub1, hub2, central}` | REG |
| MissingFootwear.jsx:103 | reads `config/refillEngine/footwearRunByLocation` → `footwearRun[hub]` (:217, :249) — data-driven | none |
| MissingFootwear.jsx:151, :218, :250 | `allStock.central[pid]` | REG |
| MissingFootwear.jsx:160-174, :263-277 | write `/refill_requests` (`requestingLocation: dest/hub`, `createdFrom.source: "central"`) | REG (Central role); no wall issue (Central supplies both) |
| MissingFootwear.jsx:342 | string "Carried at both hubs, but both are empty" | REG |
| missingFootwearCore.js:85 | `computeMissingFootwear({…, hubs = ["hub1","hub2"]})` default; HealthView.jsx:454 calls it WITHOUT `hubs` (relies on the default) | REG |
| missingFootwearCore.js:131, :145, :150 | `allStock.central`, `unitsAt(…,"central",…)`, `cellsOf(…,"central",…)` | REG |
| missingFootwearCore.js:83, :114-128 | `nameKey` / `idsByName` / `twinWithHubStock` — NAME-keyed duplicate detection (display hint `duplicateOf` only, no write) | none (name-key, see defects) |

#### MoveExcess.jsx
| file:line | what it does | change needed |
|---|---|---|
| MoveExcess.jsx:30 | `LOC_LABEL` (PE, Trophy, hub2, central) | REG |
| MoveExcess.jsx:31 | `SOURCES = ["hub2","marathon-pe","trophy"]` (fallback when routes empty) | REG |
| MoveExcess.jsx:68 | `routesCfg = engineConfig.routes || {"marathon-pe":"hub2", trophy:"hub2", hub2:"central"}` | REG (fallback map) |
| MoveExcess.jsx:72-76 | `sources` = keys of routes, ordered store-before-its-source | REG |
| MoveExcess.jsx:91-118 | `deficitBySize` keyed `pid|sizeKey` summed over ALL `sources` — one network-wide deficit pool, no section dimension | REG — a Section-1 deficit would hold back / attract Section-2 excess once routes include both sections; must key by section (or by hub) |
| MoveExcess.jsx:120 | `minEx = loc === "hub2" ? 1 : storeMin` | REG (is-hub) |
| MoveExcess.jsx:141-157 | `if (loc === "hub2")` net-based branch vs store two-leg split (`toHub` / `toCentral`) | REG |
| MoveExcess.jsx:197-202 | pick-list routes: `sources.filter(l => l !== "hub2")`, `routesCfg[from] || "hub2"`, `to: "central"`, plus `{from:"hub2", to:"central"}` | REG |
| MoveExcess.jsx:230, :233, :262, :424, :456 | `c.loc !== "hub2"` / `c.loc === "hub2"` display + ceiling branches | REG |
| MoveExcess.jsx:268-269 | `hubDest = routesCfg[c.loc] || "hub2"`; `dest = which === "hub" ? hubDest : "central"` | REG (store's own hub); wall holds by construction if hubDest comes from the store's section |
| MoveExcess.jsx:298-304 | `applyMovement transfer_out c.loc → dest` | WALL (belt-and-braces) |
| MoveExcess.jsx:359 | label "→ Hub 2 · N units" | REG |
| MoveExcess.jsx:408 | `routesCfg[c.loc] || "hub2"` | REG |

#### excessComputation.js / ExcessHubToCentral.jsx
| file:line | what it does | change needed |
|---|---|---|
| excessComputation.js:95 | `EXCESS_HUB_LOCATIONS = Object.freeze(["hub1","hub2"])` ("deliberately not derived from the registry") | REG |
| excessComputation.js:137-142 | `excessEnabledAt(config, loc)` per-location kill switch — data-driven | none |
| excessComputation.js:148-158 | `reservedByHubFromOpenRequests(openRequests, routes)` — source = `r.source || r.createdFrom.source || routes[r.requestingLocation]` | none (data-driven; depends on routes covering new stores) |
| excessComputation.js:170-233 | `computeHubExcess(ctx, reserved, {locations = EXCESS_HUB_LOCATIONS,…})` | REG via default |
| ExcessHubToCentral.jsx:71 | `HUB_LABEL = {hub1, hub2}` | REG |
| ExcessHubToCentral.jsx:72-73 | `DEST_KEY = "central"`, `DEST_LABEL = "Central"` | REG |
| ExcessHubToCentral.jsx:98 | `useState(EXCESS_HUB_LOCATIONS[0] || "hub1")` | REG |
| ExcessHubToCentral.jsx:171-188, :206, :246 | `doMove(pid, lines, from, to)` → `applyMovement transfer_out hub → central`; undo runs `central → hub` | none for the wall (Central is shared); REG |

#### distributionSuggest.js / InitialDistributionWizard.jsx
| file:line | what it does | change needed |
|---|---|---|
| distributionSuggest.js:30 | `DISTRIBUTION_DESTS = ["marathon-pe","trophy","marathon-pine","hub1","hub2"]` (hub3 absent) | REG |
| distributionSuggest.js:32-38 | `DEST_LABELS` | REG |
| distributionSuggest.js:44-50 | `LETTER_RUNS` per location | REG / config |
| distributionSuggest.js:55 | `SHOE_RUN = {PE:0, trophy:0, pine:0, hub1:2, hub2:2}` | REG / config |
| distributionSuggest.js:84 | `NEVER_DEFAULT_ON = new Set(["hub1","hub2"])` | REG (is-hub) |
| distributionSuggest.js:93-110 | `suggestInitialDistribution({product})` — iterates DISTRIBUTION_DESTS | REG |
| InitialDistributionWizard.jsx:6 | comment listing the five destinations | none |
| InitialDistributionWizard.jsx:99 | subscribes `stock/central/{pid}` | REG |
| InitialDistributionWizard.jsx:169-175 | `applyMovement transfer_out from:"central" to: dest` (reason `initial_distribution`) — does NOT go through `isTransitLane` (instant move even cross-building) | REG; no wall issue (source is Central) |
| SetQuantity.jsx:51, :150 | default location `RECEIVING_DEFAULT`; `loc === "central"` opens the distribution wizard | REG |

#### introduceExistingCore.js / IntroduceExisting.jsx
| file:line | what it does | change needed |
|---|---|---|
| introduceExistingCore.js:36 | `HUB2_RUN` constant | REG / config |
| introduceExistingCore.js:37 | `MIGRATION_DESTS = ["marathon-pe","trophy","hub2"]` | REG |
| introduceExistingCore.js:40-41 | `destsFrom(config)` = keys of `config.routes`, else MIGRATION_DESTS | REG (fallback) |
| introduceExistingCore.js:52-55 | `effectiveRun(config, loc)`: fallback `loc === "hub2" ? HUB2_RUN : STANDARD_RUN` | REG (is-hub) |
| introduceExistingCore.js:80-125 | `computeUnintroduced(allStock, allTargets, productsById, dests, categoryPolicy)`; :112 `["central", ...dests]`; :120 `carries` per dest | REG (Central) |
| introduceExistingCore.js:175 | `if (loc !== "hub2" && item.carries && !item.carries[loc]) continue;` — Hub 2 "buffers BOTH shops" so gets every product | REG — per section: a hub should get a product only if a store IN ITS SECTION carries it |
| introduceExistingCore.js:183-192 | writes `/stock_targets/{loc}/{pid}/{size}` | none (not a stock move) |
| introduceExistingCore.js:208 | `policyVersion = shops:${runFor("marathon-pe")}|hub2:${runFor("hub2")}` | REG |
| IntroduceExisting.jsx:17 | `LOC_LABEL` | REG |
| IntroduceExisting.jsx:43, :46-47 | `l === "hub2"`, `effectiveRun(config,"marathon-pe")`, `effectiveRun(config,"hub2")`; :107-110 copy "Hub 2 buffers everything" | REG |

#### NoTargetQueue.jsx
| file:line | what it does | change needed |
|---|---|---|
| NoTargetQueue.jsx:46 | `ALL_LOCS = ["marathon-pe","trophy","hub2","central"]` (network strip per card, :153, :178, :218) | REG |
| NoTargetQueue.jsx:47 | `LOC_LABEL` | REG |
| NoTargetQueue.jsx:137-155 | "NEW at Central" cards iterate `allStock.central`; key `central|pid`, `loc:"central"` | REG |
| NoTargetQueue.jsx:202-211 | `if (loc === "hub2")` — Hub 2 cards also pick up untargeted sizes stocked at Central | REG (every non-sneaker hub) |
| NoTargetQueue.jsx:259-262 | `targetFor`: `card.isNew && loc === "hub2"` → `effectiveRun(engineConfig,"hub2")` | REG |
| NoTargetQueue.jsx:267-282 | `distributionOf(card)` deals Central's pool across `dests` in order | REG |
| NoTargetQueue.jsx:284-327 | `saveTargets`: writes `/stock_targets`, then `applyMovement transfer_out from:"central" to: loc` (:313-319) | REG; no wall issue |
| NoTargetQueue.jsx:329-346 | `excludeHere`: writes `/stock_targets` target 0 | none |
| NoTargetQueue.jsx:350 | default dest: `card.loc==="central" ? "hub2" : card.loc==="hub2" ? "central" : "hub2"`; same expression at :532 | REG (store → its hub; hub → Central) |
| NoTargetQueue.jsx:348-372 | `transfer(card)`: `applyMovement transfer_out from card.loc → dest` (dest from picker chips at ~:525-535) | WALL |

#### RefillQueue.jsx (Source queue: Central → hub / shop)
| file:line | what it does | change needed |
|---|---|---|
| RefillQueue.jsx:73 | `SOURCE_LOC = "central"` | REG |
| RefillQueue.jsx:76 | `HUB_LABEL` map (hub1, hub2, hub3, trophy, marathon-pe) | REG |
| RefillQueue.jsx:86 | `SHOP_DESTS = new Set(["trophy","marathon-pe"])` — decides that a shop tab lists ONLY first-batch legs (:355). Any store not in this set mounted as `dest` would list its whole hub→shop backlog as Central's pick list (the 2026-09-17 incident shape) | REG — must include pine, concrete |
| RefillQueue.jsx:312 | prop default `dest = "hub2"` | REG |
| RefillQueue.jsx:355 | `r.requestingLocation === DEST_LOC && sourceQueueLists(r, SHOP_DESTS)` | REG |
| RefillQueue.jsx:370-371 | `forDests` (pass-through request) labelled via HUB_LABEL | REG |
| RefillQueue.jsx:405-540 | `fulfilRequest`: `transfer_out SOURCE_LOC → DEST_LOC` (or `in_transit` when hold lane on), or `received` into dest; then writes `/refill_requests/{id}` qty/sentQty or status fulfilled | REG; wall OK (Central origin) |
| RefillQueue.jsx:429, :637 | `holdActive({from, to})` → `isTransitLane` (BUILDING map) | REG |
| RefillQueue.jsx:548-617 | `rejectRequest`: txn on `/refill_requests/{id}`; `cancelReason` depends on `isFirstBatchShopLeg` | REG via firstBatchCore |
| RefillQueue.jsx:629-689 | `fulfilSale(row, pickLoc, qty, avail)`: `transfer_out pickLoc → DEST_LOC` with `allowNegative: true` | **WALL** — `pickLoc` is user-chosen from `warehouseLocations(registry)` minus dest (:795-797) = central, hub1, hub2, hub3 (+ concrete-stockroom). A hub1→hub3 sale-row pick is a direct cross-section move. |
| RefillQueue.jsx:773 | card grouping key `row.productId || \`name:${row.productName}\`` | name-key, see defects |
| RefillQueue.jsx:796 | request rows: sources fixed to `[{id: SOURCE_LOC, label:"Central"}]` | REG |

#### refillQueueCore.js / sourceMovementDedupe.js / sourceResponseWrites.js / refillSatisfied.js / crQueueGrouping.js
| file:line | what it does | change needed |
|---|---|---|
| refillQueueCore.js:32, :50-79 | sale rows keyed by `sourceGroupKey(productId, productName)` (utils/insights.js:139 → `productId || sanitizeKey(name) || "Unknown"`); dual-read of legacy `nameKey` for responses/progress; `movementIdSeed = srcful_{date}_{key}_{size}` | name-key (defect). Also: neither the response path (`restock_requests/{date}/{key}/{size}`) nor the movement seed contains the DESTINATION hub — see "Open defects". |
| refillQueueCore.js:130 | `groupRowsByProduct` key `productId || name:${productName}` | name-key |
| sourceMovementDedupe.js:29-31 | `sourceMovementIdSeed(date, groupKey, encodedSize)` — no location term | REG? — add dest when a second sale-driven hub exists (breaks idempotency of in-flight ids; needs a dual-read like the pid cutover) |
| sourceMovementDedupe.js:44-53 | `checkSourceMovementDuplicate` — legacy name-id check | name-key |
| sourceResponseWrites.js:25-46 | clears response cells under pid key AND legacy name key | name-key |
| refillSatisfied.js:101-148 | `partitionSatisfied(requests, destCells, lockedIds)` — LOCKED requests are never "covered"; unlocked ones are hidden when dest shelf ≥ qty | none for locations; see defect "requests not clearing after manual transfer" |
| crQueueGrouping.js:31-32 | `crMovementId(prefix, orderId, createdAt, gen)` | none |
| crQueueGrouping.js:61 | merge key `${productId}__${destShop}` | none (pid-keyed) |

#### HealthView.jsx
| file:line | what it does | change needed |
|---|---|---|
| HealthView.jsx:55 | `LOC_LABEL` (PE, trophy, hub1, hub2, hub3, pine, central) | REG |
| HealthView.jsx:107-108 | `storeRows = dest !== "hub2"`, `hubRows = dest === "hub2"` | REG (is-hub) |
| HealthView.jsx:119-120 | route text `c.dest === "hub2" ? "Central → Hub 2" : \`Hub 2 → ${dest}\``; queue name "Source → Hub 2 Refill" / "Warehouse → Clothing" | REG (source = route of dest) |
| HealthView.jsx:137, :143 | copy "Source → Hub 2 Refill", "Waiting for Hub 2" | REG |
| HealthView.jsx:172-188 | `NegativeFixChip`: `applyMovement adjustment to: row.loc` (single location) | none |
| HealthView.jsx:217 | `set(refill_engine/rejectStreak/{loc}/{pid}/{size}, null)` | none |
| HealthView.jsx:386-395 | `storeWaiting`: every engine dest except `"hub2"` | REG |
| HealthView.jsx:396 | `centralQueue = openRequests.filter(r => r.requestingLocation === "hub2")` | REG |
| HealthView.jsx:422-424 | `computeMissingProducts({allStock, products})` | REG via core |
| HealthView.jsx:453-455 | `computeMissingFootwear({allStock, products})` — default hubs | REG |
| HealthView.jsx:486-490 | screen "Central → Hub 2 Refills": `<RefillQueue dest="hub2" />` | REG |
| HealthView.jsx:505-512 | comment on the two tabs' rules | none |
| HealthView.jsx:758 | `(snr.shops).includes("marathon-pine") ? "" : "(Pine has no keep numbers…)"` | REG |
| HealthView.jsx:813, :827 | copy "at Hub 1 and Hub 2", "order sheet reads only the two hubs" | REG |
| HealthView.jsx:861 | `HUB_NAMES = {hub1, hub2, hub3}` | REG |
| HealthView.jsx:1010-1028 | stat-card copy "Waiting for Hub 2", "Hub 2 restock · in Source → Hub 2 Refill", "Hub 2 + shops above target" | REG |

#### availabilityCore.js / tomorrowGate.js
| file:line | what it does | change needed |
|---|---|---|
| availabilityCore.js:125-148 | `readyPromisedByCell(orders, loc, productsById)`; :135-137 `inHub = (loc === "hub3" || loc === "hubC") ? o.placedAtHub === loc : (o.hub || "hub1") === loc` | REG — the "hub3/hubC live in placedAtHub, everything else defaults to hub1" rule is a hardcoded hub switch (mirrors App.jsx `orderInHub`) |
| availabilityCore.js:168 | `GATED_SNEAKER_HUBS = ["hub1","hub2"]` (hub3 deliberately NULL = ungated, :157-162) | REG — per section |
| availabilityCore.js:185 | `DISPLAY_PAIR_HUB = "hub1"` | REG |
| availabilityCore.js:186-190 | `gatedSneakerHub(product, routedHub)` | REG |
| availabilityCore.js:323-367 | `resolveSneakerSourcing`; :334 `alternate = GATED_SNEAKER_HUBS.find(h => h !== taggedHub)` — assumes exactly two gated hubs and reroutes an order between them | REG + **WALL** — the alternate must be in the same section as the ordering shop; with >2 gated hubs `.find` picks an arbitrary one |
| availabilityCore.js:407-459 | `allocateSneakerCart({lines, hubData, taggedHubFor, displayPairHub = DISPLAY_PAIR_HUB})`; :409 comment `{hub1, hub2}` | REG |
| tomorrowGate.js:40 | `CENTRAL = "central"`; :47-74 `fetchCentralAvailability` reads `stock/central/{pid}/{size}` | REG |
| tomorrowGate.js:127 | `CENTRAL_FED_HUBS = ["hub1","hub2"]` | REG |
| tomorrowGate.js:128-134 | `centralFedRow(order, product)`: `placedAtHub === "hub3" || "hubC"` → false; `hub = order.hub || "hub1"`; `hub === "hub1"` → true; else `gatedSneakerHub(product,"hub2") === "hub2"` | REG — if hub3 becomes Central-fed like hub2 this three-way switch must become a role lookup |

#### armingCore.js / armingStore.js / ArmingTab.jsx
| file:line | what it does | change needed |
|---|---|---|
| armingCore.js:80-82 | `HUB1 = "hub1"`, `HUB2 = "hub2"`, `ARMING_HUBS = [HUB1, HUB2]` ("Hub 3 is deliberately absent", :77) | REG |
| armingCore.js:95-110 | `BUCKET` enum `both_hubs / hub1_only / hub2_only / nowhere`, `BUCKET_TITLE` "Hub 1"/"Hub 2" | REG — structurally a 2-hub model; N hubs needs a different shape (per section pair) |
| armingCore.js:161-213 | `hubArming(ctx, hub, pid)` — generic in `hub` | none |
| armingCore.js:241-246, :249-270 | `bucketFor(h1,h2)`, `flagsFor(h1,h2)` | REG |
| armingCore.js:290-337 | `armingIndex(ctx, pids)`: `hubArming(ctx, HUB1, pid)` / `HUB2`; rows carry `hub1:` / `hub2:` fields (:319-320) | REG |
| armingStore.js:58, :77-90 | `readArmingContext(hubs = ARMING_HUBS)` reads `stock/{hub}` and `stock_targets/{hub}` whole | REG |
| ArmingTab.jsx:39, :110, :128, :230 | uses `ARMING_HUBS` | REG |
| ArmingTab.jsx:103-105 | destinations from `transferTargets(registry)` / `allLocationIds(registry)` | none (already registry) |
| ArmingTab.jsx:371-372 | `row.hub1.armed` / `row.hub2.armed` badges "Hub 1 · n" / "Hub 2 · n" | REG |
| ArmingTab.jsx:78, :260, :289 | `BUCKET.BOTH_HUBS` default tab, "Reading both hubs…" | REG |

#### enginePolicyCore.js / EnginePolicyCard.jsx / seatingCore.js / seatingStore.js / SeatingTab.jsx / SeatingActions.jsx / targetOverride.js / ProductTargetEditor.jsx
| file:line | what it does | change needed |
|---|---|---|
| enginePolicyCore.js:167-183 | `editorRows({entry, carriage, destinations})` — locations come from the census (`census.destinations`, from the callable), not from code | none |
| enginePolicyCore.js:16, :93, :143-144, :171, :459-460 | comments only (hub2 / trophy / marathon-pine examples) | none |
| EnginePolicyCard.jsx:93-94 | `LOC_LABELS` map incl. hub3, marathon-pine | REG |
| EnginePolicyCard.jsx:91, seatingStore.js:134 | `httpsCallable("setCategoryPolicy")` — writes `config/refillEngine/categoryPolicy` server-side | none here (server must know new locations) |
| EnginePolicyCard.jsx:283 | `destinations = census?.destinations` | none |
| EnginePolicyCard.jsx:376, :985 | comments ("both hubs' queues", "Hub 1 ≠ Hub 2" drift) | none (footwear-one-policy drift logic is server-side) |
| seatingCore.js:201, :410 | comments only | none |
| seatingStore.js:345-375 | `moveBlockers(from, to, lines, destSeat)` — refuses transit lanes both directions (:352, :363) | **WALL** — add section check here |
| seatingStore.js:382-430 | `moveAndSwitchOff`: `applyMovement transfer_out seat.loc → dest` (or reversed for negatives, `allowNegative`) | WALL |
| SeatingTab.jsx:110-112, SeatingActions.jsx (dest chips ~:181) | rows/destinations from `transferTargets(registry)` | WALL (filter chips to same section + Central) |
| targetOverride.js:113, ProductTargetEditor.jsx:3 | comments | none |

#### Transfer.jsx / transferDraft.js / InTransit.jsx / CountedStockReview.jsx
| file:line | what it does | change needed |
|---|---|---|
| Transfer.jsx:94, :140 | `from` starts empty; locations = `transferTargets(registry)` — ANY active location to ANY other | **WALL** (picker + submit) |
| Transfer.jsx:355-359 | `doTransfer` validation: only from≠to | **WALL** — primary manual cross-location path |
| Transfer.jsx:373 | `transit = transitOn && isTransitLane(from, to)` | REG (BUILDING) |
| Transfer.jsx:399-413 | creates/merges `/transfers/{tId}` `{status:"dispatched", from, to, reason:"manual", lines}` | WALL (check with the REAL `to`) |
| Transfer.jsx:438-443 | `applyMovement transfer_out from → (transit ? IN_TRANSIT : to)` | WALL — note a chokepoint check inside applyMovement sees `to = in_transit` on a transit send and cannot judge the wall; the check must be made here with the real destination |
| Transfer.jsx:482-489 | marks `/refill_requests/{refillId}` fulfilled when every line moved and not transit | see defects — `setRefillId` is only ever called with `null` (:247, :258) or a restored draft (:338); nothing in this file links a manual transfer to an open request |
| transferDraft.js:6, :39 | comments | none |
| InTransit.jsx:123-128 | `applyMovement transfer_in from IN_TRANSIT → t.to` | none (destination was fixed at dispatch; wall must have been enforced there) |
| InTransit.jsx:148-150, :169-174, :307-312 | writes `/transfers/{id}/received…`, status | none |
| InTransit.jsx:194-196 | writes `config/transit` | none |
| CountedStockReview.jsx:26 | `DEFAULT_LOCATION = "marathon-pe"` | REG |
| CountedStockReview.jsx:177-198 | `moveProduct`: `applyMovement transfer_out g.loc → to` — `to` from `LocationPicker filter={transferTargets}` (:373). No transit check, no movementId (not idempotent), no wall | **WALL** |
| CountedStockReview.jsx:140-144, :208-212, :222-228 | single-location adjustments | none |

#### stockHoldCore.js / stockHoldStore.js / StockHoldRelease.jsx / StockHoldCard.jsx
| file:line | what it does | change needed |
|---|---|---|
| stockHoldCore.js:36-40 | `holdActive({config, windows, from, to})` → `isTransitLane` | REG (BUILDING) |
| stockHoldStore.js:74-91 | `recordHeldLine` → `settings/stockHold/held/{dest}/{lineId}` | none |
| stockHoldStore.js:134-240 | `releaseShipment`: `applyMovement transfer_in IN_TRANSIT → dest`; archives line; stales hub-count cells | none (dest fixed at fulfil) |
| StockHoldRelease.jsx:31 | `HUB_LABELS = {hub1, hub2, hub3}` | REG |
| StockHoldCard.jsx:90, StockHoldRelease.jsx:126, :177 | copy "credit hubs instantly" | none |

#### Display modules
| file:line | what it does | change needed |
|---|---|---|
| hubCleanupCore.js:25-26 | `CLEANUP_HUBS = ["hub1","hub2"]`, `CLEANUP_HUB_LABELS` ("deliberately NOT derived from the registry", :22-24) | REG |
| hubCleanupCore.js:28-30 | `isCleanupHub(hub)` — gate in hubCleanupStore.js:176, :376 and displayRegistrationStore.js:86, :174, :254 (messages "booked at hub1/hub2") | REG |
| hubCleanupCore.js:36-37 | `DISPLAY_STORES = ["marathon-pe","trophy"]`, `DISPLAY_STORE_LABELS` — used HubCleanup.jsx:2731, ProductDisplayHistory.jsx:72 | REG |
| HubCleanup.jsx:242, :1301 | hub picker from CLEANUP_HUBS; :1310 "Pine is out of scope" | REG |
| HubCleanup.jsx:344 | fallback list `["central","hub1","hub2","marathon-pe","trophy","in_transit"]` when registry empty | REG |
| HubCleanupCard.jsx:18, :52 | CLEANUP_HUBS picker | REG |
| hubCleanupStore.js:263-273, :396-405 | `applyMovement received → hub` (display registration adds a unit) | none (single location) |
| DisplayRegistrationView.jsx:76 | `STORES = ["marathon-pe","trophy"]` ("Pine … deliberately not offered", :74-75); :162, :383 | REG |
| DisplayRegistrationView.jsx:174-175, :214, :229-230 | `GATED_SNEAKER_HUBS[0]` / `[1]` — two fixed `useStockCellsState` hooks named hub1/hub2 | REG — positional two-hub assumption |
| DisplayRecordsTab.jsx:47 | `HUBS = ["hub1","hub2"]`; :90 `useState("hub1")`; :103 `otherHub = hub === "hub1" ? "hub2" : "hub1"` | REG — binary toggle |
| displayRecordCleanup.js:436 | `findUnregisteredDisplays({…, hubs = ["hub1","hub2"]})` | REG |
| displayRowCore.js:224 | `duplicateDisplayGroups({…, hubs = ["hub1","hub2"]})` | REG |
| displayRowCore.js:339 | `unregisteredAcrossHubs({…, hubs = ["hub1","hub2"]})` | REG |
| displayRowCore.js:100-101 | comment "store ids are the fixed set (marathon-pe, trophy)" — a safety argument for path segments | REG — re-validate (`concrete-stockroom` has no illegal chars, but the claim changes) |
| displayPairCore.js:221 | `o.placedAtHub || o.hub || "hub1"` default hub for a manual display event | REG |
| displayPairCore.js:1-32, :461-466 | comments: display-pair lane is hub1-scoped | none |
| displayRequestCore.js:90-107 | `pickDisplaySourceHub({product, hubData, hubs = GATED_SNEAKER_HUBS})` — tag first (`product.hubs[0] || product.hub`), then the other hubs in list order | REG + **WALL** — the source hub must be in the requesting store's section |
| displayRequestCore.js:130-165 | `wallWalkOrder`: `hub`, `placedAtHub: hub`, `placedStore: "central"`, `destShop: store` | REG (`"central"` literal) |
| displayRequestStore.js:113-198 | `raiseDisplayRequest({orders, store, product, hubData})` → `set(orders/{orderId})` | WALL (hub ↔ store) |
| displayRegistrationStore.js / displayRowStore.js / displaySlots.js | write `settings/displayRows…`, `settings/displaySlots/{store}/{pid}` with `bookedHub`; no `/stock` writes | none for the wall; `bookedHub`/store pairs should be same-section (data rule) |
| displaySlots.js:29, :45; DisplayRecordsTab.jsx:9; ProductDisplayHistory.jsx:11 | comments | none |

#### Remaining files (labels, defaults, comments)
| file:line | what it does | change needed |
|---|---|---|
| attentionCore.js:24-25 | `SHOP_SET = {"marathon-pe","marathon-pine","trophy"}`, `isShopLocation` (used :179) | REG (kind==="store") |
| attentionCore.js:27-33 | `LOCATION_LABELS` incl. hubC, warehouse1, base, studio | REG |
| AttentionView.jsx:26, :475, :602 | comments | none |
| networkTotalsCore.js:61 | `EXCLUDED_LOCATIONS = ["marathon-pine","hub3"]` — the network total deliberately excludes what is now Section 1 | REG — decide per section (owner call); `concrete`/`concrete-stockroom` would be COUNTED by default (:75-80) |
| NetworkTotals.jsx:16-17 | comment | none |
| refillHistoryCore.js:100-105 | `HUB_STEPS`: all / hub1 / hub2 / shops (`shops` includes `hub3` — hub3 is filed as a "shop") | REG |
| refillHistoryCore.js:218-221 | reason strings mentioning Hub 2 | REG (labels) |
| RefillHistory.jsx:46-47 | label map; :327 "Marathon PE · Trophy · Pine · Hub 3" | REG |
| refusalWriteoffsCore.js:9 | `LOC` label map | REG |
| offShelf.js:73 | `(o.placedAtHub || o.hub) !== hub` — the looser hub rule that availabilityCore.js:131-137 says produced a false ✕ | REG — one `orderHub(order)` helper |
| hubCountCore.js:51-56 | `hubOptions(registry)` — already registry-driven (warehouses incl. Central) | none |
| HubSneakerCount.jsx:93, :428 | uses `hubOptions(registry)` | none |
| StockAuditView.jsx:32, :109-110, :167 | `AUDIT_STORES` / `AUDIT_HUBS` imported from `src/config/stockAudit.js` (:19, :28 — OUT of this audit's scope; hardcoded there, mirrored in `functions/lib/stock-audit.cjs`) | REG (out of scope file) |
| stockAuditStore.js:43-79 | writes audit results by hub/store path | none |
| StockView.jsx:41, :79 | tab comment/description "Bulk hub 2 → central rebalance" | REG (copy) |
| Locator.jsx:32, CountSession.jsx:12, BarcodeCatalog.jsx:77, DuplicatesTab.jsx:103, ProductActions.jsx:112, widgets.jsx:87 | registry helpers | none |
| Adjust.jsx:62-69, CountSession.jsx:81-89, SetQuantity.jsx:129-137, hubCountStore.js:386-395, ProductActions.jsx:166-175 | single-location `adjustment` / `received` | none |
| offlineQueue.js:97-106 | `applyMovement sold from: line.fulfillingLoc` (single location; value supplied by the caller that enqueued) | none here |
| applyMovement.js:57-66, :86-91 | `"in_transit"` literal special-cases (reactivation, debt clearing) | none |
| applyMovement.js:100-112, :143-160 | `cellDeltas` / validation — no location validation beyond presence | **WALL chokepoint candidate** (transfer_out with two real locations) |
| alternativesCore.js:47; mergeDisposition.js:17, :77; mergeDispositionStore.js:6; MergeProducts.jsx:125; hubCountStore.js:4, :157; hubSizeRank.js:3; solveUndo.js:89; targetOverride.js:113; useStock.js:160-179 | comments only | none |
| MergeProducts.jsx:46 | `httpsCallable("mergeProducts")` — server moves/removes stock per location inside one product merge | out of scope (server); not a cross-location move |
| hubCountStore.js:55, offlineQueue.js:22, BarcodeCatalog.jsx:210/282, ui.js:8 | "marathon…" storage keys / "Studio" UI words — not locations | none |

#### src/print/**
| file:line | what it does | change needed |
|---|---|---|
| print/orderSlip.js:21 | `STORE_LABELS = { central: "Central", pine: "Pine" }` — keyed by `order.placedStore || order.placedHub` (:23); note key is `pine`, not `marathon-pine` | REG |
| print/orderSlip.js:25 | `"Marathon · {nice}"` / `"Marathon"` brand prefix on every slip | REG if Concrete trades under another name (unclear — owner decision) |
| print/pickList.js:14 | comment example `route: "Marathon PE → Hub 2"`; route string is passed in by the caller | none |
| print/printSlipService.js | no location literals found | none |

---

### 2. Cross-location write paths (each listed once)

All stock moves funnel through `applyMovement` (applyMovement.js:143) — a CLIENT-side multi-path `update()` of `/stock/{loc}/{pid}/{size}` cells + `/stock_movements/{mvId}` (:289, :302, :356). No callable or trigger moves stock from this folder. `applyMovement` validates type/qty/presence of from/to only; the DB rule checks `/locations/{id}` existence (per the locations.js header) — nothing checks a from→to pair.

| # | Function (file:line) | RTDB paths written | from / to | Where it runs | Wall |
|---|---|---|---|---|---|
| 1 | `doTransfer` (Transfer.jsx:355-489) | `/transfers/{tId}` (:399-413, :470, :473); `/stock` + `/stock_movements` via `transfer_out` (:438); `/refill_requests/{refillId}` status (:483) | both USER-chosen from `transferTargets(registry)`; `to` becomes `in_transit` on a transit lane | client | **needed** (real `to`) |
| 2 | `receive` (InTransit.jsx:101-181) + close-short (:307) | `/stock`,`/stock_movements` (`transfer_in in_transit → t.to`); `/transfers/{id}/received`, status | computed from the transfer doc | client | enforce at dispatch |
| 3 | `fulfilRequest` (RefillQueue.jsx:405-540) | `/stock`,`/stock_movements` (`transfer_out central → dest|in_transit`, or `received` into dest); `settings/stockHold/held/{dest}/{mvId}`; `/refill_requests/{id}` qty/sentQty/status | from = `"central"` constant; to = queue `dest` prop (request's `requestingLocation`) | client | not needed (Central) |
| 4 | `fulfilSale` (RefillQueue.jsx:629-689) | `/stock`,`/stock_movements` (`transfer_out pickLoc → dest|in_transit`, `allowNegative`), held line; progress via `onSaleProgress` (App.jsx, writes `restock_requests/…`) | `pickLoc` USER-chosen among all active warehouses ≠ dest; dest = prop | client | **needed** |
| 5 | `rejectRequest` (RefillQueue.jsx:548-617), `releaseNow` (:693-703) | `/refill_requests/{id}` (txn / update), `…/blockedRefusals/{ms}` | n/a (request state) | client | — |
| 6 | `releaseShipment` (stockHoldStore.js:134-240) | `/stock`,`/stock_movements` (`transfer_in in_transit → dest`); `settings/stockHold/held|released/…`; hub-count stale marks | computed from held line | client (admin) | enforce at fulfil |
| 7 | `solve` — old path (NetworkTransfer.jsx:624-650) | qty-0 seed cells `/stock/{hub2}/{pid}/{size}` and `/stock/{store}/…` (no movement, no request) | computed: `seedLocations(card.source, store)`; store user-tappable | client | REG (hub of store) |
| 8 | `solve` — first batch (NetworkTransfer.jsx:597-622 → `buildFirstBatchSolveUpdate` firstBatchCore.js:532-578) | seed cells at `FIRST_BATCH_HUB` + store; `/refill_requests/{id}` (requestingLocation = store, source central) in ONE update. The Hub's own leg is raised later by the server trigger `firstBatchLeg` (functions/, out of scope) | computed; store nominated by `storeChoiceFor` or tapped | client + server trigger | REG |
| 9 | `undoSolve` (NetworkTransfer.jsx:155-230) | txn-cancel `/refill_requests/{id}`; txn-delete seed cells | recorded paths | client | — |
| 10 | `transfer` (NetworkTransfer.jsx:668-691) | `/stock`,`/stock_movements` (`transfer_out card.source → dest`, reason `network_rebalance`) | from computed (`central`|`hub2`); to USER-chosen from `destOptions` | client | **needed** |
| 11 | `request` / `solve` (MissingFootwear.jsx:128-191 / :227-293) | `/refill_requests/{id}` (requestingLocation = chosen hub, source central) | hub USER-chosen from `REQUESTABLE_HUBS`; qty computed (`footwearPickPlan` / `footwearSolvePlan`) | client | not needed (Central) |
| 12 | `transferTo` (MoveExcess.jsx:266-318) | `/stock`,`/stock_movements` (`transfer_out c.loc → dest`, reason `excess_rebalance`) | from = card location; to computed: `routesCfg[c.loc] || "hub2"` or `"central"`; operator picks which leg | client | REG + wall check |
| 13 | `doMove` / undo (ExcessHubToCentral.jsx:171-188, :206, :246) | `/stock`,`/stock_movements` (`hub → central`, undo `central → hub`) | hub USER-chosen from `EXCESS_HUB_LOCATIONS`; to constant | client | not needed |
| 14 | `runTransfers` (InitialDistributionWizard.jsx:158-185) | `/stock`,`/stock_movements` (`central → dest`, `initial_distribution`); batch id minted with `push(transfers)` but NO `/transfers` doc written, no transit hop | from constant; to = ticked `DISTRIBUTION_DESTS`, qty editable | client | not needed; REG |
| 15 | `saveTargets` (NoTargetQueue.jsx:284-327) | `/stock_targets/{loc}/{pid}/{size}`; then `transfer_out central → loc` per `distributionOf` | locs = ticked `dests` (routes keys); computed qty | client (admin) | not needed; REG |
| 16 | `transfer` (NoTargetQueue.jsx:348-372) | `/stock`,`/stock_movements` (`card.loc → dest`, `network_rebalance`) | to USER-chosen (default expression :350) | client | **needed** |
| 17 | `excludeHere` (NoTargetQueue.jsx:329-346), `postpone` (:242-252) | `/stock_targets/…` target 0; `/stock_targets_decisions/{loc}/{pid}` | n/a | client | — |
| 18 | `migrateToEngine` (introduceExistingCore.js:130-219) | `/stock_targets/{loc}/{pid}/{size}` in chunks; `/stock_targets_decisions/_migrations/{batch}` | dests = routes keys; hub gets every product (:175) | client (admin) | REG (section-scoped hub) |
| 19 | `moveAndSwitchOff` (seatingStore.js:382-…) | `/stock`,`/stock_movements` (`seat.loc → dest`, or reversed for negative cells with `allowNegative`); then `/stock_targets` off-rows (rest of function) | to USER-chosen in SeatingActions | client | **needed** (in `moveBlockers`) |
| 20 | `moveProduct` (CountedStockReview.jsx:177-198) | `/stock`,`/stock_movements` (`g.loc → to`) — no movementId, no transit hop | to USER-chosen (`transferTargets`) | client | **needed** |
| 21 | `onHoldRefillPlan` (onHoldRefill.js:154-180) — plan only; the write is in App.jsx | `/refill_requests/onhold_{date}_{orderId}` | hub from the order (`placedAtHub || hub`), must be in `REACTIVE_REFILL_HUBS` | client (caller out of scope) | REG |
| 22 | `raiseDisplayRequest` (displayRequestStore.js:113-198) | `/orders/{orderId}` (wall-walk order: `hub`, `destShop`), `settings/displayRows_meta/requestLocks/…`; closes display row/slot first | store USER-chosen (`STORES`); hub computed by `pickDisplaySourceHub` | client | **needed** (hub ∈ store's section) |
| 23 | `setCategoryPolicy` callable (EnginePolicyCard.jsx:91, seatingStore.js:134) | `config/refillEngine/categoryPolicy` (server) | per-location entries | callable | — (policy, not a move) |
| 24 | display registration `received` (hubCleanupStore.js:263, :396); count/adjust paths (Adjust, CountSession, SetQuantity, hubCountStore, HealthView NegativeFixChip, ProductActions, CountedStockReview adjustments); `drainQueue` sold (offlineQueue.js:97) | `/stock`,`/stock_movements` | single location | client | — |

Not in this folder but referenced by it (unclear from here, flagged rather than guessed): the store-leg (hub→shop "CR orders") fulfil and its `crMovementId`, the sale-row response/progress writers (`restock_requests/{date}`), the on-hold request write, and the `firstBatchLeg` trigger all live in `src/App.jsx` / `functions/`.

---

### 3. How the flows work today

#### Solve (Missing Products, old path)
1. `computeMissingProducts({allStock, products})` (missingProductsCore.js:122) builds cards: pids from `allStock.central ∪ allStock.hub2`; a card exists when Central has units and neither hub2 nor PE/Trophy has a stock NODE (`source:"central"`), or hub2 has units and neither shop has a node (`source:"hub2"`).
2. Per card and store, `runFor(pid)` (NetworkTransfer.jsx:377) → `resolvedRun({std, subRun, subcategory, sizes, targets, pid, ruleBasedTargets, categoryPolicy, categoryKey, unitsAnywhere})` (solvePlan.js:255) gives `{loc: {SIZE: target}}`.
3. **Which locations are seeded:** `seedLocations(source, store)` (solvePlan.js:59) → `["hub2", store]` for a Central card, `[store]` for a hub2 card.
4. **Which sizes:** `qualifyingSizes(sizes, source, store, run)` (solvePlan.js:292) — positive target at EVERY seed location.
5. **Which shop:** `storeFor(card)` = operator's tap, else `storeChoiceFor(card)` (NetworkTransfer.jsx:462) = first of `STORES` with qualifying sizes (history-ranked only on the first-batch path).
6. `solve(card)` (:554) writes qty-0 seed cells for absent sizes in one `update()` (:625-644). No request, no movement: the engine's next scan raises central→hub2 and hub2→store. `solvePlan()` (solvePlan.js:304) is only the on-screen estimate.
7. Undo: `undoSolve` (:155) with `solveUndoBlockers` / `undoCellTxn` (solveUndo.js).

#### First batch direct to shop
1. Gate: `firstBatchEligible({source, store, product, routes, enabled, hub2Present})` (firstBatchCore.js:219) — needs `FIRST_BATCH_ENABLED`, `hub2Present === false` exactly, `source === "central"`, `routes[store] === "hub2"`, product not sneaker/slide (`isSneakerOrSlide`).
2. Presence: `hub2PresenceSignals({hub2Node, hub2Locks, hub2OpenRequestIds, sinceIso, heldLines, pid})` (:176) — any prior hub2 cell, engine lock, open hub2 request or held inbound line. Inputs gathered by `readOpenLocks(pid)` (NetworkTransfer.jsx:487).
3. **Which shop:** `buildPlacementIndex({products, allStock, stores})` (:282) + `firstBatchHistory({pid, product, index, allStock, targets, stores})` (:314) → `firstBatchStoreChoice({history, candidates, labels})` (:344): own target row > style-code siblings > category placement > first candidate.
4. **Which sizes go to the shop vs stay at the hub:** `firstBatchSizeHints({history, store, sizes})` (:463) then `firstBatchSplit({sizes, run, store, centralAvail, maxUnitsPerIntent, sizeHints})` (:501); `centralAvail` = `centralFreeFor` (:440) over `centralReservedBySize({openByLoc, routes})` (:418) after `pruneClosedLocks` (:391).
5. Write: `buildFirstBatchSolveUpdate` (:532) — seeds hub2 + store for every qualifying size and creates one `/refill_requests` row per first-batch size (`requestingLocation: store`, `createdFrom.hub: "hub2"`).
6. Central picks it in `RefillQueue dest={shop}` (listed only because `isFirstBatchShopLeg`); on fulfil the server trigger raises hub2's own leg. Out-of-stock stamps `CENTRAL_DECLINED_REASON` (RefillQueue.jsx:575).

#### Missing Sneakers (MissingFootwear)
1. `computeMissingFootwear({allStock, products, hubs, heldLines})` (missingFootwearCore.js:85): footwear with Central units and zero units (stock or held) at EVERY hub in `hubs`.
2. **Which hub:** operator chip from `REQUESTABLE_HUBS`; default `[0]` = hub1 (`hubFor`, MissingFootwear.jsx:196).
3. **Qty:** Solve → `footwearSolvePlan({catalogSizes, policy: footwearRun[hub], centralCells, openSizes, reserved})` (:229); Request → `footwearPickPlan({picks, centralCells, openSizes, reserved})` (:267). `reservedFor(pid, requests)` (MissingFootwear.jsx:199) sums open requests at any of `HUBS`.
4. Writes `/refill_requests` rows only; stock moves when Central fulfils in RefillQueue.

#### MoveExcess
1. Sources = keys of `config.refillEngine.routes` (fallback `SOURCES`), stores sorted before their source (MoveExcess.jsx:72).
2. `deficitBySize` (:106-118): for every source, target − have − inbound (open requests + held lines), summed per `pid|size` across the WHOLE network.
3. Per cell (:119-158): hub2 → net excess (raw − held-for-deficit) all `toCentral`; a store → `toHub = min(raw, need)` (consuming the shared deficit), `toCentral` = rest; thresholds `storeExcessMinUnits` / 1.
4. **Which hub receives:** `routesCfg[c.loc] || "hub2"` (:268); Central otherwise. `transferTo(c, which)` re-clamps against live source and (hub leg) live hub need, then `applyMovement transfer_out`.
5. The newer hub→Central screen is `ExcessHubToCentral` over `computeHubSneakerExcess` / `computeHubClothingExcess` (excessComputation.js:237, :245), hubs from `EXCESS_HUB_LOCATIONS`, targets via `resolveTarget` (seatingCore).

#### NetworkTransfer manual move
`destOptions(card)` (NetworkTransfer.jsx:661) → Central card: `["hub2", PE, Trophy]`; hub2 card: `[PE, Trophy]`. `transfer(card)` (:668) moves the typed quantities with `applyMovement transfer_out` from `card.source`, instant (no transit hop, no `/transfers` doc).

#### NoTargetQueue / Introduce Existing
`dests = destsFrom(config)` (routes keys). NEW-at-Central cards: clothing with Central stock, no target and no cell at any dest. `saveTargets` writes explicit rows for ticked dests (hub2 always gets `effectiveRun(config,"hub2")`), optionally distributes from Central in `dests` order (`distributionOf`). `migrateToEngine` writes standard-run rows at stores that carry the product and ALWAYS at hub2.

#### Tomorrow gate / availability
`centralFedRow(order, product)` (tomorrowGate.js:128) decides whether the Central probe applies (hub1 always; hub2 only for gated footwear; hub3/hubC never). `fetchCentralAvailability` reads one Central cell; `tomorrowTapOutcome(avail)` → "tomorrow" / "out_of_stock". Shop grid gating: `gatedSneakerHub(product, routedHub)`; hub1⇄hub2 rerouting in `resolveSneakerSourcing({product, taggedHub, size, hubData, consumedByHub})`; cart allocation `allocateSneakerCart` pins display pulls to `DISPLAY_PAIR_HUB`.

#### Arming / Engine Policy / Health
Arming tab is a fixed two-hub comparison (`armingIndex` → `hubArming(ctx, HUB1|HUB2, pid)` → `bucketFor`). Engine Policy rows come from the server census (`destinations`), so they are data-driven. HealthView splits engine work into "dest === hub2" (Central queue) and "everything else" (store legs).

---

### 4. Interaction with the known open defects

**Name-keyed source queue collisions**
- refillQueueCore.js:32, :50-79 — sale rows keyed by `sourceGroupKey` (falls back to the sanitised NAME when `productId` is missing) with legacy `nameKey` dual-reads for responses and progress.
- refillQueueCore.js:130 and RefillQueue.jsx:773 — card grouping falls back to `name:${productName}`.
- sourceMovementDedupe.js:29-53 — legacy name-derived movement ids still honoured.
- sourceResponseWrites.js:25-46 — a response cell can live under two keys.
- missingFootwearCore.js:83-128 — name-keyed twin detection (display only).
- NEW collision this project would add: `sourceMovementIdSeed(date, key, size)` and the response path `restock_requests/{date}/{key}/{size}` carry NO destination. If a second sale-driven hub queue (hub3 / concrete-stockroom) shows the same product+size on the same day, the second hub's transfer would replay as an idempotent no-op and one answer would close both cells. I could not confirm how App.jsx scopes these per hub — verify there before generalising.

**Store-leg refill resize failures**
- The store-leg (hub→shop) fulfil is not in this folder (App.jsx CR orders; only `crQueueGrouping.js` id/merge helpers are here).
- In scope: RefillQueue.jsx:494-521 — a partial send rewrites `qty`/`sentQty` on the request but cannot touch the engine's lock at `/refill_engine/open` (comment :497-507 calls the desync "transient and convergent" on the next scan's resize). Any generalised hub→store fulfil that reuses this pattern inherits the same dependency on the engine's resize succeeding.
- firstBatchCore.js:262-269 documents that the engine "regrows every locked open request" on the next scan — the first-batch request quantity relies on the same resize.
- HealthView.jsx:386-396 counts store-leg work as "every dest except hub2" — a failed resize on a new section's legs would be reported under the wrong heading.

**Refill requests not clearing after a manual transfer**
- Transfer.jsx:482-489 is the only place a manual transfer closes a request, and `refillId` is never set by the UI (:247, :258 null; :338 restored draft only). Transit sends never close (:476-481).
- NetworkTransfer.transfer (:668), MoveExcess.transferTo (:266), NoTargetQueue.transfer (:348), CountedStockReview.moveProduct (:177), seatingStore.moveAndSwitchOff (:382), InitialDistributionWizard.runTransfers (:158) all move stock without touching `/refill_requests`.
- refillSatisfied.js:101-148: an UNLOCKED request is hidden as "already covered" once the shelf holds enough, but a LOCKED (engine) request stays actionable until the engine withdraws it — so after a manual transfer the row remains on the queue and can be fulfilled a second time.
- MoveExcess.jsx:92-105 nets open requests as inbound, so a stale open request also suppresses excess routing.

---

### 5. Things I could not determine from this scope
- Whether `/orders` ids and `onhold_{date}_{orderId}` are unique across stores/sections (onHoldRefill.js:164).
- How App.jsx mounts sale rows per hub (see the destination-less seed above).
- Whether "Marathon" on the order slip is correct for Concrete (print/orderSlip.js:25).
- `AUDIT_STORES` / `AUDIT_HUBS` live in `src/config/stockAudit.js`, outside this audit.
- The server twins (`functions/lib/first-batch.cjs`, `refill-engine.cjs`, `stock-audit.cjs`, `policy-groups.cjs`) are pinned equal to several constants here by tests; they were not read.

---

# Appendix B

## Store app audit — everything under `src/` except `src/components/stock/**` and `src/print/**`

Repo `/Users/junidmohammed/Documents/marathon-store-app-sections`, HEAD `7db4d910` (#660), branch `feat/sections-network`. Read-only. Non-test files only.
Line numbers were taken from `grep -n` / `sed -n` on this HEAD. Where a row gives a range, every occurrence of the literal inside that range belongs to the cluster described.

**Method.** One regex sweep for `hub1|hub2|hub3|hubC|marathon-pe|marathon-pine|trophy|'pine'|'pe'|'central'|Hub 1/2/3/C|Trophy|Marathon PE|Pine|Central|STORE_IDS|SHOP_IDS|SHOP_LABELS|shopUniverse|destShop|storeIds|stockRole|in_transit|/locations` over all 234 in-scope files, then a read of every cluster in the files that matched. `src/App.jsx` produced 528 hit lines; all were classified.

**Uncertainty flags (things I did NOT verify):**
- RTDB **rules** are not in scope (not under `src/`); every "enforced by the rule" statement below is the code comment's claim, not something I read in a rules file.
- Server callables (`functions/`) not read. Callable names and argument shapes are from the client call site only.
- `src/components/stock/**` is the other agent's. Where App.jsx calls into it (`applyMovement`, `RefillQueue`, `InitialDistributionWizard`, `locations.js`, `availabilityCore.GATED_SNEAKER_HUBS`, `reactiveRefillHubs`, `firstBatchCore`, `displaySlots`, `displayRowStore`, `onHoldRefill`, `tomorrowGate`) I record the call site only.
- I did not confirm at runtime which of `utils/stores.js` exports are dead; the grep says `nextStoreIds`, `shouldWarnNoStore`, `placesOrders`, `STORE_LABELS` have **no non-test importer in scope** (see §5).

---

### 0. The vocabularies as they exist today (one-screen map)

| Vocabulary | Where defined | Values |
|---|---|---|
| Canonical location ids (`/stock/{loc}`, `/orders.destShop`) | `src/offline/locationIds.js:41-44` (hardcoded copy of `/locations`) | base, central, hub1, hub2, hub3, in_transit, marathon-pe, marathon-pine, studio, trophy |
| POS short ids | `src/offline/locationIds.js:32-36` | pe→marathon-pe, pine→marathon-pine, trophy→trophy |
| Routing "universe" | `src/utils/stores.js:16,34-42` | central (= marathon-pe + trophy → hub1/hub2), pine (= marathon-pine → hub3). **Unknown shop defaults to `central`** (`:42`) |
| Shop ids / labels | `src/utils/stores.js:49-50` | marathon-pe "Marathon PE", trophy "Trophy", marathon-pine "Pine" |
| Hub ids incl. trial | `src/App.jsx:870` | hub1, hub2, hub3, **hubC** ("Hub C", a non-stock clothing-trial destination; still in the warehouse hub picker and deep links) |
| Insights store keys | `src/insights/rollupCodec.js:239-250` | pe, trophy, pine, other |
| Source tab keys | `src/App.jsx:16147-16148` | hub1refill, clothing (=Hub 2), trophy, marathonpe, refillhistory |
| Registry-driven (already good) | `useLocations()` + `sellableLocations/transferTargets/warehouseLocations/labelFor` from `components/stock/locations` | used by AssistantView shop toggle, ShopStockPanel, LabelPrintView, receive pickers, ClothingSold "refill from" |

The new ids `concrete` and `concrete-stockroom` appear **nowhere** in scope. `concrete-stockroom` contains a hyphen and no `hubN` pattern, so every `h === "hub3"`-style test and every `hub\d` assumption below misses it.

---

### 1. Hardcoded store / hub lists and maps

| file:line | what it does | change needed |
|---|---|---|
| `src/utils/stores.js:16` | `STORE_IDS = ["central","pine"]` — the routing universes; also the domain of `/users/{uid}.storeIds` | Replace with sections from the registry (`section1`/`section2`), or retire in favour of a per-user `section` field |
| `src/utils/stores.js:18` | `STORE_LABELS` {central, pine} | Registry. No in-scope importer found (print/orderSlip.js has its own private copy at `:21`, other agent's scope) |
| `src/utils/stores.js:34-38` | `SHOP_TO_UNIVERSE` shop → universe | Registry: shop → section. Add `concrete` |
| `src/utils/stores.js:42` | `shopUniverse()` — unknown shop → `"central"` | **Must stop defaulting.** With a section wall an unmapped shop silently joining Section 2 is the dangerous direction; return null and fail closed |
| `src/utils/stores.js:49-50` | `SHOP_IDS`, `SHOP_LABELS` (3 shops) | Registry `kind:"store"` rows. Add `concrete`. Consumers: UserManagement, DisplayChecks ×4, App.jsx |
| `src/offline/locationIds.js:32-36` | `SHORT_TO_CANONICAL` pe/pine/trophy | Registry field (`posId`). Decide Concrete's POS short id |
| `src/offline/locationIds.js:41-44` | `CANONICAL_LOCATION_IDS` — closed list the mirror accepts as `/stock` row keys; anything else is **recorded and skipped** (`sync.js:71,227`, `changeFeed.js:46,167-171`) | **Blocking for the new locations**: `concrete` and `concrete-stockroom` stock would be dropped from every mirrored device until added. Derive from the mirrored `/locations` leg (`offline/nodes.js:110`) or add both ids |
| `src/push/pushAssignments.js:66-67` | `PUSH_HUBS = [hub1,hub2,hub3]`, `PUSH_HUB_LABEL` — the closed list that defines the assignment record shape, the index writes and the card's switches | Add `concrete-stockroom` (or derive from registry hubs). File comment `:57-63` says this list is the single edit that adds a hub |
| `src/push/pushConfig.js:86-95` | `AUDIENCE_BUCKETS` (legacy; all, hub1-3, central, 3 shops) — walked only to null out `/push_audience` | Leave (legacy drain) |
| `src/push/pushConfig.js:98-106` | `HUB_LABEL` destination → words in a notification | Registry labels; add the two new ids |
| `src/push/deepLink.js:38` | `VALID_TABS = {hub1refill, clothing, refillhistory}` for Source deep links | Add section-1 tabs if Source gains them |
| `src/push/deepLink.js:46` | `VALID_HUBS = {hub1,hub2,hub3,hubC}` — a push link naming any other hub is dropped | Add `concrete-stockroom` or derive |
| `src/config/displayChecks.js:53-57` | `DISPLAY_CHECKS_STORE_FLAGS` PE true, Trophy true, Pine false | Registry flag per store; add `concrete` |
| `src/config/stockAudit.js:19-22` | `AUDIT_STORES` PE, Trophy (must match `functions/lib/stock-audit.cjs`) | Registry; server twin must change with it |
| `src/config/stockAudit.js:28-31` | `AUDIT_HUBS` hub1, hub2 ("Hub 3 serves Pine, out of scope") | Registry; decide whether Section 1 hubs are audited |
| `src/config/stockAudit.js:37-42` | `LOCATION_LABEL` (4 entries) | Registry labels |
| `src/config/assistantVisibility.js:54` | `DEFAULT_DEACTIVATED_SHOPS = {"marathon-pine": true}` — Pine sees deactivated products | Keep as data; decide Concrete's default (hub3 "uncounted" reasoning may extend to Section 1) |
| `src/utils/clothingSold.js:53` | `CLOTHING_SOLD_STORES = [marathon-pe, trophy, marathon-pine]` — the per-store tabs of Clothing Sold | Registry stores; add `concrete`; scope to the viewer's section |
| `src/utils/newProductRecord.js:28` | `VALID_HUBS = [hub1,hub2,hub3]` for a product's `hubs` tag | Registry hubs; add `concrete-stockroom` |
| `src/components/layby/contract.js:65` | `DEFAULT_STORAGE_HUB = "hub1"` — a layby with no `storageHub` belongs to hub1 | Keep as legacy default; POS must stamp `storageHub` for Section 1 |
| `src/components/social/socialCore.js:312` | `BRANCH_NAMES = ["Marathon PE","Pine","Trophy"]` — caption filter refusing branch names in a locational frame | Add "Concrete" (it is also an ordinary word — same trap the comment at `:293-295` describes) |
| `src/insights/rollupCodec.js:250`, `rollupStore.js:97,283`, `useInsightsWindow.js:159` | Totals shape `{pe, trophy, pine, other}` | Add `concrete` bucket or key by shop id; rollup docs already written carry the old shape (versioning needed — not verified how the sweep versions) |
| `src/App.jsx:870` | `HUB_LABELS` hub1/2/3/hubC | Registry |
| `src/App.jsx:876-877` | `CR_HUB_BY_UNIVERSE = {central:"hub2", pine:"hub3"}`, `CR_HUBS` — **the** shop→clothing-hub map | Registry: per section "back-stock hub for shoes/clothing". Decide which of hub3 / concrete-stockroom serves which Section 1 shop |
| `src/App.jsx:884` | `STOCK_HUBS = [hub1,hub2,hub3]` (return origin validation) | Registry hubs |
| `src/App.jsx:2261` | `HELD_DISPATCH_HUBS = new Set(["hub2"])` — hubs whose Ready is held 6 min | Registry flag (`dispatchHoldMs`) |
| `src/App.jsx:7968` | Product editor hub chips `[hub1,"Hub 1"],[hub2,"Hub 2"],[hub3,"Hub 3 — Pine"]` | Registry |
| `src/components/admin/NewProductForm.jsx:339` | Same three hub chips on the Add Product form | Registry |
| `src/App.jsx:12278` | Warehouse hub picker `[hub1],[hub2],[hub3],[hubC]` | Registry hubs, filtered to the user's/device's section |
| `src/App.jsx:12700` | `VALID_HUBS = [hub1,hub2,hub3]` inside `recordDispatchTransfer` | Registry hubs |
| `src/App.jsx:13246-13252` | Warehouse tab set per hub (hubC / hub2 / hub3 / else) | Registry capability flag (`hasCR`) — the code already has `CR_HUBS` but this ternary re-hardcodes it |
| `src/App.jsx:13484` | Inline `{hub1:"Hub 1",hub2:"Hub 2",hub3:"Hub 3"}` label map | Registry |
| `src/App.jsx:14511` | CR Orders store pills `all / marathon-pe / trophy` (no Pine) | Stores of the selected hub's section |
| `src/App.jsx:16147-16150` | `SOURCE_SHOP_TABS` trophy, marathon-pe; `SOURCE_TABS`; `SOURCE_SHOP_BY_TAB`; `SOURCE_SHOP_LOCS` | Registry: Central's direct-to-shop lanes |
| `src/App.jsx:16398` | `counts = {hub1:0, hub2:0, trophy:0, "marathon-pe":0}` Source badges | Derive from tabs |
| `src/App.jsx:18047` | Insights "Stock Depleted" hub filter `all / hub1 / hub2` | Registry hubs |
| `src/App.jsx:18927`, `19023` | Insights store filter `all / marathon-pe / trophy / pine` (declared twice; `:18927` `STORE_OPTS` and an inline copy at `:19023`) | Registry stores, optionally grouped by section |
| Imported, defined in the other agent's scope | `GATED_SNEAKER_HUBS` (`App.jsx:126`, used 9649-9668, 10096-10098, 12849-12885), `REACTIVE_REFILL_HUBS` (`:15`, used 16298, 16401, 16419) | Note only |

---

### 2 + 3. Literal location names in logic, and every location branch — per file

#### `src/App.jsx` (20,969 lines)

**Module-level helpers**

| file:line | what it does | change needed |
|---|---|---|
| `138` | imports `shopUniverse, SHOP_LABELS` | follow §1 |
| `862-880` | Product `hubs` model comment + `HUB_LABELS`, `CR_HUB_BY_UNIVERSE`, `CR_HUBS`, `getProductHubs` | Registry |
| `884-919` | `STOCK_HUBS`; `resolveReturnDestination` validates origin hub against it | Registry |
| `946-992` | `useOrders(scopeShop)` — when the user has a `destShop`, the read is `orderByChild("destShop").equalTo(scopeShop)`; mirror path filters locally on the same field | Section scoping needs a second axis: a warehouse user with no destShop reads ALL of `/orders`. A section-scoped hub user needs a query by section or by `placedAtHub` |
| `1048`, `1089-1092` | TV orders read is a key range `"0".."9"`, not location-scoped | **One TV per shop is not possible today**: the board shows every customer order network-wide. Needs a shop/section filter |
| `2256-2275` | `HUB2_DISPATCH_HOLD_MS`, `HELD_DISPATCH_HUBS`, `holdHub2Ready()` (used at 14626 CustomerView, 20587 TV) | Hub-2-specific by name; behaviour keys off `notifyReadyAt` so only the set at 2261 decides. Decide for concrete-stockroom/hub3 |

**Home / RoleSelector (3232-3640)**

| file:line | what it does | change needed |
|---|---|---|
| `3264-3267` | Display Checks tile: viewer `destShop` is the store scope; super-admin passes null | Works for Concrete once flags/labels are registry-driven |
| `3369` | Comment: Total Stock "everywhere except Pine and Hub 3" (logic is in stock/NetworkTotals) | other agent |
| `3533`, `3591`, `15117`, `19264-19286`, `19384`, `19415` | Brand word "Marathon" in UI copy / privacy page | No change (brand, not location) |

**Admin product create / edit (5928-8030)**

| file:line | what it does | change needed |
|---|---|---|
| `5955`, `6618` | New-product form default `hubs:["hub1"]` | Default from registry/section |
| `6610`, `7671` | `if (recvLoc === "central")` → open Initial Distribution wizard | Use registry `kind`/role ("supplies all sections") not the literal |
| `6656-6681` | Clothing may not be tagged hub1; falls back to `["hub2"]`, sneakers to `["hub1"]` | Registry: "sneaker-only hub" flag. Section 1 equivalent undefined |
| `7471-7502` | Same rule in the editor (`isClothing && h === "hub1"`) | same |
| `7968-8002` | Hub chips + "Clothing cannot be stocked at Hub 1." | Registry |

**Shop stock / refill tracking (8229-8540)**

| file:line | what it does | change needed |
|---|---|---|
| `8285-8286` | `sellableLocations(registry)`; fallback default `"marathon-pe"` | Registry-driven already; fallback literal should go; filter to section |
| `8427` | Refill tracking filters `customerName === "Shop Refill" && destShop === shop` | fine |
| `8512-8536` | Refusal copy defaults `hubLabel || "Hub 1"`; "isn't at Hub 1 or Hub 2 right now" | Copy must name the section's hubs |

**AssistantView (9388-11800)** — the densest cluster

| file:line | what it does | change needed |
|---|---|---|
| `9416-9427` | Shop picker from `sellableLocations(registry)`; persisted in `localStorage.storeAssistantShop`; legacy migration `storeAssistantMode === "pine" ? "marathon-pine" : "marathon-pe"` | Registry-driven; default literal goes |
| `9436-9461` | **Scoping**: `destShop` locks to one shop; else `allowedStores.includes(shopUniverse(s.id))`; `effectiveStoreMode = shopUniverse(effectiveShop)` | Replace universe with section. This is where a section-scoped user/device gets its shop list |
| `9468-9469` | `servingHub = CR_HUB_BY_UNIVERSE[mode] || "hub2"`; subscribes `stock/{servingHub}` | Registry; the `|| "hub2"` fallback crosses the wall for an unmapped Section 1 shop |
| `9509`, `9524` | `useStockCellsState(mode === "pine" ? null : "hub1"/"hub2")` — Pine devices skip hub1/hub2 subscriptions | Section's gated hubs from registry |
| `9548-9571` | `hub1ReadyPromised`, `hub1PullPromised`, `hub1Promised`, `hub2ReadyPromised` | Generalise to a per-hub map |
| `9578` | `useDisplaySlotsState(mode !== "pine")` — Pine never reads display slots | Section flag |
| `9631-9675` | Display-pair pull is hub1-only; `displayUnitsByHub.hub1` | Hub-1-specific feature; decide for Section 1 |
| `9731-9767` | Shop-switch red confirm + first-placement destination affirm (for multi-shop users) | Keep; a section-scoped user with 2 shops still needs it |
| `9775` | Tracking count by `destShop === effectiveShop` | fine |
| `9837-9880` | Sneakers store-gated: central shows hub1/hub2 products, Pine hub3 (implemented in `assistantCatalogue.js:44-48`); Pine deactivated exemption | Registry: product hubs ∩ section hubs |
| `9939-9946` | `computeHubForItem`: `mode === "pine" → "hub3"`, else product's hub1/hub2 tag, default `"hub1"` | **Core routing rule.** Registry: section → hubs; default hub per section |
| `9971-9994` | `sneakerCellsState(hub)`, `sneakerPromisedMap(hub)` ternaries on `"hub2"`; gate object `{hub1:…, hub2:…}` | Per-hub map |
| `10060-10098` | `sneakerServedByHub1`, `sneakerAvail(pid,size,hub="hub1")`, `pullOnly: hub === "hub1"`, `checkedBoth` over `GATED_SNEAKER_HUBS` | Generalise |
| `10279` | `["hub1","hub2"].some(...)` loading test | `GATED_SNEAKER_HUBS` / section hubs |
| `10532-10581` | Checkout pre-flight for display-pair pulls against `hub1DisplayUnits` | Hub-1-specific |
| `10702-10708` | `placedHub` = clothing → `CR_HUB_BY_UNIVERSE[mode] || "hub2"`; sneakers → cart allocation or `computeHubForItem` | Registry; same fallback hazard |
| `10731-10739` | Order stamps `hub`, `placedAtHub`, `placedStore` (universe), `destShop` | Add `section` stamp so rules/readers can enforce the wall |
| `10826-10829`, `10964-10967` | `insights_log` event stamps `placedAtHub`, `destShop` | add `section` if reports group by it |
| `10874-10945` | `placeRefillRequests` — see §4 | |
| `11119-11134` | Shop toggle rendered from `availableShops`, labels from registry | already registry-driven |
| `11491-11574` | Comments only (Hub 1 / Hub 2 ✕ behaviour; Display Partner routes to Hub 1) | — |

**TomorrowActionButton (11801-11890)**

| file:line | what it does | change needed |
|---|---|---|
| `11823-11869` | "Central-fed rows only" — hub1 and hub2 probe Central's cell before offering Tomorrow; hub3/hubC skip the probe (`centralFedRow` from stock/tomorrowGate) | Brief says Central supplies both sections → hub3 / concrete-stockroom become Central-fed. Registry flag |

**WarehouseView (11895-13910)**

| file:line | what it does | change needed |
|---|---|---|
| `11914` | `selectedHub` from `localStorage.warehouseHub` — **any user with the `warehouse` permission can pick any hub**; nothing ties a user or device to a hub | Section scoping must clamp the picker and reject a persisted hub outside the section |
| `11925-11927` | Tab clamp: CR tab only on `CR_HUBS`; `hubC` only has the queue | Registry |
| `11936-11938` | `orderInHub`: hub3/hubC match on `placedAtHub`; others on `(o.hub || "hub1")` | Unify on `placedAtHub`; the `|| "hub1"` default puts hub-less orders in Section 2 |
| `12027-12029`, `12066` | Display-pair revive / pull lane only when `selectedHub === "hub1"` | Hub-1-specific |
| `12168`, `12211` | CR batches filter `(placedAtHub || hub || "hub2") !== selectedHub` | default-to-hub2 hazard |
| `12173-12191` | CR grouping key includes `destShop`; `destShop` drives the transfer | fine |
| `12265` | `useStockCells(CR_HUBS.includes(selectedHub) ? selectedHub : "__off__")` | Registry |
| `12278` | Hub picker (4 literals) | §1 |
| `12303`, `13066` | Layby filter `(storageHub || DEFAULT_STORAGE_HUB) === selectedHub` | fine once hubs are registry |
| `12354`, `12368`, `12381`, `12495`, `12525`, `12968`, `16800` | `order.placedAtHub || order.hub || "hub1"` default (reject count, slot bookedHub, hold test, refill hub, insights stamps) | Seven copies of one default; replace with one resolver that returns null for unknown |
| `12381` | `isHeldReady = READY && HELD_DISPATCH_HUBS.has(...)` | §1 |
| `12693` | `toShop = order.destShop || (placedStore === "pine" ? "marathon-pine" : null)` | Legacy inference; keep, add nothing |
| `12700-12701` | `VALID_HUBS` guard in dispatch | §1 |
| `12849-12885` | Display row ledger only for `GATED_SNEAKER_HUBS`; Pine/hub3 keeps slot-only path | Decide for Section 1 |
| `13084-13108` | CR fulfil: `store = batch.destShop`, `from = it.placedAtHub || "hub2"` | see §4 |
| `13168`, `13202` | `hub: it.placedAtHub || "hub2"` (reject count; CR undo destination) | default hazard |
| `13246-13252` | Tab sets per hub | §1 |
| `13484` | Inline hub label map | §1 |
| `13776`, `13874` | `selectedHub !== "hubC"` hides Layby | hubC trial |

**CR tab / misc (14200-14600)**

| file:line | what it does | change needed |
|---|---|---|
| `14511` | Store pills hardcoded PE / Trophy | §1 |
| `14593-14596` | `shopLabelFor`: `SHOP_LABELS[destShop]`, else `placedAtHub === "hub3" → "Pine"` | Registry label; the hub3→Pine inference becomes wrong once hub3 also serves Concrete |

**Clothing Sold (15440-16110)**

| file:line | what it does | change needed |
|---|---|---|
| `15835`, `15884-15888`, `15910` | Tabs = `CLOTHING_SOLD_STORES` (+ Backlog), labelled by `SHOP_LABELS` | Registry + section filter |
| `15860` | `canTransfer = ["store","warehouse","admin"].includes(actorRole)` | — |
| `15865-15870` | "Refill from" = **any non-store location in the registry, user-picked, no default** | **Wall hole** — see §4 |

**SourceView (16113-16660)**

| file:line | what it does | change needed |
|---|---|---|
| `16119`, `16125` | Tab icons keyed `hub1refill`, `trophy` | cosmetic |
| `16147-16150` | Source tabs: Hub 1 Refill, Hub 2 Refill, Trophy, Marathon, Refill History | Registry. Source (Central) supplies both sections, so it needs Section 1 lanes: hub3, concrete-stockroom, and possibly pine/concrete direct |
| `16153-16160` | Default tab `"hub1refill"`; `hub2Line` sneakers/clothing toggle | Hub-2-specific toggle |
| `16294-16299`, `16341`, `16402` | `(e.hub || e.placedAtHub || "hub1") === h` over `REACTIVE_REFILL_HUBS` | default hazard |
| `16398`, `16433-16436` | Badge counts keyed hub1/hub2/trophy/marathon-pe | Derive |
| `16503-16504`, `16517-16526`, `16549-16552` | `activeHub = tab === "hub1refill" ? "hub1" : tab === "clothing" ? "hub2" : null`; hub2-only line toggle; `RefillQueue dest={SOURCE_SHOP_BY_TAB[tab]}` | Map tab → location from registry |
| `16562-16567`, `16642` | Badge lookup by the same literals (twice: mobile + desktop) | Derive |

**Insights (17035-19090)**

| file:line | what it does | change needed |
|---|---|---|
| `18030`, `18047` | Depleted tab hub label/filter hub1, hub2 only | Registry |
| `18758-18763` | `matchesStore`: pine = `destShop === "marathon-pine" || placedAtHub === "hub3"`; trophy; PE = own destShop OR untagged non-hub3 history | **`placedAtHub === "hub3"` ⇒ Pine breaks** when hub3 also serves Concrete: every Concrete order would count as Pine. Same logic duplicated in `rollupCodec.js:240-242` |
| `18782` | `key = storeFilter === "marathon-pe" ? "pe" : storeFilter` | Key by shop id |
| `18927`, `19023` | Store filter options | §1 |

**AppInner / TV (19961-20969)**

| file:line | what it does | change needed |
|---|---|---|
| `19992-19995` | Display Checks route gate with `destShop` | fine |
| `20124-20125` | `myShop = isSuperAdmin ? null : permRecord.destShop`; `useOrders(myShop)` | Add section scope here — this is the single authenticated orders feed |
| `20391` | `StockView … ordersScope={myShop}` | other agent consumes it |
| `20577-20587` | TV applies `holdHub2Ready` to every order | fine |

#### `src/utils/stores.js` — see §1 and §5. Whole file is the universe model.

#### `src/offline/locationIds.js` — see §1. `:54-58`, `:66-70`, `:85-89` are the strict resolvers (unknown → null / throw).

#### `src/offline/*` (other files)

| file:line | what it does | change needed |
|---|---|---|
| `sync.js:71,227`; `changeFeed.js:46,167-171` | `/stock` change rows whose location is not `isCanonicalLocationId` are skipped | Follows `CANONICAL_LOCATION_IDS` |
| `sync.js:324-326`; `changeFeed.js:134-137` | A `destShop`-bound account cannot whole-read `/orders`; the leg is marked not-permitted instead of failing | A section-scoped rule on `/orders` (or `/stock`) will need the same treatment per leg, or section-bound devices freeze (that was incident #627-#634) |
| `nodes.js:110` | `/locations` is a mirrored leg | The registry is already on every device — the new Network card's data will arrive through this leg if it lives under `/locations` |
| `nodes.js:126` | `/stock` mirrored one location per page, **all locations** | Section-scoped devices would still download the other section's stock unless the leg is filtered |
| `health.js:349,425` | `STORE_SCOPED_LEGS` need `{storeId}` (ported from POS; comment example uses `"pe"`) | I did not trace whether the store app passes a storeId here — flag |
| `bounded.js:43-44`, `localReads.js`, `pendingWrites.js`, `staging.js` | Comments/examples only | none |

#### `src/push/*`

| file:line | what it does | change needed |
|---|---|---|
| `pushAssignments.js:66-67,101-153` | Closed hub list; record + index built from it | §1 |
| `pushConfig.js:80` | `push_bursts/{hub}` server-owned | — |
| `pushConfig.js:86-106` | Legacy buckets; `HUB_LABEL` | §1 |
| `pushConfig.js:119-120` | Deep-link tab names `clothing` / `queue` (mirrored in `functions/lib/order-push.cjs`) | — |
| `deepLink.js:35-46,94-118` | Writes `localStorage.marathon_role`, `warehouseHub`, `tabState:warehouse` from the push URL; hub validated against `VALID_HUBS` | A push link can set `warehouseHub` to any valid hub — must respect section scope |
| `PushAssignmentsCard.jsx:117,667` | One switch per `PUSH_HUBS` entry per person; rows show `stockRole` and `destShop` (`:283-284,616-617`) | Derived; group by section |
| `staffRoster.js:53-89` | Till-login detection: `stockRole === "pos"` and no store-app identity (`destShop` counts as identity, `:71`) | — |
| `registerPush.js:126-131,239,325` | Nulls every legacy bucket on each load | — |

#### `src/config/*`

| file:line | what it does | change needed |
|---|---|---|
| `displayChecks.js:53-57,64-66,83-110` | Store flags; gates take `user.destShop === storeId` | §1 |
| `stockAudit.js:19-43` | Audit stores/hubs/labels | §1 |
| `assistantVisibility.js:51,54,86-89`; `useAssistantVisibility.js` | `/config/assistantView/showDeactivatedShops/{shopId}`; default Pine | §1 |
| `enginePolicy.js:112-153`, `hubSneakerCount.js:56-123`, `stockHold.js:26-52` | Gates only (email / permFlags / stockRole); no location literals in logic | §5/§6 |

#### `src/components/assistant/assistantCatalogue.js`

| file:line | what it does | change needed |
|---|---|---|
| `44-48` | `storeMode === "pine"` → product must be tagged hub3; else a tagged product must include hub1 or hub2 (untagged visible to central) | Registry: section hubs. Core sneaker visibility rule |

#### `src/components/admin/NewProductForm.jsx`, `src/utils/newProductRecord.js`

| file:line | what it does | change needed |
|---|---|---|
| `NewProductForm.jsx:269` | Receive-into picker = `transferTargets(registry)` | registry-driven |
| `NewProductForm.jsx:339-359` | Hub chips; clothing barred from hub1 | §1 |
| `newProductRecord.js:28-40` | `VALID_HUBS`; `normaliseHubs` strips hub1 for clothing, defaults `["hub2"]` / `["hub1"]` | §1 |

#### `src/components/UserManagement.jsx`

| file:line | what it does | change needed |
|---|---|---|
| `43`, `436-440` | Row badge `SHOP_LABELS[user.destShop]` | Registry |
| `789-812` | "Store Access" radio: All stores / each `SHOP_IDS` → writes `destShop` | Add a **Section** radio beside it; add `concrete` |

#### `src/pages/DisplayChecks/*`

| file:line | what it does | change needed |
|---|---|---|
| `index.jsx:48-50` | `ENABLED_STORES` from the flag map + `SHOP_LABELS` | Registry |
| `index.jsx:103-110` | `store = isSuper ? superStore : permRecord.destShop` | fine |
| `AvailabilityView.jsx:21,162,192,203` | `otherStoreIds = SHOP_IDS.filter(s => s !== storeId)` — shows **other shops' floor stock** | **Section wall (visibility)**: should list only shops in the same section, or it invites cross-section asks |
| `AnalyticsView.jsx:14,88`; `SettingsView.jsx:15,66-69,119,157` | Labels; staff list = users with `destShop === store` | Registry labels |

#### `src/insights/*`

| file:line | what it does | change needed |
|---|---|---|
| `rollupCodec.js:40,71,89` | `destShop` is a dictionary-coded field in the rollup | fine |
| `rollupCodec.js:239-250` | `storeKeyOf(e)`: pine / trophy / pe / other — same rules as App.jsx 18760-18762 | Add concrete; fix hub3⇒pine |
| `rollupStore.js:88-97,283`; `useInsightsWindow.js:159` | Totals shape | §1 |

#### `src/utils/insights.js`

| file:line | what it does | change needed |
|---|---|---|
| `234` | `(e.placedAtHub || "hub1") === hub` | default hazard |
| `263`, `268` | `placedAtHub !== "hubC"` excludes Hub C customer clothing from clothing-refill metrics | hubC trial |

#### `src/utils/deactivation.js` — `:73-75,103` comments about the Pine exemption; the predicate takes a boolean. No literal in logic.
#### `src/utils/dispatchNegativeGate.js`, `footwearLine.js`, `productTaxonomy.js:133`, `tvOrdersRange.js` — comments only. No change.
#### `src/components/layby/*`

| file:line | what it does | change needed |
|---|---|---|
| `contract.js:65`; `LaybyTab.jsx:36,42,256,261` | `hubOf(x) = storageHub || "hub1"`; lists filter by `selectedHub` | §1 |
| `useLayby.js:77-144` | Writes `laybys/{id}` and `laybyPulls/{id}` with `receivedBy/sentBy/returnedBy/rejectedBy = hubLabel` | Not a stock move; hub id is an actor stamp |

#### `src/components/cardrecon/*`

| file:line | what it does | change needed |
|---|---|---|
| `CardReconScreen.jsx:545` | Card label `t.label || \`${t.storeId} · ${t.tillId}\`` — terminals come from the server registry, **no hardcoded store list in the client** | Concrete's 2 tills are added through TerminalSettings (data), not code. Per memory the store key is a POS join key (`pe`) — Concrete's key must be chosen to match POS |
| `CardReconScreen.jsx:56,462`; `terminalRegistry.js:35`; `TerminalSettings.jsx:162` | Comments / placeholder "Trophy Till 2" | none |
| No store tabs or per-store branch in the capture UI | — | A section-scoped capturer would need a filter on `t.storeId` (none exists) |

#### `src/components/LabelPrintView.jsx`
| `46,62-63` | Store filter from `sellableLocations(useLocations())` | registry-driven; add section filter |

#### `src/components/social/socialCore.js` — `:293-312` `BRANCH_NAMES`. §1.
#### `src/components/TvDisplayMockup.jsx` — every "trophy" hit (`19,25,341-350,450-455,646-650`) is the World Cup **trophy image**, not the shop. No change.
#### `src/device/*` — "Hub 2" appears only in comments/placeholders (`DeviceCodesCard.jsx:6,140`, `deviceRejects.js:3`, `rejectCount.js:2`). Reject records carry a `hub` field (`deviceRejects.js:62`).
#### Files with hits that are comments only, no logic: `admin/DuplicateSuggestPanel.jsx:91`, `admin/productSave.js:71`, `admin/useStyleCodeConfig.js:2`, `AssistantLabelFinder.jsx`, `hiddenCards.js:9`, `permissionCatalog.js`, `shopify/*`, `config/styleCode.js`, `utils/styleCodeClaim.js`.

---

### 4. Cross-location WRITE paths (in scope)

All stock movement goes through **`applyMovement`** (`src/components/stock/applyMovement.js`, other agent) — **client-side**, writing `/stock_movements/{movementId}` plus the `/stock/{loc}/{pid}/{size}` cells. There is **no callable** for a stock move anywhere in scope. A section wall therefore has to live in (a) `applyMovement` itself, and (b) the RTDB rules; the call sites below only decide what from/to they pass.

| # | Function (file:line) | Type / RTDB paths | from → to | Chosen how | Wall risk |
|---|---|---|---|---|---|
| 1 | `recordDispatchTransfer` (`App.jsx:12669-12745`, called from Send at `12599`) | `transfer_out`; `stock_movements/disp_{orderId}_{createdAt}`, `stock/{hub}`, `stock/{shop}` | `order.placedAtHub || order.hub` → `order.destShop` (legacy: `placedStore==="pine"` → marathon-pine) | **Computed** from the order. Footwear short-circuits (no move, sells from hub) | Hub and shop were both stamped at placement from the same shop, so consistent **if** placement is. No check that hub and shop share a section |
| 2 | `fulfillCRBatch` → `fireCRRefill` (`13077-13137`, `1709-1719`) | `transfer_out`, reason `clothing_cr`; id `crMovementId("cr",…)` | `it.placedAtHub || "hub2"` → `batch.destShop` | Computed from the order line | The `|| "hub2"` default would send Section 2 stock to a Section 1 shop for a line with no hub |
| 3 | `fireCRUncounted` (`1736-1746`, called `13135`) | `received` (+shop only, no source) reason `clothing_cr_uncounted` | → `batch.destShop` | Computed | Not a cross-location move, but mints stock at a shop from any hub's screen |
| 4 | `reverseCRRefill` (`1722-1732`, called `13202`) | `transfer_out` reason `clothing_cr_undo` | `batch.destShop` → `it.placedAtHub || "hub2"` | Computed | same default |
| 5 | `reverseCRUncounted` (`1751-1761`, called `13206`) | `adjustment` (−shop); admin only per rules comment | shop only | Computed | none |
| 6 | **`fireClothingRefill`** (`1651-1660`, called from `ClothingRefillSheet` `15547`) | `transfer_out` reason `CLOTHING_REFILL_REASON`, link `clth_{store}_{pid}` | **`refillFrom` → `group.store`** | **from is USER-CHOSEN** from every non-store registry location (`15865-15870`); to is the sale's store | **The clearest wall hole in scope**: a user on the Trophy tab can pick hub3 (or `central`, `base`, `studio`) as source. Needs the picker filtered to the store's section + Central, and a guard in the writer |
| 7 | `reverseClothingRefill` (`1666-1677`, called `15946`) | `transfer_out` undo; id `clthundo_{batch}_{size}` | `undo.store` → `undo.from` | Computed from the forward move | mirrors #6 |
| 8 | `submitReturn` (`16718-16760+`) — **retained, not wired to any UI** (comment `16709-16716`) | `transfer_out` reversing `disp_…`; id `ret_…`, `allowNegative` | `disp.to` → `disp.from` (read from the ledger row) | Computed | Dormant |
| 9 | Receive on create / edit (`6575`, `7644`; picker `7838`, `NewProductForm.jsx:269`) | `received`; also `setCellState(recvLoc,…,"live")` at `6562` | → `recvLoc` | **User-chosen** from `transferTargets(registry)`, no default | Single-location, not a transfer. A section-scoped admin could receive into the other section |
| 10 | Initial Distribution wizard (opened at `6610`, `7671`, rendered `~7002`, `~8015`) | in `components/stock/InitialDistributionWizard` | Central → hubs/shops | other agent | Central supplies both, so allowed; destinations still need section awareness |
| 11 | `RefillQueue dest={…}` (`16552`) and the hub tabs via `hubTabContent` | in `components/stock/RefillQueue` | Central → hub1/hub2/trophy/marathon-pe | other agent; `fulfilCtx.knownLoc` (`16210`) only checks the id is a registered transfer target | Source is Central → allowed by the brief |

**Requests / non-stock writes that name two locations**

| # | Function (file:line) | Paths | Locations | Notes |
|---|---|---|---|---|
| 12 | `placeOrders` → `writeOrder` (`10663-10832`, `1104-1140`) | `set orders/{NNN}`; `push insights_log` | `hub`/`placedAtHub` computed (`10702-10708`), `placedStore` = universe, `destShop` = picked shop | Client-side. The hub comes from `cartAllocation.hubOf` (stock-aware, gated hubs) or `computeHubForItem` |
| 13 | `placeRefillRequests` (`10877-10975`) | `set orders/R{nnn}-{i}` | `placedHub = CR_HUB_BY_UNIVERSE[mode] || "hub2"`, `destShop` = picked shop | Client-side |
| 14 | `updateOrder` / `updateStatus` (`1147-1150`, `~12340-12600`) | `update orders/{id}` (+ `stamps/…`) | — | Any warehouse user on any hub screen can act on that hub's orders |
| 15 | On-hold refill ask (`12404-12436`) | `set/update refill_requests/{requestId}` | built by `onHoldRefillPlan(order)` (stock/onHoldRefill) against the order's own hub | Client-side, create-if-absent |
| 16 | `saveSourceResponse` / `saveSourceFulfilProgress` (`1536`, `1545`; called `16215-16217`) | `restock_requests/{date}/{productKey}/{size}` | date/product keyed, not location keyed | — |
| 17 | `saveClothingOut` / `clearClothingOut` (`1633-1645`) | `clothing_sold_refills/{store}/{pid}/{size}` = `{outHub, at, by}` | store + user-picked hub | marker only |
| 18 | `setDisplaySlot` / `clearDisplaySlot` (`9711-9712`, `10799`, `12366`, `12933`); `sendDisplayRow` / `closeDisplayRow*` (`10789`, `12892`, `13021`) | `/settings/displaySlots`, `/settings/displayRows` (per code comment at `11897`; writers are in stock/) | `store`, `bookedHub` | Facts, not stock. `bookedHub` defaults to hub1 (`12368`) |
| 19 | `updateProductHubs` (`925-929`) | `products/{id}/hubs` | hub tags | Decides which section can see/order a sneaker |
| 20 | Layby writers (`layby/useLayby.js:77-144`) | `laybys/{id}`, `laybyPulls/{id}` | hub as actor label | no stock |
| 21 | `countReject` (`device/rejectCount.js:27-37`) | `device_enrolment/devices/{id}/rejectCount` (increment), `device_rejects/{day}/{deviceId}/…` | carries `hub` | telemetry |
| 22 | `logRestock` (`1436-1438`) | `restock_log/{date}` | — | unused in this app (POS writes it) |

**Callables in scope (none move stock):** `sendWhatsApp` (210, 2353), `generateProductPhotos`, `cleanProductNames`, `setProductType` (7193), `analyzeReorderNeeds`, `getBroadcastGroups`/`sendBroadcast` (us region), `pickupVoice`, `productIdentity`, `enrolDevice`, `deviceEnrolmentAdmin`, `createStaffUser`/`deleteStaffUser`/`updateStaffPassword`, `resolveStyleCode`, `labelAlias`, `readStyleCodeLabel`, `cardBatchCapture`, `cardTerminalAdmin`, `generateSocialPosts`, `completeDisplayCheck`.

---

### 5. How users and devices are scoped today

#### `/users/{uid}` fields read by this app

| field | read at | written at | meaning |
|---|---|---|---|
| `permissions: string[]` | `AuthGate.jsx:226,230` → `hasPermission` | `UserManagement.jsx:615` (preset), toggle `~630-646`; `createStaffUser` callable `:1112-1119` | App-tile grants; mapped by `ROLE_TO_PERMISSION` (`App.jsx:426-447`) |
| `permFlags` (scalar mirror of permissions) | `App.jsx:3239, 20474` (engine policy), card recon server-side | `UserManagement.jsx:615` `permFlagsFor(perms)` | What callables/rules check |
| `role` | presets only | `UserManagement.jsx:615, 1116` | admin / store_assistant / warehouse (`:66-70`) |
| `stockRole` | `App.jsx:19999, 16170`; many gates | `UserManagement.jsx:657-664`, auto-link `632-637`, self-grant `262-269` | `"" / store / warehouse / pos / admin` (`:88-94`). Gates stock **writes** in rules (per comments). **Not location-scoped at all** — any stockRole can move between any two locations |
| `destShop` | `App.jsx:9442, 20124, 3265, 19993`; `config/displayChecks.js:87,99`; `DisplayChecks/index.jsx:108`, `SettingsView.jsx:69` | `UserManagement.jsx:670-676` (radio at `789-812`) | Single-shop lock. Scopes the `/orders` read to a `destShop` query (`App.jsx:957-992`); comment says the `/orders` rule rejects an unscoped read from such a user. Locks the assistant shop picker |
| `storeIds: string[]` of `central`/`pine` | `AuthGate.jsx:228-229` → `effectiveStoreIds` (`utils/stores.js:57-65`) → context `storeIds` → `App.jsx:9436,9445` | **No writer found in scope.** `UserManagement.jsx` contains no `storeIds` reference (grep empty); `nextStoreIds`, `shouldWarnNoStore`, `placesOrders` have no non-test importer | Absent = all-access; `[]` = none; fails closed on read error (`AuthGate.jsx:77-81,228`). Effectively a legacy field only settable from the console today — **flag: confirm whether any live user carries it** |
| `deviceCodeRequired: bool` | `AuthGate.jsx:175,221`; `device/enrolment.js:81` | not written in scope (server / console) | This login needs each device enrolled |
| `deviceGate/{deviceId}: eid` | `device/enrolment.js:86-91` | server (`enrolDevice`), deleted by revoke | Live-enrolment proof |
| `displayName`, `username` | identity display | callable / self-grant | — |
| `hiddenCards` | `components/hiddenCards.js` | — | per-user tile hiding |
| `posAccess.storeIds` | not read here (`utils/stores.js:11-12` comment) | POS app | separate scope |

There is **no** `section`, `hub`, `hubs` or location list on a user. A warehouse user's hub is `localStorage.warehouseHub` (`App.jsx:11914`), freely changeable, and settable by a push deep link (`push/deepLink.js:104`). The assistant's shop is `localStorage.storeAssistantShop` (`App.jsx:9419-9425`).

#### Super-admin / owner gating

| file:line | what |
|---|---|
| `components/PermissionsContext.jsx:11` | `export const ADMIN_EMAIL = "gunidmoh@gmail.com"` — the shared constant |
| `components/AuthGate.jsx:217,230` | `isSuperAdmin = user.email === ADMIN_EMAIL`; `hasPermission = isSuperAdmin || permissions.includes(p)` |
| `App.jsx:19893` | **second, private** `ADMIN_EMAIL` for `AdminSignInScreen` (Google popup, `:19895-19930`) |
| `components/UserManagement.jsx:46` | **third** private copy |
| `push/PushAssignmentsCard.jsx:127,141` | **fourth** private copy |
| Importers of the shared one | `config/displayChecks.js:42`, `config/enginePolicy.js:73`, `config/hubSneakerCount.js:33`, `config/stockHold.js:24`, `admin/MirrorFleetCard.jsx:43,276`, `admin/CostWatchCard.jsx:36,172`, `cardrecon/CardReconScreen.jsx:76,251` |
| `App.jsx:19999` | `stockRole = isSuperAdmin ? "admin" : permRecord.stockRole` (UI widening only; rules read the stored value — comment `20394-20397`) |
| `App.jsx:20124` | super-admin bypasses `destShop` scope |
| `utils/stores.js:58` | super-admin gets all `STORE_IDS` |
| Admin hash routes | `App.jsx:20040-20060`: `#admin`, `#admin/users`, `#admin/notifications`, `#admin/cost`, `#admin/mirror`, `#admin/devices`; route gates `20315-20370` |

#### Device enrolment data model (as visible from the client)

| item | file:line | detail |
|---|---|---|
| Device id | `device/deviceId.js:13-35` | opaque id in localStorage; `adoptDeviceId` aligns it with the token's id |
| Enrol call | `AuthGate.jsx:43-49` | callable `enrolDevice({code, deviceId, deviceType, userAgent})` → custom token, same uid |
| Token claims | `device/enrolment.js:42-54` | `deviceId`, `eid`, `personId`, `personName`, `dkind` ("shared" or person), `dmgr` (may make codes). **No shop, hub or section claim** |
| Gate | `device/enrolment.js:73-91`; `AuthGate.jsx:221-225` | app opens only if `users/{uid}/deviceGate/{deviceId} === eid`; super-admin exempt |
| Identity for stamps | `device/enrolment.js:96-120`; `device/deviceStamp.js:27-36` | every order/stock write carries `{deviceId, personName, atMs, action}` under `stamps/…` |
| Last seen | `device/enrolment.js:161-170`; `AuthGate.jsx:127-138` | `device_enrolment/devices/{deviceId}/lastSeenAtMs` |
| Admin | `device/DeviceCodesCard.jsx:28,69,82,97` | callable `deviceEnrolmentAdmin` actions `list`, `createCode {name, kind, canManageCodes}`, `revokeDevice`, `revokePerson`. Client never reads `/device_enrolment` directly except the two leaves above |
| Reject telemetry | `device/rejectCount.js:27-37`; `deviceRejects.js:40-62` | `device_enrolment/devices/{id}/rejectCount`, `device_rejects/…` |
| Quarantine | `device/quarantine.js:53,78`; `MirrorFleetCard.jsx:382-398` | `mirror_switch/quarantine/{deviceId}`; a quarantined device sends/rejects nothing (`App.jsx:13082`) |

**Where a device→section binding would attach:** a new field on the enrolment record + a new claim next to `dkind`/`dmgr` in `pickDeviceClaims` (`enrolment.js:42-54`), surfaced through `identityFrom` (`:99-111`) into `PermissionsContext.deviceIdentity` (`PermissionsContext.jsx:24`, `AuthGate.jsx:248`), and a `section` argument on `createCode` in `DeviceCodesCard.jsx:82`. The claim is server-signed, so rules could read `auth.token.section` (rules not verified).

---

### 6. Where the owner-only settings cards live

Two patterns exist. **Pattern A — hash route** (`#admin/...`), three-layer gate (tile → route → component); **Pattern B — role route** (`ROLES.X`).

| Card | Component | Tile (`App.jsx`) | Route gate (`App.jsx`) | Gate | RTDB nodes / callable |
|---|---|---|---|---|---|
| Order Alerts | `src/push/PushAssignmentsCard.jsx` | `3396` | `20049`, `20339-20349` | super-admin email (own copy `:127`) | reads `users`, `push_assignments`, `push_tokens/{uid}`, mute flag; writes `push_assignments/{uid}` + `push_hub_audience/{hub}/{uid}` in one multi-path update (`:416`) |
| Cost Watch | `src/components/admin/CostWatchCard.jsx` | `3403` | `20053`, `20330-20338` | super-admin | reads `cost_watch/daily/{date}`, `cost_watch/suggestions`, `cost_watch/latest` |
| Mirror Fleet | `src/components/admin/MirrorFleetCard.jsx` | `3410` | `20057`, `20322-20329` | super-admin | `mirror_devices`, `mirror_switch/enabled`, `mirror_switch/off/{deviceId}`, `mirror_switch/quarantine/{deviceId}`, `device_rejects` |
| Device Codes | `src/device/DeviceCodesCard.jsx` | `3415` | `20060`, `20315-20321` | super-admin OR `deviceIdentity.canManageCodes` | callable `deviceEnrolmentAdmin` only |
| User Management | `src/components/UserManagement.jsx` | `3389` (permission `user_management`) | `20044`, `20350-20368` | route + component: super-admin only | `users/{uid}`; callables `createStaffUser`, `deleteStaffUser`, `updateStaffPassword` |
| Engine Policy | `src/components/stock/EnginePolicyCard` (other agent) | `3440` | `20474-20476` (role `ENGINE_POLICY`) | email OR `permFlags.engine_policy` (`config/enginePolicy.js:149-157`) | per its comments: policy node + `/stock_targets`; not read by me |
| Terminal settings | `src/components/cardrecon/TerminalSettings.jsx` | gear inside Card Recon, `CardReconScreen.jsx:510-519` | — | `isOwner` = email (`:251`) | callable `cardTerminalAdmin` actions `options`, `add`, `replace`, `retire`, `reinstate` (`:203,252-288`); no direct RTDB write |
| TV Ad | `src/components/TvAdSettingsCard.jsx` | `3420` | `20443-20445` (role `TV_AD`) | `tvAdRouteOpen` | `settings/tvAd`; storage `tv_ads/current.*` |
| Assistant visibility | no card (console only) | — | — | — | `config/assistantView/showDeactivatedShops/{shopId}` |
| Stock audit / hub count / stock hold | cards in stock/ | `3273-3290` | `20011-20019` | see `config/*.js` | `settings/stockAudit`, `settings/hubSneakerCount`, `settings/stockHold` |

**Recommended slot for a "Network / Sections" card:** Pattern A, next to Device Codes — tile in the Administration group after `App.jsx:3415`, hash `#admin/network` declared beside `App.jsx:20060`, route branch inserted in the chain at `20315-20349`, gate `isSuperAdmin`, component importing the shared `ADMIN_EMAIL` and re-checking it. Add a `RoleIcons` entry (the map starts at `App.jsx:2863`) and note that the hidden-cards filter (`App.jsx:3443+`, `components/hiddenCards.js`) applies to every tile key. The registry it edits is already mirrored to every device via `offline/nodes.js:110` (`/locations`) and already read through `useLocations()`; the comment at `permissionCatalog.js:44` / `enginePolicy.js:102` says `/locations` is writable by `stockRole === 'admin'` (rule not verified) — a sections node probably wants an owner-only rule instead.

---

### 7. Order / sale numbering in this app

| file:line | what it does | change needed |
|---|---|---|
| `src/utils/orderCounter.js:24-36` | `getNextOrderNumber()` — transaction on **`/orderCounter`** `{day, counter}`; day = SA date (`saTodayKey`); 1→999 then wraps to 1; returns 3-digit string | **One global counter for the whole network.** Not per shop, hub or section |
| `src/App.jsx:22`, `10663` | Called once per cart line in `placeOrders`; the number is the **RTDB key**: `orders/{NNN}` (`10710`, `1124`) | Two sections share one 001–999 space and one `/orders` node; ids are recycled daily. If sections need independent numbering (shoebox/TV), the counter path and the `/orders` key both need a section prefix — which then breaks the TV key range below |
| `src/App.jsx:2233-2245` | `getNextRefillNumber()` — transaction on **`/refillCounter`**, same day/wrap rule, returns `R###`; one per refill **cart**; line keys `R{n}-{i}` (`10896-10900`) | Global as well |
| `src/utils/tvOrdersRange.js:18-27`; `App.jsx:1089-1092` | TV reads `/orders` keys `"0".."9"` = customer orders only (excludes `R…`) | A section prefix letter would fall outside this range; a numeric prefix would stay inside it |
| `src/App.jsx:12713`, `16720-16721` | Movement ids `disp_{orderId}_{createdAt}`, `ret_{orderId}_{createdAt}` — date-scoped because ids recycle | unaffected |
| `crMovementId(...)` (`components/stock/crQueueGrouping`, used `1717-1759`) | CR ledger ids keyed on order line + creation date + generation | other agent |
| Wall-walk display request | `orderCounter.js:3-8` comment: a second surface (stock/ Unregistered Displays) draws from the same counter | other agent |
| Sale numbering | none in this app | Sales are rung in marathon-pos-app |

---

### 8. Cross-cutting hazards for the sections change (derived from the above)

1. **Defaults that point at Section 2.** `shopUniverse()` → `"central"` (`stores.js:42`); `CR_HUB_BY_UNIVERSE[...] || "hub2"` (`App.jsx:9468, 10703, 10902`); `placedAtHub || hub || "hub1"` (7 sites) and `|| "hub2"` (`12168, 12211, 13108, 13168, 13202`); `DEFAULT_STORAGE_HUB = "hub1"`; `utils/insights.js:234`. Each one silently routes an unmapped Section 1 record into Section 2.
2. **`hub3` is treated as a synonym for Pine** in `App.jsx:9940`, `14595`, `18760-18762`, `rollupCodec.js:240-242`, `assistantCatalogue.js:44-45`. Making hub3 serve Pine **and** Concrete invalidates all five.
3. **No user or device is bound to a hub.** Warehouse hub = localStorage; a push link can set it.
4. **User-chosen source hub** in Clothing Sold refill (§4 #6) is the one in-scope path where a person can directly move stock between arbitrary locations. (Stock → Transfer in `components/stock` is presumably the other; not my scope.)
5. **All stock moves are client-side `applyMovement`.** The wall cannot be enforced by UI filtering alone.
6. **Offline mirror closed list** (`locationIds.js:41-44`) drops unknown locations' stock rows — new locations must be added before any stock is received there, and every mirrored device needs the new build first.
7. **One global order counter and one `/orders` node**; the TV board is not location-filtered.
8. **Four copies of `ADMIN_EMAIL`.**
9. **`hubC`** still exists in `HUB_LABELS`, the warehouse picker, `deepLink.VALID_HUBS`, and several branches; comments call it a retired trial. Decide whether the registry migration is the moment to delete it.

---

# Appendix C

## Audit — functions/** (store repo + POS repo) for the sections/registry change

Repo: `/Users/junidmohammed/Documents/marathon-store-app-sections` (branch feat/sections-network, HEAD 7db4d910).
POS repo: `/Users/junidmohammed/Documents/marathon-pos-app-sections`.
All line numbers were taken from `grep -n` / `sed -n` on these working trees on 2026-10-01. Read-only; nothing in either repo was edited.

Legend for "change needed": **REG** = replace with a registry read; **WALL** = section-wall check belongs here; **LIVE** = honour the per-location `live` flag here; **KEEP** = no change (stated why); **?** = uncertain, verify.

---

### 0. Deploy codebases (answer to "is POS separate?")

| Repo | firebase.json `functions` | Runtime / module | Project |
|---|---|---|---|
| store app | `source: functions`, `codebase: "default"`, predeploy `node scripts/deploy-preflight.mjs --git-only` (firebase.json:2-16) | CommonJS (`require`), `functions/index.js` 5,643 lines | `marathon-club` (.firebaserc) |
| POS app | `source: functions`, `codebase: "default"`, `runtime: nodejs20`, predeploy `npm --prefix "$RESOURCE_DIR" install` (firebase.json:56-72) | ES modules (`export {…}`), `functions/index.js` 21 lines | `marathon-club` (.firebaserc; hosting targets `marathon-pos`, staging `marathon-club-ai`) |

- They are **two separate source trees, deployed separately, into the SAME project under the SAME codebase name `default`**. Neither firebase.json sets a distinct `codebase`. Consequence (stated in the store repo at `functions/refill-scan.cjs:27-28` and `:1041-1044`): a bare `firebase deploy --only functions` from either repo sees the other repo's functions as "not in source" and offers to delete them. Every deploy must be name-scoped (`--only functions:<name>`).
- No code is shared by import between the two. Shared contracts are **hand-mirrored copies** (e.g. store `functions/lib/pos-tills.cjs` mirrors POS `src/shared/stores.js`; POS `functions/lib/moneyRecordsLogic.js` and `functions/eftParked.js` carry their own store lists). A registry must therefore be read at runtime from RTDB by both, or the copies updated in both repos.
- UNCERTAIN: whether every POS function is actually deployed. POS `functions/index.js:5-10` says the first deploy "is intentionally deferred"; I could not query the live project from here. Store-repo comments treat POS functions as live.

---

### 1. Hardcoded location lists / literals / Hub-2 branches

#### 1a. Refill engine + scan (the routing core)

| file:line | what it does | change needed |
|---|---|---|
| functions/refill-scan.cjs:66 | `UNIVERSE_BY_SHOP = {"marathon-pe":"central", trophy:"central", "marathon-pine":"pine"}` — (a) value becomes `placedStore` on engine-made orders; (b) **key presence is the "is this dest a SHOP (store leg) or a HUB leg" test** | REG: registry `kind: store|hub` + a `placedStore/universe` field. `concrete` must be added or its legs are treated as hub legs (no R### order) |
| functions/refill-scan.cjs:378, 387 | `if (!UNIVERSE_BY_SHOP[dest])` → hub-leg shadow row; key `dest === "hub2" ? SHDWrr-{pid}-{size} : SHDWrr-{dest}-{pid}-{size}` | REG for the kind test. The hub2 key special-case is a legacy-compat branch: KEEP byte-for-byte for hub2, all new hubs take the dest-qualified form (already the default) |
| functions/refill-scan.cjs:411, 838 | `placedStore: UNIVERSE_BY_SHOP[dest] \|\| "central"` on shadow and live store-leg orders | REG. Note Pine's universe is `"pine"`; decide what `concrete` writes |
| functions/refill-scan.cjs:811 | `isStoreLeg = UNIVERSE_BY_SHOP[dest] != null` → store legs get an `orders/R###-n` card + insight; hub legs get `/refill_requests` only | REG (kind) |
| functions/refill-scan.cjs:523 | `locs = keys(routes) ∪ values(routes)` — the ONLY list of locations the scan reads stock for | REG/LIVE: derive from registry filtered by `live`; routes stays the topology |
| functions/refill-scan.cjs:757 | `mode = config.mode[intent.dest] \|\| "off"` (off/shadow/live per dest) | LIVE: `live=false` must force "off" regardless of `config.mode` |
| functions/refill-scan.cjs:12, 211, 380-387, 547, 775-780, 946-952 | comments naming hub1/hub2/pe/trophy/pine | docs only |
| functions/lib/refill-engine.cjs:680-687 | `routes = config.routes`; `dests = keys(routes)` sorted so a shop computes before its source | KEEP (already config). LIVE: filter dests/sources by `live` here. WALL: validate each `routes[dest]` is same-section or Central |
| functions/lib/refill-engine.cjs:706, 920, 940, 950, 983, 1168 | `entry.source \|\| routes[dest]` — a lock's stored source wins over the route | WALL: a stale lock `source` from before the registry could cross sections; validate at intent-apply |
| functions/lib/refill-engine.cjs:828-831 | `passThroughNeed`: shops fed by a hub = `keys(routes).filter(d => routes[d] === hub)` | KEEP (route-derived) |
| functions/lib/refill-engine.cjs:1345, 1358 | denial "by" = `o.placedAtHub \|\| o.hub \|\| routes[o.destShop]` / `rr.source \|\| rr.createdFrom.source \|\| routes[rr.requestingLocation]` | KEEP |
| functions/lib/refill-engine.cjs:**1362** | `levelMap = rr.requestingLocation === "hub2" ? rejCentralLevel : rejShopLevel` — **Hub-2 literal decides "Central-level denial" vs "shop-level denial"** | REG: `kind === "hub"` (or "its source is Central"). As written, a hub1/hub3/concrete-stockroom request denied by Central is filed as a SHOP-level denial |
| functions/lib/refill-engine.cjs:**1426-1427** | `centralLevelLoc = routes["hub2"] \|\| "central"`; `shopLevelLocs = dests.filter(d => d !== "hub2").map(d => routes[d])` — the confirmed-out gate's two supply levels | REG: per-section; today hub1 (a dest whose source is central) lands in `shopLevelLocs` as "central". With two sections this must be computed per dest's own chain, not one global pair |
| functions/lib/refill-engine.cjs:1527, 1580-1581, 1611, 1803, 2063-2064 | `routes[hub]`, `routes[shop] !== hub`, `routes[src]` two-level chain walk (shop→hub→upstream) | KEEP (route-derived); WALL check on `upstream` |
| functions/lib/refill-engine.cjs:1691 | exception note text "denied at both Hub 2 and Central" | REG label |
| functions/lib/refill-engine.cjs:**2139-2148** | Health "only in Central / only in Hub 2": `allPids` from `stock.central`, `stock.hub2`, `stock["marathon-pe"]`, `stock.trophy`; `sumLoc("central")`, `("hub2")`, `("marathon-pe")`, `("trophy")` | REG: per-section (Central vs section hub vs section shops). `onlyInHub2` exception key is consumed by the client |
| functions/lib/refill-engine.cjs:**2181** | Move Excess: `if (loc === "hub2")` strict net-based buffer rule, else store rule (raw, split toHub/toCentral) | REG: `kind === "hub"`. Today hub1 as a dest falls into the STORE branch |
| functions/lib/refill-engine.cjs:2197 | blind-spot loop over `dests ∪ values(routes)` | KEEP |
| functions/lib/refill-engine.cjs:2317-2319, 2343 | `"central"` literal for new-product/no-target buckets | REG: registry `central` id (single Central for both sections — low priority) |
| functions/lib/refill-engine.cjs:**2399-2400** | no-target holes: `if (loc === "hub2") { up = routes[loc] … }` — Hub 2 additionally counts sizes held only upstream | REG: `kind === "hub"` |
| functions/lib/refill-engine.cjs:**2513** | `GATED_HUBS = ["hub1","hub2"]` — "unorderable footwear" = footwear with no cell at either gated hub (mirror of client `GATED_SNEAKER_HUBS` in availabilityCore.js) | REG: hubs of the section (hub3 / concrete-stockroom for Section 1). Must change in lockstep with the client constant |
| functions/lib/refill-engine.cjs:2588 | exception key `onlyInHub2` | rename/keep — client contract |
| functions/lib/refill-engine.cjs:2601 | `shortNotRequested.shops = keys(routes).filter(d => routes[routes[d]] != null)` | KEEP (route-derived) |
| functions/lib/refill-engine.cjs:256-262, 281-286, 319-328 | per-dest switches keyed by location id: `ruleBasedTargets[dest]`, `footwearTargets[dest]`, `subcategoryRunByLocation[dest]`, `defaultRunByStore[dest]` (:654), `footwearRunByLocation[dest]` (:602), `footwearReorderPoint[dest]` (:618) | KEEP (config). LIVE: `live=false` should short-circuit `resolveTarget` or the dest loop |
| functions/lib/refill-engine.cjs:20, 240, 250, 270-272, 292, 370, 420, 682, 935-937, 1036-1037, 1197, 1337-1338, 1424, 1548, 1790-1791, 1915, 1958, 1970, 2093-2094, 2127, 2137, 2156-2178, 2209-2215, 2371, 2449, 2512 | comments naming specific locations | docs only |

#### 1b. First batch (Hub-2-specific by construction)

| file:line | what it does | change needed |
|---|---|---|
| functions/lib/first-batch.cjs:**52** | `FIRST_BATCH_HUB = "hub2"` (pinned equal to client `src/components/stock/firstBatchCore.js`) | REG: `hubFor(store)` = the store's section back-stock hub (hub3 for Pine/Concrete). Client twin must change with it |
| functions/lib/first-batch.cjs:**56** | `SOURCE = "central"` | REG (registry central id) |
| functions/lib/first-batch.cjs:86, 96-101 | `HUB2_PRESENT_REASON`; `openHub2RequestIds` filters `requestingLocation === FIRST_BATCH_HUB` | REG via the per-store hub |
| functions/lib/first-batch.cjs:107-150 | `hub2PresenceSignals({hub2Node, hub2Locks, hub2OpenRequestIds, heldLines})` | parameterise by hub |
| functions/lib/first-batch.cjs:177-190 | `centralReservations` walks `keys(routes)` and counts locks whose `source === SOURCE` | KEEP shape; SOURCE from registry |
| functions/lib/first-batch.cjs:288, 345-348, 388-392, 400, 430-432 | reads/writes `stock/hub2/{pid}`, `refill_engine/open/hub2/{pid}`, `settings/stockHold/held/hub2`, `stock_targets/hub2/{pid}`, `stock/central/{pid}/{size}` | REG via per-store hub |
| functions/lib/first-batch.cjs:**328** (`(offConfig.routes[store]) !== FIRST_BATCH_HUB` → `path_off_not_shop`) | "is this requester a shop routed via Hub 2" | REG: `routes[store] === hubFor(store)`; WALL |
| functions/lib/first-batch.cjs:301, 377-379, 395, 413, 444, 455, 483, 501, 523, 536 | marker field `firstBatch/hub2Leg`, `via: "first_batch_hub2_leg"`, reasons `hub2_present`, `hub2_covered`, `no_hub2_target` | persisted field names read by the client — KEEP names (rename = migration), generalise meaning |
| functions/lib/first-batch.cjs:1-38, 60-85, 104-138, 158, 198, 246-285, 319-364, 405-448, 484-527 | comments | docs only |
| functions/index.js:580-584 | comment on `firstBatchLeg` | docs only |

#### 1c. Policy (hub bindings)

| file:line | what it does | change needed |
|---|---|---|
| functions/lib/policy-resolve.cjs:**186** | `FOOTWEAR_POLICY_HUBS = ["hub1","hub2"]` | REG: "footwear hubs" — but see 4: the drift check assumes EXACTLY two hubs with identical legs |
| functions/lib/policy-resolve.cjs:240-247 | drift: each of the two hubs must have a usable leg; `legSignature(pol[HUBS[0]]) !== legSignature(pol[HUBS[1]])` → `hub_legs_differ` ("Hub 1 and Hub 2 do not have the same footwear numbers") | generalise to N hubs (all-pairs equal) or per section; message text |
| functions/lib/policy-resolve.cjs:248-252 | any other location in the footwear group policy → `extra_location` | **will flag hub3 / concrete-stockroom as drift the moment they are armed** — must be registry-aware |
| functions/lib/policy-resolve.cjs:272-276 | old footwear rule on at either hub → `footwear_rule_on` | REG |
| functions/lib/policy-resolve.cjs:42-47, 154-158, 188, 213-215 | comments | docs |
| functions/lib/category-policy-write.cjs:**394**, **520**, **655** | `involved = new Set(["central"])` / `["central", ...keys(config.mode)]` / `stockLocs = [...destinations, ...armedAnywhere, ...sources, "central"]` | REG (central id) |
| functions/lib/category-policy-write.cjs:407, 522, 654 | adds `config.routes[loc]` sources | KEEP |
| functions/lib/category-policy-write.cjs:914-919 | reads whole `/locations` (small) → `knownLocations = Object.keys(...)`; passed to preview/census as the location universe (:944, :1579) | REG: point at the new registry node; LIVE filter optional (policy UI may still want to show non-live) |
| functions/lib/category-policy-write.cjs:1417-1422, 1527-1531 | footwear one-policy write guards (group must name all 8 categories; own footwear entry refused while group armed) | KEEP (location-independent) |
| functions/lib/category-policy-write.cjs:266, 287, 596, 974 | comments | docs |
| functions/lib/category-policy.cjs:396, 424, 456-457, 468, 577 | preview model mirrors the engine's `routes` walk | KEEP; inherits whatever the engine gets |
| functions/lib/category-policy.cjs:310 | comment (Pine headwear husks) | docs |
| functions/lib/policy-groups.cjs:211-220, 315-322 | `locations` param or `Object.keys(stock)` | KEEP |
| functions/lib/product-type.cjs:**49** | `HUB_ORDER = ["hub1","hub2","hub3"]` (sort order of `product.hubs`) | REG (add concrete-stockroom; order from registry) |
| functions/lib/product-type.cjs:**79-93** | switch to Clothing refused while `hub1` holds units; strips `"hub1"` from hubs, default `["hub2"]`; switch back re-adds `hub1` if it has cells | REG: "sneaker hub(s)" vs "clothing hub(s)" per section. Today: hub3 is neither stripped nor defaulted |
| functions/productType/setProductType.js:33-34 | location list = `/locations` (orderByKey limitToFirst 100) + `"in_transit"` | REG |
| functions/productType/setProductType.js:**99-108** | re-reads `stock/hub1/{pid}` before the write; refusal text "Hub 1" | REG |
| functions/index.js:1220, 1258 | reorder-planner payload `hub: getProductHubs(p)[0] \|\| "hub1"` | REG default (cosmetic; AI prompt input) |

#### 1d. Scan-adjacent jobs

| file:line | what it does | change needed |
|---|---|---|
| functions/lib/refusal-writeoff.cjs:**56** | `WRITEOFF_LOCATIONS = ["hub1","hub2","central"]` — only these locations' refusals can write a cell off | REG: all `kind: hub` + central, filtered by `live` |
| functions/lib/refusal-writeoff.cjs:**57**, 156 | `EXCLUDED_LOCATIONS = ["marathon-pine"]` — refusals of requests FROM Pine never count | REG: becomes "requester not live" (Pine goes live in Section 1 → this exclusion must be lifted deliberately) |
| functions/lib/refusal-writeoff.cjs:79-80, 134, 145, 326, 392 | refusing location = `rr.createdFrom.source \|\| rr.source \|\| routes[rr.requestingLocation]` | KEEP |
| functions/lib/refusal-writeoff.cjs:152 | `cancelReason === CENTRAL_DECLINED_REASON && loc !== "central"` | REG central id |
| functions/lib/writeoff-digest.cjs:**34** | `LABEL = {hub1:"Hub 1", hub2:"Hub 2", central:"Central", "marathon-pe":"Marathon PE", trophy:"Trophy"}` | REG labels |
| functions/lib/stock-audit.cjs:**44** | `AUDIT_STORES = ["marathon-pe","trophy"]` (deliberately hard-coded, owner decision, comment :41-43) | REG + LIVE; needs owner sign-off (comment says a config key "would invite a third store to appear without anyone deciding it") |
| functions/lib/stock-audit.cjs:**52** | `AUDIT_HUBS = ["hub1","hub2"]` (hub3 dropped on purpose 2026-09-08) | REG + LIVE |
| functions/lib/stock-audit.cjs:220 | `(o.placedAtHub \|\| o.hub) !== hub` | KEEP |
| functions/stockAudit/dailyPass.cjs:126, 149 | loops `AUDIT_HUBS` / `AUDIT_STORES`; writes `settings/stockAudit/hub/{hub}/…`, `settings/stockAudit/{store}/…`, `settings/stockAudit/rotation/{store}` | follows the lists |
| functions/lib/transit-sweep.cjs:70 | `IN_TRANSIT = "in_transit"` pseudo-location | KEEP (not a section member); see WALL in §2 |
| functions/lib/admin-movement.cjs:70 | `loc !== "in_transit"` (negative-base clamp) | KEEP |
| functions/strandedTransitSweep.cjs:23 | whole-node reads `settings/stockHold`, `stock/in_transit` | KEEP |

#### 1e. Display rows / display checks

| file:line | what it does | change needed |
|---|---|---|
| functions/displayRows/lib.cjs:**60** | `DISPLAY_STORES = ["marathon-pe","trophy"]` | REG + LIVE (per section) |
| functions/displayRows/lib.cjs:**63** | `DISPLAY_HUBS = ["hub1","hub2"]` | REG (hub3/concrete-stockroom are "out of scope by owner constraint" today, comment :56-59) |
| functions/displayRows/lib.cjs:156, 182 | `m.type==="sold" && DISPLAY_STORES.includes(m.from)` / `DISPLAY_HUBS.includes(m.from)` | follows lists. **Section note:** a hub sale carries no store; `resolveHubSale` searches every DISPLAY_STORE's rows — must be limited to stores in the hub's section |
| functions/displayRows/closeDisplayRowOnSale.js:161 | `for (const s of DISPLAY_STORES)` reads `settings/displayRows/{s}/{pid}` | restrict to the hub's section |
| functions/displayRows/lib.cjs:77-80, 163-165, 176, 288, 426-428; closeDisplayRowOnSale.js:11, 30, 143 | comments | docs |
| functions/displayChecks/lib.cjs:**21-25** | `TRIGGER_STORE_FLAGS = {"marathon-pe":true, trophy:true, "marathon-pine":false}` (mirror of client `src/config/displayChecks.js`) | REG + LIVE |
| functions/displayChecks/onClothingSale.js:132-133 | `store = m.from; if (!isTriggerStoreEnabled(store)) return` | follows |
| functions/displayChecks/wakeHeldChecks.js:198-201 | `stores = Object.keys(TRIGGER_STORE_FLAGS).filter(isTriggerStoreEnabled)` | follows |
| functions/displayChecks/completeCheck.js:197, 215 | store enabled check; authorisation `userRec.destShop === store` | follows; note `users/{uid}/destShop` is the user→store scope field |

#### 1f. Notifications / rollups / online availability / misc

| file:line | what it does | change needed |
|---|---|---|
| functions/lib/order-push.cjs:**236-244** | `HUB_LABEL` = hub1, hub2, hub3, central, marathon-pe, trophy, marathon-pine | REG labels (fallback `String(hub)` already exists at :246) |
| functions/lib/order-push.cjs:**262** | `CR_HUBS = new Set(["hub2","hub3"])` — hubs whose Shop-Refill lines live on the "clothing" (CR Orders) tab | REG: `kind hub && role clothing/back-stock`; add concrete-stockroom if it works CR |
| functions/lib/order-push.cjs:**272** | `WAREHOUSE_HUBS = new Set(["hub1","hub2","hub3","hubC"])` — pinned to client `src/push/deepLink.js VALID_HUBS`; a hub outside it gets link "/" | REG, both ends. Note `hubC` exists here and nowhere else in functions (UNCERTAIN what it maps to — a warehouse-selector id, presumably Central) |
| functions/insightsRollup/rollupCodec.cjs:**284-286**, 294 | `storeBucketOf`: `marathon-pine`/`hub3`→"pine"; `trophy`→"trophy"; `marathon-pe` or (no destShop and not hub3)→"pe"; else "other" | REG; `concrete` currently falls to "other". Bucket names are persisted counters |
| functions/insightsRollup/builder.cjs:249; io.cjs:147-148 | `seenByStore = {n, pe, trophy, pine, other}` persisted counter shape | add bucket(s) or make dynamic |
| functions/lib/social-select.cjs:**108-112**, 186 | `UNSELLABLE = ["in_transit"]`, `UNTRUSTED = ["hub3","marathon-pine"]`, `ONLINE_EXCLUDED_LOCATIONS` (sealed set) | REG flag e.g. `countsOnline`. **Section 1 going live changes online availability** — owner decision 2026-09-08 excluded hub3 + Pine |
| functions/lib/shopify-inventory-dirty.cjs:**70-74**, 127 | same three sets, hand-mirrored ("MUST stay in step") | REG, same flag |
| scripts/shopify/inventory.mjs:**95-98**, 114 | third copy of the same sets (runs on the Mac mini reconcile loop, `com.marathon.shopifyreconcile.plist` → `reconcile-runner.mjs`) | REG, same flag; the mini runs its own checkout — must be pulled |
| scripts/shopify/inventorySync.mjs:76, 98-99; reconcile.mjs:1055 | `Object.keys(/locations)` minus excluded; per-product `stock/{loc}/{pid}` reads | REG (reads /locations whole — small) |
| functions/index.js:4456-4466 | social candidates: whole `/locations` read, minus `ONLINE_EXCLUDED_LOCATIONS`, then `stock/{loc}/{pid}` per shortlist product | REG |
| functions/lib/product-merge.cjs:192-199, 468 | merge walks `Object.keys(/locations)`; refuses if registry unreadable | REG: point at the new registry (or keep /locations if it stays the id list). Merge is same-location only — no wall issue |
| functions/lib/pos-tills.cjs:**17-27** | `POS_STORES` = pe, pine, trophy; `TILLS_FALLBACK` pe×3, pine×1, trophy×2 | REG / add `concrete` (2 tills). See §5 |
| functions/cardRecon/cardTerminalAdmin.js:57-58 | loops `POS_STORES`, reads `pos/config/{storeId}/tills` | follows |
| functions/index.js:2992 | chat prompt text "3 locations (Pine, PE, Trophy)" | text |
| functions/index.js:3216, 3222 | `VALID_STOCK_ROLES`, `DEFAULT_STOCK_ROLE` (role names, not locations) | KEEP |
| scripts/arm-hub1-sneaker-tranche.mjs:67-93 (launchd `scripts/launchd/com.marathon.hub1sneakertranche.plist`, daily 04:30) | writes `categoryPolicy.sneakers = {perSize, hub1:{sizes, carriedOnly}}` tranche by tranche | Hub-1-specific by design; self-retires when complete (prints a `launchctl bootout` line :87). UNCERTAIN whether the agent is still loaded on the mini |
| functions/mirrorChanges/legs.cjs:31 | mirror leg on node `locations` (depth 0) | add a leg for the new registry node if clients mirror it |

Files in scope with **no** location logic (checked by grep): `lib/auth-utils.cjs`, `lib/sa-time.cjs`, `lib/hold-reveal-sweep.cjs`, `lib/hold-availability-notify.cjs`, `lib/order-tomorrow-notify.cjs`, `lib/outbox-deliver.cjs`, `lib/reorder-demand.cjs`, `lib/merge-disposition.cjs`, `lib/label-*.cjs`, `lib/style-code*.cjs`, `lib/photo-*.cjs`, `lib/product-name.cjs`, `lib/colourway-answers.cjs`, `lib/poller-health.cjs`, `lib/social-{budget,caption,design,health,library,render,signal,twin}.cjs`, `lib/storefront-search.cjs`, `lib/eft-*.cjs` (pass `storeId` through untouched), `lib/card-recon*.cjs`/`card-expected.cjs`/`card-match.cjs` (data-driven, §5), `lib/device-enrolment.cjs`, `deviceEnrolment/*`, `eftPool/*`, `styleCode/*`, `labelAlias/*`, `productIdentity/*`, `productMerge/*`, `storefrontSearch/*`, `insightsRollup/io.cjs` (apart from the counter shape), `displayChecks/guardedTransaction.cjs`, `mirrorChanges/{lib,mirrorChanges}.js`.

#### 1g. POS repo functions

| file:line | what it does | change needed |
|---|---|---|
| functions/lib/posUsersLogic.js:**9** | `STORE_IDS = ["pe","pine","trophy"]`; `normalizeStoreIds` (:22-) validates `posAccess.storeIds` against it | REG / add `concrete` |
| functions/eftParked.js:**51**, 109, 132 | `STORE_IDS = ["pe","pine","trophy"]`; callable refuses other storeId; schedule loops them reading `{PARKED_PATH}/{storeId}` | REG / add `concrete` |
| functions/lib/moneyRecordsLogic.js:**23-27** | `TILLS = {pe:[till-1..3], pine:[till-1], trophy:[till-1,till-2]}` | REG / add `concrete: [till-1, till-2]` |
| functions/lib/moneyRecordsLogic.js:**28**, 63, 102 | `CASH_STORE_IDS = ["pe","trophy"]` — cash recon covers PE + Trophy only (error text names them) | owner decision whether Pine/Concrete join |
| functions/lib/moneyRecordsLogic.js:**29**, 59-60 | `RECYCLER_TILL = {storeId:"pe", tillId:"till-1"}` | KEEP unless Concrete has a recycler |
| functions/moneyRecords.js:72-76, 152, 320-321 | `storeAllowed(caller, storeId)`: owner, or empty `storeIds` (= all), or includes | KEEP — this is the POS's user→store scope |
| functions/lowStockAlerts.js:92, 110 | reads WHOLE `/inventory` daily 06:00; trigger on `/inventory/{store}/{productId}/{size}` — a different node from `/stock` | not location-literal; whole-node read; UNCERTAIN whether `/inventory` is still populated |

POS store key is `pe` / `pine` / `trophy` (NOT `marathon-pe`…). The store app's location ids and the POS store ids are two vocabularies joined only by convention; the registry should carry both (`id` and `posStoreId`).

---

### 2. Every exported function, and the cross-location write paths

#### 2a. Store repo — `functions/index.js`

"Stock" column: **W** = writes `/stock`; **M** = creates/alters inter-location move requests (`/refill_requests`, `/orders` Shop Refill, `/refill_engine/open`); — = neither.

| export (index.js line) | trigger | stock |
|---|---|---|
| sendWhatsApp (318) | callable | — |
| metaFallbackSweep (355) | schedule every 1 min | — |
| outboxInstantSend (435) | Firestore onDocumentCreated `whatsapp_outbox/{docId}` | — |
| dispatchHoldRevealSweep (479) | schedule every 1 min; queries `orders` by `readyNotifyPending` | — (order flags only) |
| orderTomorrowNotify (510) | onValueWritten `/orders/{orderId}/status` | — |
| holdAvailabilityNotify (552) | onValueWritten `/refill_requests/{requestId}/status` | — (notify claim only) |
| **firstBatchLeg (590)** | onValueWritten `/refill_requests/{requestId}`, retry | **W** (qty-0 seed cell) + **M** |
| shopifyInventoryDirty (632) | onValueWritten `/stock/{loc}/{pid}` | — (marks `shopify dirty` counter) |
| getBroadcastGroups (766), sendBroadcast (791) | callable | — |
| analyzeReorderNeeds (1625) | callable (reads whole `orders` :1825) | — |
| cleanProductNames (2189), generateProductPhotos (2734) | callable | — |
| chatStream (3006) | onRequest (reads whole `orders` :3070) | — |
| pickupVoice (3301) | callable | — |
| createStaffUser (3378), deleteStaffUser (3475), updateStaffPassword (3522) | callable | — (writes `/users/{uid}`: username, displayName, role, permissions, permFlags, createdAt — **no store/hub scope field is written here**) |
| **refillHealthScan (3554 → refill-scan.cjs:1046)** | schedule "every 60 minutes from 07:00 to 19:00" SAST | **W** (refusal write-off only) + **M** |
| refusalWriteoffDigest (3568) | schedule 19:40 SAST | — |
| **strandedTransitSweep (3585 → strandedTransitSweep.cjs:51)** | schedule (hourly) | **W** (in_transit → dest release) |
| orderPlacedPush (3669) | onValueWritten `/orders/{orderId}/createdAt` | — |
| onClothingSale (3729) | onValueCreated `/stock_movements/{movementId}` | — (display checks; reads one stock cell) |
| closeDisplayRowOnSale (3745) | onValueCreated `/stock_movements/{movementId}` | — (closes `settings/displayRows` rows) |
| wakeHeldChecks (3754) | schedule 09/11/13/15/16 SAST | — |
| completeDisplayCheck (3763) | callable | — |
| resolveStyleCode (3779), readStyleCodeLabel (3795), styleCodeSibling (3870), labelAlias (3845), productIdentity (3856) | callable | — |
| reapStyleCodeOcrCache (3804) | schedule 03:00 | — |
| processStyleCodeCapture (3823) | onValueCreated `/{CAPTURES_PATH}/{captureId}` | — |
| **mergeProducts (3836)** | callable | **W** — but same-location only (loser cell → survivor cell at the SAME loc) |
| storefrontSearch (3881) | onRequest | — |
| cardBatchCapture (3919), cardTerminalAdmin (3926) | callable | — |
| enrolDevice (3935), deviceEnrolmentAdmin (3941) | callable | — |
| deviceEnrolmentEmail (3948) | schedule | — |
| setProductType (3955) | callable | — (writes product `hubs`/type; reads stock) |
| syncCardReconClaim (3965) | onValueWritten `/users/{uid}/permFlags/{CLAIM}` | — |
| cardReconHealthScan (3998) | schedule */10 min | — |
| eftPoolSearch / eftPoolSettle / eftPoolReverse (4041-4043) | callable | — |
| eftRemainderScan (4044) | schedule | — |
| setCategoryPolicy (4076) | callable | — (writes `config/refillEngine/categoryPolicy`, `policyGroups`, and `/stock_targets` rows → changes what the engine will later request) |
| generateSocialPosts (4808) | callable | — |
| socialDailyAutopilot (5200) | schedule 06:00 | — |
| socialHealthScan (5405) | schedule :25 07-22 | — |
| mirrorChange* ×19 (5571-5578, from mirrorChanges/legs.cjs:30-50) | onValueWritten per leg (locations, taxonomy, stockHold config/held, hiddenProducts, config/transit, clothing_sold_refills, users, products, stock depth 2, orders, customers, displaySlots, displayRows, displayRegister, refill_requests, restock_requests, returns_log, restock_log) | — (append to `/mirror_changes`) |
| mirrorCensus, mirrorChangesSweep | schedule 02:15 / 02:45 UTC | — |
| insightsRollupSweep (5607) | schedule 00:20, 07:20, 13:20, 19:20 SAST | — |

Not exported as its own function but runs in production: `runStockAuditPass` (stockAudit/dailyPass.cjs:88) is called from inside `refillHealthScan` (refill-scan.cjs:900).

#### 2b. POS repo — `functions/index.js` (lines 12-21)

| export | trigger | stock |
|---|---|---|
| lowStockAlerts | schedule `0 6 * * *`; reads whole `/inventory` | — |
| lowStockAlertsOnWrite | onValueWritten `/inventory/{store}/{productId}/{size}` | — |
| createPosUser, updatePosUser, removePosUser, verifyManagerPin, posActiveStaff | callable | — (writes `users/{uid}/posAccess` incl. `storeIds`) |
| laybyExpiryReminder | schedule `0 9 * * *` | — (reads whole `/customers`; flags on `/pos/sales/{id}/layby`) |
| arrearsReminder | schedule `30 9 * * *` | — |
| issueStoreCredit | callable | — |
| sweepStoreCreditQueue | schedule every 5 min | — |
| reconcileCreditBalances | schedule | — |
| assignCustomerCode | onValueCreated `/customers/{key}` | — |
| eftParkedCheck | callable | — |
| eftParkedScan | schedule every 2 min | — |
| eftPoolList | callable | — |
| moneyPayoutRecord, moneyPayoutsToday, moneyCollections, moneyFloats, moneyDrops, moneyReadRange | callable | — |

**No POS Cloud Function writes `/stock` or `/stock_movements`.** POS stock effects (sales, returns, layby cancel restock) are client writes.

#### 2c. The cross-location write paths that exist server-side (complete list)

**KEY STRUCTURAL FINDING.** Physical stock transfers, receives, sales, CR fulfilment (`fulfillCRBatch`), Transfer screen, Move Excess and Solve are **client-side writes** (`src/components/stock/applyMovement.js` etc.) governed by `database.rules.json` (`"stock"` :344, `"stock_movements"` :373, `"refill_requests"` :421, `"orders"` :3). `functions/lib/admin-movement.cjs` admits only `transfer_in`, `adjustment`, `refusal_writeoff` (:62) and has exactly two callers. So a section wall "enforced in server-side write paths" has only the five points below inside Cloud Functions; the direct-move wall for human transfers must be enforced in **RTDB rules** (or those flows must be moved behind a callable). That is outside this audit's scope but it is the main gap.

| # | path | exact writes | how from/to are determined | where the wall check goes |
|---|---|---|---|---|
| 1 | **Engine intents** — refill-scan.cjs:806-878 | `refill_engine/open/{dest}/{pid}/{sizeKey}` (txn claim :818, then finalised), `refill_requests/{pushKey}` (`requestingLocation: dest`, `createdFrom.source`), and for store legs `orders/{R###-n}` (`hub`/`placedAtHub` = source, `destShop` = dest, `placedStore`) + `insights_log/{pushKey}`; all in one `safeUpdate(..., {strict:true})` | `dest` = key of `config/refillEngine/routes`; `source` = `routes[dest]` (engine :1611), or for pass-through `upstream = routes[hub]` (engine :1580) | (a) `computeRefillPlan` at engine :1609-1611 — skip a dest whose `routes[dest]` is not same-section/Central, and skip non-`live`; (b) belt-and-braces in the apply loop right before the lock claim at refill-scan.cjs:816 (`assertSameSection(source, dest)`) |
| 2 | **Shadow sync** — refill-scan.cjs:371-425, 783-785 | `refill_requests/SHDWrr-…` or `orders/SHDW-{dest}-{pid}-{size}`; `refill_engine/shadow` (:768) | same intents, `config.mode[dest] === "shadow"` | same gate as #1 (upstream of both) |
| 3 | **Resize / close / satisfied** — refill-scan.cjs:189-240, 300-345, 590-612 | txns on `orders/{id}` (qty), `refill_requests/{id}` (qty/status), `refill_engine/open/...` | existing records only — no new from/to | none (cannot create a crossing; but a pre-existing cross-section lock would be kept alive — add a one-time sweep or make `needGone` true for wall-violating locks) |
| 4 | **First-batch hub leg** — first-batch.cjs:288, 400, 519-537 (trigger index.js:590) | `stock/hub2/{pid}/{cellKey}` seeded qty 0 (`seedIfAbsent`, txn); `refill_requests/{pushKey}` (`requestingLocation: "hub2"`, `createdFrom.source: "central"`, `store`); `refill_engine/open/hub2/{pid}/{sizeKey}`; `refill_requests/{requestId}/firstBatch/hub2Leg`, `/cancelReason`; shop lock `refill_engine/open/{store}/{pid}/{sizeKey}` (`claimShopLock` :199) | `store = rr.requestingLocation` of a client-written first-batch row; hub is the constant `"hub2"`; source the constant `"central"`; guard `routes[store] !== "hub2"` → skipped (:328) | at the top of `processFirstBatchRequest` once `store` is known: resolve `hub = registry.backStockHubFor(store)`, refuse if `section(store) !== section(hub)` or either not `live`. Without this change a Pine/Concrete first batch would seed and request at **hub2** = a Section-2 hub (wall breach) or be skipped as `path_off_not_shop` |
| 5 | **Stranded transit release** — transit-sweep.cjs:266-274 via `applyMovementAdmin` | `stock/in_transit/{pid}/{size}` −qty, `stock/{dest}/{pid}/{size}` +qty, `stock_movements/rel_{lineId}` (`from: "in_transit"`, `to: r.dest`), then `settings/stockHold` archive bookkeeping | `dest` = the key under `settings/stockHold/held/{dest}/{lineId}` (or `released/{dest}/…`), i.e. chosen by the CLIENT that parked the line; orphans take dest from the parking movement | the ORIGIN (central) is not on the release; the wall must be checked when the line is parked (client/rules). Here: refuse release to a dest that is not `live`, and (if the held line records its source) check `section(source) vs section(dest)` |
| 6 | **Refusal write-off** — refusal-writeoff.cjs:338-347 via `applyMovementAdmin` | `stock/{loc}/{pid}/{cellKey}` −qty (`from: w.loc, to: null`), `stock_movements/{w.id}` type `refusal_writeoff`, cursor `refill_engine/refusalWriteoffCursor` | single location; `loc` = refusing location | not cross-location — no wall; LIVE filter on `WRITEOFF_LOCATIONS` |
| 7 | **Product merge** — product-merge.cjs:270-322 | per loc in `/locations`: `stock/{loc}/{survivor}/{size}`, `stock/{loc}/{loser}` = null, two `stock_movements` rows | same `loc` on both sides | not cross-location — no wall |

Also relevant, not a stock write: **setCategoryPolicy** (category-policy-write.cjs) writes `config/refillEngine/categoryPolicy/{key}/{loc}` and `/stock_targets/{loc}/{pid}/{size}` for any `loc` in `/locations` — arming a non-live location is possible; add a LIVE refusal (or warning) in `normalizePolicy` (:338) / `applyCategoryPolicy` (:907).

---

### 3. How the engine picks source and destination today

**There is no function that maps (shop, category) → hub.** Routing is one flat map, `config/refillEngine/routes: { dest: source }`, one source per destination, category-blind. "hub1 for sneakers / hub2 for the rest" is **not** encoded as a routing decision in functions; it emerges from four separate things:

1. `routes[shop]` is a single hub. `first-batch.cjs:328` and the comments at engine :20 / :1790 show `routes["marathon-pe"] === routes["trophy"] === "hub2"`, and hub2's source is central (engine :1426 `routes["hub2"] || "central"`). hub1 is also a dest whose source is central (engine :1036 "MANUALLY TRANSFERRED central→hub1"; scan cost table lists `stock/hub1`). **I did not read the live `/config/refillEngine/routes` value — verify it.** The scan cost table (refill-scan.cjs:946-952) lists `stock/marathon-pine` and `stock/hub3` among nodes read, which implies they appear in routes as key or value today; `first-batch` and memory notes say Pine "has no route and no keep numbers" (engine :2600). These two statements conflict — check the live node.
2. Sneakers are **sales-only at the hubs**: shops are never auto-refilled with footwear. `passThroughExcluded()` (engine :457-459) blocks Central→hub pass-through for footwear; store-leg footwear only arises if `footwearTargets[shop]` is on or an explicit row exists.
3. Which hub a category is KEPT at is policy data: `categoryPolicy[key][loc]` / `policyGroups[g].policy[loc]` (§4). Footwear is armed at hub1+hub2 via the `footwear-all` group; clothing at hub2 via rules/rows.
4. Which hub a product is SOLD/ordered from is `product.hubs` (client; `getProductHubs` index.js:933; `product-type.cjs:79-93` forces Clothing off hub1, default hub2).

Consequence for the design: a registry that says "store X: sneaker hub = A, back-stock hub = B" has no single consumer in the engine today. `routes` can only express B. If Section 1 needs both hub3 and concrete-stockroom to feed the same shop for different categories, `routes` must become category-aware (new shape) — this is a design change, not a literal swap.

#### Decision functions (all pure, in `functions/lib/refill-engine.cjs`)

| function (line) | inputs | decides |
|---|---|---|
| `computeRefillPlan(snapshot)` (664) | `{nowMs, config, targets, stock, products, openIndex, refillRequests, orders, movements, targetDecisions, rejectStreak, retryState, heldLines}` | everything: closes, resizes, satisfiedClosures, intents, exceptions |
| dest ordering (680-687) | `config.routes` | dest list; shops before their source |
| `resolveTarget(ctx, dest, pid, size)` (544) | targets, config, products, stock | HOW MANY at a dest. Precedence: deactivated→null; explicit `/stock_targets/{dest}/{pid}/{size}`; `categoryPolicyTarget`; footwear rule (`footwearTargets[dest]` + `footwearRunByLocation[dest]` + `footwearReorderPoint[dest]`); kill switch `ruleBasedTargets[dest]`; `subcategoryRunByLocation[dest]`; `defaultRunByStore[dest]` |
| `categoryPolicyEntry` (468) / `categoryPolicyTarget` (493) | config, product `categoryKey`, dest | policy numbers for (category, dest) via `locationPolicyFor` |
| `policyCategoryKey(product)` (461) | product | `categoryKey`, or legacy `Footwear`/`Sneakers` → `"sneakers"` |
| `managedPids(dest)` (1189) / `sizesFor(dest,pid)` (1212) | targets, switches, policy, `storeCarries` | which cells are walked |
| main deficit loop (1609-) | `mode = config.mode[dest]`, `src = routes[dest]` | intent `source→dest`, capped to source availability minus `sourceReserved` |
| `raisePassThrough` (1579) / `passThroughNeed` (825) / `hubLegState` (1526) | routes two levels | Central→hub leg FOR a shop |
| `confirmedOut` (1428) | `rejCentralLevel`, `rejShopLevel`, `centralLevelLoc`, `shopLevelLocs` | hub2-literal two-level denial (§1a :1362, :1426) |
| circuit breaker (1913-1990) | `maxIntentsPerRun`, `maxFootwearIntentsPerRun`, `maxUnitsPerIntent` | round-robin across dests |
| `policy-resolve.cjs`: `locationPolicyFor(config, categoryKey, dest)` (:129), `effectivePolicyFor`, `armedGroupForCategory`, `footwearPolicyDrift` | config | own entry beats group; first armed claiming group (sorted) |
| `refill-scan.cjs`: `runScan` (462), `intentRecords` (357), `shadowSyncUpdates` (371), `applyResizes` (189), `applySatisfied`, `closeRequestTxn`, `drawRefillNumber` (127) | — | I/O |
| `first-batch.cjs`: `processFirstBatchRequest`, `hub2PresenceSignals` (107), `openHub2RequestIds` (96), `centralReservations` (177), `claimShopLock` (199), `seedIfAbsent` (162), `processFirstBatchRequest` (240) | — | deferred hub leg |

#### Config and data nodes read

`/config/refillEngine` (whole, small) — keys in use: `enabled`, `routes`, `mode`, `categoryPolicy`, `policyGroups`, `ruleBasedTargets`, `footwearTargets`, `footwearRunByLocation`, `footwearReorderPoint`, `defaultRunByStore`, `subcategoryRunByLocation`, `maxIntentsPerRun`, `maxFootwearIntentsPerRun`, `maxUnitsPerIntent`, `confirmedOutDays`, `rejectCooldownHours`, `recheckCooldownMinutes`, `rejectStreakLimit`, `staleIntentHours`, `storeExcessMinUnits`, `refusalWriteoff.{enabled,maxPerRun}`, `refillRequestsProductIdIndex`; dead: `scanIntervalMinutes`, `autoAdoptTargets`.
Other: `/receiving_session` (pause), `/stock_targets`, `/stock_targets_decisions`, `/products`, `/refill_engine/{open,rejectStreak,retryState,refusalWriteoffCursor,lock,runs,shadow}`, `/refill_requests`, `/orders`, `/settings/stockHold/held`, `/stock_movements`, `/stock/{loc}`, `/refillCounter`, `settings/stockAudit/*`.

#### Read patterns (you want to avoid whole-node reads — current state)

**`refillHealthScan` is whole-node throughout** (refill-scan.cjs:524-541): `stock_targets_decisions`, `stock_targets`, `products`, `refill_engine/open`, `refill_requests`, `orders`, `rejectStreak`, `retryState`, `settings/stockHold/held`, `refusalWriteoffCursor` — all `.once("value")` on the root of the node; `stock_movements` is the one bounded read (`orderByChild("ts").startAt(45 days ago)`); `stock/{loc}` whole per location in `locs`. Measured 39.11 MB/run × 13 runs/day (comment :940-955). **Adding concrete + concrete-stockroom + making Pine/hub3 live adds one whole `stock/{loc}` read per location per run** — and `stock_targets` grows too. A `live=false` location dropped from `locs` saves its read.

Other patterns:
- `first-batch.cjs`: all scoped per product/cell (`stock/hub2/{pid}`, `stock/central/{pid}/{size}`, `stock_targets/hub2/{pid}`, `refill_engine/open/{dest}/{pid}/{size}` per route key) + whole `config/refillEngine`; the one potentially large query (`refill_requests` by `productId`) is gated behind `refillRequestsProductIdIndex` (:96-101).
- `category-policy-write.cjs`: `readMapPaged` (:189, orderByKey pages of 500) over `products`, `stock/{loc}`, `stock_targets/{loc}`, `refill_engine/open/{loc}` — paged but still the whole node; 120 s per-instance census cache (:614-617).
- `strandedTransitSweep.cjs:23`: whole `settings/stockHold` + whole `stock/in_transit`.
- `dailyPass.cjs`: reuses the scan's snapshot; REST shallow keys for prune.
- index.js:1825, 3070: whole `orders` (analyzeReorderNeeds, chatStream). index.js:4456: whole `/locations`.
- `order-push.cjs`: leaf reads only (`push_hub_audience/{hub}`, `push_mutes/{uid}/muted`, `push_tokens/{uid}`, `products/{pid}/name`).
- POS: `lowStockAlerts.js:92` whole `/inventory`; `laybyExpiryReminder.js:60` whole `/customers`; `arrearsReminder.js:53` whole `/pos/creditLedger`.

---

### 4. Hub policies — where defined, how bound to hubs

All policy is DATA under `/config/refillEngine` + `/stock_targets`; the binding to a hub is simply the location id used as a key.

| class | definition | binding to hub1/hub2 |
|---|---|---|
| Sneakers / all footwear, per-size | `policyGroups["footwear-all"]` = `{armed, memberCategoryKeys:[8 keys], policy:{perSize:true, hub1:{sizes:{…}, carriedOnly}, hub2:{sizes:{…}, carriedOnly}}}`. Constants: `FOOTWEAR_GROUP_KEY`, `FOOTWEAR_CATEGORY_KEYS` (boots, designer-shoes, kids-shoes, loafers, running-shoes, slides, sneakers, soccer-boots), `FOOTWEAR_POLICY_HUBS` (policy-resolve.cjs:181-186) | keys `hub1`, `hub2` inside `policy`; drift check requires both legs present AND identical, and flags any third location (policy-resolve.cjs:240-252). `carriedOnly` = HOW MANY never WHERE (policy-resolve.cjs:42-47; engine :476) |
| Legacy footwear rule | `footwearTargets[dest]`, `footwearRunByLocation[dest][sizeKey]`, `footwearReorderPoint[dest]` (engine :281, :600-624) | per-dest keys; flagged as drift if on at hub1/hub2 |
| Clothing (letter sizes) | `ruleBasedTargets[dest]` switch + `defaultRunByStore[dest][size]` (engine :256, :628-658) | per-dest keys (trophy, hub2, marathon-pe per comment :240) |
| One-size categories (headwear, perfume, etc.) | `categoryPolicy[categoryKey] = {perSize?:bool, "<dest>": {target, reorderPoint, minQty}}` — one-size mode speaks for the `_` cell only (engine :360-380, :493-540) | per-dest key inside the entry; "a location absent from an entry gets NOTHING there" |
| Perfume | no productType, not clothing → only explicit `/stock_targets` rows or a `categoryPolicy` entry (engine :300-304) | row location / entry key |
| Subcategory (watches) | `subcategoryRunByLocation[dest][subcategory]` (engine :319) | per-dest |
| Explicit rows | `/stock_targets/{dest}/{pid}/{sizeKey} = {target, minQty, reorderPoint}` — outrank everything | path segment |
| Writers | `setCategoryPolicy` callable → `lib/category-policy-write.cjs` (`applyCategoryPolicy` :907; seating gate `gateNewLegsToSeated` :313; footwear guards :1417, :1527); scheduled `scripts/arm-hub1-sneaker-tranche.mjs` (hub1 literal) | — |

For Section 1: hub3 "gets the role hub2 has" means new `hub3` (and `concrete-stockroom`) keys in each policy entry/group and new per-dest switch keys. Nothing auto-copies hub2's numbers. `footwearPolicyDrift` must be taught the registry first or it will report `extra_location` for the new hubs on every scan (it is written into `stock_exceptions/latest.footwearPolicyDrift`).

---

### 5. Card recon data model

- **Terminal registry:** `config/cardTerminals/{TID}` (`CARD_TERMINALS_PATH`, lib/card-recon.cjs:35). Row fields (card-terminal-admin.cjs:119-127, 148-151, 208; card-terminals.cjs): `storeId`, `tillId`, `label`, `capture` ("email" | "photo" | "typed" | absent = "both"), `mid?`, `activeFrom` (ms, when the machine entered the estate), `retiredAt` (ms; the stamp IS the flag), `tillChangedAt` (ms; stamped when `tillId` changes).
- **Effective dating:** there is **no mapping history** — the registry holds the CURRENT store/till only (card-terminals.cjs comment before `tillMoveWarning`; POS #357 reverted a history reader on the owner's instruction). `activeFrom`/`retiredAt` bound "was this machine in the estate at t" (`wasActiveAt`); `tillChangedAt` only produces a warning on a batch whose window straddles the move. A terminal **never changes store in place** (card-terminal-admin.cjs:140-145 — refused; batches are filed under the store). Replacement = new TID row inheriting store/till (`planReplace` :200-208).
- **Batches:** top-level `card_batches/{storeId}/{TID}/{batchKey}` (`CARD_BATCHES_PATH` :52; batchKey e.g. `58`, `58-r2`), drafts `card_batch_drafts/{uid}/{draftId}` (:58), audit `card_terminal_audit` (cardTerminalAdmin.js:42), poller status `card_batch_poll_status/lastRunAt`, `card_batch_poll_health` (index.js:4002-4003).
- **Store keys:** POS vocabulary — `pe`, `pine`, `trophy`. `storeId` is a JOIN KEY against `pos/paymentEvents` rows' `storeId`/`tillId` (`PAYMENT_EVENTS_PATH`, card-expected.cjs:27; filter :106, :195) — never the store-app id `marathon-pe`.
- **How stores/tills are enumerated:** `lib/pos-tills.cjs` — hardcoded `POS_STORES` (:17-21) and `TILLS_FALLBACK` (:23-27); `posStores()` overlays `pos/config/{storeId}/tills` when seeded (three leaf reads in cardTerminalAdmin.js:55-60; "unseeded for all three stores as of 21 Sept 2026"). `checkPlacement` (card-terminal-admin.cjs:81-87) refuses a store/till not in that list — **so `concrete` cannot be given a terminal until it is added to `POS_STORES`/`TILLS_FALLBACK` (and the POS's own `src/shared/stores.js`, and POS `functions/lib/moneyRecordsLogic.js TILLS`)**.
- **Hardcoded TIDs / store lists in cardRecon:** none in logic. `"0000HP1X"` (card-recon.cjs:131) and `0000AB1C` / `67000000` (cardRecon.js:155-156) are format examples in a comment and the OCR prompt. `"trophy/till-1"` (card-match.cjs:143-145) is a comment. Capture routes by the slip's own TID → registry row.
- Access: `cardTerminalAdmin` owner-only (`gunidmoh@gmail.com`, verified email; cardTerminalAdmin.js:41-49); capture gated by `users/{uid}/permFlags/card_recon` (cardRecon.js:232).
- Scheduled poller on the mini: `scripts/cardrecon/poll-runner.mjs` (launchd `com.marathon.cardreconpoll`) — no location literals found by grep in `poll-runner.mjs`, `email-poller.mjs`, `intakeCore.mjs`, `eftCore.mjs`.

---

### 6. Notifications — order-push.cjs

- Trigger: `orderPlacedPush` on `/orders/{orderId}/createdAt` (index.js:3669); re-reads `orders/{orderId}` (:3697).
- **Hub of an order:** `hubForOrder(rec)` = `rec.hub || rec.placedAtHub` (order-push.cjs:275-282). No hub → refused (`no_hub`), never defaulted (:386-398). The hub is written by the producers (AssistantView.placeOrders, placeRefillRequests, and refill-scan store legs where `hub = source`).
- **Audience:** `push_hub_audience/{hub}` → uid keys (`resolveRecipients` :411-416; admin-write-only, derived from `/push_assignments` by the client `src/push/pushAssignments.js`), minus `push_mutes/{uid}/muted` (:458), tokens from `push_tokens/{uid}` (:479). No wildcard/fallback bucket. **No store- or section-based audience** — assignment is per hub id, so any hub id works as data (hub3 already has orders: 714 logged, :93-94).
- **Burst window:** keyed by hub — `push_bursts/{hub}` txn (:601-623).
- **Hardcoded:** `HUB_LABEL` (:236-244), `CR_HUBS = {hub2, hub3}` (:262, picks tab "clothing" for Shop Refill lines), `WAREHOUSE_HUBS = {hub1, hub2, hub3, hubC}` (:272, link is "/" for anything else; pinned to client `src/push/deepLink.js`).
- For `concrete-stockroom`: add to `WAREHOUSE_HUBS` (both ends), `HUB_LABEL`, and `CR_HUBS` if it works CR lines; the id must be a legal RTDB key (hyphen is fine; `.#$/[]` refused at :376, :399).
- Other notifiers (`order-tomorrow-notify`, `hold-availability-notify`, `hold-reveal-sweep`) are customer WhatsApp flows with no location logic.

---

### 7. Numbering / counters in functions

| counter | where | behaviour |
|---|---|---|
| `/refillCounter` `{day, counter}` | refill-scan.cjs:127-136 `drawRefillNumber` (mirror of client `App.jsx getNextRefillNumber`) | txn; resets per SA day (`engine.saTodayKey`), 001-999 wrap, "R" prefix; **global, not per store/hub**. Order id = `R###-{lineIdx}` (:829), lineIdx restarts per dest per run → ids are recycled daily (comment :958-975). One R-number per destination per run |
| customer-order numbers | not in functions — minted client-side (store app). functions only read `orderNumber` (index.js:974-1003) | — |
| POS sale / receipt numbers (`R-NNNNN` etc.) | not in POS functions — client (`src/sale/engine.js`, `engineBuild.js:610`) | — |
| `customers_meta/lastCode` | POS functions/customerCodes.js:57-59, `nextCounter` (lib/customerCodesLogic.js:28), start 1000 | txn; global |
| `refill_engine/lock` | refill-scan.cjs:469-474 | run lock, 10-min steal |
| `refill_engine/rejectStreak`, `retryState`, `refusalWriteoffCursor` | engine/scan | per (dest,pid,size) state, keyed by location id |
| `shopify` dirty marker | shopify-inventory-dirty.cjs:144 `ServerValue.increment(1)` | per pid |
| `push_bursts/{hub}` | order-push.cjs:601 | per hub |
| insights rollup cursor + `seenByStore` | insightsRollup/io.cjs:140-150 | per store bucket (pe/trophy/pine/other) |
| card batch keys | `card_batches/{storeId}/{TID}/{batchNo[-rN]}` | per terminal, from the slip |
| EFT credit ids (`eftsc…`) | eftPool.js:237-261 | deterministic |

Adding stores/hubs does not require a new counter in functions. If per-section R-numbers are wanted, `drawRefillNumber` and the client twin both change. Note the recycled-id hazard grows with more store legs per day (more `orders/R###-n` keys → more overwrites; the hourly self-heal at refill-scan.cjs:958-975 depends on run k+1 drawing a different number).

---

### 8. Device enrolment

- Files: `functions/lib/device-enrolment.cjs` (pure), `functions/deviceEnrolment/deviceEnrolment.js` (I/O). Exports: `enrolDevice` (callable), `deviceEnrolmentAdmin` (callable), `deviceEnrolmentEmail` (schedule).
- Data (`ROOT = "device_enrolment"`, device-enrolment.cjs:3-12): `people/{personId}` `{name, kind: "person"|"shared", status: "active"|"revoked", canManageCodes, maxDevices?, code, devices:{deviceId:{eid, atMs}}, createdAtMs, createdBy, revokedAtMs}`; `devices/{deviceId}` `{personId, personName, kind, status, deviceType, uid, enrolledAtMs, lastSeenAtMs, rejectCount, revokedAtMs, revokedBy}`; `codes/{4-digit code} = personId`; `attempts/{key}` (rate limits per device / ip / account, LIMITS :18-22); `emailQueue`, `emailStatus`, `audit`. Limits: person 2 devices, shared 1 (:15-16).
- Gate: `users/{uid}/deviceCodeRequired` (deviceEnrolment.js:111); on success writes `users/{uid}/deviceGate/{deviceId} = eid` (:210).
- **Custom token:** `admin.auth().createCustomToken(uid, claims)` — SAME uid as the signed-in account (:187, :443). Claims (`buildClaims`, device-enrolment.cjs:115-122): `deviceId`, `eid`, `personId`, `personName` (≤80 chars), `dkind` ("person"|"shared"), `dmgr: true` if `canManageCodes`.
- **Scoping:** a device is bound to a PERSON and the account uid. **There is no store, hub, location or section in the person record, the device record, or the claims.** Location scope of a user lives elsewhere: `users/{uid}/destShop` (read at displayChecks/completeCheck.js:215), `users/{uid}/posAccess.storeIds` (POS, written by POS `createPosUser`), `users/{uid}/permissions`/`permFlags`, `stockRole` (index.js:3216). `createStaffUser` does not write `destShop` (index.js:3451-3463) — it is set by some other path (client/admin UI; not found in functions).
- If the section wall is to be enforceable in RTDB rules per device/user, a `section` (or location) claim would have to be added to `buildClaims` and to the person record — today nothing supplies it.

---

### 9. Time stamping and reusable patterns

**Time.** There is **no `serverNowMs()` helper in functions**. (`serverNowMs` appears only as a field NAME returned to the client by `setCategoryPolicy`: category-policy-write.cjs:948, 1017, 1316.) Functions run on Google's clock, so the convention is:
- `Date.now()` at the wrapper, passed down as `nowMs` / `now()` to pure libs (refill-scan.cjs:464; deviceEnrolment.js:400, 444; index.js:5621; dailyPass `nowMs`). Pure modules never call the clock themselves — follow this for testability.
- ISO strings for stock/ledger records: `new Date(nowMs).toISOString()` → `createdAt`, `ts`, `appliedAt`, `updatedAt` (refill-scan.cjs:466; admin-movement.cjs `{nowIso}`).
- `admin.database.ServerValue.TIMESTAMP` in a few record writes (index.js:3462; cardTerminalAdmin.js:91, 103; eftPool.js:237-261). Trap noted in memory: a txn's ServerValue reads back as a local estimate.
- SA dates: `lib/sa-time.cjs` — `SAST_OFFSET_MS`, `saDateStringFromMs(ms)`; `engine.saTodayKey(nowMs)` (refill-engine.cjs:146) for the counter's day key (0-based month, mirrors the client). `refusal-writeoff.cjs:76` and `transit-sweep.cjs:66` carry their own +2h copies.
- Schedules set `timeZone: "Africa/Johannesburg"` explicitly.

**Registry/config caching patterns to reuse.**
- **No shared registry loader exists.** `/locations` is read ad hoc in four places: index.js:4456 (whole), category-policy-write.cjs:915 (whole), product-merge.cjs:192 (whole, refuses if empty), setProductType.js:33 (`orderByKey().limitToFirst(100)`). `config/refillEngine` is read whole on every scan and every first-batch invocation (first-batch.cjs:325, 349, 387 — up to three reads in one trigger run).
- Per-instance in-memory TTL cache: `censusCache` + `CENSUS_TTL_MS = 120000` + `invalidateCensusCache()` (category-policy-write.cjs:614-617) — keyed by the live policy so an outside edit invalidates it. `storefrontSearch.js:115-142` caches its index per instance keyed by a `meta.version` stamp (one small leaf read to validate, big read only on version change) — **this version-stamped pattern is the best fit for a small registry node** read by hot triggers (`firstBatchLeg`, `orderPlacedPush`, `closeDisplayRowOnSale`).
- `readMapPaged(db, path, pageSize=500)` (category-policy-write.cjs:189-209, exported :1659) for paged node reads; `restShallowKeys` (dailyPass.cjs) for key-only reads.
- `safeUpdate` / `safeSet` + `engine.sanitizeUpdate` (refill-scan.cjs:88-124) — the one way the scan writes; strict mode for all-or-nothing.
- Hand-mirrored client/server constants pinned by tests (e.g. first-batch.cjs:50-52 ↔ firstBatchCore.js; displayChecks flags; `WAREHOUSE_HUBS` ↔ deepLink.js; `ONLINE_EXCLUDED_LOCATIONS` ×3 copies; pos-tills ↔ POS stores.js). Each is a test that will fail when the literal is replaced — find the pinning test before editing.
- Fail-safe convention throughout: absent/garbled config ⇒ OFF (engine :241-262). A registry read failure should likewise mean "route nothing", and `live` absent ⇒ not live.
- Mutable fake-RTDB test harnesses exist under `functions/test/` (not audited).

---

### 10. Known open defects — code involved

| defect | code found | notes |
|---|---|---|
| **Name-keyed source queue collisions** | NOT in functions as a queue. Server-side name/label-keyed things: (a) `indexProductsByName` (index.js:942) — reorder-planner join of `insights_log` to products by `productName`, collisions recorded; (b) the label-identity bug at refill-engine.cjs:751-800 (order id `R###-n` used as identity; fixed 2026-07-28 via `ledgerTouched`); (c) hub2 shadow key `SHDWrr-{pid}-{size}` without dest (refill-scan.cjs:387). The "source queue" UI itself is client code — candidates by grep: `src/components/stock/RefillQueue.jsx`, `src/components/stock/firstBatchCore.js`, `src/App.jsx`, `src/utils/sourceTwinIdentity.test.js`. **UNCERTAIN — I did not confirm which of these keys rows by name; out of the functions scope.** Section relevance: any queue keyed by name/pid without the destination will merge Section 1 and Section 2 rows once a second section's hub requests the same product from Central |
| **Store-leg refill resize failures** | plan side refill-engine.cjs:734-743 (`resizes`, `resizeSuppressed`), :966-1008 (auto-resize; suppressed while `inFlight`), :875-880 (`orderLost`); apply side refill-scan.cjs:138-166 (`resizeDropReason`), :168-240 (`applyResizes`): store legs run the `orders/{orderId}` txn which bails on `clothingRefillStatus != null \|\| clothingPlanGen != null \|\| !autoRefill` (:200) → `order_guard_bailed`; hub legs have no orderId and skip it. Drops are counted in `counts.resizeDropped` / `resizeSuppressed` on `refill_engine/runs/{runId}` | recycled `orders/R###-n` ids are the root hazard (refill-scan.cjs:958-975). More store legs (concrete, pine) → more id reuse |
| **Refill requests not clearing after a manual transfer** | refill-engine.cjs:1011-1076 (explanation), :1077-1145 (`satisfiedClosures` — lock-less requests whose dest cell already holds the qty); apply refill-scan.cjs:286-345 (`applySatisfied`, live cell re-check :309, txn :319). Locked requests rely on `needGone` in the reconcile loop (engine :897-924) | still-open hole by construction: a request with a lock whose dest has NO resolvable target and is not covered is never withdrawn; and `satisfiedClosures` only fires on full coverage of the request qty. Whether the reported defect is one of these is UNCERTAIN |
| **Layby cancel restocks to the wrong location** | NOT in either functions dir. POS client: `src/sale/engine.js:1504` (`cancelLaybyImpl`), `src/sale/engineBuild.js:610-680` (builds the cancel updates, source `layby_cancel`), `src/layby/LaybyDetailView.jsx:505, 548` ("cancelLayby already restored the…"). POS functions only handle the credit side (`lib/storeCreditLogic.js:21, 31`) | I did not read the restock location logic (client, out of scope). Relevant fact from functions: a sneaker sold from a HUB cell carries no store on its movement (displayRows/lib.cjs:166-181), so a return/cancel that restocks "the store" rather than the hub it sold from is the likely shape — verify in `engineBuild.js`. With sections, a restock to the wrong location could also cross the wall |

---

### 11. Things to decide / verify before coding (flagged uncertainties)

1. Read live `/config/refillEngine/routes` and `/config/refillEngine/mode` — I inferred their shape from code and comments only.
2. Read live `/locations` — shape of a record (it has `active` per index.js:4448 comment; other fields unknown to me).
3. `routes` is one-source-per-dest and category-blind; the "sneaker hub vs back-stock hub" notion has no engine consumer today (§3).
4. The human-transfer section wall is not enforceable in Cloud Functions as the code stands — stock moves are client writes under `database.rules.json` (§2c).
5. `footwearPolicyDrift` hard-assumes exactly {hub1, hub2} with identical legs (§4).
6. `ONLINE_EXCLUDED_LOCATIONS` (3 copies incl. the mini's script) excludes hub3 + Pine from online stock by owner decision — making Section 1 live does not by itself change that; it is a separate decision.
7. `refusal-writeoff EXCLUDED_LOCATIONS = ["marathon-pine"]` and `stock-audit AUDIT_*` / `displayRows DISPLAY_*` / `displayChecks TRIGGER_STORE_FLAGS` are recorded owner decisions to keep Pine/hub3 out — each needs an explicit yes before the registry switches them on.
8. POS store ids (`pe`/`pine`/`trophy`) ≠ store-app location ids (`marathon-pe`/…): registry needs both.
9. `hubC` in `WAREHOUSE_HUBS` — meaning not established from functions code.
10. Whether POS functions are all deployed, and whether `/inventory` (POS lowStockAlerts) is a live node.

---

# Appendix D

## POS audit for the sections / registry build

Repo: `/Users/junidmohammed/Documents/marathon-pos-app-sections` at `05ad595` (read-only audit, nothing edited).
Scope: `src/**` non-test files. `functions/` is NOT covered here.
Line numbers were taken from `grep -n` / `cat -n` output on this checkout.

**Tooling trap found while auditing:** plain `grep` treats `src/sale/Cart.jsx` as a BINARY file (it contains bytes grep dislikes) and silently prints nothing for it. Every repo-wide grep must use `grep -a` or Cart.jsx (2,454 lines, the main sale screen) is invisible. I re-ran the store-literal and helper greps on it with `-a`; it was the only file where plain and `-a` counts differed.

Vocabulary used below:
- **store id** = POS short id (`pe`, `pine`, `trophy`) — what `/pos/sales/*.storeId`, cash-up keys, device registry and posAccess use.
- **location id** = canonical `/stock` id (`marathon-pe`, `marathon-pine`, `trophy`, `hub1`, `hub2`, `hub3`, `central`, ...).

---

### 1. Hardcoded store / till / hub lists, maps, literals, switches

#### 1a. The definitions (the things a registry replaces)

| file:line | what it does | change needed |
|---|---|---|
| `src/shared/stores.js:9-13` | `STORES` = `[pe, pine, trophy]` with labels. THE store list for every picker, report chip, validator. | Replace with registry read (+ a synchronous cached snapshot, because most consumers are sync). Add `concrete`. |
| `src/shared/stores.js:15-17` | `storeLabel(storeId)` — sync lookup over `STORES`. ~30 call sites. | Back with registry cache; keep sync signature. |
| `src/shared/stores.js:31-46` | `TILLS_FALLBACK` = pe: till-1..3, pine: till-1, trophy: till-1..2. Comment (lines 21-30) says runtime truth is `/pos/config/{storeId}/tills`, but **no code reads that node** (grep for `/tills` finds only this comment). The "fallback" is the only source. | Registry tills per store; `concrete` gets 2 tills. |
| `src/shared/stores.js:48-60` | `tillsForStore`, `tillLabel`, `isValidTillId` — sync, over `TILLS_FALLBACK`. `isValidTillId` gates PAY (Cart), layby actions, money records, deposits. | Back with registry cache. |
| `src/layby/locationIds.js:27-31` | `STORE_TO_LOCATION` pe→marathon-pe, pine→marathon-pine, trophy→trophy. The single store-id→location-id crossing. | Registry field `stockLocation` per store. |
| `src/layby/locationIds.js:37` | `CANONICAL_STORE_IDS` = values of the map above. Layby parcel `originStore` and pull `requestingStore` are validated against it. | Derive from registry (must include concrete's location id). |
| `src/layby/locationIds.js:43` | `CANONICAL_HUB_IDS` = `hub1, hub2, hub2b, hub3, hubC, warehouse1`. Validates layby `storageHub`. | Registry hubs; add `concrete-stockroom`. |
| `src/layby/locationIds.js:54-61` | `STORE_TO_HUB` pe→hub1, pine→hub3, trophy→hub1; `hubForStore` default `"hub1"`. Decides where a NEW layby parcel is stored. | Registry `laybyHub` per store. Default `hub1` for an unknown store would send a Section-1 store's parcel to a Section-2 hub — must not default across the wall. |
| `src/layby/locationIds.js:69-72` | `originLocationId` — falls back to the RAW store id for unknown stores. | Keep, but registry-backed. |
| `src/layby/locationIds.js:81-84` | `sellableStockLocation` — STRICT (null for unknown). 13 importers (list in 1c). | Registry-backed. A new store returns null today → no stock reads, no deduction, no-receipt return refused, offline stock leg "unmapped-store". |
| `src/layby/locationIds.js:90-101, 104-107` | `LOCATION_LABELS` + `locationLabel`. No `central`, no concrete. | Registry labels. |
| `src/stock/stockLocations.js:29-39, 41, 47-49` | `WRITABLE_STOCK_LOCATIONS` = marathon-pe, marathon-pine, trophy, hub1, hub2, hub3, central, studio, base. `isWritableStockLocation` is the closed-list gate in `toStockIntents`. | Registry-derived; a location not in it is SKIPPED for sales (`invalid_location`) — a new store sells without deducting until it is added. |
| `src/stock/nonDeductingLocations.js:43-45, 48-53, 62-65` | `NON_DEDUCTING_LOCATION_IDS = ["marathon-pine"]`; accepts both id forms by adding/stripping the `marathon-` prefix. | Registry flag `deducts:false` per location. The prefix trick will not map `concrete` correctly if its location id is not `marathon-concrete`. |
| `src/config/partnerStores.js:45-47, 59-65, 77-80, 93-96` | `PARTNER_PAIRS = [["marathon-pe","trophy"]]`, `partnerLocation`, `isPartnerOf`. Cross-store selling. | Registry `partnerOf`. Both members are Section 2 today, so it does not cross the wall; a registry validator should refuse a pair spanning sections. |
| `src/stock/saleStockMovements.js:98-99` | `SNEAKER_HUB_IDS = ["hub1","hub2","hub3"]` — the hubs a footwear sale may deduct, for EVERY store. Re-exported `src/stock/saleRouting.js:52,65` as `SNEAKER_HUBS`. | Must become per-section (Section 1: hub3 + concrete-stockroom; Section 2: hub1, hub2). **This is a wall breach today** — see §4. |
| `src/stock/returnRouting.js:36` | `STOCK_LOCATIONS = hub1, hub2, hub3, central, marathon-pe, trophy` — holdings probed for a return. (No pine.) | Per-section location list. |
| `src/stock/returnRouting.js:37` | `SHOP_LOCATIONS = marathon-pe, trophy` — drives `cross_shop_stay`. | Registry stores of the section. |
| `src/stock/returnRouting.js:38` | `VALID_SOURCE_HUBS = hub1, hub2, hub3`. | Per-section hubs. |
| `src/stock/returnRouting.js:42` | `SHOP_KEPT_CATEGORIES` (not a store list; policy). | none |
| `src/stock/returnRouting.js:50-75` | `BRAND_TO_HUB` — 24 brands → hub1/hub2 only. Used as last-resort hub for footwear SALES (saleRouting) and RETURNS. | Per-section table. For a Section-1 store this fallback names a Section-2 hub. |
| `src/stock/returnRouting.js:79-84` | `BRAND_ALIASES`. | none |
| `src/stock/soldCellLookup.js:51-53` | `PROBE_LOCATIONS` = writable list minus studio/base — every location probed for a `sold:` movement. | Follows the registry list automatically once 1a is registry-backed; add concrete locations. |
| `src/return/returnStores.js:20-25` | `RETURN_STORES = [pe, trophy]` (Pine deliberately absent) + label map. The no-slip return store chooser. | Registry flag `noSlipReturns:true`. |
| `src/money/records.js:51` | `RECYCLER_TILL = { storeId:"pe", tillId:"till-1" }`. | Registry: `recycler:true` on a till. |
| `src/money/records.js:53` | `CASH_STORE_IDS = ["pe","trophy"]` ("Pine is card-only for this build"). | Registry `cashRecon:true`; decide for concrete. |
| `src/money/records.js:55-60, 143, 150, 172, 174, 239` | `isRecyclerTill`, `isDrawerTill`, validators using `isValidTillId`; line 174 hardcoded message "Cash payouts are recorded at Marathon PE and Trophy tills." | Registry-driven; message from labels. |
| `src/recycler/drawerOwedRecord.js:48-49, 113-114` | `OWED_STORE_ID="pe"`, `OWED_TILL_ID="till-1"` (duplicate of RECYCLER_TILL, kept separate to avoid a firebase import). | Same registry flag. |
| `src/recycler/tillDeposit.js:150, 165-175` | `DEPOSIT_SOURCE_STORE_IDS = ["pe","trophy"]`; `depositSourceTills()` = STORES × tills filtered by it. | Registry: stores that bank into this recycler (same section only). |
| `src/config/posConfig.js:17-22, 86` | `/pos/config/{storeId}` defaults: `laybyStorageLocation:"hub1"`; validator allow-list `hub1,hub2,hub2b,hub3,hubC,warehouse1`. | Default must come from the store's registry hub; allow-list from registry hubs of the same section. |
| `src/sale/priceEditPolicy.js:20, 22-35` | `ALL_ROLES_MAY_EDIT_AT = {pine, marathon-pine}` — cashiers may edit price at Pine only. | Registry flag `cashierPriceEdit:true`; owner must say whether concrete gets it. |
| `src/device/deviceRegistry.js:18, 92` | `KNOWN_STORE_IDS` from `STORES`; error text "(pe | pine | trophy)". | Registry-backed; message from registry. |
| `src/mobile/MobileCustomerScreen.jsx:442-447` | `STORE_SHORT` and `STORE_MARKS` maps keyed pe/pine/trophy (falls back to label / AllMark for unknown). | Registry `shortLabel`; icon fallback already safe. |
| `src/mobile/StoreMarks.jsx:51, 62-63` | Per-store SVG marks (PeMark, PineMark, TrophyMark). | Add a mark or rely on fallback. |
| `src/reports/cardrecon/CardReconPhone.jsx:111-112` | `STORE_SHORT` duplicate map. | Registry `shortLabel`. |
| `src/display/CustomerDisplay.jsx:91-92` | Strips leading "Marathon " from the label (generic; comment only names stores). | none (works for "Concrete"). |

#### 1b. Literal ids / defaults inside logic

| file:line | what it does | change needed |
|---|---|---|
| `src/layby/laybyFulfillment.js:56` | `dispatchLaybyToHub({ storageHub = "hub1" })` default. | Remove default / derive from store. |
| `src/layby/laybyFulfillment.js:102` | pull record `storageHub = layby.storageHub ?? "hub1"`. | Derive from the layby's origin store's section hub. |
| `src/layby/LaybyDetailView.jsx:641, 661` | `parcel.storageHub ?? "hub1"`; `config.laybyStorageLocation ?? parcel.storageHub ?? "hub1"`. **Note order at 661: the per-store config (default "hub1") wins over the parcel's own stamped hub**, so a Pine parcel stamped hub3 dispatches to hub1 unless `/pos/config/pine/laybyStorageLocation` is set. Flagged as a likely cross-section move; I did not verify what the live config node holds. | Parcel stamp first; wall check. |
| `src/layby/LaybyDetailView.jsx:495-497` | Refuses a layby cancel unless header store === `sale.storeId`. (The only store-equality guard on layby actions; collect / pay / pull have none.) | Extend to section check for pull/collect. |
| `src/sale/logOrderCollection.js:37` | `placedAtHub = o.placedAtHub || o.hub || "hub1"`. | Section-aware default or none. |
| `src/sale/logFootwearSold.js:51` (comment) / `:58+` | `hub` on restock_log rows comes from saleRoutes; no literal default any more. | none |
| `src/sale/engineBuild.js:317-327, 343-346` | Layby parcel: `originStore = originLocationId(storeId)` validated against `CANONICAL_STORE_IDS`; `storageHub: hubForStore(storeId)`. | Registry; stamp `section`. |
| `src/print/receiptHtml.js:437, 456` | `buildTestSale()` fixture: `tillId:"till-1"`, store name "Marathon PE". | Cosmetic. |
| `src/print/laybyLabel.js:210` | test-label fixture `originStore:"marathon-pe"`. | Cosmetic. |
| `src/display/mockSale.js:34` | `STORE_NAME = "Marathon PE"` (preview mock). | Cosmetic. |
| `src/recycler/replay/runReplay.js:164-165`, `src/recycler/replay/replaySupervisor.js:336` | replay tooling defaults `storeId:"pe"`, `tillId:"till-1"`. | Dev tooling; leave or parameterise. |
| `src/mobile/MobileCustomerScreen.jsx:191-192, 402` | Courier purchase / credit issue from phone stamps `storeId: null, tillId: "mobile"`. | **A phone-issued credit has NO store → no section.** Needs a store (device registry storeId) before creditScope can work. |
| `src/sale/Cart.jsx:752-753, 769-770` (grep -a) | `validStoreIds = new Set(STORES…)`; PAY gated on store ∈ STORES and till ∈ store's tills. Does NOT check `posStoreIds`. | Registry + section/posAccess check. |
| `src/sale/Cart.jsx:641-649, 696-697` (grep -a) | Sellable-stock subscription keyed on `permRecord.storeId` (a `/users/{uid}.storeId` field), not the shift store. | Review: two different "my store" sources. |
| `src/sale/Cart.jsx:742` (grep -a) | `ordersScopeShop = permRecord.destShop` — a third per-user store field (canonical location id) scoping the `/orders` query. | Registry/section aware. |

#### 1c. Consumers of the lists (no literals of their own; change = keep working when the source becomes a registry)

| file:line | what it does | change needed |
|---|---|---|
| `src/shell/Header.jsx:30-32, 44, 52-54` | Store dropdown = `STORES` filtered by `posStoreIds` (empty = all); tills = `tillsForStore`; first till auto-picked. | Registry + section filter. |
| `src/settings/SettingsScreen.jsx:44-46, 49, 57-58, 98` | Same picker on the Settings screen. | Same. |
| `src/settings/TillSetupCard.jsx:78` (+ `src/offline/tillSetup.js:441-458`) | Offline mirror card; compares held stock leg's storeId to the shift store. | none beyond registry mapping. |
| `src/settings/CatalogueRefreshCard.jsx:3` | comment only. | none |
| `src/admin/PosUserModal.jsx:154-156` | Store checkboxes for `posAccess.storeIds` = `STORES`. | Registry; add section picker. |
| `src/admin/PosUsersScreen.jsx:98, 119` | Shows a user's stores via `storeLabel`. | Registry. |
| `src/admin/AdminHardware.jsx`, `src/admin/KioskLogScreen.jsx:51`, `src/admin/kioskLog.js`, `src/admin/posUsersApi.js` | No store literals. Kiosk log reads `pos/devices/{id}/name`. | none |
| `src/auth/*` | No store literals. `posAccess.js:26-28` derives `posStoreIds`. `PermissionsContext.jsx:3` hardcodes `ADMIN_EMAIL`. | See §7. |
| `src/cashup/CashupScreen.jsx:78-80, 87, 94, 105-107, 112` | Store picker = `STORES` ∩ `posStoreIds`; tills = `tillsForStore`. | Registry + section. |
| `src/cashup/useLeftInDrawer.js:24-35` | Builds `pos/cashups/{store}/{till}/{ymd}/left` paths for every till of the given stores. | Registry. |
| `src/cashup/leftInDrawer.js:54-60` | `mayEnterLeftFor` — manager scoped by `posStoreIds`. | Section-aware. |
| `src/cashup/useTillBanked.js:33, 78`, `src/cashup/useCashup.js:33, 76`, `src/cashup/cashupStats.js`, `src/cashup/floatCarryForward.js` | Keyed by store/till passed in; no lists. | none |
| `src/reports/DateStorePills.jsx:53-62` | Report store chips = "All" + `STORES`. | Registry; add section chips; "All/combined" owner-only. |
| `src/reports/useCashupRange.js:26-28` | `"all"` → `STORES` × `tillsForStore`. | Registry. |
| `src/reports/CashupReport.jsx:28, 53, 113-114, 148` | Totals limited to `posStoreIds` unless owner. | Section-aware. |
| `src/reports/useSalesRange.js:68`, `src/reports/usePaymentEvents.js:57`, `src/reports/useSales.js:100-101, 796-797`, `src/offline/salesRead.js:188-192` | Filter by `storeId` or `"all"` client-side after a whole-range read. | Add a section filter (set of store ids). |
| `src/reports/cashupReportStats.js:21-147`, `src/reports/cashStats.js`, `src/reports/sales-stats.js`, `src/reports/OfflineFlagsTab.jsx:90` | Group by the storeId on the record; no lists. | none (add section grouping). |
| `src/reports/cardrecon/*` | Terminals come from `/config/cardTerminals`; `useCardReconRows.js:26` filters by store. Labels via `storeLabel/tillLabel`. `matcher.js:55`, `dayRows.js:197` comments only. | See §6. |
| `src/reports/eftpool/EftPoolTab.jsx:345-353`, `src/reports/negativecredit/NegativeCreditTab.jsx:8, 143` | Labels only. | none |
| `src/money/CollectionsScreen.jsx:44, 48` | Stores = `STORES` ∩ `CASH_STORE_IDS` ∩ `posStoreIds`; drawer tills only. | Registry. |
| `src/money/reconcile.js:114, 338-339, 346-347` | Sessions without a store default to `RECYCLER_TILL`; rows restricted to `CASH_STORE_IDS`; iterates `tillsForStore`. | Registry. |
| `src/money/useMoneyData.js:86, 107`, `src/money/MoneyScreen.jsx:87` | Read ranges over `CASH_STORE_IDS`. | Registry (per section + combined). |
| `src/money/CashOutScreen.jsx:42` | Hardcoded sentence "…at Marathon PE and Trophy tills." | From registry. |
| `src/money/MoneyPhone.jsx`, `RecyclerOfflineLine.jsx`, `PayoutDetail.jsx`, `moneyParts.js`, `cashboxDrop.js`, `CashboxDropButton.jsx`, `usePayoutsToday.js`, `readers.js` | Labels / pass-through ids. | none |
| `src/recycler/RecyclerTerminalPanel.jsx:81, 122`, `KioskSelfRegistration.jsx:46`, `kioskSelfRegistration.js:15`, `TillDepositPanel.jsx:180`, `RecyclerCashupPanel.jsx:94`, `useRecyclerCashup.js:50-51`, `ownershipPolicy.js:49`, `RecyclerProvider.jsx:138` | Use STORES / `isRecyclerTill` / device registration store+till. | Follow the registry flag. |
| `src/recycler/salePaid.js:225`, `useMoneyStaysWithSale.js:2`, `recyclerPrefs.js:44`, `connectionRecorder.js:3` | comments only. | none |
| `src/inventory/stockHealth.js:11, 16-19` | `SHOP_LOCATIONS = CANONICAL_STORE_IDS`; everything else under `/stock` counts as "warehouse". `useInventoryHealth.js:57` reads ALL of `/stock`. | Section split of the health card; registry. |
| `src/inventory/stockReads.js:54-59` | Subscribes `/stock/{location}` for the store. | Registry mapping. |
| `src/stock/stockReads.js:14`, `useDispatchOrders.js:17`, `dispatchOrders.js:50`, `src/sale/useLiveOrders.js:21`, `src/sale/orderLookup.js:112`, `src/shared/ordersFeed.js:36-37` | `/orders` filtered by `destShop === sellableStockLocation(store)`. | Registry mapping. |
| `src/sale/logClothingSold.js:34` | `destShop = sellableStockLocation(storeId)` on insights_log rows. | Registry. |
| `src/stock/stockAvailability.js:132-137, 334-340` | Add-to-cart: probes ALL `SNEAKER_HUBS`; partner lookup. | Per-section hubs. |
| `src/stock/partnerRouting.js:94, 142` | Uses `partnerLocation`. | Registry. |
| `src/stock/crossStoreNotice.js:19, 26`, `src/sale/CartSummaryPanel.jsx:230, 256` | Labels "Coming from …". | none |
| `src/offline/sync.js:436, 883-888, 1740-1746, 1786-1803` | Mirrors `/stock/{sellableStockLocation(shiftStore)}` only; unknown store → `unmapped-store` (refuses). | Registry mapping; a section-1 footwear sale also needs its hub cells (not mirrored today for any store). |
| `src/offline/stockRead.js:112`, `rtdbAdapter.js:69`, `health.js:178, 406`, `staging.js`, `bootstrap.js:43, 181`, `connectionRecorderBoot.js:9`, `outboxItems.js:59-184`, `queuedBalances.js` | Pass-through of shift storeId / canonical location. | none beyond mapping. |
| `src/layby/LaybyExceptionsScreen.jsx:61-63`, `OpenLaybysScreen.jsx:122`, `src/print/laybyLabel.js:92` | `locationLabel` display. | Registry labels. |
| `src/customers/OwingList.jsx:62-63`, `StoreCreditSection.jsx:36-37`, `src/saleHistory/SaleHistoryScreen.jsx:209, 476-477, 753`, `src/shared/saleToReceipt.js:190`, `src/display/CartBroadcaster.jsx:27`, `src/cart/useRestoreValidation.js:46`, `src/mobile/ReturnWizard.jsx:46, 364` | Labels / till filter. | Registry labels. |
| `src/shell/Sidebar.jsx:46`, `SelectedShiftProvider.jsx:70`, `src/shared/footwearLine.js:12`, `src/shared/ordersFeed.js:21`, `src/sale/engine.js:240`, `src/stock/saleRouting.js:11, 37, 91` | comments only. | none |

---

### 2. How a device gets its store and till

- **Model:** a "shift" `{ storeId, tillId }` held in React context and persisted in **localStorage** key `marathon-pos.shift-context` (`src/shell/SelectedShiftContext.jsx:21`; legacy key `marathon-pos/selectedStoreId` line 22). Provider: `src/shell/SelectedShiftProvider.jsx:21-43` (read), `45-63` (persist), `68-99` (setShift: changing store clears till), `101-111` (cross-tab sync).
- **It is per browser profile, not per user and not per device record.** Nothing in RTDB assigns a till to a device for selling. Whoever signs in on that browser inherits the stored store/till.
- **UI:** header dropdowns `src/shell/Header.jsx:28-59`; duplicate on `src/settings/SettingsScreen.jsx:42-59, 98`. Lists come from `STORES` / `tillsForStore` (`src/shared/stores.js`), filtered by `posStoreIds` for display only.
- **Enforcement at sale time:** `src/sale/Cart.jsx:731-770, 787, 807, 1029-1033, 1209-1210` (grep -a) — store must be in `STORES`, till in that store's list. **There is no check that the shift store is in the user's `posAccess.storeIds`** — a stale localStorage store from another user's session passes. The filter is cosmetic. I found no server-side check in `src/`; rules/functions are out of scope.
- **Other readers of the shift:** `IssueCreditModal.jsx:35,66-67`, `RemoveCreditModal.jsx:28,60-61`, `OnAccountSection.jsx:41,86`, `LaybyDetailView.jsx:158-162, 299-301`, `CashupScreen.jsx`, `CashOutScreen.jsx`, `CartBroadcaster.jsx:27`, `KioskSelfRegistration.jsx`, `recycler/ownershipPolicy.js:14-49` (reads the localStorage key directly), `offline/bootstrap.js:24,43,181` and `offline/connectionRecorderBoot.js:9` (read the key directly).
- **Device registry** `/pos/devices/{deviceId}` (`src/device/deviceRegistry.js:82-84`): `{ name, storeId, registeredByUid, registeredAt, lastSeenAt, itlBaseUrl?, tillId? }` (lines 99-112). `deviceId` is a random UUID in localStorage key `marathon.deviceId` (`src/device/deviceId.js`). Registration cached in localStorage `marathon-pos.deviceRegistration` (`src/device/useDeviceIdentity.js:20`). Writers: `recycler/RecyclerTerminalPanel.jsx:92`, `recycler/KioskSelfRegistration.jsx` (kiosk only). **The registry's storeId/tillId does NOT drive the shift**; it is used for audit names and the recycler (which till is the machine). Phones use it only for audit metadata (`mobile/ReturnWizard.jsx:52`).
- **Two more per-user store fields exist on `/users/{uid}`:** `storeId` (Cart.jsx:641-649, 696) and `destShop` (Cart.jsx:742). They are read by the cart for stock subscription / orders scope and are independent of the shift.
- **Mobile:** no shift at all. No-slip return picks a store from `RETURN_STORES` in the wizard (`ReturnWizard.jsx:95-96, 364`); phone credit actions stamp `storeId:null, tillId:"mobile"`.

---

### 3. Numbering

- **One set of GLOBAL counters, no store in the path or the format.** `src/sale/receiptNumber.js:11-27`:

| type | prefix | counter path |
|---|---|---|
| sale | `S` | `pos_meta/lastSaleNumber` |
| layby | `L` | `pos_meta/lastLaybyNumber` |
| refund (also layby-cancel refund, credit note) | `R` | `pos_meta/lastRefundNumber` |
| exchange | `X` | `pos_meta/lastExchangeNumber` |
| no_receipt_return | `NR` | `pos_meta/lastNoReceiptReturnNumber` |

- Format: `{PREFIX}-{counter padded to 5}` (`receiptNumber.js:29, 53-58`); parser regex `^(NR|[SLRX])-(\d+)$` (line 74) — **a store-prefixed number would not parse**; `isValidReceiptNumber` is used at cart-restore, search and lookup boundaries, and `creditHistoryRows.js:67` has its own regex `^[A-Z]{1,2}-\d+$`.
- Reservation: `src/sale/receiptNumberAssignment.js:93-176` `reserveReceiptNumber(type)` — takes ONLY the type. Live path: `runTransaction(counterRef, c => c+1)` (lines 145-155), 8 s bound (line 39). Offline-selling path: draws from a per-till BLOCK (lines 115-144).
- Blocks: `src/offline/numberBlocks.js:50-56` sizes (sale 250, exchange 20, refund 20, layby 5, NRR 10); `reserveBlock` lines 141-155 does `runTransaction(path, c => c + N)`; blocks stored in IndexedDB store `numberBlocks` **keyed by receipt type only** (`src/offline/outboxDb.js:39, 432-498`); the counter watch (`numberBlocks.js:170+`) and observed-counter meta `counters.observed` are also keyed by type.
- Callers: `src/sale/engine.js:418` (sale), `:482` (refund/exchange), `:584` (layby), `:1053` (layby completion sale — an S- number), `:1451` (writeRefund), `:1513` (layby cancel → R-); `src/return/noReceiptReturnWriter.js:201, 324` (NR-). All have `draft.storeId` in hand at the call site but do not pass it.
- Training mode returns `TRAIN-####` (`receiptNumberAssignment.js:101-104`).
- Other counters: customer codes `customers_meta/lastCode` (`src/customers/codeAssignment.js:46-53`) — shared with the store app, not per store.
- "Order numbers" (`/orders/*`) are minted by the store app, not here. The POS only reads them (`sale/orderLookup.js`, `useLiveOrders.js`). Not verified where they are generated.

**What a per-store sequence starting at 001 needs (exactly):**
1. `counterPathForType(type)` → `counterPathFor(type, storeId)` with a registry-driven namespace, e.g. `pos_meta/{seqKey}/lastSaleNumber`; PE/Trophy keep the existing un-namespaced paths so their sequence continues. A new path that does not exist bootstraps to 1 automatically (`receiptNumberAssignment.js:149-154`; block path `numberBlocks.js:148`).
2. `formatReceiptNumber`/`parseReceiptNumber` need a store marker or two stores will both issue `S-00001` — receipt numbers are used as lookup keys (sale search, return picker, credit ledger `ref`, layby `invoiceNo`, EFT attach). Uniqueness today is purely "one global counter".
3. `reserveReceiptNumber` and all 7 call sites must pass `storeId`.
4. Offline blocks: IndexedDB key, `BLOCK_TYPES` loop, counter watch, `OBSERVED_COUNTER_META`, and `refiller.acceptFor(type)` are all per TYPE; they must become per (type, sequence). A till that switches store would otherwise draw another store's block.
5. RTDB rules for the new counter paths (out of scope here; the comment at `numberBlocks.js:164-169` mentions a not-yet-deployed backwards-write rule).
6. Padding: brief says "001"; code pads to 5 (`MIN_DIGITS`).

---

### 4. Stock-affecting write paths

**Single chokepoint:** every POS stock write is a normalized move → `toStockIntents` (`src/stock/saleStockMovements.js:302-425`) → `enqueueStockIntents` (`src/stock/stockQueue.js:208`) → `applyStockMovement` (`src/stock/stockMovement.js:118-149`), drained by `stock/stockReconciler.js:65`. Entry: `recordSaleStock` (`src/sale/engine.js:172-213`).

Paths written per intent (`stockMovement.js:82-110`): `stock/{loc}/{productId}/{sizeKey}/{qty,v,mv,lastType,updatedAt,updatedBy}` and `stock_movements/{type}:{recordId}:{loc}:{productId}:{sizeKey}`. POS only writes types `sold` and `return` (line 48). Sold floors at 0 and records `shortfall`.

Location resolution in `toStockIntents`: `loc = m.locOverride ?? sellableStockLocation(m.storeId)` (line 338-339); skipped when price product, route sentinel, not in `WRITABLE_STOCK_LOCATIONS` (a `return` falls back to the shop, a `sold` is skipped), in `NON_DEDUCTING_LOCATION_IDS`, or footwear one-size at a hub. **This function is where a section-wall assertion belongs** (it sees the selling/handling `storeId` and the resolved `loc` for every path below).

| # | path | function (file:line) | how the location is chosen | can cross the wall? |
|---|---|---|---|---|
| 1 | Sale deduction (non-footwear) | `writeSaleImpl` `engine.js:416-466` → `movesForSaleOrLayby` `saleStockMovements.js:155-159` | shop cell of `draft.storeId`, unless the partner layer routes it. | No (own shop). |
| 2 | Cross-store sell (partner) | `routePartner` `engine.js:297-320` → `resolvePartnerSaleRoutes` `partnerRouting.js:140-175`; add-time stamp `soldLoc` `stockAvailability.js:334-341` | partner cell when local qty ≤ 0 and partner > 0, or line stamped `soldLoc`. | Only if a pair spans sections. Today's pair is inside Section 2. |
| 3 | Sneaker hub deduction | `routeSales` `engine.js:266-293` → `resolveSaleRoutes` `saleRouting.js:252-339`, baseline `:157-183`, `pickFootwearHub` `:116-122` | 1) line `sourceHub` stamp (from the `/orders` dispatch record), 2) whichever of hub1/hub2/hub3 holds the cell (`readHubQtyForCell` `:125-136`), 3) `BRAND_TO_HUB`, 4) sentinel = deduct nowhere. | **YES.** Layers 2 and 3 are store-blind: a PE/Trophy sale can deduct hub3 (Section 1), and a Pine/Concrete sale can deduct hub1/hub2 (Section 2). Brand fallback only ever names hub1/hub2. |
| 4 | Layby creation (reserve) | `writeLaybyImpl` `engine.js:577-605` | identical to a sale (same `sold` movement, keyed by the layby id). | Same as rows 1-3. |
| 5 | Layby collect / completion | `markLaybyCollected*` `engine.js:1291-1440`, `writeLaybyCompletionSaleImpl` `:991-1110` | No stock write (comment `:984`). | Stock: no. But a layby may be paid/collected at any store (no store guard) → money/attribution crosses. |
| 6 | **Layby cancel restock** | `cancelLaybyImpl` `engine.js:1504-1563`; routes `:1541-1546`; moves `movesForCancel` `saleStockMovements.js:232-237` | `routeReturns({ storeId: prior.storeId, sourceRecordId: layby id })` → ledger sold-cell if found, else the return hierarchy from the ORIGIN store; fallback = origin store's shop cell. | YES via the hierarchy (holdings/majority/brand hub are section-blind). |
| 7 | Refund (legacy `writeRefund`) | `writeRefundImpl` `engine.js:1449-1502` (comment `:1445-1448` says it has no live caller) | `routeReturns({ storeId: refund store, sourceRecordId: original })`. | Same as row 9. |
| 8 | Void sale | `voidSale` `src/saleHistory/voidSale.js:237-254` | `routeReturns({ storeId: sale.storeId, sourceRecordId: sale.id })`; base store = the sale's store. | Via hierarchy only. |
| 9 | Return / exchange (unified) | `writeUnifiedImpl` `engine.js:477-570`; moves `movesForUnified` `saleStockMovements.js:282-296` | Return half: base store = the line's `sourceStoreId` (ORIGINAL sale's store, set at `return/returnPicker.js:163`), route resolved against the SHIFT store (`engine.js:527`). Sold half: shift store + sale routing. | **YES.** A Section-2 sale returned at a Section-1 till restocks the ORIGINAL store's cell (or its ledger cell / hub) while the unit physically stands in the other section. No guard stops returning another store's sale. |
| 10 | No-receipt return | `writeNoReceiptReturnImpl` `src/return/noReceiptReturnWriter.js:194-381`; route at `:336`; `restockLoc` persisted per line `noReceiptReturnBuild.js:163`; moves `:350` | Store picked in the wizard (`RETURN_STORES`), then `routeReturns` hierarchy (no ledger, no stamp). | Via hierarchy (holdings/majority/brand). Deploy gate applies (memory: No Receipt Return #185 is STOP-and-ask). |
| 11 | Void credit note (re-deducts returned units) | `voidCreditNoteImpl` `src/return/voidCreditNote.js:187-199` | `routeSales({ storeId: note.storeId })` then `movesForSaleOrLayby(note.lineItems, note.storeId, …)`. | Same as row 3. |
| 12 | Offline replay | `src/offline/outboxWorker.js:205-207` enqueues the intents saved on the item (built at ring time); queued layby cancel `engine.js:1547-1558`. | Location was fixed at ring time; `routeSales`/`routeReturns` with `liveReads:false` use the baseline only (stamp + brand table; returns → shop). | Brand table → Section-2 hubs for any store. |
| 13 | Training mode | `engine.js:193-197` | journal only. | n/a |

Return hierarchy (`pickReturnDestination`, `src/stock/returnRouting.js:118-226`), in order: ledger sold cell (`:138`) → partner stamp (`:173`) → shop-kept category stays / partner owner (`:176-199`) → single holding location (`:201-209`, refuses only the OTHER SHOP, not another section's hub) → `sourceHub` stamp / majority holding (`:210-223`) → `BRAND_TO_HUB` (`:224`) → stay. Holdings are read from the six locations in `STOCK_LOCATIONS` (`:230-245`).

Non-`/stock` writes that still move goods in the other app (not stock cells, but they drive hub work):
- `restock_log/{date}` rows — `sale/logFootwearSold.js:97`, `sale/logOrderCollection.js:41` (hub = route or `"hub1"` default); cancelled by `sale/cancelRestockRequests.js:71-84`.
- `insights_log` — `sale/logClothingSold.js`.
- `orders/{id}/status = collected` — `sale/markOrderCollected.js:22-24`.
- `laybys/{id}` (parcel; `storageHub`) — `engineBuild.js:272`; `laybyFulfillment.js:56-70` (dispatch to hub), `:91-131` + `:139-158` (`laybyPulls/{pullId}` with `requestingStore` = SHIFT store, `storageHub`). **A pull can be requested by any store for any layby** → hub → store parcel move across the wall. `requestLaybyReturnPull` (`:153-158`, called `LaybyDetailView.jsx:559`) = "return_to_stock" pull.

#### The known defect — "layby cancel restocking to the wrong location"

It lives in `cancelLaybyImpl`, `src/sale/engine.js:1541-1560`, with the destination decided by `routeReturns` (`engine.js:328-347`) → `resolveReturnRoutes`/`pickReturnDestination` (`src/stock/returnRouting.js:252-340`, `118-226`) and `movesForCancel` (`src/stock/saleStockMovements.js:232-237`).

What the code does: the restock is computed purely from the layby's ORIGIN store (`prior.storeId`) and the ledger/holdings hierarchy. It never reads the parcel record (`/laybys/{id}.storageHub`, `status`, `receivedBy`), so it has no idea where the goods physically are (in the store, in transit, at the storage hub, or sent to another store by a pull). When the ledger lookup fails or the till is offline (`liveReads:false` → `{}`), every line lands on the origin store's shop cell — including Pine's, where `marathon-pine` is non-deducting, so the restock is silently skipped (`non_deducting_store`) while the creation-time deduction may have hit a hub. The UI only requires header store === origin store (`LaybyDetailView.jsx:495-497`); the separate "return to stock" hub pull (`:559`) is a second, independent mechanism. I am inferring this is the defect from the code; I have not seen the original bug report, so confirm the exact symptom with the owner.

---

### 5. Store credit / layby / owed-money records

#### Records and what they stamp today

| record | path | written at | store/till stamped? |
|---|---|---|---|
| Credit claim (pre-mint) | `pos/storeCreditQueue/{creditId}` | manual `customers/storeCreditApi.js:48-65`; refund `sale/engineBuild.js:499-509`; layby cancel `:651-661`; return/exchange `:848-852`; no-receipt return `return/noReceiptReturnBuild.js:255-265` | `storeId` + `tillId` on ALL of them (null-able; phone = `null`/`"mobile"`). |
| Canonical credit | `pos/storeCredits/{creditId}` | **server only** (callable `issueStoreCredit`, `customers/issueStoreCredit.js:18-21`; sweep). Shape not visible from `src/` — functions agent must confirm whether it copies `storeId`. | unknown from client. |
| Customer mirror (what the till SPENDS against) | `customers/{customerId}/storeCredit/{creditId}` | `engineBuild.js:510-513, 662-665, 853`; `noReceiptReturnBuild.js:266-269` | **No.** Only `{ remainingAmount, issuedAt }`. |
| Issue audit | `pos/audit/store_credit_issued/{customerId}/{creditId}` | `engineBuild.js:515, 854`; `noReceiptReturnBuild.js:270` | no store. |
| Removal audit | `pos/audit/store_credit_removed/{customerId}/{eventId}` | `storeCreditApi.js:111-127` | storeId, tillId. |
| Redemption | `pos/storeCredits/{id}/redemptions/{saleId}` = `{amount, at}` + `remainingAmount` increment + mirror increment | sale `engineBuild.js:144-162`; exchange `:905-912`; offline clamp `offline/storeCreditOverspend.js`, `offline/outboxWorker.js:114-218` | no store on the redemption itself (the sale carries it). |
| Unified ledger txn | `pos/creditLedger/{customerId}/txns/{txnId}` + `/balance` | `credit/creditLedger.js:131-155`; callers `engineBuild.js:173-180, 188-198, 880-892, 921-927`, `storeCreditApi.js:135-145`, `noReceiptReturnBuild.js:282-292`, `credit/onAccountApi.js:121-128, 157-194` | `storeId`, `tillId`, `staffUid` on every txn (required for at-till sources, `creditLedger.js:111-117`). |
| On-account (owed) | `pos/creditLedger/{customerId}/{balance, creditLimit, accountType}` | `credit/onAccountApi.js:48-51, 93-107` | ONE signed balance per customer — not per store. |
| Arrears / Owing | `pos/creditLedger/{c}/txns/arr_{saleId}`, `pos/creditLedger/{c}/arrears/arr_{saleId}`, index `pos/creditArrears/{c}` (+`/incidents/{txnId}`) | `credit/arrears.js:45-84` | storeId, tillId, staffUid on each incident. |
| Layby (money) | `pos/sales/{saleId}` type `layby` + `customers/{c}/laybyHoldings/{saleId}` | `engineBuild.js:212-285` | `storeId`, `tillId` on the sale; `storeId` on the holding (`:263`). |
| Layby parcel | `laybys/{saleId}` | `engineBuild.js:307-349` | `originStore` (location id), `storageHub`. |
| Layby instalment | `pos/sales/{id}/payments/*` + `pos/paymentEvents/*` + `laybys/{id}/balanceRemaining` | `engine.js:750-935` | paying store/till on the payment event (`:921`). |
| Sale | `pos/sales/{saleId}` | `engineBuild.js:47-90` | `storeId`, `tillId`. |
| Payment event | `pos/paymentEvents/{eventId}` | `sale/paymentEvents.js:96-130` | `storeId`, `tillId`. |
| No-receipt marker | `pos/noReceiptReturns/{saleId}` | `noReceiptReturnBuild.js:241-250` | `storeId`. |
| Overspend flag | `pos/storeCreditOverspend/*` | `offline/storeCreditOverspend.js:39` | (not inspected in detail). |

#### Where credit is spent / validated (client)

- Balance + picker: `src/sale/Payment.jsx:112-177` `fetchCustomerCredits` reads **`customers/{id}/storeCredit`** (the mirror), plus queued outbox effects (`offline/queuedBalances.js`). Legs drawn oldest-first across ALL of the customer's credits: `storeCreditLegsFor` `Payment.jsx:183-194` using `planCreditRemoval` (`customers/storeCreditLedger.js`). Tile availability `Payment.jsx:989-1000`; staging `:859-884`.
- Tender validation: `src/sale/tenders.js:48-79` (amount ≤ available, needs a credit id).
- Commit: `engineBuild.js:138-181` (sale) and `:894-928` (exchange) — blind `increment(-amount)`; RTDB rule (facsimile in the fake: `remainingAmount >= 0 and never increases`) is the only server validation. **There is no callable on the spend path.**
- Manual removal: `storeCreditApi.js:89-148` (transaction on the mirror).
- Phone courier purchase spends credit: `mobile/courier.js` / `MobileCustomerScreen.jsx:184-194` with `storeId:null`.
- On-account: `Payment.jsx:85-102` (available = limit + balance), `onAccountApi.js:93-107` transaction limit check.
- Reads of the canonical record: `engine.js:1625-1630` `readStoreCredit`, `engine.js:386-395` depletion flip, `SaleHistoryScreen.jsx:674`.

#### Adding `section` + creditScope without rewriting history

- Stamp `storeId` + `section` on: the queue claim (5 writers above), the customer MIRROR entry (4 writers) and the ledger txn (`ledgerTxnRecord`, one place). The mirror is the node the spend path reads, so the section must be there (or the spend path must additionally read `pos/storeCredits/{id}`, which costs a read per credit and is not available offline).
- Historic mirror entries have no store. A read-time rule is needed: missing `section` ⇒ derive from `pos/storeCredits/{id}.storeId` / the claim / the issuing sale's `storeId` if present, else treat as `shared` (or Section 2, since all historic credit was issued at pe/trophy/pine — **Pine is Section 1, so "all historic = Section 2" is false**; the owner must rule).
- Enforcement point: `fetchCustomerCredits` (filter credits to the till's section when `creditScope === "section"`), `storeCreditLegsFor`, and the offline clamp/reallocation in `offline/storeCreditOverspend.js` + `outboxWorker.js:144-155` (which reallocates across the customer's OTHER credits and would otherwise pull from another section). Server-side enforcement would need a rule or callable; today there is none on redemption.
- On-account / arrears are a single per-customer signed balance; "section-scoped owed money" cannot be expressed without either per-section balances or deriving from txns (each txn does carry storeId).

---

### 6. Reports, card recon, cash-up

**Reports** (`src/reports/ReportsDashboard.jsx:119-124, 227`): one `storeId` state (`"all"` or a store) → `useSalesRange` / `usePaymentEvents` read the whole date range then filter client-side (`useSalesRange.js:68`, `usePaymentEvents.js:57`). Chips from `STORES` (`DateStorePills.jsx:53-62`). No section concept. Route `/pos/reports` is `RequireAdmin` (owner-only) — `src/App.jsx:249-254`; comment `:258`. Mobile activity view uses the same hooks (`MobileCustomerScreen.jsx:480-489`).

**Cash-up** (`src/cashup/`): node `pos/cashups/{storeId}/{tillId}/{YYYY-MM-DD}` (`useCashup.js:33`), `/left` and `/leftHistory/*` (`leftInDrawer.js:9-11`). Stores/tills enumerated from `STORES` ∩ `posStoreIds` and `tillsForStore` (`CashupScreen.jsx:78-113`). Roles: cashier = own shift till, blind; manager = picker within their stores; owner = everything (`CashupScreen.jsx:66-80`, `leftInDrawer.js:54-60`). Route `admin/cashup` is NOT role-gated at the router (`App.jsx:301`). Cash-up report `reports/useCashupRange.js:26-33` reads one query per store×till; totals filtered by `posStoreIds` (`CashupReport.jsx:53`).

**Money reconciliation** (`src/money/`): records via callables (`moneyReadRange`, `moneyPayoutsToday`, `moneyPayoutRecord`, `moneyCollections`, `moneyFloats`, `moneyDrops` — `money/readers.js:28-60+`); node roots named in `money/records.js:44-48` (`till_collections`, `till_floats`, `till_float_events`, `till_payouts`, `cashbox_drops`) — **I could not confirm the full path prefix from `src/`; the functions agent owns that**. Client-readable recycler nodes: `pos/till_deposits/{terminalId}`, `pos/recycler_collections/{terminalId}`, `pos/cash_sessions/{terminalId}`, `pos/recycler_owed`, `pos/recycler_levels`, `pos/recycler_health`. Hardcoded: `CASH_STORE_IDS`, `RECYCLER_TILL`, `DEPOSIT_SOURCE_STORE_IDS`, `OWED_*` (see §1a). Routes: `admin/money` RequireAdmin (`App.jsx:221, 324`), `admin/collections` RequireManager (`:215, 323`), `cash-out` open (`:248`).

**Card recon** (`src/reports/cardrecon/`):
- Terminal registry: `/config/cardTerminals/{TID}` → `{ mid, storeId, tillId, label, activeFrom?, retiredAt?, tillChangedAt? }` (`useCardRecon.js:26-50`; map key wins as `tid`). Owned/written by the store app; the POS only reads.
- Effective-dating: `terminalWasActiveAt` (`batchData.js:150-157`: `activeFrom`, `retiredAt`, both fail-safe to "active") and `terminalOnTillAt` (`dayRows.js:245-249`: `tillChangedAt` = on its CURRENT till only from that moment). It is a single "moved at" stamp, not a history list — one move per terminal is representable.
- Batches: `/card_batches/{storeId}/{tid}/{batchKey}` (top-level, owner-only by rule per comments `useCardRecon.js:3-17`), subscribed per terminal (`useCardRecon.js:58-124`).
- Matching POS side: card legs from `pos/paymentEvents` filtered by `storeId`+`tillId` window (`batchData.js:78-110`).
- Store enumeration: derived from the terminals registry, filtered by one store or `"all"` (`useCardReconRows.js:21-46`); `CardReconPhone.jsx:60` always `"all"`.
- **No hardcoded TIDs in non-test `src/`** (grep for 8-char TIDs found only a comment at `dayRows.js:241`).
- Gating: `CardReconPhone.jsx:46-47` `isSuperAdmin` only; routes RequireAdmin (`App.jsx:222, 326`); photos need `permFlags.card_recon` or owner plus the `card_recon` auth claim (`CardReconTab.jsx:572-573`, `photoAccess.js:28-60`).
- A new store's terminals appear automatically once registered with `storeId: "concrete"`; only labels (`storeLabel/tillLabel`, `STORE_SHORT`) depend on the hardcoded lists.

---

### 7. Access scoping

| item | file:line | notes |
|---|---|---|
| Owner check | `src/auth/PermissionsContext.jsx:3` `ADMIN_EMAIL = "gunidmoh@gmail.com"`; `AuthProvider.jsx:56`; `posAccess.js:18`; `fingerprint/identity.js:20-22`; `customers/editCustomer.js:162` | Single hardcoded email = `isSuperAdmin`. Client-side. |
| User record | `/users/{uid}` live-subscribed `AuthProvider.jsx:44`; all users `auth/useUsers.js:24`; `cashier-switch/secondary-auth.js:40`; `fingerprint/identity.js:44` | `permRecord` also carries `permFlags`, `storeId`, `destShop`. |
| posAccess shape | `/users/{uid}/posAccess` = `{ isActive, role: manager|cashier, storeIds: [], displayName, eftReview?, saleOnly? }`; derivation `src/auth/posAccess.js:17-44`; SCHEMA.md:98-133 | `storeIds: []` (or missing) = ALL stores. Written only by callables `createPosUser/updatePosUser/removePosUser` (`admin/posUsersApi.js:7-9`). |
| posStoreIds consumers | `Header.jsx:30-32`, `SettingsScreen.jsx:44-46`, `CashupScreen.jsx:78-80`, `cashup/leftInDrawer.js:57`, `money/CollectionsScreen.jsx:43-45`, `reports/CashupReport.jsx:53` | Picker filters + cash-up scoping only. **Not checked at sale/refund/credit/layby write.** |
| Route gates | `App.jsx`: `RequirePosAccess` `:175, 232`; `RequireAdmin` `:82, 221, 222, 224, 252, 275, 283, 324, 326, 328, 332, 340`; `RequireManager` `:215, 315, 323`; `RequireEftReview` `:208, 265` | `auth/RequireAdmin.jsx:7-9`, `RequireManager.jsx:8-10`, `RequirePosAccess.jsx:11-14`. |
| Role checks in features | `sale/priceEditPolicy.js:22-35`; `customers/CustomerScreen.jsx:295`; `recycler/tillDeposit.js:184, 203-204`; `recycler/kioskSelfRegistration.js:14`; `settings/TillSetupCard.jsx:155`; `shell/Sidebar.jsx:85, 142-152`; `fingerprint/identity.js:25-37` | |
| Manager PIN | `managerPin/verifyManagerPin.js:13` callable `verifyManagerPin` | not store-scoped from the client's view. |
| Device registry | `/pos/devices/{deviceId}` `device/deviceRegistry.js:82-138` (`storeId` validated against `STORES`) | Not an access control. SCHEMA.md:297 notes the write rule is still broad ("RTDB rule still owed"). Memory mentions a store-app device-enrolment/quarantine system (#647/#640) — I found **no** reference to `mirror_devices`, `deviceCodeRequired` or quarantine in POS `src/`; that system appears to be store-app only. |
| Empty-array trap | RTDB cannot store `storeIds: []` — it reads back as missing; `posAccess.js:28` handles missing as `[]` = all stores | A section scope must NOT use "empty = all" or a user whose only section entry is removed becomes all-sections. |

---

### 8. RTDB namespace used by POS `src/`

Under `/pos`: `sales/{saleId}` (all record types; children `lineItems`, `payments`, `refund`, `layby`, `creditNote`, `status`), `paymentEvents/{id}`, `storeCredits/{id}` (+`redemptions/{saleId}`), `storeCreditQueue/{id}`, `storeCreditOverspend`, `creditLedger/{customerId}` (`balance`, `creditLimit`, `accountType`, `txns`, `arrears`), `creditArrears/{customerId}` (+`incidents`), `creditReconciliation/findings`, `noReceiptReturns/{saleId}`, `audit/{key}` and `audit/store_credit_issued|store_credit_removed/{customerId}/{id}`, `cashups/{storeId}/{tillId}/{ymd}`, `config/{storeId}`, `devices/{deviceId}`, `parked_eft_sales/{storeId}/{parkId}`, `cash_sessions/{terminalId}/{sessionId}`, `till_deposits/{terminalId}/{id}`, `recycler_collections/{terminalId}/{id}`, `recycler_owed/{terminalId}/{id}`, `recycler_levels/{terminalId}`, `recycler_health/{terminalId}`, `fingerprint_enrolments/{moduleUid}/{slot}`.

Top-level: `pos_meta/last{Sale,Layby,Refund,Exchange,NoReceiptReturn}Number`; `customers/{id}` (+`storeCredit/{creditId}`, `laybyHoldings/{saleId}`, `code`); `customers_meta/lastCode`; `customer_index/sales/{customerId}/{saleId}`; `laybys/{laybyId}`; `laybyPulls/{pullId}`; `stock/{loc}/{pid}/{size}`; `stock_movements/{mvId}`; `restock_log/{date}/{id}`; `insights_log`; `orders/{id}`; `products`; `users/{uid}`; `config/cardTerminals/{TID}`; `card_batches/{storeId}/{tid}/{batchKey}`; `eft_pool`, `eft_unallocated` (owner read; tills use callables `eftPoolSearch/List/Settle/Reverse`, `eftParkedCheck`); `mirror_changes` (offline mirror feed); money roots named `till_collections|till_floats|till_float_events|till_payouts|cashbox_drops` (prefix unverified — callable-owned).

Store-keyed nodes (need a `concrete` branch or work automatically by key): `pos/cashups/{storeId}`, `pos/config/{storeId}`, `pos/parked_eft_sales/{storeId}`, `card_batches/{storeId}`, the `till_*` money roots. Everything else is flat with a `storeId` FIELD — so per-section reads are client-side filters over whole-range reads, not scoped queries.

No `database.rules.json` is in this repo (`firebase.json` is hosting-only); rules are console/store-app managed.

---

### 9. Test setup

- Runner: `npm test` = `vitest run` (`package.json`); `vitest.config.js` — jsdom, globals, setup `src/test-setup.js`; includes `src/**/__tests__/**/*.test.{js,jsx}`, `functions/**/__tests__/**/*.test.js`, `scripts/**/__tests__/**/*.test.js`. 473 test files under `src/`. Lint: `npm run lint` (`eslint . --max-warnings=0`).
- `src/test-setup.js` only loads jest-dom and sets `globalThis.__MARATHON_UNKNOWN_REGISTRATION_IS_OWNER__ = true`.
- **Reusable fake RTDB:** `src/offline/__tests__/fakeRtdb.js` (320 lines) — `createFakeRtdb`: one JSON tree, atomic multi-path `update`, `.sv` timestamp/increment, `runTransaction` with the firebase result shape, offline and lost-ack injection, a write log, and facsimiles of the live rules (create-only sales/payments/queue/stock_movements, `remainingAmount` never increases and ≥ 0, stock `v` must be old+1, etc. — header lines 1-27).
- **Adapter:** `src/offline/__tests__/fakeFirebaseModule.js` — `makeFirebaseDatabaseMock(holder)` routes `firebase/database` (`ref, child, push, get, update, serverTimestamp, increment, …`) onto the fake so the REAL `engine.js`, `stockMovement.js` and outbox worker run end-to-end; installed with `vi.mock` + a `vi.hoisted` holder (see `replayExactlyOnce.test.js`). Used by 16 files. `src/offline/__tests__/helpers.js` (141 lines) has further helpers.
- Most other tests (115 files) `vi.mock` `../lib/rtdb` or `firebase/database` with plain `vi.fn()` stubs; several modules take injectable deps instead (`deviceRegistry.js` `deps`, `noReceiptReturnWriter.js` `deps`, `voidCreditNote.js` `d`).
- Other harnesses: `src/reports/cardrecon/__tests__/reconHarness.js`, `src/recycler/__tests__/harness.js`, `speedHarness.js`. Functions tests use stubs in `functions/__tests__/_stubs/` (aliased in vitest config).
- **Empty arrays: YES, the fake deletes them.** `fakeRtdb.js:61-76` `prune()` removes empty arrays and empty objects bottom-up on every write (`:223, 231, 306`), matching real RTDB. Caveat: it also COMPACTS arrays (filters null entries, line 64), whereas real RTDB keeps holes as `null` in an array-coerced read — do not rely on the fake for hole behaviour (memory note "Fake RTDB answers null in array holes" refers to a different fake, in the store app).
- `@firebase/rules-unit-testing` is a devDependency but I found no test importing it in `src/`.

---

### Uncertainties (not guessed)

1. Canonical `pos/storeCredits/{id}` shape (does the server copy `storeId`?) — functions agent.
2. Prefix of the `till_*` money roots and all `money*` callables — functions agent.
3. Live value of `/pos/config/{store}/laybyStorageLocation` — decides whether `LaybyDetailView.jsx:661` actually sends Pine parcels to hub1 today.
4. RTDB rules: whether any rule checks `posAccess.storeIds` on writes. Not in this repo.
5. The exact reported symptom of the layby-cancel defect; §4 describes what the code does.
6. Where store-app order numbers are minted (the "order number sequence" for Pine/Concrete may be a store-app change, not POS).
7. `src/recycler/**` was only swept for store literals and helper usage, not read in full (≈100 files); no other store lists were found by grep.
8. Location id for the new store (`concrete` vs `marathon-concrete`) — matters for `nonDeductingLocations.js:48-53`'s prefix trick and `originLocationId`'s raw-id fallback.

---
