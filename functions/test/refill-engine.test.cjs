// Tests for the pure refill-engine core. Run: cd functions && node --test
const { test } = require("node:test");
const assert = require("node:assert");
const { computeRefillPlan, computeConfidence, encodeSizeKey, saTodayKey, retryHistoryKey, sanitizeUpdate, resolveTarget } = require("../lib/refill-engine.cjs");

// ── retryHistoryKey — RTDB keys may NOT contain . # $ [ ] / ────────────────────
// Regression pin for the 2026-07-22 outage: an ISO timestamp in the key (its ".")
// crashed every scan synchronously on .update(). This fails if anyone reintroduces
// an ISO timestamp (or any forbidden char) into the key.
test("retryHistoryKey contains no RTDB-forbidden characters", () => {
  const FORBIDDEN = /[.#$/\[\]]/;
  const isoStamps = [
    "2026-07-22T13:50:20.076Z", // the exact outage timestamp (has a ".")
    "2026-01-01T00:00:00.000Z",
    new Date().toISOString(),
  ];
  for (const ts of isoStamps) {
    const key = retryHistoryKey("trophy", "p1780488485902", "XXL", ts);
    assert.ok(!FORBIDDEN.test(key), `key must not contain . # $ [ ] / — got: ${key}`);
    // and it must NOT embed the raw ISO string (which carries the ".")
    assert.ok(!key.includes(ts), `key must not embed the ISO timestamp — got: ${key}`);
  }
});

test("retryHistoryKey uses epoch-ms and stays unique/parseable", () => {
  const key = retryHistoryKey("marathon-pe", "p123", "M", "2026-07-22T13:50:20.076Z");
  assert.strictEqual(key, "marathon-pe|p123|M|" + Date.parse("2026-07-22T13:50:20.076Z"));
  // malformed timestamp degrades safely to 0, still a valid key
  const bad = retryHistoryKey("trophy", "p1", "S", "not-a-date");
  assert.strictEqual(bad, "trophy|p1|S|0");
});

// ── sanitizeUpdate — backstop for BOTH RTDB argument-validation outages ────────
// 2026-07-22 (#269): a "." in a KEY. 2026-07-24: an `undefined` VALUE.
// Both throw SYNCHRONOUSLY out of .update(), so `.catch()` never fires and the
// whole scan dies. These pin that a malformed payload is stripped and REPORTED
// rather than reaching the driver.
test("sanitizeUpdate strips undefined values and reports them", () => {
  // The exact 2026-07-24 outage payload shape.
  const { safe, problems } = sanitizeUpdate({
    "refill_engine/retryState/marathon-pe/p1780344640383/XL": {
      retryCount: 1,
      firstRejectedAt: undefined,      // ← the field that took the engine down 26h
      lastRejectedAt: undefined,
      nextRetryAt: "2026-07-26T09:06:00.083Z",
      source: "hub2",
    },
  });
  const node = safe["refill_engine/retryState/marathon-pe/p1780344640383/XL"];
  assert.ok(!("firstRejectedAt" in node), "undefined field must be stripped");
  assert.ok(!("lastRejectedAt" in node), "undefined field must be stripped");
  assert.strictEqual(node.retryCount, 1, "defined fields survive");
  assert.strictEqual(node.source, "hub2");
  assert.strictEqual(problems.length, 2, "both undefined fields reported");
  assert.ok(problems.every((p) => p.startsWith("undefined value at")), problems.join("; "));
});

test("sanitizeUpdate preserves null (a deliberate RTDB delete)", () => {
  const { safe, problems } = sanitizeUpdate({ "refill_engine/open/trophy/p1/M": null });
  assert.strictEqual(safe["refill_engine/open/trophy/p1/M"], null, "null must NOT be stripped — it deletes the node");
  assert.strictEqual(problems.length, 0);
});

test("sanitizeUpdate rejects forbidden chars in a path segment (the #269 class)", () => {
  // The exact 2026-07-22 outage key: an ISO timestamp's "." inside the segment.
  const badPath = "refill_engine/retryHistory/marathon-pe|p1783086715022|M|2026-07-21T13:20:04.885Z";
  const { safe, problems } = sanitizeUpdate({ [badPath]: { type: "retry" }, "refill_engine/ok/a": { v: 1 } });
  assert.ok(!(badPath in safe), "path with a forbidden char must be dropped");
  assert.deepStrictEqual(safe["refill_engine/ok/a"], { v: 1 }, "clean sibling paths still written");
  assert.strictEqual(problems.length, 1);
  assert.ok(problems[0].startsWith("forbidden path"), problems[0]);
});

test("sanitizeUpdate rejects forbidden chars in NESTED keys", () => {
  const { safe, problems } = sanitizeUpdate({ "a/b": { "ok": 1, "bad.key": 2, "sl/ash": 3 } });
  assert.deepStrictEqual(safe["a/b"], { ok: 1 });
  assert.strictEqual(problems.length, 2);
});

// CodeRabbit, PR #276: arrays were returned unrecursed, so an undefined element
// slipped straight through the guard to the driver. exceptions payloads ARE
// arrays of freeform objects, so this was a live hole in the backstop.
test("sanitizeUpdate recurses into arrays (undefined element cannot escape)", () => {
  const { safe, problems } = sanitizeUpdate({
    "stock_exceptions/latest": {
      missingSizes: [
        { loc: "trophy", pid: "p1", size: "XL", wanted: 1 },
        { loc: "trophy", pid: "p2", size: undefined },   // ← would have thrown
        undefined,                                        // ← whole element
      ],
    },
  });
  const rows = safe["stock_exceptions/latest"].missingSizes;
  assert.strictEqual(rows.length, 3, "array length/indices must be preserved");
  assert.ok(!("size" in rows[1]), "undefined field inside an array element is stripped");
  assert.strictEqual(rows[1].pid, "p2", "sibling fields survive");
  assert.strictEqual(rows[2], null, "undefined element becomes null, never spliced out");
  assert.strictEqual(problems.length, 2);
  // and the result must contain no undefined anywhere
  assert.ok(!JSON.stringify(rows).includes("undefined"));
});

// Kimi review, PR #276: ServerValue sentinels are { ".sv": ... } — that key
// starts with a "." and was being stripped as "forbidden". RTDB accepts them
// happily, so this was the guard corrupting legal data; under strict mode it
// would have aborted intent creation on every scan, forever.
test("sanitizeUpdate passes ServerValue sentinels through untouched", () => {
  const TIMESTAMP = { ".sv": "timestamp" };
  const INCREMENT = { ".sv": { increment: 1 } };
  const { safe, problems } = sanitizeUpdate({
    "orders/R001": { createdAt: TIMESTAMP, hits: INCREMENT, name: "Shop Refill" },
  });
  assert.deepStrictEqual(safe["orders/R001"].createdAt, TIMESTAMP, "TIMESTAMP sentinel must survive");
  assert.deepStrictEqual(safe["orders/R001"].hits, INCREMENT, "increment sentinel must survive");
  assert.strictEqual(safe["orders/R001"].name, "Shop Refill");
  assert.strictEqual(problems.length, 0, `sentinels are legal — got: ${problems.join("; ")}`);
});

// CodeRabbit, PR #276: the sentinel carve-out returned the value unvalidated, so
// an undefined INSIDE the sentinel body rode through the guard and threw anyway.
test("sanitizeUpdate validates the ServerValue BODY, not just the .sv key", () => {
  const { safe, problems } = sanitizeUpdate({
    "a/b": { good: { ".sv": { increment: 2 } }, bad: { ".sv": { increment: undefined } } },
  });
  assert.deepStrictEqual(safe["a/b"].good, { ".sv": { increment: 2 } }, "valid sentinel survives intact");
  assert.ok(!("bad" in safe["a/b"]), "a sentinel with a malformed body is dropped whole, not half-written");
  assert.ok(problems.some((p) => /malformed ServerValue sentinel/.test(p)), problems.join("; "));
  assert.ok(!JSON.stringify(safe).includes("undefined"));
});

test("sanitizeUpdate still rejects a dotted key that is NOT a ServerValue", () => {
  // The pass-through is narrow: sole key, exactly ".sv". Anything else is a bug.
  const { safe, problems } = sanitizeUpdate({ "a/b": { ".sv": "timestamp", other: 1 } });
  assert.ok(!(".sv" in safe["a/b"]), "a .sv mixed with siblings is not a sentinel — strip it");
  assert.strictEqual(problems.length, 1);
});

test("sanitizeUpdate leaves a clean payload byte-identical", () => {
  const clean = {
    "refill_requests/-Oabc": { qty: 2, source: "hub2", status: "open", note: null },
    "refill_engine/open/trophy/p1/M": { qty: 2, refillId: "-Oabc" },
  };
  const { safe, problems } = sanitizeUpdate(clean);
  assert.deepStrictEqual(safe, clean);
  assert.strictEqual(problems.length, 0);
});

// ── the engine-side half of the 2026-07-24 fix ────────────────────────────────
// The "retry" op REPLACES the whole retryState node, so it must emit every field
// the "reject" op does. This pins the omission that caused the outage.
// CodeRabbit, PR #276: the contract fixture below SETS lastRejectionReason, so
// it proves the field is carried but never exercises the `|| null` fallback.
// This case uses a LEGACY node that omits it — the only shape that can put
// `undefined` in the payload, i.e. the actual outage class.
test("retry retryOps: legacy node without lastRejectionReason emits null, not undefined", () => {
  const now = Date.parse("2026-07-25T09:00:00.000Z");
  const plan = computeRefillPlan({
    nowMs: now,
    config: {
      routes: { trophy: "hub2" },
      mode: { trophy: "live" },
      defaultRunByStore: { trophy: { M: 2 } },
      ruleBasedTargets: true,
      rejectCooldownHours: 24,
    },
    products: { p1: { productType: "clothing", sizes: ["M"] } },
    stock: { trophy: { p1: { M: { qty: 0 } } }, hub2: { p1: { M: { qty: 5 } } } },
    retryState: {
      trophy: { p1: { M: {
        retryCount: 1,
        firstRejectedAt: "2026-07-23T08:00:00.000Z",
        lastRejectedAt: "2026-07-23T08:00:00.000Z",
        nextRetryAt: "2026-07-24T08:00:00.000Z",
        // lastRejectionReason DELIBERATELY ABSENT — the legacy/partial shape
      } } },
    },
  });
  const retryOp = (plan.retryOps || []).find((o) => o.op === "retry");
  assert.ok(retryOp, "a due retry must still emit an op:retry");
  assert.strictEqual(retryOp.lastRejectionReason, null,
    "missing field must default to null — undefined here is what crashed every scan");
  const { problems } = sanitizeUpdate({ "refill_engine/retryState/trophy/p1/M": retryOp });
  assert.strictEqual(problems.length, 0, `payload must be clean — got: ${problems.join("; ")}`);
});

test("retry retryOps carry the rejection stamps (2026-07-24 outage pin)", () => {
  const now = Date.parse("2026-07-25T09:00:00.000Z");
  const plan = computeRefillPlan({
    nowMs: now,
    config: {
      routes: { trophy: "hub2" },
      mode: { trophy: "live" },
      defaultRunByStore: { trophy: { M: 2 } },
      ruleBasedTargets: true,          // the cell exists only via the rule
      rejectCooldownHours: 24,
    },
    products: { p1: { productType: "clothing", sizes: ["M"] } },
    stock: { trophy: { p1: { M: { qty: 0 } } }, hub2: { p1: { M: { qty: 5 } } } },
    // A rejection whose 24h retry window has already elapsed → emits an op:"retry".
    retryState: {
      trophy: { p1: { M: {
        retryCount: 1,
        firstRejectedAt: "2026-07-23T08:00:00.000Z",
        lastRejectedAt: "2026-07-23T08:00:00.000Z",
        nextRetryAt: "2026-07-24T08:00:00.000Z",
        lastRejectionReason: "cancelled",
      } } },
    },
  });
  const retryOp = (plan.retryOps || []).find((o) => o.op === "retry");
  assert.ok(retryOp, "a due retry must emit an op:retry");
  for (const f of ["retryCount", "firstRejectedAt", "lastRejectedAt", "lastRetryAt", "nextRetryAt", "lastRejectionReason"]) {
    assert.notStrictEqual(retryOp[f], undefined, `op:retry must define ${f} — undefined here crashed every scan on 2026-07-24`);
  }
  assert.strictEqual(retryOp.firstRejectedAt, "2026-07-23T08:00:00.000Z", "first rejection stamp is carried forward, not reset");
  // And the whole op must survive sanitizeUpdate untouched.
  const { problems } = sanitizeUpdate({ "refill_engine/retryState/trophy/p1/M": retryOp });
  assert.strictEqual(problems.length, 0, `op:retry payload must be clean — got: ${problems.join("; ")}`);
});

const NOW = Date.parse("2026-07-12T10:00:00.000Z");
const iso = (msAgoH = 0) => new Date(NOW - msAgoH * 3600e3).toISOString();

const CONFIG = {
  enabled: true,
  mode: { "marathon-pe": "live", trophy: "live", hub2: "live" },
  routes: { "marathon-pe": "hub2", trophy: "hub2", hub2: "central" },
  defaultRunByStore: {
    "marathon-pe": { S: 1, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1 },
    trophy: { S: 1, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1 },
  },
  defaultRunRecentSaleDays: 14,
  staleIntentHours: 48,
  maxUnitsPerIntent: 20,
  maxIntentsPerRun: 200,
  // Production configuration: rule-based clothing targets ON at every dest.
  // The suite exercises the shipped state; the kill-switch tests below override
  // this per-case. NOTE the engine default when the key is ABSENT is OFF
  // (fail-safe) — pinned in "kill switch: absent key means OFF".
  ruleBasedTargets: true,
};

const PRODUCTS = { p1: { name: "Tee", productType: "clothing", sizes: ["M", "L", "XL"] } };
const cell = (qty) => ({ qty, v: 1 });

function base(over = {}) {
  return {
    nowMs: NOW, config: CONFIG, products: PRODUCTS,
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } } },
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(10) } }, central: { p1: { M: cell(5) } }, trophy: {} },
    openIndex: {}, refillRequests: {}, orders: {}, movements: [],
    ...over,
  };
}

test("store below target → intent from routed source", () => {
  const plan = computeRefillPlan(base());
  const i = plan.intents.find((x) => x.dest === "marathon-pe" && x.productId === "p1");
  assert.ok(i, "intent created");
  assert.equal(i.source, "hub2");
  assert.equal(i.qty, 2); // target 3 − have 1
  assert.equal(i.priority, "high"); // have 1 < minQty 2
});

test("negative store qty counts as 0 available, never inflates deficit", () => {
  const plan = computeRefillPlan(base({
    stock: { "marathon-pe": { p1: { M: cell(-5) } }, hub2: { p1: { M: cell(10) } }, central: {}, trophy: {} },
  }));
  const i = plan.intents.find((x) => x.dest === "marathon-pe");
  assert.equal(i.qty, 3); // target 3 − max(−5,0) = 3, NOT 8
  assert.ok(plan.exceptions.negativeCells.count >= 1);
});

test("existing open intent suppresses a duplicate and reserves source stock", () => {
  const plan = computeRefillPlan(base({
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", qty: 2, source: "hub2", createdAt: iso(1) } } } },
  }));
  assert.equal(plan.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0);
});

test("manual Shop Refill order counts as inbound; engine autoRefill order does not double-count", () => {
  const plan = computeRefillPlan(base({
    orders: {
      "R001-1": { customerName: "Shop Refill", destShop: "marathon-pe", placedAtHub: "hub2", productId: "p1", size: "M", qty: 2, status: "incoming", clothingRefillStatus: null, createdAt: iso(1) },
    },
  }));
  assert.equal(plan.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0, "manual refill already covers the deficit");
});

