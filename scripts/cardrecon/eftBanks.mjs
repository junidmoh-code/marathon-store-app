// ─── PER-BANK PAYMENT-NOTIFICATION READERS — now functions/lib/eft-banks.cjs ─
// The readers lived here from the first (Standard Bank, 30 Aug 2026) until
// 29 Oct 2026, when eftPoolManualApprove in Cloud Functions needed the same
// readers for an owner-uploaded proof of payment. Cloud Functions deploy only
// functions/, and a second copy of a reader is a second place for a wrong
// amount to come from, so the file moved there as CommonJS — every reader,
// comment and fixture verbatim — and this module re-exports it, the way
// eftCore.mjs already borrows the money parser and the fingerprint. The
// poller, the retry scripts and every test import exactly what they did.
//
// ADDING A BANK IS STILL ADDING A READER: in functions/lib/eft-banks.cjs,
// built against a real notification, pinned by a fixture in the tests here.
import { createRequire } from "node:module";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const banks = require("./lib/eft-banks.cjs");

export const { EFT_READERS, selectReader, selectReaderByContent, noReaderReason, standardBankHeading } = banks;
