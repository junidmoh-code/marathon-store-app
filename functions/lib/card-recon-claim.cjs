// ─── CARD RECON — mirroring the card_recon permission into a custom claim ────
// The slip photos under Storage `cardRecon/**` carry masked PANs, auth codes
// and RRNs for every transaction in a batch: investigation material about named
// staff. Read must be limited to holders of the `card_recon` permission, not to
// every signed-in staff member.
//
// Storage rules cannot read RTDB. The only thing a Storage rule can see about
// the caller is their ID token, so the permission has to travel there — as a
// Firebase Auth custom claim, `card_recon: true`.
//
// THE FAILURE THAT MATTERS IS THE STALE CLAIM ON REVOKE. A permission removed
// in User Management that leaves the claim behind is worse than never having
// gated the photos at all, because the screen now says the person cannot see
// them and the storage bucket still hands them over. So:
//
//   • the claim is DERIVED, never edited by hand: `granted` in ⇒ claim present,
//     `granted` out ⇒ claim key REMOVED (not set to false — a false claim still
//     occupies the token and invites a rule that tests presence);
//   • every OTHER claim on the account is preserved untouched. This account may
//     carry claims this feature knows nothing about, and a blind
//     setCustomUserClaims({card_recon:true}) would silently delete them;
//   • the sync is IDEMPOTENT and reports whether it changed anything, so the
//     trigger, the backfill and any retry all converge on the same state;
//   • it is a reconciler, not a diff applier — it reads the account's current
//     claims and writes the desired ones. A missed event, a replayed event and
//     an out-of-order event all land in the same place.
//
// PURE by the house rule: no firebase-admin here. The Auth handle is injected,
// which is also what makes the revoke path testable without an Auth project.
// Tested in functions/test/card-recon-claim.test.cjs.

"use strict";

// The claim name is the permission key, deliberately: one string appears in
// permissionCatalog.js, in permFlags, in the callable's gate and in
// storage.rules, so there is nothing to keep in sync mentally.
const CLAIM = "card_recon";
// The RTDB scalar this mirrors. permFlags is the rules-readable map twin of the
// `permissions` array (see permFlagsFor) — the array cannot be read by a rule
// or by a leaf trigger, the map can.
const FLAG_PATH = (uid) => `users/${uid}/permFlags/${CLAIM}`;

/**
 * Is the permission granted, per the permFlags scalar?
 * STRICTLY `true`. permFlagsFor only ever writes the boolean true, so anything
 * else — absent, null, false, the string "true", 1 — is not a grant. Being
 * loose here would turn a typo into access to investigation photos.
 */
function isGranted(flagValue) {
  return flagValue === true;
}

/**
 * Reconcile one account's claim against one desired state.
 *
 * @param {object}  args
 * @param {object}  args.auth     firebase-admin Auth (getUser, setCustomUserClaims)
 * @param {string}  args.uid
 * @param {boolean} args.granted  the desired state, from isGranted()
 * @param {boolean} [args.dryRun]  decide and report, write nothing
 * @returns {Promise<{uid:string, granted:boolean, changed:boolean, missing?:boolean,
 *                    before:boolean, otherClaims:string[]}>}
 *
 * `changed` means "the claim state on this account is not what it should be".
 * On a dry run that is the finding; on a live run the write has already
 * happened by the time it is returned.
 */
async function reconcileClaim({ auth, uid, granted, dryRun = false }) {
  if (typeof uid !== "string" || !uid) throw new Error("reconcileClaim: uid required");
  let user;
  try {
    user = await auth.getUser(uid);
  } catch (err) {
    // The account is gone (deleteStaffUser removes the /users record and the
    // auth user). There is no claim left to carry, so this is a completed
    // revoke, not a failure — anything else rethrows and the trigger retries.
    if (err && err.code === "auth/user-not-found") {
      return { uid, granted: false, changed: false, missing: true, before: false, otherClaims: [] };
    }
    throw err;
  }

  const current = { ...(user.customClaims || {}) };
  const before = current[CLAIM] === true;
  const otherClaims = Object.keys(current).filter((k) => k !== CLAIM);

  // Idempotent: converge, do not toggle. Note the `before` test is on `=== true`
  // while the write below DELETES rather than sets false, so a legacy
  // `card_recon: false` claim is treated as not-granted AND cleaned up when the
  // desired state is also not-granted.
  const needsWrite = granted
    ? !(CLAIM in current) || current[CLAIM] !== true
    : CLAIM in current;
  if (!needsWrite) return { uid, granted, changed: false, before, otherClaims };
  if (dryRun) return { uid, granted, changed: true, dryRun: true, before, otherClaims };

  const next = { ...current };
  if (granted) next[CLAIM] = true;
  else delete next[CLAIM];

  // `null` is the documented "no custom claims at all"; passing {} would leave
  // an empty claims object behind. Either works, but null is the clean state.
  await auth.setCustomUserClaims(uid, Object.keys(next).length ? next : null);
  return { uid, granted, changed: true, before, otherClaims };
}

/**
 * The trigger's whole decision.
 *
 * IT RE-READS THE FLAG; IT DOES NOT TRUST THE EVENT. The obvious implementation
 * takes `event.data.after.val()` and mirrors that — and it is wrong, in the one
 * direction that matters. RTDB triggers carry no ordering guarantee between
 * separate write events, and `retry: true` (which exists precisely so a revoke
 * is never dropped) makes late delivery MORE likely, not less:
 *
 *   grant fires → the Auth call fails transiently → queued for retry
 *   revoke fires → succeeds immediately → claim removed          ✔
 *   the retried GRANT finally runs → re-writes card_recon: true  ✘
 *
 * and nothing ever corrects it, because no further write to the flag happens.
 * A revoked person silently keeps access. Reading `users/{uid}/permFlags/
 * card_recon` at execution time instead makes every delivery order converge:
 * a handler may read a value newer than its own event (harmless — it writes the
 * truth), and the last write to the flag always fires a handler that reads the
 * final value. The event becomes a wake-up, not a payload.
 *
 * `db` is injected, like `auth`, so the ordering behaviour is testable.
 * (Sonnet architect review, 2026-08-28.)
 */
async function syncClaimFromFlag({ auth, db, uid }) {
  const live = await db.ref(FLAG_PATH(uid)).once("value");
  return reconcileClaim({ auth, uid, granted: isGranted(live.val()) });
}

/**
 * Reconcile a whole /users node — the backfill, and the drift check that can be
 * re-run at any time. Never reads or writes anything but claims.
 *
 * @param {object} args
 * @param {object} args.auth
 * @param {object} args.users        the /users node: { uid: record }
 * @param {boolean} args.execute     false ⇒ decide only, write nothing
 * @returns {Promise<{planned:object[], changed:object[], errors:object[]}>}
 */
async function reconcileAll({ auth, users, execute = false }) {
  const planned = [], changed = [], errors = [];
  for (const [uid, rec] of Object.entries(users || {})) {
    if (!rec || typeof rec !== "object") continue;
    const granted = isGranted(rec.permFlags && rec.permFlags[CLAIM]);
    try {
      // A dry run still READS every account, so the report is about the real
      // claim state rather than about what we assume it is.
      const res = await reconcileClaim({ auth, uid, granted, dryRun: !execute });
      planned.push(res);
      if (res.changed) changed.push(res);
    } catch (err) {
      errors.push({ uid, message: err && err.message ? err.message : String(err) });
    }
  }
  return { planned, changed, errors };
}

module.exports = { CLAIM, FLAG_PATH, isGranted, reconcileClaim, syncClaimFromFlag, reconcileAll };
