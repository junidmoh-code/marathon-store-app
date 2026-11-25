// ─── PER-BANK PAYMENT-NOTIFICATION READERS (PURE) ────────────────────────────
// The notification is sent by the PAYER'S bank, not the shop's — a customer
// paying from Standard Bank produces a Standard Bank email, a Capitec customer
// a Capitec one — and every bank lays its notification out differently. So the
// readers are PER FORMAT, exactly the way the slip parsers already are
// (functions/lib/card-recon-pdf.cjs: detectReportFormat → parsePrintedSlip /
// parseEmailedReport): detect which bank's document this is from its CONTENT,
// then read it with that bank's reader, and an unrecognised format is a CLEAN
// REFUSAL that stores the raw text and names the sending domain — never a
// guess, because a wrong amount here eventually releases stock.
//
// ADDING A BANK IS ADDING A READER to EFT_READERS — detect() + parse() built
// against a REAL notification from the mailbox, with that notification's
// extracted lines pinned as a fixture. Refusals are EXPECTED to be the common
// case until the formats accumulate; each refusal record carries everything
// needed to write the missing reader.
//
// The first reader, Standard Bank, is built from the real R100 test payment of
// 2026-08-30 ("Payment confirmation 4401", PaymentConfirmation.pdf) — the
// notification body itself says only "please open the attached PDF file"; the
// PDF carries every field.
//
// PURE by the house rule: no IMAP, no pdfjs, no fetch, no clock. The poller
// extracts PDF text lines (borrowing functions/cardRecon/pdfText.js, the same
// extraction the slip path trusts) and hands them here as data.
//
// ONE COPY, TWO HOMES (29 Oct 2026). This file was scripts/cardrecon/eftBanks.mjs
// until eftPoolManualApprove — the owner registering a payment from an
// UPLOADED proof of payment, in Cloud Functions — needed the very same readers
// (a second copy of a reader is a second place for a wrong amount to come
// from). Cloud Functions deploy only functions/, so the readers moved here as
// CommonJS, and scripts/cardrecon/eftBanks.mjs re-exports them unchanged:
// every reader, fixture and test is exactly what it was.
"use strict";

const { clip, parseBankTimestamp, redactAccountDigits } = require("./eft-text.cjs");
// The fuzzed money parser, borrowed — never a second copy.
const { parseRandsToCents } = require("./card-recon.cjs");
// The shared label-driven extractor: asked ONLY for a field a reader's own
// rule did not find (25 Nov 2026, eft-labels.cjs).
const { labelledField, flatLine, fieldsSummary } = require("./eft-labels.cjs");

// A bank's own transaction id, for a reader other than Capitec's: never a
// per-DOCUMENT code (Capitec's SkyQR / Unique Document No.).
// Same line only: a blank id (Absa prints "Transaction number:" empty) must
// stay blank — its synthetic identity depends on it — never the next line.
const BANK_ID_ONLY = { excludeLabels: ["skyqr reference", "unique document no"], nextLine: false };
// The bare "amount" / "date" labels never stand in for a reader's own
// (a fee line, a letter's date): only the specific synonyms do.
const FALLBACK_EXCLUDE = { amount: ["amount"], date: ["date"] };
/**
 * A reader's own value, else the shared extractor's — never instead of one
 * the reader read, never past a contradiction the reader refused.
 * @returns {{ok:true, value:any} | {ok:false, why:string}}
 */
function orShared(own, lines, field, opts = {}) {
  if (!own.ok || (own.value !== null && own.value !== undefined && own.value !== "")) return own;
  // A reader whose OWN label is the bare one (Capitec prints "Amount") may
  // let the shared form read it with any whitespace (allowGeneric).
  const excludeLabels = [...(opts.excludeLabels ?? []), ...(opts.allowGeneric ? [] : FALLBACK_EXCLUDE[field] ?? [])];
  const shared = labelledField(lines, field, { ...opts, excludeLabels });
  return shared.ok ? { ok: true, value: shared.value } : shared;
}

/**
 * ONE labelled line, exactly. Standard Bank prints "Label value" with no
 * colon; a label that appears twice with DIFFERENT values is a contradiction
 * and refuses (a repeat of the same value is not).
 * @returns {{ok:true, value:string|null} | {ok:false, why:string}}
 */
function labelledLine(lines, re, what) {
  const values = [...new Set(lines.map((l) => re.exec(l)?.[1]?.trim()).filter(Boolean))];
  if (values.length > 1) return { ok: false, why: `the ${what} appears ${values.length} times with different values` };
  return { ok: true, value: values[0] ?? null };
}

// ─── WHICH BANK ISSUED THIS — FROM STRONG EVIDENCE (25 Nov 2026) ─────────────
// Each reader's detect() was keyed on ONE layout's phrases (a heading, a
// sentence, a label). Capitec reworded its notification ("…has made an
// immediate payment, which is intended to reflect instantly in the
// beneficiary's account." instead of "…made a payment to your account") and
// a genuine proof Junid uploaded was refused as "no reader". A layout tweak
// must not dead-end a real payment, so a reader ALSO claims a document when
// the issuing bank is proved by what every bank prints in its legal footer —
// its company registration number, its FSP number, its own client-care
// domain — and the document says money was paid and labels an amount and an
// account. Never the metadata title, never a bare bank name: "Standard Bank"
// on a Capitec notice is the DESTINATION bank, not the issuer.
//
// THIS ONLY CHOOSES THE READER. Nothing about what is accepted changes: the
// reader still has to read every required field exactly, the destination is
// still checked digit for digit, the transaction id is still the identity,
// and in the poller the sender's DKIM domain must still be this bank's.
// Evidence for TWO banks is a document nobody claims (as two layout matches
// already are). A refusal word anywhere ("unsuccessful", "could not be
// processed", "reversed", …) and the evidence path claims nothing.
const BANK_EVIDENCE = {
  standardbank: [/\b1962\/000738\/06\b/, /\bstandardbank\.co\.za\b/i],
  fnb: [/\b1929\/001225\/06\b/, /\bfnb\.co\.za\b/i, /\bFSP\s*(?:No\.?\s*)?3071\b/i],
  capitec: [/\b1980\/003695\/06\b/, /\bcapitecbank\.co\.za\b/i, /\bFSP\s*(?:No\.?\s*)?46669\b/i, /\bCapitec Bank Limited\b/i],
  absa: [/\b1986\/004794\/06\b/, /\babsa\.co\.za\b/i],
  nedbank: [/\b1951\/000009\/06\b/, /\bnedbank\.co\.za\b/i],
};
const MONEY_IN = [
  /\bmade (?:an? )?(?:immediate |instant |real[- ]time )?payment\b/i,
  /\bpayment has been made\b/i,
];
const NOT_MONEY_IN = /\b(?:unsuccessful|could not be (?:processed|paid|made)|was not (?:processed|paid|made)|failed|declined|reversed|reversal|cancell?ed|returned|recalled|rejected|insufficient funds)\b/i;
const AMOUNT_LABEL = /^(?:payment |transaction |transfer )?amount(?: paid)?\s*(?::|\s|$)|^for the amount of\b|^cur\/amount\b/i;
const ACCOUNT_LABEL = /^(?:beneficiary |recipient )?account (?:number|no\.?)\b|^recipient\/account no\b/i;
const flat = (l) => String(l ?? "").replace(/[\u00a0\u2007\u2009\u202f\t]/g, " ").replace(/ {2,}/g, " ").trim();

/** The banks whose legal footer this document carries (ids, possibly several). */
function banksEvidencedBy(lines) {
  const text = (Array.isArray(lines) ? lines : []).map(flat).join("\n");
  return Object.keys(BANK_EVIDENCE).filter((id) => BANK_EVIDENCE[id].some((re) => re.test(text)));
}

/**
 * Does the document prove it was issued by `bankId` and say money came in?
 * Evidence for exactly this one bank, a money-in sentence, no refusal word,
 * and a labelled amount and account.
 */
