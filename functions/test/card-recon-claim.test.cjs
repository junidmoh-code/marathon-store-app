// Tests for lib/card-recon-claim.cjs — the card_recon permission ⇄ custom claim
// mirror that gates Storage read of the slip photos.
//
// The tests the brief demands, by name: granted reads, revoked does not,
// never-granted does not, backfill correctness, revoke-then-immediate-read.
// "reads" here is the STORAGE RULE's question, so each one ends by asking the
// fake token the same thing storage.rules asks: is card_recon === true?
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CLAIM, MAX_VERIFY_PASSES, isGranted, reconcileClaim, syncClaimFromFlag, reconcileAll } =
  require("../lib/card-recon-claim.cjs");

// ── A fake Auth that behaves like the real one where it matters ─────────────
// setCustomUserClaims REPLACES the whole claims object (that is the trap this
// module exists to avoid), and getUser throws auth/user-not-found for a uid it
// does not know.
function fakeAuth(accounts) {
  const store = new Map(Object.entries(accounts));
  let writes = 0;
  return {
    writes: () => writes,
    claimsOf: (uid) => (store.get(uid) || {}).customClaims ?? null,
    async getUser(uid) {
      if (!store.has(uid)) {
        const e = new Error("no user"); e.code = "auth/user-not-found"; throw e;
      }
      return { uid, ...store.get(uid) };
    },
    async setCustomUserClaims(uid, claims) {
      if (!store.has(uid)) { const e = new Error("no user"); e.code = "auth/user-not-found"; throw e; }
      writes += 1;
      store.set(uid, { ...store.get(uid), customClaims: claims });
    },
  };
}

// A fake RTDB whose permFlags leaf can be moved between calls — the trigger
// re-reads it rather than trusting its event, so the tests drive the DATABASE,
// not the payload.
function fakeDb(flags = {}) {
  const state = new Map(Object.entries(flags));
  return {
    set(uid, v) { state.set(uid, v); },
    ref(path) {
      // The PATH is part of the contract, not an implementation detail: the
      // rules-readable mirror is permFlags, and reading `permissions` instead
      // would silently answer null for every account (the array reaches a
      // read keyed by POSITION, which is why permFlags exists at all). A fake
      // that shrugs at the path lets that mutation live.
      const m = /^users\/([^/]+)\/permFlags\/card_recon$/.exec(path);
      if (!m) throw new Error(`fakeDb: unexpected path "${path}" — expected users/{uid}/permFlags/card_recon`);
      const uid = m[1];
      return { async once() { const v = state.get(uid); return { val: () => (v === undefined ? null : v) }; } };
    },
  };
}

// EXACTLY what storage.rules asks of the token: `request.auth.token.card_recon == true`.
const storageWouldAllow = (claims) => (claims || {})[CLAIM] === true;

// ── isGranted: strictly true ────────────────────────────────────────────────
test("only the boolean true is a grant", () => {
  assert.equal(isGranted(true), true);
  for (const v of [false, null, undefined, 0, 1, "true", "", {}, []]) {
    assert.equal(isGranted(v), false, `${JSON.stringify(v)} must not be a grant`);
  }
});

// ── GRANTED READS ───────────────────────────────────────────────────────────
test("granted: the claim lands and Storage would allow the read", async () => {
  const auth = fakeAuth({ u1: { customClaims: null } });
  const res = await syncClaimFromFlag({ auth, db: fakeDb({ u1: true }), uid: "u1" });
  assert.equal(res.changed, true);
  assert.equal(res.granted, true);
  assert.equal(storageWouldAllow(auth.claimsOf("u1")), true);
});

test("granted twice is granted once — no pointless token churn", async () => {
  const auth = fakeAuth({ u1: { customClaims: null } });
  await syncClaimFromFlag({ auth, db: fakeDb({ u1: true }), uid: "u1" });
  const again = await syncClaimFromFlag({ auth, db: fakeDb({ u1: true }), uid: "u1" });
  assert.equal(again.changed, false);
  assert.equal(auth.writes(), 1);
  assert.equal(storageWouldAllow(auth.claimsOf("u1")), true);
});

