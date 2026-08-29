// ─── CARD RECON — batch-slip model, parsing and validation (PURE) ────────────
// The FNB card terminals print a Batch Report at settlement: header (MID, TID,
// batch number, Opened/Closed/Printed timestamps, transaction count), a detail
// roll (one line per transaction: date, time, UTI, RRN, auth code, TSN, masked
// PAN, amount) and totals (purchases, refunds, TOTAL). This module is every
// pure decision the capture feature makes about that slip:
//
//   • timestamp + money parsing (slip prints SAST local time and "R50,355.00")
//   • the record path / duplicate / correction-revision rules
//   • extraction validation: confidence gates, slip arithmetic, the line-count
//     and TSN-contiguity checks that make silent partial capture impossible
//   • the final /card_batches record builder
//
// THE BATCH WINDOW IS NOT A CALENDAR DAY. A batch runs Opened→Closed (roughly
// 18:50 to 18:50 the next evening), so every consumer of this module reconciles
// against those two slip timestamps and never against a trading date.
//
// NO HUMAN EVER TYPES THE CARD TOTAL. Every figure in the record comes from OCR
// of the terminal's own printout; there is deliberately no builder input for a
// hand-entered total, and the validation refuses an extraction whose printed
// figures do not add up rather than letting anyone "fix" them.
//
// PURE by the house rule (style-code-ocr.cjs, product-merge.cjs): no
// firebase-admin, no fetch — IO lives in functions/cardRecon/cardRecon.js.
// Tested in functions/test/card-recon.test.cjs.

"use strict";

// ── PATHS ────────────────────────────────────────────────────────────────────
// /config/cardTerminals/{TID} → { mid, storeId, tillId, label }. Written by a
// stockRole-admin (console rule printed in docs/CARD-RECON.md); read by the
// phone screen to offer the till picker. The TID on the slip is the join key —
// nobody ever selects a cashier, and a slip shot against the wrong till rejects
// itself because its TID maps elsewhere.
const CARD_TERMINALS_PATH = "config/cardTerminals";
// /card_batches/{storeId}/{tid}/{batchKey} — TOP-LEVEL, APPEND-ONLY, written
// only by the callable (Admin SDK).
//
// IT LIVES AT THE TOP LEVEL ON PURPOSE. It used to sit under /pos, where it
// inherited that block's `.read` — "any signed-in, non-anonymous staff member".
// These records are investigation material about named staff: masked PANs, auth
// codes, RRNs, and a per-till variance. The only way to withhold them from
// inside /pos was to rewrite that block's read grant child by child, which is a
// shop-stopping risk on a path three shops trade through. At the top level no
// parent grant reaches them at all, and the live rule is owner-only read AND
// write (the root carries no .read/.write — verified by the merge script, or
// this move would achieve nothing).
//
// The Admin SDK bypasses rules, so the owner-only `.write` is a belt: this
// callable remains the only writer, and its submit transaction still refuses to
// touch an existing key.
const CARD_BATCHES_PATH = "card_batches";
// Two-phase capture: extract parks the parsed slip here, submit promotes it.
// Server-written, short-lived, keyed {uid}/{pushId} — ownership is structural,
// and the extract phase sweeps the caller's own expired drafts (bounded by
// construction: one person holds at most a handful). Top-level and owner-only
// for the same reason as the records: a draft holds the whole parsed roll.
const CARD_BATCH_DRAFTS_PATH = "card_batch_drafts";
const DRAFT_TTL_MS = 2 * 60 * 60 * 1000; // review happens on the spot; 2h is generous

// Slip photos, stored immutably by the callable (Admin SDK — no client write
// path exists in storage.rules): cardRecon/{draftId}/photo-{i}.jpg. A fresh
// draftId per extract means no path is ever written twice.
const PHOTO_STORAGE_PREFIX = "cardRecon";

// ── SLIP TIME ────────────────────────────────────────────────────────────────
// The terminal prints South Africa local time ("2026/08/26 18:50:04"). SA is
// UTC+2 with no daylight saving, so the offset is a constant, not a tz lookup.
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

