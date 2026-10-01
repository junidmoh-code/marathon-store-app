// ─── WHO IS TOLD, AND ABOUT WHICH HUB — THE ADMIN'S DECISION ─────────────────
// One pure module. It owns the shape of an assignment, the two RTDB paths it
// lives on, and the multi-path update that keeps them in step. It reads nothing
// and writes nothing itself, so every rule in it is unit-testable without a
// database.
//
// ── ABSENCE IS OFF. NOT "UNSET", NOT "DEFAULT", NOT "ASK SOMETHING ELSE" ────
// This is the whole security and correctness model of the feature and it is one
// sentence: a uid with no record under /push_assignments receives nothing.
//
// The model it replaces resolved a person's subscription from their stockRole
// and their destShop, with an explicit preference on top. That was three
// sources of truth for one question, and two of them were fields maintained for
// entirely different reasons — a stock permission grant silently changed who
// got woken up at night. Nothing here reads stockRole, destShop, permissions,
// role, email or any other field. If it is not written here, on purpose, by
// Junid, it is off. `assignedHubs()` is total and takes ONLY the assignment
// record, so there is no field it could be tempted to fall back to.
//
// ── TWO PATHS, ONE WRITE ────────────────────────────────────────────────────
//
//   /push_assignments/{uid}        one bool per hub in PUSH_HUBS, plus
//                                  updatedAt: number. Records written before
//                                  2026-09-08 carry no hub3 child; an absent
//                                  hub reads as false and is never migrated.
//        The DECISION. One record per assigned person, admin-write only. This
//        is what the admin card renders, and the only place the answer to
//        "who did Junid assign?" exists.
//
//   /push_hub_audience/{hub}/{uid} {at: number}
//        The INDEX the fan-out reads. Derived, never authored: it exists so a
//        Cloud Function answering "who is assigned to hub1?" reads ONE tiny
//        node instead of scanning /push_assignments, /users or /push_tokens.
//        Live bandwidth is the largest line on this project's bill and the
//        fan-out runs on every order.
//
// The two are written by ONE multi-path update (assignmentUpdates), so they
// cannot diverge through a half-applied change: RTDB applies a multi-path
// update atomically. A record with no matching index entry would be an
// assignment that silently never fires — exactly the failure mode that looks
// identical to the feature being broken — and an index entry with no record
// would be someone being notified whom the card does not show.
//
// ── THREE HUBS, AND THE LIST IS THE ONLY PLACE THAT SAYS SO ─────────────────
// Hub 1, Hub 2 and Hub 3 (Pine) all pick and dispatch orders, and all three are
// assignable.
//
// Hub 3 was excluded at first on the reasoning that Pine picks on its own
// floor, so an order routed there resolved to nobody by construction. That
// decision is REVERSED (owner, 2026-09-08). It was not a quiet exclusion in
// practice: over the fourteen days to 2026-09-08 the live log holds 714 orders
// placed at hub3, every one of them carrying a real `hub` of "hub3" and a
// destShop of "marathon-pine" — none refused as no_hub or bad_hub, none a
// refill. They passed every guard in the fan-out and arrived at an audience
// node that could never have anybody in it.
//
// The list is CLOSED and it is what makes a CLEAR possible: an update always
// writes every hub in it, setting the assigned ones and NULLING the rest, so a
// person moved from all three hubs to Hub 1 actually stops hearing about the
// other two instead of staying in an index nothing knows to look in. Adding a
// hub here is therefore the ONE edit that adds a hub — the record shape, the
// index writes and the card's switches are all derived from it, so none of
// them can be left behind half-done.

