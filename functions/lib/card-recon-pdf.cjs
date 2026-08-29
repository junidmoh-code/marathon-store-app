// ─── CARD RECON — READING THE BATCH REPORT OUT OF A PDF (PURE) ───────────────
// FNB terminals can email their batch report as a PDF. That file carries the
// slip's own TEXT, so there is nothing to OCR and nothing to be uncertain
// about: the figures are read exactly or not at all.
//
// THAT IS THE WHOLE DESIGN RULE HERE. Every function in this file REFUSES by
// name rather than guessing. There is no fuzzy match, no nearest-label, no
// "probably the total" — a wrong figure in this system becomes a recorded
// variance against a named person's till, and no figure at all is strictly
// better than a wrong one. A refusal sends the manager to the photo path,
// which still works.
//
// PURE by the house rule: no pdfjs, no firebase-admin, no fetch. The PDF is
// turned into lines of text by the callable (which owns the IO) and handed
// here as a string array. Tested in functions/test/card-recon-pdf.test.cjs.
//
// The output is the SAME `extraction` shape the OCR path produces, so
// everything downstream — validateExtraction, buildBatchRecord, the duplicate
// and window checks — is shared and unchanged.

"use strict";

const { parseSlipTimestamp, parseRandsToCents, normaliseTid, normaliseBatchNo, formatCents } = require("./card-recon.cjs");

/** Collapse runs of whitespace; a PDF's text layer is full of them. */
const tidy = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * Find the first line matching `re` and return its capture group 1.
 * `label` is what the refusal will call it.
 */
function field(lines, re) {
  for (const line of lines) {
    const m = re.exec(line);
    if (m) return tidy(m[1]);
  }
  return null;
}