/** "2026/08/26 18:50:04" (SAST) → epoch ms, or null on anything malformed. */
function parseSlipTimestamp(str) {
  if (typeof str !== "string") return null;
  const m = str.trim().match(/^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const utc = Date.UTC(y, mo - 1, d, h, mi, s) - SAST_OFFSET_MS;
  // Date.UTC silently rolls an invalid day (Feb 30) into the next month —
  // round-trip to catch that instead of recording a phantom timestamp.
  const check = new Date(utc + SAST_OFFSET_MS);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return utc;
}

// ── SLIP MONEY ───────────────────────────────────────────────────────────────
/**
 * "R50,355.00" / "50 355.00" / "-R48.00" / "(R48.00)" → integer cents.
 * Parentheses and a leading minus both mean negative (the refunds line).
 * Returns null on anything that does not parse EXACTLY as an amount — a
 * mangled figure must be refused upstream, never coerced.
 */
function parseRandsToCents(str) {
  if (typeof str === "number" && Number.isFinite(str)) return Math.round(str * 100);
  if (typeof str !== "string") return null;
  let s = str.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  if (s.startsWith("-")) { negative = !negative; s = s.slice(1).trim(); }
  // THE CURRENCY MARK. The terminal's printed slip writes "R50,355.00"; the
  // bank's emailed banking report writes "ZAR 900.00" for the same thing. Both
  // are accepted and nothing else is — the mark is stripped, not skipped over,
  // so "USD 900.00" still refuses rather than being read as 900 rand.
  s = s.replace(/^(?:ZAR|R)\s?/i, "").trim();
  // THOUSAND SEPARATORS MUST GROUP CORRECTLY. Stripping every comma and space
  // before testing accepted "R50,307,00.5" — mis-grouped, and read as
  // R5,030,700.50 rather than refused. This function's whole contract is that a
  // mangled figure is refused and never coerced, so the grouping is part of
  // what must parse: either no separators at all, or 1-3 digits followed by
  // groups of exactly 3. Both "R50,355.00" and "R50 355.00" still pass.
  if (!/^\d+(\.\d{1,2})?$/.test(s) && !/^\d{1,3}([,\s]\d{3})+(\.\d{1,2})?$/.test(s)) return null;
  s = s.replace(/[,\s]/g, "");
  const [rands, cents = "0"] = s.split(".");
  const value = Number(rands) * 100 + Number(cents.padEnd(2, "0"));
  return negative ? -value : value;
}

/** cents → "R1,234.56" (negatives as "-R…"), for reject reasons and the UI. */
function formatCents(cents) {
  if (!Number.isInteger(cents)) return "—";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  // en-US grouping deliberately: the en-ZA locale groups with a non-breaking
  // space, which reads badly in a reject reason on a phone.
  const rands = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}R${rands}.${String(abs % 100).padStart(2, "0")}`;
}

// ── TID / BATCH KEYS ─────────────────────────────────────────────────────────
/** Slip TIDs are fixed-width uppercase alphanumerics ("0000HP1X"). */
function normaliseTid(raw) {
  const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return /^[A-Z0-9]{4,16}$/.test(s) ? s : null;
}

/** Batch numbers print as "#494" — digits only, bounded. */
function normaliseBatchNo(raw) {
  const s = String(raw ?? "").trim().replace(/^#/, "");
  if (!/^\d{1,8}$/.test(s)) return null;
  return String(Number(s)); // strip leading zeros so #0494 and #494 collide
}

// A duplicate batchNo for a TID is REJECTED (same slip shot twice, or a
// re-print). A CORRECTION is a deliberate re-capture: it lands beside the
// original at `{batchNo}-r2`, `-r3`, …, carrying `supersedes`. Nothing is ever
// overwritten — both records stay, and readers take the highest revision.
function batchKeyFor(batchNo, revision) {
  return revision > 1 ? `${batchNo}-r${revision}` : String(batchNo);
}

/**
 * Given the existing children of /card_batches/{storeId}/{tid} and the
 * incoming batchNo, decide the write. Pure — the callable supplies the keys.
 * @returns {{ok:true,key:string,revision:number,supersedes:string|null} |
 *           {ok:false,reason:string}}
 */
function resolveBatchWrite({ existingKeys, batchNo, correction }) {
  const keys = Array.isArray(existingKeys) ? existingKeys : [];
  const revisions = keys
    .map((k) => {
      if (k === String(batchNo)) return 1;
      const m = k.match(new RegExp(`^${batchNo}-r(\\d+)$`));
      return m ? Number(m[1]) : null;
    })
    .filter((r) => r !== null);
  const highest = revisions.length ? Math.max(...revisions) : 0;
  if (highest === 0) {
    // First capture of this batch. A "correction" of a batch never captured is
    // a confusion worth surfacing, not silently accepting.
    if (correction) return { ok: false, reason: `Batch #${batchNo} has not been captured yet — nothing to correct. Submit it normally.` };
    return { ok: true, key: batchKeyFor(batchNo, 1), revision: 1, supersedes: null };
  }
  if (!correction) {
    return { ok: false, reason: `Batch #${batchNo} for this terminal is already captured. If the earlier capture was wrong, resubmit as a correction — both records are kept.` };
  }
  const revision = highest + 1;
  if (revision > MAX_REVISIONS) {
    return { ok: false, reason: `Batch #${batchNo} already has ${highest} captures — this is not a correction chain any more. Talk to the owner.` };
  }
  return { ok: true, key: batchKeyFor(batchNo, revision), revision, supersedes: batchKeyFor(batchNo, highest) };
}

