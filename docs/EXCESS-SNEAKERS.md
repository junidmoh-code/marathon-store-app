# Excess Sneakers: Hub → Central — Phase 1 Investigation

Read-only investigation. No RTDB writes were made, no code was changed. All
numbers below were read live from `marathon-club-default-rtdb` on
2026-09-03 using the same `firebase-admin` applicationDefault-credential
pattern the repo's existing `scripts/*.mjs` one-shot tools use (e.g.
`scripts/model-hub1-sneaker-policy.mjs`, `scripts/arm-hub1-sneaker-tranche.mjs`).
The engine functions used for resolution were required directly from
`functions/lib/refill-engine.cjs` (not re-implemented), so every number here
went through the real `resolveTarget`/`computeRefillPlan` code paths.

Group covered: the "Sneakers" policy group / footwear category set —
`boots`, `designer-shoes`, `kids-shoes`, `loafers`, `running-shoes`,
`slides`, `sneakers` (`functions/lib/policy-groups.cjs` — group key
`footwear-all`, `label: "Sneakers"`).

---

## 1. Five live examples, traced to their exact target row

Queried `/refill_requests` filtered to `requestingLocation === "hub1"` and
`products/{productId}.categoryKey` in the footwear-all set. 1,533 hub1
footwear refill_requests exist total (21 open, 689 cancelled, 823 fulfilled).
The 5 most recent **open** ones, each traced back through
`resolveTarget()` (`functions/lib/refill-engine.cjs:495`):

| # | Product | Size | Qty | createdAt | Traced target row |
|---|---|---|---|---|---|
| 1 | Nike SB Dunk Low Green White (`p1781648943606`) | 9 | 1 | 2026-09-02T14:45Z | `config/refillEngine/categoryPolicy/sneakers/hub1/sizes/9` → `{target:2, minQty:1, reorderPoint:1}` |
| 2 | Nike SB Dunk Low Grey White (`p1782055077934`) | 10 | 1 | 2026-09-02T12:30Z | `.../sneakers/hub1/sizes/10` → `{target:2, minQty:1, reorderPoint:1}` |
| 3 | On Cloudventure 2 White (`p1777973871259`) | 3 | 1 | 2026-09-02T11:00Z | `.../sneakers/hub1/sizes/3` → `{target:2, minQty:1, reorderPoint:1}` |
| 4 | Lacoste Audyssol Navy White (`p1777978392548`) | 7 | 1 | 2026-09-02T10:45Z | `.../sneakers/hub1/sizes/7` → `{target:3, minQty:2, reorderPoint:1}` |
| 5 | Nike Air Force 1 White (`p1777979694047`) | 6 | 3 | 2026-09-02T10:45Z | `.../sneakers/hub1/sizes/6` → `{target:3, minQty:2, reorderPoint:1}` |

For every one of these, `/stock_targets/hub1/{pid}/{sizeKey}` is **absent**
(`explicitHub1Row: null` in the raw dump) — there is no per-product override
in play. Resolution order actually taken, per `resolveTarget`:

1. **explicit `/stock_targets/hub1/{pid}/{size}` row** (`refill-engine.cjs:499-510`) — absent, skipped.
2. **category policy** — `categoryPolicyTarget()` (`refill-engine.cjs:444-493`) called via `categoryPolicyEntry()` (`refill-engine.cjs:419-432`), which reads `locationPolicyFor(config, "sneakers", "hub1")` (`functions/lib/policy-resolve.cjs:129-151`). This resolves the entry at `config/refillEngine/categoryPolicy/sneakers` → `perSize:true`, `hub1: {sizes:{…}, carriedOnly:true}` — **this is the branch that fires** for all 5 examples above. `source: "category_policy"` is stamped on the returned target object.
3. Footwear rule, kill switch, clothing default run — never reached (short-circuited by step 2 returning a value).

The node path that arms every one of these five requests:
```
config/refillEngine/categoryPolicy/sneakers/hub1/sizes/<encodedSize> = { target, minQty, reorderPoint }
config/refillEngine/categoryPolicy/sneakers/perSize = true
config/refillEngine/categoryPolicy/sneakers/hub1/carriedOnly = true
```

---

## What makes Hub 1 armed

Read live 2026-09-03, the entire object at `config/refillEngine/categoryPolicy/sneakers` is:

