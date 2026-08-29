# Card Recon — capturing the FNB batch slip as evidence

Every till has an FNB card terminal. At settlement the terminal prints a Batch
Report: header (MID, TID, batch number `#494`, Opened/Closed/Printed, the
transaction count), a detail roll (one line per transaction: date, time, UTI,
RRN, auth code, TSN, masked PAN, amount) and the totals (purchases, refunds,
TOTAL). This feature photographs that slip, OCRs it server-side, computes what
the POS says the card takings for that till **over the slip's own Opened→Closed
window** should have been, and records both — the variance is the finding.

**The batch window is not a calendar day.** It runs roughly 18:50 → 18:50.
Everything reconciles against the slip's Opened/Closed timestamps.

**Nobody types the card total.** The figure comes from OCR of the terminal's
own printout. There is no input field for it anywhere, by design — a
human-entered total is worthless as evidence.

## Data model

### `/config/cardTerminals/{TID}`

The TID→till registry. The TID printed on the slip is the join key: a slip shot
against the wrong till rejects itself because its TID maps elsewhere, and no
cashier name is ever selected anywhere in the feature.

```json
{ "mid": "000000004977890", "storeId": "pe", "tillId": "till-1", "label": "PE Till 1" }
```

Seed with `node scripts/seed-card-terminals.mjs --tid <TID> [--mid <MID>] --store <pe|pine|trophy> --till <till-N> --label "<label>" --execute`.

**All four terminals, live as of 2026-08-29:**

| TID | MID | store · till | prints |
|---|---|---|---|
| `0000HP1X` | `000000004977890` | pe · till-1 | THE MARATHON |
| `67365901` | `100000001178101` | pe · till-2 | OMARS FASHION |
| `67364485` | `100000001178101` | pine · till-1 | OMARS FASHION |
| `67377843` | *(none printed)* | trophy · till-1 | Marathon Club |

**Three things that table makes unsafe, and one more beside it.** Each is the
kind of assumption a later change makes by accident, so each is pinned by
`functions/test/card-terminal-identity.test.cjs` (6 tests, 5/5 mutations killed):

- **A MID is not unique to a store.** `pe/till-2` and `pine/till-1` share
  `100000001178101` — two different *stores* on one merchant account. Resolving
  a store from a MID would put Pine's takings on a PE till.
- **A MID may not exist.** `trophy/till-1` prints no Merchant line, and is
  registered with **no `mid` key** — not an empty string, not a placeholder.
  Anything that required one would refuse that shop's slips outright. `mid` is
  absent from `KEY_FIELDS`, so an unreadable MID cannot fail a capture either.
- **The trading name identifies nothing.** Three names across four terminals in
  three stores, one of them shared by two stores. It is not in the OCR schema at
  all, and the test refuses to let it in.
- **The TID format is not one thing.** One alphanumeric (`0000HP1X`), three
  8-digit numeric. `normaliseTid` accepts `[A-Z0-9]{4,16}`; nothing narrower.

**Store identity comes from the TID→store map and from nowhere else.** The test
asserts the registry is only ever indexed by a TID, and that no code reads a MID
*off the registry* — which is what any comparison against a slip's MID would
need.

`mid` was already optional in the live rule (`.validate` requires only
`storeId` + `tillId`), so no rule change was needed — verified against the real
rules engine rather than by reading: a MID-less terminal is accepted, a numeric
TID is accepted, a terminal missing `storeId` is still refused, and a non-admin
still cannot write the registry at all.

### `/card_batches/{storeId}/{tid}/{batchKey}`  ·  TOP-LEVEL, owner-only

Append-only: the `cardBatchCapture` callable (Admin SDK) is the only writer,
and its submit transaction refuses to touch an existing key.

**It moved out from under `/pos` on 2026-08-28, and that is the whole point.**
Under `/pos` it inherited that block's `.read` — *any signed-in, non-anonymous
staff member*. These records are investigation material about named staff:
masked PANs, auth codes, RRNs and a per-till variance. Withholding them from
inside `/pos` would have meant rewriting that block's read grant child by child,
which is a shop-stopping risk on a path three shops trade through. At the **top
level no parent grant reaches them at all** — the root carries no `.read`/
`.write`, which the merge script asserts before it will write, because without
that the move would achieve nothing.

