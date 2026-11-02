// ─── FIX 7a: PAID INTO JUNID'S OWN FNB ACCOUNT (shared) ─────────────────────
// Moved verbatim from scripts/cardrecon/eftCore.mjs on 29 Oct 2026, so that
// eftPoolManualApprove (Cloud Functions) checks an owner-uploaded proof of
// payment's destination with EXACTLY the code the poller checks a bank
// notification's. eftCore.mjs re-exports these; nothing that imported them
// changed. PURE: no IO, no clock.
"use strict";

const { clip } = require("./eft-text.cjs");

// The allowed accounts live in the gitignored .env ON THE MINI as
// EFT_ALLOWED_ACCOUNTS (comma-separated; full numbers) — never in this public
// repo. Cloud Functions read the same value from the Secret Manager secret of
// the same name (eftPool.js).
const EFT_ACCOUNTS_ENV_VAR = "EFT_ALLOWED_ACCOUNTS";

// ─── FIX 7a: PAID INTO JUNID'S OWN FNB ACCOUNT ───────────────────────────────
// accountVerdict above compares only the LAST FOUR digits and never looks at
// the bank: a proof of payment to a Capitec or Absa account that happens to
// end in the same four digits passed. destinationVerdict replaces it in the
// poller and checks BOTH things every reader already parses from the real
// documents (eftBanks.mjs): the destination BANK, which must be FNB by its own
// printed name, and the destination ACCOUNT, which must agree with one of the
// configured FULL account numbers on EVERY digit the document shows — all
// eleven when Capitec or Absa print it whole, seven when FNB shows "..3456625",
// four when Standard Bank masks it. Fewer than four visible digits is
// uncheckable and refuses, as before.
// Absa prints FNB's legal entity instead: "Beneficiary bank name: FIRSTRAND"
// (real Absa notifications, 5 Oct 2026 — the 1 Sep sample printed "FIRST
// NATIONAL BANK"). FNB is a division of FirstRand Bank Limited, and the full
// account number is still checked digit for digit below. Exact names only —
// "FIRSTRAND NAMIBIA" and the like stay refused.
// Since 2 Nov 2026 the bank is the bank OF THE MATCHED ACCOUNT (FNB unless its
// EFT_ALLOWED_ACCOUNTS entry says standardbank — see below), so a payment into
// the shop's Standard Bank account is checked the same way, digit for digit.
const FNB_BANK_NAMES = new Set(["FIRSTNATIONALBANK", "FNB", "FIRSTRAND", "FIRSTRANDBANK", "FIRSTRANDBANKLIMITED"]);

// ─── WHICH BANK EACH ACCOUNT IS AT, AND WHICH TAKE IMMEDIATE ONLY ───────────
// Junid, 2 Nov 2026: the shop is also paid into a STANDARD BANK account
// (ATUGAR TRADING PTY LTD), and that account takes IMMEDIATE payments only —
// a regular EFT into it refuses whatever its date (the date-phased rule,
// eftCore.immediacyVerdict, still governs every other account).
//
// Both facts travel WITH the account number in EFT_ALLOWED_ACCOUNTS, so no
// number ever enters this repo and the two places that read the value (the
// mini's .env, the Secret Manager secret) can never disagree about them:
//
//   62900004321,62000009092,10100008534:standardbank:immediate
//
// An entry is the account's digits (spaces / dashes ignored), then optional
// ":"-tags — a bank ("fnb", the default when none is given, or
// "standardbank") and "immediate" (immediate payments only). An entry with
// any other tag, two banks, or a repeated tag is DROPPED (fail closed: a typo
// must not quietly admit an account at the wrong bank or relax its immediacy)
// and listed by accountPolicyProblems for the poller's start-up line.
// An untagged entry reads exactly as before this change: an FNB account
// under the date-phased rule. A build that pre-dates the tags strips the
// non-digits and sees the same account number, refused at the bank check
// (it accepts FNB only) — never admitted at the wrong bank.
//
// THE DESTINATION IS JUDGED ON THE ACCOUNT NUMBER AND ITS BANK — never on the
// beneficiary NAME a document prints ("ATUGAR TRADING", "Marathon Club", …):
// a name is whatever the payer typed into their beneficiary list.
const ACCOUNT_BANKS = Object.freeze(["fnb", "standardbank"]);
const IMMEDIATE_TAG = "immediate";
// Standard Bank by its own printed name, exact forms only (as FNB above):
// "STANDARD BANK", "The Standard Bank of South Africa Limited", "SBSA".
const STANDARD_BANK_NAMES = new Set([
  "STANDARDBANK", "STANDARDBANKSA", "STANDARDBANKOFSA", "STANDARDBANKOFSOUTHAFRICA",
  "STANDARDBANKOFSOUTHAFRICALIMITED", "THESTANDARDBANKOFSOUTHAFRICALIMITED", "SBSA",
]);
const BANK_LABEL = { fnb: "First National Bank", standardbank: "Standard Bank" };

