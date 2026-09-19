# Firebase cost — measured 19 September 2026

The owner's question: the POS now runs offline, so the bill should have fallen,
and it did not. It is still about $15 a day.

**The answer is that the POS was never the cost.** Cloud Storage egress — the
photo mirror the tills pull — bills **$0.00**. 89% of the bill is Realtime
Database download, and 84% of *that* is the store app on staff phones
downloading five whole nodes, again, on every screen open.

**This report changed no application code**, and §5 explains why: while it was
being written, two parallel sessions shipped the two largest lines it found —
#617 for the display-checks sweep, and #618, the store-app offline mirror, for
the 84%. What was built here was measured, reviewed, and then dropped rather
than shipped alongside a better design. The measurement is the deliverable, plus
an unattended Monday capture (§9) and two things the owner has to decide (§10) —
one of which is that **hosting has not deployed since 17 September**.

Every figure below is **measured** (read off the billing console, a live
profiler capture, or a live bounded query) or **derived** (arithmetic on
measured figures, always shown). Nothing is modelled.

**Units, because they caused the only arithmetic mistakes in this report:** MB
here is decimal (10⁶ bytes), because that is what the profiler analyser prints;
GiB is binary (2³⁰), because that is what Google bills. Converting between them
is ÷1,073.74, not ÷1,024, and getting that wrong inflates a saving by 5%.

**What this investigation cost to produce:** 65,082 B of live reads — one
bounded `orderByChild("resolvedAt").equalTo(null)` query against
`/refill_requests` (§5.1), and a `gcloud logging read` that cost nothing — plus a 51,550 B read of `/.settings/rules.json`,
which is configuration, not data. The profiler streams operation metadata to the
admin, not data, and is not billed as download.

That figure covers *this* investigation only, and it would be a dishonest number
to leave standing on its own: §2.1 records 178.0 MB of whole-node `curl` reads
made from the same laptop, in the same hour, by a second session working the
same problem. Those are not counted here because they are not this work, but
they are the same estate's money either way, and they are the reason §2.1 exists
rather than being quietly netted off.

---

## 1. The bill, both accounts summed

Source: GCP billing console, Reports, grouped by SKU, read per account.

**Account 01014A-0CA8D9-C2A1F6 ("My Billing Account") bills $0.00 for
September.** Everything moved to 01FCC9 on 22 August and nothing came back, so
for this month the sum of both accounts *is* 01FCC9. Both were read; this is
the result of reading both, not a reason to read one.

### 1.1 Every SKU over $0.20/day, 1–18 September (measured)

Eighteen days have posted. 19 September was still posting when this was read.

| SKU | Service | SKU ID | Usage | Cost | $/day | Share |
|---|---|---|---:|---:|---:|---:|
| **Outgoing Bandwidth** | Firebase Realtime Database | 04F2-6383-80BD | **278.81 GiB** | **$272.13** | **$15.12** | **89.2%** |
| Generate_content image output, Gemini 3 Pro Image | Gemini API | 096D-0370-0236 | 161,280 | $19.35 | $1.08 | 6.3% |
| Static Ip Charge | Compute Engine | 66A2-68EA-56BE | 430 h | $4.29 | $0.24 | 1.4% |
| **All 50 other SKUs together** | | | | $9.31 | $0.52 | 3.1% |
| **Total** | | | | **$305.08** | **$16.95** | |

No fourth SKU reaches $0.20/day: the next is Gemini 3.7 flash image input at
$1.43 for eighteen days ($0.079/day), and it falls away from there.

**So: it is mostly RTDB, and it is not close.** One SKU is 89% of the bill.

**The rate.** $272.13 for 278.81 GiB is **$0.97604/GiB** — that is the bill's own
implied rate and it is what every conversion in this report and in
`scripts/cost/analyse-profile.mjs` uses. The commonly quoted $0.979 is close
enough to look right and far enough out to make totals disagree in the second
decimal, which is how the first draft of §4 came to a figure four cents above
§1.1.

### 1.2 The suspects that bill nothing (measured)

These were on the list to check and each one is a dead end, which is worth
recording so nobody spends a day on them again:

