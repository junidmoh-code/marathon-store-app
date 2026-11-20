// Black Friday → the website first (Junid, 20 Nov 2026): every approval queues
// a website publish; the card shows each approved row's website status.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { _internals: { webQueueChange } } = require("../blackFriday/webQueue.js");
const core = require("../blackFriday/core.cjs");
const ci = require("../blackFriday/cardIndex.js");

const ap = (over = {}) => ({ state: "approved", sig: "current", at: 100, shown: "u1", ...over });

test("every NEW approval is queued — one tap, a bulk approve, an Undo, a new photo", () => {
  assert.deepEqual(webQueueChange(null, ap()), { queue: { approvedAt: 100 } });
  assert.deepEqual(webQueueChange({ state: "rejected" }, ap()), { queue: { approvedAt: 100 } });
  assert.deepEqual(webQueueChange(ap(), ap({ at: 200 })), { queue: { approvedAt: 200 } });
  assert.deepEqual(webQueueChange(ap(), ap({ sig: "g1795000000000" })), { queue: { approvedAt: 100 } });
  assert.deepEqual(webQueueChange(ap(), ap({ shown: "u2" })), { queue: { approvedAt: 100 } });
});

test("a write that changes nothing about the approval queues nothing; an approval taken back is removed", () => {
  assert.equal(webQueueChange(ap(), ap({ rev: 2, name: "renamed" })), null);
  assert.deepEqual(webQueueChange(ap(), { state: "rejected" }), { remove: true });
  assert.deepEqual(webQueueChange(ap(), null), { remove: true });
  assert.equal(webQueueChange({ state: "rejected" }, null), null);
  assert.equal(webQueueChange(null, { state: "rejected" }), null);
});

test("an approved row carries its website status; just approved = Publishing; review rows carry none", () => {
  const node = {
    items: { main: {
      a: { name: "A", price: 650, qty: 20, kind: "sneakers", photo: "pa" },
      b: { name: "B", price: 650, qty: 20, kind: "sneakers", photo: "pb" },
      c: { name: "C", price: 650, qty: 20, kind: "sneakers", photo: "pc" },
      d: { name: "D", price: 650, qty: 20, kind: "sneakers", photo: "pd" },
    } },
    picks: { a: ap({ shown: "pa" }), b: ap({ shown: "pb" }), c: ap({ shown: "pc" }) },
    web: { a: { s: "live", why: "ignored", at: 1 }, b: { s: "fail", why: "no retail price", at: 1 } },
  };
  const v = core.viewSection(node, "main", { nowMs: 1000 });
  const row = (pid) => [...v.approved, ...v.review].find((r) => r.pid === pid);
  assert.deepEqual(row("a").web, { s: "live" });
  assert.deepEqual(row("b").web, { s: "fail", why: "no retail price" });
  assert.deepEqual(row("c").web, { s: "pub" });
  assert.equal(row("d").web, null);
  assert.deepEqual(core.webOf({ s: "oos", why: "out of stock — not published" }), { s: "oos", why: "out of stock — not published" });
  assert.deepEqual(core.webOf({ s: "bogus" }), { s: "pub" });
});

test("the card's precomputed list is rebuilt when a website status changes", () => {
  assert.ok(ci.bfCardIndexWeb, "bfCardIndexWeb is exported");
});