test("ACTIONABLE-ONLY (v9): qty capped to what the source actually has; every card fully pickable", () => {
  const plan = computeRefillPlan(base({
    targets: {
      "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } },
      hub2: { p1: { M: { target: 4, minQty: 2 } } },
    },
    stock: {
      "marathon-pe": { p1: { M: cell(0) } },
      hub2: { p1: { M: cell(1) } },       // source has exactly 1
      central: { p1: { M: cell(50) } },
      trophy: {},
    },
  }));
  const storeLeg = plan.intents.find((x) => x.dest === "marathon-pe");
  assert.equal(storeLeg.qty, 1, "capped to source availability — the card is fully pickable as written");
  const hubLeg = plan.intents.find((x) => x.dest === "hub2");
  assert.equal(hubLeg.qty, 3); // hub2 target 4 − have 1, central has plenty
  assert.equal(hubLeg.source, "central");
});

test("CASCADE (v9): downstream leg is created only after the upstream leg lands", () => {
  const targets = {
    trophy: { p1: { M: { target: 2, minQty: 1 } } },
    hub2: { p1: { M: { target: 3, minQty: 2 } } },
  };
  // Scan 1: Trophy needs M, hub2 has NONE, central has plenty →
  // ONLY the central→hub2 leg is created; Trophy parks as awaiting-upstream.
  const scan1 = computeRefillPlan(base({
    targets,
    stock: { trophy: { p1: { M: cell(0) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(20) } }, "marathon-pe": {} },
  }));
  assert.equal(scan1.intents.filter((x) => x.dest === "trophy").length, 0, "no Trophy card while hub2 is empty");
  assert.equal(scan1.intents.filter((x) => x.dest === "hub2" && x.source === "central").length, 1, "the upstream leg IS created");
  assert.ok(scan1.exceptions.awaitingUpstream.items.some((w) => w.loc === "trophy" && w.source === "hub2"), "Trophy demand parked visibly, not dropped");
  // Scan 2: hub2 received → the Trophy leg auto-creates. Nobody recreated anything.
  const scan2 = computeRefillPlan(base({
    targets,
    stock: { trophy: { p1: { M: cell(0) } }, hub2: { p1: { M: cell(3) } }, central: { p1: { M: cell(17) } }, "marathon-pe": {} },
  }));
  assert.equal(scan2.intents.filter((x) => x.dest === "trophy" && x.source === "hub2").length, 1, "downstream leg lands the scan after the stock does");
});

test("AWAITING SUPPLIER (v9): whole upstream chain empty → passive category, never a card", () => {
  const plan = computeRefillPlan(base({
    targets: { "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } } },
    // stock exists ONLY at the other store — nothing hub2 or central can pick
    stock: { "marathon-pe": { p1: { M: cell(0) } }, trophy: { p1: { M: cell(4) } }, hub2: {}, central: {} },
  }));
  assert.equal(plan.intents.length, 0, "no impossible work");
  assert.ok(plan.exceptions.awaitingSupplier.items.some((w) => w.loc === "marathon-pe"), "parked under Awaiting Supplier");
  assert.ok(!plan.exceptions.missingSizes.items.some((m) => m.pid === "p1" && m.size === "M"), "M not on the reorder list — stock exists, just stranded");
});

test("AUTO-RESIZE: open requests continuously track reality — shrink, grow, cap, and in-flight skip", () => {
  const mkOpen = (qty, extra = {}) => ({
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "R007-1", orderCreatedAt: iso(2), qty, source: "hub2", createdAt: iso(2) } } } },
    refillRequests: { r1: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe", source: "hub2" } },
    orders: { "R007-1": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(2), clothingRefillStatus: null, status: "incoming", ...extra } },
  });
  // SHRINK: policy dropped to target 2; legacy ask was 3.
  const shrink = computeRefillPlan(base({
    ...mkOpen(3),
    targets: { "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } } },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: { p1: { M: cell(9) } }, central: {}, trophy: {} },
  }));
  assert.deepEqual(shrink.resizes[0] && { from: shrink.resizes[0].from, to: shrink.resizes[0].to }, { from: 3, to: 2 }, "3 → 2 (new deficit)");
  // GROW capped by source: deficit rose to 3 but hub2 only has 2.
  const grow = computeRefillPlan(base({
    ...mkOpen(1),
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } } },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: { p1: { M: cell(2) } }, central: {}, trophy: {} },
  }));
  assert.deepEqual(grow.resizes[0] && { from: grow.resizes[0].from, to: grow.resizes[0].to }, { from: 1, to: 2 }, "1 → 2 (deficit 3, source caps at 2)");
  // IN-FLIGHT: locked split → never resized this scan.
  const picking = computeRefillPlan(base({
    ...mkOpen(3, { clothingPlanGen: 0 }),
    targets: { "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } } },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: { p1: { M: cell(9) } }, central: {}, trophy: {} },
  }));
  assert.equal(picking.resizes.length, 0, "a card being picked keeps its quantity");
  // EXACT already: no resize entry.
  const exact = computeRefillPlan(base({
    ...mkOpen(2),
    targets: { "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } } },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: { p1: { M: cell(9) } }, central: {}, trophy: {} },
  }));
  assert.equal(exact.resizes.length, 0, "correct quantities are untouched");
});

test("AUTO-RESIZE threading: sibling grows share the source, never overcommit (Sonnet HIGH)", () => {
  // hub2 holds 10; A and B both hold qty-1 locks and both deficits widen to 8.
  // Stale-read math promised 16 vs 10 physical; threaded math shares exactly 10.
  const two = (qa, qb) => ({
    openIndex: {
      "marathon-pe": { p1: { M: { refillId: "rA", orderId: "R008-1", orderCreatedAt: iso(1), qty: qa, source: "hub2", createdAt: iso(1) } } },
      trophy: { p1: { M: { refillId: "rB", orderId: "R009-1", orderCreatedAt: iso(1), qty: qb, source: "hub2", createdAt: iso(1) } } },
    },
    refillRequests: {
      rA: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe", source: "hub2" },
      rB: { status: "open", productId: "p1", size: "M", requestingLocation: "trophy", source: "hub2" },
    },
    orders: {
      "R008-1": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: null, status: "incoming" },
      "R009-1": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: null, status: "incoming" },
    },
  });
  const grow = computeRefillPlan(base({
    ...two(1, 1),
    targets: { "marathon-pe": { p1: { M: { target: 8, minQty: 2 } } }, trophy: { p1: { M: { target: 8, minQty: 2 } } } },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, trophy: { p1: { M: cell(0) } }, hub2: { p1: { M: cell(10) } }, central: {} },
  }));
  const total = grow.resizes.reduce((t, r) => t + r.to, 0) +
    2 - grow.resizes.length * 1;   // resized locks new qty + untouched locks old qty (1 each)
  assert.ok(total <= 10, `combined promises (${total}) never exceed the 10 physical units`);
  assert.ok(grow.resizes.length >= 1, "at least one sibling grows into the free units");
  // Symmetric SHRINK converges: both qty-3 locks against deficits of 2 shrink
  // to 2 each — never frozen at their oversized quantities (old deadlock).
  const shrink = computeRefillPlan(base({
    ...two(3, 3),
    targets: { "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } }, trophy: { p1: { M: { target: 2, minQty: 1 } } } },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, trophy: { p1: { M: cell(0) } }, hub2: { p1: { M: cell(3) } }, central: {} },
  }));
  assert.equal(shrink.resizes.length, 2, "both oversized siblings shrink — never frozen");
  assert.ok(shrink.resizes.every((r) => r.to <= 2 && r.to >= 1), "each lands within its true deficit");
  assert.equal(shrink.resizes.reduce((t, r) => t + r.to, 0), 3, "combined claims converge to exactly the 3 physical units");
});

test("AUTO-RESIZE threading: a grow consumes the units BEFORE the deficit loop sees them", () => {
  // trophy lock grows 1→5 over hub2 five units; PE (no lock) must then park —
  // stale reservations previously let PE create a fresh 3-unit intent (8 vs 5).
  const plan = computeRefillPlan(base({
    openIndex: { trophy: { p1: { M: { refillId: "rB", orderId: "R009-1", orderCreatedAt: iso(1), qty: 1, source: "hub2", createdAt: iso(1) } } } },
    refillRequests: { rB: { status: "open", productId: "p1", size: "M", requestingLocation: "trophy", source: "hub2" } },
    orders: { "R009-1": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: null, status: "incoming" } },
    targets: { trophy: { p1: { M: { target: 5, minQty: 2 } } }, "marathon-pe": { p1: { M: { target: 3, minQty: 1 } } } },
    stock: { trophy: { p1: { M: cell(0) } }, "marathon-pe": { p1: { M: cell(0) } }, hub2: { p1: { M: cell(5) } }, central: {} },
  }));
  const rb = plan.resizes.find((r) => r.dest === "trophy");
  assert.deepEqual(rb && { from: rb.from, to: rb.to }, { from: 1, to: 5 }, "trophy grows into all 5");
  assert.equal(plan.intents.filter((i) => i.dest === "marathon-pe").length, 0, "PE cannot claim already-promised units");
  assert.ok(plan.exceptions.awaitingUpstream.items.some((w) => w.loc === "marathon-pe") || plan.exceptions.awaitingSupplier.items.some((w) => w.loc === "marathon-pe"), "PE parks passively");
});

test("AUTO-RESIZE emits for hub2 legs too (no orderId on the lock)", () => {
  const plan = computeRefillPlan(base({
    openIndex: { hub2: { p1: { M: { refillId: "rH", qty: 3, source: "central", createdAt: iso(1) } } } },
    refillRequests: { rH: { status: "open", productId: "p1", size: "M", requestingLocation: "hub2", source: "central" } },
    targets: { hub2: { p1: { M: { target: 2, minQty: 1 } } } },
    stock: { hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(9) } }, "marathon-pe": {}, trophy: {} },
  }));
  const rz = plan.resizes.find((r) => r.dest === "hub2");
  assert.deepEqual(rz && { from: rz.from, to: rz.to, orderId: rz.orderId }, { from: 3, to: 2, orderId: null }, "hub2 leg resizes with null orderId");
});

test("AUTO-RESIZE respects sibling reservations — never steals another request's units", () => {
  const plan = computeRefillPlan(base({
    targets: {
      "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } },
      trophy: { p1: { M: { target: 3, minQty: 2 } } },
    },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, trophy: { p1: { M: cell(0) } }, hub2: { p1: { M: cell(3) } }, central: {} },
    openIndex: {
      "marathon-pe": { p1: { M: { refillId: "rA", orderId: "R008-1", orderCreatedAt: iso(1), qty: 2, source: "hub2", createdAt: iso(1) } } },
      trophy: { p1: { M: { refillId: "rB", orderId: "R009-1", orderCreatedAt: iso(1), qty: 3, source: "hub2", createdAt: iso(1) } } },
    },
    refillRequests: {
      rA: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe", source: "hub2" },
      rB: { status: "open", productId: "p1", size: "M", requestingLocation: "trophy", source: "hub2" },
    },
    orders: {
      "R008-1": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: null, status: "incoming" },
      "R009-1": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: null, status: "incoming" },
    },
  }));
  // hub2 holds 3; PE reserves 2 → Trophy's ask must shrink to the 1 unit left.
  const rb = plan.resizes.find((r) => r.dest === "trophy");
  assert.deepEqual(rb && { from: rb.from, to: rb.to }, { from: 3, to: 1 }, "trophy 3 → 1 (PE's reservation respected)");
  assert.ok(!plan.resizes.some((r) => r.dest === "marathon-pe"), "PE ask (2) already ≤ its share");
});

test("NO SILENT STARVATION (v9): a source with no buffer target is a CONFIG block, never 'chain flowing'", () => {
  // Stores need M; hub2 is empty AND has NO target for the cell — no
  // central→hub2 leg will ever auto-create, so labelling this
  // awaiting-upstream would starve silently behind a self-healing promise.
  const plan = computeRefillPlan(base({
    targets: { "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } }, trophy: { p1: { M: { target: 2, minQty: 1 } } } },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, trophy: { p1: { M: cell(0) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(50) } } },
  }));
  assert.equal(plan.exceptions.awaitingUpstream.count, 0, "nothing may claim the chain is flowing");
  const blocked = plan.exceptions.awaitingSupplier.items.filter((w) => /no buffer target/.test(w.note));
  assert.equal(blocked.length, 2, "both stores surface as blocked-by-config, demanding a human");
  // Give hub2 its buffer target → the chain genuinely flows: hub2 leg created,
  // stores correctly park as awaiting-upstream.
  const flowing = computeRefillPlan(base({
    targets: {
      "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } }, trophy: { p1: { M: { target: 2, minQty: 1 } } },
      hub2: { p1: { M: { target: 3, minQty: 2 } } },
    },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, trophy: { p1: { M: cell(0) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(50) } } },
  }));
  assert.equal(flowing.intents.filter((x) => x.dest === "hub2").length, 1, "upstream leg created");
  assert.equal(flowing.exceptions.awaitingUpstream.items.filter((w) => w.loc !== "hub2").length, 2, "stores now genuinely awaiting upstream");
});

test("BLOCKED UPSTREAM (v9): a rejection-parked source leg is labelled blocked, not flowing", () => {
  // Central's queue rejected hub2's ask 10 MINUTES ago while central still
  // counts stock → inside the short recheck window the leg is parked and the
  // store demand is honestly labelled blocked (2026-07-19 recheck contract).
  const setup = {
    targets: {
      "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } },
      hub2: { p1: { M: { target: 3, minQty: 2 } } },
    },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(50) } }, trophy: {} },
  };
  const parked = computeRefillPlan(base({
    ...setup,
    refillRequests: { rHub: { status: "cancelled", resolvedAt: iso(1 / 6), productId: "p1", size: "M", requestingLocation: "hub2", source: "central", rejectedBy: "warehouse" } },
  }));
  assert.equal(parked.intents.length, 0, "hub2 leg rests inside the recheck window");
  assert.ok(parked.exceptions.awaitingSupplier.items.some((w) => w.loc === "marathon-pe" && /blocked/.test(w.note)),
    "store demand shows the truth: upstream leg blocked, not flowing");
  assert.equal(parked.exceptions.awaitingUpstream.count, 0);
  // 2h after the rejection the recheck window has long passed (central still
  // counts stock — either the count is wrong or the item is findable): the
  // hub2 leg re-asks and the store demand is flowing again.
  const reopened = computeRefillPlan(base({
    ...setup,
    refillRequests: { rHub: { status: "cancelled", resolvedAt: iso(2), productId: "p1", size: "M", requestingLocation: "hub2", source: "central", rejectedBy: "warehouse" } },
  }));
  assert.equal(reopened.intents.filter((x) => x.dest === "hub2" && x.sizeKey === "M").length, 1, "recheck window passed → central→hub2 re-asks");
  assert.ok(reopened.exceptions.awaitingUpstream.items.some((w) => w.loc === "marathon-pe"), "store demand back to flowing");
});

