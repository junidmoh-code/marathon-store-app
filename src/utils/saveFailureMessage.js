// ─── WHAT THE OPERATOR SEES WHEN A PRODUCT SAVE FAILS ─────────────────────────
// The old catch block showed "Failed to save product. Please try again." for
// anything it did not recognise — which swallowed the real error, so a save
// that could NEVER succeed (a rules rejection, a payload the SDK refuses)
// looked identical to a network blip and staff just kept retrying. This module
// is the one place that turns a save failure into the message the operator
// reads, and its contract is:
//
//   • an error flagged showToOperator (see operatorError) IS the message —
//     it was written for a person, show it verbatim;
//   • a recognised failure class gets its instruction ("ask an admin to check
//     your access"), not just a diagnosis;
//   • everything else still shows the underlying error text. NOTHING is
//     swallowed — "show this to an admin" beats "please try again", which
//     tells the admin nothing when they are eventually asked.
//
// Matching is on the SDK's stable error codes/tokens (permission_denied,
// network/timeout), never on prose meant for humans — prose-matching is how
// the style-code claim messages were lost (PR #312).

/** The operator-facing alert body for a failed product save. */
export function saveFailureMessage(err) {
  if (err?.showToOperator) return `Failed to save product:\n${err.message}`;

  const raw = String(err?.message || err || "unknown error");
  const code = String(err?.code || "");

  if (/permission[_ ]denied/i.test(`${code} ${raw}`)) {
    return (
      "Failed to save product: the database refused the write (permission denied).\n\n" +
      "Your account is missing access for part of this save — ask an admin to check " +
      "your permissions (stock writes need stock access on your user record).\n\n" +
      `Technical detail for the admin:\n${raw}`
    );
  }
  if (/network|offline|disconnected|timeout|unavailable/i.test(`${code} ${raw}`)) {
    // A network failure does NOT prove the write was lost — RTDB can commit it
    // server-side without the client ever seeing the acknowledgement, and a
    // blind re-save then creates a duplicate product and burns another
    // sku/barcode pair. Say the outcome is unknown and make checking first the
    // instruction. (CodeRabbit, PR #327.)
    return (
      "Failed to save product: network problem while writing.\n\n" +
      "The save may or may not have gone through. Check the product list for it first — " +
      "only save again if it is NOT there, or you will create a duplicate.\n\n" +
      `Technical detail for the admin:\n${raw}`
    );
  }
  return (
    "Failed to save product.\n\n" +
    "This does not look like a temporary problem — retrying alone is unlikely to fix it. " +
    "Show this to an admin:\n" +
    raw
  );
}