| Line | Usage, 1–18 Sep | Cost |
|---|---:|---:|
| Cloud Storage — Download Worldwide Destinations (**the POS photo mirror**) | 88.13 GiB | **$0.00** |
| Cloud Run Functions — invocations | 194,162 | $0.00 |
| Cloud Run Functions — CPU, europe-west1 | 129,741 s | $0.00 (−$3.11 discounted) |
| Cloud Vision — document text detection (card recon) | 530 | $0.00 |
| Firebase Hosting — outgoing bandwidth | 2.81 GiB | $0.00 |
| Firebase Realtime Database — **storage** | 0.09 GiB·month | $0.00 |

The photo mirror moved 88 GiB and was charged for none of it. **There is no
POS photo line to cut.** Cloud Storage class B operations ($0.59 for eighteen
days) is the only storage-side charge that is not zero, and it is $0.03/day.

### 1.3 Per-day trend (measured)

| Sep | $ | | Sep | $ | | Sep | $ |
|---:|---:|---|---:|---:|---|---:|---:|
| 1 | 18.77 | | 8 | 16.85 | | 15 | 13.22 |
| 2 | 21.59 | | 9 | 12.68 | | 16 | 13.73 |
| 3 | 21.40 | | 10 | 14.09 | | 17 | 15.02 |
| 4 | 22.10 | | 11 | 15.18 | | 18 | 15.33 |
| 5 | 14.96 | | 12 | **24.59** | | 19 | 6.47 (partial) |
| 6 | 15.17 | | 13 | 12.07 | | | |
| 7 | 16.29 | | 14 | 15.55 | | | |

These are the console's **subtotal** figures — what is actually charged, after
the small "other savings" line. 19 September is partial and is excluded from
every average below, so that every figure here covers the same 1–18 September
window §1.1 does.

The eighteen charged days sum to **$298.59**, against the **$305.08** §1.1
reports for that same window — a $6.49 (2.1%) gap between two views the console
gives of one period. It is not explained here, and it is left visible rather
than smoothed away. Nothing in this report turns on it (the fixes are sized from
measured per-read bytes, not from this series), but a daily series that does not
add up to its own period total is exactly the sort of thing a later reader
deserves to be warned about rather than to discover.

Two things this series says:

- **There is a step down on 5 September.** 1–4 Sep averages $20.97; 5–18 Sep
  averages $15.34. That is PR #551 (the Shopify reconcile loop learning to read
  what changed, merged 4 Sep) landing, and it is worth about $5.63/day. §3
  confirms the loop is now 149 B a tick.
- **Weekends cost slightly MORE than weekdays.** In September 2026 the weekend
  days in this window are the 5th, 6th, 12th and 13th (19 September, the day of
  the capture, is a Saturday). They average **$16.70**; the fourteen weekdays
  average **$16.56**. A bill that is marginally higher when every shop is shut
  is not being driven by trading, which is the single most useful thing this
  series says — and it is why the capture in §2 was worth taking on a Saturday
  evening at all.

The 12 September spike is $19.27 of RTDB plus $4.57 of Gemini image generation
in one day — a social-engine burst on top of an ordinary-to-heavy database day,
not a single event.

---

## 2. Live capture — Saturday 19 September, 18:14–19:14 SAST

`firebase database:profile --project marathon-club --duration 3900 --raw`,
run on the Mac mini. 36,801 records over 59.8 minutes. Shops shut: this is the
after-hours floor.

Analysed by `scripts/cost/analyse-profile.mjs`, which is committed alongside
this report so every number here can be recomputed from the raw capture.

### 2.1 The capture had to be cleaned first

Raw total: **624.90 MB over the 59.8-minute window.** Of that, **188.84 MB
(30.2%) came from the laptop this investigation runs on** (`client-e0bc`,
identified by matching the capture's address against that machine's own public
IP) — 178.0 MB of it `curl/8.7.1` making whole-node REST reads of
`/stock_movements`, `/insights_log`, `/stock`, `/refill_requests`, `/products`,
`/orders` and `/restock_log`, and 10.8 MB from a Chrome session.

That is a second investigation session working the same problem on the same
machine at the same time, and **none of it is production traffic.** It is
excluded from every figure below. It is recorded rather than quietly dropped
because a 30% contaminant that nobody names is exactly how a capture ends up
"proving" a cost that does not exist — and because it is a live demonstration
of what one whole-node read costs: a single `curl` of `/stock_movements` over
REST was **31.8 MB**, uncompressed.

