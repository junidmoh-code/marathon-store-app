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

Append-only: the `cardBatchCapture` callable (Admin SDK) is the only writer,
and its submit transaction refuses to touch an existing key. No browser can
create, edit or delete a record — `".write": "false"` was applied to the live
rules on 2026-08-28 (see "The RTDB rules" below; before that, the `/pos`
`"$other"` child granted every signed-in user write on this path). The live
`/pos` `.read` grants signed-in staff read access — the record carries masked PANs and till
takings, the same sensitivity as `/pos/sales` beside it.

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

### `/pos/card_batch_drafts/{uid}/{draftId}`

The two-phase handshake: `extract` OCRs the photos, validates, and parks the
parsed slip here (2h TTL, server-written, keyed under the submitting uid so
ownership is structural and the per-user expired-draft sweep stays bounded);
`submit` promotes the draft verbatim into `/pos/card_batches`. The review step
between the two shows what the OCR read — it offers **no way to edit a
figure**.

### Photos

`cardRecon/{draftId}/photo-{i}.jpg` in the default Storage bucket, written by
the callable with the Admin SDK. A fresh `draftId` per extract means no path is
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

**Inside `"pos"`, as siblings of `"sales"` / `"paymentEvents"` / `"$other"`:**

```json
"card_batches": {
  ".write": "false",
  "$storeId": { "$tid": { ".indexOn": ["slip/closedAt", "batchNo"] } }
},
"card_batch_drafts": {
  ".write": "false"
}
```

This is the block that mattered. The live `/pos` rules carry a `"$other"` child
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