```json
{
  "perSize": true,
  "hub1": {
    "carriedOnly": true,
    "sizes": {
      "3":  { "target": 2, "minQty": 1, "reorderPoint": 1 },
      "4":  { "target": 2, "minQty": 1, "reorderPoint": 1 },
      "5":  { "target": 2, "minQty": 1, "reorderPoint": 1 },
      "5_5":{ "target": 2, "minQty": 1, "reorderPoint": 1 },
      "6":  { "target": 3, "minQty": 2, "reorderPoint": 1 },
      "7":  { "target": 3, "minQty": 2, "reorderPoint": 1 },
      "8":  { "target": 3, "minQty": 2, "reorderPoint": 1 },
      "9":  { "target": 2, "minQty": 1, "reorderPoint": 1 },
      "10": { "target": 2, "minQty": 1, "reorderPoint": 1 },
      "11": { "target": 2, "minQty": 1, "reorderPoint": 1 }
    }
  }
}
```

**There is no `hub2` key inside this object at all.** That is the entirety
of the arming mechanism. If this one node were deleted (or the `hub1` key
inside it removed), Hub 1's sneaker refill requests would stop the very
next scan — no other row keeps it alive:

- No per-product `/stock_targets/hub1/{pid}` rows are what's arming these
  five example products (`explicitHub1Row: null` for all of them). The only
  explicit rows that exist for footwear categories at hub1 are 110 rows, and
  every one of them is an explicit **target 0** (see §6) — an off-switch for
  specific discontinued models, not an arming mechanism.
- The **footwear rule** (`config/refillEngine/footwearTargets`) is `undefined`
  live → `footwearTargetsEnabled()` (`refill-engine.cjs:276-281`) returns
  `false` everywhere → the footwear-rule branch (`refill-engine.cjs:551-572`)
  never fires for hub1 OR hub2 today, even though
  `config/refillEngine/footwearRunByLocation.hub1` and `.hub2` both hold a
  populated run. This branch is currently **dead code in practice** — it is
  not what arms Hub 1.
- The **policy group** `footwear-all` (`config/refillEngine/policyGroups/footwear-all`)
  is `armed: false` live, so it plays no role even if it were consulted.
  It is moot anyway: `armedGroupForCategory()` (`policy-resolve.cjs:78-109`)
  never even looks at the group once `categoryPolicy.sneakers` is present as
  its own key (`own !== undefined && own !== null` short-circuits to `null`
  at `policy-resolve.cjs:97`) — **own-category presence blocks group
  fallback entirely, regardless of which locations the own entry actually
  covers.** This is the mechanism behind the Hub 2 gap below.
- `ruleBasedTargets: true` live, but that only governs the **clothing** rule
  (`isClothing`), which sneakers never match (`isFootwear` and `isClothing`
  are disjoint categories, `refill-engine.cjs:174-200`).
- `config/mode.hub1 = "live"` (not `"off"`/`"shadow"`) — required for the
  scan to actually create requests rather than just log a shadow preview,
  but this is a network-wide switch, not sneaker-specific.
- `config/refillEngine/carriedOnlyEngineDeployedAt = "2026-08-25T10:46:55.353Z"`
  — the deploy sentinel `scripts/arm-hub1-sneaker-tranche.mjs` checks before
  writing anything; it is present, meaning the deployed engine understands
  `carriedOnly`.

**Minimal set of writes that, if reverted, silences Hub 1's sneaker refill
requests:** delete (or null) `config/refillEngine/categoryPolicy/sneakers`.
That is the single node. Nothing else in the live tree keeps it alive.

---

## Hub 1 vs Hub 2 diff

| Node | Hub 1 | Hub 2 |
|---|---|---|
| `config/refillEngine/categoryPolicy/sneakers/<hub>` | **present** — `carriedOnly:true`, 10-size map (missing 12, 13) | **absent entirely** — no key |
| `config/refillEngine/categoryPolicy/sneakers/perSize` | `true` (shared, one flag for the whole entry) | same flag, but moot for hub2 with no `hub2` key |
| `config/refillEngine/mode.hub2` | n/a | `"live"` — **not the blocker**, hub2 is fully live-mode already |
| `config/refillEngine/policyGroups/footwear-all` | irrelevant (own-key short-circuit) | irrelevant for the same reason — even though this group's `policy.hub2.sizes` **does** hold a full 3–13 run (see below), it is never consulted because `categoryPolicy.sneakers` exists as its own key |
| `config/refillEngine/footwearTargets` (hub2) | off (undefined) | off (undefined) — identical, not a hub2-specific gap |
| `/stock_targets/hub2/{pid}/{size}` explicit rows, footwear categories | 0 | 0 — no explicit rows either way |
| `config/refillEngine/footwearRunByLocation.hub2` | n/a | present (`{3:2,4:2,5:2,6:3,7:2,8:2,9:2,10:2,11:1,5_5:2}`) but inert — footwear rule is globally off |