function evidenceClaims(bankId, lines) {
  if (!Array.isArray(lines) || !lines.length) return false;
  const banks = banksEvidencedBy(lines);
  if (banks.length !== 1 || banks[0] !== bankId) return false;
  const flatLines = lines.map(flat);
  const prose = flatLines.join(" ");
  if (!MONEY_IN.some((re) => re.test(prose)) || NOT_MONEY_IN.test(prose)) return false;
  return flatLines.some((l) => AMOUNT_LABEL.test(l)) && flatLines.some((l) => ACCOUNT_LABEL.test(l));
}

// ─── STANDARD BANK ───────────────────────────────────────────────────────────
// Real layout (fixture in eftBanks.test.mjs, sanitised of personal data):
//   We confirm that the following payment has been made into your account from J SOAP:
//   Reference number 4140542552          ← the BANK's transaction id
//   Beneficiary name ATUGAR TRADING
//   Bank name FIRST NATIONAL BANK        ← the DESTINATION bank (ours)
//   Beneficiary account number XXXXXXXXXXXX6625   ← MASKED — tail digits only
//   Beneficiary branch number 25065500
//   Beneficiary reference OM82           ← what the PAYER typed — the matching key
//   Amount R100.00
//   Payment date and time 2026-08-30 23h48
//
// IMMEDIATE OR NOT — THE DOCUMENT'S HEADING, NOTHING ELSE (fix 7b, Junid,
// 25 Oct 2026, from the real R710 payment of 2026-10-25):
//   Dear MARATHON CLUB
//   Immediate Payment Confirmation       ← the heading: immediate
//   We confirm that the following payment has been made into your account from …
// A non-immediate payment's heading is plain "Payment Confirmation" (Junid's
// spec — no real non-immediate sample with a heading exists yet; the older
// Aug–Oct layout printed no heading at all, and still refuses).
//
// THE FOOTER IS NEVER READ FOR THIS. Every Standard Bank confirmation, of any
// type, ends with "Immediate payments may take a few hours." / "Non-immediate
// payments … up to 24 hours" / "… three business days". The word "immediate"
// anywhere in the document would therefore pass a scheduled payment. Only a
// line that IS the heading — the whole line, nothing else on it — counts, and
// it must stand above the "We confirm …" sentence, where the heading is.
// No heading, two different headings, a heading merged into another line by
// the PDF extraction, the sentence printed more than once, or a heading line
// anywhere BELOW the sentence: `immediate` is null, and the pool refuses (eftCore
// immediacyVerdict) — EXCEPT a Standard Bank notice paying a Standard Bank
// account with no heading or a clean one: same-bank, accepted as immediate
// (6 Nov 2026, immediacyVerdict); an out-of-shape heading still refuses. The reader only ever runs on a message that passed DKIM
// for standardbank.co.za (email-poller.mjs), so the heading is the bank's.
const SB_HEADINGS = [
  { re: /^immediate payment confirmation$/i, immediate: true, label: "Immediate Payment Confirmation" },
  { re: /^payment confirmation$/i, immediate: false, label: "Payment Confirmation" },
];
const SB_CONFIRM_SENTENCE = /payment has been made into your account/i;

/** @returns {{immediate:boolean|null, paymentType:string|null}} */
function standardBankHeading(lines) {
  const norm = (l) => String(l ?? "").replace(/\s+/g, " ").trim();
  const sentences = lines.filter((l) => SB_CONFIRM_SENTENCE.test(l)).length;
  if (sentences !== 1) return { immediate: null, paymentType: null };
  const sentenceAt = lines.findIndex((l) => SB_CONFIRM_SENTENCE.test(l));
  const isHeading = (l) => SB_HEADINGS.find((x) => x.re.test(norm(l)));
  // A heading below the confirmation is not where Standard Bank puts one: a
  // second page, a quoted copy — refuse rather than pick.
  if (lines.slice(sentenceAt + 1).some(isHeading)) return { immediate: null, paymentType: "heading below the confirmation" };
  const above = lines.slice(0, sentenceAt);
  // "Immediate" on its own line just above "Payment Confirmation" is a heading
  // the extraction may have split — or may not. Unreadable, never guessed
  // either way. (Spec review.)
  if (above.some((l, i) => i > 0 && SB_HEADINGS[1].re.test(norm(l)) && /^immediate$/i.test(norm(above[i - 1])))) {
    return { immediate: null, paymentType: "heading split across lines" };
  }
  const found = new Set(above.map(isHeading).filter(Boolean));
  if (found.size !== 1) return { immediate: null, paymentType: found.size ? "contradictory headings" : null };
  const [h] = found;
  return { immediate: h.immediate, paymentType: h.label };
}

const standardBank = {
  id: "standardbank",
  domain: "standardbank.co.za",
  /** Content, not sender: the header block plus the confirmation sentence. */
  detect(lines) {
    const has = (re) => lines.some((l) => re.test(l));
    return has(/payment has been made into your account/i)
      && has(/^Beneficiary account number\s+/i)
      && has(/^Amount\s+/i);
  },
  /**
   * @returns {{ok:true, amountCents, reference, payer, bankTs, bankRef,
   *            beneficiaryName, destBankName, accountMask}
   *          |{ok:false, reason:string}}
   */
  parse(lines) {
    const take = (re, what) => labelledLine(lines, re, what);

    // ONE PAYMENT PER DOCUMENT, COUNTED ON RAW LINES. labelledLine dedupes
    // identical values to tolerate repeated page headers — which would also
    // silently collapse TWO IDENTICAL PAYMENTS (same amount, same reference:
    // routine when a customer pays twice) into one recorded payment. A reprint
    // and a genuine double are indistinguishable from here, so more than one
    // payment block refuses and a person decides.
    // (Independent adversarial review, v2.)
    const blocks = lines.filter((l) => /^Beneficiary account number\s+/i.test(l)).length;
    if (blocks > 1) {
      return { ok: false, reason: `This document holds ${blocks} payment blocks — a reprint and two identical payments cannot be told apart here. Handle it by hand.` };
    }

    // THE AMOUNT — required, exact, single.
    const amount = orShared(take(/^Amount\s+(.+)$/i, "Amount line"), lines, "amount");
    if (!amount.ok) return { ok: false, reason: `Standard Bank notification: ${amount.why}.` };
    if (amount.value === null) return { ok: false, reason: "Standard Bank notification carries no Amount line." };
    const amountCents = parseRandsToCents(amount.value);
    if (amountCents === null) {
      return { ok: false, reason: `Standard Bank Amount line reads "${clip(amount.value, 60)}", which does not parse exactly as a rand amount.` };
    }
    if (amountCents <= 0) return { ok: false, reason: "The amount is zero or negative — not an incoming payment." };

    // THE DESTINATION ACCOUNT — required: the allowlist check depends on it,
    // and a notification that stops printing it must refuse loudly rather
    // than sail past the one check that keeps other people's payments out.
    // One token ("XXXXXXXXXXXX6625", "10100008534") — or an all-digit number
    // printed in groups, the way Standard Bank prints its own account numbers
    // ("10 10 000 853 4"); the spaces never reach a check (digits only).
    const account = orShared(take(/^Beneficiary account number\s+(\S+|\d+(?: \d+)+)\s*$/i, "Beneficiary account number"), lines, "account");
    if (!account.ok) return { ok: false, reason: `Standard Bank notification: ${account.why}.` };
    if (account.value === null) return { ok: false, reason: "No Beneficiary account number could be read from this Standard Bank notification (the line may be absent, or merged with another column) — the destination account cannot be checked." };

    // "Beneficiary reference" is what the PAYER typed — the future matching
    // key. "Reference number" is the bank's own transaction id; the two are
    // deliberately kept apart.
    const reference = orShared(take(/^Beneficiary reference\s+(.+)$/i, "Beneficiary reference"), lines, "reference");
    if (!reference.ok) return { ok: false, reason: `Standard Bank notification: ${reference.why}.` };
    const bankRef = orShared(take(/^Reference number\s+(.+)$/i, "Reference number"), lines, "txnId", BANK_ID_ONLY);
    if (!bankRef.ok) return { ok: false, reason: `Standard Bank notification: ${bankRef.why}.` };
    const beneficiaryName = orShared(take(/^Beneficiary name\s+(.+)$/i, "Beneficiary name"), lines, "beneficiary");
    const destBankName = orShared(take(/^Bank name\s+(.+)$/i, "Bank name"), lines, "destBank");

    // "…payment has been made into your account from J SOAP:" — the payer,
    // in prose. Optional: a payment with no payer line still lands.
    const payer = labelledLine(lines, /payment has been made into your account from\s+(.+?):?\s*$/i, "payer sentence");

    // "Payment date and time 2026-08-30 23h48" — parseBankTimestamp knows the
    // 23h48 shape. The parse still succeeds without it, but since fix 8 the
    // date GATES the money: a null bankTs refuses downstream as
    // refused-stale-date (eftCore.paymentDateVerdict), never carried by
    // receivedAt.
    const when = orShared(labelledLine(lines, /^Payment date and time\s+(.+)$/i, "Payment date and time"), lines, "date");
    const bankTs = when.ok && Number.isInteger(when.value) ? when.value
      : when.ok && when.value ? parseBankTimestamp(when.value) : null;

    // Fix 7b: immediate only by the heading (standardBankHeading, above).
    const { immediate, paymentType } = standardBankHeading(lines);

    return {
      ok: true,
      amountCents,
      reference: clip(reference.value, 140),
      payer: payer.ok && payer.value ? clip(redactAccountDigits(payer.value), 120) : null,
      bankTs,
      bankRef: clip(bankRef.value, 60),
      beneficiaryName: beneficiaryName.ok ? clip(beneficiaryName.value, 120) : null,
      destBankName: destBankName.ok ? clip(destBankName.value, 60) : null,
      accountMask: clip(account.value, 40),
      paymentType,
      immediate,
    };
  },
};

