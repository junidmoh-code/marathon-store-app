# EFT: Standard Bank ATUGAR account (immediate only), and Concrete enforced (2 Nov 2026)

Junid asked for three changes to the live EFT confirmer.

## 1. A second receiving bank: Standard Bank, account ATUGAR TRADING PTY LTD

`EFT_ALLOWED_ACCOUNTS` entries can now carry `:`-tags after the digits:

```
<fnb account>,<fnb account>,<standard bank account>:standardbank:immediate
```

- **Bank tag.** Use `fnb` (the default when no tag is given) or `standardbank`.
  - A payment counts as the shop's only when the destination bank printed on the notice matches the account's bank.
  - Every printed digit of the account number must also match the configured number.
- **The beneficiary name is never read.** "ATUGAR TRADING", "Marathon Club", or whatever the payer typed: none of it can refuse a payment or admit one.
- **Standard Bank names accepted.** These names, exactly: `STANDARD BANK`, `Standard Bank of South Africa (Limited)`, `The Standard Bank of South Africa Limited`, `Standard Bank SA` and `SBSA`.
- **Bad entries are dropped.** An entry with an unknown tag, two banks, or a repeated tag is left out (fail closed).
  - The poller warns about it on every tick, naming the last four digits only.
- **Older builds.** A build from before this change strips the tags and sees the same digits. It refuses the Standard Bank destination at its FNB-only bank check, so it never admits that account at the wrong bank.
- **Grouped account numbers.** The Standard Bank reader also accepts a beneficiary account printed in digit groups ("10 10 000 853 4").
- **Where the value lives.**
  - On the mini: `~/marathon-store-app/.env`.
  - The Secret Manager secret `EFT_ALLOWED_ACCOUNTS`, bound by `eftPoolManualApprove`.
  - This repository is public, so the real numbers never appear in it.

## 2. Immediate payments only into that account

> **Superseded for this account on 8 Nov 2026 (Junid).** The ATUGAR account now confirms non-immediate EFTs under the same date-phased rule as Marathon's FNB account. Its `:immediate` tag stays in `EFT_ALLOWED_ACCOUNTS`; the poller waives it for this account only (`IMMEDIATE_TAG_WAIVED` / `enforcesImmediateOnly` in `eftCore.mjs`). A confirmed payment into it records `immediate` and `paymentType`. Any other account given the tag is still held to it. Section 3 is unchanged.

- **Accounts tagged `immediate`.** A payment into one of these must be IMMEDIATE, whatever its bank date.
  - The date-phased rule says that from 2026-10-27 regular payments are accepted. That rule does **not** apply to these accounts.
  - A regular payment is refused as `refused-not-immediate`. The reason given is "the account it was paid into takes IMMEDIATE payments only".
- **How immediacy is detected.** Each bank's existing signal is used.
  - **Standard Bank:** the whole-line heading "Immediate Payment Confirmation". The footer is never read for this.
  - **Capitec:** "Payment type Immediate Payment".
  - **Absa:** the "Immediate payment" field.
  - **Nedbank:** the channel.
  - **FNB:** its notice proves only FNB-to-FNB transfers, so an FNB notice paying a Standard Bank account is refused.
- **Every other account keeps the date-phased rule.**
- **The owner's proof approval (`eftPoolManualApprove`) is unchanged.** It does not apply immediacy, because nothing floats and Junid attests receipt himself.
  - It now checks a keyed photo against the matched account's own bank.

## 3. Concrete enforces EFT matching

- **Where the setting lives.** The enforced set is the RTDB node `/eft_enforcement`, served by `eftEnforcementStatus`. The tills follow that answer, not their built-in default `["trophy","pe"]`.
  - The live node had `concrete: false`.
  - `scripts/cardrecon/apply-eft-enforcement-concrete-20261102.mjs` flips it to `true`. It merges the way the owner's "set" callable does.
- **The code default is unchanged.** `/eft_enforcement` decides.
- **Known gaps on the POS side.** Both are in marathon-pos-app and are not part of this change.
  - A till that has never loaded the server's answer and is offline falls back to the built-in `["trophy","pe"]`. Every till that has loaded it once keeps it in its cache.
    - The 5-minute breach scan flags any plain-EFT sale at Concrete either way.
  - `functions/eftParked.js` still lists `STORE_IDS = ["pe","pine","trophy"]`. A sale parked at Concrete is therefore not auto-matched by the parked-sale scan, and that store's refresh button answers "That is not a store."
    - Matching at the till and Junid's hand entry both work.
