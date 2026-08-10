# Headwear one-size collapse — operator runbook

Everything here is for **Junid to run**. The build is complete and reviewed. The
migration has **not** been executed, no target row has been written, and nothing
has been deployed. There is no app change in this work at all — it is scripts
only, so **no hosting deploy is needed or wanted**.

State as at the census of 2026-08-10:

```text
scope 301 products — 134 beanies + 167 caps
units 1358          central=700  hub2=262  marathon-pe=396  marathon-pine=0
already one-size    68 (47 beanies, 21 caps) — verify as no-ops
```

Caps are **not** an extension of the beanie job. Two things that were trivially
true of beanies are false of caps, and both change what can go wrong:

- **47 caps hold stock in two or more sizes at once**, so the merge genuinely
  adds quantities (`L 2 + M 1 + S 2 + XL 1 → "_" 6`). No beanie ever did.
- **87 caps carry more than one barcode** (one carries seven), so a rule has to
  decide which code keeps the `"_"` slot.

---

## 0. Clear the gates first

**97 blockers across 70 products** (50 caps, 20 beanies). A gated product is
skipped, not failed — the run completes everything else and you re-run for these
afterwards. Nothing about one product blocks another.

**68 products gated by an active Display Check**, all at marathon-pe. A check is
keyed `{pid}__{sizeKey}`; after the collapse a sale keys `{pid}___`, so an
existing `pid__M` check can never be matched or completed again. Complete or
clear each one in Display Checks before migrating that product. This is floor
work and it is the bulk of the job.

**7 products gated by live refill activity** — an open refill request with its
engine lock, an unresolved Shop Refill line, or one (`Polo Ralph beanie brown`)
resolved this morning and still inside the 24h undo window. Fulfil or reject
each in the refill queue; the undo-window one clears by itself.

Re-running the census after clearing shows exactly what is left:

```bash
node scripts/headwear-census.mjs
```

### Two things to read before you start, not after

**15 caps are in scope because of the shelf they sit on, not their name** —
`Armani exchange mustard`, `Nike Dri-FIT Fly Maroon`, `New Era Atlanta Braves
59FIFTY fitted Black` and so on. A name rule would have left them sized while
their siblings collapsed. The census prints all 15 under
`ADMITTED AS A CAP BY THE SHELF ALONE`. **If any of those is not a cap, say so
before the run** — that is the one scope decision the data cannot settle.

**23 shelf-mates are deliberately excluded**: 7 visors and 16 bucket hats.
Neither is a cap. 15 of the 16 bucket hats already declare `["_"]` and need
nothing; the sixteenth (`Nike bucket hat green`, `["M"]`) is the only excluded
record with a sized run left. Say the word and it is a one-line addition — it is
out today because the brief scoped this to beanies and caps.

---

## 1. Pause the engine

```bash
firebase database:set /receiving_session/active --project marathon-club <<< 'true'
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
close. Concretely:

- a till sale during the run lands in whichever cell that product's identity
  currently points at. Each movement re-reads and re-checks the cell before
  committing, so a sale cannot be silently overwritten — but a sale landing
  between a product's Step 1 and Step 2 leaves a unit in the sized cell, and the
  drain check then refuses to collapse that product until it is swept;
- the pre-flight probe writes each barcode index record's existing value back.
  There is no exclusive barcode-write lock in this system to take, so a product
  being *edited* at that moment could be overwritten. The quiet window is the
  real control there;
- the 68 Display Check clears in step 0 are floor work.

**Budget it as two sessions, not one.** The beanie half is mostly identity work;
the cap half carries the arithmetic and the 68 Display Checks. `--kind` exists
so you can run them on separate days:

```bash
node scripts/collapse-one-size-headwear.mjs --kind=beanie --execute
node scripts/collapse-one-size-headwear.mjs --kind=cap    --execute
```

## 3. Pre-flight probe, then dry run

Run the probe inside the same quiet window:

```bash
node scripts/headwear-preflight-probe.mjs        # expect: 719/719 ok, 0 failed
```

It probes **every** code, never a sample, and that matters more on caps than it
did on beanies: Step 2 rewrites all of a product's index records in one atomic
update, so one unwritable record takes down its whole product. The largest
single batch is 9 records (`p1785568547550`).

If it aborts with `PERMISSION_DENIED` it will name the credential type. Nothing
moves until it passes.

Then the dry run, and read it:

```bash
GATE_MAX_AGE_SECONDS=3600 node scripts/collapse-one-size-headwear.mjs
```

**Expect the dry run to take a while, and use that env var for it.** The gate
data (transfers, orders, refill requests, engine locks, Display Checks) is
re-read whenever it is more than 60 seconds old, so that a request opened
mid-run cannot be missed. `/refill_requests` alone is ~12k records, and over 301
products that refresh happens many times. That bounded staleness is exactly what
you want on the **execute** run and is pure cost on a dry run, which writes
nothing — so raise it for the dry run and leave it at the default when you
execute:

```bash
node scripts/collapse-one-size-headwear.mjs --execute        # default 60s — keep it
```

Confirm the summary matches the census and that GATED is down to whatever you
chose not to clear. The dry run flags any planned leg whose movement id is
already spent — on a first run that never happens; on a resume it means stock
arrived in a size whose pair has been used, and the execute path will refuse to
collapse that product rather than strand the units.

## 4. Execute

Run it as **two passes**, each with its own snapshot and report, matching the
two-session plan above. Without `--kind` a single run migrates every eligible
beanie AND cap, which is not what the session plan says:

```bash
# PASS 1 — beanies
SNAPSHOT_PATH=~/headwear-beanie-rollback-$(date +%Y%m%d-%H%M).json \
REPORT_JSON=~/headwear-beanie-report-$(date +%Y%m%d-%H%M).json \
node scripts/collapse-one-size-headwear.mjs --kind=beanie --execute