// ── TSN CONTIGUITY ───────────────────────────────────────────────────────────
/**
 * TSNs are sequential within a batch. Sorted, they must run n, n+1, … with no
 * gap and no duplicate — a gap is a MISSING LINE, which is exactly what this
 * feature exists to find, so it is a refusal, never a shrug.
 * @returns {{ok:boolean, gaps:number[], duplicates:number[], first:number|null, last:number|null}}
 */
function checkTsnContiguity(tsns) {
  const nums = (tsns || []).map(Number).filter(Number.isInteger);
  if (!nums.length) return { ok: false, gaps: [], duplicates: [], first: null, last: null };
  const sorted = [...nums].sort((a, b) => a - b);
  const gaps = [], duplicates = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) duplicates.push(sorted[i]);
    else for (let g = sorted[i - 1] + 1; g < sorted[i] && gaps.length < 20; g++) gaps.push(g);
  }
  return { ok: gaps.length === 0 && duplicates.length === 0, gaps, duplicates, first: sorted[0], last: sorted[sorted.length - 1] };
}

// ── LINE DEDUPE — overlapping detail photos, not slip anomalies ──────────────
/**
 * The detail roll is shot in overlapping sections, so the SAME printed line
 * legitimately appears in two photos. Collapse exact repeats (same TSN with the
 * same amount, and the same RRN/UTI where both sides carry one); refuse when
 * one TSN arrives with CONFLICTING readings — that is a misread, and letting
 * either version through silently is exactly the corruption this feature
 * exists to catch.
 * @returns {{ok:true, lines:object[]} | {ok:false, reason:string}}
 */
function dedupeLines(lines) {
  const byTsn = new Map();
  for (const l of lines || []) {
    const tsn = Number(l && l.tsn);
    if (!Number.isInteger(tsn)) return { ok: false, reason: "A transaction line was read without a TSN — reshoot the detail roll." };
    const prev = byTsn.get(tsn);
    if (!prev) { byTsn.set(tsn, l); continue; }
    const conflict =
      prev.amountCents !== l.amountCents ||
      (prev.rrn && l.rrn && prev.rrn !== l.rrn) ||
      (prev.uti && l.uti && prev.uti !== l.uti);
    if (conflict) {
      return { ok: false, reason: `TSN ${tsn} was read twice with different details — reshoot the detail roll so each line is sharp.` };
    }
    // Same printed line, twice — keep the fuller reading.
    const fields = ["uti", "rrn", "authCode", "pan", "date", "time", "at"];
    const fuller = fields.filter((f) => l[f] != null).length > fields.filter((f) => prev[f] != null).length ? l : prev;
    byTsn.set(tsn, fuller);
  }
  return { ok: true, lines: [...byTsn.values()].sort((a, b) => a.tsn - b.tsn) };
}

