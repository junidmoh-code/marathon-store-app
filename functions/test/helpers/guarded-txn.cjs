// ─── DISPLAY CHECKS — reusable guards for the transaction primitive + invariant ─
// Two exported assertions that future PRs (11 roster-lock, 12 marks, retention)
// MUST inherit. Together they are the honest statement of why the primitive is
// safe:
//
//   1. assertLatchAbortsOnAuthoritativeNull — the guardedMutate latch aborts (does
//      NOT substitute preRead) when a LATER callback sees an authoritative null.
//      This closes the retry-path resurrection AND removes the copy-paste
//      latch-OMISSION that made the wake flip a bug-in-waiting.
//
//   2. assertNeverDeletesActiveRecord — the module-wide INVARIANT guard. The latch
//      canNOT close the cold-cache SINGLE-round-trip delete race (see below), so
//      that case is closed instead by never deleting an ACTIVE (held/open) record.
//      This asserts a delete path leaves every active record intact — the
//      load-bearing fact for the entire class of unreachables.
//
// WHY THE LATCH IS NOT ENOUGH (the honest scope): on the RTDB wire the update
// function is re-invoked ONLY on an expected-hash mismatch. A Cloud Function has
// no local cache, so the first callback runs on null and the write is sent with
// expected-hash = hash(null). If the record was deleted after preRead and the
// server value is ALSO null, the hashes MATCH and the server commits mutate(preRead)
// on the FIRST callback — no re-invocation, the latch never runs, the record is
// resurrected. The latch only ever guards a LATER callback (reached after a
// non-null datastale delivery). So the cold-both-null resurrection is closed not
// by the latch but by the never-delete-an-active-record invariant (#2).

"use strict";

const assert = require("node:assert/strict");
const { guardedMutate } = require("../../displayChecks/guardedTransaction.cjs");

// A one-node fake ref modelling the RTDB transaction WIRE (not an unconditional
// re-run): cold first callback on null; commit-on-CAS-match; datastale re-invoke
// on mismatch. `deleteAfterRetry` models a delete landing after the record was
// delivered to a retry — producing a genuine LATER authoritative null (the case
// the latch guards). `coldAborts` counts a returning-undefined-on-cold-null.
function makeNode(initial) {
  let value = initial == null ? null : structuredClone(initial);
  const api = { coldAborts: 0, deleteAfterRetry: false };
  Object.defineProperty(api, "value", { get: () => value });
  api.ref = {
    async transaction(fn) {
      const cold = fn(null);                                            // (1) cold-cache FIRST callback
      if (cold === undefined) { api.coldAborts++; return { committed: false, snapshot: { val: () => value } }; }
      // (2) The write is sent with expected = hash(null). If the server is ALSO
      //     null, CAS matches and it commits HERE — the cold-both-null case the
      //     latch cannot guard (no re-invocation). Otherwise datastale → re-invoke.
      if (value === null) { value = cold; return { committed: true, snapshot: { val: () => value } }; }
      let out = fn(value);                                              // (3) datastale re-invoke with the authoritative record
      if (api.deleteAfterRetry && out !== undefined) { value = null; out = fn(null); } // (4) delete → LATER authoritative null
      if (out === undefined) return { committed: false, snapshot: { val: () => value } };
      value = out;                                                     // out may be null (delete) or a record
      return { committed: true, snapshot: { val: () => value } };
    },
  };
  return api;
}

// GUARD 1 — the latch aborts on a LATER authoritative null (retry path).
// Applies to guardedMutate sites ONLY. A guardedCreate site would (correctly)
// write on null and fail (b) — and that it can't pass this is the proof it is the
// create shape, not a coverage gap. NOTE the scope: this pins the retry-path
// resurrection the latch closes; the cold-SINGLE-round-trip delete race is out of
// the latch's reach and is covered by GUARD 2 (never-delete invariant), not here.
async function assertLatchAbortsOnAuthoritativeNull({ preRead, mutate, label = "site" }) {
  // (a) cold-cache first-null → preRead rescues it (reaches the server; no silent abort)
  const warm = makeNode(preRead);
  await guardedMutate(warm.ref, preRead, mutate);
  assert.equal(warm.coldAborts, 0, `${label}: cold-cache first run must be rescued by preRead (no silent abort)`);
  // (b) a LATER authoritative null (record present at the first server response,
  //     then deleted before a retry) → the latch must abort, never substitute preRead.
  const gone = makeNode(preRead);
  gone.deleteAfterRetry = true;
  const res = await guardedMutate(gone.ref, preRead, mutate);
  assert.equal(res.committed, false, `${label}: a later authoritative null must abort (not resurrect via the retry path)`);
  assert.equal(gone.value, null, `${label}: the slot must stay absent — no ghost`);
}

// GUARD 2 — the never-delete-an-active-record invariant. Run a delete path and
// assert every ACTIVE (held/open) record it could touch SURVIVES. This is the
// load-bearing fact that keeps the cold-both-null resurrection unreachable at
// EVERY guardedMutate site. ANY future PR adding a delete to an active-record
// path must pass this (or route deletes through reapTombstone's completed-only
// path) IN ITS OWN DIFF — see docs/display-checks-txn-audit.md.
//   db          — a fake RTDB with a `.state` tree, seeded with active records
//   run(db)     — the delete path under test (e.g. runWakeSweep)
//   activePaths — { label: 'displayChecks_active/{store}/{key}' } that must survive
async function assertNeverDeletesActiveRecord({ db, run, activePaths }) {
  await run(db);
  for (const [label, path] of Object.entries(activePaths)) {
    const rec = path.split("/").reduce((n, k) => (n == null ? n : n[k]), db.state);
    assert.ok(rec != null,
      `never-delete invariant VIOLATED: the ${label} active record was deleted (${path}). ` +
      `A delete on an active-record path re-opens the cold-both-null resurrection at every guardedMutate site — ` +
      `route the delete through reapTombstone's completed-only path, or re-verify unreachability here.`);
  }
}

module.exports = { makeNode, assertLatchAbortsOnAuthoritativeNull, assertNeverDeletesActiveRecord };