/** One entry → its policy, or null (and a problem) when it does not read. */
function accountPolicyOf(entry) {
  const [number, ...rawTags] = String(entry ?? "").split(":");
  const account = number.replace(/\D/g, "");
  const tags = rawTags.map((t) => t.trim().toLowerCase());
  if (account.length < 4) return { policy: null, problem: number.trim() || rawTags.length ? "an entry with fewer than four digits" : null };
  const tail = account.slice(-4);
  const banks = tags.filter((t) => ACCOUNT_BANKS.includes(t));
  const unknown = tags.filter((t) => !ACCOUNT_BANKS.includes(t) && t !== IMMEDIATE_TAG);
  if (unknown.length || banks.length > 1 || new Set(tags).size !== tags.length) {
    return { policy: null, problem: `the entry for the account ending ${tail} carries tags that do not read (${tags.join(":") || "empty"}) — use fnb or standardbank, and immediate` };
  }
  return { policy: { account, bank: banks[0] ?? "fnb", immediateOnly: tags.includes(IMMEDIATE_TAG) }, problem: null };
}

/** "62900004321, 10100008534:standardbank:immediate" →
 *  [{account:"62900004321", bank:"fnb", immediateOnly:false},
 *   {account:"10100008534", bank:"standardbank", immediateOnly:true}]
 *  — full digit strings; never logged. Malformed entries are left out. */
function parseAccountPolicies(raw) {
  return String(raw ?? "").split(",").map(accountPolicyOf).map((x) => x.policy).filter(Boolean);
}

/** The entries parseAccountPolicies left out, as sentences with no full
 *  account number in them — for the poller's start-up line. */
function accountPolicyProblems(raw) {
  return String(raw ?? "").split(",").map(accountPolicyOf).map((x) => x.problem).filter(Boolean);
}

/** "62900004321, 6200-000-9092" → ["62900004321","62000009092"] — full digit
 *  strings (at least four digits each); never logged. Tags are read by
 *  parseAccountPolicies; an entry whose tags do not read is left out here too. */
function parseAllowedAccounts(raw) {
  return parseAccountPolicies(raw).map((p) => p.account);
}