The live rule is **owner-only read and write**. The Admin SDK bypasses rules, so
the owner-only `.write` is a belt: the callable is still the only writer.

The old `/pos/card_batches` and `/pos/card_batch_drafts` rules were deliberately
**left in place**, carrying `".write": "false"`. Nothing under `/pos` changed.
Anything still running an old bundle is refused rather than quietly creating a
shadow record under the abandoned path.

#### CLOSED 2026-08-29 — /pos's blanket read was pushed down to its children

Those two entries used to inherit `/pos`'s `.read` — *any signed-in,
non-anonymous staff member* — and no rule under `/pos` could stop it. **RTDB read
and write grants cascade downward and cannot be revoked by a deeper rule**, so
adding `".read": "false"` beside the `".write": "false"` did nothing at all
(verified against the real engine before it was ever applied; the `.write`
denial works only because `/pos` has no `.write` of its own to override).

The fix was to remove the grant rather than try to revoke it: **each child that
needs it now carries the predicate verbatim, `$other` included, and `/pos`'s own
`.read` is gone.** `$other` is what made it safe — one entry covers every
present and future *unnamed* child, so nothing depended on remembering a reader.
The card nodes are explicitly named, so `$other` does not reach them, and they
are dark.

Applied in three stages by `scripts/narrow-pos-read.mjs`, each with the same
fetch → backup → merge → diff → write → re-fetch → verify → restore-on-surprise
method, and each verified before the next:

| stage | what | effect at the time |
|---|---|---|
| 1 | add the six child `.read` grants | **none** — `/pos` still granted; provably inert |
| 2 | delete `/pos`'s `.read` | the behaviour change, one line, revertible |
| 3 | drop the `card_batch_overrides` deep write grant | staff can no longer create an override |

Stage 2 **refuses to run** unless every child that needs a grant already has
one, `$other` included.

**`$other` was doing more work than the six named grants.** Enumerating every
`"pos/<child>"` literal across both repos turns up 14 first-level nodes, and
four of them — `cashups`, `config`, `creditLedger`, `pinAttempts` — have **no
rule of their own at all**. They read entirely through `$other`. Without a
`.read` on it, this change would have taken out the cash-up, the POS config, the
credit ledger behind store credit and on-account, and the PIN throttle, all at
once and only on the shop floor. They are now asserted by name in the probe
rather than trusted to a wildcard nobody checked.

The only referenced node that went dark is `pos/card_batches`, and its remaining
references are two rules-test canaries that *expect* the denial, one comment and
one regex — the real reader moved to top-level `/card_batches` in
marathon-pos-app #272.

#### The third path, also closed

`/pos/card_batch_overrides` had no `.write` of its own; its
`$storeId/$dayYmd/$tillId` rule granted create to any signed-in staff member,
gated only by naming an **active manager** as authoriser. Measured before the
change: a cashier could not self-authorise, but **could** create one naming any
real active manager, **with no approval from that manager**. The gate that
consumed these was deleted in marathon-pos-app #269, so nothing acted on them —
but the path took data.

The deep rule is now removed and the node left named with `".write": "false"`.
Named matters: deleting it outright would drop it back under `/pos/$other`,
which grants write. And the fix could not have been a `".write": "false"`
layered *above* the deep rule — write grants cascade downward too, so a
shallower `false` cannot revoke a deeper grant.

#### And a rule that had never worked now does

`/pos/noReceiptReturns` carried a manager-or-owner `.read` that had never once
applied, masked by the same blanket grant. It applies now. **Nothing broke**,
and that is checked rather than asserted
(`scripts/verify-no-receipt-return-access.mjs`, 6/6 against the live rules):

- the **write** was always manager-or-owner only — a cashier never could, and
  still cannot. Who can *make* a no-receipt return did not move.
- the **read** now matches the write, which is what its author intended.
- the marker still commits inside the multi-path update it rides in.
- and nothing anywhere in either app *reads* that node — it is a write-only
  marker (grepped both repos, including the Cloud Functions).

### How it was measured before it was done

`scripts/probe-pos-read-narrowing.mjs` measured the risk rather than estimating
it, and still runs — now against the live state rather than a candidate. **It
applies nothing.**