// The hubs an assignment may name, and the words the card puts on them.
export const PUSH_HUBS = Object.freeze(["hub1", "hub2", "hub3"]);
export const PUSH_HUB_LABEL = Object.freeze({ hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3" });

export const PUSH_ASSIGNMENTS_PATH = "push_assignments";
export const pushAssignmentPath = (uid) => `${PUSH_ASSIGNMENTS_PATH}/${uid}`;

export const PUSH_HUB_AUDIENCE_PATH = "push_hub_audience";
export const pushHubAudiencePath = (hub) => `${PUSH_HUB_AUDIENCE_PATH}/${hub}`;
export const pushHubAudienceEntryPath = (hub, uid) => `${PUSH_HUB_AUDIENCE_PATH}/${hub}/${uid}`;

// RTDB refuses ".", "#", "$", "/", "[" and "]" in a key, and the SDK throws
// SYNCHRONOUSLY on one — before any promise exists to catch it. A uid comes
// from Firebase Auth and is safe, but this module builds PATHS out of it and a
// caller could hand it anything (a hand-edited record, a future import script).
// Refusing here turns a crash that would take a whole admin save down with it
// into an assignment that is simply not written. Same lesson as #269.
const ILLEGAL_KEY = /[.#$/[\]]/;

/** Is this string usable as an RTDB path segment? */
export function isLegalKey(v) {
  return typeof v === "string" && v !== "" && !ILLEGAL_KEY.test(v);
}

/**
 * The hubs this person is assigned to. TOTAL: any record shape at all resolves
 * to a defined list, never to a throw and never to a half-formed one.
 *
 * Only a REAL boolean `true` counts. A stray "true", a 1, a null or a missing
 * field are all "not assigned" — because the only write path is the admin card,
 * so anything else in the node is corruption, and corruption must degrade to
 * silence rather than to notifying someone nobody chose.
 *
 * @param {object|null} record /push_assignments/{uid}, or null when absent
 * @returns {string[]} a subset of PUSH_HUBS, in PUSH_HUBS order
 */
export function assignedHubs(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  return PUSH_HUBS.filter((hub) => record[hub] === true);
}

/** Is this person assigned to anything at all? */
export function isAssigned(record) {
  return assignedHubs(record).length > 0;
}

/**
 * The ONE multi-path update that sets a person's assignment: the decision
 * record and every hub's index entry, together.
 *
 * Paths are returned relative to the database ROOT, for `update(ref(db), …)`.
 *
 * An EMPTY hub list deletes the record outright rather than storing a record
 * full of falses. Absence is the off state this whole module is built on, so
 * "off" must produce absence — a record of falses would leave a row on the card
 * that reads as an assignment, and would mean two different representations of
 * the same answer for every later reader to agree about.
 *
 * @param {string} uid
 * @param {string[]} hubs  any subset of PUSH_HUBS; unknown hubs are ignored
 * @param {number} nowMs   serverNowMs(), never Date.now() — updatedAt is
 *        rules-validated and a till's clock is not evidence of anything
 * @returns {object} path → value (null deletes)
 */
export function assignmentUpdates(uid, hubs, nowMs) {
  if (!isLegalKey(uid)) throw new Error(`push assignment: unusable uid "${uid}"`);
  const want = new Set(Array.isArray(hubs) ? hubs.filter((h) => PUSH_HUBS.includes(h)) : []);
  const upd = {};

  // The index FIRST, every hub in the closed list, every time — set or null.
  // Writing only the hubs being turned on is the bug this list exists to
  // prevent: the ones being turned off would keep their entry and keep firing.
  for (const hub of PUSH_HUBS) {
    upd[pushHubAudienceEntryPath(hub, uid)] = want.has(hub) ? { at: nowMs } : null;
  }

  // BUILT FROM PUSH_HUBS, never from a literal. This line used to name hub1
  // and hub2 by hand while the index loop above iterated the list, so the two
  // halves of one write disagreed about what a hub was the moment the list
  // changed: adding Hub 3 would have written a hub3 index entry and an
  // assignment record with no hub3 in it — the person would be notified, and
  // the card would show their Hub 3 switch OFF, which is the one state this
  // module exists to make impossible.
  upd[pushAssignmentPath(uid)] = want.size
    ? PUSH_HUBS.reduce((rec, hub) => { rec[hub] = want.has(hub); return rec; },
                       { updatedAt: nowMs })
    : null;

  return upd;
}
