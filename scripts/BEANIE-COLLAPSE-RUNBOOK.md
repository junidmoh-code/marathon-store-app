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
firebase database:set /receiving_session/active --project marathon-club <<< 'true'
# confirm it took:
firebase database:get /receiving_session/active --project marathon-club     # → true
```

The migration **refuses to execute** unless this is `true`. The health scan runs
every 15 minutes regardless of shop hours, so a trading-hours freeze alone does
not cover it.

It pauses the refill engine and **nothing else** — tills keep selling. That is
why the run also skips any product that moved in the last 15 minutes, and why
the window below matters.

## 2. Trading-hours window

Run it **outside trading hours** — early morning before the shops open, or after
close. Two reasons, both concrete:

- a till sale during the run lands in whichever cell that product's identity
  currently points at. Each movement re-reads and re-checks the cell before
  committing, so a sale cannot be silently overwritten — but a sale landing
  between a product's Step 1 and Step 2 leaves a unit in the sized cell, and the
  drain check then refuses to collapse that product until it is swept;
- the 18 Display Check clears in step 0 are floor work.

The run itself is short — 67 products, 214 movement legs, 280 units.

## 3. Pre-flight probe, then dry run

Run the probe inside the same quiet window — it writes each barcode index
record's existing value back, and a product being edited at that moment could be
overwritten (there is no exclusive barcode-write lock in this system to take):

```bash
node scripts/beanie-preflight-probe.mjs      # expect: 134/134 ok, 0 failed
```

Then the dry run, and read it:

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
firebase database:set /receiving_session/active --project marathon-club <<< 'false'
firebase database:get /receiving_session/active --project marathon-club     # → false
```

---

## Rollback

The snapshot from step 4 holds, per product: `sizes`, the `barcodes` map, every
barcode index record, every stock cell and every target row as they were before
the run.

**Identity is what you roll back**, and there is a script for it — it was a
one-liner until review pointed out that a one-liner restored the wrong subset:

```bash
node scripts/rollback-beanie-collapse.mjs ~/beanie-collapse-rollback-YYYYMMDD-HHMM.json
# read it, then:
node scripts/rollback-beanie-collapse.mjs ~/beanie-collapse-rollback-YYYYMMDD-HHMM.json --execute
```

It restores `sizes`, the `barcodes` map, **whole** barcode index records (and
removes any the migration created), and the `/stock_targets` rows the migration
retired — leaving those out would give a product back its old identity with no
refill policy. It verifies on fresh reads afterwards.

**It refuses if the product has moved since the snapshot.** Step 5 above sells
at the till on purpose, so later activity is expected rather than hypothetical,
and restoring identity under it can strand units that arrived in the `"_"` cell
after the collapse. The script names those movements and stops; `--force`
proceeds if you decide that is what you want.

**Stock is a ledger, not a snapshot.** The rollback deliberately does NOT move
stock — overwriting cells from the file would erase every sale and receive
since the run. After an identity restore the units are still in the `"_"` cell
while the product declares its old sizes again, so the sized cell reads 0. The
script prints exactly where the stock is sitting. To finish the job, move each
`"_"` balance back with FRESH paired movements — new ids, because the
migration's own ids are spent and would no-op.

## If a run dies without releasing its lock

`--execute` takes a lock at `/_migrations/beanieOneSizeCollapse/runLock` so two
runs can never overlap. Ctrl-C and a normal error both release it. A `SIGKILL`,
a crashed host or a lost laptop does not — there is no expiry, deliberately,
because auto-stealing a lock is how two runs end up writing at once.

The next run's abort message names the holder (pid, host, when it started).
Confirm that process is genuinely dead — `ps -p <pid>` on that host — then clear
it and re-run:

```bash
firebase database:remove /_migrations/beanieOneSizeCollapse/runLock --project marathon-club
```

A dry run never takes the lock, so it always works regardless.

## What is NOT armed

No `/stock_targets` row is created by any of this, and no config key is touched.
After the collapse the beanies resolve **no** rule-based target — `"_"` is
deliberately absent from `defaultRunByStore` — so they sit inert until you write
explicit rows. `scripts/model-beanie-onesize-policy.mjs` models what those rows
would do; it writes nothing.