// ── REVOKED DOES NOT ────────────────────────────────────────────────────────
test("revoked: the claim KEY is removed, not set to false", async () => {
  const auth = fakeAuth({ u1: { customClaims: { [CLAIM]: true } } });
  const res = await syncClaimFromFlag({ auth, db: fakeDb({ u1: null }), uid: "u1" });
  assert.equal(res.changed, true);
  assert.equal(res.granted, false);
  assert.equal(storageWouldAllow(auth.claimsOf("u1")), false);
  // Not `{card_recon: false}` — a false claim still occupies the token and
  // invites a rule that tests presence instead of value.
  assert.equal(CLAIM in (auth.claimsOf("u1") || {}), false);
});

test("revoked by writing false, not by deleting the flag", async () => {
  const auth = fakeAuth({ u1: { customClaims: { [CLAIM]: true } } });
  await syncClaimFromFlag({ auth, db: fakeDb({ u1: false }), uid: "u1" });
  assert.equal(storageWouldAllow(auth.claimsOf("u1")), false);
});

test("REVOKE-THEN-IMMEDIATE-READ: nothing in between can leave the claim standing", async () => {
  const auth = fakeAuth({ u1: { customClaims: null } });
  await syncClaimFromFlag({ auth, db: fakeDb({ u1: true }), uid: "u1" });
  assert.equal(storageWouldAllow(auth.claimsOf("u1")), true);
  await syncClaimFromFlag({ auth, db: fakeDb({ u1: null }), uid: "u1" });
  // The very next question the storage rule asks — no refresh window on the
  // SERVER side; the account's claim is already gone.
  assert.equal(storageWouldAllow(auth.claimsOf("u1")), false);
  // And a retried/replayed revoke stays revoked rather than toggling.
  const replay = await syncClaimFromFlag({ auth, db: fakeDb({ u1: null }), uid: "u1" });
  assert.equal(replay.changed, false);
  assert.equal(storageWouldAllow(auth.claimsOf("u1")), false);
});

test("A RETRIED GRANT LANDING AFTER A REVOKE DOES NOT RE-GRANT — the race retry makes likelier", async () => {
  // The sequence that mattered enough to change the design (Sonnet architect
  // review, 2026-08-28). retry:true exists so a revoke is never dropped, and it
  // is exactly what makes a stale grant arrive late:
  //   grant fires → the Auth call fails transiently → queued for retry
  //   revoke fires → succeeds → claim removed
  //   the retried GRANT finally runs → and must NOT put the claim back.
  // Only re-reading the flag makes that true; an implementation that mirrored
  // the event's own `after` value would re-grant here and nothing would ever
  // correct it, because no further write to the flag happens.
  const auth = fakeAuth({ u1: { customClaims: null } });
  const db = fakeDb({ u1: true });          // granted

  // The grant's first attempt dies inside Auth, after reading the flag.
  const realSet = auth.setCustomUserClaims.bind(auth);
  auth.setCustomUserClaims = async () => { throw Object.assign(new Error("transient"), { code: "auth/internal-error" }); };
  await assert.rejects(() => syncClaimFromFlag({ auth, db, uid: "u1" }), /transient/);
  assert.equal(storageWouldAllow(auth.claimsOf("u1")), false);

  // The owner revokes; that write's own handler runs and succeeds.
  auth.setCustomUserClaims = realSet;
  db.set("u1", null);
  await syncClaimFromFlag({ auth, db, uid: "u1" });
  assert.equal(storageWouldAllow(auth.claimsOf("u1")), false);

  // NOW the retried grant runs. It carries `after: true`; the flag says null.
  const retried = await syncClaimFromFlag({ auth, db, uid: "u1" });
  assert.equal(retried.granted, false, "the retried grant must mirror the FLAG, not its own event");
  assert.equal(storageWouldAllow(auth.claimsOf("u1")), false);
});