// ─── FNB ─────────────────────────────────────────────────────────────────────
// Built from the real payment notification of 2026-08-31 10:11 (refused-parse
// record in /eft_pool — the refusal's stored raw text IS this reader's
// specification; fixture pinned in eftBanks.test.mjs, digits sanitised).
//
// FNB's PDF is TWO COLUMNS, and pdfText's Y-grouping interleaves them: some
// labels carry their value inline ("Trace ID : 5TG59DVQ", "Payment From X"),
// but the right column's values land on the line BEFORE their label —
//
//   10:11:39            ← the value…
//   Time Actioned :     ← …of this label
//   MR M                ← the value…
//   Reference :         ← …of this label
//   ZAR30.00            ← the value…
//   Cur/Amount          ← …of this label
//
// so this reader reads a label's value inline when present, and from the
// PREVIOUS line when the label line is bare — refusing if that previous line
// looks like another label (a layout this has never seen must refuse, never
// guess; a wrong amount here eventually releases stock).
const FNB_LABELISH = /.+\s:\s*$|.+\s:\s.+/;
function fnbLabelValue(lines, re, what) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    let value = (m[1] ?? "").trim();
    if (!value) {
      // Bare label: the value is the previous line — unless that line is
      // itself a label, which means the layout shifted. null value; the
      // caller decides whether that refuses.
      const prev = (lines[i - 1] ?? "").trim();
      value = prev && !FNB_LABELISH.test(prev) ? prev : "";
    }
    if (value) hits.push(value);
  }
  const distinct = [...new Set(hits)];
  if (distinct.length > 1) return { ok: false, why: `the ${what} appears ${distinct.length} times with different values` };
  return { ok: true, value: distinct[0] ?? null };
}

// FNB prints values ABOVE their labels in its right column, so the shared
// extractor's next-line form would read the WRONG field: same-line only.
const FNB_SHARED = { nextLine: false };

const fnb = {
  id: "fnb",
  domain: "fnb.co.za",
  /** Content, not sender: FNB's own title block and the two-column amount label. */
  detect(lines) {
    const has = (re) => lines.some((l) => re.test(l));
    return has(/NOTIFICATION OF PAYMENT/i)
      && has(/First National Bank hereby confirms/i)
      && has(/Cur\/Amount/i);
  },
  parse(lines) {
    // ONE payment per document, counted on the bank's own transaction id.
    const traces = lines.filter((l) => /^Trace ID\s*:/i.test(l)).length;
    if (traces > 1) {
      return { ok: false, reason: `This document holds ${traces} Trace ID lines — more than one payment per document cannot be read safely. Handle it by hand.` };
    }

    // THE AMOUNT — the money-only line the Cur/Amount label points at.
    // Required, exact, single: every line that is nothing but a currency
    // amount must agree, because a second different one is a layout this
    // reader does not understand.
    //
    // PAYSHAP (real notice of 7 Nov 2026, R650 into Concrete's Standard Bank
    // account): FNB's PayShap notification prints the label and the amount
    // on ONE line — "Cur/Amount R650.00" — so there is no lone money line and
    // the reader refused a genuine payment. The value on a "Cur/Amount" line
    // counts as an amount line too; it must be money-only, and it joins the
    // same must-all-agree set, so a second different figure still refuses.
    const MONEY = /^(?:ZAR|R)\s?\d[\d,\s]*(?:\.\d{1,2})?$/;
    const moneyLines = [];
    for (const raw of lines) {
      const l = raw.trim();
      if (MONEY.test(l)) { moneyLines.push(l); continue; }
      const inline = /^Cur\/Amount\s*:?\s*(.+)$/i.exec(l);
      if (!inline) continue;
      const value = inline[1].trim();
      if (!MONEY.test(value)) {
        return { ok: false, reason: `FNB amount line reads "${clip(l, 60)}", which does not parse exactly as a rand amount.` };
      }
      moneyLines.push(value);
    }
    // Distinct by VALUE, not spelling: "R650.00" and "ZAR650.00" are one amount.
    const amounts = [...new Set(moneyLines.map((l) => parseRandsToCents(l)))];
    if (!moneyLines.length) {
      // No lone figure and no Cur/Amount line: a labelled amount on ONE line
      // ("Amount : R650.00") is the only other shape accepted.
      const shared = labelledField(lines, "amount", { ...FNB_SHARED, excludeLabels: ["amount"] });
      if (!shared.ok) return { ok: false, reason: `FNB notification: ${shared.why}.` };
      if (shared.value !== null) moneyLines.push(String(shared.value).replace(/[\u00a0\u202f\u2009]/g, " ").trim());
    }
    if (!moneyLines.length) return { ok: false, reason: "FNB notification carries no amount line (a lone ZAR figure)." };
    if (amounts.length > 1) return { ok: false, reason: `FNB notification carries ${amounts.length} different amount lines — cannot tell which is the payment.` };
    const amountCents = parseRandsToCents(moneyLines[0]);
    if (amountCents === null) {
      return { ok: false, reason: `FNB amount line reads "${clip(moneyLines[0], 60)}", which does not parse exactly as a rand amount.` };
    }
    if (amountCents <= 0) return { ok: false, reason: "The amount is zero or negative — not an incoming payment." };

    // THE DESTINATION ACCOUNT — required: the allowlist check depends on it.
    const account = orShared(fnbLabelValue(lines, /^Recipient\/Account no\s*:\s*(.*)$/i, "Recipient/Account no"), lines, "account", FNB_SHARED);
    if (!account.ok) return { ok: false, reason: `FNB notification: ${account.why}.` };
    if (!account.value) return { ok: false, reason: "No Recipient/Account no could be read from this FNB notification — the destination account cannot be checked." };

    // Reference is what the PAYER typed (right column, value-above-label);
    // optional — some customers type none, and the pool's amount search
    // exists for exactly that.
    const reference = orShared(fnbLabelValue(lines, /^Reference\s*:\s*(.*)$/i, "Reference"), lines, "reference", FNB_SHARED);
    if (!reference.ok) return { ok: false, reason: `FNB notification: ${reference.why}.` };
    const bankRef = orShared(fnbLabelValue(lines, /^Trace ID\s*:\s*(.*)$/i, "Trace ID"), lines, "txnId", { ...FNB_SHARED, ...BANK_ID_ONLY });
    if (!bankRef.ok) return { ok: false, reason: `FNB notification: ${bankRef.why}.` };
    const payer = fnbLabelValue(lines, /^Payment From\s+(.+)$/i, "payer line");

    // "Date Actioned : 2026/08/31" inline; the time is the value-above-label
    // of "Time Actioned :". The parse still succeeds if the pair does not
    // read, but since fix 8 the date GATES the money: a null bankTs refuses
    // downstream as refused-stale-date, never carried by receivedAt.
    const date = fnbLabelValue(lines, /^Date Actioned\s*:\s*(.*)$/i, "Date Actioned");
    const time = fnbLabelValue(lines, /^Time Actioned\s*:\s*(.*)$/i, "Time Actioned");
    const timeOk = time.ok && time.value && /^\d{2}:\d{2}(?::\d{2})?$/.test(time.value);
    const bankTs = date.ok && date.value
      ? parseBankTimestamp(timeOk ? `${date.value} ${time.value}` : date.value)
      : null;

    return {
      ok: true,
      amountCents,
      reference: reference.value ? clip(reference.value, 140) : null,
      payer: payer.ok && payer.value ? clip(redactAccountDigits(payer.value), 120) : null,
      bankTs,
      bankRef: bankRef.value ? clip(bankRef.value, 60) : null,
      beneficiaryName: (() => { const n = fnbLabelValue(lines, /^Name\s*:\s*(.*)$/i, "Name"); return n.ok && n.value ? clip(n.value, 120) : null; })(),
      destBankName: (() => { const b = fnbLabelValue(lines, /^Bank\s*:\s*(.*)$/i, "Bank"); return b.ok && b.value ? clip(b.value, 60) : null; })(),
      accountMask: clip(account.value, 40),
      // Only a PayShap notice says anything about speed (fnbPayShap, below);
      // an ordinary FNB notice leaves immediate unset, as it always has.
      ...(fnbPayShap(lines) ? { paymentType: "PayShap", immediate: true } : {}),
    };
  },
};

