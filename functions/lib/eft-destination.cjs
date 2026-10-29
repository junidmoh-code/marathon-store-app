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
const FNB_BANK_NAMES = new Set(["FIRSTNATIONALBANK", "FNB", "FIRSTRAND", "FIRSTRANDBANK", "FIRSTRANDBANKLIMITED"]);

/** "62900004321, 6200-000-9092" → ["62900004321","62000009092"] — full digit
 *  strings (at least four digits each); never logged. */
function parseAllowedAccounts(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.replace(/\D/g, ""))
    .filter((digits) => digits.length >= 4);
}

/**
 * @returns {{ok:true, tail:string} | {ok:false, reason:string}}
 */
function destinationVerdict({ accountMask, destBankName, allowedAccounts, configured }) {
  const bank = String(destBankName ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  if (!FNB_BANK_NAMES.has(bank)) {
    return { ok: false, reason: destBankName
      ? `This payment was made to "${clip(destBankName, 60)}", not to First National Bank — the shop is paid only into its own FNB account.`
      : "The proof of payment does not say which bank the money was paid to, so it cannot be confirmed as paid into the shop's FNB account." };
  }
  const visible = String(accountMask ?? "").replace(/\D/g, "");
  if (visible.length < 4) {
    return { ok: false, reason: `The destination account prints as "${clip(accountMask, 40)}" — fewer than four visible digits, so it cannot be checked.` };
  }
  if (!Array.isArray(allowedAccounts) || !allowedAccounts.length) {
    return { ok: false, reason: configured
      ? `${EFT_ACCOUNTS_ENV_VAR} is set but holds no usable account number. Every payment refuses here until it is fixed.`
      : `No account allowlist is configured — set ${EFT_ACCOUNTS_ENV_VAR} in the .env on the mini (the FULL account number). Until then every payment refuses here, deliberately.` };
  }
  const tail = visible.slice(-4);
  const sameTail = allowedAccounts.filter((a) => a.endsWith(tail));
  if (!sameTail.length) {
    return { ok: false, reason: `This payment credits an account ending ${tail}, which is not the shop's own account.` };
  }
  // When the document prints the account IN FULL (no mask placeholder), it must
  // EQUAL a configured account exactly — a complete printed number must not pass
  // merely by being the suffix of a longer configured number. Suffix matching is
  // for a genuinely MASKED number (Standard Bank "XXXX…6625", FNB "..776625"),
  // where only the trailing digits are shown. (CodeRabbit, this PR.)
  const masked = /[x*]/i.test(String(accountMask ?? "")) || /\.{2,}/.test(String(accountMask ?? ""));
  const matches = masked
    ? sameTail.some((a) => a.length >= visible.length && a.endsWith(visible))
    : sameTail.some((a) => a === visible);
  if (matches) return { ok: true, tail };
  if (sameTail.every((a) => a.length < visible.length)) {
    return { ok: false, reason: `The document prints ${visible.length} digits of the destination account but ${EFT_ACCOUNTS_ENV_VAR} holds only the last ${Math.max(...sameTail.map((a) => a.length))} — put the shop's full account number there so every printed digit can be checked.` };
  }
  return { ok: false, reason: `This payment credits an account ending ${tail} whose other printed digits are not the shop's own account.` };
}


module.exports = { EFT_ACCOUNTS_ENV_VAR, FNB_BANK_NAMES, parseAllowedAccounts, destinationVerdict };