test("a handler that wakes on a stale revoke still mirrors a flag that says granted", async () => {
  // The mirror image, and the reason this is convergence rather than
  // last-writer-wins: a late REVOKE event must not remove a claim the owner has
  // since re-granted. Whoever wakes last reads the truth.
  const auth = fakeAuth({ u1: { customClaims: null } });
  const db = fakeDb({ u1: true });
  await syncClaimFromFlag({ auth, db, uid: "u1" });         // stale revoke event, flag says granted
  assert.equal(storageWouldAllow(auth.claimsOf("u1")), true);
});

test("a missing flag node reads as revoked, never as absent-so-leave-alone", async () => {
  const auth = fakeAuth({ u1: { customClaims: { [CLAIM]: true } } });
  await syncClaimFromFlag({ auth, db: fakeDb({}), uid: "u1" }); // no node at all
  assert.equal(storageWouldAllow(auth.claimsOf("u1")), false);
});

// ── NEVER-GRANTED DOES NOT ──────────────────────────────────────────────────
test("never granted: no claim is ever written and Storage refuses", async () => {
  const auth = fakeAuth({ u2: { customClaims: null } });
  const res = await syncClaimFromFlag({ auth, db: fakeDb({ u2: null }), uid: "u2" });
  assert.equal(res.changed, false);
  assert.equal(auth.writes(), 0);
  assert.equal(storageWouldAllow(auth.claimsOf("u2")), false);
});

test("a staff account with OTHER claims and no card_recon is left completely alone", async () => {
  const auth = fakeAuth({ u3: { customClaims: { someOtherThing: true } } });
  await syncClaimFromFlag({ auth, db: fakeDb({ u3: null }), uid: "u3" });
  assert.equal(auth.writes(), 0);
  assert.deepEqual(auth.claimsOf("u3"), { someOtherThing: true });
});

// ── OTHER CLAIMS SURVIVE ────────────────────────────────────────────────────
test("granting preserves every other claim on the account", async () => {
  const auth = fakeAuth({ u1: { customClaims: { posRole: "cashier", admin: true } } });
  await syncClaimFromFlag({ auth, db: fakeDb({ u1: true }), uid: "u1" });
  assert.deepEqual(auth.claimsOf("u1"), { posRole: "cashier", admin: true, [CLAIM]: true });
});

test("revoking removes ONLY card_recon", async () => {
  const auth = fakeAuth({ u1: { customClaims: { posRole: "cashier", [CLAIM]: true } } });
  await syncClaimFromFlag({ auth, db: fakeDb({ u1: null }), uid: "u1" });
  assert.deepEqual(auth.claimsOf("u1"), { posRole: "cashier" });
});

test("revoking the LAST claim clears the claims object rather than leaving an empty one", async () => {
  const auth = fakeAuth({ u1: { customClaims: { [CLAIM]: true } } });
  await syncClaimFromFlag({ auth, db: fakeDb({ u1: null }), uid: "u1" });
  assert.equal(auth.claimsOf("u1"), null);
});

test("a legacy card_recon:false claim is cleaned up, not mistaken for a grant", async () => {
  const auth = fakeAuth({ u1: { customClaims: { [CLAIM]: false, posRole: "x" } } });
  const res = await syncClaimFromFlag({ auth, db: fakeDb({ u1: null }), uid: "u1" });
  assert.equal(res.changed, true);          // the key was present; it is now gone
  assert.deepEqual(auth.claimsOf("u1"), { posRole: "x" });
  assert.equal(storageWouldAllow(auth.claimsOf("u1")), false);
});

test("a legacy card_recon:false claim is REPAIRED to true when the flag says granted", async () => {
  const auth = fakeAuth({ u1: { customClaims: { [CLAIM]: false } } });
  await syncClaimFromFlag({ auth, db: fakeDb({ u1: true }), uid: "u1" });
  assert.equal(storageWouldAllow(auth.claimsOf("u1")), true);
});

// ── A DELETED ACCOUNT ───────────────────────────────────────────────────────
test("a deleted account is a completed revoke, not a crash", async () => {
  const auth = fakeAuth({});
  const res = await syncClaimFromFlag({ auth, db: fakeDb({ gone: null }), uid: "gone" });
  assert.equal(res.missing, true);
  assert.equal(res.changed, false);
});