// ── The header ───────────────────────────────────────────────────────────────
// Labels are matched case-insensitively and tolerate the spacing a text layer
// introduces, but the SHAPE of each value is pinned: a TID is alphanumeric, a
// batch number is digits, a timestamp is the terminal's own format. A label
// found with a value that does not fit its shape is a refusal, not a shrug.
// THREE RULES, AND EVERY ONE IS LOAD-BEARING.
//
// FIRST, every header label is anchored to the start of its row (`^\s*`). A
// slip is a column of LABELLED ROWS — "TERMINAL ID 0000HP1X" — so the label is
// the first thing on its line. Unanchored, the same words match prose that
// merely mentions them, and the FIRST match wins: a line of boilerplate reading
// "This terminal handles up to 9999 transactions per batch" made the terminal
// ID read as "HANDLES".
//
// KNOWN LIMIT, ACCEPTED DELIBERATELY. pdfToLines merges every fragment sharing
// a Y coordinate into one line, so a slip printing TWO fields side by side
// arrives as "MERCHANT ID 000000004977890   TERMINAL ID 0000HP1X" and this
// anchor finds no terminal ID on it. Allowing a label after a column gap
// instead was tried and does not work: `tidy` collapses every run of
// whitespace to a single space before any regex runs, and it must, because
// splitTxnMiddle and TXN_RE both read a transaction row as single-space
// columns. Preserving gaps for the header would break the detail roll.
//
// No slip on file uses that layout — the fixture follows the real report the
// OCR prompt was written from, one field per row — so this is a refusal for a
// layout nobody has seen, and the refusal names the missing field and sends
// the manager to the photo path, which handles any layout. If such a slip ever
// turns up, the fix is in pdfToLines (split a row at a wide X gap for header
// lines only), not in these patterns.
//
// SECOND, only SEPARATORS may sit between the label and its value
// (`[^0-9A-Za-z]*` — spaces, colons, dots, dashes), never words. Anchoring
// alone is not enough, because prose can begin with the label too:
// "Transactions are settled within 7 working days" starts the row correctly
// and would have yielded a count of 7. A printed field puts its value right
// after its label; anything with words in between is a sentence.
//
// THIRD, THE TID TOKEN MUST CONTAIN A DIGIT — WITHIN THE TOKEN ITSELF. The label's "ID"/"NO"/"NUMBER" word is
// optional (slips differ), which left the pattern accepting ANY alphanumeric
// word straight after "Terminal" — so a line reading "Terminal replacement
// 8888ZZZZ pending" yielded a terminal ID of "REPLACEMENT". This repo's own
// note on terminal identity says not to assume a TID FORMAT, and this does not:
// it assumes only that a card terminal's identifier contains at least one
// digit, which both live TIDs do (0000HP1X and 67377843). A token with none is
// passed over and the search continues to the next line; if no row qualifies,
// the slip is refused for a missing terminal ID — a sentence the manager can
// act on, and never a wrong till.
//
// The lookahead counts to 15, not to infinity: `[A-Za-z0-9]*[0-9]` is satisfied
// by a digit anywhere in an unbroken run, INCLUDING past the 16 characters the
// capture actually takes — so "Terminal REPLACEMENTLETTERZZ8888" passed the
// digit test and captured "REPLACEMENTLETTE", sixteen letters and no digit at
// all. The bound ties the assertion to the same text the group takes.
//
// Everything these two rules catch was caught downstream anyway — by the TID
// cross-check and the line-count check — so no wrong figure was ever recorded.
// But the manager was told the PDF belonged to "TID HANDLES", which is a
// refusal nobody can act on. Found by review on PR #509; the second rule was
// found by the mutation that proved the first one insufficient.
const RE = {
  mid:      /^\s*merchant\s*(?:id|no|number)?\b[^0-9A-Za-z]*([0-9]{6,})/i,
  tid:      /^\s*terminal\s*(?:id|no|number)?\b[^0-9A-Za-z]*(?=[A-Za-z0-9]{0,15}[0-9])([A-Za-z0-9]{4,16})/i,
  batchNo:  /^\s*batch\b[^#\n]*#\s*([0-9]{1,8})/i,
  opened:   /^\s*opened\b[^0-9A-Za-z]*([0-9]{4}[/-][0-9]{2}[/-][0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/i,
  closed:   /^\s*closed\b[^0-9A-Za-z]*([0-9]{4}[/-][0-9]{2}[/-][0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/i,
  printed:  /^\s*printed\b[^0-9A-Za-z]*([0-9]{4}[/-][0-9]{2}[/-][0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/i,
  txnCount: /^\s*transactions?\b[^0-9A-Za-z]*([0-9]{1,5})\b/i,
  reconLine: /^([0-9]{3}\s*-\s*.*reconcil.*)$/i,
};

// Money labels. The capture is THE WHOLE REST OF THE LINE, deliberately — see
// moneyField for why anything narrower silently truncates a mangled figure.
// `purchases` accepts the card-scheme wording the slip actually prints as well
// as a bare "Purchases".
const MONEY = {
  purchases: /\b(?:(?:master ?card|visa|card)\s*)?purchases?\b\s*[:.]?\s*(.*)$/i,
  refunds:   /\brefunds?\b\s*[:.]?\s*(.*)$/i,
  cash:      /\bcash\b\s*[:.]?\s*(.*)$/i,
  total:     /\btotals?\b\s*[:.]?\s*(.*)$/i,
};

// A STRICT amount: one that carries a currency mark, or states its cents. This
// is what lets a label be followed by an extra word without the search falling
// back into prose — see moneyField's second attempt. "ZAR 30120.00" and
// "30,120.00" qualify; the "7" of "Total pages 7" and the "56" of "Refunds
// enquiries 0860 12 34 56" do not, which is exactly the distinction that keeps
// page furniture out of the figures.
// How many words may sit between a money label and its figure before the line
// stops being a label and starts being a sentence. Two covers "Total Amount";
// three already reaches "surcharge rate is".
const MAX_LABEL_SUFFIX_WORDS = 2;

const STRICT_AMOUNT = /(?:^|\s)((?:ZAR|R)\s*[-(]?\s*[0-9][0-9,. ]*\)?|[-(]?\s*[0-9][0-9,. ]*\.[0-9]{2}\)?)\s*$/i;

// ─── IS THIS REMAINDER A FIGURE AT ALL? ──────────────────────────────────────
// After a money label, three quite different things can follow, and telling
// them apart is what keeps this path both usable and honest:
//
//   "CARD TOTALS"                 → nothing follows. A section heading.
//   "TOTALS SUMMARY"              → a word follows. Also a heading.
//   "Total pages 7"               → prose that happens to contain a digit.
//   "Refunds enquiries 0860 1234" → a page footer, on a seven-page report.
//   "Total   ZAR 30,120.00"       → the figure row.
//   "Total   ZAR 3O,120.00"       → the figure row, MANGLED. Must refuse.
//
// The test is whether the remainder BEGINS like an amount: an optional sign or
// bracket, an optional currency mark, then a digit. Anything starting with a
// word is prose and the search moves on; anything starting like an amount must
// parse in full or the report is refused.
//
// An earlier rule — "a remainder containing a digit anywhere is a figure row" —
// was right about headings and wrong about everything else. The real report is
// SEVEN PAGES with FNB's address block and page footers interleaved between the
// transactions, and a footer reading "Total pages 7" was therefore read as a
// broken TOTAL and refused the whole report. Prose is not a mangled figure.
//
// The mangled case is untouched: "R5O,307.00" and "ZAR 5O0.00" both begin with
// a currency mark and a digit, so both are still figure rows, and still refuse.
// A figure so mangled that it begins with a letter is skipped as prose and the
// field ends up missing — which is a refusal too, just a differently worded
// one. There is no reading in which a wrong number is recorded.
function looksLikeAmount(rest) {
  if (!rest) return false;
  return /^[-(]?\s*(?:ZAR|R)?\s*[-(]?\s*\d/i.test(rest);
}

/**
 * Read one money figure off its label line.
 *
 * THE WHOLE REMAINDER MUST PARSE. A narrower capture — "the digits after the
 * label" — truncates instead of refusing: `TOTAL R5O,307.00`, with a letter O
 * where a zero belongs, matched up to the O and yielded R5.00. A wrong figure,
 * recorded, as a variance against a named person's till. That is the one
 * outcome this path exists to make impossible, so the remainder is taken whole
 * and either parses or refuses.
 *
 * An EMPTY remainder is a section header ("CARD TOTALS" above the figures), not
 * a broken figure — skipped, and the search continues on the next matching
 * line. That distinction is what lets the strict rule coexist with a slip whose
 * headings contain the same words as its rows.
 *
 * @returns {{cents:number} | {err:string} | {missing:true}}
 */
function moneyField(rows, re, what, { allowLabelSuffix = false } = {}) {
  // EVERY matching row, not the first. A money label cannot be anchored to the
  // start of its line the way a header label can — the slip prints
  // "MasterCard/Visa Purchases   R50,355.00" — so an unanchored match can land
  // on a decoy before it reaches the real row. Taking the first would then
  // quietly read the decoy. Instead every candidate is collected, and if two
  // disagree the slip is REFUSED as ambiguous: a slip that states a figure
  // twice, differently, is one no reader should be picking between.
  let found = null;
  for (const line of rows) {
    const m = re.exec(line);
    if (!m) continue;
    const rest = tidy(m[1]);
    // A LABEL, A LINE OF PROSE, OR A BROKEN FIGURE? — see looksLikeAmount.
    //
    // (The rule itself lives in looksLikeAmount, above.)
    let figure = rest;
    if (!looksLikeAmount(rest)) {
      if (!allowLabelSuffix) continue;
      // NOT a figure where one was expected — but the label may simply carry an
      // extra word: "Purchase Amount   ZAR 30120.00" rather than "Purchase
      // ZAR 30120.00". So look for a STRICT amount at the end of the line and
      // accept it only when what sits between the label and it is plainly a
      // LABEL and not a SENTENCE.
      //
      // TWO CONDITIONS, and the word cap is the one that matters. "No digits in
      // between" is nearly useless on its own, because prose has no digits
      // either: it let "Cash advance fees are subject to a service charge of
      // 2.50" through as a R2.50 cash figure, and "Total excludes certain bank
      // charges (25.00)" through as a NEGATIVE total. A label suffix is one or
      // two words ("Amount", "Total Amount"); nine words is a sentence about
      // fees. Found by review of PR #512 — this second attempt was the thing
      // that introduced the very failure this module exists to prevent.
      const m2 = STRICT_AMOUNT.exec(rest);
      if (!m2) continue;
      const prefix = rest.slice(0, m2.index).trim();
      const words = prefix ? prefix.split(/\s+/) : [];
      if (words.length > MAX_LABEL_SUFFIX_WORDS || /\d/.test(prefix)) continue;
      figure = m2[1];
    }
    const cents = parseRandsToCents(figure);
    if (cents === null) {
      return { err: `The ${what} reads "${figure}", which is not an amount this understands. Nothing was recorded — photograph the slip instead.` };
    }
    if (found !== null && found !== cents) {
      return { err: `The ${what} appears twice on that PDF with different figures (${formatCents(found)} and ${formatCents(cents)}). Nothing was recorded — photograph the slip instead.` };
    }
    found = cents;
  }
  return found === null ? { missing: true } : { cents: found };
}

/**
 * One printed transaction line.
 *
 * The roll prints, in order: date, time, UTI, RRN, auth code, TSN, masked PAN,
 * amount. Anchored on the DATE + TIME at the start and the AMOUNT at the end,
 * because those two are the only fields whose shape is unambiguous; everything
 * between is taken positionally from what is left. A line that does not present
 * a date, a time, a TSN and an amount is not treated as a transaction at all —
 * it is prose, a header, or a total, and quietly skipping it is right. A line
 * that LOOKS like a transaction but whose amount will not parse is a refusal.
 */
const TXN_RE = new RegExp(
  "^(\\d{4}[/-]\\d{2}[/-]\\d{2})\\s+" +           // date
  "(\\d{2}:\\d{2}(?::\\d{2})?)\\s+" +             // time
  "(.+?)\\s+" +                                   // uti / rrn / auth / tsn / pan, positional
  "([-(]?\\s*(?:ZAR|R)?\\s*[0-9][0-9,. ]*\\)?)" +   // amount, in rand or ZAR
  "(?:\\s+(REFUND|PURCHASE|VOID|REVERSAL))?$",    // optional trailing type marker
  "i",
);

/**
 * Pull the middle of a transaction line apart. Positional, and deliberately
 * forgiving about which of UTI/RRN/auth are present — terminals differ — but
 * STRICT about the TSN, because TSN contiguity is one of the checks that makes
 * a missing line impossible to hide.
 */
function splitTxnMiddle(middle) {
  const parts = tidy(middle).split(" ").filter(Boolean);
  // The masked PAN is the token carrying mask characters; the TSN is the last
  // bare integer BEFORE it (or the last bare integer at all).
  // The masking character varies by terminal — asterisk, X, a middle dot, a
  // bullet, a hash. Missing it costs no MONEY figure (the amount is anchored at
  // the end of the line and the TSN is found either way); it costs the PAN,
  // which weakens line-level matching against the POS legs. Widened rather than
  // guessed at: an unrecognised mask leaves `pan` null, which is honest.
  const panIdx = parts.findIndex((p) => /[*x·•#]{2,}/i.test(p));
  const pan = panIdx >= 0 ? parts[panIdx] : null;
  const beforePan = panIdx >= 0 ? parts.slice(0, panIdx) : parts;
  let tsn = null;
  for (let i = beforePan.length - 1; i >= 0; i--) {
    if (/^\d{1,6}$/.test(beforePan[i])) { tsn = Number(beforePan[i]); beforePan.splice(i, 1); break; }
  }
  // Whatever is left, in print order: UTI, RRN, auth code.
  const [uti = null, rrn = null, authCode = null] = beforePan;
  return { tsn, pan, uti, rrn, authCode };
}

/**
 * THE TERMINAL'S OWN PRINTED BATCH SLIP, as a PDF.
 *
 * Labelled rows ("TERMINAL ID", "Batch Report (#494)", "Opened", "Closed",
 * "Transactions"), rand amounts, and a detail roll whose TSNs run unbroken
 * because the roll prints every attempt including the declines.
 *
 * @param {string[]} rows  tidied text, one entry per visual line
 * @returns {{ok:true, extraction:object} | {ok:false, reason:string}}
 */
function parsePrintedSlip(rows) {
  const need = (value, what) => (value === null || value === undefined
    ? { ok: false, reason: `That PDF does not print ${what} anywhere this could find it. If it is the right file, photograph the slip instead.` }
    : null);

  const rawTid = field(rows, RE.tid);
  let bad = need(rawTid, "a terminal ID"); if (bad) return bad;
  const tid = normaliseTid(rawTid);
  if (!tid) return { ok: false, reason: `"${rawTid}" does not look like a terminal ID.` };

  const rawBatch = field(rows, RE.batchNo);
  bad = need(rawBatch, "a batch number"); if (bad) return bad;
  const batchNo = normaliseBatchNo(rawBatch);
  if (batchNo === null) return { ok: false, reason: `"${rawBatch}" does not look like a batch number.` };

  const openedText = field(rows, RE.opened);
  bad = need(openedText, "an Opened time"); if (bad) return bad;
  const closedText = field(rows, RE.closed);
  bad = need(closedText, "a Closed time"); if (bad) return bad;
  const openedAt = parseSlipTimestamp(openedText);
  const closedAt = parseSlipTimestamp(closedText);
  if (openedAt === null) return { ok: false, reason: `The Opened time reads "${openedText}", which is not a date this understands.` };
  if (closedAt === null) return { ok: false, reason: `The Closed time reads "${closedText}", which is not a date this understands.` };
  const printedText = field(rows, RE.printed);
  const printedAt = printedText ? parseSlipTimestamp(printedText) : null;

  const rawCount = field(rows, RE.txnCount);
  bad = need(rawCount, "a Transactions count"); if (bad) return bad;
  const txnCount = Number(rawCount);

  const money = (re, what, { required }) => {
    const found = moneyField(rows, re, what);
    if (found.missing) {
      return required
        ? { err: `That PDF does not print a ${what}.` }
        : { cents: 0 };                     // absent means zero, as on the roll
    }
    return found;
  };
  const purchases = money(MONEY.purchases, "purchases figure", { required: true });
  if (purchases.err) return { ok: false, reason: purchases.err };
  const total = money(MONEY.total, "TOTAL", { required: true });
  if (total.err) return { ok: false, reason: total.err };
  const refunds = money(MONEY.refunds, "refunds figure", { required: false });
  if (refunds.err) return { ok: false, reason: refunds.err };
  const cash = money(MONEY.cash, "cash figure", { required: false });
  if (cash.err) return { ok: false, reason: cash.err };

  // ── The detail roll ──
  const txns = [];
  for (const row of rows) {
    const m = TXN_RE.exec(row);
    if (!m) continue;
    const [, date, time, middle, rawAmount, marker] = m;
    const at = parseSlipTimestamp(`${date} ${time.length === 5 ? `${time}:00` : time}`);
    const { tsn, pan, uti, rrn, authCode } = splitTxnMiddle(middle);
    if (!Number.isInteger(tsn)) {
      return { ok: false, reason: `A transaction line has no sequence number this could read: "${row}".` };
    }
    const amountCents = parseRandsToCents(rawAmount);
    if (amountCents === null) {
      return { ok: false, reason: `A transaction line's amount will not parse: "${row}".` };
    }
    // A refund is named by the trailing marker, by the word appearing on the
    // line, or by a negative amount. The roll does not print all three, and
    // which one it prints differs by terminal.
    const isRefund = /^refund$/i.test(marker || "") || /\brefund\b/i.test(row) || amountCents < 0;
    txns.push({
      tsn, at, date, time,
      uti, rrn, authCode, pan,
      type: isRefund ? "refund" : "purchase",
      amountCents: isRefund && amountCents > 0 ? -amountCents : amountCents,
    });
  }

  return {
    ok: true,
    extraction: {
      mid: field(rows, RE.mid),
      tid, batchNo: String(batchNo),
      openedAt, closedAt, printedAt,
      openedText, closedText,
      txnCount,
      purchasesCents: purchases.cents,
      cashCents: cash.cents,
      refundsCents: Math.abs(refunds.cents),   // magnitude by contract
      totalCents: total.cents,
      reconLine: field(rows, RE.reconLine),
      // NO confidence object. There is nothing to be confident about — the text
      // was read exactly or this refused. validateExtraction skips its
      // confidence gate for source "pdf" rather than being handed a fabricated
      // 1.0, which would be a lie sitting in the record for ever.
      confidence: null,
      format: "printed",
      windowSource: "printed",     // Opened and Closed came off the slip itself
      lines: txns,
    },
  };
}


// ═══ THE BANK'S EMAILED BANKING REPORT ═══════════════════════════════════════
//
// A SECOND FORMAT, not a variant of the first. FNB's emailed report covers the
// same batch as the terminal's printed slip but states it differently, and two
// of those differences change what the CHECKS may conclude — which is why this
// is a separate reader rather than a few extra patterns bolted onto the other.
//
//   printed slip                        emailed banking report
//   ─────────────────────────────────   ──────────────────────────────────────
//   "TERMINAL ID  0000HP1X"             "Banking Report for Batch 59 of
//   "Batch Report (#494)"                Terminal 67365901"  ← both, in one line
//                                       "Merchant:" / "Terminal:" / "Batch:"
//   "Transactions  2"                   "APPROVED TRANSACTIONS" / "Items: 40"
//   "R50,355.00"                        "ZAR 900.00"
//   Opened / Closed printed             NO window printed at all
//   TSNs run unbroken                   TSNs have GAPS, and that is correct
//   Payment Type Summary block          TOTALS SUMMARY + CARD TOTALS, no PTS
//
// ── THE TWO CHECKS THAT HAD TO CHANGE ────────────────────────────────────────
//
// TSN CONTIGUITY IS MEANINGLESS HERE. The printed roll lists every attempt, so
// a gap in its sequence means a line was missed — the exact thing this feature
// exists to catch. The emailed report lists APPROVED transactions only, so
// declines and voids leave gaps by design; the real example runs 2,3,4,6,7,8
// (no 5) and skips 21-24, 30-31, 33-34 and 43. Applying contiguity here would
// refuse every emailed report ever sent. It is therefore skipped for this
// format — but DUPLICATE TSNs are still refused, because a repeat is a
// mis-parse in either format and means something quite different from a gap.
//
// THERE IS NO PRINTED WINDOW. The report carries a print timestamp and the
// transaction times, and nothing else. The reconciliation window is therefore
// DERIVED from the transactions themselves — first to last — and the record
// says so in `windowSource`, so nobody reading it later mistakes a derived
// window for one the terminal declared. Nothing is invented: with no
// transactions there is no window and the report is refused.
//
// EVERYTHING ELSE HOLDS. TID against the picked till, duplicate batch numbers,
// the arithmetic, the line count against the printed Items figure, and the
// lines summing to the printed total are all unchanged.

const EMAILED = {
  // The title carries BOTH identifiers, which is what makes this format
  // recognisable at all — and it is checked against the labelled "Terminal:"
  // and "Batch:" rows below, so a misread title cannot pass quietly.
  title:    /^\s*banking report for batch\s+([0-9]{1,8})\s+of terminal\s+(?=[A-Za-z0-9]{0,15}[0-9])([A-Za-z0-9]{4,16})\b/i,
  mid:      /^\s*merchant\b[^0-9A-Za-z]*([0-9]{6,})/i,
  tid:      /^\s*terminal\b[^0-9A-Za-z]*(?=[A-Za-z0-9]{0,15}[0-9])([A-Za-z0-9]{4,16})/i,
  batchNo:  /^\s*batch\b[^0-9A-Za-z]*([0-9]{1,8})\b/i,
  items:    /^\s*items\b[^0-9A-Za-z]*([0-9]{1,5})\b/i,
  approved: /^\s*approved transactions\b/i,
  cardTotals: /^\s*card totals\b/i,
  totalsSummary: /^\s*totals summary\b/i,
  printed:  /^\s*(?:date|printed)\b[^0-9A-Za-z]*([0-9]{4}[/-][0-9]{2}[/-][0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/i,
  bareStamp: /^\s*([0-9]{4}[/-][0-9]{2}[/-][0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})\s*$/,
};

/**
 * Which report is this? Answered before anything is read out of it, so a file
 * that is neither is refused by NAME rather than by a pile of missing fields.
 *
 * The emailed report is identified by its title line, or failing that by the
 * "APPROVED TRANSACTIONS" heading together with an "Items:" count — two marks
 * the printed slip never carries. The printed slip is identified by its own
 * labelled TERMINAL ID row plus a parenthesised batch number.
 *
 * @returns {"emailed"|"printed"|null}
 */
function detectReportFormat(rows) {
  const has = (re) => rows.some((r) => re.test(r));
  if (has(EMAILED.title)) return "emailed";
  if (has(EMAILED.approved) && has(EMAILED.items)) return "emailed";
  if (field(rows, RE.tid) !== null && field(rows, RE.batchNo) !== null) return "printed";
  return null;
}


// ─── WHERE IS THE MASKED CARD NUMBER? ────────────────────────────────────────
// It is the fence between the row's identifiers and its amount, so getting its
// extent wrong moves the fence and the TSN is read out of the wrong column.
//
// Most terminals print it as ONE token — "************1111". Some print it in
// groups — "4111 11** **** 1111" — and then only the middle groups carry mask
// characters at all: the leading "4111" is bare digits and was being taken as a
// sequence number. (Raised in review of PR #511; the real file was not
// available to confirm which style FNB uses, so both are handled.)
//
// THE SECOND CLAUSE ONLY FIRES ON A SPLIT PAN. Absorbing a preceding all-digit
// group is safe when at least two tokens carry mask characters — that is a card
// number broken across columns. With a single mask-bearing token nothing is
// absorbed and this behaves exactly as it always did, so a row in the known
// layout is unaffected.
const MASKED = /[*x·•#]{2,}/i;

function panSpanOf(parts) {
  const first = parts.findIndex((t) => MASKED.test(t));
  if (first < 0) return null;
  let start = first, end = first;
  while (end + 1 < parts.length && MASKED.test(parts[end + 1])) end += 1;
  const split = end > start;
  // …and the outer groups of a split number, which carry no mask at all.
  // Forward absorption is bounded by `middle` itself: TXN_RE has already taken
  // the amount off the end, so there is no figure here to swallow.
  if (split && start > 0 && /^\d{2,6}$/.test(parts[start - 1])) start -= 1;
  if (split && end + 1 < parts.length && /^\d{2,6}$/.test(parts[end + 1])) end += 1;
  return { start, end, pan: parts.slice(start, end + 1).join(" ") };
}

/**
 * Pull apart the middle of an emailed report's transaction line.
 *
 * Its columns are date, time, UTI, RRN, Auth Code, TSN, **Batch**, masked PAN,
 * amount, type — and that Batch column is the trap. The printed reader takes
 * "the last bare integer before the PAN" as the TSN, which here would take the
 * BATCH NUMBER off every single line: forty identical TSNs, a duplicate
 * refusal, and a feature that never works.
 *
 * The layout is therefore settled ONCE for the whole report, from evidence
 * rather than from position: a real Batch column carries the report's own batch
 * number on EVERY line. If every line's last integer matches it, that column is
 * the batch and the TSN is the one before it. Otherwise there is no batch
 * column and the last integer is the TSN — which is also the right answer when
 * one line's TSN merely happens to equal the batch number by coincidence.
 *
 * @param {string} middle    the text between the time and the amount
 * @param {boolean} hasBatchColumn  the layout, decided across all lines
 */
function splitEmailedTxnMiddle(middle, hasBatchColumn) {
  const parts = tidy(middle).split(" ").filter(Boolean);
  const span = panSpanOf(parts);
  const pan = span ? span.pan : null;
  const before = span ? parts.slice(0, span.start) : parts.slice();

  const intAt = (from) => {
    for (let i = from; i >= 0; i--) if (/^\d{1,8}$/.test(before[i])) return i;
    return -1;
  };
  const lastInt = intAt(before.length - 1);
  let tsnIdx = lastInt;
  let batchOnLine = null;
  if (hasBatchColumn && lastInt >= 0) {
    batchOnLine = Number(before[lastInt]);
    tsnIdx = intAt(lastInt - 1);
  }
  const tsn = tsnIdx >= 0 ? Number(before[tsnIdx]) : null;
  // Everything that is not the TSN or the batch column, in print order.
  const rest = before.filter((_, i) => i !== tsnIdx && !(hasBatchColumn && i === lastInt));
  const [uti = null, rrn = null, authCode = null] = rest;
  return { tsn, pan, uti, rrn, authCode, batchOnLine };
}



// ─── THE REPORT IS DIVIDED INTO SECTIONS, AND THE DIVIDERS ARE PRINTED ───────
// The real file separates every section with a rule of underscores:
//
//     ______________________________
//     APPROVED TRANSACTIONS
//     Items: 40
//     ______________________________
//     …the transaction blocks…
//     ______________________________
//     TOTALS SUMMARY
//     ______________________________
//
// That structure is worth reading rather than ignoring, because a report may
// carry MORE than one section of transactions — and their counts are different
// facts, not contradictions. A Trophy till's report stated "Items: 25" and
// "Items: 5" in two sections and was refused as self-contradictory, which it
// was not: 25 belonged to the approved list and 5 to something else.
//
// A section begins where a divider is followed by an ALL-CAPS heading. Nothing
// else in the document has that shape: transaction blocks open on a timestamp,
// and the header's labelled rows are mixed case.
const SECTION_DIVIDER = /^\s*_{4,}\s*$/;
const SECTION_HEADING = /^\s*([A-Z][A-Z0-9 &/'.-]{3,})\s*$/;

function sectionStarts(rows) {
  const out = [];
  for (let i = 0; i < rows.length - 1; i++) {
    if (!SECTION_DIVIDER.test(rows[i])) continue;
    const m = SECTION_HEADING.exec(rows[i + 1]);
    if (m) out.push({ at: i + 1, heading: tidy(m[1]) });
  }
  return out;
}

/**
 * The span of the APPROVED TRANSACTIONS section: where its heading sits, and
 * where the next section begins.
 *
 * A report with no dividers at all (another terminal's firmware, say) falls
 * back to the whole document, which is what this did before sections were read
 * — so nothing that worked before stops working.
 */
function approvedSection(rows, totalsIdx) {
  const limit = totalsIdx >= 0 ? totalsIdx : rows.length;
  const starts = sectionStarts(rows);
  const approved = starts.find((sec) => /approved/i.test(sec.heading) && sec.at < limit);
  if (!approved) return { from: 0, to: limit };
  const next = starts.find((sec) => sec.at > approved.at);
  return { from: approved.at, to: Math.min(next ? next.at - 1 : limit, limit) };
}

// ─── A TRANSACTION IS A BLOCK, NOT A ROW ─────────────────────────────────────
// This is the shape the real emailed report actually uses — one transaction
// spread over eight or nine lines rather than printed across one:
//
//     29-08-2026 09:07:23          ← the block opens on a bare timestamp
//     UTI:70db11a9-13f2-4980-8fcd-
//     97cbf50222c5                 ← …which WRAPS onto the next line
//     RRN: 04Yewn059002
//     Auth Code: 932966
//     TSN:2 Batch:59               ← both numbers, on one line
//     518103******4436
//     Total: ZAR 900.00            ← the amount
//     Purchase ZAR 900.00          ← the type, and the amount again
//
// AND THE PAGE FURNITURE LANDS INSIDE THE BLOCKS. In the real file a
// "Page 6 of 7" footer sits between one transaction's timestamp and its UTI.
// Reading a block therefore means scanning its slice for the fields it carries
// rather than counting lines, so anything else in there is ignored for free.
//
// The dates are DD-MM-YYYY, which is not what the printed slip uses — see
// parseEmailedStamp.

const BLOCK = {
  stamp:    /^\s*(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s*$/,
  tsnBatch: /^\s*TSN:\s*(\d{1,8})\s+Batch:\s*(\d{1,8})\s*$/i,
  rrn:      /^\s*RRN:\s*(\S+)/i,
  auth:     /^\s*Auth\s*Code:\s*(\S+)/i,
  uti:      /^\s*UTI:\s*(\S*)\s*$/i,
  utiTail:  /^\s*[0-9a-f]{4,}\s*$/i,
  pan:      /^\s*(\d{2,6}[*x·•#]{2,}\d{2,6})\s*$/i,
  amount:   /^\s*Total:\s*(.+)$/i,
  type:     /^\s*(Purchase|Refund|Void|Reversal)\b(.*)$/i,
};

/**
 * DD-MM-YYYY, which the emailed report uses and the printed slip does not.
 *
 * A SEPARATE parser rather than a widening of parseSlipTimestamp: that one
 * reads YYYY-MM-DD, and a function accepting both would have to guess which
 * way round "01-02-2026" is. Here the format is fixed by the document, so
 * there is nothing to guess — and leaving the slip's parser untouched means
 * the photo path cannot be changed by this at all.
 */
function parseEmailedStamp(text) {
  const m = BLOCK.stamp.exec(String(text || ""));
  if (!m) return null;
  const [, dd, mo, yyyy, hh, mi, ss] = m;
  // Reuse the slip parser's own validation and SAST handling by handing it the
  // order it expects, so the two paths cannot drift on leap years or offsets.
  return parseSlipTimestamp(`${yyyy}/${mo}/${dd} ${hh}:${mi}:${ss}`);
}

/**
 * Slice the document into transaction blocks.
 *
 * A block opens on a bare timestamp and runs to the next one, or to the totals
 * region. The report's own header carries a timestamp too — the moment it was
 * printed — so a slice only counts as a transaction if it contains a TSN line.
 * That is what distinguishes the two, not its position in the document.
 */
function collectTxnBlocks(rows, from = 0) {
  const limit = rows.length;
  const starts = [];
  for (let i = Math.max(from, 0); i < limit; i++) if (BLOCK.stamp.test(rows[i])) starts.push(i);
  // EVERY stamp-slice is returned, including the header's. Deciding which of
  // them is a transaction belongs to readTxnBlock, which has to look for a TSN
  // anyway — splitting that judgement across two functions left the "no TSN"
  // branch there permanently unreachable, and an unreachable branch is one a
  // later reader trusts for protection it does not give.
  const blocks = [];
  starts.forEach((from, k) => {
    blocks.push(rows.slice(from, k + 1 < starts.length ? starts[k + 1] : limit));
  });
  return blocks;
}

/**
 * Read one block. Refuses rather than guessing at every step.
 *
 * @returns {{txn:object} | {err:string}}
 */
function readTxnBlock(block, batchNo) {
  const first = (re) => {
    for (const l of block) { const m = re.exec(l); if (m) return m; }
    return null;
  };
  const at = parseEmailedStamp(block[0]);
  if (at === null) return { err: `A transaction's date and time will not parse: "${block[0]}".` };

  // NOT EVERY TIMESTAMPED SLICE IS A TRANSACTION. The report's header carries a
  // bare timestamp of its own — the moment it was printed — and it is followed
  // by the trading name, the version and the labelled rows, not by a TSN. A
  // slice with no TSN line is that header block, and is skipped rather than
  // refused; a transaction is identified by carrying a sequence number, never
  // by its position in the document.
  const tb = first(BLOCK.tsnBatch);
  if (!tb) return { skip: true };
  const tsn = Number(tb[1]);
  // The block states its own batch number. It must be this report's, or the
  // block has been read out of the wrong document — the same cross-check the
  // title and the Batch row already get.
  if (Number(tb[2]) !== Number(batchNo)) {
    return { err: `A transaction at ${block[0]} says it belongs to batch ${tb[2]}, but this report is batch ${batchNo}. Nothing was recorded — photograph the slip instead.` };
  }

  const amt = first(BLOCK.amount);
  if (!amt) return { err: `The transaction at ${block[0]} prints no amount this could read.` };
  const amountCents = parseRandsToCents(tidy(amt[1]));
  if (amountCents === null) {
    return { err: `A transaction's amount reads "${tidy(amt[1])}", which is not an amount this understands. Nothing was recorded — photograph the slip instead.` };
  }

  // The type line repeats the amount ("Purchase ZAR 900.00"). Free integrity:
  // the two must agree, and a disagreement means one of them was misread.
  const ty = first(BLOCK.type);
  const type = ty ? ty[1].toLowerCase() : "purchase";
  if (ty && tidy(ty[2])) {
    const repeat = parseRandsToCents(tidy(ty[2]));
    if (repeat !== null && repeat !== amountCents) {
      return { err: `A transaction at ${block[0]} states two different amounts (${formatCents(amountCents)} and ${formatCents(repeat)}). Nothing was recorded — photograph the slip instead.` };
    }
  }

  // The UTI wraps: "UTI:70db11a9-13f2-4980-8fcd-" then "97cbf50222c5" alone on
  // the next line. Join the continuation when the very next line is a bare
  // fragment and nothing else claims it.
  let uti = null;
  const utiIdx = block.findIndex((l) => BLOCK.uti.test(l));
  if (utiIdx >= 0) {
    uti = tidy(BLOCK.uti.exec(block[utiIdx])[1]);
    // A CONTINUATION ONLY FOLLOWS A LINE THAT WAS CUT MID-VALUE. The real file
    // breaks the UTI inside a group — "UTI:70db11a9-13f2-4980-8fcd-" — so the
    // trailing hyphen is the wrap marker, and requiring it is what stops the
    // join swallowing a neighbouring value.
    //
    // "Bare hex on the next line" is not enough on its own: DIGITS ARE HEX, so
    // an auth code of "932966" sitting under a COMPLETE UTI was appended to it,
    // corrupting the UTI and losing the auth code, with no refusal. It costs no
    // money figure — the amount, TSN and batch are read from their own lines —
    // but it silently weakens the line-level match against the POS legs.
    // (Raised in review of PR #513.)
    const next = block[utiIdx + 1];
    if (uti.endsWith("-") && next && BLOCK.utiTail.test(next)) uti += tidy(next);
  }
  const rrn = first(BLOCK.rrn);
  const auth = first(BLOCK.auth);
  const pan = first(BLOCK.pan);
  const isRefund = type === "refund" || amountCents < 0;

  return {
    txn: {
      tsn, at,
      date: `${block[0].slice(0, 10)}`, time: block[0].slice(11, 19),
      uti: uti || null,
      rrn: rrn ? rrn[1] : null,
      authCode: auth ? auth[1] : null,
      pan: pan ? pan[1] : null,
      type: isRefund ? "refund" : "purchase",
      amountCents: isRefund && amountCents > 0 ? -amountCents : amountCents,
    },
  };
}

/**
 * Read an emailed banking report.
 *
 * @param {string[]} rows  tidied text, one entry per visual line
 * @returns {{ok:true, extraction:object} | {ok:false, reason:string}}
 */
function parseEmailedReport(rows) {
  const bad = (reason) => ({ ok: false, reason });

  // ── identity: the title, cross-checked against the labelled rows ──
  let titleBatch = null, titleTid = null;
  for (const row of rows) {
    const m = EMAILED.title.exec(row);
    if (m) { titleBatch = m[1]; titleTid = m[2]; break; }
  }
  const labelledTid = field(rows, EMAILED.tid);
  const labelledBatch = field(rows, EMAILED.batchNo);

  const rawTid = titleTid ?? labelledTid;
  if (rawTid === null || rawTid === undefined) {
    return bad("That banking report does not state a terminal number anywhere this could find it. If it is the right file, photograph the slip instead.");
  }
  const tid = normaliseTid(rawTid);
  if (!tid) return bad(`"${rawTid}" does not look like a terminal ID.`);

  // The title and the "Terminal:" row must agree. They are the same fact
  // printed twice; disagreeing means one was misread, and picking between them
  // is exactly the guess this path refuses to make.
  if (titleTid && labelledTid && normaliseTid(labelledTid) !== tid) {
    return bad(`That report's title says terminal ${tid} but its Terminal line says ${normaliseTid(labelledTid)}. Nothing was recorded — photograph the slip instead.`);
  }

  const rawBatch = titleBatch ?? labelledBatch;
  if (rawBatch === null || rawBatch === undefined) {
    return bad("That banking report does not state a batch number anywhere this could find it. If it is the right file, photograph the slip instead.");
  }
  const batchNo = normaliseBatchNo(rawBatch);
  if (batchNo === null) return bad(`"${rawBatch}" does not look like a batch number.`);
  if (titleBatch && labelledBatch && normaliseBatchNo(labelledBatch) !== batchNo) {
    return bad(`That report's title says batch ${batchNo} but its Batch line says ${normaliseBatchNo(labelledBatch)}. Nothing was recorded — photograph the slip instead.`);
  }

  // ── the count: "Items: 40", not "Transactions 2" ──
  // EVERY Items row, not the first. A banking report prints one under APPROVED
  // TRANSACTIONS and another under TOTALS SUMMARY, and they state the same
  // fact. Taking the first would quietly prefer one of two disagreeing counts —
  // and this count is what the line-count check measures a missed row against,
  // so getting it wrong defeats that check rather than tripping it. The money
  // fields already refuse on disagreement; there is no reason the count should
  // be treated more loosely than the figures it guards.
  // Where the totals begin, and where the approved list lives. Both are needed
  // before anything is read out of the document, because each scopes a search.
  const totalsRegionIdx = rows.findIndex((r) => EMAILED.totalsSummary.test(r) || EMAILED.cardTotals.test(r));
  const approved = approvedSection(rows, totalsRegionIdx);

  // ONLY THE APPROVED SECTION'S COUNT. A second section states its own, and
  // that is a different fact — see approvedSection. Within the one section a
  // repeated count must still agree, because there it IS the same fact stated
  // twice, and this figure is what the line-count check measures a missed
  // transaction against.
  const itemCounts = [];
  for (const row of rows.slice(approved.from, approved.to + 1)) {
    const m = EMAILED.items.exec(row);
    if (m) itemCounts.push(Number(m[1]));
  }
  if (!itemCounts.length) {
    return bad("That banking report does not print an Items count. If it is the right file, photograph the slip instead.");
  }
  const disagreeing = [...new Set(itemCounts)];
  if (disagreeing.length > 1) {
    return bad(`That report states its Items count more than once and the counts differ (${disagreeing.join(" and ")}). Nothing was recorded — photograph the slip instead.`);
  }
  const txnCount = itemCounts[0];


  // ── THE TRANSACTIONS, WHICH ARE BLOCKS AND NOT ROWS ──
  // Each one occupies eight or nine lines, and the page furniture lands INSIDE
  // them — a "Page 6 of 7" footer sits between a transaction's timestamp and
  // its UTI in the real file. Reading a block means scanning its slice for the
  // fields it carries, so anything else in there is simply ignored.
  // …and so do the transactions. A second section's transactions are not this
  // list's, and counting them would put the roll over the printed Items figure.
  const blocks = collectTxnBlocks(rows.slice(0, approved.to + 1), approved.from);
  const txns = [];
  for (const blk of blocks) {
    const read = readTxnBlock(blk, batchNo);
    if (read.skip) continue;    // a stamp with no TSN under it is not a transaction
    if (read.err) return bad(read.err);
    txns.push(read.txn);
  }

  // ── the figures live in the TOTALS REGION, and nowhere else ──
  // A banking report closes with TOTALS SUMMARY and then CARD TOTALS. Both
  // blocks state the same figures, so the region runs from whichever heading
  // comes first to the end of the document, and moneyField's ambiguity rule
  // refuses them if they ever disagree rather than preferring one.
  //
  // THE SEARCH DOES NOT WIDEN BEYOND IT, and that is the whole point. This is a
  // SEVEN-PAGE document with FNB's address block and page footers interleaved
  // between the transactions, and that furniture is full of money labels
  // followed by digits. An earlier version fell back to searching the whole
  // report for any figure it could not find in the totals block, and a footer
  // reading "Refunds enquiries 0860 12 34 56" was then read as the refunds
  // FIGURE — "enquiries 0860 12 34 56" will not parse, so the entire report was
  // refused. A refunds line printed halfway through page 3 is not this batch's
  // refunds total; absent from the totals region means absent.
  // IF THE TOTALS HEADING IS NOT FOUND, the search falls back to the rows after
  // the LAST TRANSACTION ENDS — never to the whole document. Every one of the
  // forty blocks prints a "Total: ZAR …" and a "Purchase ZAR …" of its own, so
  // an unscoped search meets dozens of disagreeing candidates and refuses the
  // report as ambiguous on the first two it sees, which says nothing useful
  // about what is wrong. (Raised in review of PR #513.)
  //
  // A report with NO recognisable totals heading is still refused — with no
  // heading there is nothing to stop the last transaction's block running to
  // the end of the document and absorbing the totals — but it now refuses by
  // naming the figure it could not find, which is a sentence someone can act
  // on. Recovering such a report properly needs a real example of one.
  const totalsIdx = totalsRegionIdx;
  // AFTER the last block ends, not where it begins: the final transaction
  // carries its own "Total:" and "Purchase" lines, and including them would
  // meet the report's real totals as two disagreeing figures.
  const lastBlock = blocks.length ? blocks.at(-1) : null;
  const afterTxns = lastBlock ? rows.indexOf(lastBlock[0]) + lastBlock.length : 0;
  const totalsRows = totalsIdx >= 0 ? rows.slice(totalsIdx) : rows.slice(afterTxns);
  const money = (re, what, { required }) => {
    // The label-suffix attempt is enabled HERE and nowhere else. These are the
    // few rows of the totals region, where a labelled figure is the only thing
    // that belongs; the printed slip searches its whole document and must not
    // have a looser rule applied to every line of it.
    const found = moneyField(totalsRows, re, what, { allowLabelSuffix: true });
    if (found.missing) {
      return required ? { err: `That banking report does not print a ${what}.` } : { cents: 0 };
    }
    return found;
  };
  const purchases = money(MONEY.purchases, "purchases figure", { required: true });
  if (purchases.err) return bad(purchases.err);
  const total = money(MONEY.total, "TOTAL", { required: true });
  if (total.err) return bad(total.err);
  const refunds = money(MONEY.refunds, "refunds figure", { required: false });
  if (refunds.err) return bad(refunds.err);
  const cash = money(MONEY.cash, "cash figure", { required: false });
  if (cash.err) return bad(cash.err);

  // WHEN THE REPORT WAS PRINTED. Its header carries a bare timestamp of its own
  // — the same DD-MM-YYYY shape as a transaction's — and it is the only moment
  // this format states. It is taken from the rows ABOVE the approved section,
  // so a transaction's own timestamp can never be mistaken for it. On the real
  // file it reads 16:26:31, seventeen minutes after the batch's last sale.
  const headerStamp = rows.slice(0, approved.from)
    .map(parseEmailedStamp).find((v) => v !== null) ?? null;
  if (!txns.length) {
    return bad("No transactions could be read from that banking report. If it is the right file, photograph the slip instead.");
  }


  // ── the window, DERIVED, and said to be derived ──
  // First transaction to last. The +1ms is not padding: the reconciliation
  // window is half-open ([start, end)) so that a batch's closing instant
  // belongs to the NEXT batch, and without it the last transaction of this
  // batch would fall outside its own window.
  const times = txns.map((t) => t.at);
  const openedAt = Math.min(...times);
  const closedAt = Math.max(...times) + 1;

  // …and if the header carried no timestamp of its own, a labelled one.
  const labelledPrinted = field(rows, EMAILED.printed);
  const printedAt = headerStamp
    ?? (labelledPrinted ? parseSlipTimestamp(labelledPrinted) : null);

  return {
    ok: true,
    extraction: {
      mid: field(rows, EMAILED.mid),
      tid, batchNo: String(batchNo),
      openedAt, closedAt, printedAt,
      openedText: null, closedText: null,   // this format prints neither
      txnCount,
      purchasesCents: purchases.cents,
      cashCents: cash.cents,
      refundsCents: Math.abs(refunds.cents),
      totalCents: total.cents,
      reconLine: field(rows, RE.reconLine),
      confidence: null,
      format: "emailed",
      windowSource: "transactions",
      lines: txns,
    },
  };
}

/**
 * Read whichever of the two reports this is.
 *
 * @param {string[]} lines  the PDF's text, one entry per visual line
 * @returns {{ok:true, extraction:object} | {ok:false, reason:string}}
 */
function parseSlipPdf(lines) {
  const rows = (Array.isArray(lines) ? lines : []).map(tidy).filter(Boolean);
  if (!rows.length) {
    return { ok: false, reason: "That PDF has no readable text — it may be a scan rather than the terminal's own file. Photograph the slip instead." };
  }
  const format = detectReportFormat(rows);
  if (format === "emailed") return parseEmailedReport(rows);
  if (format === "printed") return parsePrintedSlip(rows);
  return {
    ok: false,
    reason: "That PDF is neither a terminal batch slip nor an emailed banking report — it carries no TERMINAL ID with a batch number, and no \"Banking Report for Batch … of Terminal …\" title. Check it is the right file, or photograph the slip instead.",
  };
}

module.exports = {
  parseSlipPdf, parsePrintedSlip, parseEmailedReport, detectReportFormat,
  moneyField, looksLikeAmount, STRICT_AMOUNT, TXN_RE, BLOCK,
  sectionStarts, approvedSection,
  parseEmailedStamp, collectTxnBlocks, readTxnBlock, EMAILED, splitTxnMiddle, splitEmailedTxnMiddle, panSpanOf, tidy,
};