test("SOURCE RESERVATION (v9): two stores never get cards for the same physical unit", () => {
  const targets = {
    "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } },
    trophy: { p1: { M: { target: 2, minQty: 1 } } },
  };
  const stock = { "marathon-pe": { p1: { M: cell(0) } }, trophy: { p1: { M: cell(0) } }, hub2: { p1: { M: cell(3) } }, central: {} };
  const plan = computeRefillPlan(base({ targets, stock }));
  const totalAsked = plan.intents.reduce((t, i) => t + i.qty, 0);
  assert.equal(totalAsked, 3, "combined asks never exceed the 3 units hub2 actually holds (demand is 4)");
  // And an EXISTING open request reserves its units across scans too:
  const scan2 = computeRefillPlan(base({
    targets: { "marathon-pe": targets["marathon-pe"], trophy: targets.trophy },
    stock: { ...stock, hub2: { p1: { M: cell(1) } } },
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", qty: 1, source: "hub2", createdAt: iso(1) } } } },
    refillRequests: { r1: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe", source: "hub2" } },
  }));
  assert.equal(scan2.intents.filter((x) => x.dest === "trophy").length, 0, "hub2's last unit is already promised to PE — no Trophy card");
  assert.ok(scan2.exceptions.awaitingUpstream.items.some((w) => w.loc === "trophy") || scan2.exceptions.awaitingSupplier.items.some((w) => w.loc === "trophy"),
    "Trophy demand parks passively instead");
});

test("IN-FLIGHT GUARD (v9): a card being picked is never withdrawn under the picker", () => {
  const plan = computeRefillPlan(base({
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(9) } }, trophy: {} },
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "R005-3", orderCreatedAt: iso(1), qty: 2, source: "hub2", createdAt: iso(1) } } } },
    refillRequests: { r1: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe", source: "hub2" } },
    // The warehouse has LOCKED a split for this card (attempt underway).
    orders: { "R005-3": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: null, status: "incoming", clothingPlanGen: 0 } },
  }));
  assert.ok(!plan.closes.some((x) => x.reason === "awaiting_upstream"), "in-flight fulfilment is untouchable");
});

test("SOURCE-EMPTY WITHDRAW (v9): an open request the source can no longer fill leaves the queue", () => {
  const plan = computeRefillPlan(base({
    targets: {
      "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } },
      hub2: { p1: { M: { target: 3, minQty: 2 } } },   // buffer target — chain genuinely flows
    },
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(9) } }, trophy: {} },
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "R005-3", orderCreatedAt: iso(1), qty: 2, source: "hub2", createdAt: iso(1) } } } },
    refillRequests: { r1: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe", source: "hub2" } },
    orders: { "R005-3": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: null, status: "incoming" } },
  }));
  const c = plan.closes.find((x) => x.reason === "awaiting_upstream");
  assert.ok(c, "withdrawn — staff never scroll past unpickable cards");
  assert.equal(c.removeOrderId, "R005-3", "the queue card is deleted");
  assert.ok(plan.exceptions.awaitingUpstream.items.some((w) => w.loc === "marathon-pe"), "and the demand stays visible passively");
});

test("zero stock anywhere → NO request at all, straight to the reorder list", () => {
  const plan = computeRefillPlan(base({
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: {}, central: {}, trophy: {} },
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } }, hub2: { p1: { M: { target: 2, minQty: 1 } } } },
  }));
  assert.equal(plan.intents.length, 0, "provably unfillable — never enters a queue");
  assert.ok(plan.exceptions.missingSizes.count >= 1, "surfaced as a reorder candidate instead");
});

test("rejection cooldown: denier still counting stock → short recheck; denier empty → full 24h", () => {
  // 2026-07-19 recheck contract: the 24h rest only applies when the denier's
  // counted cell agrees with the "no" (empty). While it still claims stock,
  // the cell re-checks on the short window instead.
  const withStock = { stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(10) } }, central: {}, trophy: {} } };
  const rejOrder = (agoH) => ({ "R009-1": { customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: "p1", size: "M", clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(agoH), status: "incoming", createdAt: iso(agoH) } });
  const fresh = computeRefillPlan(base({ ...withStock, orders: rejOrder(0.25) }));
  assert.equal(fresh.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0, "15min since rejection → resting inside the recheck window");
  const rechecked = computeRefillPlan(base({ ...withStock, orders: rejOrder(2) }));
  assert.equal(rechecked.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "recheck window passed while hub2 still counts stock → ask again");
  const emptyDenier = { stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(5) } }, trophy: {} } };
  const resting = computeRefillPlan(base({ ...emptyDenier, orders: rejOrder(2) }));
  assert.equal(resting.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0, "denier counted empty → full 24h cooldown still holds");
  const after24 = computeRefillPlan(base({ ...withStock, orders: rejOrder(30) }));
  assert.equal(after24.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "cooldown passed + stock exists → ask again");
});

test("ARRIVAL LIFT: stock arriving at the source AFTER a rejection reopens the demand at once", () => {
  const withStock = { stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(10) } }, central: {}, trophy: {} } };
  const rejected5hAgo = {
    orders: { "R009-1": { customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: "p1", size: "M", clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(5), status: "incoming", createdAt: iso(5) } },
  };
  // Hub 2 received stock an hour ago (AFTER the 5h-old rejection) → the "no"
  // is stale; the engine re-asks immediately instead of resting out 24h.
  const arrived = computeRefillPlan(base({
    ...withStock, ...rejected5hAgo,
    movements: [{ type: "received", to: "hub2", productId: "p1", size: "M", qty: 10, ts: iso(1) }],
  }));
  assert.equal(arrived.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "arrival after rejection → reopened");
  // The only arrival PREDATES the rejection (they looked and said no AFTER the
  // stock came in) → the cooldown holds, and the parked demand is visible as
  // waitingForStock instead of vanishing. Denier counted EMPTY here — with the
  // 2026-07-19 recheck contract, a denier still counting stock re-asks on the
  // short window, so the 24h-resting cases must use an empty denier cell.
  // (central holds stock so the zero-upstream branch doesn't fire first —
  // the 24h cooldown gate is the thing under test)
  const emptyDenier = { stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(5) } }, trophy: {} } };
  const stale = computeRefillPlan(base({
    ...emptyDenier, ...rejected5hAgo,
    movements: [{ type: "received", to: "hub2", productId: "p1", size: "M", qty: 10, ts: iso(9) }],
  }));
  assert.equal(stale.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0, "arrival predates the rejection → still resting");
  assert.ok(stale.exceptions.waitingForStock.items.some((w) => w.pid === "p1" && w.loc === "marathon-pe" && w.source === "hub2"),
    "parked demand surfaced as Waiting for Stock");
  // An outbound movement (a sale at the source) is NOT an arrival — no lift.
  const soldOnly = computeRefillPlan(base({
    ...emptyDenier, ...rejected5hAgo,
    movements: [{ type: "sold", from: "hub2", productId: "p1", size: "M", qty: 1, ts: iso(1) }],
  }));
  assert.equal(soldOnly.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0, "a sale never lifts a rejection");
  // EVERY inbound type counts as arrival evidence (transfers carry a REAL
  // from+to in this system — no in_transit hop — so both legs qualify).
  for (const type of ["return", "adjustment", "transfer_in", "transfer_out", "opening"]) {
    const lifted = computeRefillPlan(base({
      ...withStock, ...rejected5hAgo,
      movements: [{ type, from: type.startsWith("transfer") ? "central" : undefined, to: "hub2", productId: "p1", size: "M", qty: 3, ts: iso(1) }],
    }));
    assert.equal(lifted.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, `${type} after rejection → reopened`);
  }
});

test("BOOKKEEPING ≠ ARRIVAL: a movement that leaves the cell at ≤0 lifts nothing", () => {
  const withStock = { stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(4) } }, trophy: {} } };
  const rejected5hAgo = {
    orders: { "R009-1": { customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: "p1", size: "M", clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(5), status: "incoming", createdAt: iso(5) } },
  };
  // The Negative Inventory "Fix → 0" adjustment records after:{hub2:0} — a
  // bookkeeping correction, not pickable stock. Must NOT reopen the demand.
  const negFix = computeRefillPlan(base({
    ...withStock, ...rejected5hAgo,
    movements: [{ type: "adjustment", to: "hub2", productId: "p1", size: "M", qty: 2, ts: iso(1), reason: "health_negative_zero_fix", after: { hub2: 0 } }],
  }));
  assert.equal(negFix.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0, "clearing a negative to 0 is not an arrival");
  assert.ok(negFix.exceptions.waitingForStock.items.some((w) => w.pid === "p1"), "still parked as Waiting for Stock");
  // A receive into a deep oversell hole (after still negative) lifts nothing.
  const intoHole = computeRefillPlan(base({
    ...withStock, ...rejected5hAgo,
    movements: [{ type: "received", to: "hub2", productId: "p1", size: "M", qty: 2, ts: iso(1), after: { hub2: -1 } }],
  }));
  assert.equal(intoHole.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0, "arrival swallowed by an oversell hole ≠ available stock");
  // The same receive that ends POSITIVE is a real arrival → reopened. (The
  // hub2 CELL carries the arrived stock too — v9 only queues actionable work.)
  const arrivedStock = { stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(3) } }, central: { p1: { M: cell(4) } }, trophy: {} } };
  const real = computeRefillPlan(base({
    ...arrivedStock, ...rejected5hAgo,
    movements: [{ type: "received", to: "hub2", productId: "p1", size: "M", qty: 3, ts: iso(1), after: { hub2: 3 } }],
  }));
  assert.equal(real.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "positive resulting balance → reopened");
  // Legacy movements without an after snapshot keep the old behavior (lift).
  const legacy = computeRefillPlan(base({
    ...arrivedStock, ...rejected5hAgo,
    movements: [{ type: "received", to: "hub2", productId: "p1", size: "M", qty: 3, ts: iso(1) }],
  }));
  assert.equal(legacy.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "no after snapshot → counted as before");
});

test("SAME-SCAN REOPEN: a rejected lock releases its inbound so the re-ask lands in the same plan", () => {
  // Rejection and arrival both happened since the last scan. The stale lock
  // must not keep counting as inbound — close AND fresh intent in ONE plan.
  const plan = computeRefillPlan(base({
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(10) } }, central: {}, trophy: {} },
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "R004-7", orderCreatedAt: iso(6), qty: 2, source: "hub2", createdAt: iso(6) } } } },
    refillRequests: { r1: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe", source: "hub2" } },
    orders: { "R004-7": { customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: "p1", size: "M", createdAt: iso(6), clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(5), status: "incoming" } },
    movements: [{ type: "received", to: "hub2", productId: "p1", size: "M", qty: 10, ts: iso(1) }],
  }));
  assert.ok(plan.closes.some((c) => c.refillId === "r1"), "stale lock closed");
  assert.equal(plan.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "re-ask in the SAME plan, not next scan");
});

test("DENIER-PINNED: after a route change, only arrival at the location that SAID no lifts the rejection", () => {
  const cfg = { ...CONFIG, routes: { "marathon-pe": "hub3", trophy: "hub2", hub2: "central" } };
  const rejectedByHub2 = {
    config: cfg,
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub3: { p1: { M: cell(8) } }, hub2: {}, central: {}, trophy: {} },
    orders: { "R011-3": { customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: "p1", size: "M", placedAtHub: "hub2", clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(5), status: "incoming", createdAt: iso(6) } },
  };
  // Arrival at the NEW route source (hub3) is no evidence against hub2's "no".
  const wrongLoc = computeRefillPlan(base({
    ...rejectedByHub2,
    movements: [{ type: "received", to: "hub3", productId: "p1", size: "M", qty: 5, ts: iso(1) }],
  }));
  assert.equal(wrongLoc.intents.filter((x) => x.dest === "marathon-pe").length, 0, "hub3 arrival ≠ hub2 evidence");
  assert.ok(wrongLoc.exceptions.waitingForStock.items.some((w) => w.source === "hub2"), "watches the denier, not today's route");
  // Arrival at the RECORDED denier (hub2) lifts it; the new route then supplies.
  const rightLoc = computeRefillPlan(base({
    ...rejectedByHub2,
    movements: [{ type: "received", to: "hub2", productId: "p1", size: "M", qty: 5, ts: iso(1) }],
  }));
  assert.equal(rightLoc.intents.filter((x) => x.dest === "marathon-pe" && x.source === "hub3").length, 1, "hub2 arrival reopens; intent routed via hub3");
});

test("ARRIVAL LIFT: confirmed-out clears when stock arrives at a denying level after its denial", () => {
  const denials = {
    orders: { "R009-1": { customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: "p1", size: "M", clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(30), status: "incoming", createdAt: iso(30) } },
    refillRequests: { rHub: { status: "cancelled", resolvedAt: iso(30), productId: "p1", size: "M", requestingLocation: "hub2", rejectedBy: "warehouse" } },
  };
  // Central receives the size from a supplier AFTER both denials → no longer
  // confirmed out; the normal cycle resumes (the 30h-old rejection has cooled
  // down, so the store's deficit is asked again right away).
  const restocked = computeRefillPlan(base({
    ...denials,
    movements: [{ type: "received", to: "central", productId: "p1", size: "M", qty: 6, ts: iso(2) }],
  }));
  assert.equal(restocked.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "arrival at Central un-confirms the out");
  assert.ok(!restocked.exceptions.missingSizes.items.some((m) => m.pid === "p1" && /confirmed out/.test(m.note)), "off the confirmed-out reorder list");
  // Arrival BEFORE the denials changes nothing — still confirmed out.
  const priorArrival = computeRefillPlan(base({
    ...denials,
    movements: [{ type: "received", to: "central", productId: "p1", size: "M", qty: 6, ts: iso(40) }],
  }));
  assert.equal(priorArrival.intents.filter((x) => x.productId === "p1" && x.sizeKey === "M").length, 0, "old arrival ≠ fresh evidence");
  assert.ok(priorArrival.exceptions.missingSizes.items.some((m) => m.pid === "p1" && /confirmed out/.test(m.note)), "stays on the reorder list");
});

test("excess: hub2 strict, stores only when significant; sneakers never counted", () => {
  const plan = computeRefillPlan(base({
    products: {
      p1: { name: "Tee", productType: "clothing", sizes: ["M"] },
      pSnk: { name: "Shoe", productType: "sneaker", sizes: ["8"] },
    },
    targets: {
      "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } },
      hub2: { p1: { M: { target: 3, minQty: 2 } } },
    },
    stock: {
      "marathon-pe": { p1: { M: cell(4) }, pSnk: { "8": cell(-3) } },  // +1 only → not significant
      hub2: { p1: { M: cell(4) } },                                     // +1 → flagged (strict)
      central: {}, trophy: {},
    },
  }));
  const locs = plan.exceptions.excess.items.map((e) => e.loc);
  assert.deepEqual(locs, ["hub2"]);
  assert.ok(plan.exceptions.negativeCells.items.every((n) => n.pid !== "pSnk"), "sneaker negatives filtered out");
});

test("restock resurrects a size: no stock = absent; stock appears = requested again", () => {
  const rejected = {
    orders: {
      "R009-1": { customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: "p1", size: "M", clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(30), status: "incoming", createdAt: iso(30) },
    },
  };
  const dry = computeRefillPlan(base({
    ...rejected,
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: {}, central: {}, trophy: {} },
  }));
  assert.equal(dry.intents.filter((x) => x.sizeKey === "M").length, 0, "nothing upstream → absent from queues");
  // Stock lands at CENTRAL only → v9 cascade: still no store card (hub2 is
  // empty), but the demand is visibly awaiting the upstream leg (hub2 has a
  // buffer target, so the chain genuinely flows).
  const centralOnly = computeRefillPlan(base({
    ...rejected,
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } }, hub2: { p1: { M: { target: 3, minQty: 2 } } } },
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: {}, central: { p1: { M: cell(12) } }, trophy: {} },
  }));
  assert.equal(centralOnly.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0, "hub2 still empty → cascades, no store card yet");
  assert.ok(centralOnly.exceptions.awaitingUpstream.items.some((w) => w.loc === "marathon-pe"), "parked as awaiting-upstream");
  // Stock reaches HUB 2 → the request returns to the queue.
  const restocked = computeRefillPlan(base({
    ...rejected,
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(6) } }, central: { p1: { M: cell(6) } }, trophy: {} },
  }));
  assert.equal(restocked.intents.filter((x) => x.sizeKey === "M").length, 1, "stock at the source + cooldown passed → asked again");
});