// PAYSHAP IS REAL-TIME, AND FNB SAYS SO IN ITS OWN WORDS (7 Nov 2026). A
// PayShap notification carries FNB's sentence "Please note that this PayShap
// Payment Notification cannot be authenticated using our FNB “Verify
// Payments” link, however, as PayShap payments are made in real time, …" —
// where an ordinary notification says "To authenticate this Payment
// Notification, please visit …". PayShap is the interbank rapid-payment
// rail: it settles in seconds, so it is an IMMEDIATE payment whichever bank
// it pays into (Junid: "it's an immediate payment, I did receive the money").
//
// Read ONLY directly below the ONE "END OF NOTIFICATION" line: everything the
// payer can type (their name, the reference) is printed above it, so a
// reference cannot pose as FNB's sentence. The whole two-line sentence must
// be there as FNB prints it, and the ordinary notice's "To authenticate this
// Payment Notification" must not. No END line, two END lines, or anything
// out of shape: no PayShap — never assumed.
/**
 * Does this FNB notice carry FNB's own PayShap sentence below END OF NOTIFICATION?
 * @param {(string|null|undefined)[]} lines the document's text lines
 * @returns {boolean}
 */
function fnbPayShap(lines) {
  const trimmed = lines.map((l) => String(l ?? "").trim());
  // Exactly ONE end line: a second (a payer-typed "END OF NOTIFICATION")
  // would move the boundary into text the payer controls. (Sonnet review.)
  const ends = trimmed.reduce((acc, l, i) => (/^END OF NOTIFICATION$/i.test(l) ? [...acc, i] : acc), []);
  if (ends.length !== 1) return false;
  // The ordinary notice's own sentence means it is NOT a PayShap notice.
  if (trimmed.some((l) => /^To authenticate this Payment Notification\b/i.test(l))) return false;
  // FNB's full two-line sentence, directly below the end line, as printed:
  //   "Please note that this PayShap Payment Notification cannot be
  //    authenticated using our FNB “Verify Payments” link, however, as
  //    PayShap payments are made in"
  //   "real time, to verify this payment please check …"
  const first = trimmed[ends[0] + 1] ?? "";
  const second = trimmed[ends[0] + 2] ?? "";
  return /^Please note that this PayShap Payment Notification cannot be authenticated\b.*\bas PayShap payments are made in$/i.test(first)
    && /^real time, to verify this payment\b/i.test(second);
}

// ─── CAPITEC ─────────────────────────────────────────────────────────────────
// Built from a REAL Capitec "Payment Notification" PDF (fixture in
// eftBanks.test.mjs, sanitised). Layout, verbatim from pdfText:
//
//   Payment Notification
//   SkyQR reference: 504f-614a-494a          ← IGNORED, deliberately; see below
//   Capitec Bank
//   31/08/2026
//   Please take note that Sicelo made a payment to your account. …
//   Notification number 599784               ← the BANK's own id
//   Payment date 20/04/2026 10:15            ← DAY-FIRST
//   Beneficiary name Marathon
//   Bank name First National Bank            ← the DESTINATION bank (ours)
//   Account number 62903776625               ← UNMASKED; see below
//   Branch 250655
//   Payment type Immediate Payment
//   Amount R750.00
//   Payment reference S MKHUMBUZI            ← what the PAYER typed
//
// THE QR CODE IS IGNORED, AND THAT IS A SECURITY DECISION, not an omission.
// The document carries a "SkyQR reference" whose code links to Capitec's site.
// Following a link out of a document to confirm the payment it describes would
// mean letting the document vouch for itself — a forged PDF would carry a
// forged link. Origin is proved by ONE thing here and it happens before any of
// this runs: Gmail's DKIM verdict on the message, checked against the bank's
// own domain (eftCore.mjs, authVerdict). Nothing in a document body ever
// vouches for it, so the QR line is read as text and used for nothing.
//
// CAPITEC PRINTS THE DESTINATION ACCOUNT IN FULL, where Standard Bank and FNB
// print it masked. Nothing special happens here: the reader returns what the
// document says and the pool masks it on the way in (maskAccountValue keeps
// four digits), and the stored raw text is struck out by redactAccountDigits.
// The allowlist check only ever compares the last four either way.
//
// THE DATE IS DAY-FIRST. "20/04/2026" is 20 April: SA convention, and this
// document's own header prints "31/08/2026", which can only be day-first. That
// is converted here into the ISO shape parseBankTimestamp already accepts
// rather than teaching the shared parser a shape whose meaning depends on
// which bank printed it — the ambiguous half of the year (04/05) would then be
// read day-first for every bank, including any that prints month-first.
// SINCE FIX 8 THE DATE GATES THE MONEY (eftCore.paymentDateVerdict refuses a
// payment the bank dates before the cutoff), so day-first is a load-bearing
// assumption here, pinned by eftBanks.test.mjs on this document's own
// "31/08/2026" header: a month-first Capitec layout would have to be a new
// reader built from a real sample, never a guess. A date that will not parse
// leaves bankTs null and the payment refuses downstream as refused-stale-date;
// receivedAt never stands in for it.
const CAPITEC_DAY_FIRST = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}:\d{2}(?::\d{2})?))?$/;
function capitecTimestamp(value) {
  const m = CAPITEC_DAY_FIRST.exec(String(value ?? "").trim());
  if (!m) return null;
  const [, dd, mm, yyyy, time] = m;
  // parseBankTimestamp does the rest of the validating — including refusing a
  // phantom date like 31/02, which it catches by round-tripping.
  return parseBankTimestamp(`${yyyy}-${mm}-${dd}${time ? ` ${time.slice(0, 5)}` : ""}`);
}