**The single, precise gap:** `config/refillEngine/categoryPolicy/sneakers`
has a `hub1` key and no `hub2` key. `locationPolicyFor(config, "sneakers", "hub2")`
(`policy-resolve.cjs:129`) reads `cat["hub2"]` → `undefined` →
`locationEntryMode(undefined)` → `"invalid"` (`policy-resolve.cjs:56-64`) →
`locationPolicyFor` returns `null` (`policy-resolve.cjs:136`) →
`categoryPolicyEntry` returns `null` (`refill-engine.cjs:428`) →
`categoryPolicyTarget` returns `null` → `resolveTarget` falls through to the
footwear rule, which is off → falls to the clothing kill-switch branch,
which sneakers never match → returns `null`. **Every sneaker size at hub2
resolves to "unarmed" today, with the sole exception of anything a future
explicit `/stock_targets/hub2/{pid}/{size}` row would cover (none exist).**

Interestingly, the *policy group* `footwear-all` already holds a **hub2**
entry with a fuller run than Hub 1's own policy (sizes 3–13 including 12
and 13, vs. Hub 1's 3–11 excluding 12/13) — written 2026-08-22 per
`functions/lib/policy-groups.cjs:298-299` history notes — but it is
permanently unreachable for `sneakers` while `categoryPolicy.sneakers` owns
the category directly (own-entry-blocks-group is unconditional, not
per-location). This group policy is inert scaffolding today, not a live
fallback.

---

## Precedence + field semantics (target vs reorder point)

Precedence, confirmed in code (`refill-engine.cjs:495-611`,
`policy-resolve.cjs:13-18`), highest first:

1. **Explicit `/stock_targets/{loc}/{pid}/{size}` row** — `resolveTarget`, `refill-engine.cjs:499-510`. Always wins, even an explicit 0.
2. **Category's own policy** — `config/refillEngine/categoryPolicy/{categoryKey}` — `refill-engine.cjs:534`, resolved via `categoryPolicyTarget`/`categoryPolicyEntry`.
3. **That category's ARMED policy group** — `config/refillEngine/policyGroups/{groupKey}.policy`, only reached if the category has **no own key at all** (`policy-resolve.cjs:96-97,113-119`) and the group is `armed: true` (`policy-resolve.cjs:103`).
4. **Footwear rule** — `config/refillEngine/footwearRunByLocation` gated by `footwearTargets` — `refill-engine.cjs:536-572`.
5. **Kill switch** — `ruleTargetsEnabled()` / `config/refillEngine/ruleBasedTargets` — `refill-engine.cjs:573`.
6. **Subcategory default run**, then **clothing default run by size** (`defaultRunByStore`) — `refill-engine.cjs:574-610`. Sneakers never reach here (`isClothing` false for footwear).

**Field semantics — verified in code, not from on-screen labels:**

- **`target`** is the level the engine tops the cell **up to**. Proof:
  `deficit = t.target - have - inb` (`refill-engine.cjs:1411`) — the request
  quantity is literally `min(deficit, …)` (`refill-engine.cjs:1606`). This is
  what a Hub→Central replenishment move should restock **to**.
