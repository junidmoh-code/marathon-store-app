// "Sent" — and nothing else: the receipt says WHEN the server kept the slip
// and for WHICH trading day. Never a figure, a batch, a job or a verdict.
"use strict";
const assert = require("node:assert/strict");

function assertSent(out, msg) {
  assert.ok(out && typeof out === "object", msg || "an answer came back");
  assert.deepEqual(Object.keys(out).sort(), ["ok", "receipt", "received"], msg);
  assert.equal(out.ok, true, msg || out.reason);
  assert.equal(out.received, true, msg);
  assert.deepEqual(Object.keys(out.receipt).sort(), ["at", "dayYmd"], msg);
  assert.ok(Number.isFinite(out.receipt.at), msg);
  assert.match(out.receipt.dayYmd, /^\d{4}-\d{2}-\d{2}$/, msg);
  return out;
}

module.exports = { assertSent };