// THE SKYQR LAYOUT (real proof, 24 Nov 2026 — fixture in
// eftReaderRobust.test.mjs, sanitised). Capitec's newer notification:
//
//   Payment Notification
//   Capitec Bank Limited
//   SkyQR reference: 4000-4000-4a00          ← the transaction id (see below)
//   Please note that M SOAP has made an immediate payment, which is intended to reflect
//   instantly in the beneficiary's account.
//   Beneficiary Name concerte
//   Account Number 10100008534               ← UNMASKED, as before
//   Bank Standard Bank                       ← the DESTINATION bank
//   Payment Date 24/11/2026 12:34            ← DAY-FIRST, as before
//   Amount R15 050.00                        ← space thousands separator
//   Reference M SOAP                         ← what the PAYER typed
//   Unique Document No.: 0000…-…0000 / 903 / V2.0 - 01/11/2024
//
// THE TRANSACTION ID. The older layout's "Notification number" stays the id
// wherever it is printed — nothing about those documents changes, and their
// SkyQR line is still read as nothing. This layout prints no notification
// number, so its id is the SkyQR reference, else the Unique Document No.'s
// leading code. The code is used as TEXT, an identifier, exactly as a
// notification number was; the QR's link is still never followed — a
// document never vouches for itself.
// KNOWN LIMIT (review of #995): both codes are per DOCUMENT. If Capitec ever
// issued the payer's proof and the beneficiary's email of ONE payment with
// different codes, the fingerprint would not link them (two numbers are two
// payments — the house rule, eft-linked-copies.cjs); the copies would then be
// caught only by the owner's review. The real proof and email are expected
// to be one document; revisit with a real pair if that ever proves false.
function capitecBankRef(lines) {
  const notification = labelledLine(lines, /^Notification number\s+(.+)$/i, "Notification number");
  if (!notification.ok || notification.value) return notification;
  // Only the SkyQR layout falls back to its document codes: an OLDER-layout
  // notice that lost its notification number stays id-less (held-no-bankref
  // in the poller), exactly as before. (Architect review of #995.)
  if (lines.some((l) => /made a payment to your account/i.test(String(l ?? "")))) return notification;
  // Only the two Capitec ids qualify here — never a generic label.
  const flatLines = lines.map(flatLine);
  const skyOnly = labelledLine(flatLines,
    /^SkyQR reference\s*:?\s*([A-Za-z0-9][A-Za-z0-9-]{3,59})\s*$/i, "SkyQR reference");
  if (!skyOnly.ok || skyOnly.value) return skyOnly;
  const doc = labelledLine(flatLines,
    /^Unique Document No\.?\s*:?\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i, "Unique Document No.");
  return doc;
}