// ── EXTRACTION VALIDATION ────────────────────────────────────────────────────
// The model reports per-field confidence; these fields are load-bearing enough
// that a shaky read is a retake, not a guess written into evidence.
const MIN_KEY_FIELD_CONFIDENCE = 0.75;
// purchases and the transaction count are load-bearing (they gate the
// arithmetic and the line-count refusal), so they are confidence-gated like
// the total. refunds/cash are NOT in this list — a slip with no refunds line
// legitimately reads as absent with confidence 0 — their protection is the
// strict parse (a garbled figure stays null and is refused below) plus the
// slip arithmetic.
const KEY_FIELDS = ["tid", "batchNo", "totalCents", "openedAt", "closedAt", "purchasesCents", "txnCount"];
// No FNB batch runs a week: a window wider than this is a misread date (or a
// forged draft) and must never become the bounds of a ledger query.
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Corrections are rare, deliberate acts; a chain this long is something else.
const MAX_REVISIONS = 20;

/**
 * Validate one parsed extraction (already through parseSlipTimestamp /
 * parseRandsToCents — every *Cents is an integer, every *At epoch ms).
 *
 * `summaryOnly` skips the line checks but the record it produces is FLAGGED
 * (linesCaptured:false) so downstream can never imply a line match ran.
 *
 * @returns {{ok:true, warnings:string[]} | {ok:false, reason:string}}
 */