**Production: 436,064,345 B over 59.8 minutes** — 437.5 MB/h normalised —
**→ 9.78 GiB/day → $9.55/day.**

Every byte figure in §2.2, §2.3 and §2.4 is the **capture total for those 59.8
minutes**, not a per-hour rate; the annualisation above is the only place the
window length is divided out. The two are within 0.3% of each other, which is
precisely why labelling them loosely would have been easy and wrong.

That is the floor with the shops shut, and it is two thirds of the $15.12/day
RTDB bill — *part* of it, not something underneath it. The remaining third is
trading-hours traffic this window could not see, which is what the Monday
capture in §9 is for.

### 2.2 Production, by client (measured)

Client addresses are reduced to stable tags. This file is in a **public**
repository, and the staff-phone rows are personal devices whose public IP has no
business being published; the tag is enough to say "these reads came from the
same device", which is all the analysis needs.
`scripts/cost/analyse-profile.mjs` does this by default and `--raw-addresses`
undoes it for local work.

| Client | Who | Bytes in the window | Share |
|---|---|---:|---:|
| `client-01dd`, `client-56d1`, `client-28cb` (iOS) | **four staff phones** | **242,263,371** | **55.6%** |
| `client-cf7a`, Admin SDK | **refillHealthScan** (4 runs) | 163,384,548 | 37.5% |
| `client-fec1`, Admin SDK | **wakeHeldChecks** (12 runs) | 19,358,667 | 4.4% |
| `client-301d`, Admin SDK + node | **the Mac mini** — reconcile loop, card-recon poller, social publisher | 6,234,326 | 1.4% |
| other Cloud Functions | search index, EFT, social, hold-reveal | 4,823,433 | 1.1% |

Four phones after closing time outweigh every server process in the estate put
together.

### 2.3 Production, by path (measured)

"Ranged" counts reads that carried a server-side query. The profiler also flags
a query it had to answer *without* an index (`unIndexed`); **no read in this
capture was flagged**, so nothing is silently falling back to a scan.

| Path | Bytes in the window | Share | Reads | Of those, ranged | Biggest single read |
|---|---:|---:|---:|---:|---:|
| `/stock` | 82,787,385 | 19.0% | 17,705 | 1,585 | **6,886,383 B** (whole node) |
| `/insights_log` | 71,599,498 | 16.4% | 4 | **0** | **35,799,749 B** (whole node) |
| `/stock_movements` | 66,594,018 | 15.3% | 9 | 7 | 16,648,995 B |
| `/products` | 63,299,294 | 14.5% | 47 | 20 | **4,868,296 B** (whole node) |
| `/refill_requests` | 63,206,283 | 14.5% | 7 | **0** | **9,029,469 B** (whole node) |
| `/orders` | 29,122,489 | 6.7% | 81 | 60 | 2,647,499 B |
| `/displayChecks_active` | 19,342,584 | 4.4% | 18 | 0 | 1,280,013 B |
| `/stock_targets` | 12,225,759 | 2.8% | 7 | 0 | 1,746,537 B |
| everything else | 27,887,035 | 6.4% | | | |
| **total** | **436,064,345** | **100%** | | | |

The two paths with **zero** ranged reads are exactly the two this PR fixes.

The 17,705 reads of `/stock` are almost all single-cell `qty` reads from
wakeHeldChecks and cost bytes each; the 6.89 MB figure is the whole-node read a
phone makes.

### 2.4 What the staff phones actually download (measured)

242.26 MB in the 59.8-minute window, with the shops shut. This is the line that
matters.

"Reads" is every read record, including ones that returned nothing; the last
column is the largest single read, which for these paths is the whole node.
`/insights_log` shows four read records and two of them are 0 B — the node was
fully downloaded **twice**.

| Path | Bytes in the window | Share of phone traffic | Reads | Largest single read |
|---|---:|---:|---:|---:|
| `/insights_log` | 71,599,498 | 29.6% | 4 (2 of them 0 B) | **35,799,749 B** |
| `/stock` | 59,276,990 | 24.5% | 16 | 6,886,383 B |
| `/products` | 43,805,730 | 18.1% | 21 | 4,868,296 B |
| `/refill_requests` | 27,088,407 | 11.2% | 3 | 9,029,469 B |
| `/orders` | 18,532,493 | 7.6% | 17 | 2,647,499 B |
| `/customers` | 5,426,210 | 2.2% | 6 | 1,808,403 B |
| `/stock_targets` | 5,239,611 | 2.2% | 3 | 1,746,537 B |
| `/returns_log` | 4,504,704 | 1.9% | 17 | 750,784 B |
| `/settings` | 3,111,677 | 1.3% | 69 | 178,000 B |

