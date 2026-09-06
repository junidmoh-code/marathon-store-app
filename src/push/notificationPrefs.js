// ─── WHO GETS TOLD, AND WHERE THEY GET TOLD ABOUT ────────────────────────────
// One pure function. Given a staff member's /users record and their explicit
// preference (if any), it answers two questions: are they subscribed, and to
// which destinations.
//
// ── DEFAULT ON, NOT OPT-IN ──────────────────────────────────────────────────
// The absence of a /notification_prefs record does NOT mean off. It means "this
// person has never touched the switch", and for the people whose job is picking
// refills — stockRole warehouse and admin — the right answer to that is on.
//
// An opt-in that starts off looks safer and is not. The failure mode of opt-in
// is silent and permanent: a picker who never finds the toggle is never
// notified, believes the feature does not work, and the requests they were
// meant to see sit in a queue nobody opened. The failure mode of default-on is
// a notification someone did not want, which they can switch off in one tap,
// on the same screen they sign out from.
//
// The default is scoped to the two roles that fulfil refills. It is not "on for
// everybody": a POS cashier has no use for a Hub 1 pick.
//
// ── THE DATA IS DIRTY, AND THAT IS THE NORMAL CASE ──────────────────────────
// Of ~31 accounts, 7 carry no stockRole at all and several carry no destShop.
// Every branch below therefore has to be total: a missing field resolves to a
// defined answer, never to a crash and never to a half-formed bucket list. The
// fan-out reads this module's output through an index, so a malformed answer
// here would be a malformed index entry there — the one place where "it threw"
// would become "nobody in that hub was told, and nothing said so".

import { AUDIENCE_ALL, AUDIENCE_BUCKETS } from "./pushConfig";

// The roles whose job includes fulfilling refill requests. These are the two
// that are subscribed by default.
export const DEFAULT_ON_ROLES = Object.freeze(["warehouse", "admin"]);

// Buckets a destination-scoped user may be placed in. `all` is excluded: it is
// the Central wildcard, reached by role, never by a destShop value.
const SCOPED_BUCKETS = new Set(AUDIENCE_BUCKETS.filter((b) => b !== AUDIENCE_ALL));

/**
 * @param {object} args
 * @param {object|null} args.permRecord   /users/{uid}, or null on a read failure
 * @param {object|null} args.prefs        /notification_prefs/{uid}, or null when absent
 * @param {boolean} [args.isSuperAdmin]
 * @returns {{on: boolean, buckets: string[], reason: string}}
 *          `reason` names which rule decided, so the UI can say "on for your
 *          role" rather than just "on", and so a test can tell the two apart.
 */
export function resolvePushSubscription({ permRecord, prefs, isSuperAdmin = false } = {}) {
  // The super-admin's stockRole is not stored on the record — the whole app
  // treats the email as admin — so it is resolved the same way here.
  const role = isSuperAdmin ? "admin" : normalise(permRecord && permRecord.stockRole);
  const roleDefault = DEFAULT_ON_ROLES.includes(role);

  // The explicit setting wins over the role default in BOTH directions: a
  // warehouse picker who switched it off stays off, and a cashier who switched
  // it on stays on. Only a real boolean counts as explicit — a stray string,
  // number or null in the node is treated as "never set", so a malformed write
  // degrades to the default rather than to silence.
  const explicit = typeof (prefs && prefs.refillRequests) === "boolean"
    ? prefs.refillRequests
    : null;

  const on = explicit === null ? roleDefault : explicit;
  if (!on) {
    return { on: false, buckets: [], reason: explicit === false ? "explicit_off" : "role_default_off" };
  }

  return {
    on: true,
    buckets: bucketsFor(role, permRecord),
    reason: explicit === true ? "explicit_on" : "role_default_on",
  };
}

// Which destinations a subscribed user hears about.
function bucketsFor(role, permRecord) {
  // Warehouse and admin pick for EVERY destination, so scoping them to one hub
  // would hide most of their own work from them.
  if (DEFAULT_ON_ROLES.includes(role)) return [AUDIENCE_ALL];

  const destShop = normalise(permRecord && permRecord.destShop);
  if (destShop && SCOPED_BUCKETS.has(destShop)) return [destShop];

  // No destShop, or one this app does not recognise — and the person has
  // explicitly asked to be notified (they cannot be here otherwise, since the
  // role default already returned false above). Over-notifying a volunteer is
  // recoverable in one tap; silently subscribing them to nothing is the bug
  // this whole module exists to avoid, and it would look identical to working.
  return [AUDIENCE_ALL];
}

function normalise(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** The value the toggle writes. Kept here so the UI and the resolver cannot
 *  disagree about the field name. */
export function prefPayload(on, nowMs) {
  return { refillRequests: !!on, updatedAt: nowMs };
}