- **`reorderPoint`** is the **trigger threshold**, tested against physical
  on-hand only (not on-hand + inbound): `if (t.reorderPoint != null && have > t.reorderPoint) continue;`
  (`refill-engine.cjs:1436`) — the cell stays silent while `have` is
  strictly above `reorderPoint`, and only asks (for the *whole* gap up to
  `target` at once) once `have <= reorderPoint`. `reorderPoint: 1` at Hub 1
  means "ask when the shelf drops to 1 unit or below," not "keep 1 unit."
  A `reorderPoint` of `null`/absent means eager continuous top-up (ask any
  time `have < target`); `0` is a valid, distinct value ("ask only when
  empty") and is explicitly NOT treated as falsy/absent (`refill-engine.cjs:453-454,508`).
- **`minQty`** is used **only** for priority tagging, not for gating a
  request: `priority: have < t.minQty ? "high" : "normal"` (`refill-engine.cjs:1610`).
  It does not change whether a request is raised or its quantity — it only
  flags urgency on the request that is already being raised.
- Owner's on-screen labels "Keep" and "Minimum" do **not** map 1:1 onto
  these three fields by name; the engine only cares about
  `target`/`reorderPoint`/`minQty` as read from these exact RTDB keys. The
  UI's arming script (`scripts/lib/hub1SneakerRun.mjs`) computes
  `minQty = ceil(target/2)` and pins `reorderPoint = 1` regardless of the
  screen labels — i.e. the mapping from "Keep"/"Minimum" on-screen to these
  three RTDB fields is a **written convention of the arming script**, not
  something the engine infers from the labels itself.

**Does `resolveTarget` distinguish "unarmed" from "armed at zero" at hub
scope? Yes, explicitly, at two levels:**

- Per-size category-policy map: a size **not named** in `entry.sizes` (e.g.
  hub1 sizes "12"/"13", or the entire hub2 key) returns `null` at
  `categoryPolicyTarget` (`refill-engine.cjs:472-473`) — **unarmed,
  falls through** to the next precedence level. A size that **is named**
  but has zero units anywhere in the network resolves an explicit `target: 0`
  (`refill-engine.cjs:476`, the "dead-size" rule) — **armed, at zero, a
  stop, not a fall-through** (comment at `refill-engine.cjs:464-469` is
  explicit about this). The engine only ever produces this zero from a
  *named* row; it is never confused with "the row does not exist."
- Explicit `/stock_targets` rows: same distinction — `explicit.reorderPoint`
  of `0` is read with a `typeof ... === "number"` test, never a truthiness
  check, specifically because "`num()` maps garbage to 0, which would arm
  the gate at only-when-empty — the silent-starvation case… 0 itself IS
  valid and must survive" (`refill-engine.cjs:505-508`, inline comment).

---

## Unarmed sizes

At **Hub 1**: sizes **12 and 13** are genuinely absent from every level —
not in `categoryPolicy.sneakers.hub1.sizes` (only 3,4,5,5.5,6,7,8,9,10,11
are named), not in `footwearRunByLocation.hub1` (same 10 sizes, footwear
rule off anyway), and no explicit `/stock_targets/hub1/{pid}/12|13` rows
were found for any sneaker product. These resolve `null` (unarmed), never
`0` — they are simply never asked about. This matches the modelling script's
own note that "the owner believes these do not exist" as live cells
(`scripts/model-hub1-sneaker-policy.mjs`, ODD_SIZES check) — no live hub1
stock cells were found at 12/13 for sneakers either, so this is consistent
with the sizes genuinely not existing in the run rather than a coverage gap.

At **Hub 2**: **all** sizes 3–13 are unarmed for sneakers today (see the
diff above) — this isn't a "missing a couple of sizes" gap, it's a missing
category entry entirely.

---

## Projected first-scan volume (if Hub 2 armed identically to Hub 1)

Computed by requiring the live `functions/lib/refill-engine.cjs`
`computeRefillPlan` directly and overlaying `config.categoryPolicy.sneakers`
with an added `hub2` key holding the **same** 10-size map Hub 1 uses
(`{target, minQty, reorderPoint:1}` per size, `carriedOnly:true`), caps
lifted (`maxIntentsPerRun`/`maxFootwearIntentsPerRun` set very high) to see
the *uncapped* first-scan demand, matching the methodology
`scripts/model-hub1-sneaker-policy.mjs` already uses for Hub 1:

| | Hub 1 (current, live) | Hub 2 (if armed identically) |
|---|---|---|
| First-scan refill request lines | 59 | 448 |
| First-scan units | 75 | 808 |
| Distinct product cards | 45 | 252 |

For scale, per-run throttles are `maxFootwearIntentsPerRun: 25` and
`maxIntentsPerRun: 75` live — so an unthrottled 448-line first scan at Hub 2
would need ~18 scan cycles (or a tranche approach identical to Hub 1's
`scripts/arm-hub1-sneaker-tranche.mjs`) to drain, exactly the reasoning that
already justified Hub 1's own staged rollout.

**Excess** (cells already above the Hub-1-identical target — Move-Excess
candidates, computed against live on-hand):

| | Hub 1 (own live targets today) | Hub 2 (if given Hub 1's targets) |
|---|---|---|
| Cards with excess | 228 | 184 |
| Size-lines in excess | 422 | 367 |
| Units in excess | 967 | 906 |

Note: Hub 1's own 228-card / 967-unit excess is **not currently visible in
the Move-Excess screen at all**, because `hub1` is not in that screen's
`SOURCES` list (see below) — this is a pre-existing gap independent of
whether Hub 2 gets armed, and is exactly the kind of number this excess
project is meant to expose and route to Central.

---

## Existing movement action usable for Hub → Central

`src/components/stock/applyMovement.js:109` — `applyMovement(movement, opts = {})`.
`movement.type` is drawn from `VALID_TYPES = new Set(["received","opening","sold","transfer_in","transfer_out","adjustment","return"])`
(`applyMovement.js:35`). For a relocation, `transfer_out`/`transfer_in`
take **arbitrary** `from`/`to` location-key strings — `cellDeltas()`
(`applyMovement.js:64-76`) does `(m.from && m.to) ? [{loc:m.from,delta:-q},{loc:m.to,delta:+q}] : null`
with no enum/allow-list on the location values.

This is **already used** for a hub→Central destination today:
`src/components/stock/MoveExcess.jsx:283-288` calls
```js
applyMovement({ type: "transfer_out", productId: c.pid, size: s.size, qty: q,
  from: c.loc, to: dest, actorRole, reason: "excess_rebalance",
  movementId: `${batchId}_${c.pid}_${encodeSizeKey(s.size)}_${dest}`,
  link: { transferId: batchId } })
```
where `dest` is `"central"` when the "→ Central" button is pressed
(`MoveExcess.jsx:254`, `dest = which === "hub" ? hubDest : "central"`).
This is currently wired for `hub2` (and stores routing to `hub2`) because
`MoveExcess.jsx:26` hardcodes `SOURCES = ["hub2", "marathon-pe", "trophy"]`
— **Hub 1 is simply not in that list.** No new movement path, type, or
`applyMovement` signature change is needed to express Hub 1 → Central; it
is a UI/config change (add `"hub1"` to `SOURCES`, and to
`engineConfig.routes` if per-location routing config decides the hub leg —
`MoveExcess.jsx:64`, `routesCfg = engineConfig?.routes || {...}`), not an
engine or `applyMovement` change.

---

## STOP conditions check

1. **"The existing move action cannot express a hub→Central destination
   without a new movement path."** — **NOT TRIGGERED.** `applyMovement`'s
   `transfer_out` type already accepts any `to` location string, and
   `MoveExcess.jsx` already issues exactly this call with `to: "central"`
   for Hub 2 today. Extending it to Hub 1 is adding `"hub1"` to a hardcoded
   array (`MoveExcess.jsx:26`), not building a new capability.

2. **"`resolveTarget` cannot distinguish unarmed from zero at hub scope."**
   — **NOT TRIGGERED.** `categoryPolicyTarget()` (`refill-engine.cjs:470-477`)
   explicitly returns `null` (unarmed, falls through to the next precedence
   level) for a size the per-size map does not name, and returns an
   explicit `{target: 0, …}` object (armed-at-zero, a stop) for a named size
   with zero live units anywhere. The same `null`-vs-typed-zero discipline
   holds for explicit `/stock_targets` rows (`refill-engine.cjs:500-510`,
   the `typeof rp === "number"` test explicitly called out in the inline
   comment as distinguishing garbage-as-0 from a legitimate 0). This
   distinction is exercised live today: Hub 1's own dead-size rows (e.g.
   sizes 9/10/11 on `p1777897827663` in the §5-representative-product table)
   resolve `target: 0`, while the same product's sizes 3–5.5 (not declared
   by the product at all) and hub2 (no category entry) resolve `null`.