// The SkyQR layout's sentence: "Please note that <PAYER> has made an immediate
// payment, which is intended to reflect instantly in the beneficiary's
// account." Read on the joined prose (the extraction wraps it). IMMEDIATE ONLY
// BY THE BANK'S OWN PHRASE: the phrase must appear exactly once, it must end
// its sentence with nothing saying "has made" after it, and the payer's name
// in front of it may not itself carry "payment" or "made" — so a name cannot
// pose as the bank's words. Anything else: not immediate (null).
function capitecSkyQrSentence(lines) {
  // POSITION-BOUND (architect review of #995): the bank's sentence stands
  // ABOVE the payment details. Only the lines before the first labelled
  // payment field are read — the payer-typed "Reference" (and every other
  // field) sits below and can never supply the phrase.
  const DETAIL = /^(?:beneficiary details|payment details|beneficiary name|account number|bank\b|payment date|amount\b|reference\b)/i;
  const firstDetail = lines.findIndex((l) => DETAIL.test(flatLine(l)));
  const head = firstDetail === -1 ? lines : lines.slice(0, firstDetail);
  const prose = head.map((l) => String(l ?? "").replace(/[\u00a0\u2007\u2009\u202f\t]/g, " ")).join(" ").replace(/ {2,}/g, " ");
  const phrase = /which is intended to reflect instantly in the beneficiary['’‘`]?s account/gi;
  if ((prose.match(phrase) || []).length !== 1) return { payer: null, immediate: false };
  const m = /Please note that (.{1,120}?) has made an immediate payment, which is intended to reflect instantly in the beneficiary['’‘`]?s account/i.exec(prose);
  if (!m || /payment|\bmade\b/i.test(m[1])) return { payer: null, immediate: false };
  // The bank's phrase ENDS its sentence, and nothing after it says "has
  // made" again: a name that carried the whole phrase would leave the
  // bank's own (different) verb after it, and is refused here.
  const rest = prose.slice(m.index + m[0].length);
  if (!/^\s*\./.test(rest) || /\bhas made\b/i.test(rest)) return { payer: null, immediate: false };
  return { payer: m[1].trim(), immediate: true };
}

const capitec = {
  id: "capitec",
  domain: "capitecbank.co.za",
  /** Content, not sender: the title, the confirmation sentence, and the
   *  labelled amount. All three, so a Capitec statement or a marketing letter
   *  carrying the bank's name claims nothing. */
  detect(lines) {
    const has = (re) => lines.some((l) => re.test(l));
    return has(/^Payment Notification$/i)
      && has(/made a payment to your account/i)
      && has(/^Amount\s+/i);
  },
  parse(lines) {
    const take = (re, what) => labelledLine(lines, re, what);

    // ONE PAYMENT PER DOCUMENT, counted on the bank's own notification number
    // — the same rule the other two readers keep, and for the same reason: a
    // reprint and two identical payments are indistinguishable from here, so
    // more than one block refuses and a person decides.
    const blocks = lines.filter((l) => /^Notification number\s+/i.test(l)).length;
    if (blocks > 1) {
      return { ok: false, reason: `This document holds ${blocks} payment blocks — a reprint and two identical payments cannot be told apart here. Handle it by hand.` };
    }

    // THE AMOUNT — required, exact, single.
    const amount = orShared(take(/^Amount\s+(.+)$/i, "Amount line"), lines, "amount", { allowGeneric: true });
    if (!amount.ok) return { ok: false, reason: `Capitec notification: ${amount.why}.` };
    if (amount.value === null) return { ok: false, reason: "Capitec notification carries no Amount line." };
    const amountCents = parseRandsToCents(amount.value);
    if (amountCents === null) {
      return { ok: false, reason: `Capitec Amount line reads "${clip(amount.value, 60)}", which does not parse exactly as a rand amount.` };
    }
    if (amountCents <= 0) return { ok: false, reason: "The amount is zero or negative — not an incoming payment." };

    // THE DESTINATION ACCOUNT — required: the allowlist check depends on it,
    // and a notification that stops printing it must refuse loudly rather than
    // sail past the one check that keeps other people's payments out.
    const account = orShared(take(/^Account number\s+(\S+)\s*$/i, "Account number"), lines, "account");
    if (!account.ok) return { ok: false, reason: `Capitec notification: ${account.why}.` };
    if (account.value === null) return { ok: false, reason: "No Account number could be read from this Capitec notification (the line may be absent, or merged with another column) — the destination account cannot be checked." };

    // "Payment reference" is what the PAYER typed — the matching key.
    // "Notification number" is Capitec's own id; kept apart, like Standard
    // Bank's two references.
    // The SkyQR layout (25 Nov 2026) prints plain "Reference".
    const reference = orShared(take(/^Payment reference\s+(.+)$/i, "Payment reference"), lines, "reference");
    if (!reference.ok) return { ok: false, reason: `Capitec notification: ${reference.why}.` };
    const bankRef = capitecBankRef(lines);
    if (!bankRef.ok) return { ok: false, reason: `Capitec notification: ${bankRef.why}.` };
    const beneficiaryName = orShared(take(/^Beneficiary name\s+(.+)$/i, "Beneficiary name"), lines, "beneficiary");
    // The SkyQR layout prints "Bank Standard Bank" — the shared extractor's
    // "bank" label, asked only when "Bank name" is absent.
    const destBankName = orShared(take(/^Bank name\s+(.+)$/i, "Bank name"), lines, "destBank");

    // "Please take note that Sicelo made a payment to your account." — the
    // payer, in prose. Optional: a payment with no payer line still lands.
    // The SkyQR layout: "Please note that M SOAP has made an immediate payment, …".
    const skyqr = capitecSkyQrSentence(lines);
    let payer = labelledLine(lines, /take note that\s+(.+?)\s+made a payment to your account/i, "payer sentence");
    if (payer.ok && !payer.value && skyqr.payer) payer = { ok: true, value: skyqr.payer };

    const when = orShared(take(/^Payment date\s+(.+)$/i, "Payment date"), lines, "date", { dayFirst: true });
    const bankTs = when.ok && Number.isInteger(when.value) ? when.value
      : when.ok && when.value ? capitecTimestamp(when.value) : null;

    // "Payment type Immediate Payment" (fix 7b). Exactly that phrase is
    // immediate; any other type printed is not; an absent or contradictory
    // line is unknown (null) — the pool refuses unknown, never assumes.
    // The SkyQR layout prints no type line; its sentence says so instead
    // (capitecSkyQrSentence — the BANK's phrase, never the payer's name).
    const type = take(/^Payment type\s+(.+)$/i, "Payment type");
    let paymentType = type.ok && type.value ? clip(type.value, 60) : null;
    let immediate = paymentType === null ? null : /^immediate payment$/i.test(paymentType);
    if (type.ok && type.value === null && skyqr.immediate) { paymentType = "Immediate Payment"; immediate = true; }

    return {
      ok: true,
      amountCents,
      reference: clip(reference.value, 140),
      payer: payer.ok && payer.value ? clip(redactAccountDigits(payer.value), 120) : null,
      bankTs,
      bankRef: clip(bankRef.value, 60),
      beneficiaryName: beneficiaryName.ok ? clip(beneficiaryName.value, 120) : null,
      destBankName: destBankName.ok ? clip(destBankName.value, 60) : null,
      accountMask: clip(account.value, 40),
      paymentType,
      immediate,
    };
  },
};

// ─── ABSA ────────────────────────────────────────────────────────────────────
// Built from the REAL R80 payment of 2026-09-01 (the owner paid the shop from
// his own Absa account to produce the format). Layout, verbatim from pdfText:
//
//   Notice of Payment
//   Please be advised that MR JM ATUGAR made a payment to your account …
//   Transaction number: 80D2F2AB5A-1        ← the BANK's own id
//   Payment date:                           ← BARE label…
//   2026-09-01                              ← …value on the NEXT line
//   Payment made by: MR JM ATUGAR           ← inline value
//   Payment made to:
//   Marathon club
//   Beneficiary bank name: FIRST NATIONAL BANK
//   Beneficiary account number: 62903776625 ← UNMASKED, like Capitec's
//   Bank branch code: 250655
//   For the amount of: 80.00                ← NO currency mark
//   Immediate payment:
//   N
//   Reference on beneficiary statement: test  ← what the PAYER typed
//
// TWO LAYOUTS IN ONE DOCUMENT, and that is the whole difficulty. Some labels
// carry their value after the colon; others are bare, with the value on the
// FOLLOWING line. It is FNB's problem mirrored — FNB's bare labels take the
// line BEFORE, Absa's take the line AFTER — so it gets its own reader rather
// than a shared one that would have to guess which direction a bank means.
// A bare label whose next line is itself a label reads as ABSENT, never as
// that label's text: a layout this has never seen must refuse, not guess.
//
// THE AMOUNT CARRIES NO "R". parseRandsToCents accepts a bare figure ("80.00")
// and still refuses anything mangled — the currency mark is optional there,
// never skipped over, so "USD 80.00" would still refuse rather than read as
// eighty rand.
//
// "Immediate payment: N" says the money may only land by midnight rather than
// at once. Junid decided (fix 7b) that only an immediate payment may become a
// spendable record, so the reader returns it as `immediate` and the pool
// refuses anything not immediate (eftCore.mjs immediacyVerdict) — for a
// payment the bank dates before 2026-10-27 only (date-phased, 27 Oct 2026).
//
// "Transaction number:" IS SOMETIMES BLANK (real notices of 5, 27, 28 and
// 29 Oct 2026 — R10, R1,900, R1,000, R610; the 1 Sep, 24 Oct and 26 Oct
// notices printed one). The bare label is then followed by the next label,
// so absaLabelValue reads it as ABSENT and bankRef is null — the reader does
// not invent an id. The POOL gives such a notice a synthetic identity from
// what IS printed (payer, account, day, amount, reference: eftCore
// syntheticIdentityOf → functions/lib/eft-fingerprint.cjs absaSyntheticRef)
// and holds a second notice with the same identity for the owner. The amount
// is printed space-grouped above a thousand ("1 600.00", "1 000.00" — real
// 24 and 28 Oct notices), which parseRandsToCents reads exactly; the payment
// date is a day only, no time of day, and there is no running balance.
// THE PAYER'S OWN COPY (7 Nov 2026, the real R3950 of MRS CJ DELPAUL, txn
// 80856A…, ibreply@absa.co.za, DKIM pass). Absa also sends the PAYER's
// "Notice of Payment" — the one a payer has Absa e-mail to the shop. Same
// labels, same values, two differences, verbatim (digits sanitised):
//
//   Dear MRS A PAYER                         ← the payer (no "Payment made by:")
//   Subject: Notice Of Payment: SHOP NAME
//   Please be advised that you made a payment to SHOP NAME as indicated below.
//   Transaction number: 80000000A0-34
//   Payment date:
//   2026-11-07
//   Payment made from: Ultimate Plus         ← the payer's account product
//   Payment made to:
//   SHOP NAME
//   Beneficiary bank name: FIRSTRAND …
//
// It is read by the same reader: the destination account is still checked
// digit for digit, the transaction number is still the identity, and the
// payer is the "Dear …" line — read ONLY in this variant (the beneficiary's
// copy greets the SHOP there).
const ABSA_PAYER_COPY = /^Please be advised that you made a payment to .+ as indicated below\.?$/i;
const ABSA_LABELISH = /.+:\s*$|.+:\s.+/;
function absaLabelValue(lines, re, what) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    let value = (m[1] ?? "").trim();
    if (!value) {
      // Bare label: the value is the NEXT line — unless that line is itself a
      // label, which means the layout shifted.
      const next = (lines[i + 1] ?? "").trim();
      value = next && !ABSA_LABELISH.test(next) ? next : "";
    }
    if (value) hits.push(value);
  }
  const distinct = [...new Set(hits)];
  if (distinct.length > 1) return { ok: false, why: `the ${what} appears ${distinct.length} times with different values` };
  return { ok: true, value: distinct[0] ?? null };
}