function validateExtraction(ex, { summaryOnly = false, source = "photo", format = null } = {}) {
  // The extraction names its own format; the caller may override for a test.
  const reportFormat = format || ex.format || "printed";
  // THE CONFIDENCE GATE IS ABOUT OCR, AND ONLY OCR. A PDF carries the slip's
  // own text, so there is no reading to be uncertain about: either the parser
  // found a field exactly or it refused by name before reaching here. Handing
  // this a fabricated confidence of 1.0 would put a number in the record that
  // no model ever produced, and would sit there for ever looking like evidence.
  //
  // EVERY OTHER CHECK BELOW APPLIES UNCHANGED to both sources — the shape of
  // each figure, the slip's own arithmetic, the 7-day window cap, the line
  // count against the printed Transactions figure, and TSN contiguity.
  if (source !== "pdf") {
    const conf = ex.confidence || {};
    for (const f of KEY_FIELDS) {
      const c = Number(conf[f]);
      if (!Number.isFinite(c) || c < MIN_KEY_FIELD_CONFIDENCE) {
        return { ok: false, reason: `Could not read the slip's ${describeField(f)} confidently — retake that photo in better light.` };
      }
    }
  }
  if (!normaliseTid(ex.tid)) return { ok: false, reason: `"${ex.tid}" does not look like a terminal ID — retake the header photo.` };
  if (normaliseBatchNo(ex.batchNo) === null) return { ok: false, reason: `"${ex.batchNo}" does not look like a batch number — retake the header photo.` };
  for (const f of ["totalCents", "purchasesCents", "refundsCents", "cashCents"]) {
    if (!Number.isInteger(ex[f])) return { ok: false, reason: `The slip's ${describeField(f)} did not read as an amount — retake the totals photo.` };
  }
  // ── THE RECONCILIATION WINDOW ─────────────────────────────────────────────
  // The printed slip declares its own Opened→Closed window. The emailed banking
  // report declares NONE, so its window is derived from the first and last
  // transaction (see parseEmailedReport) and `windowSource` says which it is.
  // The bounds are checked identically either way — a derived window is still
  // capable of being nonsense if a transaction date was misread — but the
  // refusals must not tell someone to re-photograph a header that does not
  // exist on their file.
  // Anything that is not a window the document DECLARED is a derived one, and
  // there are two flavours (see parseEmailedReport). Testing for the absence of
  // "printed" rather than for one named flavour is what stops a third one
  // silently getting the printed slip's wording — which is exactly what
  // happened when "transactions-to-print" was added.
  const derived = ex.windowSource && ex.windowSource !== "printed";
  if (!Number.isInteger(ex.openedAt) || !Number.isInteger(ex.closedAt)) {
    return { ok: false, reason: derived
      ? "The transaction timestamps did not read cleanly, so no reconciliation window could be worked out. Nothing was recorded — photograph the slip instead."
      : "The Opened/Closed timestamps did not read cleanly — retake the header photo." };
  }
  if (ex.closedAt <= ex.openedAt) {
    return { ok: false, reason: derived
      ? "That report's last transaction is not after its first, so no window could be worked out. Nothing was recorded — photograph the slip instead."
      : "The slip's Closed time is not after its Opened time — check the header photo." };
  }
  if (ex.closedAt - ex.openedAt > MAX_WINDOW_MS) {
    return { ok: false, reason: derived
      ? "That report's transactions span more than 7 days, which no single batch does — one of the dates was misread. Nothing was recorded — photograph the slip instead."
      : "The slip's Opened→Closed window is longer than 7 days — one of the dates was misread. Retake the header photo." };
  }
  // Slip arithmetic: purchases + cash − refunds must equal TOTAL. refundsCents
  // is a POSITIVE magnitude by contract (the slip prints it bracketed); both it
  // and cashCents arrive 0 when the slip prints no such line and NULL when the
  // printed figure would not parse — and null was refused by the loop above,
  // so a garbled figure can never be silently treated as zero.
  const cash = ex.cashCents;
  if (ex.purchasesCents + cash - ex.refundsCents !== ex.totalCents) {
    return {
      ok: false,
      reason: `The slip's figures don't add up as read (${formatCents(ex.purchasesCents)} purchases + ${formatCents(cash)} cash − ${formatCents(ex.refundsCents)} refunds ≠ ${formatCents(ex.totalCents)} total) — retake the totals photo.`,
    };
  }
  if (!Number.isInteger(ex.txnCount) || ex.txnCount < 0) {
    return { ok: false, reason: "The printed Transactions count did not read cleanly — retake the header photo." };
  }

  const warnings = [];
  if (summaryOnly) return { ok: true, warnings: ["Summary only — no transaction lines were captured, so no line-level match can run for this batch."] };

  const lines = Array.isArray(ex.lines) ? ex.lines : [];
  if (!lines.length) {
    return { ok: false, reason: "No transaction lines could be read from the detail photos. Reshoot the detail roll, or submit as summary-only." };
  }
  // REFUSE SILENT PARTIAL CAPTURE: the printed Transactions figure is the
  // terminal's own line count, and a shortfall means a photo missed lines.
  if (lines.length !== ex.txnCount) {
    return {
      ok: false,
      reason: `The slip says ${ex.txnCount} transactions but ${lines.length} line${lines.length === 1 ? " was" : "s were"} read. A missing line is exactly what this capture exists to find — reshoot the detail roll so every line is sharp, or submit as summary-only.`,
    };
  }
  // ── TSN CONTIGUITY, AND WHY ONE FORMAT IS EXEMPT ──────────────────────────
  // A DUPLICATE TSN is a mis-parse in any format: the same printed line read
  // twice, or two lines collapsed into one. Always refused.
  //
  // A GAP means different things in the two formats, so it cannot be judged the
  // same way. The terminal's printed roll lists every attempt, so a gap there
  // is a MISSING LINE — the single thing this feature exists to catch. The
  // bank's emailed report lists APPROVED transactions only, so declines and
  // voids leave gaps by design (a real report runs 2,3,4,6,7,8 and skips
  // 21-24, 30-31, 33-34, 43). Refusing those would reject every emailed report
  // ever sent, so gaps are expected there and the line count against the
  // printed Items figure is what guards against a missed row instead.
  const tsn = checkTsnContiguity(lines.map((l) => l.tsn));
  if (tsn.duplicates.length) {
    return { ok: false, reason: `The transaction sequence numbers repeat (TSN ${tsn.duplicates.join(", ")} appears twice) — the same line was read twice. Nothing was recorded.` };
  }
  if (!tsn.ok && reportFormat !== "emailed") {
    return { ok: false, reason: `The transaction sequence numbers are not contiguous (TSN ${tsn.gaps.join(", ")} ${tsn.gaps.length === 1 ? "is" : "are"} missing) — reshoot the detail roll, or submit as summary-only.` };
  }
  if (!tsn.ok) {
    warnings.push(`${tsn.gaps.length} sequence number${tsn.gaps.length === 1 ? "" : "s"} between ${tsn.first} and ${tsn.last} are not in this report (${tsn.gaps.slice(0, 8).join(", ")}${tsn.gaps.length > 8 ? "…" : ""}) — expected on a banking report, which lists approved transactions only.`);
  }
  for (const l of lines) {
    if (!Number.isInteger(l.amountCents)) {
      return { ok: false, reason: `Transaction line TSN ${l.tsn} did not read a clean amount — reshoot that part of the roll.` };
    }
  }
  // The lines' sum SHOULD equal the slip total; a mismatch on a slip whose own
  // totals add up usually means one amount was misread.
  //
  // WHAT HAPPENS NEXT DEPENDS ON WHERE THE FIGURES CAME FROM, and this is the
  // only place the two sources are judged differently besides the confidence
  // gate. On the PHOTO path a mismatch is a warning: a camera genuinely does
  // miss a line, some slips carry reversal artefacts, and refusing would send
  // a manager back to re-shoot a roll that is already correct.
  //
  // On the PDF path there is no such excuse. The text is exact, so lines that
  // do not sum to the printed total mean the PARSER misread one — the fuzzy
  // read the owner's rule forbids. It is refused, and the manager is told to
  // photograph the slip instead. Found by the corruption fuzz in
  // card-recon-pdf-fuzz.test.cjs, which asserts the whole pipeline is exact or
  // refusing and has no third outcome.
  const lineSum = lines.reduce((s, l) => s + l.amountCents, 0);
  if (lineSum !== ex.totalCents) {
    if (source === "pdf") {
      return {
        ok: false,
        reason: `The transaction lines in that PDF add up to ${formatCents(lineSum)}, but the slip's own total is ${formatCents(ex.totalCents)}. A PDF is read exactly, so this means a line was misread rather than mis-photographed — nothing was recorded. Photograph the slip instead.`,
      };
    }
    warnings.push(`The captured lines sum to ${formatCents(lineSum)} but the slip total is ${formatCents(ex.totalCents)} — check the detail photos against the record.`);
  }
  return { ok: true, warnings };
}