It is what turned "re-grant child by child across a block three shops trade
through" into a change with a known blast radius: 14 first-level `/pos` nodes,
enumerated by grepping both repos rather than read off the rules document (which
only lists what somebody thought to name), and every one of them checked. Four
had no rule of their own and read purely through `$other`; one node went dark
and nothing real reads it.

The staged shape is what made it safe to apply at all: stage 1 was provably
inert — both suites came back byte-identical to baseline — so the only step that
could break anything was a single line, with the stage before it already
verified and a backup one PUT away.

**The residual risk that remains**: a child grant does not authorise a read *at*
`/pos` itself, or a listener attached there. Nothing in either repo does that —
both `src/` trees were grepped and the probe asserts the denial — but a caller
outside these two repos would break. There is no such caller today.

### `/card_batches/{storeId}/{tid}/{batchKey}`  ·  TOP-LEVEL, owner-only

Append-only: the `cardBatchCapture` callable (Admin SDK) is the only writer,
and its submit transaction refuses to touch an existing key.

**It moved out from under `/pos` on 2026-08-28, and that is the whole point.**
Under `/pos` it inherited that block's `.read` — *any signed-in, non-anonymous
staff member*. These records are investigation material about named staff:
masked PANs, auth codes, RRNs and a per-till variance. Withholding them from
inside `/pos` would have meant rewriting that block's read grant child by child,
which is a shop-stopping risk on a path three shops trade through. At the **top
level no parent grant reaches them at all** — the root carries no `.read`/
`.write`, which the merge script asserts before it will write, because without
that the move would achieve nothing.

The live rule is **owner-only read and write**. The Admin SDK bypasses rules, so
the owner-only `.write` is a belt: the callable is still the only writer.

The old `/pos/card_batches` and `/pos/card_batch_drafts` rules were deliberately
**left in place**, carrying `".write": "false"`. Nothing under `/pos` changed.
Anything still running an old bundle is refused rather than quietly creating a
shadow record under the abandoned path.

#### CLOSED 2026-08-29 — /pos's blanket read was pushed down to its children

Those two entries used to inherit `/pos`'s `.read` — *any signed-in,
non-anonymous staff member* — and no rule under `/pos` could stop it. **RTDB read
and write grants cascade downward and cannot be revoked by a deeper rule**, so
adding `".read": "false"` beside the `".write": "false"` did nothing at all
(verified against the real engine before it was ever applied; the `.write`
denial works only because `/pos` has no `.write` of its own to override).

The fix was to remove the grant rather than try to revoke it: **each child that
needs it now carries the predicate verbatim, `$other` included, and `/pos`'s own
`.read` is gone.** `$other` is what made it safe — one entry covers every
present and future *unnamed* child, so nothing depended on remembering a reader.
The card nodes are explicitly named, so `$other` does not reach them, and they
are dark.

Applied in three stages by `scripts/narrow-pos-read.mjs`, each with the same
fetch → backup → merge → diff → write → re-fetch → verify → restore-on-surprise
method, and each verified before the next:

| stage | what | effect at the time |
|---|---|---|
| 1 | add the six child `.read` grants | **none** — `/pos` still granted; provably inert |
| 2 | delete `/pos`'s `.read` | the behaviour change, one line, revertible |
| 3 | drop the `card_batch_overrides` deep write grant | staff can no longer create an override |

Stage 2 **refuses to run** unless every child that needs a grant already has
one, `$other` included.

**`$other` was doing more work than the six named grants.** Enumerating every
`"pos/<child>"` literal across both repos turns up 14 first-level nodes, and
four of them — `cashups`, `config`, `creditLedger`, `pinAttempts` — have **no
rule of their own at all**. They read entirely through `$other`. Without a
`.read` on it, this change would have taken out the cash-up, the POS config, the
credit ledger behind store credit and on-account, and the PIN throttle, all at
once and only on the shop floor. They are now asserted by name in the probe
rather than trusted to a wildcard nobody checked.

The only referenced node that went dark is `pos/card_batches`, and its remaining
references are two rules-test canaries that *expect* the denial, one comment and
one regex — the real reader moved to top-level `/card_batches` in
marathon-pos-app #272.

#### The third path, also closed

