# Customer phone-merge runbook

Duplicate customers exist because the `/customers` key IS the phone digits and
three dialects of one number were minted over time (`0813995333`,
`27813995333`, `813995333`). Store credit, laybys and on-account balances hang
off those records — **this migration touches money**, so every step below is
guarded and the merge itself never runs without the owner typing `--execute`.

The classification and plan rules live in ONE module shared by every script:
`scripts/lib/customerMergeCore.mjs` (pure, firebase-free, mutation-proven by
`scripts/mutation-proof-customer-merge.mjs` — 19/19).

## Non-negotiables baked into the runner

- **Dry run is the default.** `--execute` is a separate deliberate act.
- **REVIEW groups** (same number, materially different names) are **never
  merged** — they are the owner's to judge, one by one.
- **Store credits MOVE as intact records** (same creditId, same
  `remainingAmount`). Live rules only ever let an amount decrease, so nothing
  is summed or rewritten; the runner proves the base-wide credit total is
  identical to the cent before and after, and exits 1 + prints the restore
  command if it is not.
- **Nothing is deleted.** The loser keeps name/phone/code and gains
  `mergedInto`; every byte changed is captured in the disk snapshot AND in
  `customer_merges/{mergeId}` (the reversal recipe).
- The credit-issuance queue (`pos/storeCreditQueue`) must be **empty** — a
  pending claim would re-mint credit onto a tombstone after the merge.
- One run at a time: RTDB lock `_migrations/customerPhoneMerge/runLock`,
  acquired by transaction, never auto-stolen.

## Preconditions before an execute run

- **HARD GATE — POS tombstone handling.** The POS has no `mergedInto`
  awareness yet (docs/POS-PHONE-MERGE-IMPACT.md): after a merge, till staff
  who look up the losing dialect see the tombstone with ZERO credit and can
  attach new sales/credits/laybys to it, re-fragmenting what the merge
  consolidated. Do not run `--execute` until EITHER the POS ships its
  tombstone filter + pointer-follow, OR the owner explicitly accepts running
  before that with a follow-up sweep (re-running this merge later re-folds
  anything that accrued on a tombstone).
- **Tills closed / quiet hours — LOAD-BEARING, not advisory.** A till
  redemption landing between a pair's drift check and its atomic update would
  be clobbered by the verbatim credit move, and the base-wide total would NOT
  catch it (the clobber restores a pre-spend amount). Closed tills close this
  window; no guard in the runner does.
- `pos/storeCreditQueue` empty (the runner refuses otherwise).
- **Run the POS index backfill first** (POS repo:
  `scripts/migrate/backfill-customer-sale-index.mjs`, idempotent) so
  `customer_index/sales` is complete — the runner's `pos/sales.customerId`
  re-pointing scope is index-derived plus layby holdings plus the laybys node.
  A pre-index-era plain sale missing from the index would stay attributed to
  the tombstone (display/history only; open laybys are covered regardless via
  the laybys leg).

## Steps

1. **Census (read-only, writes nothing):**

       node scripts/customer-phone-census.mjs

   Prints format counts, collapse groups with per-record money detail,
   SAFE/REVIEW classification, and the base-wide credit total.

2. **Dry run (writes nothing):**

       node scripts/customer-merge.mjs

   Plans every SAFE pair from fresh reads, prints per-group money movement and
   the credit-before/expected-after totals, writes the snapshot + JSON report.
   Exit 0 means the execute run it rehearses has no known blockers.

3. **Execute (OWNER ONLY, quiet hours, tills closed):**

       node scripts/customer-merge.mjs --execute

   Per pair: fresh re-read → drift check (any change since planning skips the
   pair) → ONE atomic multi-path update → fresh verify. Then the base-wide
   credit total is recomputed from paged reads and compared to the cent.
   `--only=+27619467420` limits the run to named groups.

4. **Rollback (if anything looks wrong):**

       node scripts/rollback-customer-merge.mjs <snapshot.json>            # dry
       node scripts/rollback-customer-merge.mjs <snapshot.json> --execute

   Paths that changed AGAIN since the merge (a redemption, an instalment) are
   refused unless `--force` — read the divergence list before forcing.

## Known benign behaviours

- A resweep whose target survivor was itself touched earlier in the SAME run
  (a pair merge or another resweep into the same survivor) will DRIFT-skip
  and exit 1 — data-safe by design. Just re-run; the second pass plans from
  the settled state.
- A resweep whose tombstone's NAME no longer matches the survivor is refused
  (recycled number = possibly a different person) — those are the owner's to
  judge, like any REVIEW pair.

## After an execute run

- Spot-check one merged pair at the till: look the customer up by both number
  dialects, confirm credit balance and open laybys show on the one record, and
  confirm the layby is still findable by its invoice number.
- The tombstones stay visible to the POS until it gains a `mergedInto` filter
  (tracked in the POS-impact report) — the store app already follows the
  pointer on every resolve, so order-flow cannot re-fragment them.
