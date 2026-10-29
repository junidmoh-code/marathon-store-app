# EFT: Absa notices with no transaction number, and the proof-of-payment approval ledger (29 Oct 2026)

Two additions to the EFT confirmer, asked for by Junid on 29 Oct 2026. The
date-phased immediate rule (#805) and every working reader are untouched.

## What was found first

- **Nedbank reader: already exists** (`functions/lib/eft-banks.cjs`, built
  from the five real 27 Oct notices; `eftNedbank.test.mjs`). Nothing added.
- **Absa reader: already existed**, built from the 1 Sep R80 notice, and
  already reads every field Junid listed — "Payment made by", "Payment made
  to", "Beneficiary account number", "Bank branch code", "For the amount of"
  (space-grouped, e.g. `1 900.00`), "Payment date" (day only), "Immediate
  payment" Y/N, "Reference on beneficiary statement". The real notices in the
  pool show **"Transaction number:" blank on some payments** (5, 27, 28, 29
  Oct) and printed on others (1 Sep, 24 Oct, 26 Oct). A blank one left
  `bankRef` null and the payment landed `held-no-bankref` — correct but
  useless: every such payment waited for the owner.

## Build 1 — synthetic identity for Absa, and the collision rule

- `functions/lib/eft-fingerprint.cjs` `absaSyntheticRef` /
  `syntheticIdentityOf`: when, and only when, an **Absa** parse carries no
  bank id, the identity is
  `ABSA|<payer>|<account last 4>|<YYYY-MM-DD>|<cents>|<reference>` (payer and
  reference normalised to A–Z0–9; an empty reference is allowed; no payer,
  day, amount or account → no identity → still `held-no-bankref`).
  `paymentFingerprint` hashes it under a `synthetic` namespace; a printed
  transaction number always wins.
- `eftCore.mjs eftPoolRecord` carries `syntheticRef` on every record that
  carries `bankRef`; refusals claim it exactly as they claim a bank id.
- **Collision rule** (`applyFingerprintHold`): the first notice of an
  identity is confirmed live; a second notice with the same identity is
  **`held-possible-duplicate`** — a new HELD outcome: not spendable, never
  auto-floated, reported REJECTED by the verdict mail, refused by the retry
  script and the settle. The **owner can release it** after checking the
  statement (`eftPoolSettle { action: "releaseHold" }`): the release re-keys
  the synthetic identity (`…|RELEASED:<ms>`) so the record is spendable once
  on a fingerprint of its own, while the base identity stays the first
  record's. A third copy is held against the first again. A transaction-id
  bank's second copy is still `held-duplicate` (final).
- The POS owner panel (`marathon-pos-app src/reports/eftpool/poolText.js`,
  `EftPoolTab.jsx`) renders unknown outcomes as "Could not be read exactly"
  and shows the release button only for `held-no-bankref`. **It needs a row
  label and the release button for `held-possible-duplicate`** — a POS
  change, not made here.

## Build 2 — the manual-approved ledger (`eftPoolManualApprove`)

Owner-only (same `isOwner` lock as the manual entry: admin email on a
verified Google sign-in), `{ entryId, pdfBase64, filename?, note? }`:

1. The PDF is read with `cardRecon/pdfText.js` (bucket grouping, as the
   poller reads EFT PDFs) and the reader its **content** selects
   (`selectReaderByContent`; no sending domain, no DKIM — Junid vouches).
2. Destination checked with the poller's own `destinationVerdict`
   (`functions/lib/eft-destination.cjs`) against the **`EFT_ALLOWED_ACCOUNTS`
   Secret Manager secret** — the same value as the mini's `.env`.
3. Identity = bank transaction id, or Absa's synthetic identity. One pool
   record per identity, key `sha256("eftapproved1|" + fingerprint)`:
   outcome `recorded`, status `used`, `used.outsidePos` by Junid (the
   existing mark-as-used shape), `auth.verdict: "manual-approved"`,
   `manualApproved { by, uid, email, at, note, filename, entryId }`.
4. The fingerprint claim names the approval as **holder and spender**,
   `manualApproved: true`. A later bank notification is filed
   `held-duplicate` with `approvedByHand: <approval key>` (never released);
   the settle's `claimHolderCheck` refuses it as `duplicate-used`.
5. If the bank's record is already in the pool **unused** → refused
   `bank-record-waiting` with its key (use it at the till / mark it used).
   Already used → `already-used`. A **refused** record holding the identity
   → stamped spent by the approval. Same proof twice → `already: true`.
6. `{ action: "list" }` lists `/eft_manual_approvals` (newest first, no
   index needed).

**It floats nothing.** `eftPoolManualEntry` is untouched: floating by hand
stays instant and never needs a proof.

## Shared modules (one copy, two homes)

The readers moved verbatim to `functions/lib/eft-banks.cjs`
(`scripts/cardrecon/eftBanks.mjs` re-exports). `clip`, `parseBankTimestamp`,
`sastDate`, `redactAccountDigits`, `maskAccountValue` → `eft-text.cjs`;
`parseAllowedAccounts`, `destinationVerdict` → `eft-destination.cjs`.
`eftCore.mjs` / `intakeCore.mjs` re-export them; no importer changed.

## Tests

- `scripts/cardrecon/eftAbsaFingerprint.test.mjs` — real 27 Oct R1,900
  notice (sanitised): fields, no invented id, synthetic identity, date-phased
  rule unchanged, first confirms / second held / third held, differing
  amount or day both confirm, owner release re-keys and settles once,
  approved money's later copy (Absa synthetic and Standard Bank id) held.
- `functions/test/eft-manual-approved.test.cjs` — the callable: owner lock,
  input, Absa and Standard Bank proofs, retry, bank-record-waiting /
  already-used / refused-holder, wrong destination, manual float with no
  proof.

## Deploy

    firebase deploy --only functions:eftPoolManualApprove   # new; binds EFT_ALLOWED_ACCOUNTS
    firebase deploy --only functions:eftPoolSettle          # releaseHold accepts held-possible-duplicate
    # the poller: git pull on ~/marathon-store-app, restart com.marathon.cardreconpoll
