// ALL NEW ARRIVALS ARE POSTED (Junid, 21 Nov 2026): which New Arrivals the auto-approval takes, and why not.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { skipWhy, SETTLE_MS } = require("../blackFriday/naAuto.cjs");

const NOW = Date.UTC(2026, 10, 21, 8, 0, 0);
const row = (o = {}) => ({ pid: `p${NOW - 3600_000}`, name: "Nike TN black", price: 650, qty: 4, shown: "https://x/p.jpg", noPrice: false, generating: false, ...o });

test("a priced, photographed, in-stock New Arrival is approved; every exception says why", () => {
  assert.equal(skipWhy(row(), { nowMs: NOW }), null);
  assert.equal(skipWhy(row({ price: 0, noPrice: true }), { nowMs: NOW }), "no price (R0)");
  assert.equal(skipWhy(row({ price: null }), { nowMs: NOW }), "no price (R0)");
  assert.equal(skipWhy(row({ shown: null }), { nowMs: NOW }), "no photo");
  assert.equal(skipWhy(row({ name: "Paper bag large" }), { nowMs: NOW }), "paper bag");
  assert.equal(skipWhy(row({ qty: 0 }), { nowMs: NOW }), "out of stock");
  assert.equal(skipWhy(row(), { nowMs: NOW, takenBack: true }), "approved before and taken back by Junid");
  assert.equal(skipWhy(row({ generating: true }), { nowMs: NOW }), "AI photo still being made (next run)");
});

test("an upload settles 15 minutes before it is approved", () => {
  assert.equal(skipWhy(row({ pid: `p${NOW - 60_000}` }), { nowMs: NOW }), "just uploaded (next run)");
  assert.equal(skipWhy(row({ pid: `p${NOW - SETTLE_MS - 1}` }), { nowMs: NOW }), null);
});
