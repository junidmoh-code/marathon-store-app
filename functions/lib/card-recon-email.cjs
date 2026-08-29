// ─── CARD RECON — ROUTING A SLIP THAT ARRIVED BY EMAIL (PURE) ────────────────
// Terminals and managers email the FNB batch report to the shop's mailbox, and
// a poller on the Mac mini feeds each PDF through the SAME capture callable a
// manager's phone uses. Everything about that capture is unchanged — the exact
// text extraction, the slip arithmetic, the line count against the printed
// Transactions figure, TSN contiguity, the window bounds, the duplicate-batch
// refusal and the append-only transaction. One thing cannot be:
//
//   ON THE PHONE, THE MANAGER PICKS A TILL, AND THE SLIP'S TID MUST MATCH IT.
//   That is the check that stops a slip being recorded against the wrong till.
//   AN EMAIL HAS NOBODY TO ASK. There is no pick, so there is nothing to
//   mismatch: the TID printed on the slip IS the routing key.
//
// A routing key with nothing checking it is a routing key that can be wrong in
// silence, so this module is what the mismatch refusal BECOMES on that path.
// Two independent identifiers are printed on every FNB batch report, and both
// must agree with the registry row before a batch is recorded:
//
//   THE TID       must resolve in /config/cardTerminals to a store and a till.
//                 An unregistered TID is REFUSED — never dropped, never
//                 recorded against a guess. That refusal is the whole point:
//                 a terminal quietly failing to reconcile because nobody
//                 mapped it must be VISIBLE, and the poller records every
//                 refusal with its reason and its source message.
//
//   THE MID       the merchant id, which is registered per terminal. It is not
//                 a shop-wide constant here (the four live terminals carry
//                 three different values, and one carries none), so a slip
//                 whose printed MID contradicts the registered one is a slip
//                 from somewhere else entirely — forwarded, or from a machine
//                 that was re-registered without the registry being updated.
//                 Refused.
//
// WHAT IS MISSING IS A WARNING, NEVER A PASS DISGUISED AS A CHECK. A terminal
// registered without a MID (Trophy Till 1, today) can only be vouched for by
// its TID, and the record says so out loud rather than implying two checks ran
// when one did.
//
// A THIRD CHECK LIVES IN THE PARSER, not here: card-recon-pdf.cjs refuses a
// file that prints two DIFFERENT terminal IDs, so the TID this module routes on
// is the only one the file states.
//
// PURE by the house rule (card-recon.cjs, card-recon-pdf.cjs): no
// firebase-admin, no fetch. Tested in functions/test/card-recon-email.test.cjs.

"use strict";

const { normaliseTid } = require("./card-recon.cjs");

// The permission that opens the email channel, checked on the CALLER — a
// second flag beside `card_recon` rather than a wider grant, so the identity
// the poller runs as can capture unattended without anyone else acquiring a
// path that skips the till pick.
const EMAIL_INTAKE_FLAG = "card_recon_intake";

/**
 * Merchant ids print with leading zeros and are stored the same way, but a
 * terminal re-registered by hand may carry one form and the slip the other.
 * Compared as NUMBERS-ONLY with leading zeros dropped, so "000000004977890"
 * and "4977890" are the same merchant — and anything with no digits at all is
 * not a MID and compares as absent.
 */
function normaliseMid(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "").replace(/^0+/, "");
  return digits || null;
}

/**
 * Decide which till an emailed slip belongs to.
 *
 * @param extraction  the parsed slip (card-recon-pdf.cjs output)
 * @param terminals   /config/cardTerminals, whole
 * @returns {{ok:true, tid:string, terminal:object, warnings:string[]}
 *          |{ok:false, reason:string, tid:string|null, unmapped?:boolean}}
 */
function routeEmailSlip({ extraction, terminals }) {
  const tid = normaliseTid(extraction && extraction.tid);
  if (!tid) {
    return { ok: false, tid: null, reason: "No terminal ID could be read off that PDF, so there is no till to record it against." };
  }
  const registry = terminals || {};
  const terminal = registry[tid];
  if (!terminal || !terminal.storeId || !terminal.tillId) {
    return {
      ok: false, tid, unmapped: true,
      reason: `Terminal ${tid} is not registered under /config/cardTerminals, so this batch has no till to be recorded against. An admin must map it (scripts/seed-card-terminals.mjs) — until then this terminal's slips cannot reconcile.`,
    };
  }

  const warnings = [];
  const registered = normaliseMid(terminal.mid);
  const printed = normaliseMid(extraction.mid);
  if (registered && printed && registered !== printed) {
    return {
      ok: false, tid,
      reason: `That PDF prints merchant ID ${extraction.mid} but terminal ${tid} is registered to merchant ${terminal.mid}. The file is not from this terminal, or the registry is out of date — nothing was recorded.`,
    };
  }
  if (registered && !printed) {
    warnings.push(`Emailed slip: the merchant ID could not be read off the PDF, so only the terminal ID vouches for the till it was recorded against.`);
  }
  if (!registered) {
    warnings.push(`Emailed slip: terminal ${tid} has no merchant ID registered, so only the terminal ID vouches for the till it was recorded against.`);
  }
  return { ok: true, tid, terminal, warnings };
}

module.exports = { routeEmailSlip, normaliseMid, EMAIL_INTAKE_FLAG };