`/pos/card_batch_overrides` had no `.write` of its own; its
`$storeId/$dayYmd/$tillId` rule granted create to any signed-in staff member,
gated only by naming an **active manager** as authoriser. Measured before the
change: a cashier could not self-authorise, but **could** create one naming any
real active manager, **with no approval from that manager**. The gate that
consumed these was deleted in marathon-pos-app #269, so nothing acted on them —
but the path took data.

The deep rule is now removed and the node left named with `".write": "false"`.
Named matters: deleting it outright would drop it back under `/pos/$other`,
which grants write. And the fix could not have been a `".write": "false"`
layered *above* the deep rule — write grants cascade downward too, so a
shallower `false` cannot revoke a deeper grant.

#### And a rule that had never worked now does

`/pos/noReceiptReturns` carried a manager-or-owner `.read` that had never once
applied, masked by the same blanket grant. It applies now. **Nothing broke**,
and that is checked rather than asserted
(`scripts/verify-no-receipt-return-access.mjs`, 6/6 against the live rules):

- the **write** was always manager-or-owner only — a cashier never could, and
  still cannot. Who can *make* a no-receipt return did not move.
- the **read** now matches the write, which is what its author intended.
- the marker still commits inside the multi-path update it rides in.
- and nothing anywhere in either app *reads* that node — it is a write-only
  marker (grepped both repos, including the Cloud Functions).

### How it was measured before it was done

`scripts/probe-pos-read-narrowing.mjs` measured the risk instead of estimating
it, and still runs — now against the live state rather than a candidate. **It
applies nothing.**

It is smaller than it sounds. `/pos` has 12 children; three already carry their
own `.read`. Six need one added — `sales`, `paymentEvents`, `storeCredits`,
`storeCreditQueue`, `audit`, and **`$other`**. That last one is what removes the
fear: a wildcard can carry a `.read`, so every present and future *unnamed*
child keeps its access from one entry rather than from somebody remembering it.
The three card nodes are explicitly named, so `$other` does not reach them and
they go dark. Verified: 14/14, including a read of an invented future `/pos`
child.

It can also be done in two steps, the first with no effect at all: add the six
`.read` entries (nothing changes, `/pos` still grants), confirm, then delete
`/pos`'s `.read` as a single revertible line.

**One caveat the child-path checks cannot see**: a child `.read` does not
authorise a read *at* `/pos` itself, or a listener attached there. Neither repo
does that today — both `src/` trees were grepped, and the probe asserts the
denial explicitly — but a caller outside these two repos, or a future
whole-block subscription, would break. That is the residual risk in this option,
and it is why the probe stays a probe.

**It has exactly one behavioural consequence beyond closing the residual, and it
is not a break.** `/pos/noReceiptReturns` carries its own `.read` restricting it
to the owner or an **active manager** — and that rule has never done anything.
`/pos`'s broader grant lets every staff member read straight past it, for exactly
the same reason `".read": "false"` on the card nodes would do nothing. Removing
the parent grant makes the restriction its author intended finally apply.

Whether that is wanted is an owner decision, not a technical one — but it should
be a decision rather than a surprise on the day. It is the reason this is still
written down as an option rather than done.

- `batchKey` is the batch number (`"494"`); a **duplicate batch number for the
  same TID is rejected** (same slip shot twice, or a re-print).
- A **correction** is a deliberate re-capture: it lands beside the original at
  `494-r2` (`-r3`, …) carrying `supersedes: "494"`. Both records are kept;
  readers take the highest revision.
- `slip.*` is what the printout said (all integer cents, epoch-ms times, the
  original printed strings kept beside them).
- `lines/{tsn}` is the detail roll — validated for **TSN contiguity** and for
  **line count == the printed Transactions figure** before anything is written.
  A summary-only capture is permitted as a fallback but is flagged
  (`linesCaptured: false`, `lines: null`) so downstream can never imply a
  line-level match ran.
- `expected.*` is computed server-side from `/pos/paymentEvents` (card-method
  legs only, signed, over `[openedAt, closedAt)`) — see
  `functions/lib/card-expected.cjs`. `varianceCents = slip.totalCents −
  expected.cardCents`.
- `cashiers` is derived, read-only: everyone who transacted on that till inside
  the window, with first/last activity times. It comes from the payment-event
  ledger, not from a picker.

