import { test } from "vitest";
import assert from "node:assert";
import { buildSpecialStartPlan, buildSpecialEndPlan, specialsNodeBytes } from "./specials";

const STAMP = { startedAt: "2026-08-13T10:00:00.000Z", startedBy: "u1", startedByEmail: "junid@marathon.internal" };
const CATALOG = [
  { id: "p1", name: "Nike Air Cap", photoUrl: "https://firebasestorage.googleapis.com/v0/b/x/o/p1.jpg?alt=media&token=aaaa", retailPrice: 300, stockPrice: 150 },
  { id: "p2", name: "Puma Runner", retailPrice: 800 },
  { id: "p3", name: "Unpriced Thing" },
  { id: "p4", name: "Already Special", retailPrice: 199 },
];
const ACTIVE = { p4: { name: "Already Special", price: 199, wasPrice: 250, startedAt: "2026-08-01T08:00:00.000Z" } };

// ── start plan ───────────────────────────────────────────────────────────────

test("start percent: sale price is % off retail (whole rand), wasPrice parked, entry rides the same batch", () => {
  const plan = buildSpecialStartPlan({ products: CATALOG, specials: ACTIVE, selectedIds: ["p1", "p2"], mode: "percent", percentDraft: "20", ...STAMP });
  assert.equal(plan.ok, true);
  assert.equal(plan.count, 2);
  assert.deepEqual(plan.lines.p1, { name: "Nike Air Cap", from: { retailPrice: 300 }, to: { retailPrice: 240 } });
  const auxP1 = plan.aux.find((a) => a.path === "specials/p1");
  assert.equal(auxP1.from, null);
  assert.equal(auxP1.to.price, 240);
  assert.equal(auxP1.to.wasPrice, 300); // the recoverable normal price
  assert.equal(auxP1.to.startedBy, "u1");
  assert.equal(auxP1.to.plannedEndAt, null);
});

test("start: on-special and unpriced (percent mode) products are excluded and reported", () => {
  const plan = buildSpecialStartPlan({ products: CATALOG, specials: ACTIVE, selectedIds: ["p1", "p3", "p4"], mode: "percent", percentDraft: "50", ...STAMP });
  assert.equal(plan.count, 1);
  assert.deepEqual(plan.skippedOnSpecial.map((s) => s.pid), ["p4"]);
  assert.deepEqual(plan.missingPrice.map((s) => s.pid), ["p3"]);
});

test("start absolute: one price for all; an unpriced product is allowed with wasPrice null and flagged", () => {
  const plan = buildSpecialStartPlan({ products: CATALOG, specials: {}, selectedIds: ["p2", "p3"], mode: "absolute", priceDraft: "99", plannedEndAt: "2026-08-20", ...STAMP });
  assert.equal(plan.count, 2);
  assert.equal(plan.lines.p3.from.retailPrice, null);
  const auxP3 = plan.aux.find((a) => a.path === "specials/p3");
  assert.equal(auxP3.to.wasPrice, null);
  assert.equal(auxP3.to.plannedEndAt, "2026-08-20");
  assert.equal(plan.rows.find((r) => r.pid === "p3").badge, "no old price to restore"); // flagged in the preview
});

test("start: bad discounts refused; sale equal to current is a no-op", () => {
  for (const bad of ["0", "100", "150", "-5", ""]) {
    assert.equal(buildSpecialStartPlan({ products: CATALOG, specials: {}, selectedIds: ["p1"], mode: "percent", percentDraft: bad, ...STAMP }).ok, false);
  }
  const plan = buildSpecialStartPlan({ products: CATALOG, specials: {}, selectedIds: ["p1"], mode: "absolute", priceDraft: "300", ...STAMP });
  assert.equal(plan.count, 0);
  assert.deepEqual(plan.noop.map((n) => n.pid), ["p1"]);
});

test("start absolute: a sale price ABOVE a product's current retail SKIPS that product and reports it (CodeRabbit PR #355)", () => {
  // One price across a mixed selection: fine for p2 (800), above p1's 300.
  const plan = buildSpecialStartPlan({ products: CATALOG, specials: {}, selectedIds: ["p1", "p2"], mode: "absolute", priceDraft: "500", ...STAMP });
  assert.equal(plan.count, 1);
  assert.equal(plan.lines.p2.to.retailPrice, 500);
  assert.equal(plan.lines.p1, undefined); // never raises a shelf price
  assert.deepEqual(plan.aboveRetail.map((m) => m.pid), ["p1"]);
});

