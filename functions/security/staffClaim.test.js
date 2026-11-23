"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { reconcileClaim } = require("../lib/card-recon-claim.cjs");

function fakeAuth(claims) {
  const state = { claims, writes: 0 };
  return {
    state,
    getUser: async () => ({ customClaims: state.claims }),
    setCustomUserClaims: async (_uid, c) => { state.claims = c; state.writes++; },
  };
}

test("staff claim is added without touching card_recon or device claims", async () => {
  const auth = fakeAuth({ card_recon: true, deviceId: "d1" });
  const r = await reconcileClaim({ auth, uid: "u1", granted: true, claim: "staff" });
  assert.equal(r.changed, true);
  assert.deepEqual(auth.state.claims, { card_recon: true, deviceId: "d1", staff: true });
});

test("staff claim removal leaves card_recon in place", async () => {
  const auth = fakeAuth({ card_recon: true, staff: true });
  await reconcileClaim({ auth, uid: "u1", granted: false, claim: "staff" });
  assert.deepEqual(auth.state.claims, { card_recon: true });
});

test("converges: no write when already correct", async () => {
  const auth = fakeAuth({ staff: true });
  const r = await reconcileClaim({ auth, uid: "u1", granted: true, claim: "staff" });
  assert.equal(r.changed, false);
  assert.equal(auth.state.writes, 0);
});

test("default claim is still card_recon (existing callers unchanged)", async () => {
  const auth = fakeAuth({ staff: true });
  await reconcileClaim({ auth, uid: "u1", granted: true });
  assert.deepEqual(auth.state.claims, { staff: true, card_recon: true });
});