test("CONFIRMED OUT: denied at BOTH levels → no request anywhere, reorder list instead", () => {
  // Shop level said no (rejected Shop Refill line, 30h ago — past the 24h
  // cooldown, so WITHOUT the rule an intent would be re-created) AND Central
  // said no (cancelled hub2 request, no cancelReason). Counted cells still
  // show plenty — humans beat the database.
  const denials = {
    orders: { "R009-1": { customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: "p1", size: "M", clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(30), status: "incoming", createdAt: iso(30) } },
    refillRequests: { rHub: { status: "cancelled", resolvedAt: iso(30), productId: "p1", size: "M", requestingLocation: "hub2", rejectedBy: "warehouse" } },
  };
  const plan = computeRefillPlan(base(denials));
  assert.equal(plan.intents.filter((x) => x.productId === "p1" && x.sizeKey === "M").length, 0, "confirmed out — never asked again");
  assert.ok(plan.exceptions.missingSizes.items.some((m) => m.pid === "p1" && /confirmed out/.test(m.note)), "surfaced on the reorder list as confirmed out");

  // Only ONE level denied → normal lifecycle: the 30h-old shop rejection has
  // cooled down and stock exists upstream, so the engine re-asks.
  const oneLevel = computeRefillPlan(base({ orders: denials.orders }));
  assert.equal(oneLevel.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "single-level denial keeps the cooldown cycle");

  // An engine SELF-withdrawal at the central level never counts as a denial.
  const selfWithdraw = computeRefillPlan(base({
    orders: denials.orders,
    refillRequests: { rHub: { status: "cancelled", cancelReason: "unfillable", resolvedAt: iso(30), productId: "p1", size: "M", requestingLocation: "hub2" } },
  }));
  assert.equal(selfWithdraw.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "self-withdrawal ≠ human denial");

  // Window lapse (15 days > confirmedOutDays 14) → one re-ask resumes.
  const lapsed = computeRefillPlan(base({
    orders: { "R009-1": { ...denials.orders["R009-1"], clothingOutOfStockAt: iso(15 * 24), createdAt: iso(15 * 24) } },
    refillRequests: { rHub: { ...denials.refillRequests.rHub, resolvedAt: iso(15 * 24) } },
  }));
  assert.equal(lapsed.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "denials aged out — engine may re-ask once");
});

test("SELF-REVERSAL: request withdrawn when stock arrives by another path", () => {
  const openReq = {
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "R003-2", orderCreatedAt: iso(1), qty: 2, source: "hub2", createdAt: iso(1) } } } },
    refillRequests: { r1: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe" } },
    orders: { "R003-2": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: null, status: "incoming" } },
  };
  // Manual transfer / direct add / bulk return raised the shop to target (3/3):
  const topped = computeRefillPlan(base({
    ...openReq,
    stock: { "marathon-pe": { p1: { M: cell(3) } }, hub2: { p1: { M: cell(10) } }, central: {}, trophy: {} },
  }));
  const c = topped.closes.find((x) => x.reason === "no_longer_needed");
  assert.ok(c, "withdrawn on the next scan");
  assert.equal(c.removeOrderId, "R003-2", "warehouse card deleted before anyone picks it");
  assert.equal(c.rrStatus, "cancelled");
  // Still partially needed (1/3, ask covers it) → NOT withdrawn.
  const partial = computeRefillPlan(base({
    ...openReq,
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(10) } }, central: {}, trophy: {} },
  }));
  assert.ok(!partial.closes.some((x) => x.reason === "no_longer_needed"), "still needed → stays in the queue");
});

test("POLICY DROP reconciliation: lowering a target withdraws the now-oversized open request", () => {
  // Request for 2 units was created under the old policy (target 3, have 1).
  // The policy drops to target 1 → the shop already holds enough → the very
  // next scan withdraws the request (no human cleanup, no obsolete work).
  const openReq = {
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "R003-2", orderCreatedAt: iso(1), qty: 2, source: "hub2", createdAt: iso(1) } } } },
    refillRequests: { r1: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe", source: "hub2" } },
    orders: { "R003-2": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: null, status: "incoming" } },
  };
  const plan = computeRefillPlan(base({
    ...openReq,
    targets: { "marathon-pe": { p1: { M: { target: 1, minQty: 1 } } } },  // NEW reduced policy
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(10) } }, central: {}, trophy: {} },
  }));
  const c = plan.closes.find((x) => x.reason === "no_longer_needed");
  assert.ok(c, "request obsolete under the new policy → withdrawn");
  assert.equal(c.removeOrderId, "R003-2", "warehouse card deleted");
  assert.equal(plan.intents.length, 0, "and no replacement is created — target is met");
});

test("engine self-withdrawal imposes NO cooldown — a fresh dip re-asks immediately", () => {
  const plan = computeRefillPlan(base({
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(10) } }, central: {}, trophy: {} },
    refillRequests: { rOld: { status: "cancelled", cancelReason: "no_longer_needed", resolvedAt: iso(1), productId: "p1", size: "M", requestingLocation: "marathon-pe" } },
  }));
  assert.equal(plan.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1,
    "withdrawal an hour ago ≠ human rejection — deficit re-asks at once");
});

test("PURGE: open engine request that became unfillable is withdrawn from the queue", () => {
  const plan = computeRefillPlan(base({
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(0) } }, central: {}, trophy: {} },
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "R002-4", orderCreatedAt: iso(2), qty: 2, source: "hub2", createdAt: iso(2) } } } },
    refillRequests: { r1: { status: "open", productId: "p1", size: "M", requestingLocation: "marathon-pe" } },
    orders: { "R002-4": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(2), clothingRefillStatus: null, status: "incoming" } },
  }));
  const c = plan.closes.find((x) => x.reason === "unfillable");
  assert.ok(c, "withdrawn");
  assert.equal(c.rrStatus, "cancelled");
  assert.equal(c.removeOrderId, "R002-4", "the queue card is deleted, not left for staff to reject");
});

test("TWO-LEG MOVE EXCESS: store overage splits deficit-first to Hub 2, remainder to Central, in one card", () => {
  // The Shambeen case: PE M 7/2 (raw 5), hub2 M 0/3 (deficit 3) →
  // ONE card moving all 5: 3 → Hub 2 (Cortez preserved), 2 → Central.
  const plan = computeRefillPlan(base({
    products: { p1: { name: "Shambeen", productType: "clothing", sizes: ["M", "XL", "XXL"] } },
    targets: {
      "marathon-pe": { p1: { M: { target: 2, minQty: 1 }, XL: { target: 1, minQty: 1 }, XXL: { target: 1, minQty: 1 } } },
      hub2: { p1: { M: { target: 3, minQty: 2 }, XL: { target: 2, minQty: 1 }, XXL: { target: 2, minQty: 1 } } },
    },
    stock: {
      "marathon-pe": { p1: { M: cell(7), XL: cell(2), XXL: cell(3) } },
      hub2: { p1: { M: cell(0), XL: cell(0), XXL: cell(0) } },
      central: {}, trophy: {},
    },
  }));
  const ex = (sk) => plan.exceptions.excess.items.find((e) => e.loc === "marathon-pe" && e.sizeKey === sk);
  assert.deepEqual({ excess: ex("M").excess, toHub: ex("M").toHub, toCentral: ex("M").toCentral }, { excess: 5, toHub: 3, toCentral: 2 }, "M: whole overage, split deficit-first");
  assert.equal(ex("XL"), undefined, "XL raw 1 stays below the store threshold (sells down naturally)");
  assert.deepEqual({ toHub: ex("XXL").toHub, toCentral: ex("XXL").toCentral }, { toHub: 2, toCentral: 0 }, "XXL: fully-held overage now VISIBLE and routed to Hub 2");
});

test("TWO-LEG MOVE EXCESS: allocation is threaded — two stores never both fill the same Hub 2 need", () => {
  const plan = computeRefillPlan(base({
    products: { p1: { name: "Tee", productType: "clothing", sizes: ["M"] } },
    targets: {
      "marathon-pe": { p1: { M: { target: 1, minQty: 1 } } },
      trophy: { p1: { M: { target: 1, minQty: 1 } } },
      hub2: { p1: { M: { target: 3, minQty: 2 } } },
    },
    stock: {
      "marathon-pe": { p1: { M: cell(4) } },   // raw 3
      trophy: { p1: { M: cell(4) } },          // raw 3
      hub2: { p1: { M: cell(0) } },            // deficit 3
      central: {},
    },
  }));
  const items = plan.exceptions.excess.items.filter((e) => e.loc !== "hub2" && e.sizeKey === "M");
  const hubTotal = items.reduce((t, e) => t + (e.toHub || 0), 0);
  assert.equal(hubTotal, 3, "combined Hub 2 allocation equals its deficit exactly — no double-fill");
  assert.equal(items.reduce((t, e) => t + e.excess, 0), 6, "both stores still move their whole overage");
});

test("NO SILENT MISS: a stocked STANDARD size without a target surfaces under a managed product", () => {
  // The owner audit case: Diesel Jeans managed on L, but M×4 sits at hub2 with
  // no M target — no deficit ever computes for M, so no refill would EVER
  // generate. It must surface as a decision instead of vanishing.
  const plan = computeRefillPlan(base({
    products: { p1: { name: "Diesel Jeans", productType: "clothing", sizes: ["M", "L"] } },
    targets: { hub2: { p1: { L: { target: 3, minQty: 2 } } } },
    stock: { hub2: { p1: { L: cell(3), M: cell(4) } }, central: {}, "marathon-pe": {}, trophy: {} },
  }));
  const card = plan.exceptions.noTarget.items.find((c) => c.pid === "p1" && c.noStandard);
  assert.ok(card, "untargeted stocked M surfaces");
  assert.equal(card.units, 4);
  // And a NEW size arriving at CENTRAL (upstream) surfaces on the hub2 card
  // even though hub2 itself holds none of it yet.
  const upstream = computeRefillPlan(base({
    products: { p1: { name: "Diesel Jeans", productType: "clothing", sizes: ["S", "L"] } },
    targets: { hub2: { p1: { L: { target: 3, minQty: 2 } } } },
    stock: { hub2: { p1: { L: cell(3) } }, central: { p1: { S: cell(6) } }, "marathon-pe": {}, trophy: {} },
  }));
  const up = upstream.exceptions.noTarget.items.find((c) => c.pid === "p1" && c.loc === "hub2");
  assert.ok(up && up.units === 6, "central-stocked new size surfaces at the buffer");
});

test("Cortez fix: surplus is HELD for downstream deficits, never excess past a starving store", () => {
  const over = {
    products: { p1: { name: "Cortez tracksuit", productType: "clothing", sizes: ["XL"] } },
    targets: {
      "marathon-pe": { p1: { XL: { target: 2, minQty: 1 } } },
      hub2: { p1: { XL: { target: 2, minQty: 1 } } },
    },
    stock: {
      "marathon-pe": { p1: { XL: cell(0) } },   // store starving: deficit 2
      hub2: { p1: { XL: cell(3) } },            // hub +1 over its own target
      central: { p1: { XL: cell(20) } }, trophy: {},
    },
  };
  const plan = computeRefillPlan(base(over));
  assert.equal(plan.exceptions.excess.items.filter((e) => e.pid === "p1").length, 0,
    "hub2's +1 is held for the store's deficit — NOT excess to return to Central");
  // Once the store is satisfied, the same surplus IS excess again.
  const fed = computeRefillPlan(base({ ...over,
    stock: { "marathon-pe": { p1: { XL: cell(2) } }, hub2: { p1: { XL: cell(3) } }, central: { p1: { XL: cell(20) } }, trophy: {} },
  }));
  assert.deepEqual(fed.exceptions.excess.items.map((e) => `${e.loc}:${e.excess}`), ["hub2:1"]);
});

test("resolved order closes its lock (fulfilled on available, cancelled on rejected)", () => {
  const plan = computeRefillPlan(base({
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "R004-1", orderCreatedAt: iso(3), qty: 2, source: "hub2", createdAt: iso(3) } } } },
    orders: { "R004-1": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(3), clothingRefillStatus: "available", status: "incoming" } },
  }));
  const c = plan.closes.find((x) => x.pid === "p1");
  assert.ok(c); assert.equal(c.reason, "fulfilled");
});

test("recycled R-number (createdAt mismatch) does NOT close the lock; it goes stale instead", () => {
  const plan = computeRefillPlan(base({
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "R004-1", orderCreatedAt: iso(80), qty: 2, source: "hub2", createdAt: iso(80) } } } },
    orders: { "R004-1": { customerName: "Shop Refill", autoRefill: true, productId: "p1", size: "M", createdAt: iso(1), clothingRefillStatus: "available", status: "incoming" } },
  }));
  assert.equal(plan.closes.length, 0);
  assert.ok(plan.exceptions.stuckRefills.count >= 1, "80h old lock is stale");
});

test("circuit breaker is FAIR across destinations (no store starves another)", () => {
  const products = { p1: { productType: "clothing", sizes: [] } };
  const targets = { "marathon-pe": { p1: {} }, trophy: { p1: {} } };
  const stockPe = { p1: {} }, stockTr = { p1: {} }, stockHub = { p1: {} };
  for (let i = 0; i < 20; i++) {
    const s = `Z${i}`;
    products.p1.sizes.push(s);
    targets["marathon-pe"].p1[s] = { target: 3, minQty: 3 };  // ALL high priority
    stockPe.p1[s] = cell(0); stockHub.p1[s] = cell(9);
    if (i < 5) { targets.trophy.p1[s] = { target: 3, minQty: 1 }; stockTr.p1[s] = cell(0); } // few, normal priority
  }
  const plan = computeRefillPlan(base({
    config: { ...CONFIG, maxIntentsPerRun: 10 },
    products, targets,
    stock: { "marathon-pe": stockPe, trophy: stockTr, hub2: stockHub, central: {} },
  }));
  assert.equal(plan.intents.length, 10);
  const trophyGot = plan.intents.filter((i) => i.dest === "trophy").length;
  assert.equal(trophyGot, 5, "trophy gets its full share despite PE's bigger, higher-priority backlog");
});

test("three states: no target = noTarget surface (NOT excess); explicit 0 = all excess", () => {
  const plan = computeRefillPlan(base({
    products: {
      p1: PRODUCTS.p1,
      pUnset: { productType: "clothing", sizes: ["M"] },   // stock, NO target anywhere
      pBanned: { productType: "clothing", sizes: ["M"] },  // explicit target 0
    },
    targets: {
      "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } },
      hub2: { pBanned: { M: { target: 0, minQty: 0 } } },
    },
    stock: {
      "marathon-pe": { p1: { M: cell(3) } },
      hub2: { pUnset: { M: cell(6) }, pBanned: { M: cell(1) } },
      central: {}, trophy: {},
    },
  }));
  // Unconfigured circulating stock with standard sizes: awaiting MIGRATION
  // (v8), not a decision — and never auto-classified as excess.
  assert.equal(plan.exceptions.noTarget.count, 0, "standard-size circulating product is not a decision");
  assert.deepEqual(plan.exceptions.unintroduced.items, [
    { pid: "pUnset", standardSizes: ["M"], units: 6, byLoc: { central: 0, hub2: 6, "marathon-pe": 0, trophy: 0 } },
  ]);
  assert.ok(!plan.exceptions.excess.items.some((e) => e.pid === "pUnset"), "no-target is NOT excess");
  // Deliberate exclusion (target 0): every unit is excess, even a single one.
  assert.deepEqual(plan.exceptions.excess.items, [{ loc: "hub2", pid: "pBanned", sizeKey: "M", have: 1, target: 0, excess: 1 }]);
  // And unmanaged cells never generate refill intents.
  assert.ok(!plan.intents.some((i) => i.productId === "pUnset"));
});