# PASS 2 — caps (the arithmetic half; run it on its own day)
SNAPSHOT_PATH=~/headwear-cap-rollback-$(date +%Y%m%d-%H%M).json \
REPORT_JSON=~/headwear-cap-report-$(date +%Y%m%d-%H%M).json \
node scripts/collapse-one-size-headwear.mjs --kind=cap --execute
```

Each pass has its own rollback snapshot, so a cap problem can be reverted
without touching the beanies.

The rollback snapshot is written **before any write** and verified readable, or
the run aborts. Keep both files until the verification below passes.

A cautious first pass on one product:

```bash
node scripts/collapse-one-size-headwear.mjs --execute --only=p1782723308519
```

That one is a good first choice: a real multi-size cap (`marathon-pe: L 2 + M 2
→ "_" 4`) carrying six barcodes, so it exercises both new paths at once.

Exit 0 means every product processed and verified. Exit 1 means at least one was
gated or failed — the report names it. **Interrupting is safe at any point**:
every write is idempotent or ledger-derived, and a re-run completes the rest.

## 5. Verify — records, then labels

The script verifies per product on fresh reads (identity collapsed, every index
record at `"_"`, no sized cell holding units, per-location totals unchanged) and
prints the network total before and after. **The totals are the headline: 1358
units in, 1358 units out.** That is necessary and not sufficient.

**Scan physical labels at the till.** Reading records back cannot prove the
index repair worked; only a scan does, and for caps there is a second thing to
prove that beanies never had:

1. Take a handful of hats off the shelf at marathon-pe — **at least one former
   `M` and one former `L` cap**, plus a former `S` beanie.
2. Scan each at the POS. Each must resolve to the right product and sell without
   a `size_unavailable` error.
3. **Then scan two labels from the same multi-size cap** — a former `M` and a
   former `L` of one design. Both must ring up the *same* product at the *same*
   price and deduct the *same* cell. That is the one thing the keep-code rule
   promises and the only way to see it: only one of those two codes kept the
   `"_"` slot, and the other must still resolve.

If a scan fails, stop and report before touching anything else.

## 6. Resume the engine

```bash
firebase database:set /receiving_session/active --project marathon-club <<< 'false'
firebase database:get /receiving_session/active --project marathon-club     # → false
```

---

## 7. Arm the refill policy — a SEPARATE decision, after the collapse

Nothing in steps 1–6 creates a target row. Do this only once the collapse has
been verified.

```bash
MODEL_JSON=~/headwear-policy-model.json PAYLOAD_JSON=~/headwear-policy-payload.json \
node scripts/model-headwear-onesize-policy.mjs        # writes files only, never RTDB