const absa = {
  id: "absa",
  domain: "absa.co.za",
  /** Content, not sender: Absa's own title, the confirmation sentence and the
   *  labelled amount. All three, so an Absa statement or a fee letter carrying
   *  the bank's name claims nothing. */
  detect(lines) {
    const has = (re) => lines.some((l) => re.test(l));
    return has(/^Notice of Payment$/i)
      && (has(/made a payment to your account/i) || has(ABSA_PAYER_COPY))
      && has(/^For the amount of:/i);
  },
  parse(lines) {
    const take = (re, what) => absaLabelValue(lines, re, what);

    // ONE PAYMENT PER DOCUMENT, counted on the bank's own transaction number —
    // the same rule the other readers keep: a reprint and two identical
    // payments are indistinguishable from here, so more than one refuses.
    const blocks = lines.filter((l) => /^Transaction number:/i.test(l)).length;
    if (blocks > 1) {
      return { ok: false, reason: `This document holds ${blocks} payment blocks — a reprint and two identical payments cannot be told apart here. Handle it by hand.` };
    }

    // THE AMOUNT — required, exact, single.
    const amount = orShared(take(/^For the amount of:\s*(.*)$/i, "amount line"), lines, "amount");
    if (!amount.ok) return { ok: false, reason: `Absa notification: ${amount.why}.` };
    if (amount.value === null) return { ok: false, reason: "Absa notification carries no amount line." };
    const amountCents = parseRandsToCents(amount.value);
    if (amountCents === null) {
      return { ok: false, reason: `Absa amount line reads "${clip(amount.value, 60)}", which does not parse exactly as a rand amount.` };
    }
    if (amountCents <= 0) return { ok: false, reason: "The amount is zero or negative — not an incoming payment." };

    // THE DESTINATION ACCOUNT — required: the allowlist check depends on it.
    const account = orShared(take(/^Beneficiary account number:\s*(.*)$/i, "Beneficiary account number"), lines, "account");
    if (!account.ok) return { ok: false, reason: `Absa notification: ${account.why}.` };
    if (!account.value) return { ok: false, reason: "No Beneficiary account number could be read from this Absa notification — the destination account cannot be checked." };

    // "Reference on beneficiary statement" is what the PAYER typed — the
    // matching key. "Transaction number" is Absa's own id; kept apart.
    const reference = orShared(take(/^Reference on beneficiary statement:\s*(.*)$/i, "Reference on beneficiary statement"), lines, "reference");
    if (!reference.ok) return { ok: false, reason: `Absa notification: ${reference.why}.` };
    let bankRef = orShared(take(/^Transaction number:\s*(.*)$/i, "Transaction number"), lines, "txnId", BANK_ID_ONLY);
    // A blank number whose next line is a bare WORD ("Details") is still
    // blank: an Absa transaction number carries a digit. (Architect review
    // of #995 — the word would have become every such notice's identity.)
    if (bankRef.ok && bankRef.value && !/\d/.test(bankRef.value)) bankRef = { ok: true, value: null };
    if (!bankRef.ok) return { ok: false, reason: `Absa notification: ${bankRef.why}.` };
    const beneficiaryName = take(/^Payment made to:\s*(.*)$/i, "Payment made to");
    const destBankName = take(/^Beneficiary bank name:\s*(.*)$/i, "Beneficiary bank name");
    let payer = take(/^Payment made by:\s*(.*)$/i, "Payment made by");
    // The payer's own copy names no "Payment made by:" — the payer is the
    // addressee. Only when the document says it is that copy, and only when
    // exactly one greeting line is printed.
    if (payer.ok && !payer.value && lines.some((l) => ABSA_PAYER_COPY.test(l))) {
      // A generic greeting names nobody (architect review): never a payer.
      const greetings = lines.map((l) => /^Dear\s+(.{2,120})$/i.exec(l.trim())?.[1]?.trim())
        .filter((g) => g && !/^(customer|client|sir|madam|sir\/madam|valued customer)\b/i.test(g));
      payer = { ok: true, value: new Set(greetings).size === 1 ? greetings[0] : null };
    }

    // "Payment date:" then "2026-09-01" — a shape parseBankTimestamp already
    // knows. The parse still succeeds if it will not read, but since fix 8
    // the date GATES the money: a null bankTs refuses downstream as
    // refused-stale-date, never carried by receivedAt.
    const when = orShared(take(/^Payment date:\s*(.*)$/i, "Payment date"), lines, "date");
    const bankTs = when.ok && Number.isInteger(when.value) ? when.value
      : when.ok && when.value ? parseBankTimestamp(when.value) : null;

    // "Immediate payment:" then "Y"/"N" on the next line (fix 7b). The real
    // R80 sample printed "N" (normal clearing — by midnight); "Y" is the
    // field's other value. Anything else, or no line, is unknown (null).
    const imm = take(/^Immediate payment:\s*(.*)$/i, "Immediate payment");
    const paymentType = imm.ok && imm.value ? clip(imm.value, 20) : null;
    const immediate = paymentType === null ? null
      : /^(y|yes)$/i.test(paymentType) ? true
      : /^(n|no)$/i.test(paymentType) ? false
      : null;

    return {
      ok: true,
      amountCents,
      reference: reference.value ? clip(reference.value, 140) : null,
      payer: payer.ok && payer.value ? clip(redactAccountDigits(payer.value), 120) : null,
      bankTs,
      bankRef: bankRef.value ? clip(bankRef.value, 60) : null,
      beneficiaryName: beneficiaryName.ok && beneficiaryName.value ? clip(beneficiaryName.value, 120) : null,
      destBankName: destBankName.ok && destBankName.value ? clip(destBankName.value, 60) : null,
      accountMask: clip(account.value, 40),
      paymentType,
      immediate,
    };
  },
};

// ─── NEDBANK ─────────────────────────────────────────────────────────────────
// Built from the five REAL Nedbank notifications of 2026-10-27 (11:19–11:30
// SAST, "Nedbank" <Notification@nedbank.co.za>, DKIM pass for nedbank.co.za).
// The email BODY says only "A payment has been made to your account. To view
// the details of the payment, please open the attached PDF file." — it carries
// no amount, account or id, and never claims anything here (no detect() match).
// EVERY FIELD IS IN THE ATTACHED Proof_Of_Payment.pdf. Layout, verbatim from
// pdfText (fixture in eftNedbank.test.mjs, sanitised):
//
//   Notification of Payment
//   Nedbank Limited confirms that the following payment has been made:
//   Date of Payment : 27/10/2026             ← DAY-FIRST, date only, no time
//   Reference Number : 388e74ec-4314-…       ← the BANK's own transaction id
//   Beneficiary details
//   Recipient : Marathon
//   Amount : R350.00
//   Recipient Reference : Ricardo            ← what the PAYER typed
//   :                                        ← the second column's colons,
//   Bank FIRST NATIONAL BANK                 ←  split off their labels by
//   :                                        ←  the extraction: "Bank",
//   Account Number ...776625                 ←  "Account Number" and "Channel"
//   :                                        ←  read with or without one
//   Channel Internet payment                 ← how it was paid (see below)
//   Payer details
//   Paid from Account Holder : A CUSTOMER
//   …
//   Payments may take up to three business days. Please check your account
//   to verify the existence of the funds.    ← the FOOTER, on every copy
//   Security Code D6CA…                      ← differs per copy; never read
//
// The four 11:19–11:29 copies were ONE payment resent (same Reference Number,
// amount and reference, a fresh Security Code each time); 11:30 was another.
//
// IMMEDIATE OR NOT — THE "Channel" LINE, NEVER THE FOOTER. Every real sample
// so far prints "Channel Internet payment" — a normal interbank EFT, which
// Nedbank's own footer says "may take up to three business days" and tells
// the recipient to check the account for. That is not money received, so it
// reads immediate:false and the pool refuses it (eftCore immediacyVerdict),
// exactly as Absa "Immediate payment: N" does. "Channel Immediate payment"
// reads immediate:true — the phrase Capitec prints; no real Nedbank immediate
// sample exists yet, so it is the one value accepted on spec, and a sample
// that prints anything else refuses as unreadable until a reader is taught it.
// Any other channel ("App payment", "Branch", …) is unknown: null, refused.
// Like Standard Bank's, the footer is the same on every copy and is never read.
// DATE-PHASED SINCE 27 OCT 2026: the channel decides only for a payment the
// bank dates before 2026-10-27; from that date an "Internet payment" is
// accepted (eftCore immediacyVerdict).
//
// THE DATE IS DAY-FIRST and carries no time: "27/10/2026" can only be 27 Oct.
// capitecTimestamp already reads that shape exactly (and refuses 31/02); a
// date-only bankTs is the start of that SAST day, which is what the cutoff
// (fix 8) compares, and a payment dated beyond the next business day after its
// notification arrived refuses as scheduled (immediacyVerdict; a weekend
// payment dated Monday settles then — 7 Nov 2026).
const NEDBANK_CHANNELS = [
  { re: /^internet payment$/i, immediate: false },
  { re: /^immediate payment$/i, immediate: true },
];