test("any OTHER auth error propagates, so the trigger retries instead of losing a revoke", async () => {
  const auth = {
    async getUser() { const e = new Error("backend down"); e.code = "auth/internal-error"; throw e; },
    async setCustomUserClaims() { throw new Error("must not be reached"); },
  };
  await assert.rejects(
    () => syncClaimFromFlag({ auth, db: fakeDb({ u1: null }), uid: "u1" }),
    /backend down/,
  );
});

// ── BACKFILL CORRECTNESS ────────────────────────────────────────────────────
const USERS = {
  granted1:   { permFlags: { [CLAIM]: true, insights: true } },
  granted2:   { permFlags: { [CLAIM]: true } },
  otherPerm:  { permFlags: { insights: true } },
  noFlags:    { role: "store_assistant" },
  staleClaim: { permFlags: { insights: true } },   // holds the claim but not the permission
  deleted:    { permFlags: { [CLAIM]: true } },    // no auth account
  notARecord: "junk",
};

function backfillAuth() {
  return fakeAuth({
    granted1:   { customClaims: null },
    granted2:   { customClaims: { [CLAIM]: true } },        // already correct
    otherPerm:  { customClaims: null },
    noFlags:    { customClaims: null },
    staleClaim: { customClaims: { [CLAIM]: true, posRole: "cashier" } },
  });
}

test("backfill dry run reports exactly the accounts that are wrong and writes nothing", async () => {
  const auth = backfillAuth();
  const { planned, changed, errors } = await reconcileAll({ auth, users: USERS, execute: false });
  assert.equal(auth.writes(), 0);
  assert.deepEqual(changed.map((c) => c.uid).sort(), ["granted1", "staleClaim"]);
  assert.ok(planned.every((p) => !p.changed || p.dryRun));
  // The account with no auth user is reported, not fatal.
  assert.equal(errors.length, 0);
  assert.equal(planned.find((p) => p.uid === "deleted").missing, true);
  // A non-object child of /users is skipped entirely.
  assert.equal(planned.some((p) => p.uid === "notARecord"), false);
});

test("backfill --execute converges every account in BOTH directions", async () => {
  const auth = backfillAuth();
  const { changed } = await reconcileAll({ auth, users: USERS, execute: true });
  assert.deepEqual(changed.map((c) => c.uid).sort(), ["granted1", "staleClaim"]);
  // granted → claim present
  assert.equal(storageWouldAllow(auth.claimsOf("granted1")), true);
  assert.equal(storageWouldAllow(auth.claimsOf("granted2")), true);
  // the stale claim is GONE, its unrelated claim untouched
  assert.equal(storageWouldAllow(auth.claimsOf("staleClaim")), false);
  assert.deepEqual(auth.claimsOf("staleClaim"), { posRole: "cashier" });
  // never-granted accounts stay claimless and were never written
  assert.equal(storageWouldAllow(auth.claimsOf("otherPerm")), false);
  assert.equal(storageWouldAllow(auth.claimsOf("noFlags")), false);
  assert.equal(auth.writes(), 2);
});

test("backfill is idempotent — a second run changes nothing", async () => {
  const auth = backfillAuth();
  await reconcileAll({ auth, users: USERS, execute: true });
  const writesAfterFirst = auth.writes();
  const second = await reconcileAll({ auth, users: USERS, execute: true });
  assert.deepEqual(second.changed, []);
  assert.equal(auth.writes(), writesAfterFirst);
});

test("backfill: one broken account does not abort the pass", async () => {
  const auth = backfillAuth();
  auth.getUser = async (uid) => {
    if (uid === "granted1") { const e = new Error("boom"); e.code = "auth/internal-error"; throw e; }
    const e2 = new Error("no user"); e2.code = "auth/user-not-found"; throw e2;
  };
  const { errors } = await reconcileAll({ auth, users: USERS, execute: true });
  assert.deepEqual(errors.map((e) => e.uid), ["granted1"]);
});