node scripts/apply-headwear-policy.mjs ~/headwear-policy-payload.json            # dry run
node scripts/apply-headwear-policy.mjs ~/headwear-policy-payload.json --execute  # arm
```

The apply script **refuses to arm any product that has not collapsed yet**, so
running it early is safe — it stops rather than writing rows that look armed and
silently become real later.

**Turning it off is deleting the rows.** Since #342 an explicit `/stock_targets`
row wins over the rule and outlives the `ruleBasedTargets` kill switch, so
flipping that config key does **not** disarm this:

```bash
node scripts/apply-headwear-policy.mjs ~/headwear-policy-payload.rollback.json --execute --delete
```

---

## Rollback (the collapse itself)

The snapshot from step 4 holds, per product: `sizes`, the `barcodes` map, every
barcode index record, every stock cell and every target row as they were before
the run.

```bash
# whichever pass you are undoing — the two have separate snapshots:
node scripts/rollback-headwear-collapse.mjs ~/headwear-cap-rollback-YYYYMMDD-HHMM.json
# read it, then:
node scripts/rollback-headwear-collapse.mjs ~/headwear-cap-rollback-YYYYMMDD-HHMM.json --execute
```

It restores `sizes`, the `barcodes` map, **whole** barcode index records (and
removes any the migration created), and the `/stock_targets` rows the migration
retired — leaving those out would give a product back its old identity with no
refill policy. It verifies on fresh reads afterwards.

**It refuses if the product has moved since the snapshot.** Step 5 sells at the
till on purpose, so later activity is expected rather than hypothetical, and
restoring identity under it can strand units that arrived in the `"_"` cell.
The script names those movements and stops; `--force` proceeds if you decide
that is what you want.

**Do the stock move-back before the next sale.** The moment an identity restore
lands, the sized barcodes are live again while the sized cells read 0 — so a
till sale in that window either refuses or drives the cell negative, and any
restored target rows re-arm the refill engine against empty sized cells. Restore
identity and move the stock back in one closed window, not across a trading day.

**Stock is a ledger, not a snapshot.** The rollback deliberately does NOT move
stock — overwriting cells from the file would erase every sale and receive since
the run. After an identity restore the units are still in the `"_"` cell while
the product declares its old sizes again, so the sized cell reads 0. The script
prints exactly where the stock is sitting. To finish, move each `"_"` balance
back with FRESH paired movements — new ids, because the migration's own ids are
spent and would no-op.

## If a run dies without releasing its lock

`--execute` takes a lock at `/_migrations/headwearOneSizeCollapse/runLock` so
two runs can never overlap. Ctrl-C and a normal error both release it. A
`SIGKILL`, a crashed host or a lost laptop does not — there is no expiry,
deliberately, because auto-stealing a lock is how two runs end up writing at
once.

The next run's abort message names the holder (pid, host, when it started).
Confirm that process is genuinely dead — `ps -p <pid>` on that host — then:

```bash
firebase database:remove /_migrations/headwearOneSizeCollapse/runLock --project marathon-club
```

A dry run never takes the lock, so it always works regardless.

## Two things worth knowing before you run

**A resumed run completes half-applied pairs from the LEDGER, not from the
cell.** If a run is interrupted between a pair's OUT and IN legs and the cell
then moves — a till oversell, a warehouse receive — the resume still credits the
quantity the OUT actually removed. Stock that arrived AFTER a pair was spent is
reported as `STRANDED` and refuses to collapse that product until you move it to
`"_"` by hand; it is never quietly swept in under a spent movement id.

**Merging negatives concentrates them, and the live `/stock` rule cares.** The
rule allows a negative cell only when `lastType` is `sold`/`return`/
`transfer_in`/`transfer_out`, so a client RECEIVE that would leave a cell still
below zero is rejected. That is already true per cell today; after the collapse
a location's negatives sit in ONE `"_"` cell instead of several sized ones, so
clearing it takes one larger receive rather than several small ones. Reconciling
the 9 negative cells before the run avoids the question entirely.

## The negative cells

Nine cells are negative (8 caps, 1 beanie), all at marathon-pe, the largest
`−3`. They are **not** blockers — they migrate through a mirrored pair that
moves the shortage rather than the stock, so a normal OUT never has to overdraw.
The `−3` sits on a cap that also holds `S 1` at the same location, so its `"_"`
cell lands at `−2`: the shortage survives the migration instead of being
laundered away. If you would rather reconcile them first, do it before step 4
and the mirrors simply will not be needed.
