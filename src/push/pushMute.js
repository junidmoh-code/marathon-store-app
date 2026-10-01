// ─── THE MUTE — THE ONE THING A STAFF MEMBER CONTROLS ────────────────────────
// One pure module. It owns the shape of a mute record, its RTDB path, and the
// update that sets and clears it. It reads nothing and writes nothing itself,
// so every rule in it is unit-testable without a database.
//
// ── A MUTE IS A VETO. IT IS NOT A SUBSCRIPTION ──────────────────────────────
// This is the whole model and it is two sentences:
//
//   Junid's assignment decides WHICH HUBS a person hears about. It is the only
//   thing that grants anything, it lives on /push_assignments and
//   /push_hub_audience, and both are super-admin-write-only.
//
//   The mute decides whether that person's own phone stays quiet. It is the
//   only thing a staff member can write, it lives here, and it can only ever
//   REMOVE somebody from a send.
//
// Recipients are the AND of the two: assigned, and not muted. Neither half can
// stand in for the other. A person who mutes themselves and is then assigned to
// three hubs still hears nothing; a person who unmutes and is assigned to
// nothing still hears nothing. There is no state in which touching this switch
// makes somebody a recipient who was not already chosen.
//
// That is the correction to the model this replaces. #569 made the personal
// switch an OPT-IN, which meant it was load-bearing for delivery: a person had
// to find it before an assignment could reach them. #573 deleted it for exactly
// that reason and took the permission prompt with it, which is why nobody has
// received anything since. A veto has neither problem — it is not needed for an
// assignment to work, and it is where the permission request belongs.
//
// ── ABSENCE IS NOT MUTED ────────────────────────────────────────────────────
// A uid with no record here is AUDIBLE. Never "unknown", never "ask something
// else", never a reason to withhold a send. This is the default for everybody
// and it has to be, because the requirement is that an assignment starts
// working the moment that person opens the app and allows notifications —
// without them having to find a switch first. A default of "muted until proven
// otherwise" would rebuild the opt-in this release exists to remove.
//
// So there is ONE representation of muted (a record with `muted === true`) and
// ONE of audible (no record at all). Unmuting DELETES; it does not store
// `muted: false`. Two representations of the same answer is a thing every later
// reader has to agree about, and one of them eventually will not.
//
// `isMuted` is nonetheless written to read a stray `{muted: false}` correctly,
// because the cost of being total here is one comparison and the cost of not
// being is somebody silently missing orders.

// RTDB refuses ".", "#", "$", "/", "[" and "]" in a key and the SDK throws
// SYNCHRONOUSLY on one — before any promise exists to catch it. Same guard, and
// the same reason, as src/push/pushAssignments.js.
import { isLegalKey } from "./pushAssignments";

export const PUSH_MUTES_PATH = "push_mutes";
export const pushMutePath = (uid) => `${PUSH_MUTES_PATH}/${uid}`;
/** The single leaf the fan-out reads. Reading the leaf rather than the record
 *  is the smallest read RTDB can be asked for, and the fan-out does one per
 *  recipient on every burst. */
export const pushMuteFlagPath = (uid) => `${PUSH_MUTES_PATH}/${uid}/muted`;

/**
 * Has this person silenced their own phone?
 *
 * TOTAL: any record shape at all answers a boolean, never a throw. Only a REAL
 * boolean `true` mutes — a stray `"true"`, a `1`, a `null` or an absent field
 * are all audible, because the only write path is the switch and anything else
 * in the node is corruption. Corruption must degrade towards DELIVERY here,
 * which is the opposite direction from `assignedHubs()` and deliberately so:
 * there, wrongly notifying somebody nobody chose is the harm; here, wrongly
 * silencing somebody who was chosen is.
 *
 * @param {object|boolean|null} record /push_mutes/{uid}, the bare `muted` leaf,
 *        or null when absent
 * @returns {boolean}
 */
export function isMuted(record) {
  if (record === true) return true;               // the bare leaf, as the fan-out reads it
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  return record.muted === true;
}

/**
 * The update that sets or clears one person's mute.
 *
 * Returned relative to the database ROOT, for `update(ref(db), …)`, so it is
 * the same shape as assignmentUpdates() and can be composed with one if a
 * caller ever needs to.
 *
 * @param {string} uid
 * @param {boolean} muted
 * @param {number} nowMs  serverNowMs(), never Date.now() — updatedAt is
 *        rules-validated and a phone's clock is not evidence of anything
 * @returns {object} path → value (null deletes)
 */
export function muteUpdates(uid, muted, nowMs) {
  if (!isLegalKey(uid)) throw new Error(`push mute: unusable uid "${uid}"`);
  return { [pushMutePath(uid)]: muted ? { muted: true, updatedAt: nowMs } : null };
}
