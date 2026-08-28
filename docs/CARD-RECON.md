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

Seed with `node scripts/seed-card-terminals.mjs --tid 0000HP1X --mid 000000004977890 --store pe --till till-1 --label "PE Till 1" --execute`.

### `/pos/card_batches/{storeId}/{tid}/{batchKey}`

Append-only, written **only** by the `cardBatchCapture` callable (Admin SDK).
There is no client write rule under `/pos` for this child, so no browser can
create, edit or delete a record. The live `/pos` `.read` already grants
signed-in staff read access — the record carries masked PANs and till takings,
the same sensitivity as `/pos/sales` beside it.

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

### `/pos/card_batch_drafts/{draftId}`

The two-phase handshake: `extract` OCRs the photos, validates, and parks the
parsed slip here (2h TTL, server-written); `submit` promotes the draft verbatim
into `/pos/card_batches`. The review step between the two shows what the OCR
read — it offers **no way to edit a figure**.

### Photos

`cardRecon/{draftId}/photo-{i}.jpg` in the default Storage bucket, written by
the callable with the Admin SDK. A fresh `draftId` per extract means no path is
ever written twice; `storage.rules` has no match for `cardRecon/`, so no client
can write or delete there.

## The rule to paste (console)

`database.rules.json` in this repo is NOT deployed and must not be edited (live
rules drift — see project memory). Paste this in the Firebase console's RTDB
rules editor, **inside the existing `"config"` block**, as a sibling of
`"shopify"` / `"styleCode"` (order inside the block does not matter):

```json
"cardTerminals": {
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

Who may write it: any account whose `stockRole` is `admin` (the same gate as
every other `/config/*` child). Reads need no new rule — `/config` already
grants authenticated, non-anonymous read, which is what the phone screen's till
picker uses. `/pos/card_batches` and `/pos/card_batch_drafts` need **no rule at
all**: with no `.write` anywhere on those children, clients cannot write them,
and the callable writes with the Admin SDK.

## Permission

The phone screen and the callable are both gated by the dedicated
`card_recon` permission (permissions array + `permFlags` mirror, the
`photo_generation` pattern) — **not** on `stockRole`. Granted per-user in User
Management; it is in no role preset.

## What a separate POS-side session does with this

The captured `lines/{tsn}` rows (UTI, RRN, auth code, amount, time) are the
terminal's half of a line-level match against POS card tender legs. Capturing
them accurately — refusing partial capture — is the point of this build; the
matching itself lives in marathon-pos-app.
