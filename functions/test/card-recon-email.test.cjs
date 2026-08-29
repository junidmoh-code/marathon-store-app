// The email channel has no picked till, so the TID on the slip IS the routing
// key. These are the checks that stand in for the mismatch refusal the phone
// path gets for free.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { routeEmailSlip, normaliseMid } = require("../lib/card-recon-email.cjs");

const TERMINALS = {
  "0000HP1X": { mid: "000000004977890", storeId: "pe", tillId: "till-1", label: "PE Till 1" },
  "67365901": { mid: "100000001178101", storeId: "pe", tillId: "till-2", label: "PE Till 2" },
  "67377843": { storeId: "trophy", tillId: "till-1", label: "Trophy Till 1" },  // no MID registered
};

test("routes on the slip's own TID", () => {
  const r = routeEmailSlip({ extraction: { tid: "0000HP1X", mid: "000000004977890" }, terminals: TERMINALS });
  assert.equal(r.ok, true);
  assert.equal(r.tid, "0000HP1X");
  assert.equal(r.terminal.tillId, "till-1");
  assert.deepEqual(r.warnings, []);
});

test("an UNREGISTERED terminal is refused by name — it must surface, not vanish", () => {
  // A terminal nobody mapped is a terminal quietly failing to reconcile. The
  // poller records this reason against the source message.
  const r = routeEmailSlip({ extraction: { tid: "9999ZZZZ", mid: "1" }, terminals: TERMINALS });
  assert.equal(r.ok, false);
  assert.equal(r.unmapped, true);
  assert.equal(r.tid, "9999ZZZZ");
  assert.match(r.reason, /not registered/i);
  assert.match(r.reason, /9999ZZZZ/);
});

test("a MID that contradicts the registry is refused — the file is from elsewhere", () => {
  const r = routeEmailSlip({ extraction: { tid: "0000HP1X", mid: "100000001178101" }, terminals: TERMINALS });
  assert.equal(r.ok, false);
  assert.match(r.reason, /merchant ID/i);
  assert.ok(!r.unmapped);
});

test("leading zeros are not a merchant difference", () => {
  const r = routeEmailSlip({ extraction: { tid: "0000HP1X", mid: "4977890" }, terminals: TERMINALS });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(normaliseMid("000000004977890"), normaliseMid("4977890"));
  assert.equal(normaliseMid("  "), null);
});

test("a missing MID is a WARNING, never a check that quietly did not run", () => {
  const noneRegistered = routeEmailSlip({ extraction: { tid: "67377843", mid: "100000001178101" }, terminals: TERMINALS });
  assert.equal(noneRegistered.ok, true);
  assert.match(noneRegistered.warnings[0], /no merchant ID registered/i);

  const noneOnSlip = routeEmailSlip({ extraction: { tid: "67365901", mid: null }, terminals: TERMINALS });
  assert.equal(noneOnSlip.ok, true);
  assert.match(noneOnSlip.warnings[0], /could not be read/i);
});

test("an unreadable TID is refused rather than routed anywhere", () => {
  for (const tid of [null, "", "??", "a terminal"]) {
    const r = routeEmailSlip({ extraction: { tid }, terminals: TERMINALS });
    assert.equal(r.ok, false);
    assert.equal(r.tid, null);
  }
  // No registry at all is the same answer, not a crash.
  assert.equal(routeEmailSlip({ extraction: { tid: "0000HP1X" }, terminals: null }).ok, false);
});