const nedbank = {
  id: "nedbank",
  domain: "nedbank.co.za",
  /** Content, not sender: the title, Nedbank's confirmation sentence and the
   *  labelled amount. The generic email body matches none of them. */
  detect(lines) {
    const has = (re) => lines.some((l) => re.test(l));
    return has(/^Notification of Payment$/i)
      && has(/Nedbank Limited confirms that the following payment has been made/i)
      && has(/^Amount\s*:/i);
  },
  parse(lines) {
    const take = (re, what) => labelledLine(lines, re, what);

    // ONE PAYMENT PER DOCUMENT, counted on the bank's own Reference Number —
    // the rule every reader keeps: a reprint and two identical payments are
    // indistinguishable from here, so more than one block refuses.
    const blocks = lines.filter((l) => /^Reference Number\s*:/i.test(l)).length;
    if (blocks > 1) {
      return { ok: false, reason: `This document holds ${blocks} payment blocks — a reprint and two identical payments cannot be told apart here. Handle it by hand.` };
    }

    // THE AMOUNT — required, exact, single.
    const amount = orShared(take(/^Amount\s*:\s*(.+)$/i, "Amount line"), lines, "amount");
    if (!amount.ok) return { ok: false, reason: `Nedbank notification: ${amount.why}.` };
    if (amount.value === null) return { ok: false, reason: "Nedbank notification carries no Amount line." };
    const amountCents = parseRandsToCents(amount.value);
    if (amountCents === null) {
      return { ok: false, reason: `Nedbank Amount line reads "${clip(amount.value, 60)}", which does not parse exactly as a rand amount.` };
    }
    if (amountCents <= 0) return { ok: false, reason: "The amount is zero or negative — not an incoming payment." };

    // THE DESTINATION ACCOUNT — required: the allowlist check depends on it.
    // Printed masked ("...776625"); destinationVerdict checks every digit shown.
    const account = orShared(take(/^Account Number\s*:?\s*(\S+)\s*$/i, "Account Number"), lines, "account");
    if (!account.ok) return { ok: false, reason: `Nedbank notification: ${account.why}.` };
    if (account.value === null) return { ok: false, reason: "No Account Number could be read from this Nedbank notification (the line may be absent, or merged with another column) — the destination account cannot be checked." };

    // THE BANK'S OWN ID — required here, not just for the hold: without it a
    // resend could not be told from a second payment.
    const bankRef = orShared(take(/^Reference Number\s*:\s*(.+)$/i, "Reference Number"), lines, "txnId", BANK_ID_ONLY);
    if (!bankRef.ok) return { ok: false, reason: `Nedbank notification: ${bankRef.why}.` };
    // "Recipient Reference" is what the PAYER typed — the matching key.
    const reference = orShared(take(/^Recipient Reference\s*:\s*(.*)$/i, "Recipient Reference"), lines, "reference");
    if (!reference.ok) return { ok: false, reason: `Nedbank notification: ${reference.why}.` };
    const beneficiaryName = take(/^Recipient\s*:\s*(.+)$/i, "Recipient");
    const destBankName = take(/^Bank\s*:?\s+(.+)$/i, "Bank");
    const payer = take(/^Paid from Account Holder\s*:\s*(.+)$/i, "Paid from Account Holder");

    const when = orShared(take(/^Date of Payment\s*:\s*(.+)$/i, "Date of Payment"), lines, "date", { dayFirst: true });
    const bankTs = when.ok && Number.isInteger(when.value) ? when.value
      : when.ok && when.value ? capitecTimestamp(when.value) : null;

    const channel = take(/^Channel\s*:?\s+(.+)$/i, "Channel");
    const paymentType = channel.ok && channel.value ? clip(channel.value, 60) : null;
    const known = paymentType === null ? null : NEDBANK_CHANNELS.find((c) => c.re.test(paymentType.replace(/\s+/g, " ")));
    const immediate = known ? known.immediate : null;

    return {
      ok: true,
      amountCents,
      reference: reference.value ? clip(reference.value, 140) : null,
      payer: payer.ok && payer.value ? clip(redactAccountDigits(payer.value), 120) : null,
      bankTs,
      bankRef: bankRef.value ? clip(bankRef.value, 60) : null,
      beneficiaryName: beneficiaryName.ok && beneficiaryName.value ? clip(beneficiaryName.value, 120) : null,
      destBankName: destBankName.ok && destBankName.value ? clip(destBankName.value, 60) : null,
      accountMask: clip(account.value, 40),
      paymentType,
      immediate,
    };
  },
};

// ─── THE REGISTRY ────────────────────────────────────────────────────────────
// Adding a bank = adding a reader here + its domain to EFT_ALLOWED_DOMAINS in
// eftCore.mjs. Nothing else changes.
// Each reader claims its own layout (detect, unchanged) OR its bank's strong
// evidence (evidenceClaims, above). layoutDetect stays reachable so a test can
// tell which of the two claimed a document.
for (const reader of [standardBank, fnb, capitec, absa, nedbank]) {
  const layoutDetect = reader.detect;
  reader.layoutDetect = layoutDetect;
  reader.detect = (lines) => layoutDetect(lines) || evidenceClaims(reader.id, lines);
}
const EFT_READERS = [standardBank, fnb, capitec, absa, nedbank];

/**
 * Which reader claims this document, by CONTENT. The sending domain narrows
 * the candidates (a Standard Bank layout arriving from absa.co.za would be a
 * forgery of a strange kind and refuses as unrecognised); the detect() decides.
 */
function selectReader({ fromDomain, lines }) {
  const domain = String(fromDomain ?? "").toLowerCase();
  for (const reader of EFT_READERS) {
    const domainFits = domain === reader.domain || domain.endsWith(`.${reader.domain}`);
    if (domainFits && reader.detect(lines)) return reader;
  }
  return null;
}

/**
 * Which reader claims this document BY CONTENT ALONE — for a document that
 * did not arrive by email: the proof of payment the owner uploads to
 * eftPoolManualApprove. There is no sending domain to narrow by, and no DKIM;
 * the owner is vouching for the document, and this only says which bank's
 * layout it is. Exactly one reader may claim it — two claiming the same
 * lines would mean the detect() rules overlap, and a guess between them is
 * not a reading.
 * @returns {object|null}
 */
function selectReaderByContent(lines) {
  if (!Array.isArray(lines)) return null;
  // A layout match decides first, exactly as before; the evidence path is
  // asked only when no layout matched (so no existing document changes
  // reader), and still only when exactly one bank claims it.
  const byLayout = EFT_READERS.filter((r) => r.layoutDetect(lines));
  if (byLayout.length) return byLayout.length === 1 ? byLayout[0] : null;
  const claimants = EFT_READERS.filter((r) => r.detect(lines));
  return claimants.length === 1 ? claimants[0] : null;
}

/**
 * The refusal for a document no reader recognises: names the domain and says
 * a reader is missing, because that sentence — plus the stored raw text — is
 * the entire work order for adding the bank.
 */
function noReaderReason(fromDomain) {
  const known = EFT_READERS.some((r) => {
    const d = String(fromDomain ?? "").toLowerCase();
    return d === r.domain || d.endsWith(`.${r.domain}`);
  });
  return known
    ? `This ${fromDomain} message does not match the known ${fromDomain} notification layout — the format may have changed. The raw text below is what the reader saw.`
    : `No payment-notification reader exists for ${fromDomain} yet. The raw text below is the real format — build the reader from it (scripts/cardrecon/eftBanks.mjs).`;
}

/**
 * One sentence for a refusal nobody could read (25 Nov 2026): the bank its
 * footer names, and the fields the shared extractor could and could not
 * find — names only, never values. The poller appends it to its no-reader
 * refusal so the owner's tab says what broke, from the first message.
 */
function unreadSummary(lines) {
  const L = Array.isArray(lines) ? lines : [];
  const banks = banksEvidencedBy(L);
  const { read, missing } = fieldsSummary(L);
  const bank = banks.length === 1 ? `Issuer by its footer: ${banks[0]}.` : banks.length > 1 ? `Footer names several banks: ${banks.join(", ")}.` : "No bank footer recognised.";
  return `${bank} Read: ${read.join(", ") || "nothing"}. Missing: ${missing.join(", ") || "—"}.`;
}

module.exports = { EFT_READERS, selectReader, selectReaderByContent, noReaderReason, standardBankHeading, banksEvidencedBy, evidenceClaims, unreadSummary };
