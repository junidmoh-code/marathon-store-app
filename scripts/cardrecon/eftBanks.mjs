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
// read day-first for every bank, including any that prints month-first. A
// misread here costs a DISPLAYED date and nothing else: bankTs is carried on
// the record for a person to read, no money and no matching depends on it, and
// a payment whose date will not parse still lands (receivedAt carries it).
const CAPITEC_DAY_FIRST = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}:\d{2}(?::\d{2})?))?$/;
function capitecTimestamp(value) {
  const m = CAPITEC_DAY_FIRST.exec(String(value ?? "").trim());
  if (!m) return null;
  const [, dd, mm, yyyy, time] = m;
  // parseBankTimestamp does the rest of the validating — including refusing a
  // phantom date like 31/02, which it catches by round-tripping.
  return parseBankTimestamp(`${yyyy}-${mm}-${dd}${time ? ` ${time.slice(0, 5)}` : ""}`);
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
    const amount = take(/^Amount\s+(.+)$/i, "Amount line");
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
    const account = take(/^Account number\s+(\S+)\s*$/i, "Account number");
    if (!account.ok) return { ok: false, reason: `Capitec notification: ${account.why}.` };
    if (account.value === null) return { ok: false, reason: "No Account number could be read from this Capitec notification (the line may be absent, or merged with another column) — the destination account cannot be checked." };

    // "Payment reference" is what the PAYER typed — the matching key.
    // "Notification number" is Capitec's own id; kept apart, like Standard
    // Bank's two references.
    const reference = take(/^Payment reference\s+(.+)$/i, "Payment reference");
    if (!reference.ok) return { ok: false, reason: `Capitec notification: ${reference.why}.` };
    const bankRef = take(/^Notification number\s+(.+)$/i, "Notification number");
    if (!bankRef.ok) return { ok: false, reason: `Capitec notification: ${bankRef.why}.` };
    const beneficiaryName = take(/^Beneficiary name\s+(.+)$/i, "Beneficiary name");
    const destBankName = take(/^Bank name\s+(.+)$/i, "Bank name");

    // "Please take note that Sicelo made a payment to your account." — the
    // payer, in prose. Optional: a payment with no payer line still lands.
    const payer = labelledLine(lines, /take note that\s+(.+?)\s+made a payment to your account/i, "payer sentence");

    const when = take(/^Payment date\s+(.+)$/i, "Payment date");
    const bankTs = when.ok && when.value ? capitecTimestamp(when.value) : null;

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
// NOT USED, AND WORTH KNOWING: "Immediate payment: N" says the money may only
// land by midnight rather than at once. Every bank's notification carries some
// version of that caveat (Standard Bank: "up to one business day"), and the
// pool has always treated a notification as evidence of an INSTRUCTION, not of
// cleared funds — so this reader does not smuggle it into a field the record
// has no place for. If it should gate settling, that is a record-shape change
// and a decision, not a parser detail.
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
      && has(/made a payment to your account/i)
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
    const amount = take(/^For the amount of:\s*(.*)$/i, "amount line");
    if (!amount.ok) return { ok: false, reason: `Absa notification: ${amount.why}.` };
    if (amount.value === null) return { ok: false, reason: "Absa notification carries no amount line." };
    const amountCents = parseRandsToCents(amount.value);
    if (amountCents === null) {
      return { ok: false, reason: `Absa amount line reads "${clip(amount.value, 60)}", which does not parse exactly as a rand amount.` };
    }
    if (amountCents <= 0) return { ok: false, reason: "The amount is zero or negative — not an incoming payment." };

    // THE DESTINATION ACCOUNT — required: the allowlist check depends on it.
    const account = take(/^Beneficiary account number:\s*(.*)$/i, "Beneficiary account number");
    if (!account.ok) return { ok: false, reason: `Absa notification: ${account.why}.` };
    if (!account.value) return { ok: false, reason: "No Beneficiary account number could be read from this Absa notification — the destination account cannot be checked." };

    // "Reference on beneficiary statement" is what the PAYER typed — the
    // matching key. "Transaction number" is Absa's own id; kept apart.
    const reference = take(/^Reference on beneficiary statement:\s*(.*)$/i, "Reference on beneficiary statement");
    if (!reference.ok) return { ok: false, reason: `Absa notification: ${reference.why}.` };
    const bankRef = take(/^Transaction number:\s*(.*)$/i, "Transaction number");
    if (!bankRef.ok) return { ok: false, reason: `Absa notification: ${bankRef.why}.` };
    const beneficiaryName = take(/^Payment made to:\s*(.*)$/i, "Payment made to");
    const destBankName = take(/^Beneficiary bank name:\s*(.*)$/i, "Beneficiary bank name");
    const payer = take(/^Payment made by:\s*(.*)$/i, "Payment made by");

    // "Payment date:" then "2026-09-01" — a shape parseBankTimestamp already
    // knows. Optional: receivedAt carries the record if it will not read.
    const when = take(/^Payment date:\s*(.*)$/i, "Payment date");
    const bankTs = when.ok && when.value ? parseBankTimestamp(when.value) : null;

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
    };
  },
};

// ─── THE REGISTRY ────────────────────────────────────────────────────────────
// Adding a bank = adding a reader here + its domain to EFT_ALLOWED_DOMAINS in
// eftCore.mjs. Nothing else changes.
export const EFT_READERS = [standardBank, fnb, capitec, absa];

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