// ── end plan ─────────────────────────────────────────────────────────────────

test("end: retail returns to the parked wasPrice exactly and the entry deletes — in one batch", () => {
  const specials = { p1: { name: "Nike Air Cap", price: 240, wasPrice: 300, startedAt: STAMP.startedAt } };
  const products = [{ id: "p1", name: "Nike Air Cap", retailPrice: 240 }];
  const plan = buildSpecialEndPlan({ products, specials, selectedIds: ["p1"] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.lines.p1, { name: "Nike Air Cap", from: { retailPrice: 240 }, to: { retailPrice: 300 } });
  assert.deepEqual(plan.aux, [{ path: "specials/p1", from: specials.p1, to: null }]);
});

test("end: a special started on an unpriced product returns retail to NOT SET", () => {
  const specials = { p3: { name: "Unpriced Thing", price: 99, wasPrice: null, startedAt: STAMP.startedAt } };
  const plan = buildSpecialEndPlan({ products: [{ id: "p3", name: "Unpriced Thing", retailPrice: 99 }], specials, selectedIds: ["p3"] });
  assert.equal(plan.lines.p3.to.retailPrice, null);
});

test("end: honest from — records the LIVE retail even if something bypassed the app", () => {
  const specials = { p1: { name: "Nike Air Cap", price: 240, wasPrice: 300 } };
  const plan = buildSpecialEndPlan({ products: [{ id: "p1", retailPrice: 777 }], specials, selectedIds: ["p1"] });
  assert.equal(plan.lines.p1.from.retailPrice, 777);
  assert.equal(plan.lines.p1.to.retailPrice, 300);
});

test("full lifecycle: start → end returns the exact pre-special retail price", () => {
  const start = buildSpecialStartPlan({ products: CATALOG, specials: {}, selectedIds: ["p1"], mode: "percent", percentDraft: "35", ...STAMP });
  const afterStart = { id: "p1", name: "Nike Air Cap", retailPrice: start.lines.p1.to.retailPrice };
  const liveSpecials = { p1: start.entries.p1 };
  const end = buildSpecialEndPlan({ products: [afterStart], specials: liveSpecials, selectedIds: ["p1"] });
  assert.equal(end.lines.p1.to.retailPrice, 300); // exactly what p1 held before
});

// ── the bandwidth bill ───────────────────────────────────────────────────────

test("MEASURED: the specials node stays a few KB at realistic sizes — an always-on screen's hourly bill is its size, not hundreds of KB", () => {
  const entry = (i) => ({
    name: `Realistic Product Name Somewhat Long ${i}`,
    photoUrl: `https://firebasestorage.googleapis.com/v0/b/marathon-club.appspot.com/o/product-photos%2Fp17${String(1000000000 + i)}.jpg?alt=media&token=abcdef12-3456-7890-abcd-ef1234567890`,
    price: 199, wasPrice: 299,
    startedAt: "2026-08-13T10:00:00.000Z", startedBy: "AbCdEfGh123456789012345678", startedByEmail: "junid@marathon.internal",
    plannedEndAt: "2026-08-20", batchId: "pb_1786615200000_abc123",
  });
  const node = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p17${String(1000000000 + i)}`, entry(i)]));
  const at20 = specialsNodeBytes(node(20));
  const at50 = specialsNodeBytes(node(50));
  // ~8 KB at 20 specials, ~20 KB at 50. One onValue subscription downloads the
  // node once per (re)connect and then only deltas — so an hour of idle
  // subscription costs ONE node download. Even a paranoid 12 reloads/hour at
  // 50 specials is ~240 KB. The redesign threshold in the brief (a few hundred
  // KB/hour) is never approached at plausible sizes.
  assert.ok(at20 < 12 * 1024, `20 specials = ${at20} bytes — expected < 12 KB`);
  assert.ok(at50 < 30 * 1024, `50 specials = ${at50} bytes — expected < 30 KB`);
});
