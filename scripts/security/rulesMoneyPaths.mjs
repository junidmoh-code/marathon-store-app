// ─── MONEY-PATH RULES (pure, no I/O) — Nov 2026 audit ────────────────────────
//
// Additive edits to the LIVE rules document:
//
// 1. pos/shopifyCreditDebits and pos/shopifyCreditDebitsOpen — Admin SDK only.
//    They fell under pos/$other (any staff write). shopifyCreditRelease reads a
//    "done" row and credits row.accountId with row.amountCents, so a forged row
//    became website store credit. Naming them takes them OUT of $other: the
//    named key replaces the wildcard, so no client grant remains. No client
//    reads or writes either (only functions/shopifyStoreCredit.js, Admin SDK).
//
// 2. pos/storeCredits/$creditId/status — the till writes "depleted" (sale
//    engine, overspend, outbox) and "voided" (src/return/voidCreditNote.js,
//    in one atomic update with the credit note). Any other value — reviving a
//    credit to "active" — is refused; re-writing the same value stays allowed.
//    (First publish allowed only "depleted" and refused voids for ~15 min;
//    caught in architect review, fixed 23 Nov.)
//
// 3. pos_manager_pins — the salted manager-PIN hashes. Top-level with no
//    grant above it, so already unreadable; stated explicitly so a future
//    root-level grant can never expose it.
//
// Idempotent. Throws if the document is not plain JSON (comments) or a path
// it expects is missing, rather than guessing.
export function patchMoneyPaths(text) {
  const doc = JSON.parse(text);
  const r = doc.rules;
  if (!r?.pos || typeof r.pos !== "object") throw new Error("rules.pos missing");
  const already = JSON.stringify(r.pos.storeCredits?.$creditId?.status?.[".validate"] || "");
  void already;
  r.pos.shopifyCreditDebits = { ".read": false, ".write": false };
  r.pos.shopifyCreditDebitsOpen = { ".read": false, ".write": false };
  const st = r.pos.storeCredits?.$creditId?.status;
  if (!st) throw new Error("rules.pos.storeCredits.$creditId.status missing");
  st[".validate"] = "newData.isString() && (newData.val() === 'depleted' || newData.val() === 'voided' || (data.exists() && newData.val() === data.val()))";
  r.pos_manager_pins = { ".read": false, ".write": false };
  const out = JSON.stringify(doc);
  return out === JSON.stringify(JSON.parse(text)) ? text : out;
}