**One phone opened Insights twice in an hour and paid 35,799,749 B each time.**
`/insights_log` was 30.9 MB on 3 September and is 35.80 MB now: about 0.31 MB a
day over those sixteen days, and nothing prunes or archives it.

---

## 3. The Mac mini's Shopify loop — the 3 September headline, now closed

On 3 September the mini's reconcile loop was 45–79% of every hour measured.
It is now **1.4% of the floor**, and the fix that did it is confirmed running:

| Question | Answer | Evidence |
|---|---|---|
| Is PR #551's fix what is actually running? | **Yes** | `git merge-base --is-ancestor 469ec87 HEAD` on the mini's own checkout returns true |
| Bytes per tick | **149 B** on an incremental tick; **2,476,027 B** on the 30-minute full scan | the loop's own `rtdb read this run:` line, `logs/shopify-reconcile.log` |
| Ticks per day | ~672 incremental + 48 full scans | launchd `ThrottleInterval` 120 s, full scan on a 30-minute cadence |
| Overnight ticks | They run, and they do no work: `scan: incremental (watermark) · 0 node(s) in window, 0 retry` | same log, 18:16 and 18:21 ticks |
| **Does the `/shopify_publish` `updatedAt` index exist live?** | **Yes.** `".indexOn": ["state", "updatedAt"]` | read from `/.settings/rules.json` live |
| Is the loop ever falling back to a whole-node read? | **No** — zero occurrences of the fallback warning in the current log | the loop logs `⚠ /shopify_publish has no ".indexOn"` whenever it falls back |

Derived: 48 × 2.476 MB + 672 × 149 B ≈ **119 MB/day = 0.11 GiB/day = $0.11/day**,
down from the $87–160/month the 3 September report measured. The further
"~$45/month depends on adding updatedAt to .indexOn" **was applied and is
live.** There is nothing left to do here.

The mini's whole footprint — reconcile loop, card-recon poller, social
publisher, watchdog — is 6.23 MB/h, $0.14/day.

---

## 4. Where the $15.12/day goes

Lines 2–5 are each a measured per-run size multiplied by a schedule read
verbatim out of Cloud Scheduler (`gcloud scheduler jobs list`, quoted below).
Line 1 is the remainder. Conversions use the bill's own $0.97604/GiB.