### `/card_batch_drafts/{uid}/{draftId}`  ·  TOP-LEVEL, owner-only

The two-phase handshake: `extract` reads the slip (OCR on the photo path,
direct text extraction on the PDF path), validates, and parks the
parsed slip here (2h TTL, server-written, keyed under the submitting uid so
ownership is structural and the per-user expired-draft sweep stays bounded);
`submit` promotes the draft verbatim into `/card_batches`. The review step
between the two shows what the OCR read — it offers **no way to edit a
figure**.

## Two ways in: the PDF and the photos

An FNB terminal can email its batch report as a **PDF**, and that is the fast
path. Photographing the printed slip remains for terminals that cannot email.
A submission is **one or the other, never both** — the callable refuses a
request carrying a PDF and photos together, and the screen enforces the same
rule by disabling whichever input the other has claimed.

`chooseCaptureSource()` in `lib/card-recon.cjs` makes that decision once. Its
answer routes the extract **and** stamps `capturedVia` on the batch record, so
the field the owner reads to tell a PDF batch from a photographed one cannot
drift from the path that actually ran.

### Two PDF formats, not one

A terminal produces its batch figures in two different documents, and both are
now read:

| | terminal's printed slip | bank's emailed banking report |
|---|---|---|
| identity | `TERMINAL ID 0000HP1X`, `Batch Report (#494)` | `Banking Report for Batch 59 of Terminal 67365901`, plus `Merchant:` / `Terminal:` / `Batch:` rows |
| count | `Transactions  2` | `APPROVED TRANSACTIONS` then `Items: 40` |
| amounts | `R50,355.00` | `ZAR 900.00` |
| window | `Opened` / `Closed` printed | **none printed** |
| TSNs | run unbroken | **have gaps, by design** |
| totals | Payment Type Summary | `TOTALS SUMMARY` + `CARD TOTALS`, no PTS |
| rows | date, time, UTI, RRN, auth, TSN, PAN, amount | …TSN, **Batch**, PAN, amount, type |

`detectReportFormat()` decides which before either is read, so a file that is
neither is refused by name rather than by a pile of missing fields.

#### The two checks that had to change

**TSN contiguity is meaningless on a banking report.** The printed roll lists
every attempt, so a gap there means a line was missed — the exact thing this
feature exists to catch. The emailed report lists *approved* transactions only,
so declines and voids leave gaps by design; the real example runs 2, 3, 4, 6, 7,
8 and skips 21–24, 30–31, 33–34 and 43. Applying contiguity would refuse every
emailed report ever sent, so it is skipped for that format and the gaps are
recorded as a warning instead. **Duplicate TSNs are still refused in both** — a
repeat is a mis-parse whatever the format, and means something quite different
from a gap.

**There is no printed window on a banking report.** It carries a print
timestamp and the transaction times, nothing else. The window is therefore
derived — first transaction to last, plus one millisecond so the half-open
`[start, end)` interval contains the last transaction — and `slip.windowSource`
records `"transactions"` rather than `"printed"` so nobody later mistakes a
derived window for a declared one. Nothing is invented: with no transactions
there is no window and the report is refused.

#### The window edge

A printed window has natural slack (the terminal opens the batch before the
first sale and closes it after the last). A derived one has none, so a till leg
written a few seconds either side of the terminal's clock falls outside a window
it plainly belongs to. **The window is not widened to compensate — a fabricated
window is a fabricated variance.** Instead `computeExpectedCard` takes an
`edgeMs`, widens only its *fetch*, and reports card legs for that till sitting
just outside as `expected.nearEdgeLegs` / `nearEdgeCents` plus a warning. They
are never counted in `cardCents`; the reconciled figure is identical whether or
not edge reporting is on, which is pinned by test.

#### The Batch column trap

The emailed row order is `… TSN, Batch, PAN …`. The printed reader takes "the
last bare integer before the PAN" as the TSN, which here would take the *batch
number* off every row — forty identical TSNs and a duplicate refusal. The
layout is therefore settled once for the whole report from evidence, not
position: a real Batch column carries the report's own batch number on **every**
row. One row whose TSN merely coincides with the batch number does not make a
column.

### Why the PDF is read as text and never OCR'd

