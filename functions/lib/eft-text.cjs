// ─── EFT TEXT HELPERS — shared by the poller (ESM) and the callables (CJS) ──
// Three small pure helpers that used to live in scripts/cardrecon (clip in
// intakeCore.mjs; parseBankTimestamp, redactAccountDigits and sastDate in
// eftCore.mjs). The per-bank readers need them, and since 29 Oct 2026 the
// readers run in BOTH places — the mailbox poller on the mini and
// eftPoolManualApprove in Cloud Functions (an owner-uploaded proof of payment
// read by the same reader the poller would use) — so the helpers moved here,
// where either side can require them. The ESM modules re-export them; nothing
// that imported them changed. ONE definition, as with the money parser and
// the fingerprint. PURE: no IO, no clock.
"use strict";

/** Trimmed, capped text — or null for nothing. */
function clip(value, max = 200) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ─── THE BANK'S OWN TIMESTAMP ────────────────────────────────────────────────
// SA is UTC+2 with no daylight saving; the offset is a constant, same as the
// card slips. Only shapes the bank is known to print are accepted; anything
// else is null. (Until fix 8 a null date was cosmetic — the record landed and
// receivedAt carried it. Now the date gates the money: paymentDateVerdict
// refuses a payment whose bank date is null, and receivedAt never stands in.)
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function parseBankTimestamp(str) {
  const s = String(str ?? "").trim();
  if (!s) return null;
  let y, mo, d, h = 0, mi = 0, sec = 0;
  // 2026/08/30 14:41:56 · 2026-08-30 14:41
  let m = /^(\d{4})[/-](\d{2})[/-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    if (m[4]) [h, mi, sec] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  } else if ((m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})h(\d{2})$/.exec(s))) {
    // 2026-08-30 23h48 — Standard Bank's printed shape (real notification,
    // 2026-08-30).
    [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])];
  } else {
    // 30 Aug 2026 · 30 August 2026 14:41
    m = /^(\d{1,2}) ([A-Za-z]{3,9}) (\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (!m) return null;
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    [d, mo, y] = [Number(m[1]), month, Number(m[3])];
    if (m[4]) [h, mi, sec] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  }
  if (d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null;
  const utc = Date.UTC(y, mo, d, h, mi, sec) - SAST_OFFSET_MS;
  // Date.UTC rolls Feb 30 into March; round-trip to refuse the phantom.
  const check = new Date(utc + SAST_OFFSET_MS);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo || check.getUTCDate() !== d) return null;
  return utc;
}

/** The SAST calendar day of a bank timestamp, as the bank would print it. */
function sastDate(ms) {
  return new Date(ms + SAST_OFFSET_MS).toISOString().slice(0, 10);
}

// ─── ACCOUNT NUMBERS DO NOT GET STORED ───────────────────────────────────────
// The notification body can carry the paying account, and the raw text is kept
// with every record precisely so refusals are diagnosable — so anything that
// looks like an account number is struck out on the way in: any run of six or
// more digits keeps its last three and loses the rest. Over-striking is the
// right direction; the cost is a vaguer diagnostic, not a leaked account.
// (The EXTRACTED reference is deliberately not swept: it is the customer's own
// typed matching key — often a phone number — and destroying it would destroy
// the thing the pool exists to search on. It is a field the payer chose to
// write, not a field the bank printed about an account.)
function redactAccountDigits(text) {
  if (typeof text !== "string" || !text) return text;
  // Grouped forms too ("6283 4519 234", "62-834-519") — six or more digits
  // however they are spaced or dashed. This eats grouped AMOUNTS as well,
  // which is the accepted cost: over-striking a diagnostic is fine,
  // under-striking an account is not. (Delta review.)
  //
  // EXCEPT A DATE. "2026-08-30 23h48" is digits joined by dashes and a space,
  // and striking it out of a refusal's raw text deletes the very field the
  // format is judged by. END-ANCHORED, deliberately: a run that merely STARTS
  // like a date ("1234-56-789012", or an account riding one space after a
  // real date) must still be swept — only a run that IS a date (plus at most
  // the hour "23" that a "23h48" contributes before the 'h' breaks the run)
  // is exempt. (Delta review, v2 — the prefix test exempted whole runs.)
  return text.replace(/\d(?:[ -]?\d){5,}/g, (run) =>
    /^\d{4}-\d{2}-\d{2}( \d{2})?$/.test(run) ? run : `⋯${run.replace(/\D/g, "").slice(-3)}`);
}

/**
 * The stored/rendered form of a destination account value. Today's banks print
 * it masked already ("XXXXXXXXXXXX6625") and this changes nothing — but a bank
 * that prints the FULL number must not put a complete account number into the
 * database and onto a screen. Digits beyond the last four become X.
 * (Independent adversarial review, v2.)
 */
function maskAccountValue(value) {
  const s = String(value ?? "");
  if (!s) return null;
  return s.replace(/\d(?=(?:\D*\d){4})/g, "X");
}

// ─── THE NEXT BUSINESS DAY (Junid, 7 Nov 2026) ───────────────────────────────
// A non-immediate EFT made on a weekend is dated by the payer's bank for the
// day it settles: a Saturday Nedbank "Internet payment" prints Monday's date.
// Such a payment is accepted on date grounds; anything dated LATER than the
// next business day is a scheduled payment and is not. Business days skip
// Saturday and Sunday. There is no South African public-holiday list in this
// repo (and no paid calendar service is to be added), so a payment dated the
// day after a public holiday that falls on a Monday is refused as too far out
// — the safe side; Junid floats it by hand.
/** "2026-11-07" (a Saturday) → "2026-11-09"; "2026-11-04" → "2026-11-05". */
function nextBusinessDay(sastDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(sastDay ?? ""));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.toISOString().slice(0, 10) !== sastDay) return null; // 2026-02-31 is no date
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/**
 * Is a payment the bank dates `bankTs` settled on date grounds, judged from
 * `todayMs` (the notification's arrival, or the server's now)? Dated on or
 * before the next business day after today's SAST date: yes.
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
function settlementDateVerdict(bankTs, todayMs) {
  // Fails CLOSED on anything it cannot judge (substitute review of #866).
  if (!Number.isInteger(bankTs) || !Number.isInteger(todayMs)) return { ok: false, reason: "No payment date to judge — not treated as settled." };
  const paidDay = sastDate(bankTs);
  const nbd = nextBusinessDay(sastDate(todayMs));
  if (!nbd || paidDay > nbd) {
    return { ok: false, reason: `Payment dated ${paidDay} — beyond the next business day, not treated as settled.` };
  }
  return { ok: true };
}

module.exports = { clip, parseBankTimestamp, sastDate, redactAccountDigits, maskAccountValue, SAST_OFFSET_MS, nextBusinessDay, settlementDateVerdict };
