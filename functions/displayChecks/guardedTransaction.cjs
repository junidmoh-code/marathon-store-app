// ─── DISPLAY CHECKS — the ONE guarded transaction primitive ───────────────────
// Six times in this module the same shape shipped or nearly shipped:
//   cur === null ? fallback : mutate
// In a Cloud Function the RTDB client has no local cache, so a transaction's
// FIRST callback runs against null; returning undefined there aborts BEFORE the
// server round-trip (silent write loss), so the fix forces the round-trip with a
// preRead fallback. The trap: on a LATER callback the server value can be
// authoritatively null (the record was genuinely deleted/reaped), and the same
// branch then substitutes the stale preRead and RESURRECTS it.
//
// The bug recurs because the pattern is copy-pasted across independent call sites
// with no shared primitive, so closing it in five places never closes the sixth —
// and the sixth is always the one outside the current diff (see
// docs/display-checks-txn-audit.md, finding A: the wake held→open flip was an
// unlatched resurrection site missed by every prior PR because it was never
// in-diff). This file removes the copy-paste latch-OMISSION: two explicit modes,
// a call site provably in exactly one of them.
//
// HONEST SCOPE (do not overclaim). The latch closes the RETRY-path resurrection —
// a null delivered to a LATER callback. It does NOT close the cold-cache
// SINGLE-round-trip delete race: in a Cloud Function the first callback runs on
// null and the write is sent with expected-hash = hash(null); if the record was
// deleted after preRead and the server is ALSO null, the hashes MATCH and the
// server commits mutate(preRead) on the FIRST callback — no re-invocation, the
// latch never runs, the record is resurrected. THAT case is closed not by this
// primitive but by the module's NEVER-DELETE-AN-ACTIVE-RECORD invariant (the sole
// deleter, prior-day tombstone reaping, can't touch a record a mutation holds).
// The invariant is the co-requirement, guarded by assertNeverDeletesActiveRecord
// and the PR-11/12 stop condition in the audit doc — the latch cannot substitute
// for it.

"use strict";

// ── MODE 1: guardedMutate — mutate an EXISTING record, abort on a later null ───
// For every transaction that reads a current record and writes the next one
// (bumpCheck, the wake held→open flip, completion's flip, the reap's conditional
// delete). The wrapper OWNS the null-handling so the caller never sees null and
// therefore cannot get it wrong:
//   • cold-cache first run (cur === null on the first callback) → use `preRead`,
//     forcing the server round-trip instead of a silent abort.
//   • authoritative null on a LATER callback (cur === null after a non-null
//     datastale delivery) → abort (undefined), never substitute preRead → no
//     resurrection via the retry path. (The cold-both-null first-callback commit
//     is out of the latch's reach — see HONEST SCOPE above; the never-delete
//     invariant closes it.)
// The caller supplies `preRead` and `mutate(nonNullCurrent)`, which returns:
//   • a next value → commit it
//   • null         → delete the node (conditional-delete callers, e.g. reap)
//   • undefined    → abort (an in-mutation guard failed, e.g. a checkId/status fence)
// Returns the raw RTDB transaction result ({ committed, snapshot }).
async function guardedMutate(ref, preRead, mutate) {
  let firstRun = true;
  return ref.transaction((cur) => {
    const c = (cur === null && firstRun) ? preRead : cur; // preRead ONLY on the cold first run
    firstRun = false;
    if (c == null) return undefined; // authoritative null (or empty preRead) → abort, never resurrect
    return mutate(c);
  });
}

// ── MODE 2: guardedCreate — write ON absence, by design ───────────────────────
// For transactions where a null current IS the signal to create (the idempotency
// lease claim, the create-if-empty path). Here writing on an authoritative null
// is correct — a fresh checkId / a new lease, NOT a resurrection — so `decide` is
// given `cur` directly (it may be null) and is expected to return the value to
// write on absence. It MUST NOT return undefined for the null case (that would be
// the cold-cache silent-abort bug for a create). This is deliberately a SEPARATE
// mode from guardedMutate: the resurrection assertion does not — must not — apply
// here, because a create site correctly writes on null. Keeping the two modes
// distinct is what makes every site provably one shape or the other (a mutate
// site wrongly placed here fails the resurrection assertion; a create site wrongly
// placed in guardedMutate fails its own create-on-empty test).
async function guardedCreate(ref, decide) {
  return ref.transaction(decide);
}

module.exports = { guardedMutate, guardedCreate };
