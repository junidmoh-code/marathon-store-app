// ─── THE SCAN IS THE ONLY REQUESTER — source classifier + guard (1 Nov 2026) ──
// Run: cd functions && node --test test/request-source.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { classifyRequestSource, rejectTxn, rejectionRecord, REJECT_REASON } = require("../lib/request-source.cjs");

const base = { productId: "p1", size: "M", qty: 1, requestingLocation: "hub2", status: "open", createdAt: "2026-11-01T10:00:00.000Z" };
const NOW = "2026-11-01T10:00:05.000Z";

test("the scan and a Solve pass — tagged or by the shape they have always written", () => {
  assert.equal(classifyRequestSource({ ...base, requestSource: "scan", createdFrom: { engine: true, runId: "r", source: "central" } }), "scan");
  assert.equal(classifyRequestSource({ ...base, createdFrom: { engine: true, runId: "r", source: "central" } }), "scan");
  assert.equal(classifyRequestSource({ ...base, requestSource: "solve", createdFrom: { firstBatch: true, via: "missing_products_solve" } }), "solve");
  assert.equal(classifyRequestSource({ ...base, createdFrom: { firstBatch: true, via: "first_batch_hub2_leg" } }), "solve");
  assert.equal(classifyRequestSource({ ...base, requestSource: "solve", createdFrom: { manual: true, via: "missing_sneakers" } }), "solve");
});

test("the on-hold path, the website escalation, a typed-quantity request and an untagged write are rejected", () => {
  for (const cf of [
    { manual: true, source: "central", via: "on_hold", orderId: "275" },
    { manual: true, source: "central", via: "online_escalation", orderKey: "1", lineIndex: 0 },
    { manual: true, source: "central", via: "missing_sneakers_pick" },
    {},
  ]) assert.equal(classifyRequestSource({ ...base, createdFrom: cf }), null, JSON.stringify(cf));
  assert.equal(classifyRequestSource({ ...base }), null);
  assert.equal(classifyRequestSource(null), null);
});

test("a tag cannot be spoofed: 'scan' without the engine's shape, 'solve' without a Solve's, or an unknown tag", () => {
  assert.equal(classifyRequestSource({ ...base, requestSource: "scan", createdFrom: { manual: true, via: "on_hold" } }), null);
  assert.equal(classifyRequestSource({ ...base, requestSource: "solve", createdFrom: { manual: true, via: "online_escalation" } }), null);
  assert.equal(classifyRequestSource({ ...base, requestSource: "staff", createdFrom: { engine: true } }), null);
});

test("rejectTxn cancels an untouched rejected row, and never one a person started or a scan row", () => {
  const hold = { ...base, createdFrom: { manual: true, via: "on_hold" } };
  assert.equal(rejectTxn(null, { nowIso: NOW }), null);   // cold pass
  const out = rejectTxn(hold, { nowIso: NOW });
  assert.equal(out.status, "cancelled");
  assert.equal(out.cancelReason, REJECT_REASON);
  assert.equal(out.resolvedAt, NOW);
  for (const touched of [{ sentQty: 1 }, { fulfilledBy: { movementId: "m" } }, { picking: { token: "t" } }, { status: "fulfilled" }]) {
    assert.equal(rejectTxn({ ...hold, ...touched }, { nowIso: NOW }), undefined, JSON.stringify(touched));
  }
  assert.equal(rejectTxn({ ...base, createdFrom: { engine: true } }, { nowIso: NOW }), undefined);
});

test("the log record names what was asked and by which path", () => {
  const r = rejectionRecord("k1", { ...base, createdFrom: { via: "online_escalation", source: "central" }, stamps: { a: { personName: "Mike" } } }, { nowIso: NOW, cancelled: true });
  assert.deepEqual(r, { id: "k1", at: NOW, cancelled: true, productId: "p1", size: "M", qty: 1, requestingLocation: "hub2", source: "central", via: "online_escalation", requestSource: null, createdAt: base.createdAt, createdBy: "Mike" });
});
