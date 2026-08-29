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
function moneyField(rows, re, what) {
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
    // A LABEL, OR A BROKEN FIGURE? The difference is whether there are digits.
    //
    // "CARD TOTALS" leaves nothing after the label, and "TOTALS SUMMARY" leaves
    // the word SUMMARY — both are section headings the slip prints ABOVE the
    // row that carries the number, and both must be walked past rather than
    // refused. (FNB prints all three of "Payment Type Summary", "TOTALS
    // SUMMARY" and "CARD TOTALS"; the second one refused every such slip until
    // CodeRabbit caught it on PR #509.)
    //
    // A remainder WITH digits is a different thing entirely: it is the figure
    // row, and if it will not parse then the figure is unreadable and the slip
    // is refused. That is what keeps "R5O,307.00" (letter O) a refusal instead
    // of a quiet R5.00 — the distinction is digits, not a list of known
    // headings, because a list would only meet the heading it did not name.
    if (!rest || !/\d/.test(rest)) continue;
    const cents = parseRandsToCents(rest);
    if (cents === null) {
      return { err: `The ${what} reads "${rest}", which is not an amount this understands. Nothing was recorded — photograph the slip instead.` };
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
  "([-(]?\\s*R?\\s*[0-9][0-9,. ]*\\)?)" +          // amount
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
  const itemCounts = [];
  for (const row of rows) {
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

  // ── the figures: the CARD TOTALS block first ──
  // A banking report closes with TOTALS SUMMARY and then CARD TOTALS, and it is
  // the CARD figures this reconciles against the till's card legs. Searching
  // the card block first keeps a same-named line in the earlier block from
  // being read instead; if a figure is not in that block the search widens to
  // the whole report, and moneyField's own ambiguity rule still refuses two
  // rows that disagree.
  const cardIdx = rows.findIndex((r) => EMAILED.cardTotals.test(r));
  const cardRows = cardIdx >= 0 ? rows.slice(cardIdx) : rows;
  const money = (re, what, { required }) => {
    let found = moneyField(cardRows, re, what);
    if (found.missing && cardIdx >= 0) found = moneyField(rows, re, what);
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

  // ── the transaction rows, and the layout decided across all of them ──
  const candidates = [];
  for (const row of rows) {
    const m = TXN_RE.exec(row);
    if (!m) continue;
    const [, date, time, middle, rawAmount, marker] = m;
    candidates.push({ row, date, time, middle, rawAmount, marker });
  }
  if (!candidates.length) {
    return bad("No transaction rows could be read from that banking report. If it is the right file, photograph the slip instead.");
  }
  // See splitEmailedTxnMiddle: a real Batch column carries the batch number on
  // EVERY row, so that is what decides — never the position of a token.
  // TWO CONDITIONS, because one is not enough. A batch column must carry the
  // report's batch number on EVERY row — but on a single-row report that test
  // is satisfied by pure coincidence the moment the one TSN happens to equal
  // the batch number, and the reader then hunts for a sequence number that is
  // not there and refuses a perfectly good report.
  //
  // So the count matters too: a batch column ADDS an integer. A row that has
  // only one usable integer before its PAN has a TSN and nothing else, whatever
  // that integer's value.
  const beforePanOf = (middle) => {
    const parts = tidy(middle).split(" ").filter(Boolean);
    const span = panSpanOf(parts);
    return span ? parts.slice(0, span.start) : parts;
  };
  const intsBeforePan = (middle) => beforePanOf(middle).filter((t) => /^\d{1,8}$/.test(t)).map(Number);

  // ONE MORE TOKEN, on a report with only one row to learn from.
  //
  // Across several rows the batch-number test is decisive: the same value
  // landing in the same position on every row is a column, and a TSN coinciding
  // with the batch number cannot repeat. With a SINGLE row there is no such
  // corroboration, and both readings fit — "TSN then Batch", or "RRN then a TSN
  // that happens to equal the batch number".
  //
  // The token COUNT breaks that tie, because a batch column is an extra column:
  // the layout is UTI, RRN, auth, TSN — four tokens — and a batch column makes
  // five. It is only consulted for the one-row case, where the stronger
  // evidence does not exist; asking it of every report would refuse a terminal
  // that leaves a field blank.
  const hasBatchColumn = candidates.every((c) => {
    const ints = intsBeforePan(c.middle);
    if (ints.length < 2 || ints[ints.length - 1] !== Number(batchNo)) return false;
    return candidates.length > 1 || beforePanOf(c.middle).length >= 5;
  });

  const txns = [];
  for (const c of candidates) {
    const at = parseSlipTimestamp(`${c.date} ${c.time.length === 5 ? `${c.time}:00` : c.time}`);
    if (at === null) return bad(`A transaction row's date and time will not parse: "${c.row}".`);
    const { tsn, pan, uti, rrn, authCode } = splitEmailedTxnMiddle(c.middle, hasBatchColumn);
    if (!Number.isInteger(tsn)) {
      return bad(`A transaction row has no sequence number this could read: "${c.row}".`);
    }
    const amountCents = parseRandsToCents(c.rawAmount);
    if (amountCents === null) {
      return bad(`A transaction row's amount will not parse: "${c.row}".`);
    }
    const isRefund = /^refund$/i.test(c.marker || "") || /\brefund\b/i.test(c.row) || amountCents < 0;
    txns.push({
      tsn, at, date: c.date, time: c.time,
      uti, rrn, authCode, pan,
      type: isRefund ? "refund" : "purchase",
      amountCents: isRefund && amountCents > 0 ? -amountCents : amountCents,
    });
  }

  // ── the window, DERIVED, and said to be derived ──
  // First transaction to last. The +1ms is not padding: the reconciliation
  // window is half-open ([start, end)) so that a batch's closing instant
  // belongs to the NEXT batch, and without it the last transaction of this
  // batch would fall outside its own window.
  const times = txns.map((t) => t.at);
  const openedAt = Math.min(...times);
  const closedAt = Math.max(...times) + 1;

  const printedText = field(rows, EMAILED.printed)
    ?? (rows.slice(0, cardIdx >= 0 ? cardIdx : rows.length).map((r) => EMAILED.bareStamp.exec(r)).find(Boolean) || [])[1]
    ?? null;
  const printedAt = printedText ? parseSlipTimestamp(printedText) : null;

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
  moneyField, TXN_RE, EMAILED, splitTxnMiddle, splitEmailedTxnMiddle, panSpanOf, tidy,
};
