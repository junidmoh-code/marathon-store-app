// ─── STYLE CODE CAPTURE — THE BACKFILL SAFETY GUARANTEE ──────────────────────
// The single most important test in this file is "the live name, image and
// category are NEVER touched". Everything else is detail.
//
// Capturing a code on an EXISTING product is a backfill: thousands of records
// that staff and the POS already recognise, being touched by an automated
// process. If that process can rename a product — even occasionally, even when
// it is right — the catalogue stops being trustworthy, and a catalogue nobody
// trusts is worse than one with gaps. So the code is stamped and the SUGGESTION
// waits for a human, always.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  captureDecision,
  validateCapture,
  comparable,
  ALLOWED_PRODUCT_FIELDS,
  FORBIDDEN_PRODUCT_FIELDS,
  AGREEMENT_MIN_CONFIDENCE,
} = require("../lib/style-code-capture.cjs");
const { runCapture, claimIndexServerSide } = require("../styleCode/processCapture.js");

const NOW = 1754300000000;

const CAPTURE = (over = {}) => ({
  styleCodeNormalised: "CT8527016",
  styleCode: "CT8527-016",
  productId: "p1",
  capturedBy: "u1",
  capturedAt: NOW - 1000,
  origin: "displayCheck",
  labelPhotoUrl: "https://storage/label.jpg",
  ...over,
});
const PRODUCT = (over = {}) => ({
  id: "p1", name: "Staff-typed name", photoUrl: "https://p/1.jpg",
  category: "Footwear", productType: "sneaker", ...over,
});
const MODEL = (over = {}) => ({
  styleCode: "CT8527-016", brand: "Nike", model: "Dunk Low", colorwayName: "Black White",
  imageUrl: "https://cat/1.jpg", source: "api", fetchedAt: 1, ...over,
});
const AGREE = { sameProduct: true, confidence: 0.95, reason: "same silhouette and colourway" };
const DISAGREE = { sameProduct: false, confidence: 0.9, reason: "different colourway" };

// ── THE GUARANTEE ────────────────────────────────────────────────────────────
test("BACKFILL SAFETY: the product patch can never contain name, image or category", () => {
  for (const comparison of [AGREE, DISAGREE, null]) {
    for (const model of [MODEL(), null]) {
      const d = captureDecision({ capture: CAPTURE(), product: PRODUCT(), model, comparison, nowMs: NOW });
      assert.strictEqual(d.kind, "apply");
      for (const forbidden of FORBIDDEN_PRODUCT_FIELDS) {
        assert.ok(!(forbidden in d.productPatch),
          `${forbidden} must NEVER be written by a capture (comparison=${JSON.stringify(comparison)})`);
      }
      for (const k of Object.keys(d.productPatch)) {
        assert.ok(ALLOWED_PRODUCT_FIELDS.includes(k), `unexpected product field: ${k}`);
      }
    }
  }
});

test("BACKFILL SAFETY: even a confident agreement only writes the CODE", () => {
  const d = captureDecision({ capture: CAPTURE(), product: PRODUCT(), model: MODEL(), comparison: AGREE, nowMs: NOW });
  assert.strictEqual(d.status, "autoConfirmed");
  assert.deepStrictEqual(Object.keys(d.productPatch).sort(), [
    "styleCode", "styleCodeConfirmedBy", "styleCodeFetchedAt",
    "styleCodeLabelPhoto", "styleCodeNormalised", "styleCodeSource",
  ]);
  // The catalogue's name and photo exist — as SUGGESTIONS, awaiting a human.
  assert.strictEqual(d.pending.suggestedName, "Nike Dunk Low Black White");
  assert.strictEqual(d.pending.suggestedImageUrl, "https://cat/1.jpg");
});

test("'autoConfirmed' means a human can approve it quickly — NOT that it was applied", () => {
  const d = captureDecision({ capture: CAPTURE(), product: PRODUCT(), model: MODEL(), comparison: AGREE, nowMs: NOW });
  assert.strictEqual(d.pending.status, "autoConfirmed");
  assert.ok(d.pending.suggestedName, "the suggestion is still parked in pending");
  assert.ok(!("name" in d.productPatch));
});

// ── Agreement / disagreement ─────────────────────────────────────────────────
test("images agree → autoConfirmed, and the reason is recorded", () => {
  const d = captureDecision({ capture: CAPTURE(), product: PRODUCT(), model: MODEL(), comparison: AGREE, nowMs: NOW });
  assert.strictEqual(d.status, "autoConfirmed");
  assert.strictEqual(d.reviewReason, "images-agree");
  assert.strictEqual(d.pending.comparedConfidence, 0.95);
});