test("decision types: keep (permanent), snooze (expires), until_change (fingerprint)", () => {
  // pUnset is numeric-size (no standard run) so it stays a GENUINE decision
  // under v8 — postponements only ever apply to decision cards, never to the
  // unintroduced migration list.
  const over = {
    products: { p1: PRODUCTS.p1, pUnset: { productType: "clothing", sizes: ["32"] } },
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } } },
    stock: { "marathon-pe": { p1: { M: cell(3) } }, hub2: { pUnset: { 32: cell(6) } }, central: {}, trophy: {} },
  };
  assert.equal(computeRefillPlan(base(over)).exceptions.noTarget.count, 1);
  // keep: permanent
  assert.equal(computeRefillPlan(base({ ...over,
    targetDecisions: { hub2: { pUnset: { decision: "keep" } } } })).exceptions.noTarget.count, 0);
  // snooze: suppressed until `until`, resurfaces after
  assert.equal(computeRefillPlan(base({ ...over,
    targetDecisions: { hub2: { pUnset: { decision: "snooze", until: new Date(NOW + 30 * 864e5).toISOString() } } } })).exceptions.noTarget.count, 0);
  assert.equal(computeRefillPlan(base({ ...over,
    targetDecisions: { hub2: { pUnset: { decision: "snooze", until: new Date(NOW - 1).toISOString() } } } })).exceptions.noTarget.count, 1, "expired snooze resurfaces");
  // until_change: suppressed while the network fingerprint matches, resurfaces on ANY qty change
  const { stockFingerprint } = require("../lib/refill-engine.cjs");
  const fp = stockFingerprint(base(over).stock, "pUnset");
  assert.equal(computeRefillPlan(base({ ...over,
    targetDecisions: { hub2: { pUnset: { decision: "until_change", fingerprint: fp } } } })).exceptions.noTarget.count, 0);
  const changed = JSON.parse(JSON.stringify(base(over).stock));
  changed.hub2.pUnset["32"] = cell(5); // one unit sold
  assert.equal(computeRefillPlan(base({ ...over, stock: changed,
    targetDecisions: { hub2: { pUnset: { decision: "until_change", fingerprint: fp } } } })).exceptions.noTarget.count, 1, "inventory change resurfaces the card");
});

// This is the EXPLICIT-ONLY (v5/v8) decision taxonomy, so it runs with the kill
// switch OFF. With rule-based targets ON the "leftover" class is absorbed by the
// rule rather than asked about — that is the feature working, pinned in the
// companion test directly below.
test("v8 split (rule OFF): circulating = unintroduced (migration) · central-only = NEW · numeric = decision · leftover = decision", () => {
  const plan = computeRefillPlan(base({
    config: { ...CONFIG, ruleBasedTargets: false },
    products: {
      p1: PRODUCTS.p1,                                          // targeted at PE
      pCirc: { productType: "clothing", sizes: ["M", "L"] },    // circulating, no targets → MIGRATION
      pFresh: { productType: "clothing", sizes: ["M"] },        // central-only, no targets → NEW
      pJeans: { productType: "clothing", sizes: ["32", "34"] }, // numeric circulating → DECISION (noStandard)
    },
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } } },
    stock: {
      central: { pCirc: { M: cell(9) }, pFresh: { M: cell(7) } },
      "marathon-pe": { p1: { M: cell(3) } },
      hub2: { pCirc: { L: cell(4) }, pJeans: { 32: cell(5) } },
      trophy: { p1: { M: cell(2) } },                           // leftover: targets elsewhere, none here
    },
  }));
  const nt = plan.exceptions.noTarget.items;
  // pCirc: stock at Central AND hub2 — NOT new, NOT a decision; one migration entry.
  assert.ok(!nt.some((c) => c.pid === "pCirc"), "circulating product never appears in the Decision Queue");
  const mig = plan.exceptions.unintroduced.items.find((u) => u.pid === "pCirc");
  assert.deepEqual(mig, { pid: "pCirc", standardSizes: ["M", "L"], units: 4, byLoc: { central: 9, hub2: 4, "marathon-pe": 0, trophy: 0 } });
  // pFresh: genuinely new (central-only) — leads the queue.
  assert.deepEqual(nt[0], { loc: "central", pid: "pFresh", units: 7, isNew: true });
  // pJeans: no standard quantities exist for numeric sizes — a real decision.
  assert.ok(nt.some((c) => c.pid === "pJeans" && c.noStandard && c.loc === "hub2"), "numeric-size product stays a decision");
  // p1 at Trophy: has targets at PE but none at Trophy — assortment decision.
  assert.ok(nt.some((c) => c.pid === "p1" && c.loc === "trophy" && !c.isNew && !c.noStandard), "leftover with targets elsewhere stays a decision");
  // Exactly one card per product — no duplicates across lists.
  const all = [...nt.map((c) => c.pid), ...plan.exceptions.unintroduced.items.map((u) => u.pid)];
  assert.equal(new Set(all).size, all.length, "one card per product, no dup across NEW/migration/decision");
});

// Companion to the above: the SAME "leftover" cell, with the switch ON. The rule
// includes it automatically, so the human decision disappears and the cell is
// refilled instead. This is the intended behaviour change of #259 — recorded
// here explicitly so nobody later reads the OFF-taxonomy test as a regression.
test("v8 leftover (rule ON): auto-included by the rule instead of asking a human", () => {
  const shared = {
    products: { p1: PRODUCTS.p1 },
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } } },
    stock: {
      "marathon-pe": { p1: { M: cell(3) } },
      hub2: { p1: { M: cell(10) } },
      central: {},
      // Leftover: targets at PE, none at Trophy. Must hold real units — a
      // qty-0 cell raises no decision card under either setting.
      trophy: { p1: { M: cell(1) } },
    },
  };
  const off = computeRefillPlan(base({ ...shared, config: { ...CONFIG, ruleBasedTargets: false } }));
  assert.ok(off.exceptions.noTarget.items.some((c) => c.pid === "p1" && c.loc === "trophy")
    || off.exceptions.unintroduced.items.some((u) => u.pid === "p1"),
    "switch OFF → still a human decision");

  const on = computeRefillPlan(base({ ...shared, config: { ...CONFIG, ruleBasedTargets: true } }));
  assert.ok(!on.exceptions.noTarget.items.some((c) => c.pid === "p1" && c.loc === "trophy"),
    "switch ON → no decision card; the rule already covers it");
  assert.ok(on.intents.some((i) => i.dest === "trophy" && i.productId === "p1" && i.sizeKey === "M"),
    "and it is actively refilled to the trophy standard run");
});

test("numeric-only product at TWO locations gets a decision card per location (dedup is migration-only)", () => {
  const plan = computeRefillPlan(base({
    products: { p1: PRODUCTS.p1, pJeans: { productType: "clothing", sizes: ["32", "34"] } },
    targets: { "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } } },
    stock: {
      "marathon-pe": { p1: { M: cell(2) } },
      hub2: { pJeans: { 32: cell(5) } },
      trophy: { pJeans: { 34: cell(3) } },
      central: {},
    },
  }));
  const cards = plan.exceptions.noTarget.items.filter((c) => c.pid === "pJeans" && c.noStandard);
  assert.equal(cards.length, 2, "one decision card per location holding stock");
  assert.deepEqual(cards.map((c) => c.loc).sort(), ["hub2", "trophy"], "no location's stock goes invisible");
});

test("sold-to-zero destination cell still counts as circulated — never NEW again", () => {
  const plan = computeRefillPlan(base({
    products: { p1: PRODUCTS.p1, pSoldOut: { productType: "clothing", sizes: ["M"] } },
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } } },
    stock: { central: { pSoldOut: { M: cell(6) } }, "marathon-pe": { p1: { M: cell(3) } }, hub2: { pSoldOut: { M: cell(0) } }, trophy: {} },
  }));
  assert.ok(!plan.exceptions.noTarget.items.some((c) => c.pid === "pSoldOut" && c.isNew), "a zero-qty cell is circulation evidence — not NEW");
  assert.ok(plan.exceptions.unintroduced.items.some((u) => u.pid === "pSoldOut"), "sold-through product goes to migration (demand proven)");
});

test("size-scoped guard: a managed product's stocked numeric sizes surface as noStandard", () => {
  const plan = computeRefillPlan(base({
    products: { p1: { name: "Mixed jeans", productType: "clothing", sizes: ["M", "32"] } },
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } } },
    stock: { "marathon-pe": { p1: { M: cell(3), 32: cell(4) } }, hub2: {}, central: {}, trophy: {} },
  }));
  const card = plan.exceptions.noTarget.items.find((c) => c.pid === "p1" && c.noStandard);
  assert.ok(card, "numeric leftover under a MANAGED pid is never silently lost");
  assert.equal(card.units, 4);
  assert.equal(card.loc, "marathon-pe");
  assert.equal(plan.exceptions.noTarget.items.filter((c) => c.pid === "p1").length, 1, "the targeted M cell creates no extra decision");
});

test("orphaned pending lock (crashed scan) self-heals; the freed deficit re-asks in the same plan", () => {
  const plan = computeRefillPlan(base({
    openIndex: { "marathon-pe": { p1: { M: { qty: 2, createdAt: iso(2), runId: "old", pending: true } } } },
  }));
  const c = plan.closes.find((x) => x.reason === "orphaned_pending");
  assert.ok(c, "pending lock older than 1h is removed");
  assert.equal(plan.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1, "released inbound → re-ask in the SAME plan");
  // A young pending lock is in-flight: untouched, still suppressing.
  const young = computeRefillPlan(base({
    openIndex: { "marathon-pe": { p1: { M: { qty: 2, createdAt: iso(0.5), runId: "cur", pending: true } } } },
  }));
  assert.ok(!young.closes.some((x) => x.reason === "orphaned_pending"), "young pending lock left alone");
  assert.equal(young.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0, "in-flight lock still counts as inbound");
});

test("NEW PRODUCT at Central (no targets anywhere) enters the Decision Queue", () => {
  const plan = computeRefillPlan(base({
    products: { p1: PRODUCTS.p1, pNew: { productType: "clothing", sizes: ["M", "L"] } },
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } } },
    stock: { "marathon-pe": { p1: { M: cell(3) } }, hub2: {}, trophy: {}, central: { pNew: { M: cell(20), L: cell(15) } } },
  }));
  const entry = plan.exceptions.noTarget.items.find((n) => n.pid === "pNew");
  assert.deepEqual(entry, { loc: "central", pid: "pNew", units: 35, isNew: true });
  // ...but a product introduced ANYWHERE no longer counts as new at Central.
  const introduced = computeRefillPlan(base({
    products: { pNew: { productType: "clothing", sizes: ["M"] } },
    targets: { trophy: { pNew: { M: { target: 2, minQty: 1 } } } },
    stock: { "marathon-pe": {}, hub2: {}, trophy: { pNew: { M: cell(2) } }, central: { pNew: { M: cell(20) } } },
  }));
  assert.ok(!introduced.exceptions.noTarget.items.some((n) => n.pid === "pNew" && n.loc === "central"));
});

test("engine computes default clothing targets from global rule when store carries the product", () => {
  const plan = computeRefillPlan(base({
    targets: {},
    stock: { "marathon-pe": { p1: { L: cell(0) } }, hub2: { p1: { L: cell(9) } }, central: {}, trophy: {} },
    movements: [{ type: "sold", from: "marathon-pe", productId: "p1", size: "L", qty: 1, ts: iso(5) }],
  }));
  assert.equal(plan.intents.length, 1, "default rule creates a request for the stocked size");
  assert.equal(plan.intents[0].dest, "marathon-pe");
  assert.equal(plan.intents[0].sizeKey, "L");
});

test("circuit breaker caps intents and reports an error", () => {
  const targets = { "marathon-pe": { p1: {} } };
  const stockPe = { p1: {} }; const stockHub = { p1: {} };
  const products = { p1: { productType: "clothing", sizes: [] } };
  for (let i = 0; i < 30; i++) {
    const s = `Z${i}`;
    products.p1.sizes.push(s);
    targets["marathon-pe"].p1[s] = { target: 3, minQty: 1 };
    stockPe.p1[s] = cell(0); stockHub.p1[s] = cell(9);
  }
  const plan = computeRefillPlan(base({
    config: { ...CONFIG, maxIntentsPerRun: 10 },
    products, targets,
    stock: { "marathon-pe": stockPe, hub2: stockHub, central: {}, trophy: {} },
  }));
  assert.equal(plan.intents.length, 10);
  assert.ok(plan.errors.length >= 1);
});

test("intelligence: onlyInCentral / onlyInHub2 / hub2 excess", () => {
  const plan = computeRefillPlan(base({
    products: { p1: PRODUCTS.p1, p2: { productType: "clothing", sizes: ["M"] }, p3: { productType: "clothing", sizes: ["M"] } },
    targets: { hub2: { p3: { M: { target: 2, minQty: 1 } } } },
    stock: {
      "marathon-pe": {}, trophy: {},
      hub2: { p3: { M: cell(11) } },
      central: { p2: { M: cell(7) } },
    },
  }));
  assert.deepEqual(plan.exceptions.onlyInCentral.items[0], { pid: "p2", units: 7 });
  assert.equal(plan.exceptions.onlyInHub2.items[0].pid, "p3");
  assert.deepEqual(plan.exceptions.excess.items[0], { loc: "hub2", pid: "p3", sizeKey: "M", have: 11, target: 2, excess: 9 });
});

test("confidence: negative cells + adjustments + uncounted sends lower the score", () => {
  const out = computeConfidence({
    nowMs: NOW,
    stock: { "marathon-pe": { p1: { M: { qty: -2, updatedAt: iso(1) } } } },
    movements: [
      { type: "adjustment", from: "marathon-pe", productId: "p1", ts: iso(24) },
      { type: "received", reason: "clothing_cr_uncounted", to: "marathon-pe", productId: "p1", ts: iso(24) },
    ],
  });
  const e = out["marathon-pe"].p1;
  assert.equal(e.score, 100 - 30 - 5 - 10);
  assert.equal(e.factors.negativeCells, 1);
});

test("saTodayKey matches device-local SA format (0-based month)", () => {
  // 2026-07-11 23:30 UTC = 2026-07-12 01:30 SA → key uses SA date, month 0-based
  assert.equal(saTodayKey(Date.parse("2026-07-11T23:30:00Z")), "2026-6-12");
  assert.equal(encodeSizeKey("5.5"), "5_5");
  assert.equal(encodeSizeKey(""), "_");
});

test("ZOMBIE LEG: lock whose order node is GONE → request cancelled order_lost, lock closed", () => {
  const plan = computeRefillPlan(base({
    openIndex: { "marathon-pe": { p1: { M: {
      refillId: "r9", qty: 1, source: "hub2", createdAt: iso(30),
      orderId: "R013-1", orderCreatedAt: iso(30),
    } } } },
    refillRequests: { r9: { productId: "p1", size: "M", qty: 1, requestingLocation: "marathon-pe", status: "open" } },
    orders: {},   // the R013-1 node was clobbered by the daily reset
  }));
  const c = plan.closes.find((x) => x.refillId === "r9");
  assert.ok(c, "zombie close emitted");
  assert.equal(c.reason, "order_lost");
  assert.equal(c.rrStatus, "cancelled");
  assert.equal(c.cancelReason, "order_lost");
  assert.ok(!c.removeOrderId, "must never delete a same-key node that belongs to a later order");
});

