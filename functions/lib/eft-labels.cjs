// ─── LABEL-DRIVEN FIELD EXTRACTION, SHARED BY EVERY BANK READER (25 Nov 2026) ─
// Every reader in eft-banks.cjs reads its own bank's layout with its own exact
// rules, and those rules stay first. But a bank that renames "Payment
// reference" to "Reference", or "Bank name" to "Bank", used to cost the whole
// payment: the reader found nothing and the proof dead-ended. This module
// finds a field by its LABEL and the label's synonyms, wherever the line sits,
// with the label and value on the same line or the value on the next one, and
// any whitespace (normal, non-breaking, narrow, tabs). A reader asks it for a
// field ONLY when its own rule found none — it never overrides a value the
// reader read, never settles a contradiction the reader refused, and a value
// it returns must still validate as that kind of field.
//
// AS STRICT AS THE READERS: a label printed twice with DIFFERENT values is a
// contradiction and refuses (never "pick one"); an amount must parse exactly
// with the fuzzed card-recon parser; an account must show at least four
// digits; a date must round-trip (31/02 is no date). The next-line form is
// used only when the label line is bare and the next line is not itself a
// label — FNB's two-column layout puts values ABOVE their labels, so a reader
// can switch the next-line form off (FNB does).
//
// PURE: no IO, no clock.
"use strict";

const { parseBankTimestamp } = require("./eft-text.cjs");
const { parseRandsToCents } = require("./card-recon.cjs");

// Every whitespace a PDF extraction produces, folded to one space.
const flat = (l) => String(l ?? "").replace(/[\u00a0\u2007\u2009\u202f\t\r]/g, " ").replace(/ {2,}/g, " ").trim();

// Label phrases per field. Order within a field is PRIORITY (the first label
// that yields a valid value wins) for the identity-like fields; for the money
// and destination fields every label must agree (see AGREE).
const FIELD_LABELS = {
  amount: ["payment amount", "transaction amount", "amount paid", "for the amount of", "cur/amount", "amount"],
  date: ["payment date and time", "payment date", "date of payment", "transaction date", "date actioned", "date"],
  account: ["beneficiary account number", "recipient account number", "recipient/account no", "beneficiary account no", "account number", "account no"],
  reference: ["beneficiary reference", "recipient reference", "their reference", "payment reference", "reference on beneficiary statement", "reference"],
  txnId: ["skyqr reference", "transaction number", "transaction id", "transaction reference", "trace id", "notification number", "reference number", "unique document no"],
  beneficiary: ["beneficiary name", "recipient name", "payment made to", "recipient"],
  destBank: ["beneficiary bank name", "recipient bank name", "recipient bank", "bank name", "bank"],
};
// Fields where two DIFFERENT values under two different synonyms refuse:
// the money and the destination may never be picked between.
const AGREE = new Set(["amount", "account"]);
// The bare "amount" and "date" labels are too generic to stand in for a
// reader's own missing label (a fee line, a letter date): the readers' fallback
// excludes them (FALLBACK_EXCLUDE, eft-banks.cjs). Detection still uses them.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/ /g, "\\s+");
// "<label>" then a colon, whitespace, or end of line. "Reference" never
// matches "Reference number" / "Reference no" (the bank's id, not the payer's).
function labelRe(label) {
  const guard = label === "reference" ? "(?!\\s*(?:number|no)\\b)" : "";
  return new RegExp(`^${esc(label)}\\.?${guard}(?:\\s*:\\s*|\\s+|$)(.*)$`, "i");
}
const ALL_LABELS = Object.entries(FIELD_LABELS)
  .flatMap(([field, labels]) => labels.map((label) => ({ field, label, re: labelRe(label) })))
  // Longest first: "payment date and time" before "payment date" before "date".
  .sort((a, b) => b.label.length - a.label.length);

/** The ONE label a line starts with (longest wins), or null. */
function labelOf(line) {
  const l = flat(line);
  for (const x of ALL_LABELS) {
    const m = x.re.exec(l);
    if (m) return { ...x, value: m[1].trim() };
  }
  return null;
}
const looksLikeLabel = (line) => !!labelOf(line) || /^[^:]{1,40}:\s*$/.test(flat(line));

// ── VALIDATORS: a value must be that kind of field, or it is no value ───────
const MONEY = /^(?:ZAR|R)\s?\d[\d,\s]*(?:\.\d{1,2})?$|^\d[\d,\s]*\.\d{2}$/i;
function validAmount(v, { nextLine }) {
  const s = flat(v);
  // On the next line a figure must carry its currency mark: a bare number
  // there could be anything (a branch code, a page number).
  if (nextLine ? !/^(?:ZAR|R)\s?\d/i.test(s) : !MONEY.test(s)) return null;
  const cents = parseRandsToCents(s.replace(/^ZAR\s?/i, "R"));
  return cents === null ? null : s;
}
function validAccount(v) {
  const s = flat(v);
  if (!/^[\dXx*.\- ]+$/.test(s)) return null;
  if ((s.match(/\d/g) || []).length < 4) return null;
  return s;
}
function dateOf(v, { dayFirst }) {
  const s = flat(v);
  // ISO and year-first shapes are unambiguous; parseBankTimestamp reads them.
  let m = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:\s+(\d{2})[:h](\d{2})(?::\d{2})?)?$/i.exec(s);
  if (m) return parseBankTimestamp(`${m[1]}-${m[2]}-${m[3]}${m[4] ? ` ${m[4]}:${m[5]}` : ""}`);
  // Day-first only for a bank whose reader says it prints day-first — the
  // date gates the money, so the order of an ambiguous date is never guessed.
  m = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::\d{2})?)?$/.exec(s);
  if (m && dayFirst) return parseBankTimestamp(`${m[3]}-${m[2]}-${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ""}`);
  return null;
}
function validTxnId(v, label) {
  const s = flat(v);
  // "Unique Document No.: 0311406c-… / 903 / V2.0 - 01/11/2024": the id is the
  // first token; the rest is the template's number and version.
  const token = (label === "unique document no" ? s.split(/\s+\/\s+|\s+/)[0] : s);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{3,59}$/.test(token)) return null;
  // A bank's id carries a digit; a word ("Details") is never one.
  if (!/\d/.test(token)) return null;
  if ((token.replace(/[^A-Za-z0-9]/g, "")).length < 4) return null;
  return token;
}
const validText = (v) => { const s = flat(v); return s && /[A-Za-z0-9]/.test(s) && s.length <= 140 && !looksLikeLabel(s) ? s : null; };