/** "FIRST NATIONAL BANK" → "fnb", "STANDARD BANK" → "standardbank", else null. */
function destinationBankOf(destBankName) {
  const bank = String(destBankName ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  if (FNB_BANK_NAMES.has(bank)) return "fnb";
  if (STANDARD_BANK_NAMES.has(bank)) return "standardbank";
  return null;
}

/** A configured entry as a policy: a bare digit string (older callers and
 *  tests) is an FNB account under the date-phased rule. */
function asPolicy(a) {
  if (typeof a === "string") return { account: a, bank: "fnb", immediateOnly: false };
  if (a && typeof a === "object" && typeof a.account === "string" && ACCOUNT_BANKS.includes(a.bank)) {
    return { account: a.account, bank: a.bank, immediateOnly: a.immediateOnly === true };
  }
  return null;
}

/**
 * `allowedAccounts`: parseAccountPolicies(raw) — or bare digit strings, read
 * as FNB accounts.
 * @returns {{ok:true, tail:string, bank:string, immediateOnly:boolean} | {ok:false, reason:string}}
 */
function destinationVerdict({ accountMask, destBankName, allowedAccounts, configured }) {
  const destBank = destinationBankOf(destBankName);
  if (!destBank) {
    return { ok: false, reason: destBankName
      ? `This payment was made to "${clip(destBankName, 60)}", which is not a bank the shop is paid into (its own First National Bank and Standard Bank accounts only).`
      : "The proof of payment does not say which bank the money was paid to, so it cannot be confirmed as paid into one of the shop's own accounts." };
  }
  const visible = String(accountMask ?? "").replace(/\D/g, "");
  if (visible.length < 4) {
    return { ok: false, reason: `The destination account prints as "${clip(accountMask, 40)}" — fewer than four visible digits, so it cannot be checked.` };
  }
  const policies = (Array.isArray(allowedAccounts) ? allowedAccounts : []).map(asPolicy).filter(Boolean);
  if (!policies.length) {
    return { ok: false, reason: configured
      ? `${EFT_ACCOUNTS_ENV_VAR} is set but holds no usable account number. Every payment refuses here until it is fixed.`
      : `No account allowlist is configured — set ${EFT_ACCOUNTS_ENV_VAR} in the .env on the mini (the FULL account number). Until then every payment refuses here, deliberately.` };
  }
  const tail = visible.slice(-4);
  // Only the shop's accounts AT THE BANK THE MONEY WENT TO can vouch for it:
  // a Standard Bank account that happens to end like the FNB one (Standard
  // Bank masks to four digits) is somebody else's.
  const atBank = policies.filter((p) => p.bank === destBank);
  const sameTail = atBank.filter((p) => p.account.endsWith(tail));
  if (!sameTail.length) {
    return { ok: false, reason: atBank.length
      ? `This payment credits a ${BANK_LABEL[destBank]} account ending ${tail}, which is not the shop's own account.`
      : `This payment was made to ${BANK_LABEL[destBank]}, where the shop has no account that takes payments.` };
  }
  // When the document prints the account IN FULL (no mask placeholder), it must
  // EQUAL a configured account exactly — a complete printed number must not pass
  // merely by being the suffix of a longer configured number. Suffix matching is
  // for a genuinely MASKED number (Standard Bank "XXXX…6625", FNB "..776625"),
  // where only the trailing digits are shown. (CodeRabbit, this PR.)
  const masked = /[x*]/i.test(String(accountMask ?? "")) || /\.{2,}/.test(String(accountMask ?? ""));
  const hits = masked
    ? sameTail.filter((p) => p.account.length >= visible.length && p.account.endsWith(visible))
    : sameTail.filter((p) => p.account === visible);
  if (hits.length) {
    // Two of the shop's accounts at one bank sharing every printed digit:
    // the strictest policy among them applies (immediate-only wins).
    return { ok: true, tail, bank: destBank, immediateOnly: hits.some((p) => p.immediateOnly) };
  }
  if (sameTail.every((p) => p.account.length < visible.length)) {
    return { ok: false, reason: `The document prints ${visible.length} digits of the destination account but ${EFT_ACCOUNTS_ENV_VAR} holds only the last ${Math.max(...sameTail.map((p) => p.account.length))} — put the shop's full account number there so every printed digit can be checked.` };
  }
  return { ok: false, reason: `This payment credits an account ending ${tail} whose other printed digits are not the shop's own account.` };
}


module.exports = {
  EFT_ACCOUNTS_ENV_VAR, FNB_BANK_NAMES, STANDARD_BANK_NAMES, ACCOUNT_BANKS,
  parseAllowedAccounts, parseAccountPolicies, accountPolicyProblems, destinationBankOf, destinationVerdict,
};