Neither condition blocks the primary path (replicate Hub 1's
`categoryPolicy.sneakers.hub1` shape onto a `hub2` key with hub2's own
numbers) or the fallback (dual-level arming via the group). Both remain
implementation choices, not blockers.

---

## Appendix A — representative per-size resolution table (Hub 1 vs Hub 2)

Product: **Nike Air Max DN Grey Black Volt** (`p1777897827663`), declared
sizes `[6,7,8,9,10,11]`, carried (has a stock cell) at both hub1 and hub2,
no explicit `/stock_targets` row at either hub. Resolved live through
`resolveTarget()` for every size 3–13:

| size | hub1 have | hub1 target | hub1 reorderPt | hub1 minQty | hub1 source | hub2 have | hub2 target | hub2 reorderPt | hub2 minQty | hub2 source |
|---|---|---|---|---|---|---|---|---|---|---|
| 3 | – | null (unarmed — size not declared by product) | – | – | – | – | null (unarmed — no hub2 category entry) | – | – | – |
| 4 | – | null (unarmed — size not declared) | – | – | – | – | null (unarmed) | – | – | – |
| 5 | – | null (unarmed — size not declared) | – | – | – | – | null (unarmed) | – | – | – |
| 5.5 | – | null (unarmed — size not declared) | – | – | – | – | null (unarmed) | – | – | – |
| 6 | – | 0 (dead size — named, zero units anywhere) | 1 | 2 | category_policy | – | null (unarmed) | – | – | – |
| 7 | 3 | 3 | 1 | 2 | category_policy | 0 | null (unarmed) | – | – | – |
| 8 | 1 | 3 | 1 | 2 | category_policy | – | null (unarmed) | – | – | – |
| 9 | – | 0 (dead size) | 1 | 1 | category_policy | – | null (unarmed) | – | – | – |
| 10 | – | 0 (dead size) | 1 | 1 | category_policy | – | null (unarmed) | – | – | – |
| 11 | – | 0 (dead size) | 1 | 1 | category_policy | – | null (unarmed) | – | – | – |
| 12 | – | null (unarmed — size not named anywhere) | – | – | – | – | null (unarmed) | – | – | – |
| 13 | – | null (unarmed) | – | – | – | – | null (unarmed) | – | – | – |