The text in a PDF is exact. There is nothing to be confident *about*, so the
confidence gate — the only check the photo path applies that this one does not
— is skipped, and `confidence` is recorded as `null` rather than a fabricated
1.0.

**A parse failure is a hard reject with a reason, never a fuzzy second
attempt.** `parseSlipPdf()` refuses by name: it says which field it could not
find, or that a figure "reads `R5O,307.00`, which is not an amount this
understands". Falling back to OCR here would be the one thing worse than
refusing — a figure nobody can vouch for, recorded as a variance against a
named person's till. The refusal tells the manager to photograph the slip
instead, and the photo path is right there below.

Money is parsed from the **whole remainder of the line**, which must parse
entirely or the line is refused. An earlier version captured digits up to the
first bad character and read `R5O,307.00` (letter O) as **R5.00** — silently,
with no warning. That is precisely the failure this design exists to prevent.

### Known limit: two fields on one printed row

`pdfToLines` merges every text fragment sharing a Y coordinate into one line,
and the header patterns anchor each label to the **start** of its row. A slip
that printed two labelled fields side by side —
`MERCHANT ID 000000004977890   TERMINAL ID 0000HP1X` — would therefore be
refused for a missing terminal ID.

Allowing a label after a column gap instead does not work: `tidy` collapses
every run of whitespace to a single space before any pattern runs, and it must,
because `splitTxnMiddle` and `TXN_RE` read a transaction row as single-space
columns. Preserving gaps for the header would break the detail roll.

No slip on file uses that layout. If one turns up, the fix belongs in
`pdfToLines` — split a row at a wide X gap, for header lines only — not in the
patterns. Until then it is a refusal that names the missing field and sends the
manager to the photo path, which reads any layout.

### What is the same on both paths

Every existing refusal, unchanged: unmapped TID, the TID on the slip
disagreeing with the picked till, a duplicate batch number, arithmetic that
does not hold, the line count against the printed Transactions figure, a
window over 7 days, and TSN contiguity where present. A PDF with lines
extracted is **never** `linesCaptured: false` — one file is the whole slip, so
there is no detail/summary split and no summary-only fallback on this path.

`readPdfPayload()` decides whether the file is a PDF at all, on its **magic
bytes** (`%PDF-`) rather than its name, so a renamed photo is refused with a
sentence instead of failing deep inside a parser. Size (10 MB) and base64
integrity are checked in the same seam; the client applies its own payload
pre-flight before the call so an oversized file gets a clean message rather
than a transport error.

### Photos

`cardRecon/{draftId}/photo-{i}.jpg` in the default Storage bucket — and on
the PDF path, `cardRecon/{draftId}/slip.pdf`, the file itself as the evidence.
Both are written by the callable with the Admin SDK. A fresh `draftId` per extract means no path is
ever written twice; `storage.rules` has no match for `cardRecon/`, so no client
can write or delete there.

## The RTDB rules — APPLIED LIVE 2026-08-28

`database.rules.json` in this repo is NOT deployed and must not be edited (the
repo copy is stale; deploying it would regress the live rules — see project
memory). These blocks were merged into the **live** document via the
`.settings/rules.json` REST endpoint with an owner credential: the live rules
were fetched to `rules-live-backup-20260828-182126.json` in this repo, the
three additions merged in, written back, then re-fetched and diffed to prove
nothing else moved.

**Inside `"config"`:**

```json
"cardTerminals": {
  ".read": "auth != null",
  ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && root.child('users').child(auth.uid).child('stockRole').val() === 'admin'",
  "$tid": {
    ".validate": "newData.hasChildren(['storeId','tillId'])",
    "storeId": { ".validate": "newData.isString()" },
    "tillId":  { ".validate": "newData.isString()" },
    "mid":     { ".validate": "newData.isString()" },
    "label":   { ".validate": "newData.isString()" }
  }
}
```

Note the `.read` is `auth != null`, which is **looser than the parent** `/config`
read (`auth != null && non-anonymous`): it lets an anonymously-signed-in client
(the TV board) read the TID→till registry. The registry holds MID/TID/store/till
— no takings, no PANs — but if you want it to match the parent, the one-line
tightening is `".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'"`.

