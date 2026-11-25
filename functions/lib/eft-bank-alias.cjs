// ─── ONE BANK-NAME NORMALISER FOR EVERY PROOF OF PAYMENT (Junid, 25 Nov 2026) ─
// Each bank prints the BENEFICIARY bank its own way. The R5,900 Absa notice of
// 25 Nov 2026 (bank txn 80DBD74246-1) named Standard Bank "STD S.A." on one copy
// and "STANDARD BANK SA LTD" on the other; the exact-name sets in
// eft-destination.cjs knew neither, and a genuine payment into the shop's own
// Standard Bank account was refused as "Wrong destination account".
//
// This module is the ONE place a printed bank name (or universal branch code)
// becomes a canonical bank id. Everything that compares bank names — the
// poller's destination check, its same-bank immediacy rules, and the owner's
// "Upload approved proof" (eftPoolManualApprove) — goes through it via
// destinationBankOf (eft-destination.cjs).
//
// THE BANK IS SUPPORTING EVIDENCE ONLY. Whether money reached the shop is
// decided on the destination ACCOUNT NUMBER (destinationVerdict); a bank name
// never admits a payment on its own.
//
// Matching: case, punctuation and spacing are ignored ("STD S.A." = "std sa" =
// "STD. SA"), a leading "THE" and a trailing "LTD"/"LIMITED" are dropped, and
// what is left must EQUAL a known form — no substring matching, so "FIRSTRAND
// NAMIBIA" is not FNB. PURE: no IO.
"use strict";

// Canonical id → printed forms, written as people read them. Compared after
// normaliseBankName, so each entry only needs its words, not its punctuation.
const BANK_ALIASES = Object.freeze({
  standardbank: [
    "STANDARD BANK", "STANDARD BANK SA", "STANDARD BANK OF SA", "STANDARD BANK SOUTH AFRICA",
    "STANDARD BANK OF SOUTH AFRICA", "THE STANDARD BANK OF SOUTH AFRICA", "STANDARD BANK SA LTD",
    "SBSA", "STD SA", "STD S.A.", "STD BANK", "STD BANK SA", "STD SOUTH AFRICA",
  ],
  fnb: [
    "FNB", "FIRST NATIONAL BANK", "FIRST NATIONAL BANK SA", "FIRST NATIONAL BANK OF SOUTH AFRICA",
    "FIRSTRAND", "FIRSTRAND BANK", "FNB SA",
  ],
  // The other banks the shop's readers see. They are known so that a payment
  // made TO one of them is refused as another bank, not treated as a name
  // nobody recognises.
  absa: ["ABSA", "ABSA BANK", "ABSA GROUP"],
  capitec: ["CAPITEC", "CAPITEC BANK"],
  nedbank: ["NEDBANK", "NEDBANK SA", "NEDBANK SOUTH AFRICA"],
  investec: ["INVESTEC", "INVESTEC BANK"],
  tymebank: ["TYME", "TYMEBANK", "TYME BANK"],
  discovery: ["DISCOVERY", "DISCOVERY BANK"],
  africanbank: ["AFRICAN BANK"],
  bidvest: ["BIDVEST", "BIDVEST BANK"],
  // Same group, ANOTHER country — another bank, never the shop's.
  fnbnamibia: ["FIRST NATIONAL BANK OF NAMIBIA", "FIRSTRAND NAMIBIA", "FNB NAMIBIA"],
  standardbanknamibia: ["STANDARD BANK NAMIBIA", "STANDARD BANK OF NAMIBIA"],
});

// South African UNIVERSAL branch codes. Absa prints "Bank branch code: 250655".
const BRANCH_CODES = Object.freeze({
  "051001": "standardbank",
  "250655": "fnb",
  "632005": "absa",
  "470010": "capitec",
  "198765": "nedbank",
  "580105": "investec",
  "678910": "tymebank",
  "679000": "discovery",
  "430000": "africanbank",
  "462005": "bidvest",
});

const BANK_LABELS = Object.freeze({
  standardbank: "Standard Bank", fnb: "First National Bank", absa: "Absa", capitec: "Capitec",
  nedbank: "Nedbank", investec: "Investec", tymebank: "TymeBank", discovery: "Discovery Bank",
  africanbank: "African Bank", bidvest: "Bidvest Bank", fnbnamibia: "First National Bank of Namibia",
  standardbanknamibia: "Standard Bank Namibia",
});

/** "The Standard Bank of South Africa Limited" → "STANDARDBANKOFSOUTHAFRICA";
 *  "STD S.A." → "STDSA". Empty string when nothing is left. */
function normaliseBankName(name) {
  const words = String(name ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  if (words[0] === "THE") words.shift();
  while (words.length > 1 && (words[words.length - 1] === "LTD" || words[words.length - 1] === "LIMITED")) words.pop();
  return words.join("");
}

const ALIAS_INDEX = (() => {
  const m = new Map();
  for (const [id, forms] of Object.entries(BANK_ALIASES)) {
    for (const f of forms) {
      const key = normaliseBankName(f);
      if (m.has(key) && m.get(key) !== id) throw new Error(`bank alias "${f}" names two banks`);
      m.set(key, id);
    }
  }
  return m;
})();

/** A universal branch code (spaces/dashes ignored; Standard Bank's
 *  eight-digit "25065500" form reads as its first six) → bank id, else null. */
function bankIdFromBranchCode(code) {
  const digits = String(code ?? "").replace(/[\s-]/g, "");
  if (!/^\d{6}(\d{2})?$/.test(digits)) return null;
  if (digits.length === 8 && !digits.endsWith("00")) return null;
  return BRANCH_CODES[digits.slice(0, 6)] ?? null;
}

/** A printed bank name → canonical id ("standardbank", "fnb", "absa", …), or
 *  null when the name is not one we know. A bare branch code in the name
 *  field reads as that code. */
function bankIdOf(name) {
  const key = normaliseBankName(name);
  if (!key) return null;
  if (/^\d+$/.test(key)) return bankIdFromBranchCode(key);
  return ALIAS_INDEX.get(key) ?? null;
}

module.exports = { BANK_ALIASES, BRANCH_CODES, BANK_LABELS, normaliseBankName, bankIdOf, bankIdFromBranchCode };