This single product illustrates both flavours of "unarmed" side by side:
sizes 3–5.5/12/13 are unarmed because the *product doesn't declare them* (a
per-product fact, `productSizes` filter, `refill-engine.cjs:475,491`) or
because the *category doesn't name them* (12/13), while sizes 6/9/10/11 are
armed-at-an-explicit-zero because the category names them but no stock
exists anywhere in the network for that size on this product — both distinct
from the hub2 column, where every size is unarmed for the single reason that
`categoryPolicy.sneakers` has no `hub2` key at all.

## Appendix B — every explicit `/stock_targets` row in a footwear-all category

Read live from `/stock_targets`, filtered to `products/{pid}.categoryKey`
in `{boots, designer-shoes, kids-shoes, loafers, running-shoes, slides,
sneakers}`. **124 rows total** — all of them, at every location and size,
are an explicit **`target: 0`** (a per-product/size kill of the category
policy for a specific size, e.g. a discontinued colourway):

- **110 rows at `hub1`**, spanning sizes 3–11 (and one `_` one-size row) on
  6 distinct sneaker products (The North Face Glenclyffe Low Green, New
  Balance 9060 Black, Diesel S-Ukiyo V2 Low White, Replay Field Speed Brown,
  Karl Lagerfeld Kapri Ikonik Black, and one more not shown above — full
  dump saved at `~/footwear-targets-dump.txt` from this session for anyone
  who wants the complete list).
- **14 rows at `marathon-pe`**, same pattern (explicit 0 overrides).
- **0 rows at `hub2`** — confirms Hub 2 has no per-product overrides either;
  its lack of arming is 100% the missing category-policy key, not competing
  explicit rows.

No row anywhere in this set has a nonzero `target` — there is no
"hand-tuned per-product sneaker target" anywhere in the live data; every
per-product row that exists is strictly a **shutoff**, never a boost.

---

## Phase 2: Arm result (2026-09-03)

Written live via `scripts/arm-hub2-sneaker-policy.mjs --execute`, which goes
through `applyCategoryPolicy` — the deployed Engine Policy card's own write
path (`functions/lib/category-policy-write.cjs`): drift-checked before and
immediately before the mutation, history entry written first
(`engine_policy_history/-P0a44cqvWkarNMUmzze`), post-write read-back
verified. Only the `hub2` key was added to
`config/refillEngine/categoryPolicy/sneakers`; `hub1` was passed through
byte-identical (verified: `hub1` after the write is character-for-character
the same object read before it). `/stock_targets` was not touched.
`database.rules.json` was not touched. Numbers came from the owner's own
already-entered Hub 2 run at
`config/refillEngine/policyGroups/footwear-all.policy.hub2.sizes` — not
invented — with `carriedOnly: true` added to match Hub 1's shape (the group
snapshot doesn't carry that flag; the live `hub1` entry does).