/**
 * Every value printed for `field`, label by label, in priority order.
 * @returns {Array<{label:string, value:string}>}
 */
function candidates(lines, field, { nextLine = true } = {}) {
  const out = [];
  const L = Array.isArray(lines) ? lines : [];
  for (let i = 0; i < L.length; i++) {
    const hit = labelOf(L[i]);
    if (!hit || hit.field !== field) continue;
    let value = hit.value, fromNext = false;
    // The next line is a value only if it is not itself a label AND not a
    // "Key : value" line: a blank reference followed by "Paid from Account
    // Holder : J SOAP" stays blank, never becomes that line.
    if (!value && nextLine) {
      const next = flat(L[i + 1]);
      if (next && !looksLikeLabel(next) && !/^[^:]{1,40}\s:/.test(next) && !/^[^:]{1,40}:\s/.test(next)) { value = next; fromNext = true; }
    }
    if (value) out.push({ label: hit.label, value, fromNext });
  }
  const order = FIELD_LABELS[field];
  return out.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
}

/**
 * ONE field, by its labels. `{ok:true, value:null}` when nothing labelled it
 * validly; `{ok:false, why}` on a contradiction.
 * @param {string[]} lines
 * @param {"amount"|"date"|"account"|"reference"|"txnId"|"beneficiary"|"destBank"} field
 * @param {{nextLine?:boolean, dayFirst?:boolean, excludeLabels?:string[]}} [opts]
 * @returns {{ok:true, value:any, label?:string} | {ok:false, why:string}}
 */
function labelledField(lines, field, opts = {}) {
  const { nextLine = true, dayFirst = false, excludeLabels = [] } = opts;
  const valid = [];
  for (const c of candidates(lines, field, { nextLine })) {
    if (excludeLabels.includes(c.label)) continue;
    let v = null;
    if (field === "amount") v = validAmount(c.value, { nextLine: c.fromNext });
    else if (field === "account") v = validAccount(c.value);
    else if (field === "date") { const ts = dateOf(c.value, { dayFirst }); v = Number.isInteger(ts) ? ts : null; }
    else if (field === "txnId") v = validTxnId(c.value, c.label);
    else v = validText(c.value);
    if (v !== null) valid.push({ label: c.label, value: v });
  }
  if (!valid.length) return { ok: true, value: null };
  const keyOf = (v) => (field === "amount" ? parseRandsToCents(flat(v.value).replace(/^ZAR\s?/i, "R"))
    : field === "account" ? String(v.value).replace(/[^\dXx*]/g, "")
      : String(v.value).toUpperCase());
  const pool = AGREE.has(field) ? valid : valid.filter((v) => v.label === valid[0].label);
  const distinct = new Set(pool.map(keyOf));
  if (distinct.size > 1) return { ok: false, why: `the ${field === "txnId" ? "transaction id" : field} appears ${distinct.size} times with different values` };
  return { ok: true, value: pool[0].value, label: pool[0].label };
}

const FIELD_NAMES = {
  amount: "amount", date: "payment date", account: "destination account number",
  reference: "payment reference", txnId: "bank transaction id", beneficiary: "beneficiary name", destBank: "destination bank",
};

/**
 * What the shared extractor can read from a document at all — for the
 * refusal record of a proof nobody could read: which fields were found, which
 * were not. Values are NOT returned (the record holds the redacted raw text);
 * only the field names.
 * @returns {{read:string[], missing:string[]}}
 */
function fieldsSummary(lines, { dayFirst = true } = {}) {
  // `missing` lists only what an approval REQUIRES (amount, destination
  // account, transaction id); the optional date and reference are reported in
  // `read` when found, never as missing.
  const read = [], missing = [];
  for (const f of ["amount", "account", "txnId", "date", "reference"]) {
    const r = labelledField(lines, f, { dayFirst });
    if (r.ok && r.value !== null) read.push(FIELD_NAMES[f]);
    else if (REQUIRED.has(f)) missing.push(FIELD_NAMES[f]);
  }
  return { read, missing };
}
const REQUIRED = new Set(["amount", "account", "txnId"]);

module.exports = { labelledField, fieldsSummary, labelOf, FIELD_LABELS, FIELD_NAMES, flatLine: flat };
