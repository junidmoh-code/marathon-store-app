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

const { parseSlipTimestamp, parseRandsToCents, normaliseTid, normaliseBatchNo, normaliseMid, formatCents } = require("./card-recon.cjs");

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

/**
 * EVERY line matching `re`, as capture group 1. Used where a second, DIFFERENT
 * reading of the same field is evidence about the file rather than noise.
 */
function fieldAll(lines, re) {
  const out = [];
  for (const line of lines) {
    const m = re.exec(line);
    if (m) out.push(tidy(m[1]));
  }
  return out;
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
 * @param {string[]} lines  the PDF's text, one entry per visual line
 * @returns {{ok:true, extraction:object} | {ok:false, reason:string}}
 */
function parseSlipPdf(lines) {
  const rows = (Array.isArray(lines) ? lines : []).map(tidy).filter(Boolean);
  if (!rows.length) {
    return { ok: false, reason: "That PDF has no readable text — it may be a scan rather than the terminal's own file. Photograph the slip instead." };
  }

  const need = (value, what) => (value === null || value === undefined
    ? { ok: false, reason: `That PDF does not print ${what} anywhere this could find it. If it is the right file, photograph the slip instead.` }
    : null);

  const rawTid = field(rows, RE.tid);
  let bad = need(rawTid, "a terminal ID"); if (bad) return bad;
  const tid = normaliseTid(rawTid);
  if (!tid) return { ok: false, reason: `"${rawTid}" does not look like a terminal ID.` };

  // ── ONE FILE, ONE TERMINAL ───────────────────────────────────────────────
  // The TID is the join key: it decides which till a batch is recorded
  // against. A file that prints TWO different terminal IDs is a file no reader
  // should be picking between — the first match would simply win, silently,
  // and the batch would land on whichever till happened to print first.
  //
  // THIS MATTERS MOST WHERE THERE IS NOBODY TO ASK. On the phone path the
  // manager has already picked a till and a disagreeing slip refuses itself
  // against that pick. A report that arrives by EMAIL has no pick — the TID on
  // the slip IS the routing key — so this internal agreement is what remains
  // of that check, and it must be a refusal rather than a first-match.
  //
  // Only DIFFERING valid readings refuse; a slip that prints its TID in both
  // the header and the footer is the normal case and agrees with itself. A
  // prose row that survived the anchor, the separators-only rule and the
  // digit-in-token rule and yielded a second valid-looking token would refuse
  // a good file — which is the safe direction: the refusal names both
  // readings, and the photo path handles any layout.
  const allTids = [...new Set(fieldAll(rows, RE.tid).map(normaliseTid).filter(Boolean))];
  if (allTids.length > 1) {
    return { ok: false, reason: `That PDF prints more than one terminal ID (${allTids.join(" and ")}), so which till it belongs to cannot be decided. Nothing was recorded — photograph the slip instead.` };
  }

  // ── ONE FILE, ONE MERCHANT ───────────────────────────────────────────────
  // The same rule as the TID above, for the same reason. On the email path the
  // MID is the SECOND identifier the router checks the slip against the
  // registry with — it is what makes "this file is not from this terminal"
  // detectable at all — so a file that states two different merchant ids is a
  // file whose second check means nothing, whichever reading happens to win.
  // Repeated MATCHING readings are the normal case (a slip printing its header
  // twice) and pass. (CodeRabbit, PR #510.)
  const allMids = [...new Set(fieldAll(rows, RE.mid).map(normaliseMid).filter(Boolean))];
  if (allMids.length > 1) {
    return { ok: false, reason: `That PDF prints more than one merchant ID, so which merchant it belongs to cannot be decided. Nothing was recorded — photograph the slip instead.` };
  }

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
      lines: txns,
    },
  };
}

module.exports = { parseSlipPdf, moneyField, TXN_RE, splitTxnMiddle, tidy, field, fieldAll, RE };