test("ZOMBIE LEG: order node RECYCLED (same key, different createdAt) → order_lost, node untouched", () => {
  const plan = computeRefillPlan(base({
    openIndex: { "marathon-pe": { p1: { M: {
      refillId: "r9", qty: 1, source: "hub2", createdAt: iso(30),
      orderId: "R013-1", orderCreatedAt: iso(30),
    } } } },
    refillRequests: { r9: { productId: "p1", size: "M", qty: 1, requestingLocation: "marathon-pe", status: "open" } },
    // Same key, but a DIFFERENT (later) order: createdAt no longer matches.
    orders: { "R013-1": { productId: "p1", size: "M", createdAt: iso(2), customerName: "Shop Refill", status: "incoming", autoRefill: true } },
  }));
  const c = plan.closes.find((x) => x.refillId === "r9");
  assert.ok(c, "recycled-node zombie close emitted");
  assert.equal(c.cancelReason, "order_lost");
  assert.ok(!c.removeOrderId, "the recycled node belongs to the newer order — never deleted");
});

test("ZOMBIE guard: a matching, unresolved order is NOT order_lost (normal reconcile continues)", () => {
  const plan = computeRefillPlan(base({
    openIndex: { "marathon-pe": { p1: { M: {
      refillId: "r9", qty: 1, source: "hub2", createdAt: iso(1),
      orderId: "R013-1", orderCreatedAt: iso(1),
    } } } },
    refillRequests: { r9: { productId: "p1", size: "M", qty: 1, requestingLocation: "marathon-pe", status: "open" } },
    orders: { "R013-1": { productId: "p1", size: "M", createdAt: iso(1), customerName: "Shop Refill", status: "incoming", autoRefill: true, clothingRefillStatus: null } },
  }));
  assert.ok(!plan.closes.find((x) => x.cancelReason === "order_lost"), "live matching leg untouched");
});

test("DEFAULT RULE: stocked catalog size at a carrying store gets the standard target", () => {
  const plan = computeRefillPlan(base({
    config: { ...CONFIG, defaultRunByStore: { ...CONFIG.defaultRunByStore, hub2: { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 1 } } },
    stock: { "marathon-pe": {}, trophy: {}, central: { p1: { L: cell(9), M: cell(9), XL: cell(9), XXXL: cell(9) } }, hub2: { p1: { L: cell(2), XXXL: cell(1), M: cell(0) } } },
    targets: {},
  }));
  const l = plan.intents.find((a) => a.dest === "hub2" && a.productId === "p1" && a.sizeKey === "L");
  assert.ok(l, "L default target computed");
  assert.equal(l.qty, 1);                       // target 3 − have 2
  const xxxl = plan.intents.find((a) => a.sizeKey === "XXXL");
  assert.ok(!xxxl, "XXXL at target — no intent");
  const m = plan.intents.find((a) => a.sizeKey === "M");
  assert.equal(m.qty, 3);                       // target 3 − have 0
});

test("DEFAULT RULE: explicit targets (incl. 0 exclusions) always win over the rule", () => {
  const over = {
    config: { ...CONFIG, defaultRunByStore: { ...CONFIG.defaultRunByStore, hub2: { L: 3, M: 3 } } },
    stock: { "marathon-pe": {}, trophy: {}, central: { p1: { M: cell(9), L: cell(9) } }, hub2: { p1: { L: cell(2), M: cell(2) } } },
    targets: { hub2: { p1: { L: { target: 0 } } } },   // explicit exclusion
  };
  const plan = computeRefillPlan(base(over));
  assert.ok(!plan.intents.find((a) => a.sizeKey === "L"), "explicit 0 wins over default");
  assert.ok(plan.intents.find((a) => a.sizeKey === "M"), "sibling size still gets default");
});

test("DEFAULT RULE: non-carrying store and non-clothing products get no default", () => {
  const stockOver = { "marathon-pe": {}, trophy: {}, central: {}, hub2: { p1: { M: cell(2), 8: cell(4) } } };
  const plan = computeRefillPlan(base({
    stock: stockOver, targets: {},
    products: { p1: { name: "Tee", productType: "clothing", sizes: ["M", "8"] } },
  }));
  assert.equal(plan.intents.filter((a) => a.dest === "marathon-pe").length, 0, "store without stock node never gets default");
  assert.ok(!plan.intents.find((a) => a.sizeKey === "8"), "numeric size never gets default");
  const snk = computeRefillPlan(base({
    stock: { "marathon-pe": { pSnk: { "8": cell(0) } }, hub2: { pSnk: { "8": cell(9) } }, central: {}, trophy: {} },
    targets: {},
    products: { pSnk: { name: "Shoe", productType: "sneaker", sizes: ["8"] } },
  }));
  assert.equal(snk.intents.length, 0, "sneaker never gets default");
});

// ── Reject re-check + loop guard (incident 2026-07-19: wrong shelf) ───────────
// A rejection while the denier's counted cell still shows stock re-checks on a
// SHORT window (default 30 min) instead of the 24h cooldown; N such rejections
// (default 3) park the cell in Recount Needed instead of looping forever.

const rejectedOrder = (agoH) => ({
  o_rej: {
    customerName: "Shop Refill", clothingRefillStatus: "rejected",
    destShop: "marathon-pe", productId: "p1", size: "M",
    clothingOutOfStockAt: iso(agoH), createdAt: iso(agoH), placedAtHub: "hub2",
  },
});
const streakNode = (count, agoH = 1) => ({
  "marathon-pe": { p1: { M: { count, lastTs: iso(agoH), by: "hub2" } } },
});

test("reject while denier still counts stock → re-proposes after the SHORT recheck window", () => {
  const plan = computeRefillPlan(base({ orders: rejectedOrder(0.75) })); // 45 min ago > 30 min recheck
  const i = plan.intents.find((x) => x.dest === "marathon-pe" && x.sizeKey === "M");
  assert.ok(i, "re-proposed after recheck window despite 24h cooldown not having elapsed");
});

test("reject while denier still counts stock → suppressed INSIDE the recheck window, surfaced as waiting", () => {
  const plan = computeRefillPlan(base({ orders: rejectedOrder(0.25) })); // 15 min ago < 30 min recheck
  assert.equal(plan.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0);
  const w = plan.exceptions.waitingForStock.items.find((x) => x.loc === "marathon-pe");
  assert.ok(w && /re-checks in/.test(w.note), "waiting entry carries the recheck note");
});

test("reject while denier counted EMPTY → full 24h cooldown unchanged", () => {
  const plan = computeRefillPlan(base({
    orders: rejectedOrder(2),
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(5) } }, trophy: {} },
  }));
  assert.equal(plan.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0);
  const w = plan.exceptions.waitingForStock.items.find((x) => x.loc === "marathon-pe");
  assert.ok(w && /reopens when stock arrives/.test(w.note), "empty denier keeps the arrival/24h contract");
});

// ── LOOP GUARD RESTORED (2026-07-25) — supersedes #259's "no permanent park" ──
// This test previously asserted the OPPOSITE: that a streak at the limit keeps
// retrying every 24h. That was #259 silently reversing the 2026-07-19 incident
// fix, whose entire purpose was to STOP re-asking into a wrong count. The owner
// restored the guard; the assertion is inverted to match, and the precedence
// (park BEATS retry) is pinned explicitly below.
test("streak at limit + stock still shown → PARKED in Recount Needed, not re-asked", () => {
  const plan = computeRefillPlan(base({ orders: rejectedOrder(30), rejectStreak: streakNode(4) }));
  assert.equal(
    plan.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0,
    "30h later the guard still holds — a bad count must not be re-asked forever",
  );
  const r = plan.exceptions.recountNeeded.items.find((x) => x.loc === "marathon-pe" && x.size === "M");
  assert.ok(r, "surfaced for a human recount");
  assert.equal(r.rejections, 4);
  assert.match(r.note, /Ask again/, "note tells staff how to release it");
});

test("streak park BEATS the 24h auto-retry (precedence is load-bearing)", () => {
  // A cell that is BOTH streak-flagged AND has an elapsed retry window. If the
  // retry were evaluated first it would re-ask and the guard would be decorative
  // — which is exactly the regression #259 introduced.
  const plan = computeRefillPlan(base({
    orders: rejectedOrder(30),
    rejectStreak: streakNode(4),
    retryState: { "marathon-pe": { p1: { M: {
      retryCount: 2,
      firstRejectedAt: iso(72), lastRejectedAt: iso(30),
      nextRetryAt: iso(6),           // due 6h ago — retry WOULD fire
      lastRejectionReason: "cancelled",
    } } } },
  }));
  assert.equal(plan.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 0,
    "park wins: no intent, even though the retry window elapsed");
  assert.ok(plan.exceptions.recountNeeded.items.some((x) => x.loc === "marathon-pe"), "still parked for recount");
  assert.ok(!(plan.retryOps || []).some((o) => o.op === "retry" && o.dest === "marathon-pe"),
    "a parked cell must not emit a retry op either");
});

test("below the streak limit, the 24h auto-retry still works (guard is not a blanket stop)", () => {
  const plan = computeRefillPlan(base({ orders: rejectedOrder(30), rejectStreak: streakNode(1) }));
  assert.equal(plan.intents.filter((x) => x.dest === "marathon-pe" && x.sizeKey === "M").length, 1,
    "ordinary rejection: re-asks after the cooldown as designed");
  assert.equal(plan.exceptions.recountNeeded.count, 0);
});

test("RETRY: denier no longer shows stock → streak reset, normal cooldown resumes", () => {
  const plan = computeRefillPlan(base({
    orders: rejectedOrder(2), rejectStreak: streakNode(3),
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(5) } }, trophy: {} },
  }));
  assert.equal(plan.exceptions.recountNeeded.count, 0);
  assert.ok(plan.streakOps.some((o) => o.op === "reset" && o.dest === "marathon-pe" && o.pid === "p1" && o.sizeKey === "M"));
});

test("RETRY: stock ARRIVES at the denier after the last strike → re-asks immediately", () => {
  const plan = computeRefillPlan(base({
    orders: rejectedOrder(1), rejectStreak: streakNode(3, 1),
    movements: [{ type: "received", to: "hub2", productId: "p1", size: "M", qty: 5, ts: iso(0.5), after: { hub2: 15 } }],
  }));
  assert.equal(plan.exceptions.recountNeeded.count, 0);
  assert.ok(plan.streakOps.some((o) => o.op === "reset" && o.dest === "marathon-pe"));
  assert.ok(plan.intents.find((x) => x.dest === "marathon-pe" && x.sizeKey === "M"), "arrival lift re-proposes");
});

test("reconciled human rejection increments the streak when the denier still shows stock", () => {
  const plan = computeRefillPlan(base({
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "o1", orderCreatedAt: iso(2), qty: 2, source: "hub2", createdAt: iso(2) } } } },
    refillRequests: { r1: { status: "open", requestingLocation: "marathon-pe", productId: "p1", size: "M" } },
    orders: { o1: { customerName: "Shop Refill", destShop: "marathon-pe", productId: "p1", size: "M", createdAt: iso(2), clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(0.1) } },
  }));
  const close = plan.closes.find((c) => c.dest === "marathon-pe" && c.sizeKey === "M");
  assert.ok(close && close.streakOp && close.streakOp.op === "inc", "streak inc attached to its close");
  assert.equal(close.streakOp.count, 1);
  assert.equal(close.streakOp.by, "hub2");
});

test("fulfilment resets an existing streak", () => {
  const plan = computeRefillPlan(base({
    rejectStreak: streakNode(2),
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "o1", orderCreatedAt: iso(2), qty: 2, source: "hub2", createdAt: iso(2) } } } },
    refillRequests: { r1: { status: "open", requestingLocation: "marathon-pe", productId: "p1", size: "M" } },
    orders: { o1: { customerName: "Shop Refill", destShop: "marathon-pe", productId: "p1", size: "M", createdAt: iso(2), clothingRefillStatus: "available" } },
  }));
  const close = plan.closes.find((c) => c.dest === "marathon-pe" && c.sizeKey === "M");
  assert.ok(close && close.streakOp && close.streakOp.op === "reset", "reset attached to the fulfilled close");
});

// ── Loop guard round 2 (review blocker): hub2/rr-only rejections + flagged-source labelling ──

test("hub2 queue rejection (rr cancelled, no cancelReason) increments the streak — no uncapped recheck loop", () => {
  const plan = computeRefillPlan(base({
    targets: { hub2: { p1: { M: { target: 3, minQty: 2 } } } },
    stock: { "marathon-pe": {}, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(50) } }, trophy: {} },
    openIndex: { hub2: { p1: { M: { refillId: "rHub", qty: 2, source: "central", createdAt: iso(2) } } } },
    refillRequests: { rHub: { status: "cancelled", resolvedAt: iso(0.1), requestingLocation: "hub2", productId: "p1", size: "M", source: "central", rejectedBy: "warehouse" } },
  }));
  const close = plan.closes.find((c) => c.dest === "hub2" && c.sizeKey === "M");
  assert.ok(close && close.streakOp && close.streakOp.op === "inc", "human rr-reject counted on its close");
  assert.equal(close.streakOp.by, "central");
});

test("engine self-withdrawal (rr cancelled WITH cancelReason) never increments the streak", () => {
  const plan = computeRefillPlan(base({
    targets: { hub2: { p1: { M: { target: 3, minQty: 2 } } } },
    stock: { "marathon-pe": {}, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(50) } }, trophy: {} },
    openIndex: { hub2: { p1: { M: { refillId: "rHub", qty: 2, source: "central", createdAt: iso(2) } } } },
    refillRequests: { rHub: { status: "cancelled", cancelReason: "unfillable", resolvedAt: iso(0.1), requestingLocation: "hub2", productId: "p1", size: "M", source: "central" } },
  }));
  assert.equal(plan.streakOps.filter((o) => o.op === "inc").length, 0);
  assert.ok(plan.closes.every((c) => !c.streakOp || c.streakOp.op !== "inc"), "no inc on any close either");
});

// ── SOURCE-LEG GUARD RESTORED (2026-07-25) — inverted from #259 ───────────────
// Previously asserted the store demand "flows again" while its supplying leg was
// parked awaiting a recount. That is the starvation case the 07-19 fix named
// explicitly: demand sitting under a reassuring label behind a leg nobody is
// working. A parked source leg must report the store as BLOCKED.
test("streak-flagged source leg parks, and the store behind it reports BLOCKED", () => {
  const plan = computeRefillPlan(base({
    targets: {
      "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } },
      hub2: { p1: { M: { target: 3, minQty: 2 } } },
    },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: { p1: { M: cell(0) } }, central: { p1: { M: cell(50) } }, trophy: {} },
    rejectStreak: { hub2: { p1: { M: { count: 4, lastTs: iso(30), by: "central" } } } },
  }));
  assert.equal(plan.intents.filter((x) => x.dest === "hub2").length, 0, "the flagged hub2 leg stays parked");
  assert.ok(plan.exceptions.recountNeeded.items.some((x) => x.loc === "hub2"), "hub2 leg surfaced for recount");
  assert.ok(!plan.exceptions.awaitingUpstream.items.some((w) => w.loc === "marathon-pe"),
    "store must NOT be labelled 'flowing' behind a parked leg");
  const b = plan.exceptions.awaitingSupplier.items.find((w) => w.loc === "marathon-pe");
  assert.ok(b, "store demand is reported as blocked");
  assert.match(b.note, /awaits a recount/, "and the note names the real remedy");
});

// ═══ KILL SWITCH — /config/refillEngine/ruleBasedTargets ═════════════════════
// The emergency control. These pin that it works instantly, in both directions,
// with no half-state, and that ABSENT means OFF (fail-safe).
const carried = (over = {}) => base({
  // pRule is carried at trophy (stock node present) with NO explicit target —
  // it exists ONLY by virtue of the rule, so it is the perfect switch probe.
  products: { ...PRODUCTS, pRule: { productType: "clothing", sizes: ["M", "L"] } },
  targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } } },
  stock: {
    "marathon-pe": { p1: { M: cell(1) } },
    hub2: { p1: { M: cell(10) }, pRule: { M: cell(10), L: cell(10) } },
    central: { p1: { M: cell(5) } },
    trophy: { pRule: { M: cell(0), L: cell(0) } },
  },
  ...over,
});
// hub2 needs its own standard run for the rule to resolve there — production
// has one (S2 M3 L3 XL2 XXL2 XXXL1); the shared CONFIG above only defines the
// two stores, so the switch probes supply it explicitly.
const RULE_CONFIG = { ...CONFIG, defaultRunByStore: { ...CONFIG.defaultRunByStore, hub2: { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 1 } } };
const rulePlan = (ruleBasedTargets) =>
  computeRefillPlan(carried({ config: { ...RULE_CONFIG, ruleBasedTargets } }));