test("images disagree → needsReview", () => {
  const d = captureDecision({ capture: CAPTURE(), product: PRODUCT(), model: MODEL(), comparison: DISAGREE, nowMs: NOW });
  assert.strictEqual(d.status, "needsReview");
  assert.strictEqual(d.reviewReason, "images-disagree");
});

test("agreement below the confidence bar is still a review", () => {
  const weak = { sameProduct: true, confidence: AGREEMENT_MIN_CONFIDENCE - 0.01, reason: "maybe" };
  const d = captureDecision({ capture: CAPTURE(), product: PRODUCT(), model: MODEL(), comparison: weak, nowMs: NOW });
  assert.strictEqual(d.status, "needsReview");
  assert.ok(AGREEMENT_MIN_CONFIDENCE >= 0.8, "the bar is deliberately high");
});

test("'COULD NOT CHECK' is never 'checked and passed'", () => {
  // Auto-confirming an unverifiable match would rubber-stamp exactly the
  // products we have the least evidence about.
  const noProductPhoto = captureDecision({
    capture: CAPTURE(), product: PRODUCT({ photoUrl: null }), model: MODEL(), comparison: null, nowMs: NOW,
  });
  assert.strictEqual(noProductPhoto.status, "needsReview");
  assert.strictEqual(noProductPhoto.reviewReason, "product-image-missing");

  const noCataloguePhoto = captureDecision({
    capture: CAPTURE(), product: PRODUCT(), model: MODEL({ imageUrl: null }), comparison: null, nowMs: NOW,
  });
  assert.strictEqual(noCataloguePhoto.status, "needsReview");
  assert.strictEqual(noCataloguePhoto.reviewReason, "catalogue-image-missing");

  const comparisonFailed = captureDecision({
    capture: CAPTURE(), product: PRODUCT(), model: MODEL(), comparison: null, nowMs: NOW,
  });
  assert.strictEqual(comparisonFailed.status, "needsReview");
});

test("no catalogue match → review, and the code is still captured", () => {
  const d = captureDecision({ capture: CAPTURE(), product: PRODUCT(), model: null, comparison: null, nowMs: NOW });
  assert.strictEqual(d.status, "needsReview");
  assert.strictEqual(d.reviewReason, "no-catalogue-match");
  assert.strictEqual(d.stampCode, true, "the code came off a real label — keep it");
  assert.strictEqual(d.productPatch.styleCodeSource, "manual");
  assert.strictEqual(d.pending.suggestedName, null);
});

test("comparable() requires BOTH images", () => {
  assert.strictEqual(comparable(PRODUCT(), MODEL()), true);
  assert.strictEqual(comparable(PRODUCT({ photoUrl: null }), MODEL()), false);
  assert.strictEqual(comparable(PRODUCT(), MODEL({ imageUrl: null })), false);
  assert.strictEqual(comparable(null, MODEL()), false);
  assert.strictEqual(comparable(PRODUCT(), null), false);
});

// ── Immutability + conflicts ─────────────────────────────────────────────────
test("a product that already has THIS code is not re-stamped", () => {
  const d = captureDecision({
    capture: CAPTURE(), product: PRODUCT({ styleCodeNormalised: "CT8527016" }),
    model: MODEL(), comparison: AGREE, nowMs: NOW,
  });
  assert.strictEqual(d.stampCode, false);
  assert.deepStrictEqual(d.productPatch, {}, "styleCodeNormalised is immutable once set");
});

test("a product carrying a DIFFERENT code is rejected — never overwritten", () => {
  const d = captureDecision({
    capture: CAPTURE(), product: PRODUCT({ styleCodeNormalised: "CT8527700" }),
    model: MODEL(), comparison: AGREE, nowMs: NOW,
  });
  assert.strictEqual(d.kind, "reject");
  assert.strictEqual(d.code, "code-conflict");
});

test("every spelling of the same code counts as the same code", () => {
  const d = captureDecision({
    capture: CAPTURE({ styleCodeNormalised: "ct8527-016" }),
    product: PRODUCT({ styleCodeNormalised: "CT8527016" }),
    model: MODEL(), comparison: AGREE, nowMs: NOW,
  });
  assert.strictEqual(d.kind, "apply");
  assert.strictEqual(d.stampCode, false);
});

