// ─── THE ABSA "STD S.A." NOTICE OF 25 NOV 2026 — A REAL DOCUMENT'S LINES ─────
// The R5,900.00 Absa Notice of Payment (ibreply@absa.co.za, DKIM pass,
// arrived 17:57:37 SAST) that the confirmer refused as "Wrong destination
// account": Absa printed Standard Bank as "STD S.A.". Layout, labels, bank
// name, branch code, amount, date and immediacy are VERBATIM from the real
// notice; the account number, transaction number, payer and reference are
// STAND-INS (this repo is public — no real account numbers or customers).
// The account stands in for the shop's Standard Bank account (…8534), at
// its real length of eleven digits.
"use strict";

const SB_ACCOUNT = "10100008534";
const SB_POLICY = `${SB_ACCOUNT}:standardbank:immediate`;

const lines = ({ bank = "STD S.A.", account = SB_ACCOUNT, branch = "051001", txn = "80D0A0A0A0-1" } = {}) => [
  "25 November 2026",
  "Notice of Payment",
  "Dear CONCRETE",
  "Subject: Notice Of Payment: CONCRETE",
  "Please be advised that MRS A PAYER made a payment to your account as indicated below.",
  `Transaction number: ${txn}`,
  "Payment date:",
  "2026-11-25",
  "Payment made by: MRS A PAYER",
  "Payment made to:",
  "CONCRETE",
  `Beneficiary bank name: ${bank}`,
  `Beneficiary account number: ${account}`,
  `Bank branch code: ${branch}`,
  "For the amount of: 5 900.00",
  "Immediate payment:",
  "Y",
  "Reference on beneficiary statement: customer",
  "View your account to confirm that you have received this payment as the following applies to online banking",
  "payments into non-ABSA and Absa Vehicle and Asset Finance bank accounts.",
  "• Payments made on weekdays before 15:30 will be credited to the receiving bank account by midnight of the same day.",
  "• Payments made on weekdays after 15:30 will be credited by midnight of the following day.",
  "If you need more information or assistance, please call us on 0860008600 or +2711 501 5110 (International calls).",
  "Yours sincerely",
  "General Manager: Digital Channels",
  "Absa Bank Limited Reg No 1986/004794/06 Authorised Financial Services and Registered Credit Provider Reg No NCRCP7 Company Information: www.absa.co.za",
];

module.exports = { SB_ACCOUNT, SB_POLICY, ABSA_STD_SA: lines(), absaStdSa: lines };