test("kill switch ON: rule-based targets manage a carried product with no explicit target", () => {
  const plan = rulePlan(true);
  const mine = plan.intents.filter((i) => i.productId === "pRule" && i.dest === "trophy");
  assert.equal(mine.length, 2, "M and L both refilled by the rule");
  assert.ok(plan.stats.managedCells > 0);
  assert.deepEqual(plan.policy.ruleBasedTargets, { "marathon-pe": true, trophy: true, hub2: true });
});

test("kill switch OFF: engine reverts to explicit-targets-only, no crash, no half-state", () => {
  const plan = rulePlan(false);
  assert.equal(plan.intents.filter((i) => i.productId === "pRule").length, 0,
    "no rule-based intents at all");
  // explicit targets keep working exactly as before
  assert.ok(plan.intents.some((i) => i.productId === "p1" && i.dest === "marathon-pe"),
    "explicit-target refills are untouched by the switch");
  assert.equal(plan.errors.filter((e) => /undefined|cannot|TypeError/i.test(e)).length, 0, "clean run");
  assert.deepEqual(plan.policy.ruleBasedTargets, { "marathon-pe": false, trophy: false, hub2: false });
});

test("kill switch: absent key means OFF (fail-safe)", () => {
  const { ruleBasedTargets, ...noKey } = CONFIG;
  const plan = computeRefillPlan(carried({ config: noKey }));
  assert.equal(plan.intents.filter((i) => i.productId === "pRule").length, 0,
    "a missing/garbled config node must never silently switch thousands of cells ON");
});

test("kill switch: per-destination map", () => {
  const plan = rulePlan({ trophy: true, hub2: false, "marathon-pe": false });
  assert.ok(plan.intents.some((i) => i.productId === "pRule" && i.dest === "trophy"), "trophy on");
  assert.ok(!plan.intents.some((i) => i.productId === "pRule" && i.dest === "hub2"), "hub2 off");
  assert.deepEqual(plan.policy.ruleBasedTargets, { "marathon-pe": false, trophy: true, hub2: false });
});

test("kill switch: flipping OFF then ON is fully reversible on the next scan", () => {
  const on1 = rulePlan(true).intents.filter((i) => i.productId === "pRule").length;
  const off = rulePlan(false).intents.filter((i) => i.productId === "pRule").length;
  const on2 = rulePlan(true).intents.filter((i) => i.productId === "pRule").length;
  assert.ok(on1 > 0 && off === 0 && on2 === on1,
    `expected on→off→on to be symmetric, got ${on1}/${off}/${on2}`);
});

// ═══ THROTTLE — /config/refillEngine/maxIntentsPerRun ═════════════════════════
test("throttle caps intents per scan and reports it in policy", () => {
  const plan = computeRefillPlan(carried({ config: { ...RULE_CONFIG, ruleBasedTargets: true, maxIntentsPerRun: 1 } }));
  // Guard the fixture itself: with only one intent computed, a cap of 1 would
  // "pass" without ever exercising the throttle. (CodeRabbit, PR #277.)
  assert.ok(plan.policy.intentsComputed > 1, `fixture must compute >1 intent, got ${plan.policy.intentsComputed}`);
  assert.equal(plan.intents.length, 1, "hard cap honoured");
  assert.equal(plan.policy.maxIntentsPerRun, 1);
  assert.ok(plan.policy.throttled, "policy records that this run was throttled");
  assert.ok(plan.policy.intentsComputed > plan.policy.intentsPlanned, "and how much was deferred");
});

// ═══ P1 — PHANTOM DECISION QUEUES ════════════════════════════════════════════
// #259 changed what the planner manages but not what these queues ask, so
// rule-managed products kept demanding a human decision (382 noTarget + 211
// unintroduced phantoms live on 2026-07-25).
test("a rule-managed product does NOT appear in noTarget/unintroduced", () => {
  const plan = rulePlan(true);
  assert.ok(!plan.exceptions.noTarget.items.some((x) => x.pid === "pRule"),
    "engine is actively refilling it — it is not an open decision");
  assert.ok(!plan.exceptions.unintroduced.items.some((x) => x.pid === "pRule"),
    "nor is it awaiting migration");
});

test("with the switch OFF the same product DOES surface as a decision again", () => {
  const plan = rulePlan(false);
  const surfaced = plan.exceptions.noTarget.items.some((x) => x.pid === "pRule")
    || plan.exceptions.unintroduced.items.some((x) => x.pid === "pRule");
  assert.ok(surfaced, "queues follow the switch — v5 behaviour returns intact");
});

// Kimi, PR #277: the excess loop asked the explicit row, so a rule-managed cell
// that was massively overstocked appeared in NO queue — not excess (no explicit
// row) and not noTarget (managedHere skips rule-managed products).
test("rule-managed overstock still surfaces as excess", () => {
  const plan = computeRefillPlan(carried({
    config: { ...RULE_CONFIG, ruleBasedTargets: true },
    products: { ...PRODUCTS, pOver: { productType: "clothing", sizes: ["M"] } },
    targets: {},                                    // NO explicit rows anywhere
    stock: {
      "marathon-pe": {}, hub2: {}, central: {},
      trophy: { pOver: { M: cell(14) } },           // rule target for trophy M is 2
    },
  }));
  const ex = plan.exceptions.excess.items.find((e) => e.pid === "pOver" && e.loc === "trophy");
  assert.ok(ex, "overstock against a RULE target must be visible in Move Excess");
  assert.equal(ex.target, 2, "measured against the rule target");
  assert.equal(ex.excess, 12);
});

test("throttle: a negative maxIntentsPerRun cannot silently stop the engine", () => {
  // Unclamped, -5 is truthy → breaker trips → deal loop exits → zero intents,
  // every scan, while the run record claims it merely throttled.
  const plan = computeRefillPlan(carried({ config: { ...RULE_CONFIG, ruleBasedTargets: true, maxIntentsPerRun: -5 } }));
  assert.ok(plan.intents.length >= 1, "clamped to at least 1 — never a silent total stop");
  const zero = computeRefillPlan(carried({ config: { ...RULE_CONFIG, ruleBasedTargets: true, maxIntentsPerRun: 0 } }));
  assert.ok(zero.intents.length >= 1, "0 falls back to the default, not to a stop");
});

// CodeRabbit, PR #277: the blind-spot guard iterated `targets[loc]` — explicit
// rows only. A RULE-managed product has no explicit row, so a numeric size it
// holds was skipped by the decision queues (managedHere → continue) AND never
// visited by the guard: no target, no request, surfaced nowhere. Silent miss.
test("rule-managed product: a numeric size still surfaces as a blind spot", () => {
  const plan = computeRefillPlan(carried({
    config: { ...RULE_CONFIG, ruleBasedTargets: true },
    // pMixed is covered by the rule on M/L, and also holds jeans size 32 which
    // the standard run does NOT cover. It has NO explicit target row anywhere.
    products: { ...PRODUCTS, pMixed: { productType: "clothing", sizes: ["M", "L", "32"] } },
    targets: { "marathon-pe": { p1: { M: { target: 3, minQty: 2 } } } },
    stock: {
      "marathon-pe": { p1: { M: cell(1) } },
      hub2: { p1: { M: cell(10) } },
      central: {},
      trophy: { pMixed: { M: cell(1), 32: cell(4) } },
    },
  }));
  // The rule manages it, so it must NOT be an unintroduced/assortment card…
  assert.ok(!plan.exceptions.unintroduced.items.some((u) => u.pid === "pMixed"),
    "rule-managed → not awaiting migration");
  // …but the untargetable numeric size MUST still be visible to a human.
  const card = plan.exceptions.noTarget.items.find((c) => c.pid === "pMixed" && c.loc === "trophy" && c.noStandard);
  assert.ok(card, "numeric size under a rule-managed product must not go silently unmanaged");
  assert.equal(card.units, 4, "only the untargetable size's units are counted, not the rule-covered M");
});

test("explicit target 0 is a DECISION, never a blind spot (three-state rule holds)", () => {
  const plan = computeRefillPlan(carried({
    config: { ...CONFIG, ruleBasedTargets: false },
    targets: { hub2: { pRule: { M: { target: 0, minQty: 0 } } } },
    stock: { "marathon-pe": {}, hub2: { pRule: { M: cell(5) } }, central: {}, trophy: {} },
  }));
  assert.ok(!plan.exceptions.noTarget.items.some((x) => x.pid === "pRule" && x.noStandard),
    "a deliberate exclusion must not be re-surfaced as an unmanaged size");
});

test("dormant streak (older than the ledger window) resets instead of flagging a forgotten mismatch", () => {
  const plan = computeRefillPlan(base({
    rejectStreak: { "marathon-pe": { p1: { M: { count: 3, lastTs: iso(60 * 24), by: "hub2" } } } },
  }));
  assert.equal(plan.exceptions.recountNeeded.count, 0);
  assert.ok(plan.streakOps.some((o) => o.op === "reset" && o.dest === "marathon-pe" && o.sizeKey === "M"));
  assert.ok(plan.intents.find((x) => x.dest === "marathon-pe" && x.sizeKey === "M"), "cell resumes normal proposing");
});

test("sub-limit streaks age out too — old strikes never combine with fresh ones months later", () => {
  const plan = computeRefillPlan(base({
    rejectStreak: { "marathon-pe": { p1: { M: { count: 2, lastTs: iso(20 * 24), by: "hub2" } } } }, // 20d > 14d window
  }));
  assert.ok(plan.streakOps.some((o) => o.op === "reset" && o.dest === "marathon-pe" && o.sizeKey === "M"),
    "stale sub-limit streak cleared");
  assert.equal(plan.exceptions.recountNeeded.count, 0);
  assert.ok(plan.intents.find((x) => x.dest === "marathon-pe" && x.sizeKey === "M"), "cell proposes normally");
});

test("fresh rejection over an EXPIRED streak restarts the count at 1 — never combines with dead strikes", () => {
  const plan = computeRefillPlan(base({
    rejectStreak: { "marathon-pe": { p1: { M: { count: 3, lastTs: iso(20 * 24), by: "hub2" } } } }, // stale (>14d)
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "o1", orderCreatedAt: iso(2), qty: 2, source: "hub2", createdAt: iso(2) } } } },
    refillRequests: { r1: { status: "open", requestingLocation: "marathon-pe", productId: "p1", size: "M" } },
    orders: { o1: { customerName: "Shop Refill", destShop: "marathon-pe", productId: "p1", size: "M", createdAt: iso(2), clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(0.1) } },
  }));
  const close = plan.closes.find((c) => c.dest === "marathon-pe" && c.sizeKey === "M");
  assert.ok(close && close.streakOp && close.streakOp.op === "inc");
  assert.equal(close.streakOp.count, 1, "expired evidence discarded — fresh strike is #1, not #4");
});

// ── Rule-based target engine + 24h auto-retry (owner 2026-07-21) ─────────────

test("DEFAULT RULE: every catalog size at a carrying store gets the global rule target", () => {
  const plan = computeRefillPlan(base({
    targets: {},
    stock: { "marathon-pe": { p1: { L: cell(0) } }, hub2: { p1: { L: cell(9), M: cell(9), XL: cell(9) } }, central: {}, trophy: {} },
  }));
  const sizes = plan.intents.map((i) => i.sizeKey).sort();
  assert.deepEqual(sizes, ["L", "M", "XL"], "all catalog sizes proposed");
});

test("DEFAULT RULE: store that does not carry the product gets no target", () => {
  const plan = computeRefillPlan(base({
    targets: {},
    stock: { "marathon-pe": {}, trophy: { p1: { L: cell(1) } }, hub2: { p1: { L: cell(9), M: cell(9), XL: cell(9) } }, central: {} },
  }));
  assert.equal(plan.intents.filter((i) => i.dest === "marathon-pe").length, 0, "marathon-pe never carried p1");
  assert.ok(plan.intents.filter((i) => i.dest === "trophy").length >= 1, "trophy carries p1");
});

test("DEFAULT RULE: zero-qty stock node still counts as carrying", () => {
  const plan = computeRefillPlan(base({
    targets: {},
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: { p1: { M: cell(9) } }, central: {}, trophy: {} },
  }));
  assert.equal(plan.intents.filter((i) => i.dest === "marathon-pe" && i.sizeKey === "M").length, 1, "zero-qty node still carries");
});

test("RETRY: rejection writes retryState + retryHistory; retry after 24h", () => {
  const rejected = {
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", orderId: "o1", orderCreatedAt: iso(2), qty: 2, source: "hub2", createdAt: iso(2) } } } },
    refillRequests: { r1: { status: "open", requestingLocation: "marathon-pe", productId: "p1", size: "M" } },
    orders: { o1: { customerName: "Shop Refill", destShop: "marathon-pe", productId: "p1", size: "M", createdAt: iso(2), clothingRefillStatus: "rejected", clothingOutOfStockAt: iso(0.1) } },
  };
  const plan = computeRefillPlan(base(rejected));
  const rejOp = plan.retryOps.find((o) => o.op === "reject" && o.dest === "marathon-pe");
  assert.ok(rejOp, "reject op emitted");
  assert.equal(rejOp.retryCount, 1);
  const hist = plan.retryOps.find((o) => o.op === "history" && o.type === "rejection");
  assert.ok(hist, "history entry emitted");
  // 24h later, the cell retries automatically
  const retryPlan = computeRefillPlan(base({
    ...rejected,
    orders: { o1: { ...rejected.orders.o1, clothingOutOfStockAt: iso(26), createdAt: iso(26) } },
    retryState: { "marathon-pe": { p1: { M: { retryCount: 1, firstRejectedAt: iso(26), lastRejectedAt: iso(26), nextRetryAt: iso(1) } } } },
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(10) } }, central: {}, trophy: {} },
  }));
  assert.equal(retryPlan.intents.filter((i) => i.dest === "marathon-pe" && i.sizeKey === "M").length, 1, "retry intent created after 24h");
  const retryOp = retryPlan.retryOps.find((o) => o.op === "retry");
  assert.ok(retryOp, "retry op emitted");
  const retryHist = retryPlan.retryOps.find((o) => o.op === "history" && o.type === "retry");
  assert.ok(retryHist, "retry history entry emitted");
});

test("RETRY: open lock prevents duplicate retry", () => {
  const plan = computeRefillPlan(base({
    openIndex: { "marathon-pe": { p1: { M: { refillId: "r1", qty: 2, source: "hub2", createdAt: iso(1) } } } },
    retryState: { "marathon-pe": { p1: { M: { retryCount: 1, firstRejectedAt: iso(26), lastRejectedAt: iso(26), nextRetryAt: iso(1) } } } },
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(10) } }, central: {}, trophy: {} },
  }));
  assert.equal(plan.intents.filter((i) => i.dest === "marathon-pe" && i.sizeKey === "M").length, 0, "open lock suppresses duplicate");
});

test("RETRY: manual exclusion stops retrying", () => {
  const plan = computeRefillPlan(base({
    targets: { "marathon-pe": { p1: { M: { target: 0 } } } },
    retryState: { "marathon-pe": { p1: { M: { retryCount: 1, firstRejectedAt: iso(26), lastRejectedAt: iso(26), nextRetryAt: iso(1) } } } },
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(10) } }, central: {}, trophy: {} },
  }));
  assert.equal(plan.intents.filter((i) => i.dest === "marathon-pe" && i.sizeKey === "M").length, 0, "explicit 0 stops retry");
});