**At the TOP LEVEL** (applied 2026-08-28 by
`scripts/merge-card-recon-top-level-rules.mjs`, which backs up, merges, writes,
re-fetches, verifies `/pos` came out byte-identical, and restores on any
surprise):

```json
"card_batches": {
  ".read":  "auth != null && auth.token.email === 'gunidmoh@gmail.com'",
  ".write": "auth != null && auth.token.email === 'gunidmoh@gmail.com'",
  "$storeId": { "$tid": { ".indexOn": ["slip/closedAt", "batchNo"] } }
},
"card_batch_drafts":    { ".read": "…owner…", ".write": "…owner…" },
"card_batch_overrides": { ".read": "…owner…", ".write": "…owner…" }
```

**This is proved, not asserted.** `scripts/verify-card-recon-node-isolation.mjs`
loads a snapshot of the *live* rules into the real Firebase rules engine and
asks it, as an ordinary signed-in staff account: read `/card_batches` — refused;
read a leaf inside it — refused; write it — refused; all three nodes. The same
token can still read `/pos/sales`, which is what proves the refusals are about
the node and not about the token, and the owner's token is allowed throughout.
16/16. (The RTDB emulator treats any `Authorization: Bearer` header as its admin
bypass and skips rules entirely, so tokens travel as `?auth=` and the script
refuses to report anything until a known-denied write is denied *and* a
known-allowed one is allowed.)

Owner-only read is not a downgrade for anyone: the POS Card recon tab already
sits behind `RequireAdmin`, which is the same single email, so the database rule
and the UI gate now agree. `card_batch_overrides` has no writer at all — the
trading-session gate that wrote it was deleted in marathon-pos-app #269.

**Still under `"pos"`, unchanged and deliberately kept** (siblings of `"sales"` /
`"paymentEvents"` / `"$other"`):

```json
"card_batches": {
  ".write": "false",
  "$storeId": { "$tid": { ".indexOn": ["slip/closedAt", "batchNo"] } }
},
"card_batch_drafts": {
  ".write": "false"
}
```

These are now the ABANDONED paths, and they stay because `".write": "false"`
means an old bundle is refused rather than silently writing a shadow record.
When they were live they mattered for a different reason: the `/pos` rules carry a `"$other"` child
granting **every signed-in staff user write on any unmatched `/pos` child** — so
until these two were named, a cashier could write their own `/pos/card_batches`
record and zero out their own variance. In RTDB, `$other` matches only children
with no explicit sibling rule, so naming them with `".write": "false"` removes
them from that grant and makes them Admin-SDK-only, which is what append-only
evidence requires. Verified in the re-fetched live document: both now sit as
named siblings of `$other`.

The `.indexOn` is what the POS half's two queries need
(`orderByChild("slip/closedAt")` for the range subscription, `orderByChild("batchNo")`
for the revision-completion fetch).

## Permission

The phone screen and the callable are both gated by the dedicated
`card_recon` permission (permissions array + `permFlags` mirror, the
`photo_generation` pattern) — **not** on `stockRole`. Granted per-user in User
Management; it is in no role preset.

## The cross-repo record contract

The captured `lines/{tsn}` rows (UTI, RRN, auth code, amount, time) are the
terminal's half of a line-level match against POS card tender legs. Capturing
them accurately — refusing partial capture — is the point of this build; the
matching itself lives in marathon-pos-app.