### Before / after, sizes 3–13

| Size | Hub 1 target/reorderPt (before) | Hub 1 (after) | Hub 2 target/reorderPt (before) | Hub 2 (after) |
|---|---|---|---|---|
| 3 | 2 / 1 | 2 / 1 (unchanged) | unarmed (null) | **2 / 1** |
| 4 | 2 / 1 | 2 / 1 (unchanged) | unarmed (null) | **2 / 1** |
| 5 | 2 / 1 | 2 / 1 (unchanged) | unarmed (null) | **2 / 1** |
| 5.5 | 2 / 1 | 2 / 1 (unchanged) | unarmed (null) | **2 / 1** |
| 6 | 3 / 1 | 3 / 1 (unchanged) | unarmed (null) | **3 / 1** |
| 7 | 3 / 1 | 3 / 1 (unchanged) | unarmed (null) | **2 / 1** |
| 8 | 3 / 1 | 3 / 1 (unchanged) | unarmed (null) | **2 / 1** |
| 9 | 2 / 1 | 2 / 1 (unchanged) | unarmed (null) | **2 / 1** |
| 10 | 2 / 1 | 2 / 1 (unchanged) | unarmed (null) | **2 / 1** |
| 11 | 2 / 1 | 2 / 1 (unchanged) | unarmed (null) | **2 / 1** |
| 12 | unarmed (null) | unarmed (null, unchanged) | unarmed (null) | **2 / 1** |
| 13 | unarmed (null) | unarmed (null, unchanged) | unarmed (null) | **2 / 1** |

Note sizes 7 and 8: Hub 1's *own* live entry (target 3) has drifted from the
footwear-all group's hub1 snapshot (target 2) since the group was last
written (2026-08-22) — expected, since Hub 1's policy has been edited by
hand since then. Hub 2 was armed with Hub 2's own screen numbers from the
group, not Hub 1's current numbers, per the task's instruction not to invent
values.

**No size 3–13 gap.** The group's hub2 leg covers all twelve size keys Hub 1
uses plus 12 and 13 (which Hub 1 itself doesn't arm) — every size Hub 1 has
armed is also covered for Hub 2. Hub 2 is now armed on *more* sizes than
Hub 1 (12 and 13 additionally), which is a genuine feature of the numbers
the owner already entered, not an invented addition.

Post-write verification: re-read `config/refillEngine/categoryPolicy/sneakers`
has exactly the three keys `perSize`, `hub1`, `hub2` — no shop key
(`marathon-pe`, `trophy`, `pine`) exists at that node, and a direct read of
each confirmed `null`. `config/refillEngine/policyGroups/footwear-all.armed`
is still `false` — the group played no role beyond being the numbers
source; it remains inert scaffolding, unreachable while `categoryPolicy.sneakers`
owns the category.

Uncapped-preview scale for the Hub 2 leg alone (from `applyCategoryPolicy`'s
own `buildPreview`, throttled by the live `maxIntentsPerRun`/
`maxFootwearIntentsPerRun` caps rather than the uncapped methodology used in
the Phase 1 projection table above): 305 request lines / 403 units on the
resulting scan.

### Disarm — one action, no code change, no deploy

Removes exactly the `hub2` key, leaving `hub1` and `perSize` untouched:

```
curl -X DELETE "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app/config/refillEngine/categoryPolicy/sneakers/hub2.json?access_token=$(gcloud auth print-access-token)"
```

or, as an admin-SDK one-liner (same credential pattern as every script in
this repo):

```js
node -e "require('firebase-admin').initializeApp({credential:require('firebase-admin').credential.applicationDefault(),databaseURL:'https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app'}); require('firebase-admin').database().ref('config/refillEngine/categoryPolicy/sneakers/hub2').remove().then(()=>process.exit(0));"
```

Full rollback (Hub 2 back to whatever it was — `undefined` — recorded in
`~/hub2-sneaker-policy-rollback-2026-09-03.json`, written by the arming
script before it wrote anything) is the same operation: this task's `before`
had no `hub2` key at all, so "restore before" and "delete hub2" are the
identical action.
