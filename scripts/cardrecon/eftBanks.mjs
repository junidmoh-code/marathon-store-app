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
import { createRequire } from "node:module";
import { clip } from "./intakeCore.mjs";
import { parseBankTimestamp, redactAccountDigits } from "./eftCore.mjs";

// The fuzzed money parser, borrowed — never a second copy.
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { parseRandsToCents } = require("./lib/card-recon.cjs");

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
    const amount = take(/^Amount\s+(.+)$/i, "Amount line");
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
    const account = take(/^Beneficiary account number\s+(\S+)\s*$/i, "Beneficiary account number");
    if (!account.ok) return { ok: false, reason: `Standard Bank notification: ${account.why}.` };
    if (account.value === null) return { ok: false, reason: "No Beneficiary account number could be read from this Standard Bank notification (the line may be absent, or merged with another column) — the destination account cannot be checked." };

    // "Beneficiary reference" is what the PAYER typed — the future matching
    // key. "Reference number" is the bank's own transaction id; the two are
    // deliberately kept apart.
    const reference = take(/^Beneficiary reference\s+(.+)$/i, "Beneficiary reference");
    if (!reference.ok) return { ok: false, reason: `Standard Bank notification: ${reference.why}.` };
    const bankRef = take(/^Reference number\s+(.+)$/i, "Reference number");
    if (!bankRef.ok) return { ok: false, reason: `Standard Bank notification: ${bankRef.why}.` };
    const beneficiaryName = take(/^Beneficiary name\s+(.+)$/i, "Beneficiary name");
    const destBankName = take(/^Bank name\s+(.+)$/i, "Bank name");

    // "…payment has been made into your account from J SOAP:" — the payer,
    // in prose. Optional: a payment with no payer line still lands.
    const payer = labelledLine(lines, /payment has been made into your account from\s+(.+?):?\s*$/i, "payer sentence");

    // "Payment date and time 2026-08-30 23h48" — parseBankTimestamp knows the
    // 23h48 shape. Optional; receivedAt carries the record if absent.
    const when = labelledLine(lines, /^Payment date and time\s+(.+)$/i, "Payment date and time");
    const bankTs = when.ok && when.value ? parseBankTimestamp(when.value) : null;

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
    const moneyLines = [...new Set(lines.map((l) => l.trim()).filter((l) => /^(?:ZAR|R)\s?\d[\d,\s]*(?:\.\d{1,2})?$/.test(l)))];
    if (!moneyLines.length) return { ok: false, reason: "FNB notification carries no amount line (a lone ZAR figure)." };
    if (moneyLines.length > 1) return { ok: false, reason: `FNB notification carries ${moneyLines.length} different amount lines — cannot tell which is the payment.` };
    const amountCents = parseRandsToCents(moneyLines[0]);
    if (amountCents === null) {
      return { ok: false, reason: `FNB amount line reads "${clip(moneyLines[0], 60)}", which does not parse exactly as a rand amount.` };
    }
    if (amountCents <= 0) return { ok: false, reason: "The amount is zero or negative — not an incoming payment." };

    // THE DESTINATION ACCOUNT — required: the allowlist check depends on it.
    const account = fnbLabelValue(lines, /^Recipient\/Account no\s*:\s*(.*)$/i, "Recipient/Account no");
    if (!account.ok) return { ok: false, reason: `FNB notification: ${account.why}.` };
    if (!account.value) return { ok: false, reason: "No Recipient/Account no could be read from this FNB notification — the destination account cannot be checked." };

    // Reference is what the PAYER typed (right column, value-above-label);
    // optional — some customers type none, and the pool's amount search
    // exists for exactly that.
    const reference = fnbLabelValue(lines, /^Reference\s*:\s*(.*)$/i, "Reference");
    if (!reference.ok) return { ok: false, reason: `FNB notification: ${reference.why}.` };
    const bankRef = fnbLabelValue(lines, /^Trace ID\s*:\s*(.*)$/i, "Trace ID");
    if (!bankRef.ok) return { ok: false, reason: `FNB notification: ${bankRef.why}.` };
    const payer = fnbLabelValue(lines, /^Payment From\s+(.+)$/i, "payer line");

    // "Date Actioned : 2026/08/31" inline; the time is the value-above-label
    // of "Time Actioned :". Optional — receivedAt carries the record if the
    // pair does not read.
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
    };
  },
};

// ─── THE REGISTRY ────────────────────────────────────────────────────────────
// Adding a bank = adding a reader here + its domain to EFT_ALLOWED_DOMAINS in
// eftCore.mjs. Nothing else changes.
export const EFT_READERS = [standardBank, fnb];

/**
 * Which reader claims this document, by CONTENT. The sending domain narrows
 * the candidates (a Standard Bank layout arriving from absa.co.za would be a
 * forgery of a strange kind and refuses as unrecognised); the detect() decides.
 */
export function selectReader({ fromDomain, lines }) {
  const domain = String(fromDomain ?? "").toLowerCase();
  for (const reader of EFT_READERS) {
    const domainFits = domain === reader.domain || domain.endsWith(`.${reader.domain}`);
    if (domainFits && reader.detect(lines)) return reader;
  }
  return null;
}

/**
 * The refusal for a document no reader recognises: names the domain and says
 * a reader is missing, because that sentence — plus the stored raw text — is
 * the entire work order for adding the bank.
 */
export function noReaderReason(fromDomain) {
  const known = EFT_READERS.some((r) => {
    const d = String(fromDomain ?? "").toLowerCase();
    return d === r.domain || d.endsWith(`.${r.domain}`);
  });
  return known
    ? `This ${fromDomain} message does not match the known ${fromDomain} notification layout — the format may have changed. The raw text below is what the reader saw.`
    : `No payment-notification reader exists for ${fromDomain} yet. The raw text below is the real format — build the reader from it (scripts/cardrecon/eftBanks.mjs).`;
}
