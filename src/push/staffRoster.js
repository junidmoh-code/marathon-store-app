// ─── WHICH ACCOUNTS BELONG ON THE ORDER ALERTS LIST ──────────────────────────
// One pure predicate and its justification. It reads nothing and writes
// nothing, so every claim below is unit-testable without a database.
//
// ── THE DEFAULT IS "SHOW IT" ────────────────────────────────────────────────
// The Order alerts card exists to make a decision about every person who might
// need to hear about an order, and the accounts most likely to need that
// decision are the sparse ones — of 35 accounts, 9 carry no stockRole at all
// and several carry no destShop. Under the model this replaced they had no role
// default, so nothing resolved for them and nobody could tell. Filtering the
// list by any field would hide exactly the people the screen exists for.
//
// So this module hides an account only when it can POSITIVELY identify it as
// something that is not a person who uses this app. Ambiguity shows the row.
// Absence of a field is never evidence.
//
// ── WHAT A POS-ONLY ACCOUNT ACTUALLY LOOKS LIKE ─────────────────────────────
// The tills are a separate app (marathon-pos-app) sharing this Firebase
// project, and creating a till login writes a record under /users here:
//
//   "58ayGw6WJAabRpH4j6EspZNGKrk2": {
//     "stockRole": "pos",
//     "posAccess": { "role": "cashier", "displayName": "yasmin", … }
//   }
//
// Two of the nine live ones are barer still — `{ "stockRole": "pos" }` and
// nothing else — because marathon-pos-app's removePosUser deletes ONLY the
// posAccess child and leaves the /users record behind. So posAccess cannot be
// required by the test either; a revoked till is still a till.
//
// What every one of them shares is what is ABSENT: no displayName, no
// username, no role, no permissions, no permFlags — no store-app identity of
// any kind. The card renders `displayName || username || uid`, so today these
// appear as nine rows named after a raw Firebase uid.
//
// ── WHY stockRole === "pos" IS NOT ON ITS OWN THE TEST ──────────────────────
// It is the obvious discriminator and it is WRONG. Ten accounts carry
// stockRole "pos"; one of them is Zee — username "zee", role "admin", destShop
// "marathon-pe", eight permissions, permFlags. A real person who works here and
// happens to carry that stock role. Hiding Zee from the screen that decides who
// gets woken up, on the strength of one field, is precisely the silent
// misfiling this feature was rebuilt to stop.
//
// The test is therefore a CONJUNCTION: the POS stock role AND the complete
// absence of a store-app identity. Both halves are load-bearing. The second
// half alone would be wrong too — an account with no identity fields and no
// "pos" role is a sparse human account, which is a row this screen must show.
//
// ── posAccess IS NOT THE DISCRIMINATOR EITHER ───────────────────────────────
// Nine accounts carry `posAccess`, but two of them are Ahmed and Amanda — staff
// who use both apps. `posAccess` means "can also work a till", not "is a till".

/** The stockRole a till login is created with by marathon-pos-app. */
export const POS_STOCK_ROLE = "pos";

/**
 * Does this record show ANY sign of being a person who uses the store app?
 *
 * Deliberately generous. Every one of these fields is written by the store
 * app's own user management for a human account, and any single one of them is
 * enough to keep the row. Being generous here is the safe direction: the cost
 * of a wrong `true` is one extra row on an admin screen, and the cost of a
 * wrong `false` is a member of staff who can never be assigned.
 */
export function hasStoreAppIdentity(rec) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return false;
  if (rec.displayName || rec.username || rec.name || rec.email) return true;
  if (rec.role) return true;
  if (rec.permFlags && typeof rec.permFlags === "object") return true;
  if (Array.isArray(rec.permissions) ? rec.permissions.length > 0 : !!rec.permissions) return true;
  if (rec.destShop) return true;
  // stockRole is NOT in this list on purpose: "pos" is a stockRole, so counting
  // any stockRole as an identity would make the predicate below unsatisfiable.
  return false;
}

/**
 * Is this account positively identifiable as a till login and nothing else?
 *
 * TOTAL: any shape of input answers false rather than throwing. False is the
 * answer that keeps a row, so a record this cannot make sense of stays on the
 * screen, labelled exactly as it is.
 *
 * @param {object|null} rec a /users/{uid} record
 * @returns {boolean} true only for POS-only accounts
 */
export function isPosOnlyAccount(rec) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return false;
  return rec.stockRole === POS_STOCK_ROLE && !hasStoreAppIdentity(rec);
}

/**
 * Split a roster into the rows the card shows and the count it hid.
 *
 * A hidden account that IS ALREADY ASSIGNED stays visible. A row you cannot see
 * is a row you cannot switch off, and an assignment nobody can see or reach is
 * the exact failure this feature is built to make impossible. This should never
 * fire — a till login has no browser to be assigned from — which is why it is
 * cheap to guarantee rather than to reason about.
 *
 * The guarantee is only as good as `hubs`, and the caller passes [] for every
 * row when the assignment read FAILED — so in that state an assigned till
 * would still be hidden. That is not a hole this function can close: the whole
 * screen is showing "not known" there, it says so in a banner, and its
 * switches are locked.
 *
 * @param {Array<{uid: string, record: object|null, hubs: string[]}>} candidates
 * @returns {{visible: typeof candidates, hiddenPosOnly: number}}
 */
export function partitionRoster(candidates) {
  const visible = [];
  let hiddenPosOnly = 0;
  for (const c of candidates || []) {
    const assigned = Array.isArray(c && c.hubs) && c.hubs.length > 0;
    if (!assigned && isPosOnlyAccount(c && c.record)) { hiddenPosOnly += 1; continue; }
    visible.push(c);
  }
  return { visible, hiddenPosOnly };
}
