# Sneaker over-request, 23–24 Oct 2026 — forensics

**Report:** Air Jordan 1 lines asking ×3 on sizes 7–11, "waiting 1d 9h", raised
00:00 SAST Fri 23 Oct. Junid's hub sneaker policy is 3/4/5/5.5→2, 6/7/8→3,
9–13→2, ask-at 1, at Hub 1 and Hub 2.

## Verdict: no policy edit, no engine defect — sale-row stacking in the queue

- **Policy unchanged.** `/config/refillEngine/policyGroups/footwear-all` holds
  Junid's numbers exactly at Hub 1 and Hub 2. `/engine_policy_history` since
  10 Oct has no group/category edit; the only sneaker entries are seven
  per-product rows (15 Oct ×6, 23 Oct ×1), none a flat 3.
- **Engine correct.** Its AJ1 requests matched policy (e.g. Wolf Grey 19 Oct:
  6/7/8 ×3, 9/10/11 ×2, 12 ×1). It runs 07–19 SAST hourly; nothing was raised
  overnight. The lines in the report are not `/refill_requests` rows.
- **What they were.** Hub 2 *sale-driven* queue rows. A past day's rows are
  rebuilt from `insights_log` **"ready" events**, one per order number
  (`restockCountsFromLog`, `fa97e669` #183, 11 Jul; made pickable queue lines by
  `e115cde8`, 8 Aug), and dated at the SA day start — hence "since 00:00".
  On 23 Oct one customer order of 10 pairs was placed and marked ready three
  times at Hub 2; a single POS sale took one pair of each. Every size asked ×3.

## When it really started (data, 1 Jul – 24 Oct)

Read-only census, by key/`ts` range only: per SA day, Hub 2 sneaker
sale-row asks (distinct ready orders) against pairs that actually left Hub 2
(sold or sent out, same day + 2).

- **Asks above pairs that left Hub 2: every day since 31 Jul**, typically 10–25
  cells a day (Aug–Oct), against 2–9 a day in mid-July. A ready that never
  becomes a sale (fetched, shown, refused, never collected) still asked for a
  replacement.
- **Re-placed orders (same customer, same pair, same day):** 0–5 cells on most
  days, with earlier spikes on 27 Jul (14 units), 7 Sep (8) and 4 Oct (10).
  23 Oct (20 cells, 36 units) was the largest by far, not the first.

The commits, in order:

| When (SAST) | Commit | PR | What it did |
|---|---|---|---|
| 11 Jul 12:54 | `fa97e669` | #183 | Past days rebuilt by counting `insights_log` "ready" events |
| 30 Jul 11:43 | `85eeedbd` | #288 | TODAY made sale-driven (POS `restock_log`), for exactly this reason. **Past days were left on readies** |
| 8 Aug 21:50 | `e115cde8` | #337 | Past-day stragglers became pickable queue lines (Fulfil / Out of Stock) |
| 24 Sep 19:34 | `ec404c82` | #646 | Hub 2 sneakers also put under the engine's per-size policy, so two mechanisms now ask for the same pairs |

Deploy times for these were manual CLI deploys and are not recorded in the
repo. Each was described as deployed the same day.

## Damage (Hub 2, 23 Oct)

- 20 sneaker cells inflated by re-placed orders; 36 units asked beyond demand.
- 11 excess units were sent before anyone noticed (AJ1 Craft Tech Grey 7 and 9,
  TS Mocha 8, Blue Whisper 4: +2 each; Samba Off-White 3, Mercurial 7,
  Armani 8: +1 each). Left as sent.
- The remaining AJ1 rows were closed Out of Stock by Central staff on 24 Oct.
- Two rows still open (Samba Off-White 3 ×1, 4 ×2; Hub 2 holds 4, keep 2) were
  closed `policy_trimmed` by `scripts/policy-overrequest-trim.mjs`.
- Hub 1 is engine-only — its sale events never become rows. Hub 3 has no
  per-size policy and was not touched.

## Fix

`src/components/stock/saleRowPolicyCap.js`: the sale rows of a footwear cell
may together ask at most `keep − on hand − open requests` (the engine's own
keep via the browser twin of `resolveTarget`; explicit rows win). Fully
covered rows move to "Already covered" with their numbers.

## Root-cause fix (follow-up PR, Junid-approved 24 Oct)

- Past-day sale rows count **pairs sold** from the POS `restock_log`, the same
  source as today, never "ready" events. `soldPairEntries` makes one sale =
  at most one line per pair: a double-written order row counts once, and
  walk-in rows (one per unit) are never merged.
- **The scan owns a policy cell** (`scanOnly`): at Hub 2, a footwear cell whose
  keep resolves under Junid's policy never shows a sale row as pickable work.
  The hourly scan asks for it at the policy's ask-at point. The Hub 2 badge no
  longer counts those cells.
- Still a non-scan path, **left for Junid** (rule 2): sale rows for products
  with no resolvable policy (clothing at Hub 2, footwear without a category).
  Under rule 1 these would also be scan-only, but that change was not asked for.

## Not changed

`maxFootwearIntentsPerRun` was left at 25: the code clamps 0 back to 25
(`Math.max(1, …)`), and pausing the engine would stop every Hub 1 sneaker
refill without touching this leak.

## Sale-raised requests switched off (Junid's decision, 24 Oct)

**Which flows raised requests from sales.** Only Hub 2's "replace what sold"
lines in the Refill Queue. The Clothing-Sold refill tabs (shop clothing from
ledger `sold` movements) have not been mounted since 12 Jul (#202): shop
clothing has been scan-only since then.

**Products relying on them with no policy (Hub 2, last 6 days of POS sales):**
39 product/size pairs; 36 already under a scan policy (27 by the footwear-all
group, 9 by explicit rows). The 3 without:
- Kids soccerboot (size 32): no category key, and the footwear map names no
  size 32, so there is no existing policy to arm it under. Needs Junid.
- Adidas Samba White Blue Pink (6) and Air Jordan pink/white (8): the policy
  resolves 0 (explicit 0 or a dead size), which is governed, not missing.

**Arming correction.** A first census also counted the unmounted Clothing-Sold
tabs. Eleven shop products from that count (2 Adidas bags at PE, 8 glasses and
a belt at Trophy) were armed through the policy writer at 13:41 SAST and
**removed through the same writer at 13:45**, when it was found they were never
being refilled by sales. No scan ran in between, and no request exists for any
of them. Both steps are in `engine_policy_history`. Snapshots are in
`~/marathon-rollbacks/arm-sale-only-products-*`.

**Switch.** `src/config/saleRaisedRequests.js` `SALE_RAISED_REQUESTS = false`:
no sale line is pickable work, policy or not. The lines stay visible as
"Already covered", and the Hub 2 badge counts none of them.

## The till's sale log was missing order collections (POS #560)

The 23 Oct 12:06 sale (PE till 2) collected 19 hub orders. Since POS
`32184dd7` (11 Oct 21:48), the sale log was written only after **every** order
close in the sale landed. A close that did not land dropped the whole sale from
`restock_log` and `insights_log`. 1–24 Oct, 841 of 2,084 sales that should have
logged rows logged none or only some (1,140 order pairs), about 5 a day before
12 Oct and 47–87 a day after, at the PE and Trophy tills. For 891 of those
orders the close never even claimed `pos/orderPickups`. POS #560 logs the
collected orders from the sale itself.