function describeField(f) {
  return {
    tid: "terminal ID", batchNo: "batch number", totalCents: "card TOTAL",
    purchasesCents: "purchases figure", refundsCents: "refunds figure",
    cashCents: "cash figure", txnCount: "Transactions count",
    openedAt: "Opened time", closedAt: "Closed time",
  }[f] || f;
}

// ── RECORD BUILDER ───────────────────────────────────────────────────────────
/**
 * The final /card_batches record. `expected` comes from the server-side
 * calculator (lib/card-expected.cjs) — the client never supplies it — and
 * variance is DERIVED here, in one place: slip total − expected card takings.
 * `submittedAt` is the caller's serverNowMs; nothing here reads a clock.
 */
function buildBatchRecord({
  extraction, terminal, tid, batchKey, revision, supersedes,
  photoPaths, summaryOnly, warnings, expected, cashiers, match = null,
  submittedBy, submittedAt, draftId, ocr,
  // "pdf"  — read from the terminal's own emailed file, text extracted exactly
  // "photo" — photographed and OCR'd
  // Recorded so a batch's provenance is visible without inferring it from
  // whether `ocr` happens to be null.
  capturedVia = "photo",
  pdfPath = null,
}) {
  const lines = summaryOnly ? null : Object.fromEntries(
    (extraction.lines || []).map((l) => [String(l.tsn), {
      tsn: Number(l.tsn),
      at: l.at ?? null,                    // epoch ms when date+time parsed
      date: l.date ?? null, time: l.time ?? null, // as printed, always kept
      uti: l.uti ?? null, rrn: l.rrn ?? null,
      authCode: l.authCode ?? null, pan: l.pan ?? null,
      type: l.type ?? "purchase",
      amountCents: l.amountCents,
    }]),
  );
  return {
    batchNo: Number(normaliseBatchNo(extraction.batchNo)),
    batchKey, revision, supersedes: supersedes ?? null,
    tid, mid: extraction.mid ?? null,
    storeId: terminal.storeId, tillId: terminal.tillId,
    terminalLabel: terminal.label ?? null,
    slip: {
      openedAt: extraction.openedAt, closedAt: extraction.closedAt,
      printedAt: extraction.printedAt ?? null,
      openedText: extraction.openedText ?? null, closedText: extraction.closedText ?? null,
      txnCount: extraction.txnCount,
      purchasesCents: extraction.purchasesCents,
      cashCents: Number.isInteger(extraction.cashCents) ? extraction.cashCents : 0,
      refundsCents: extraction.refundsCents,
      totalCents: extraction.totalCents,
      reconLine: extraction.reconLine ?? null,
      // WHICH REPORT THIS CAME OFF, and where its window came from. The
      // terminal's printed slip declares Opened/Closed; the bank's emailed
      // banking report declares neither, so its window is the span of its own
      // transactions. Recorded rather than inferred, so nobody reading this
      // batch later mistakes a derived window for a declared one — or wonders
      // why its TSNs have gaps.
      format: extraction.format ?? "printed",
      windowSource: extraction.windowSource ?? "printed",
    },
    confidence: extraction.confidence ?? null,
    lines,
    linesCaptured: !summaryOnly,
    lineCount: summaryOnly ? 0 : (extraction.lines || []).length,
    warnings: warnings && warnings.length ? warnings : null,
    photos: photoPaths,
    expected: {
      cardCents: expected.cardCents,
      legs: expected.legs,
      byKind: expected.byKind,
      windowStartMs: extraction.openedAt,
      windowEndMs: extraction.closedAt,
      // Card legs for this till sitting just OUTSIDE the window — only ever
      // non-zero on a derived window, where there is no printed slack. They are
      // NOT in cardCents; they are here so a variance can be read honestly.
      nearEdgeLegs: expected.nearEdgeLegs ?? 0,
      nearEdgeCents: expected.nearEdgeCents ?? 0,
      // Legs inside the window but after the report's last transaction. These
      // ARE in cardCents; they are broken out so a variance can be read
      // honestly — see the tail note in lib/card-expected.cjs.
      tailLegs: expected.tailLegs ?? 0,
      tailCents: expected.tailCents ?? 0,
    },
    // ── WHAT COULD BE ACCOUNTED FOR, WHEREVER IT WAS RUNG ──────────────────
    // The subtraction above is scoped to the till this terminal is MAPPED to.
    // The machines move: a speedpoint spent a morning at another shop and its
    // sales were rung on that shop's till, so the subtraction called R3,500 of
    // perfectly good takings missing. The match follows the money instead.
    match: match ? {
      matchedLegs: match.matches.length,
      matchedCents: match.matchedCents,
      onTillCents: match.onTillCents,
      offTillCents: match.offTillCents,
      // Where the work was rung when it was not on this terminal's own till,
      // so "the machine was at Trophy that morning" reads off the record.
      offTill: Object.keys(match.offTill).length ? match.offTill : null,
      // Money the machine took that no sale accounts for — the finding.
      unmatchedTxns: match.unmatchedTxns.length,
      unmatchedTxnCents: match.unmatchedTxnCents,
      // …and card sales on this till that the machine has no record of. A
      // different error, deliberately NOT netted off against the first.
      unmatchedLegs: match.unmatchedLegsOnTill.length,
      unmatchedLegCents: match.unmatchedLegCents,
    } : null,
    // THE FINDING. Money on the machine that no sale accounts for — which is
    // exactly `match.unmatchedTxnCents`, since a matched leg carries the same
    // amount as the transaction it answers. Where no match could run (a
    // summary-only capture has no transactions), this falls back to the old
    // till-scoped subtraction.
    varianceCents: match
      ? extraction.totalCents - match.matchedCents
      : extraction.totalCents - expected.cardCents,
    // The old subtraction, kept so a batch reconciled before the match existed
    // stays comparable with one reconciled after.
    varianceOnTillCents: extraction.totalCents - expected.cardCents,
    cashiers: cashiers && cashiers.length ? cashiers : null,
    submittedBy, submittedAt, draftId,
    ocr: ocr ?? null, // { model, tokensIn, tokensOut, costUSD } — provenance
    capturedVia,
    pdfPath: pdfPath ?? null,
  };
}

