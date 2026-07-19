// ─── DISPLAY CHECKS — reusable resurrection assertion for guardedMutate sites ──
// The single test that every mutate-existing displayChecks transaction must pass,
// so PR 11 (roster-lock) and PR 12 (marks) inherit the GUARD (guardedMutate) AND
// its proof: any future two-path write wires this assertion or it doesn't merge.
//
// It drives a guardedMutate call through the two-callback scenario the module was
// bitten by six times:
//   (a) cold-cache first-null  → must be rescued by preRead (no silent cold-abort)
//   (b) authoritative later-null → must ABORT and NOT resurrect the record
//
// It applies to guardedMutate sites ONLY. A guardedCreate site (write-on-null by
// design) would (correctly) WRITE on the authoritative null and fail (b) — and
// "this assertion cannot be applied here" is exactly the proof that #2/#3 are the
// safe create shape, not a coverage gap.

"use strict";

const assert = require("node:assert/strict");
const { guardedMutate } = require("../../displayChecks/guardedTransaction.cjs");

// A one-node fake ref with Cloud-Function cold-cache transaction semantics: the
// first callback runs against null (no local cache). `deleteBeforeServer` models
// an authoritative delete (e.g. a reap) landing between the cold callback and the
// server round-trip. `coldAborts` counts a returning-undefined-on-cold-null (the
// silent abort the preRead fallback exists to prevent).
function makeNode(initial) {
  let value = initial == null ? null : structuredClone(initial);
  const api = { coldAborts: 0, deleteBeforeServer: false };
  Object.defineProperty(api, "value", { get: () => value });
  api.ref = {
    async transaction(fn) {
      const cold = fn(null);                                   // cold-cache FIRST callback
      if (cold === undefined) { api.coldAborts++; return { committed: false, snapshot: { val: () => value } }; }
      if (api.deleteBeforeServer) { value = null; api.deleteBeforeServer = false; } // authoritative delete
      const server = value;
      const final = fn(server);
      if (final === undefined) return { committed: false, snapshot: { val: () => server } };
      value = final;                                           // final may be null (delete) or an object
      return { committed: true, snapshot: { val: () => value } };
    },
  };
  return api;
}

// Assert a guardedMutate site never resurrects on an authoritative null.
//   preRead : the record the cold-cache first callback must be rescued with
//   mutate  : the site's mutation, (nonNullCurrent) → next | null(delete) | undefined(abort)
async function assertNoResurrectionOnAuthoritativeNull({ preRead, mutate, label = "site" }) {
  // (a) cold-cache first-null → preRead rescues it (the operation reaches the server)
  const cold = makeNode(preRead);
  await guardedMutate(cold.ref, preRead, mutate);
  assert.equal(cold.coldAborts, 0, `${label}: cold-cache first run must be rescued by preRead (no silent abort)`);

  // (b) authoritative later-null → abort, never resurrect
  const gone = makeNode(preRead);
  gone.deleteBeforeServer = true;
  const res = await guardedMutate(gone.ref, preRead, mutate);
  assert.equal(res.committed, false, `${label}: an authoritative null must abort (not commit a resurrected record)`);
  assert.equal(gone.value, null, `${label}: the slot must stay absent — no ghost resurrected`);
}

module.exports = { makeNode, assertNoResurrectionOnAuthoritativeNull };