The two halves were built by separate sessions, and the POS side read this
record shape while it was still uncommitted and moving. A rename on this side
does not crash anything over there — the field simply reads `undefined`, the
matcher runs with less evidence, and the screen shows a **confident wrong
variance against a named person's till**. So every field the POS half touches
is pinned by `functions/test/card-recon-cross-repo-contract.test.cjs`, with the
POS file that touches it named beside it. Audited against marathon-pos-app
`36bd1df` (PR #265) on 2026-08-28: **no field-name or type drift** — every
field that side reads, this side writes, with matching types and null
semantics.

Two things that are NOT drift but are worth knowing:

- **`expected` / `varianceCents` are recorded here and recomputed there.** The
  POS tab recomputes POS card takings live from `/pos/paymentEvents` rather
  than reading `record.expected.cardCents`. Both use the identical predicate
  (`method === "card"`, same store + till, `at` in `[openedAt, closedAt)`), so
  they agree at capture time — but a leg voided *after* capture moves the
  displayed figure away from the recorded one. The recorded figure is the
  evidence; the live one is the current view. Neither is wrong, and both are
  kept.
- **`cashiers` is recorded here and re-derived there**, under different key
  names (`{uid,name,legs}` here, `{cashierUid,cashierName,movements}` there).
  Nothing reads the recorded copy, so the names cannot collide — but do not
  "fix" one to match the other without changing the reader.

## Access to the slip photos — the custom claim

The slip photos under `cardRecon/**` carry masked PANs, auth codes and RRNs for
every transaction in a batch: investigation material about named staff. Storage
rules cannot read RTDB, so the `card_recon` permission is **mirrored into a
Firebase Auth custom claim** and the Storage rule reads that claim.

- `syncCardReconClaim` (a `/users/{uid}/permFlags/card_recon` write trigger)
  sets `card_recon: true` on grant and **removes the key** on revoke, preserving
  every other claim on the account. It is the only writer of that claim.
- `scripts/backfill-card-recon-claim.mjs` reconciles every existing account in
  both directions (dry run by default).
- A claim reaches a signed-in browser only when its ID token refreshes. The POS
  app watches its own `permFlags.card_recon` and force-refreshes the token the
  moment it changes, so a revoke bites in seconds rather than at token expiry —
  and if the fetch still fails it says *why* (permission removed vs. the rule)
  instead of failing silently.
- Residual: a client that is open but cannot reach the network keeps a valid
  ID token for up to an hour. `admin.auth().revokeRefreshTokens(uid)` closes
  that too, at the cost of signing the account out of every device mid-shift;
  it is deliberately not done automatically.

### The trigger re-reads the flag; it never trusts its own event

The obvious handler mirrors `event.data.after.val()`, and it is wrong in the
one direction that matters. RTDB triggers carry no ordering guarantee between
write events, and `retry: true` — which exists so a revoke is never dropped —
makes late delivery *more* likely:

```
grant fires  → the Auth call fails transiently → queued for retry
revoke fires → succeeds immediately → claim removed        ✔
the retried GRANT finally runs → re-writes card_recon:true ✘   and nothing corrects it
```

So the handler reads `users/{uid}/permFlags/card_recon` at execution time. The
event is a wake-up, not a payload. Every delivery order then converges, because
the last write to the flag always fires a handler that reads the final value.

### No bearer links: the photos are FETCHED, never linked

`getDownloadURL()` is the obvious way to show these and it quietly undoes the
whole gate. It returns a `…?alt=media&token=…` URL, and that token is a **bearer
credential**: every later fetch of it is served *without consulting Security
Rules at all*. Once a permitted viewer opens a batch's evidence panel the URLs
are in their history, their cache and anywhere they paste them — and revoking
the permission, refreshing the token, even `revokeRefreshTokens`, none of it
invalidates a URL already issued. Only deleting the object or rotating its
download-token metadata does, and nothing does that on revoke.

The failure that buys: an investigator opens the batch that implicates them,
keeps the URL, has their permission pulled that afternoon, and reads the masked
PANs and auth codes that evening anyway.

So the POS half uses `getBlob()` — an authenticated GET with rules evaluated on
**every** request — and renders the result as an object URL, which is local to
that document and dies with it. A test refuses `getDownloadURL` anywhere under
`src/reports/cardrecon/`. This needs the bucket's CORS to allow the POS origin;
the config was widened on 2026-08-28 (additively — every previous origin kept)
and backed up to `storage-cors-backup-20260828.json`. Without CORS the fetch
fails and is reported like any other refusal, which is fail-closed.

### Known limits

- The cross-repo contract test is a **point-in-time audit** pinned as a comment
  (`36bd1df`). It catches renames on *this* side. It cannot catch the POS half
  starting to read a field this side does not write — re-audit when that half
  changes.
- `reconcileClaim` is a read-modify-write on custom claims with no
  compare-and-swap. `syncCardReconClaim` is currently the ONLY writer of custom
  claims in either app, which is what makes it safe. A second claim-mirroring
  feature must coordinate through this module or add a CAS.
- The backfill script is therefore also the standing drift check, not only a
  one-time bootstrap.
