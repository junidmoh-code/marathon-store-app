# Shop ← Central refill requests — investigation (3 Oct 2026)

**Report:** "Marathon PE and Trophy are sending refill requests to CENTRAL for
products that should be refilled from HUB 2."

**Owner rule (17 Sep 2026):** a product that exists at Hub 2 by ANY means —
current stock, past stock, any movement ever recorded there — is refilled to a
shop from Hub 2, never from Central. Central → shop only for the FIRST batch
of a product Hub 2 has never held, raised by the first-batch Solve (#607 and
follow-ups). Section 1 equivalent: Pine / Concrete ← Hub 3 ← Central.

## Verdict

**Neither a display bug nor a stored routing bug exists today. No request in
the live database breaks the rule, and none has since 1 Sep.** There IS a
real enforcement gap, which is what this PR closes: the rule was checked
ONCE — when a first-batch request was created — and nowhere else. Nothing
re-checked it afterwards, and nothing at all stopped the engine itself from
raising shop ← Central if `config.routes` ever named Central for a shop.

There is no introducing commit because no wrong request was found. The gap
has been there since the guard was written in #610 (`60e24f37`):
`functions/lib/first-batch.cjs` `processFirstBatchRequest` comments that the
guard is "Judged ONCE, on the row's first write". `functions/lib/refill-engine.cjs`
`computeRefillPlan` takes a shop's source from `routes[dest]` with no check.

The suspect named in the brief, the Pine / Concrete / Hub 3 "sections" work,
is **not on main and not deployed**. It is the unmerged local branch
`feat/sections-network` (116 commits, last 2 Oct). Live hosting is
`e4e860e` (main) and live `/config/refillEngine.routes` is
`{hub1: central, hub2: central, marathon-pe: hub2, trophy: hub2}`.

## Live evidence (read 3 Oct 2026, ~13:00 SAST)

Every read was narrow or indexed: `refill_requests` by `resolvedAt`/`createdAt`,
`orders` by `destShop`, `stock_movements` by `ts` in daily windows, and per-product
`stock/hub2/{pid}` reads.

### Open requests now (`refill_requests` where `resolvedAt` is null: 412 rows)

| status | requesting | source | rows |
|---|---|---|---|
| open | marathon-pe | hub2 | 229 |
| open | trophy | hub2 | 69 |
| open | hub2 | central | 76 (66 normal, 9 pass-through, 1 on-hold) |
| open | hub1 | central | 38 |

**Open PE / Trophy requests sourced from Central: 0.** The engine lock table
agrees: `refill_engine/open/marathon-pe` has 229 locks, all `source: hub2`, and
`trophy` has 69, all `source: hub2`. Shop orders (`orders` by `destShop`, all
statuses, 2,977 rows): every one has `hub` = hub1 or hub2. None names Central.

The 9 open **pass-through** legs (#641) are Hub 2 ← Central, raised *for* a shop
(`forDests: [marathon-pe]` ×7, `[trophy]` ×2). In Central's Hub 2 (Clothing)
queue they read "· for Marathon PE". For every one of those 9 sizes Hub 2 has
**no cell at all**, so Hub 2 has never held them, and Central → Hub 2 → shop is
the allowed route. This is the one thing on Central's screen that pairs a shop
name with Central. It is correct as it stands.

### Every shop ← Central request since 1 Sep (`createdAt` ≥ 2026-09-01: 11,609 rows)

All 189 came from the first-batch Solve (`createdFrom.firstBatch`). The engine
raised none:

| raised | fulfilled | cancelled (`first_batch_central_declined`) |
|---|---|---|
| 18 Sep | 5 | — |
| 21 Sep | 3 | — |
| 25 Sep | 152 | 29 |

That is 102 products in total: t-shirts 41, pants 30, hoodies 19, golf t-shirts 5,
watches 3, jackets 2, suits 1, and 1 uncategorised. No sneakers and no slides.

**Had Hub 2 ever held any of them before its first batch?** The `p<ms>` product
ids put creation between 21 Aug and 18 Sep. All 41,588 `stock_movements` from
21 Aug to 3 Oct were scanned. For each product, any movement before its first
first-batch request with `from`/`to`/`before`/`after` naming hub2 was counted.
**Result: 0 of 102.** None had a prior Hub 2 request either (one had a Hub 2
request that was *cancelled* on 17 Sep; it moved no stock). The first batches
obeyed the rule.

### Stock that actually moved Central → PE / Trophy since 15 Sep

| what | rows |
|---|---|
| movements linked to a first-batch request (`refillId`; all 102 products checked above) | 164 |
| manual Transfer-screen moves (`transferId`, not a refill request) | 2 (28 Sep, 2 Oct; one is a size-7 shoe) |

**Already picked from Central in breach of the rule: 0.**

### Section 1 (Pine, Concrete, Hub 3)

- Pine and Concrete are **not engine destinations**. `routes` has no entry for them,
  there are 0 refill locks at marathon-pine / concrete / hub3, and there are 0
  refill requests for them. Concrete has no `/locations` entry yet.
- Pine is stocked by hand from the Transfer screen, Central → Pine, every day
  (550 moves 15 Sep – 3 Oct). Hub 3 has only POS sales recorded. The Hub 3 route
  does not exist in production, so the same defect **cannot** happen there yet.
- Once the sections work makes Pine / Concrete engine destinations, the rule added
  in this PR applies to them unchanged. It keys on "is a shop"
  (`/locations/{id}.kind === "store"`) and on "the shop's own hub" (`routes[shop]`),
  never on the literal `hub2`.

## The gap closed by this PR

1. **The rule was enforced at creation only.** A first-batch shop ← Central
   request is legitimate when created. It stays open until Central picks it,
   which can be days at the 06:00 / 14:00 releases. If Hub 2 receives the
   product in that window (its own Central leg lands first, a count, a
   return), the request is now shop ← Central for a product Hub 2 holds.
   Nothing withdrew it.
2. **The engine would raise shop ← Central on a route change.** `computeRefillPlan`
   takes `routes[dest]` as the source with no check. One console edit, or the
   owner settings card the sections work adds, writing `routes.trophy = "central"`
   would have made every Trophy refill a Central request on the next hourly scan.
3. **The trigger would treat a withdrawal as a fulfilment.** If anything other
   than the trigger cancelled a first-batch row with a reason, the trigger raised
   Hub 2's leg as if the shop's request had been served.

The fix (commit 2) is one rule module, `functions/lib/shop-source-rule.cjs`,
applied where every engine source is chosen and where every open shop request is
reconciled. The details are in the PR.