// ── Validation ───────────────────────────────────────────────────────────────
test("a malformed capture is rejected before anything acts on it", () => {
  const cases = [
    [null, "malformed"],
    [CAPTURE({ styleCodeNormalised: "---" }), "bad-style-code"],
    [CAPTURE({ capturedBy: null }), "no-actor"],
    [CAPTURE({ origin: "wat" }), "bad-origin"],
    [CAPTURE({ productId: null }), "no-product"],
  ];
  for (const [capture, code] of cases) {
    assert.strictEqual(validateCapture(capture).code, code);
    assert.deepStrictEqual(captureDecision({ capture, product: PRODUCT(), model: null, comparison: null, nowMs: NOW }),
      { kind: "reject", code });
  }
});

test("all four origins are accepted", () => {
  for (const origin of ["addSneaker", "displayCheck", "receiving", "admin"]) {
    assert.strictEqual(validateCapture(CAPTURE({ origin })).ok, true);
  }
});

test("a vanished product is rejected, not written to", () => {
  const d = captureDecision({ capture: CAPTURE(), product: null, model: MODEL(), comparison: AGREE, nowMs: NOW });
  assert.deepStrictEqual(d, { kind: "reject", code: "product-missing" });
});

// ── The worker ───────────────────────────────────────────────────────────────
function fakeDb(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  const logs = [];
  const at = (p) => p.split("/").filter(Boolean).reduce((n, k) => (n == null ? n : n[k]), data);
  const put = (p, v) => {
    const parts = p.split("/").filter(Boolean);
    const last = parts.pop();
    let node = data;
    for (const k of parts) { if (node[k] == null || typeof node[k] !== "object") node[k] = {}; node = node[k]; }
    if (v === undefined) delete node[last]; else node[last] = v;
  };
  const makeRef = (path) => ({
    async get() { const v = at(path); const val = v === undefined ? null : v; return { val: () => val, exists: () => val !== null }; },
    async set(v) { logs.push(["set", path]); put(path, v); },
    async update(patch) { logs.push(["update", path]); for (const [k, v] of Object.entries(patch)) put(`${path}/${k}`, v); },
    child(k) { return makeRef(`${path}/${k}`); },
    async transaction(fn) {
      const cur = at(path);
      const next = fn(cur === undefined ? null : cur);
      const committed = next !== undefined;
      if (committed) put(path, next);
      const final = at(path);
      return { committed, snapshot: { val: () => (final === undefined ? null : final) } };
    },
  });
  return { data, logs, ref: makeRef };
}

const WORKER = { nowMs: NOW, geminiKey: "k" };

test("worker: agreement stamps the code, parks the suggestion, claims the index", async () => {
  const db = fakeDb({ products: { p1: PRODUCT() }, sneaker_models: { CT8527016: MODEL() } });
  const out = await runCapture(db, "c1", CAPTURE(), { ...WORKER, compareFn: async () => AGREE });

  assert.strictEqual(out.status, "autoConfirmed");
  assert.strictEqual(out.stamped, true);

  const p = db.data.products.p1;
  assert.strictEqual(p.styleCodeNormalised, "CT8527016");
  assert.strictEqual(p.styleCodeLabelPhoto, "https://storage/label.jpg");
  // THE GUARANTEE, end to end.
  assert.strictEqual(p.name, "Staff-typed name", "the live name is untouched");
  assert.strictEqual(p.photoUrl, "https://p/1.jpg", "the live image is untouched");
  assert.strictEqual(p.category, "Footwear", "the live category is untouched");
  // The suggestion is parked.
  assert.strictEqual(p.pendingStyleCode.suggestedName, "Nike Dunk Low Black White");
  assert.strictEqual(p.pendingStyleCode.status, "autoConfirmed");
  // And the index was claimed.
  assert.strictEqual(db.data.style_code_index.CT8527016.productId, "p1");
});

test("worker: disagreement parks everything for review and stamps nothing extra", async () => {
  const db = fakeDb({ products: { p1: PRODUCT() }, sneaker_models: { CT8527016: MODEL() } });
  const out = await runCapture(db, "c1", CAPTURE(), { ...WORKER, compareFn: async () => DISAGREE });

  assert.strictEqual(out.status, "needsReview");
  assert.strictEqual(db.data.products.p1.pendingStyleCode.status, "needsReview");
  assert.strictEqual(db.data.products.p1.pendingStyleCode.reviewReason, "images-disagree");
  assert.strictEqual(db.data.products.p1.name, "Staff-typed name");
  assert.strictEqual(db.data.style_code_captures.c1.status, "needsReview");
});

