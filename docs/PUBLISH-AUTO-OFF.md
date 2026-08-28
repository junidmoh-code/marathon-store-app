# Why published products go OFF by themselves

Investigation, 2026-08-28. Read-only evidence first, then the instrumentation
that stops the question needing an investigation next time.

## The question

Junid reports, from the phone: *products that were published go off by
themselves some time later.* Three candidates were named up front — a
brand-leak compliance scan, stock reaching zero under the storefront inventory
push, and reconciler `desiredState`/`liveState` disagreement.

## Answer, in one line

**A product is switched OFF because it has to be OFF before its listing name
can be changed.** The switch-off is deliberate and correct at the moment it
happens; what makes it look automatic is that nothing records *why* it
happened, nothing says so on the row, and nothing ever switches the product
back on once the rename has landed.

Two of the three candidates are ruled OUT by measurement (below). The third —
"the compliance scan" — is half right: the products taken off on 22 August
were taken off *for a brand-leak reason*, but not by a scan. Their names were
changed, which required them to be off.

## What can write "off" at all

Exhaustive sweep of the codebase, the deployed Cloud Functions and the Mac
mini's launchd agents. Only four paths exist:

| Path | Field written | Actor |
|---|---|---|
| `setDesiredState(pid, node, "off")` — the page's on/off switch | `desiredState: "off"` | a signed-in uid |
| `markBlocked()` — the reconciler's apply-time refusal | `state: "blocked"`, `desiredState: "off"` | `script:reconcile` |
| `confirmLiveState(pid, "off")` — the reconciler applying an off intent | `state: "live"`, `liveState: "off"` | `script:reconcile` |
| a hand-run Admin-SDK script or a console edit | anything | untracked |

There is **no** scheduled job, Cloud Function or trigger anywhere that turns a
product off. `firebase functions:list` carries no Shopify publishing function;
the mini runs exactly three agents (`photograbber`, `shopifyreconcile`,
`socialpublish`) and the only one that touches `/shopify_publish` is
`reconcile-runner.mjs`, which applies intent — it never authors it.

The reconciler's worklist is `desiredState !== confirmed state`. A product that
is live+on with `desiredState: "on"` is **skipped on every tick**. It cannot
drift off on its own.

## Candidate 1 — brand-leak compliance scan: NO SUCH SCAN

No script in the repo, no function, no agent scans live listings for brand
triggers and switches them off. The belief comes from the shape of the 22
August event, which was a name cleanup (below), not a scan.

## Candidate 2 — stock reaching zero: RULED OUT

Measured with `networkTotals()` (the same function the inventory push uses) over
every product taken off in the last two days:

```
n = 18 products    ZERO network stock = 1    POSITIVE stock = 17
```

Sold-out products are not being switched off, and products with 41, 30 and 58
units were. Zero stock is not the cause. (A first pass suggested otherwise and
was wrong: it summed `/stock` cells as numbers when a cell is the
movement-stamped object `{ qty, … }`, and used a guessed location list. The
corrected run is the one above.)

## Candidate 3 — desiredState/liveState disagreement: RULED OUT

Full state histogram of `/shopify_publish` (3,633 nodes):

```
awaiting | –   | –     2370
live     | on  | on     901
blocked  | –   | off    210
live     | off | off    152
```

Every node is self-consistent. There are no `live|on|off` or `live|off|on`
nodes — no disagreement to resolve, and none of the pathological legacy shapes
(`state: live` with no `liveState`) that `normalizedFields` exists to repair.

## What actually happened — the 22 August event, with evidence

`logs/shopify-reconcile.log` on the mini, all times SAST:

```
2026/08/22, 12:56:59  tick — no unapplied intent
2026/08/22, 12:59:01  ── run start ──
2026/08/22, 12:59:01     nodes with unapplied intent: 139
2026/08/22, 12:59:01     ⚠ 139 intents — applying the first 25 only (hard cap)
2026/08/22, 12:59:03     ▶ p1777897007208 → OFF
… 107 products unpublished across the 12:59–13:59 runs …
```

139 off-intents appeared inside one two-minute window. That is a bulk write,
not a person tapping switches.

Eight and a half hours later, `approve-name-proposals.mjs` ran:

```
~/marathon-rollbacks/approve-name-proposals-rollback-1787427445735.json
  104 rows · 97 of them are products from the 12:59 off batch
```

And the names it replaced say exactly what the off was for:

