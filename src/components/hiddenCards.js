// ─── PER-USER HIDDEN CARDS ───────────────────────────────────────────────────
// One user, one list of home cards they should not have. Read from
// /users/{uid}/hiddenCards, an array of card keys.
//
// ── WHY THIS EXISTS RATHER THAN A PERMISSION ─────────────────────────────────
// The home cards are gated by GROUPS of access, not one flag each. `Attention`,
// `Total Stock`, `Stock`, `Inventory Health` and `Marketing` all hang off one
// predicate — hasStockAccess — which is true for anyone with `stock_management`
// or a warehouse/admin stockRole. That is deliberate and it is right: they are
// five views of one job.
//
// So "give this person Shopify Publishing but take Attention away" cannot be
// expressed by adding or removing a permission. Removing `stock_management`
// would take Stock, Health and Marketing with it and break the work they
// actually do; adding a new permission per card would mean re-granting it to
// everybody who already has those cards, and getting that wrong hides a card
// from someone who needs it.
//
// A subtractive list is the smaller, safer shape: it changes NOTHING for the
// 32 users who do not have one, and for the one who does it removes exactly
// what it names.
//
// ── IT IS A REAL GATE, NOT A COSMETIC ONE ────────────────────────────────────
// Hiding a tile while leaving the route open is theatre — the role persists in
// localStorage, so a user who opened Attention once would keep landing back on
// it after this "removed" it. So the same function is called in BOTH places,
// exactly as the Engine Policy card is gated twice:
//
//   GATE 1  the tile is not rendered          (RoleSelector)
//   GATE 2  the route refuses and drops home  (the role-reset effect)
//
// The two are independent: deleting either leaves the other working.
//
// ── WHAT IT IS NOT ───────────────────────────────────────────────────────────
// It is not a security boundary and must never be used as one. The database
// rules are what actually stop a write; this only decides what a person is
// shown. Hiding a card from someone who could still write the underlying node
// is tidying, not protection — say so out loud rather than letting a future
// reader assume otherwise.

/** The card keys this user should not be shown. Always an array. */
export function hiddenCardsFor(permRecord) {
  const raw = permRecord && permRecord.hiddenCards;
  if (!raw) return [];
  // RTDB hands an array back as an array when the indices are contiguous and as
  // an object when they are not (an entry removed mid-edit). Both are accepted;
  // anything else is treated as "nothing hidden" rather than throwing on a
  // screen that has to render.
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object"
      ? Object.keys(raw).sort((a, b) => Number(a) - Number(b)).map((k) => raw[k])
      : [];
  return list.filter((k) => typeof k === "string" && k.trim() !== "").map((k) => k.trim());
}

/**
 * Is this card hidden for this user?
 *
 * The super-admin is never subject to a hidden list. That is not a courtesy —
 * it is the recovery path: the account that edits these lists must not be able
 * to lock itself out of the screen it edits them from.
 */
export function isCardHidden(cardKey, permRecord, isSuperAdmin = false) {
  if (isSuperAdmin) return false;
  if (!cardKey) return false;
  return hiddenCardsFor(permRecord).includes(cardKey);
}

/**
 * The ROLE keys a hidden-card list closes off, for the route gate.
 *
 * Card keys and role keys are the same string for every card this is used on
 * (`attention`, `total_stock`, `stock`, …) — the home grid builds tiles keyed
 * by the role they open. Kept as its own function anyway so that the day a card
 * key and a role key diverge, there is one place to say so.
 */
export function isRoleHidden(role, permRecord, isSuperAdmin = false) {
  return isCardHidden(role, permRecord, isSuperAdmin);
}