// ── The direct entry point, for the backfill's own uid-at-a-time use ────────
test("reconcileClaim rejects a missing uid rather than reconciling nothing", async () => {
  await assert.rejects(() => reconcileClaim({ auth: fakeAuth({}), uid: "", granted: true }), /uid required/);
});


// ── CONCURRENT INSTANCES ────────────────────────────────────────────────────
// The trigger has no concurrency guard: two rapid flag writes wake two
// instances, and the read / getUser / setCustomUserClaims are three separate
// round trips. The instance that read the STALE value can be the one whose
// write lands last. Re-reading the flag instead of the event does not close
// this on its own — writing, then verifying against the flag, does.
test("CONCURRENT: the instance that read a stale flag does not get the last word", async () => {
  const auth = fakeAuth({ u1: { customClaims: null } });
  const db = fakeDb({ u1: true });

  // A wakes on "on" and reads it.
  // Model the interleave by driving A's write through a gate we hold open
  // while B runs to completion.
  let releaseA;
  const aWriteGate = new Promise((r) => { releaseA = r; });
  const realSet = auth.setCustomUserClaims.bind(auth);
  let gated = true;
  auth.setCustomUserClaims = async (uid, claims) => {
    if (gated) { gated = false; await aWriteGate; }   // A stalls mid-write
    return realSet(uid, claims);
  };

  const a = syncClaimFromFlag({ auth, db, uid: "u1" });      // reads "on", stalls in the write
  await new Promise((r) => setImmediate(r));

  db.set("u1", null);                                        // the owner revokes
  await syncClaimFromFlag({ auth, db, uid: "u1" });          // B: reads "off", writes off
  assert.equal(storageWouldAllow(auth.claimsOf("u1")), false);

  releaseA();                                                // A's stale write finally lands
  await a;

  // A wrote `true` — and then verified against the flag, saw "off", and
  // corrected itself. Without the verify pass this assertion fails.
  assert.equal(storageWouldAllow(auth.claimsOf("u1")), false,
    "the stale writer must reconcile against the flag, not leave its own value standing");
});

test("CONCURRENT: the mirror image — a stale REVOKE does not strip a live grant", async () => {
  const auth = fakeAuth({ u1: { customClaims: null } });
  const db = fakeDb({ u1: null });
  let releaseA;
  const gate = new Promise((r) => { releaseA = r; });
  const realSet = auth.setCustomUserClaims.bind(auth);
  let gated = true;
  auth.setCustomUserClaims = async (uid, claims) => {
    if (gated) { gated = false; await gate; }
    return realSet(uid, claims);
  };
  // Seed a claim so the revoke path actually writes.
  await realSet("u1", { [CLAIM]: true });

  const a = syncClaimFromFlag({ auth, db, uid: "u1" });   // reads "off", stalls
  await new Promise((r) => setImmediate(r));
  db.set("u1", true);                                     // re-granted
  await syncClaimFromFlag({ auth, db, uid: "u1" });        // B: writes the grant
  releaseA();
  await a;
  assert.equal(storageWouldAllow(auth.claimsOf("u1")), true);
});

test("a flag toggling faster than a round trip is rethrown, never left unverified", async () => {
  const auth = fakeAuth({ u1: { customClaims: null } });
  // A flag that flips on every single read: no pass can ever verify.
  let v = true;
  const flipping = { ref: () => ({ async once() { v = !v; return { val: () => (v ? true : null) }; } }) };
  await assert.rejects(
    () => syncClaimFromFlag({ auth, db: flipping, uid: "u1" }),
    new RegExp(`kept moving across ${MAX_VERIFY_PASSES} passes`),
  );
});

test("the account disappearing between the read and the WRITE is a completed revoke", async () => {
  const auth = fakeAuth({ u1: { customClaims: null } });
  auth.setCustomUserClaims = async () => { const e = new Error("gone"); e.code = "auth/user-not-found"; throw e; };
  const res = await syncClaimFromFlag({ auth, db: fakeDb({ u1: true }), uid: "u1" });
  assert.equal(res.missing, true);
  assert.equal(res.granted, false);
});