| was | became |
|---|---|
| `Low-top sneaker Drake Palest Purple` | Smooth leather low-top trainer with translucent script midsole |
| `Sneaker Adistar White Black` | Layered stripe mesh runner in white and silver |
| `Sneaker FuelCell Elite Black White` | Matte black mesh marathon trainer with sculpted thick sole |
| `Sneaker Goodyear Blue Orange Black` | Chunky-sole panelled trail sneaker in blue and orange |
| `Sneaker Audyssol Full Black` | Gradient-shroud chunky runner with toggle lacing |

`Drake`, `Adistar`, `FuelCell Elite`, `Goodyear`, `Audyssol` — model and brand
names the lexicon does not catch, sitting on **live public listings**.

The sequence is forced by the code, and every step of it is correct:

1. `approveName()`, `applyNameProposal()` and `approve-name-proposals.mjs` all
   **refuse to rename a product that is ON** (`isOnOrGoingOn`). Renaming a live
   listing changes the handle customers and Google already hold.
2. So the only way to fix a brand-leaking name on a live listing is: switch it
   off → rename → switch it back on.
3. Steps 1 and 2 happened on 22 August. **Step 3 never happened.**

The same shape repeats. On 28 August at 07:19 SAST nine more went off, all
carrying old lexicon names of the same kind — `Low-top sneaker Just Do It White
Denim`, `Sneaker Siempre Familia Orange`, `Sneaker SF Special Field Wheat`,
`Sneaker Brooklyn` — and all nine still hold stock (4, 6, 1, 5, 5, 5, 0, 6, 8
units).

## Why nobody could tell

Two reasons, and both are fixed by the instrumentation below.

**1. The node never records why it went off.** `confirmLiveState` writes
`state`, `liveState`, `updatedAt`, `updatedBy` — and `updatedBy` is the
*reconciler*, because the reconciler wrote last. The person or script that
authored the intent leaves no trace at all.

**2. `updatedBy` is clobbered by unrelated writes.** Every write to
`/shopify_publish` is a whole-node transaction that re-stamps `updatedBy`. Of
the 107 products unpublished on 22 August, 95 now read
`updatedBy: script:approve-name-proposals` — the *rename* that came afterwards,
which had nothing to do with switching them off. That stamp is why the event
was attributed to a compliance scan in the first place.

So the honest answer to "who turned this off, and when, and why" was, until
today, **unrecoverable from the database**. The only evidence left was a log
file on a Mac mini and a rollback file in a home directory.

## What was changed

### An audit record on every transition to off

Every path that can take a product off the storefront now writes, in the same
breath as the state change:

```
/shopify_publish/{pid}/lastOff = {
  at:         <serverNowMs()>,      // server clock, never Date.now()
  actor:      "<uid>" | "script:<name>" | "function:<name>",
  reasonCode: one of OFF_REASONS,
  detail:     one human-readable sentence,
}
/shopify_publish/{pid}/offLog/{at} = the same record   // last 10 kept
```

Reason codes (`src/components/shopify/publishAudit.js` — the one list, shared
by the browser and the Admin-SDK scripts):

| code | meaning |
|---|---|
| `switched_off` | somebody used the on/off switch |
| `off_to_rename` | switched off so the listing name could be changed |
| `publish_cancelled` | a pending publish was cancelled before it went public |
| `reconciler_refused` | the apply-time validator refused — `detail` carries its words |
| `no_shopify_product` | confirmed off because nothing of ours exists on Shopify |
| `cancelled_mid_run` | the intent was withdrawn between validation and publish |
| `script` | an Admin-SDK script; `actor` names which one |

`lastOff` and `offLog` ride the live console rule's `$other: { ".validate":
true }` clause on `/shopify_publish/$pid`, so **no rule change is needed** —
verified against the live rules, not the stale repo copy. The rule that *is*
load-bearing is unchanged: `updatedBy` must equal `auth.uid` for a browser
write, which is why `actor` is a separate field rather than a re-use of it.

### The row says so, in English

A product that is on Shopify but not published now reads, on the list row and
on the product page:

> Taken off the shop on 22 Aug 2026 — switched off so the listing name could be
> changed. Renamed since; ready to publish again.

`describeOff()` in `publishAudit.js` is the single place that sentence is
built. A node with no `lastOff` (everything switched off before today) still
reads honestly: *"Off the shop. It went off before this app started recording
why."*

### The one-way trip is visible

When a product was taken off for a rename and the rename has since landed
(`nameApprovedAt > lastOff.at`), the row says so and offers Publish. Nothing is
switched on automatically — that is the owner's call, and this work does not
move a single live product in either direction.

## Products still off from the 22 August rename, at the time of writing

152 nodes sit at `live | off | off`. The 97 identified above are the rename
batch: renamed on 22 August, never put back. They are now the top of the
**Awaiting review** tab with the reason on the row.