// ─── WHICH SOURCE IS THIS SUBMISSION? ────────────────────────────────────────
// ONE PATH PER SUBMISSION. A PDF is the whole slip in one file — header, totals
// and detail roll together — so there is no detail/summary split on that path
// and no sense in mixing two sources into one record.
//
// This is a PURE decision and it lives here, alone, for one reason: the answer
// is used twice — once to route the extract, and again to stamp `capturedVia`
// on the record the owner reads to tell a PDF batch from a photographed one.
// Two literals in two places drift; one function does not.
function chooseCaptureSource({ photos, pdf, maxPhotos }) {
  const hasPdf = !!(pdf && typeof pdf.base64 === "string" && pdf.base64);
  const hasPhotos = Array.isArray(photos) && photos.length > 0;
  if (hasPdf && hasPhotos) return { err: "Send the PDF or the photos, not both." };
  if (!hasPdf && !hasPhotos) return { err: "Add the terminal's PDF, or photograph the slip." };
  if (hasPhotos && photos.length > maxPhotos) return { err: `Too many photos — ${maxPhotos} at most.` };
  return { source: hasPdf ? "pdf" : "photo" };
}

// ─── IS THIS ACTUALLY A PDF, AND DID IT ARRIVE INTACT? ───────────────────────
// Pure so it can be attacked with the payloads that matter: a renamed photo, a
// truncated upload, an empty file, one too large to be a batch report. Every
// refusal is a sentence; none is a transport error.
//
// The magic bytes decide, not the file name. "%PDF-" is the header every PDF
// carries, so a JPEG renamed .pdf is refused HERE rather than deep inside a
// parser where the reason would be unreadable.
function readPdfPayload(base64, maxBytes) {
  const cleaned = String(base64 || "").replace(/^data:application\/pdf;base64,/i, "").replace(/\s/g, "");
  if (!cleaned || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    return { err: "That file did not arrive intact — try again." };
  }
  const buffer = Buffer.from(cleaned, "base64");
  if (!buffer.length) return { err: "That file is empty." };
  if (buffer.length > maxBytes) {
    return { err: `That file is ${(buffer.length / 1048576).toFixed(1)}MB — too large for a batch report. Check it is the right file.` };
  }
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return { err: "That file is not a PDF. Attach the terminal's emailed batch report, or photograph the slip.", reject: true };
  }
  return { buffer };
}

module.exports = {
  CARD_TERMINALS_PATH, CARD_BATCHES_PATH, CARD_BATCH_DRAFTS_PATH, DRAFT_TTL_MS,
  PHOTO_STORAGE_PREFIX, SAST_OFFSET_MS,
  MIN_KEY_FIELD_CONFIDENCE, MAX_WINDOW_MS, MAX_REVISIONS,
  parseSlipTimestamp, parseRandsToCents, formatCents,
  normaliseTid, normaliseBatchNo, batchKeyFor, resolveBatchWrite,
  checkTsnContiguity, dedupeLines, validateExtraction, buildBatchRecord,
  chooseCaptureSource, readPdfPayload,
};
