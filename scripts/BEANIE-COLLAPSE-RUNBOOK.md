# Beanie one-size collapse — operator runbook

Everything here is for **Junid to run**. The build is complete and reviewed; the
migration has **not** been executed and nothing has been deployed.

State as at the dry run of 2026-08-10:

```
scope 134 beanies   units 798   central=490  hub2=185  marathon-pe=123
PLANNED 67 · ALREADY DONE 47 · GATED 20
```

---

## 0. Clear the gates first

20 products are gated. They are skipped, not failed — the run completes the
other 67 and you re-run for these afterwards. Nothing about one product blocks
another.

**13 gated only by an active Display Check** (all at marathon-pe). A check is
keyed `{pid}__{sizeKey}`; after the collapse a sale keys `{pid}___`, so an
existing `pid__M` check can never be matched or completed again. Complete or
clear each one in Display Checks before migrating that product.

**7 gated by live refill activity** — an open refill request with its engine
lock, an unresolved Shop Refill line, or (one product) a line resolved this
morning that is still inside the 24h undo window. Fulfil or reject each request
in the refill queue; the undo-window one clears by itself once 24h has passed
since its resolution.

**5 products carry both kinds** of gate and need both cleared.

Re-running the dry run after clearing shows exactly what is left.

---

## 1. Pause the engine

```bash
# in the Firebase console, or via the CLI:
#   /receiving_session/active = true
```

The migration **refuses to execute** unless this is `true`. The health scan runs
every 15 minutes regardless of shop hours, so a trading-hours freeze alone does
not cover it.

## 2. Trading-hours window

Run it **outside trading hours** — early morning before the shops open, or after
close. Two reasons, both concrete:

- a till sale during the run lands in whichever cell that product's identity
  currently points at; the paired movements are safe under concurrency (each is
  atomic and version-guarded) but a sale landing between a product's Step 1 and
  Step 2 leaves a unit in the sized cell that the next run has to sweep;
- the 18 Display Check clears in step 0 are floor work.

The run itself is short — 67 products, 214 movement legs, 280 units.

## 3. Dry run, and read it

```bash
cd /Users/junidmohammed/Documents/marathon-store-app
node scripts/collapse-one-size-beanies.mjs
```

Confirm the summary matches what you expect and that GATED is down to whatever
you chose not to clear.

## 4. Execute

```bash
SNAPSHOT_PATH=~/beanie-collapse-rollback-$(date +%Y%m%d-%H%M).json \
REPORT_JSON=~/beanie-collapse-report-$(date +%Y%m%d-%H%M).json \
node scripts/collapse-one-size-beanies.mjs --execute
```

The rollback snapshot is written **before any write** and verified readable, or
the run aborts. Keep both files until the verification below passes.

To do a cautious first pass on one product:

```bash
node scripts/collapse-one-size-beanies.mjs --execute --only=p1782554164689
```

Exit 0 means every product processed and verified. Exit 1 means at least one was
gated or failed — the report names it. **Interrupting is safe at any point**:
every write is idempotent or ledger-derived, and a re-run completes the rest.

## 5. Verify — records, then labels

The script already verifies per product on fresh reads (identity collapsed,
every index record at `"_"`, no sized cell holding units, per-location totals
unchanged) and prints the network total before and after. That is necessary and
not sufficient.

**Scan physical labels at the till.** Reading records back cannot prove the
index repair worked; only a scan does. Take a handful of beanies off the shelf
at marathon-pe — including at least one that was `S` and one that was `M` — and
scan each at the POS. Each must resolve to the right product and sell without a
`size_unavailable` error. If a scan fails, stop and report before touching
anything else.

## 6. Resume the engine

```bash
#   /receiving_session/active = false
```

---

## Rollback

The snapshot from step 4 holds, per product: `sizes`, the `barcodes` map, every
barcode index record, every stock cell and every target row as they were before
the run. Restoring identity (sizes + barcodes map + index records) puts scanning
back exactly as it was. Stock is a ledger, not a snapshot — reversing it means
new paired movements in the opposite direction, not overwriting cells.

## What is NOT armed

No `/stock_targets` row is created by any of this, and no config key is touched.
After the collapse the beanies resolve **no** rule-based target — `"_"` is
deliberately absent from `defaultRunByStore` — so they sit inert until you write
explicit rows. `scripts/model-beanie-onesize-policy.mjs` models what those rows
would do; it writes nothing.