test("worker: BOTH outcomes are written to the capture record", async () => {
  for (const [cmp, expected] of [[AGREE, "autoConfirmed"], [DISAGREE, "needsReview"]]) {
    const db = fakeDb({ products: { p1: PRODUCT() }, sneaker_models: { CT8527016: MODEL() } });
    await runCapture(db, "c1", CAPTURE(), { ...WORKER, compareFn: async () => cmp });
    const rec = db.data.style_code_captures.c1;
    assert.strictEqual(rec.status, expected);
    assert.ok(rec.review.reason, "an outcome with no recorded reason is unauditable");
    assert.strictEqual(rec.review.decidedAt, NOW);
  }
});

test("worker: a comparison that THROWS routes to review, never to agreement", async () => {
  const db = fakeDb({ products: { p1: PRODUCT() }, sneaker_models: { CT8527016: MODEL() } });
  const out = await runCapture(db, "c1", CAPTURE(), {
    ...WORKER, compareFn: async () => { throw new Error("gemini HTTP 503"); },
  });
  assert.strictEqual(out.status, "needsReview");
  assert.match(db.data.products.p1.pendingStyleCode.comparisonError, /503/);
});

test("worker: a code already claimed by ANOTHER product is flagged, not stolen", async () => {
  const db = fakeDb({
    products: { p1: PRODUCT(), p2: PRODUCT({ id: "p2" }) },
    sneaker_models: { CT8527016: MODEL() },
    style_code_index: { CT8527016: { productId: "p2", claimedAt: 1 } },
  });
  const out = await runCapture(db, "c1", CAPTURE(), { ...WORKER, compareFn: async () => AGREE });

  assert.strictEqual(out.stamped, false);
  assert.strictEqual(out.claimConflict, "p2");
  assert.strictEqual(db.data.products.p1.styleCodeNormalised, undefined, "the code was not stolen");
  assert.strictEqual(db.data.products.p1.pendingStyleCode.status, "needsReview");
  assert.strictEqual(db.data.products.p1.pendingStyleCode.claimConflictWith, "p2");
  assert.strictEqual(db.data.style_code_index.CT8527016.productId, "p2", "the original claim stands");
});

test("worker: a rejection is RECORDED, not silently dropped", async () => {
  const db = fakeDb({ products: {} });
  const out = await runCapture(db, "c1", CAPTURE(), { ...WORKER, compareFn: async () => AGREE });
  assert.strictEqual(out.kind, "rejected");
  assert.strictEqual(db.data.style_code_captures.c1.status, "rejected");
  assert.strictEqual(db.data.style_code_captures.c1.review.reason, "product-missing");
});

test("worker: the metered resolver is skipped when the cache already has the model", async () => {
  const db = fakeDb({ products: { p1: PRODUCT() }, sneaker_models: { CT8527016: MODEL() } });
  let resolveCalls = 0;
  await runCapture(db, "c1", CAPTURE(), {
    ...WORKER, compareFn: async () => AGREE, resolveFn: async () => { resolveCalls++; return MODEL(); },
  });
  assert.strictEqual(resolveCalls, 0, "never pay for a code already in /sneaker_models");
});

test("claimIndexServerSide reimplements create-once — the Admin SDK bypasses the rule", async () => {
  const db = fakeDb({});
  const first = await claimIndexServerSide(db, "CT8527016", "p1", "u1", NOW);
  assert.deepStrictEqual([first.claimed, first.ownerId], [true, "p1"]);

  // A plain set() would silently steal the code here. The transaction must not.
  const second = await claimIndexServerSide(db, "CT8527016", "p2", "u2", NOW);
  assert.strictEqual(second.claimed, false);
  assert.strictEqual(second.ownerId, "p1");
  assert.strictEqual(db.data.style_code_index.CT8527016.productId, "p1");
});

test("claimIndexServerSide writes only the three permitted fields", async () => {
  const db = fakeDb({});
  await claimIndexServerSide(db, "IE3437", "p1", "u1", NOW);
  assert.deepStrictEqual(Object.keys(db.data.style_code_index.IE3437).sort(),
    ["claimedAt", "claimedBy", "productId"]);
});