test("RETRY: no source stock pauses retry, resumes when stock arrives", () => {
  const dry = computeRefillPlan(base({
    retryState: { "marathon-pe": { p1: { M: { retryCount: 1, firstRejectedAt: iso(26), lastRejectedAt: iso(26), nextRetryAt: iso(1) } } } },
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: {}, central: {}, trophy: {} },
  }));
  assert.equal(dry.intents.filter((i) => i.dest === "marathon-pe" && i.sizeKey === "M").length, 0, "no source stock → no retry");
  const wet = computeRefillPlan(base({
    retryState: { "marathon-pe": { p1: { M: { retryCount: 1, firstRejectedAt: iso(26), lastRejectedAt: iso(26), nextRetryAt: iso(1) } } } },
    stock: { "marathon-pe": { p1: { M: cell(1) } }, hub2: { p1: { M: cell(5) } }, central: {}, trophy: {} },
  }));
  assert.equal(wet.intents.filter((i) => i.dest === "marathon-pe" && i.sizeKey === "M").length, 1, "source stock arrives → retry resumes");
});

// ═══ CATEGORY POLICY — /config/refillEngine/categoryPolicy (2026-08-13) ═══════
// The owner's standing rule: the CATEGORY a product is given is what arms it.
// These tests pin the whole contract: precedence (explicit row > map > clothing
// rules), the two size modes, the dead-size 0, the off switch, survival of the
// kill switch, and byte-for-byte non-interference with unmapped clothing and
// footwear.
const CAT_CONFIG = {
  ...CONFIG,
  categoryPolicy: {
    perfumes: {
      "marathon-pe": { target: 8, reorderPoint: 3, minQty: 4 },
      hub2: { target: 10, reorderPoint: 5, minQty: 5 },
    },
    "caps-beanies": {
      "marathon-pe": { target: 5, reorderPoint: 0, minQty: 3 },
      hub2: { target: 10, reorderPoint: 0, minQty: 5 },
    },
    "fitted-caps": {
      perSize: true,
      "marathon-pe": { target: 2, reorderPoint: 0, minQty: 1 },
      hub2: { target: 5, reorderPoint: 0, minQty: 3 },
    },
  },
};
const CAT_PRODUCTS = {
  scent1: { name: "Gentleman Givenchy perfume", categoryKey: "perfumes", sizes: ["_"] },   // NO productType — the live shape
  beanie1: { name: "Nike beanie brown", productType: "clothing", categoryKey: "caps-beanies", subcategory: "Caps & Hats", sizes: ["_"] },
  capLegacy: { name: "Lacoste cap", productType: "clothing", categoryKey: "caps-beanies", subcategory: "Caps & Hats", sizes: ["M"] },
  fitted1: { name: "TC fitted cap navy/red", productType: "clothing", categoryKey: "fitted-caps", subcategory: "Caps & Hats", sizes: ["S", "M", "XXXL"] },
  // The unmapped controls carry REAL categoryKeys — an unmapped KEY, not a
  // missing one, is the case a sloppy map lookup would wrongly match.
  p1: { ...PRODUCTS.p1, categoryKey: "t-shirts" },
  shoe1: { name: "Air Zoom", category: "Footwear", categoryKey: "sneakers", sizes: ["8"] },
  // A one-size NON-mapped class: the exact record a sloppy lookup would arm,
  // because "_" is the size a one-size map entry speaks for.
  belt1: { name: "Belt Premium", productType: "clothing", categoryKey: "belts", sizes: ["_"] },
};
const catCtx = (over = {}) => ({
  targets: {}, config: CAT_CONFIG, products: CAT_PRODUCTS,
  stock: {
    central: { scent1: { _: cell(48) }, fitted1: { M: cell(0) } },
    hub2: { fitted1: { M: cell(3), S: cell(1) } },
    "marathon-pe": { capLegacy: { M: cell(0) }, fitted1: { S: cell(2), M: cell(1) } },
    trophy: {},
  },
  ...over,
});

test("category policy: a row-less perfume resolves the map at both mapped legs — and nowhere else", () => {
  const ctx = catCtx();
  assert.deepEqual(resolveTarget(ctx, "marathon-pe", "scent1", "_"),
    { target: 8, minQty: 4, reorderPoint: 3, source: "category_policy" });
  assert.deepEqual(resolveTarget(ctx, "hub2", "scent1", "_"),
    { target: 10, minQty: 5, reorderPoint: 5, source: "category_policy" });
  // Decision 5: a location the entry does not name gets NOTHING.
  assert.equal(resolveTarget(ctx, "trophy", "scent1", "_"), null);
});

test("category policy: an explicit row still WINS — the map never overrides it", () => {
  const ctx = catCtx({ targets: { "marathon-pe": { scent1: { _: { target: 3, minQty: 1, reorderPoint: 1 } } } } });
  assert.deepEqual(resolveTarget(ctx, "marathon-pe", "scent1", "_"),
    { target: 3, minQty: 1, reorderPoint: 1, source: "explicit" });
  // …including an explicit 0 — "deliberately excluded" beats the map too.
  const zero = catCtx({ targets: { hub2: { scent1: { _: { target: 0, minQty: 0 } } } } });
  assert.equal(resolveTarget(zero, "hub2", "scent1", "_").target, 0);
  assert.equal(resolveTarget(zero, "hub2", "scent1", "_").source, "explicit");
});

test("category policy one-size mode: '_' resolves the map, a LETTER falls through to the clothing rules", () => {
  const ctx = catCtx();
  // The collapsed/one-size record: map numbers on the sentinel.
  assert.deepEqual(resolveTarget(ctx, "marathon-pe", "beanie1", "_"),
    { target: 5, minQty: 3, reorderPoint: 0, source: "category_policy" });
  // The uncollapsed legacy record: its M cell keeps the garment run (M: 2)
  // exactly as before the map existed — the map does not starve letter stock.
  assert.deepEqual(resolveTarget(ctx, "marathon-pe", "capLegacy", "M"),
    { target: 2, minQty: 1, reorderPoint: null, source: "default" });
});

test("category policy per-size mode: live sizes get the numbers, dead sizes get an EXPLICIT 0, undeclared get nothing", () => {
  const ctx = catCtx();
  // M holds units (hub2 3, pe 1) → mapped numbers at both legs.
  assert.deepEqual(resolveTarget(ctx, "marathon-pe", "fitted1", "M"),
    { target: 2, minQty: 1, reorderPoint: 0, source: "category_policy" });
  assert.deepEqual(resolveTarget(ctx, "hub2", "fitted1", "M"),
    { target: 5, minQty: 3, reorderPoint: 0, source: "category_policy" });
  // XXXL is declared and stocked NOWHERE → target 0 from the map — a STOP that
  // the garment run below can never re-arm (it would have said XXXL: 1).
  const dead = resolveTarget(ctx, "marathon-pe", "fitted1", "XXXL");
  assert.equal(dead.target, 0);
  assert.equal(dead.source, "category_policy");
  // An undeclared size resolves nothing from the map (nor the run).
  assert.equal(resolveTarget(ctx, "marathon-pe", "fitted1", "L"), null);
});

test("category policy: dead-size 0 ARMS ITSELF the moment units exist anywhere", () => {
  const ctx = catCtx();
  ctx.stock.central.fitted1 = { ...ctx.stock.central.fitted1, XXXL: cell(4) };
  assert.equal(resolveTarget(ctx, "marathon-pe", "fitted1", "XXXL").target, 2);
});

test("category policy: survives the kill switch — and the OFF SWITCH is deleting the entry", () => {
  // ruleBasedTargets off: the run dies, the map does not (it is owner-armed
  // policy, same reasoning as explicit rows).
  const killed = catCtx({ config: { ...CAT_CONFIG, ruleBasedTargets: false } });
  assert.equal(resolveTarget(killed, "marathon-pe", "beanie1", "_").target, 5);
  assert.equal(resolveTarget(killed, "marathon-pe", "capLegacy", "M"), null); // the run is dead
  // THE off switch: delete /config/refillEngine/categoryPolicy/<key> → the
  // category falls back to exactly the pre-map branches, live, no deploy.
  const { perfumes, ...rest } = CAT_CONFIG.categoryPolicy;
  const off = catCtx({ config: { ...CAT_CONFIG, categoryPolicy: rest } });
  assert.equal(resolveTarget(off, "marathon-pe", "scent1", "_"), null);
  // And an entirely absent/garbled map arms nothing (fail-safe).
  assert.equal(resolveTarget(catCtx({ config: CONFIG }), "marathon-pe", "scent1", "_"), null);
  assert.equal(resolveTarget(catCtx({ config: { ...CONFIG, categoryPolicy: "on" } }), "marathon-pe", "scent1", "_"), null);
});

test("category policy: malformed entries arm NOTHING (fail-safe direction)", () => {
  for (const bad of [
    { "marathon-pe": { target: "8" } },          // stringy number
    { "marathon-pe": { target: -2 } },           // negative
    { "marathon-pe": { target: Infinity } },     // non-finite
    { "marathon-pe": 8 },                        // location not an object
    ["not", "a", "map"],                         // entry not an object
  ]) {
    const cfg = { ...CAT_CONFIG, categoryPolicy: { perfumes: bad } };
    assert.equal(resolveTarget(catCtx({ config: cfg }), "marathon-pe", "scent1", "_"), null,
      `entry ${JSON.stringify(bad)} must arm nothing`);
  }
});

test("category policy: unmapped clothing and footwear resolve BYTE-FOR-BYTE as without the map", () => {
  const withMap = catCtx();
  const noMap = catCtx({ config: CONFIG });
  for (const [dest, pid, size] of [
    ["marathon-pe", "p1", "M"], ["marathon-pe", "p1", "L"], ["trophy", "p1", "M"],
    ["hub2", "shoe1", "8"], ["marathon-pe", "shoe1", "8"],
    ["marathon-pe", "belt1", "_"], ["hub2", "belt1", "_"],
  ]) {
    assert.deepEqual(resolveTarget(withMap, dest, pid, size), resolveTarget(noMap, dest, pid, size),
      `${dest}/${pid}/${size} must be untouched by the map`);
  }
});

test("category policy END TO END: a stranded perfume raises the central→hub2 leg with NO row and NO cell", () => {
  const plan = computeRefillPlan({
    nowMs: NOW, config: CAT_CONFIG, products: CAT_PRODUCTS,
    targets: {},
    stock: { central: { scent1: { _: cell(48) } }, hub2: {}, "marathon-pe": {}, trophy: {} },
    openIndex: {}, refillRequests: {}, orders: {}, movements: [],
  });
  const i = plan.intents.find((x) => x.dest === "hub2" && x.productId === "scent1");
  assert.ok(i, "hub2 buffer intent raised for the mapped perfume");
  assert.equal(i.source, "central");
  assert.equal(i.qty, 10);                    // the map's hub2 target
  assert.equal(i.sizeKey, "_");               // the sentinel survives the whole path
  assert.equal(i.size, "_");                  // …and the raw size IS the declared "_" catalogue size
  // The shop leg does NOT fire this scan (hub2 has nothing yet) — the cascade
  // parks it as awaiting-upstream, exactly the actionable-only contract.
  assert.ok(!plan.intents.find((x) => x.dest === "marathon-pe" && x.productId === "scent1"));
  assert.ok(plan.exceptions.awaitingUpstream.items.find((x) => x.loc === "marathon-pe" && x.pid === "scent1"),
    "shop demand visible as awaiting upstream");
});

test("category policy END TO END: reorderPoint 0 keeps a mapped one-size cell SILENT until it sells out", () => {
  const plan = computeRefillPlan({
    nowMs: NOW, config: CAT_CONFIG, products: CAT_PRODUCTS,
    targets: {},
    stock: {
      central: {}, hub2: { beanie1: { _: cell(10) } },
      "marathon-pe": { beanie1: { _: cell(1) } },   // below target 5, above rp 0
      trophy: {},
    },
    openIndex: {}, refillRequests: {}, orders: {}, movements: [],
  });
  assert.ok(!plan.intents.find((x) => x.productId === "beanie1" && x.dest === "marathon-pe"),
    "1 on hand > reorderPoint 0 → silent");
  const empty = computeRefillPlan({
    nowMs: NOW, config: CAT_CONFIG, products: CAT_PRODUCTS,
    targets: {},
    stock: {
      central: {}, hub2: { beanie1: { _: cell(10) } },
      "marathon-pe": { beanie1: { _: cell(0) } },
      trophy: {},
    },
    openIndex: {}, refillRequests: {}, orders: {}, movements: [],
  });
  const i = empty.intents.find((x) => x.productId === "beanie1" && x.dest === "marathon-pe");
  assert.ok(i, "sold out → the whole gap at once");
  assert.equal(i.qty, 5);
});

test("category policy: the WHOLE PLAN is byte-identical for an unmapped snapshot with the map present", () => {
  const withMap = computeRefillPlan(base({ config: { ...CONFIG, categoryPolicy: CAT_CONFIG.categoryPolicy } }));
  const noMap = computeRefillPlan(base());
  assert.deepEqual(withMap, noMap);
});

test("category policy: the Decision Queue agrees with the planner even with the kill switch OFF", () => {
  // managedHere consulted the kill switch before the map, so a mapped product
  // was listed as "needs a decision" while the planner refilled it.
  // (CodeRabbit + Sonnet, PR #352.)
  const cfg = { ...CAT_CONFIG, ruleBasedTargets: false };
  const snap = (config) => ({
    nowMs: NOW, config, products: CAT_PRODUCTS, targets: {},
    stock: {
      central: {}, hub2: { beanie1: { _: cell(10) } },
      "marathon-pe": { beanie1: { _: cell(0) } }, trophy: {},
    },
    openIndex: {}, refillRequests: {}, orders: {}, movements: [],
  });
  const plan = computeRefillPlan(snap(cfg));
  // The planner IS refilling it…
  assert.ok(plan.intents.find((x) => x.productId === "beanie1" && x.dest === "marathon-pe"));
  // …so the queues must not demand a decision for it.
  const flagged = [...plan.exceptions.noTarget.items, ...plan.exceptions.unintroduced.items]
    .filter((x) => x.pid === "beanie1");
  assert.deepEqual(flagged, []);
  // Control: with the entry deleted (the off switch) and the switch still off,
  // the product genuinely needs a decision again — the test can fail.
  const off = computeRefillPlan(snap({ ...cfg, categoryPolicy: {} }));
  const reflagged = [...off.exceptions.noTarget.items, ...off.exceptions.unintroduced.items]
    .filter((x) => x.pid === "beanie1");
  assert.ok(reflagged.length > 0, "without the map the queue must flag it again");
});

test("category policy per-size mode REFUSES the '_' sentinel — a data error falls through, on both sides", () => {
  // A per-size product declaring one-size is a record error; answering for it
  // would put a one-size target on a sized product. (CodeRabbit, PR #352.)
  const products = { ...CAT_PRODUCTS, fittedOdd: { name: "Odd fitted", productType: "clothing", categoryKey: "fitted-caps", sizes: ["_", "M"] } };
  const ctx = { targets: {}, config: CAT_CONFIG, products, stock: { central: { fittedOdd: { _: cell(4), M: cell(2) } }, hub2: {}, "marathon-pe": {}, trophy: {} } };
  assert.equal(resolveTarget(ctx, "marathon-pe", "fittedOdd", "_"), null);
  // …while its real letter size still resolves the map.
  assert.equal(resolveTarget(ctx, "marathon-pe", "fittedOdd", "M").target, 2);
});