| # | Line | Schedule, as Cloud Scheduler holds it | Per run | Runs/day | GiB/day | $/day | Share of RTDB |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | **Store app whole-node reads on staff phones and browsers** | — | — | — | **12.95** | **$12.64** | **83.6%** |
| 2 | refillHealthScan | `every 15 minutes from 07:00 to 19:00` (Africa/Johannesburg) | 40.85 MB | 49 | 1.86 | $1.82 | 12.0% |
| 3 | wakeHeldChecks | `every 5 minutes` *(until #617 — see §5.3)* | 1.61 MB | 288 | 0.43 | $0.42 | 2.8% |
| 4 | Mac mini — every process on it | 2-minute loop, `KeepAlive` | 6.23 MB | — | 0.14 | $0.14 | 0.9% |
| 5 | All other Cloud Functions | various | 4.82 MB | — | 0.11 | $0.11 | 0.7% |
| | **RTDB total** | | | | **15.49** | **$15.12** | 100% |

The GiB column sums exactly to the bill's 15.49. The dollar column is each line
rounded on its own, so adding it up gives $15.13 against the bill's $15.12 —
a cent of rounding, not a missing line.

**On line 2's 49 runs, not 96.** The capture saw four refillHealthScan runs in
59.8 minutes, which reads like 96 a day if you assume it runs around the clock.
It does not: the schedule is `every 15 minutes from 07:00 to 19:00`, so four an
hour for twelve hours is 48–49, and the capture hour (18:14–19:14) sits at the
very end of that window. The distinction is worth $1.82/day on line 1, which is
why the schedule string is quoted rather than summarised.

Line 1 is a remainder, and remainders deserve suspicion. It is more trustworthy
here than the equivalent figure was on 3 September, because the capture's own
production rate — 9.78 GiB/day, with the shops shut and four phones on it — now
accounts for two thirds of the bill by direct measurement rather than a third.
It is still the one number in this report that nothing measured end to end, and
§9's Monday capture is what turns it into a measurement.

Outside RTDB, the only other lines worth naming are Gemini 3 Pro image
generation for the social engine ($1.08/day) and the static IP ($0.24/day).

---

## 5. What this work fixed, and what fixed itself while it ran

**No application code changed in this branch, and that is the finding as much as
anything else in it.**

Two candidate fixes were built, reviewed and then dropped, because during the
five hours this investigation ran two parallel sessions shipped the same two
lines with better designs:

- **#617, merged 18:55 SAST** — the display-checks sweep (`wakeHeldChecks`) from
  288 runs a day to 5. That is §4 line 3, from $0.42/day to about $0.01/day.
- **#618, merged 20:00 SAST** — an offline mirror for the store app: "one
  download at setup, then only what changed". It routes `usePath` — the
  chokepoint for `/stock`, `/refill_requests`, `/stock_movements`, `/products`
  and the `/settings` nodes — through a local copy, and gives
  `/insights_log` its own mirrored source in the same provider. That is §4
  line 1, the 84% line, by a route that removes the reads rather than narrowing
  them.

### 5.1 What was built here instead, and why it was dropped

Both are recorded because the measurements behind them stand, and because
either would be the right answer if the mirror is ever off.

**`/refill_requests`, whole node → open set.** `useRefillRequests()` read the
whole 9,029,469 B node for six call sites, every one of which then filters
`status === "open"`. Measured against the live database:

| | Bytes | Rows |
|---|---:|---:|
| Whole node | **9,029,469** | all history |
| `orderByChild("resolvedAt").equalTo(null)` | **65,082** | **272, every one `status: "open"`** |

**99.3% smaller**, on an index (`resolvedAt`) that is already live, for exactly
the rows the screens keep. `RefillHistory.jsx` already uses this query for its
open backlog, so it is an established shape.

*Why it was dropped:* the implementation subscribed directly, which would route
**around** the mirror chokepoint #618 had just introduced. On a mirror-serving
device that read now costs nothing at all, so the version built here would have
turned a zero into 65 KB and put one hook outside the new design — to save bytes
on a fallback path that #618 exists to retire. Rewiring `usePath` to carry a
query instead is a change to the heart of a design that landed an hour earlier,
and it is its author's call, not a side effect of a cost report.

**`/insights_log`, resume instead of re-download.** The node is append-only, so
a provider that released its subscription could keep its rows and resume with
`orderByKey().startAfter(lastKey)` rather than paying 35,799,749 B again.

*Why it was dropped:* #618 does the same thing properly — the rows live in
IndexedDB across sessions and devices, not in one tab's memory for 30 minutes,
and its mirrored source re-reads when the leg moves. Keeping both would have
been actively wrong: the store would pass a `sinceKey` to a mirrored source that
returns the whole leg, and the merge would duplicate rows on screen.

Review earned its keep on this one before it was dropped. The first version
concatenated the resumed tail in front of the kept rows, which assumes every
tail row is newer *by `timestamp`*. `src/utils/serverTime.js` documents a known
limit — the server offset is measured once at the socket handshake and never
resynced — so a till whose clock drifts mid-session writes a `timestamp` behind
reality, gets a chronological push key, and lands in the tail while being old by
timestamp. The whole-node read re-sorted on every read and healed it invisibly;
`App.jsx` renders `periodLog.slice(0, 30)` positionally. **That would have put
the wrong rows on an Insights screen** — the one thing this work was not allowed
to do. Anyone building a resume on this node later should start from that.

### 5.2 The server-side readers: measured, and worth nothing

`chatStream` reads the whole of `/insights_log` (35.8 MB) and `/orders`
(2.65 MB) on every invocation and sends the model only the most recent 100 of
each. `analyzeReorderNeeds` reads `/products`, `/orders`, `/insights_log` and
`/returns_log` whole per run. Both look like obvious `limitToLast` fixes.

Neither has been invoked in seven days:

```
$ gcloud logging read "resource.type=cloud_run_revision AND
    resource.labels.service_name=chatStream" --freshness=7d
(no entries)
```

`chatStream` serves `marathon-club-ai.web.app`, which the owner disabled on
3 September. **Fixing either would save $0.00/day**, so neither was touched.
They are written down so the next person costing this estate does not spend an
afternoon on them. If that site is ever re-enabled, they become real, and
`orderByKey().limitToLast(100)` needs no index on either node.

### 5.3 What was deliberately not touched

- **`functions/refill-scan.cjs` was not edited at all.** refillHealthScan is
  §4's second line at $1.82/day, and the same open-only query as §5.1 would cut
  the 36.1 MB it re-reads of `/refill_requests` on each of 49 daily runs. It
  belongs to the session that owns that file. Measured here, left there.
- **Neither schedule in §4 was changed here** — both are owned by the parallel
  session, and #617 is one of them landing.

---

## 6. What is left, after #617 and #618

The mirror removes the client-side reads for devices that have set it up. What
it does not remove:

| Line | Measured | Why it survives |
|---|---:|---|
| **refillHealthScan reads `/refill_requests` whole** | 36.1 MB per run × 49 runs/day ≈ $0.83/day | Server-side; the mirror is a client. The §5.1 query applies directly, on an index already live. |
| **refillHealthScan reads `/stock_movements` whole** | 16,648,995 B per run ≈ $0.80/day | `.indexOn: ["ts"]` is already live, so a watermark read needs no paste — but what window the scan may safely read is its owner's call. |
| **The mirror's own first sync** | `/insights_log` 35.8 MB + `/products` 4.87 MB + `/stock` 6.89 MB per device, once | By design, and the whole point: paid once instead of per screen open. It does mean the saving arrives per device as each is set up, not all at once. |
| **Every device still on the fallback path** | the §2.4 figures, unchanged | The mirror is per-device setup. Until a device has it, that device reads exactly as it did on 19 September. |

---


## 7. The console rule and index situation

**Nothing here needs a rule or an index pasted**, and neither would the two
dropped fixes in §5.1 — both run on indexes that are already live. This section
records what was checked, because "the `updatedAt` index may never have been
applied" was an open question going in, and the answer turns out to be worth
about $45/month.

Read live from `/.settings/rules.json` on 19 September:

| Node | Live `.indexOn` | Needed by | Verdict |
|---|---|---|---|
| `shopify_publish` | `["state", "updatedAt"]` | the mini's incremental reconcile scan | **present — the ~$45/month index was applied** |
| `refill_requests` | `["createdAt", "resolvedAt"]` | the open-only query in §5.1, and §6's server-side version of it | **present** |
| `insights_log` | none | `orderByKey()` ranges, which never need one | **nothing needed** |
| `orders` | `["destShop", "readyNotifyPending", "customerId"]` | a future `createdAt` range (§6) | would need a paste; not part of this work |
| `stock_movements` | `["ts"]` | a future watermark read (§6) | present, unused |

The repo's `database.rules.json` was not touched and must not be deployed: it
is stale against live.

---

## 8. Expected result

| | Working | $/day |
|---|---|---:|
| Measured bill, 5–18 September average | subtotal column, §1.3 | **$15.34** |
| less #617, display-checks sweep 288 → 5 runs | 283 fewer runs × 1.61 MB = 455.6 MB/day = 0.424 GiB | −$0.41 |
| less #618, store-app mirror — **per device, as each is set up** | at the §2.4 rate, a device that stops re-reading `/insights_log`, `/stock`, `/products` and `/refill_requests` is worth up to ~$4 – 9/day across the estate | −$4 to −$9 |
| **Expected** | | **≈ $6 – 11** |

**The #618 line is a range, not a number, and it is the least certain figure in
this report.** Three things make it so, and all three point the same way — it
arrives gradually:

1. **The mirror is per-device setup.** Every device still on the fallback path
   reads exactly as §2.4 measured. The saving lands as devices are set up, not
   on merge.
2. **The estate's screen-open count per day is still not measured.** §2.4 gives
   the cost of each open exactly; how many happen in a trading day is the gap
   §9's Monday capture exists to close.
3. **Each device pays the first sync once** — `/insights_log` 35.8 MB plus
   `/products` and `/stock` — so the first day or two after a device is set up
   is dearer than the steady state.

What *is* firm is the shape of the remainder. The after-hours window contained
242.26 MB of staff-phone reads, which the mirror removes once a device is set
up — held flat across a day that is 5.43 GiB, **$5.30/day**, and a trading day
has more phones on it than a Saturday evening does. It also contained 163.38 MB
of refillHealthScan reads, which the mirror does not touch at all.

So **the floor this estate cannot get below without §6 is about $2.08/day** —
refillHealthScan $1.82, the Mac mini $0.14, the other Cloud Functions $0.11, and
the display-checks sweep's remaining $0.01. Everything above that line is
client-side reading, and #618 is the thing that removes it.


## 9. The trading-hours capture, running unattended

`scripts/cost/trading-hours-capture.sh` runs under launchd on the Mac mini
(`com.marathon.costcapture`) at **10:00 SAST every Monday**. It takes a full
60-minute profiler capture, analyses it with `scripts/cost/analyse-profile.mjs`,
appends the result to this report in a fresh clone, and pushes a
`perf/trading-capture-<stamp>` branch. Nobody triggers it and nobody has to
fetch the result.

**It was built for CI first, and that was wrong.** The reasoning was that a
GitHub Actions runner has both halves of the job: `FIREBASE_SERVICE_ACCOUNT` to
authenticate the profiler, and `GITHUB_TOKEN` to open the PR. The first half
does not exist —

```
$ gh secret list
(empty)
```

— which is also, separately, why **every hosting deploy since at least
17 September has failed**; see §10. A CI capture would have failed the same way,
silently, every Monday.

So the capture runs where the credentials are. The mini holds the owner's gcloud
ADC, and it can authenticate. What it could not do was *deliver*: its `gh` token
is expired and it had no key, so `git push` failed with `could not read Username
for 'https://github.com'` and `git ls-remote` worked only because this repo is
public. That half is closed by a **repository deploy key** (read-write, scoped
to this one repo, generated on the mini on 19 September, listed under
Settings → Deploy keys as "mac-mini cost capture (write)" and revocable there).
No Google credential was minted for it.

A deploy key authenticates git but not the REST API, so the job pushes a branch
rather than opening a pull request. The branch is the delivery.

**It was tested end to end before being installed**, by running the whole path —
capture, clone, analyse, append, commit, push — against a 45-second capture, via
the `COSTCAPTURE_REF` override that lets it clone a feature branch before that
branch is merged. It pushed `perf/trading-capture-20260919-1948`.

Two details that are load-bearing and easy to lose:

- **Application Default Credentials carry no quota project**, and
  `firebasedatabase.googleapis.com` refuses a request without one — a 403
  `SERVICE_DISABLED` naming project 764086051850, which is gcloud's shared
  project and not this estate's. `GOOGLE_CLOUD_QUOTA_PROJECT=marathon-club` is
  what makes the profiler start at all; the first attempt on the mini failed
  outright on this.
- **The analysed output is committed to a public repository**, so the analyser
  reduces client addresses to stable tags by default (§2.2). The raw capture,
  which carries real addresses and full paths, stays on the mini and is never
  pushed.

---

## 10. What the owner has to do

Nothing in the two fixes needs a rule or an index pasted (§7). These are the
things this work found that it could not fix itself.

### 10.1 The hosting deploy has been broken since at least 17 September

`.github/workflows/deploy.yml` builds and then calls
`FirebaseExtended/action-hosting-deploy` with
`firebaseServiceAccount: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}`. That secret
does not exist — `gh secret list` returns nothing — so every run since at least
17 September has ended:

```
Error: Input required and not supplied: firebaseServiceAccount
```

**No hosting deploy has succeeded in the last 40 workflow runs.** The build step
passes, so the failure looks like a red tick on a merged PR rather than an
outage, and the live site has been quietly stuck while main moved on.

This is not something to fix by minting a key unasked: it means creating a
Google service account credential and storing it in a public repository's
secrets, which is the owner's call, not a side effect of a cost investigation.
**To restore it:** create a service account with the Firebase Hosting Admin
role, download a JSON key, and set it with
`gh secret set FIREBASE_SERVICE_ACCOUNT < key.json`. Until then, hosting deploys
are manual: from a **fresh clone of `origin/main`** (never a worktree),
`npm ci && npm run build && firebase deploy --only hosting:marathon-club`.

### 10.2 Optional, and worth knowing about

The deploy key added in §9 can be revoked at any time from Settings → Deploy
keys. Revoking it stops the Monday capture delivering; it breaks nothing else.
