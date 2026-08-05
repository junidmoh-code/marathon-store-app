// ─── resolveStyleCode — THE THREE-TIER CHAIN, END TO END (no network, no admin) ─
// Exercises runResolve() against a fake RTDB and a fake fetch, so the whole
// resolution path — cache hit, vendor fetch, cache write, duplicate flagging,
// broken-tier handling — is covered without firebase-admin or a live vendor.
//
// THE TEST THIS FILE EXISTS FOR is "two codes sharing the first six characters
// resolve to different models and never collapse". It is asserted three ways:
// distinct cache keys, distinct resolved models, and — the one that actually
// bites in production — a vendor that fuzzily returns the SIBLING colorway is
// REFUSED rather than silently accepted as the shoe in the operator's hand.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  runResolve,
  findProductsByStyleCode,
  duplicatePairId,
  duplicatePairs,
  readClaim,
  DUPLICATE_CANDIDATES_PATH,
  STYLE_CODE_MISSES_PATH,
  STYLE_CODE_INDEX_PATH,
} = require("../styleCode/resolveStyleCode.js");
const {
  makeCacheProvider,
  makeKicksDbProvider,
  makeWebSearchProvider,
  resolveThroughProviders,
  verifyStyleCodeMatch,
  pickKicksDbRecord,
  packRaw,
} = require("../lib/style-code-providers.cjs");

const NOW = 1754300000000; // fixed clock — no Date.now() in assertions

// ── A fake RTDB: a plain object tree, path-addressed, with the one query shape
//    the resolver uses (orderByChild(...).equalTo(...)). Records every write. ──
function fakeDb(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  const writes = [];
  let failWritesMatching = null;

  const at = (path) => path.split("/").filter(Boolean).reduce((node, k) => (node == null ? node : node[k]), data);
  const put = (path, value) => {
    const parts = path.split("/").filter(Boolean);
    const last = parts.pop();
    let node = data;
    for (const k of parts) { if (node[k] == null || typeof node[k] !== "object") node[k] = {}; node = node[k]; }
    node[last] = value;
  };

  const db = {
    data,
    writes,
    failWrites(substr) { failWritesMatching = substr; },
    ref(path) {
      return {
        async get() {
          const v = at(path);
          const val = v === undefined ? null : v;
          return { val: () => val, exists: () => val !== null };
        },
        async set(value) {
          if (failWritesMatching && path.includes(failWritesMatching)) throw new Error("simulated write failure");
          writes.push({ path, value });
          put(path, value);
        },
        orderByChild(field) {
          return {
            equalTo(target) {
              return {
                async get() {
                  const node = at(path) || {};
                  const out = {};
                  for (const [k, v] of Object.entries(node)) if (v && v[field] === target) out[k] = v;
                  return { val: () => (Object.keys(out).length ? out : null) };
                },
              };
            },
          };
        },
      };
    },
  };
  return db;
}

// ── A fake KicksDB: a SKU → record map, plus a call log. ──
function fakeKicksDb(bySku, { status = 200, throwOn = null } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (throwOn && url.includes(throwOn)) throw new Error("ECONNRESET");
    if (status !== 200) return { ok: false, status, async json() { return {}; } };
    // The code is a QUERY param on the StockX route, not a path segment.
    const identifier = decodeURIComponent(new URL(url).searchParams.get("sku") || "");
    const rows = bySku[identifier];
    if (!rows) return { ok: false, status: 404, async json() { return {}; } };
    return { ok: true, status: 200, async json() { return { data: rows }; } };
  };
  return { fetchImpl, calls };
}

// The REAL StockX record shape, captured from the live vendor during the
// emulator smoke test. Note what is NOT here: no `name`, no `images[]`, no
// `metadata.colorway`, no barcode — the unified endpoint had all four, and
// coding against it is what shipped a broken adapter.
const KDB_RECORD = (sku, title, image, model) => ({
  id: "50b8dfb8-327b-4703-8a9b-e6a344aef7b8",
  sku,
  title,
  brand: title.split(" ")[0],
  model: model || title,
  gender: "men",
  image,
  gallery: [image],
  product_type: "sneakers",
  category: "Air Jordan",
  secondary_category: "Four",
  slug: title.toLowerCase().replace(/\s+/g, "-"),
});

const providersFor = (db, kdb, apiKey = "test-key") => [
  makeCacheProvider(db),
  makeKicksDbProvider({ apiKey, fetchImpl: kdb.fetchImpl, baseUrl: "https://api.test", nowMs: NOW }),
  makeWebSearchProvider(),
];

const ACTOR = { uid: "u1", name: "Staff" };

// ─────────────────────────────────────────────────────────────────────────────
test("tier 1 — a cached model answers without touching the vendor", async () => {
  const db = fakeDb({
    sneaker_models: {
      CT8527016: { styleCode: "CT8527-016", brand: "Nike", model: "Dunk Low", imageUrl: "https://img/a.jpg", source: "kicksdb", fetchedAt: 1 },
    },
  });
  const kdb = fakeKicksDb({});
  const out = await runResolve(db, { code: "CT8527-016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  assert.strictEqual(out.kind, "ok");
  assert.strictEqual(out.found, true);
  assert.strictEqual(out.source, "cache");
  assert.strictEqual(out.tier, 1);
  assert.strictEqual(out.fromCache, true);
  assert.strictEqual(out.cached, false, "a cache hit must not re-write the cache");
  assert.strictEqual(kdb.calls.length, 0, "the vendor must not be called on a cache hit");
});

test("tier 1 — a cached record whose own styleCode disagrees with its key is NOT trusted", async () => {
  // A bad historical write must not be believed forever just because it is ours.
  const db = fakeDb({
    sneaker_models: { CT8527016: { styleCode: "CT8527-700", brand: "Nike", model: "wrong" } },
  });
  const kdb = fakeKicksDb({ "CT8527-016": [KDB_RECORD("CT8527-016", "Nike Dunk Low Black", "https://img/a.jpg")] });
  const out = await runResolve(db, { code: "CT8527-016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  assert.strictEqual(out.source, "kicksdb", "must fall through to the vendor, not serve the poisoned cache row");
  assert.strictEqual(out.model.model, "Nike Dunk Low Black");
});

test("tier 2 — a vendor resolve is returned AND written to the permanent cache", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({ "CT8527-016": [KDB_RECORD("CT8527-016", "Nike Dunk Low Black", "https://img/a.jpg")] });
  const out = await runResolve(db, { code: "CT8527-016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  assert.strictEqual(out.found, true);
  assert.strictEqual(out.source, "kicksdb");
  assert.strictEqual(out.tier, 2);
  assert.strictEqual(out.fromCache, false);
  assert.strictEqual(out.cached, true);
  // Cached under the NORMALISED code, with every documented field present.
  const cached = db.data.sneaker_models.CT8527016;
  assert.ok(cached, "must cache under the normalised key");
  for (const f of ["styleCode", "brand", "model", "colorwayName", "productType", "imageUrl", "gtin", "source", "fetchedAt", "raw"]) {
    assert.ok(f in cached, `cached record is missing ${f}`);
  }
  // The RULES enum, not the vendor's name — "kicksdb" would fail validation.
  assert.strictEqual(cached.source, "api");
  assert.strictEqual(cached.fetchedAt, NOW);
  assert.strictEqual(cached.imageUrl, "https://img/a.jpg");
});

test("tier 2 — the cache is consulted first on the SECOND resolve of the same code", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({ "IE3437": [KDB_RECORD("IE3437", "adidas Samba OG", "https://img/s.jpg")] });
  await runResolve(db, { code: "IE3437", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });
  const callsAfterFirst = kdb.calls.length;
  assert.ok(callsAfterFirst > 0);

  const second = await runResolve(db, { code: "IE3437", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });
  assert.strictEqual(second.source, "cache");
  assert.strictEqual(kdb.calls.length, callsAfterFirst, "resolve a code once, never pay for it again");
});

// ── THE GATE ─────────────────────────────────────────────────────────────────
test("THE GATE: two codes sharing the first six characters resolve to DIFFERENT models", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({
    "CT8527-016": [KDB_RECORD("CT8527-016", "Nike Dunk Low Black White", "https://img/016.jpg")],
    "CT8527-700": [KDB_RECORD("CT8527-700", "Nike Dunk Low Varsity Maize", "https://img/700.jpg")],
  });

  const a = await runResolve(db, { code: "CT8527-016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });
  const b = await runResolve(db, { code: "CT8527-700", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  // Different identity keys…
  assert.strictEqual(a.normalised, "CT8527016");
  assert.strictEqual(b.normalised, "CT8527700");
  assert.notStrictEqual(a.normalised, b.normalised);
  // …the shared prefix is real, which is exactly why prefix matching is unsafe…
  assert.strictEqual(a.normalised.slice(0, 6), b.normalised.slice(0, 6));
  // …different resolved products…
  assert.strictEqual(a.model.model, "Nike Dunk Low Black White");
  assert.strictEqual(b.model.model, "Nike Dunk Low Varsity Maize");
  assert.notStrictEqual(a.model.imageUrl, b.model.imageUrl);
  // …and two separate, co-existing cache rows. Neither overwrote the other.
  assert.strictEqual(Object.keys(db.data.sneaker_models).length, 2);
  assert.strictEqual(db.data.sneaker_models.CT8527016.imageUrl, "https://img/016.jpg");
  assert.strictEqual(db.data.sneaker_models.CT8527700.imageUrl, "https://img/700.jpg");
});

test("THE GATE: a vendor that fuzzily returns the SIBLING colorway is REFUSED", async () => {
  // The realistic failure: we ask for CT8527-016, the catalog's fuzzy search
  // hands back CT8527-700 because it shares a silhouette. Accepting that would
  // put the wrong photo and wrong name on the operator's confirm screen.
  const db = fakeDb({});
  const kdb = fakeKicksDb({
    "CT8527-016": [KDB_RECORD("CT8527-700", "Nike Dunk Low Varsity Maize", "https://img/700.jpg")],
    "CT8527016": [KDB_RECORD("CT8527-700", "Nike Dunk Low Varsity Maize", "https://img/700.jpg")],
  });
  const out = await runResolve(db, { code: "CT8527-016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  assert.strictEqual(out.found, false, "a near-match on a different SKU is NOT a match");
  assert.strictEqual(out.model, null);
  assert.deepStrictEqual(out.errors, [], "a refused fuzzy match is a clean miss, not a tier error");
  assert.strictEqual(db.data.sneaker_models, undefined, "nothing may be cached from a refused match");
});

test("THE GATE: verifyStyleCodeMatch refuses prefixes, suffixes and near-misses", () => {
  assert.strictEqual(verifyStyleCodeMatch("CT8527-016", "CT8527016"), true);
  assert.strictEqual(verifyStyleCodeMatch("ct8527 016", "CT8527016"), true, "spelling differences are fine");
  assert.strictEqual(verifyStyleCodeMatch("CT8527-700", "CT8527016"), false);
  assert.strictEqual(verifyStyleCodeMatch("CT8527", "CT8527016"), false, "a prefix is not a match");
  assert.strictEqual(verifyStyleCodeMatch("CT85270160", "CT8527016"), false, "an extra digit is not a match");
  assert.strictEqual(verifyStyleCodeMatch("", "CT8527016"), false);
  assert.strictEqual(verifyStyleCodeMatch("CT8527016", ""), false);
  assert.strictEqual(verifyStyleCodeMatch(null, "CT8527016"), false);
});

test("THE GATE: pickKicksDbRecord picks the exact SKU out of a mixed result set", () => {
  const payload = {
    data: [
      KDB_RECORD("CT8527-700", "sibling", "https://img/700.jpg"),
      KDB_RECORD("CT8527-016", "the right one", "https://img/016.jpg"),
      KDB_RECORD("CT8527-001", "another sibling", "https://img/001.jpg"),
    ],
  };
  assert.strictEqual(pickKicksDbRecord(payload, "CT8527016").title, "the right one");
  assert.strictEqual(pickKicksDbRecord(payload, "CT8527999"), null);
});

test("pickKicksDbRecord prefers an exact match that actually has an image", () => {
  const payload = {
    data: [
      { ...KDB_RECORD("CT8527-016", "no photo", ""), image: "", gallery: [] },
      KDB_RECORD("CT8527-016", "with photo", "https://img/016.jpg"),
    ],
  };
  assert.strictEqual(pickKicksDbRecord(payload, "CT8527016").title, "with photo");
});

// ─────────────────────────────────────────────────────────────────────────────
test("multiple spellings are tried, and the first exact match wins", async () => {
  // Staff typed it without the hyphen; the catalog only knows the hyphenated form.
  const db = fakeDb({});
  const kdb = fakeKicksDb({ "CT8527-016": [KDB_RECORD("CT8527-016", "Nike Dunk Low", "https://img/a.jpg")] });
  const out = await runResolve(db, { code: "ct8527016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  assert.strictEqual(out.found, true);
  assert.strictEqual(out.normalised, "CT8527016");
  assert.ok(kdb.calls.some((u) => u.includes("ct8527016")), "asks with what the human typed first");
  assert.ok(kdb.calls.some((u) => u.includes("CT8527-016")), "then with the canonical hyphenated form");
});

test("tier 3 — the web-search stub reports not-found, it does not error", async () => {
  const stub = makeWebSearchProvider();
  assert.strictEqual(await stub.resolve({ normalised: "CT8527016", candidates: [] }), null);
  assert.strictEqual(stub.tier, 3);
  assert.strictEqual(stub.name, "web-search");
});

test("an unknown code walks all three tiers and comes back not-found, cleanly", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({});
  const out = await runResolve(db, { code: "ZZ9999-999", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  assert.strictEqual(out.found, false);
  assert.strictEqual(out.model, null);
  assert.strictEqual(out.source, null);
  assert.deepStrictEqual(out.errors, []);
  assert.strictEqual(out.normalised, "ZZ9999999");
  assert.strictEqual(out.displayCode, "ZZ9999-999", "not-found still echoes a readable code back to the operator");
});

test("a BROKEN vendor is reported as an error, never as 'no such shoe'", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({}, { status: 401 });
  const out = await runResolve(db, { code: "CT8527-016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  assert.strictEqual(out.found, false);
  assert.strictEqual(out.errors.length, 1);
  assert.strictEqual(out.errors[0].provider, "kicksdb");
  assert.match(out.errors[0].message, /401/);
});

test("a missing API key disables the tier without taking the resolve down", async () => {
  const db = fakeDb({
    sneaker_models: { IE3437: { styleCode: "IE3437", brand: "adidas", model: "Samba OG" } },
  });
  const kdb = fakeKicksDb({});
  // No key at all — the cache must still answer.
  const out = await runResolve(db, { code: "IE3437", providers: providersFor(db, kdb, ""), actor: ACTOR, nowMs: NOW });
  assert.strictEqual(out.found, true);
  assert.strictEqual(out.source, "cache");

  const miss = await runResolve(db, { code: "ZZ1111-111", providers: providersFor(db, kdb, ""), actor: ACTOR, nowMs: NOW });
  assert.strictEqual(miss.found, false);
  assert.match(miss.errors[0].message, /KICKSDB_API_KEY is not configured/);
});

test("a network throw on one spelling does not abandon the other spellings", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb(
    { "CT8527-016": [KDB_RECORD("CT8527-016", "Nike Dunk Low", "https://img/a.jpg")] },
    { throwOn: "ct8527016" }, // the as-typed spelling blows up
  );
  const out = await runResolve(db, { code: "ct8527016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });
  assert.strictEqual(out.found, true, "the canonical spelling still resolved");
  assert.deepStrictEqual(out.errors, [], "a tier that ultimately succeeded reports no error");
});

test("resolveThroughProviders: a throwing tier is recorded and the walk continues", async () => {
  const boom = { name: "boom", tier: 1, async resolve() { throw new Error("down"); } };
  const good = { name: "good", tier: 2, async resolve() { return { styleCode: "X" }; } };
  const out = await resolveThroughProviders([boom, good], { normalised: "X", candidates: [] });
  assert.strictEqual(out.provider, "good");
  assert.strictEqual(out.errors.length, 1);
  assert.strictEqual(out.errors[0].provider, "boom");
});

test("an empty / unusable code is rejected before any tier runs", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({});
  for (const bad of ["", "   ", "---", "///"]) {
    const out = await runResolve(db, { code: bad, providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });
    assert.strictEqual(out.kind, "reject");
    assert.strictEqual(out.code, "empty-code");
  }
  assert.strictEqual(kdb.calls.length, 0);
});

test("a cache-write failure does not fail the resolve", async () => {
  const db = fakeDb({});
  db.failWrites("sneaker_models");
  const kdb = fakeKicksDb({ "CT8527-016": [KDB_RECORD("CT8527-016", "Nike Dunk Low", "https://img/a.jpg")] });
  const out = await runResolve(db, { code: "CT8527-016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  assert.strictEqual(out.found, true, "the answer in hand is still correct");
  assert.strictEqual(out.cached, false, "and we honestly report that it was not cached");
});

test("the cached `raw` blob is a STRING — an object could carry an illegal RTDB key", async () => {
  // Vendor payloads carry price maps keyed by size ("10.5"). A "." in an RTDB key
  // throws at write time and would take the whole resolve down.
  const db = fakeDb({});
  const rec = KDB_RECORD("CT8527-016", "Nike Dunk Low", "https://img/a.jpg");
  rec.prices = { "10.5": 220, "11": 210 }; // <- illegal as RTDB keys
  const kdb = fakeKicksDb({ "CT8527-016": [rec] });
  const out = await runResolve(db, { code: "CT8527-016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  assert.strictEqual(typeof out.model.raw, "string");
  assert.ok(out.model.raw.includes("10.5"), "the payload is preserved, just not as keys");
  assert.strictEqual(typeof db.data.sneaker_models.CT8527016.raw, "string");
});

test("packRaw survives an unserialisable payload instead of throwing", () => {
  const circular = {}; circular.self = circular;
  assert.strictEqual(packRaw(circular), null);
  assert.strictEqual(typeof packRaw({ a: 1 }), "string");
});

test("the cached model never contains undefined (RTDB rejects it)", async () => {
  const db = fakeDb({});
  // A sparse vendor record: no brand, no images, no metadata.
  const kdb = fakeKicksDb({ "IE3437": [{ sku: "IE3437", name: "Samba" }] });
  const out = await runResolve(db, { code: "IE3437", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  assert.strictEqual(out.found, true);
  for (const [k, v] of Object.entries(out.model)) {
    assert.notStrictEqual(v, undefined, `${k} must be null, never undefined`);
  }
  assert.strictEqual(out.model.imageUrl, null);
  assert.strictEqual(out.model.brand, null);
});

// ── Existing products + duplicate candidates ─────────────────────────────────
const PRODUCTS = {
  p1: { id: "p1", name: "Nike Dunk Low Black", photoUrl: "https://p/1.jpg", category: "Footwear", productType: "sneaker", styleCode: "CT8527-016", styleCodeNormalised: "CT8527016" },
  p2: { id: "p2", name: "Nike Dunk Low Black (dup)", photoUrl: "https://p/2.jpg", category: "Footwear", productType: "sneaker", styleCode: "CT8527016", styleCodeNormalised: "CT8527016" },
  p3: { id: "p3", name: "adidas Samba OG", photoUrl: null, category: "Footwear", productType: "sneaker", styleCode: "IE3437", styleCodeNormalised: "IE3437" },
  p4: { id: "p4", name: "Untagged product", photoUrl: null, category: "Footwear", productType: "sneaker" },
};

test("an existing code returns the products that already carry it", async () => {
  const db = fakeDb({ products: PRODUCTS });
  const kdb = fakeKicksDb({});
  const out = await runResolve(db, { code: "IE3437", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  assert.strictEqual(out.existingProducts.length, 1);
  assert.strictEqual(out.existingProducts[0].id, "p3");
  assert.strictEqual(out.existingProducts[0].name, "adidas Samba OG");
  assert.strictEqual(out.duplicate, false);
});

test("two products on ONE code write a PAIR row to /duplicate_candidates and raise the banner", async () => {
  const db = fakeDb({ products: PRODUCTS });
  const kdb = fakeKicksDb({});
  const out = await runResolve(db, { code: "CT8527-016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  assert.strictEqual(out.duplicate, true);
  assert.strictEqual(out.existingProducts.length, 2);
  assert.deepStrictEqual(out.duplicatePairIds, ["p1__p2"]);

  // The live rules validate this node as a PAIR record. A row keyed by style
  // code holding a productIds ARRAY is rejected at write time and shows up in
  // the UI as a silent no-op.
  const flag = db.data[DUPLICATE_CANDIDATES_PATH].p1__p2;
  assert.ok(flag, "the duplicate must be recorded, not just shown");
  assert.strictEqual(flag.productIdA, "p1");
  assert.strictEqual(flag.productIdB, "p2");
  assert.strictEqual(flag.reason, "styleCodeCollision");
  assert.strictEqual(flag.status, "open");
  assert.strictEqual(flag.detectedAt, NOW);
  assert.ok(!("productIds" in flag), "the array shape is the REJECTED shape");
  assert.strictEqual(flag.detectedBy, "u1");
  // The live rule permits extra children and validates these explicitly. The
  // field is styleCodeNormalised, NOT styleCode — validated as a string of at
  // most 32 chars, which the normalised form always satisfies.
  assert.strictEqual(flag.styleCodeNormalised, "CT8527016");
  assert.ok(flag.styleCodeNormalised.length <= 32);
  assert.ok(!("styleCode" in flag), "styleCode is not the validated field name");
  assert.deepStrictEqual(Object.keys(flag).sort(),
    ["detectedAt", "detectedBy", "productIdA", "productIdB", "reason", "status", "styleCodeNormalised"]);

  // NOTHING was merged, renamed or deleted — both products are untouched.
  assert.deepStrictEqual(db.data.products.p1, PRODUCTS.p1);
  assert.deepStrictEqual(db.data.products.p2, PRODUCTS.p2);
});

test("the pair id is deterministic — re-detecting rewrites one row, never piles up", async () => {
  const db = fakeDb({ products: PRODUCTS });
  const kdb = fakeKicksDb({});
  await runResolve(db, { code: "CT8527-016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });
  await runResolve(db, { code: "ct8527 016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW + 5000 });
  assert.deepStrictEqual(Object.keys(db.data[DUPLICATE_CANDIDATES_PATH]), ["p1__p2"]);
  assert.strictEqual(duplicatePairId("p2", "p1"), "p1__p2", "id order must not matter");
});

test("three products on one code become pair rows, anchored on the lowest id", () => {
  assert.deepStrictEqual(duplicatePairs(["p3", "p1", "p2"]), [
    { pairId: "p1__p2", productIdA: "p1", productIdB: "p2" },
    { pairId: "p1__p3", productIdA: "p1", productIdB: "p3" },
  ]);
});

test("a single match never raises a duplicate flag", async () => {
  const db = fakeDb({ products: PRODUCTS });
  const kdb = fakeKicksDb({});
  await runResolve(db, { code: "IE3437", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });
  assert.strictEqual(db.data[DUPLICATE_CANDIDATES_PATH], undefined);
});

test("findProductsByStyleCode matches on the normalised field only", async () => {
  const db = fakeDb({ products: PRODUCTS });
  assert.deepStrictEqual((await findProductsByStyleCode(db, "CT8527016")).map((p) => p.id), ["p1", "p2"]);
  assert.deepStrictEqual(await findProductsByStyleCode(db, "CT8527700"), [], "the sibling colorway matches nothing");
  assert.deepStrictEqual(await findProductsByStyleCode(db, "CT8527"), [], "a prefix matches nothing");
});

// ── COVERAGE BY BRAND ────────────────────────────────────────────────────────
// The free KicksDB tier is StockX-sourced and thinner on adidas/Puma/Reebok
// than on Jordan and Dunk. Misses are recorded per brand so that gap can be
// measured rather than guessed at.
test("a miss is logged with the brand family the code shape implies", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({});
  await runResolve(db, { code: "IE3437", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  const row = db.data[STYLE_CODE_MISSES_PATH].IE3437;
  assert.ok(row, "a miss must be recorded, not merely returned");
  assert.strictEqual(row.brandFamily, "adidas");
  assert.strictEqual(row.format, "adidas-block");
  assert.strictEqual(row.misses, 1);
  assert.strictEqual(row.firstMissedAt, NOW);
  assert.strictEqual(row.lastMissedAt, NOW);
  assert.strictEqual(row.lastErrors, null, "a clean coverage gap carries no error");
});

test("repeat misses of the same code update ONE row with a count", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({});
  await runResolve(db, { code: "380190-01", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });
  await runResolve(db, { code: "380190-01", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW + 60000 });

  const row = db.data[STYLE_CODE_MISSES_PATH]["38019001"];
  assert.strictEqual(row.misses, 2);
  assert.strictEqual(row.brandFamily, "Puma");
  assert.strictEqual(row.firstMissedAt, NOW, "the first sighting is preserved");
  assert.strictEqual(row.lastMissedAt, NOW + 60000);
  assert.strictEqual(Object.keys(db.data[STYLE_CODE_MISSES_PATH]).length, 1);
});

test("a BROKEN tier is recorded on the miss as an outage, not a coverage gap", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({}, { status: 500 });
  await runResolve(db, { code: "CT8527-016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  const row = db.data[STYLE_CODE_MISSES_PATH].CT8527016;
  assert.strictEqual(row.brandFamily, "Nike/Jordan");
  assert.ok(row.lastErrors, "an outage must be distinguishable from 'the catalog lacks this shoe'");
  assert.match(row.lastErrors, /500/);
});

test("a successful resolve logs NO miss", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({ "IE3437": [KDB_RECORD("IE3437", "adidas Samba OG", "https://img/s.jpg")] });
  await runResolve(db, { code: "IE3437", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });
  assert.strictEqual(db.data[STYLE_CODE_MISSES_PATH], undefined);
});

// ── THE /sneaker_models WRITE CONTRACT (live RTDB rules) ─────────────────────
test("source is the rules ENUM, never the vendor name", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({ "IE3437": [KDB_RECORD("IE3437", "adidas Samba OG", "https://img/s.jpg")] });
  const out = await runResolve(db, { code: "IE3437", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });
  assert.strictEqual(out.model.source, "api");
  assert.ok(["api", "websearch", "manual"].includes(out.model.source));
  // The required trio the rules enforce.
  for (const f of ["styleCode", "source", "fetchedAt"]) {
    assert.ok(out.model[f] !== null && out.model[f] !== undefined && out.model[f] !== "", `${f} is required`);
  }
});

test("a non-https image is DROPPED rather than failing the whole cache write", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({ "IE3437": [{ ...KDB_RECORD("IE3437", "adidas Samba OG", "http://insecure/x.jpg") }] });
  const out = await runResolve(db, { code: "IE3437", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });
  assert.strictEqual(out.found, true, "the model is still useful without a photo");
  assert.strictEqual(out.model.imageUrl, null, "imageUrl must be https:// or absent");
});

test("the variant GTIN/EAN is kept when the catalog returns one", async () => {
  const db = fakeDb({});
  const rec = KDB_RECORD("IE3437", "adidas Samba OG", "https://img/s.jpg");
  rec.barcodes = ["4066748931552"];
  const kdb = fakeKicksDb({ "IE3437": [rec] });
  const out = await runResolve(db, { code: "IE3437", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });
  assert.strictEqual(out.model.gtin, "4066748931552");
  assert.strictEqual(db.data.sneaker_models.IE3437.gtin, "4066748931552");
});

// ── /style_code_index IS THE AUTHORITY ON OWNERSHIP ──────────────────────────
// Uniqueness is CLAIMED, not checked. The index — not a /products scan —
// answers "does this code already belong to something?".
test("the claim is read and reported as authority", async () => {
  const db = fakeDb({
    products: PRODUCTS,
    [STYLE_CODE_INDEX_PATH]: { IE3437: { productId: "p3", claimedAt: 123, claimedBy: "u9" } },
  });
  const out = await runResolve(db, { code: "IE3437", providers: providersFor(db, fakeKicksDb({})), actor: ACTOR, nowMs: NOW });

  assert.deepStrictEqual(out.claim, { productId: "p3", claimedAt: 123, claimedBy: "u9" });
  assert.strictEqual(out.claimOrphaned, false);
});

test("an unclaimed code reports claim:null so intake may attempt the claim", async () => {
  const db = fakeDb({ products: PRODUCTS });
  const out = await runResolve(db, { code: "ZZ9999-999", providers: providersFor(db, fakeKicksDb({})), actor: ACTOR, nowMs: NOW });
  assert.strictEqual(out.claim, null);
  assert.strictEqual(out.claimOrphaned, false);
});

test("THE CASE THE /products SCAN ALONE MISSES: a claim whose product is not stamped", async () => {
  // The claim landed; the styleCodeNormalised stamp did not (denied by the
  // immutability rule, or the follow-up write failed). A scan-only resolver
  // reports "nothing has this code" and sends staff off to create a duplicate.
  const db = fakeDb({
    products: { p9: { id: "p9", name: "Unstamped but claimed" } },
    [STYLE_CODE_INDEX_PATH]: { CT8527016: { productId: "p9", claimedAt: 1, claimedBy: "u1" } },
  });
  const out = await runResolve(db, { code: "CT8527-016", providers: providersFor(db, fakeKicksDb({})), actor: ACTOR, nowMs: NOW });

  assert.deepStrictEqual(out.existingProducts, [], "the scan genuinely finds nothing");
  assert.strictEqual(out.claim.productId, "p9", "but the claim knows who owns it");
  assert.strictEqual(out.claimOrphaned, false, "and the product does exist");
});

test("an ORPHAN claim — product never created — is reported, not treated as taken", async () => {
  const db = fakeDb({
    products: PRODUCTS,
    [STYLE_CODE_INDEX_PATH]: { CT8527700: { productId: "pGONE", claimedAt: 1, claimedBy: "u1" } },
  });
  const out = await runResolve(db, { code: "CT8527-700", providers: providersFor(db, fakeKicksDb({})), actor: ACTOR, nowMs: NOW });
  assert.strictEqual(out.claim.productId, "pGONE");
  assert.strictEqual(out.claimOrphaned, true);
});

test("readClaim ignores a malformed index row rather than trusting it", async () => {
  const db = fakeDb({ [STYLE_CODE_INDEX_PATH]: { A1: {}, A2: { productId: "" }, A3: { productId: 7 } } });
  for (const k of ["A1", "A2", "A3", "MISSING"]) {
    assert.strictEqual(await readClaim(db, k), null);
  }
});

// ── /sneaker_models IS CREATE-ONCE ───────────────────────────────────────────
test("an occupied cache slot is NOT overwritten incidentally", async () => {
  // Tier 1 serves the row, so tier 2 never runs and no write is attempted.
  const db = fakeDb({
    sneaker_models: { IE3437: { styleCode: "IE3437", brand: "adidas", model: "Samba OG", source: "api", fetchedAt: 1 } },
  });
  const kdb = fakeKicksDb({ "IE3437": [KDB_RECORD("IE3437", "SOMETHING ELSE", "https://img/x.jpg")] });
  const out = await runResolve(db, { code: "IE3437", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  assert.strictEqual(out.cached, false);
  assert.strictEqual(out.cacheCorrected, false);
  assert.strictEqual(db.data.sneaker_models.IE3437.model, "Samba OG", "the stored row is untouched");
  assert.strictEqual(db.writes.filter((w) => w.path.includes("sneaker_models")).length, 0);
});

test("a CORRUPT cache row is corrected deliberately, and the correction is reported", async () => {
  const db = fakeDb({
    sneaker_models: { CT8527016: { styleCode: "CT8527-700", model: "wrong shoe" } },
  });
  const kdb = fakeKicksDb({ "CT8527-016": [KDB_RECORD("CT8527-016", "Nike Dunk Low Black", "https://img/a.jpg")] });
  const out = await runResolve(db, { code: "CT8527-016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  assert.strictEqual(out.cached, true);
  assert.strictEqual(out.cacheCorrected, true, "the one overwrite this function performs is flagged");
  assert.strictEqual(db.data.sneaker_models.CT8527016.model, "Nike Dunk Low Black");
});

test("a fresh resolve into an EMPTY slot is a create, not a correction", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({ "IE3437": [KDB_RECORD("IE3437", "adidas Samba OG", "https://img/s.jpg")] });
  const out = await runResolve(db, { code: "IE3437", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });
  assert.strictEqual(out.cached, true);
  assert.strictEqual(out.cacheCorrected, false);
});

// ── TIER 3 — CONFUSABLE-CHARACTER RETRY ─────────────────────────────────────
// OCR confuses 0/O, 1/I, 8/B, 5/S, 2/Z on a small printed label. When a code
// misses everywhere, retry the LOOKUP with the plausible misreadings.
test("a misread glyph is recovered by retrying the lookup", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({ "CT8527-016": [KDB_RECORD("CT8527-016", "Nike Dunk Low", "https://img/a.jpg")] });
  // OCR read the 0 as an O.
  const out = await runResolve(db, {
    code: "CT8527O16", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW, confusableRetry: true,
  });

  assert.strictEqual(out.found, true);
  assert.strictEqual(out.normalised, "CT8527016", "the CORRECTED code is the effective identity");
  assert.strictEqual(out.correctedFrom, "CT8527O16", "and the UI is told what was actually read");
});

test("THE POISON GUARD: a corrected resolve caches under the REAL code, never the misread one", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({ "CT8527-016": [KDB_RECORD("CT8527-016", "Nike Dunk Low", "https://img/a.jpg")] });
  await runResolve(db, {
    code: "CT8527O16", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW, confusableRetry: true,
  });

  assert.ok(db.data.sneaker_models.CT8527016, "cached under the real code");
  assert.strictEqual(db.data.sneaker_models.CT8527O16, undefined,
    "caching under the misread code would poison it permanently and stamp a product with a code no shoe carries");
});

test("a corrected resolve re-asks ownership about the CORRECTED code", async () => {
  const db = fakeDb({
    products: PRODUCTS,
    [STYLE_CODE_INDEX_PATH]: { CT8527016: { productId: "p1", claimedAt: 1, claimedBy: "u1" } },
  });
  const kdb = fakeKicksDb({ "CT8527-016": [KDB_RECORD("CT8527-016", "Nike Dunk Low", "https://img/a.jpg")] });
  const out = await runResolve(db, {
    code: "CT8527O16", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW, confusableRetry: true,
  });

  assert.strictEqual(out.claim.productId, "p1", "the claim on the corrected code must be found");
  assert.ok(out.existingProducts.some((p) => p.id === "p1"));
});

test("tier 3 is OFF by default — a typed code does not pay for variant lookups", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({ "CT8527-016": [KDB_RECORD("CT8527-016", "Nike Dunk Low", "https://img/a.jpg")] });
  const out = await runResolve(db, { code: "CT8527O16", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  assert.strictEqual(out.found, false, "a human who typed it did not misread it");
  assert.strictEqual(out.correctedFrom, null);
});

test("tier 3 lookups are hard-capped", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({});
  await runResolve(db, {
    code: "SSSSSSSSS", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW,
    confusableRetry: true, maxConfusableLookups: 3,
  });
  // 1 first pass + at most 3 variants, each asking at most its spellings.
  assert.ok(kdb.calls.length <= 4 * 3, `unbounded variant fan-out: ${kdb.calls.length} calls`);
});

test("a code with no confusable characters skips tier 3 entirely", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({});
  const before = kdb.calls.length;
  const out = await runResolve(db, {
    code: "XY3467", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW, confusableRetry: true,
  });
  assert.strictEqual(out.found, false);
  assert.strictEqual(out.correctedFrom, null);
  assert.ok(kdb.calls.length - before <= 2, "no variants to try, so no extra lookups");
});

test("the miss is logged against the code as READ, not a variant", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({});
  await runResolve(db, {
    code: "CT8527O16", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW, confusableRetry: true,
  });
  assert.ok(db.data[STYLE_CODE_MISSES_PATH].CT8527O16, "the catalog failed on what we asked for");
  assert.strictEqual(Object.keys(db.data[STYLE_CODE_MISSES_PATH]).length, 1, "variants must not each log a miss");
});

// ── A CLOSED DUPLICATE MUST STAY CLOSED ──────────────────────────────────────
// A style-code collision is PERMANENT until someone merges the products: both
// records keep the code, so every future scan of that shoe re-detects it. If
// re-detection rewrote the status, the duplicate queue could never be cleared.
test("re-detection NEVER reopens a pair a human closed", async () => {
  for (const closed of ["merged", "dismissed"]) {
    const db = fakeDb({
      products: PRODUCTS,
      [DUPLICATE_CANDIDATES_PATH]: {
        p1__p2: { productIdA: "p1", productIdB: "p2", reason: "styleCodeCollision", status: closed, detectedAt: 111 },
      },
    });
    await runResolve(db, { code: "CT8527-016", providers: providersFor(db, fakeKicksDb({})), actor: ACTOR, nowMs: NOW });
    const row = db.data[DUPLICATE_CANDIDATES_PATH].p1__p2;
    assert.strictEqual(row.status, closed, `a ${closed} pair must not be reopened`);
    assert.strictEqual(row.detectedAt, 111, "the FIRST sighting is the useful fact, not the latest re-observation");
  }
});

test("an already-open pair stays open and keeps its original detectedAt", async () => {
  const db = fakeDb({
    products: PRODUCTS,
    [DUPLICATE_CANDIDATES_PATH]: {
      p1__p2: { productIdA: "p1", productIdB: "p2", reason: "styleCodeCollision", status: "open", detectedAt: 222 },
    },
  });
  await runResolve(db, { code: "CT8527-016", providers: providersFor(db, fakeKicksDb({})), actor: ACTOR, nowMs: NOW });
  const row = db.data[DUPLICATE_CANDIDATES_PATH].p1__p2;
  assert.strictEqual(row.status, "open");
  assert.strictEqual(row.detectedAt, 222);
});

test("a genuinely NEW pair is born open, stamped now", async () => {
  const db = fakeDb({ products: PRODUCTS });
  await runResolve(db, { code: "CT8527-016", providers: providersFor(db, fakeKicksDb({})), actor: ACTOR, nowMs: NOW });
  const row = db.data[DUPLICATE_CANDIDATES_PATH].p1__p2;
  assert.strictEqual(row.status, "open");
  assert.strictEqual(row.detectedAt, NOW);
});

test("a malformed prior status is not trusted — it falls back to open", async () => {
  const db = fakeDb({
    products: PRODUCTS,
    [DUPLICATE_CANDIDATES_PATH]: { p1__p2: { productIdA: "p1", productIdB: "p2", status: 42, detectedAt: "soon" } },
  });
  await runResolve(db, { code: "CT8527-016", providers: providersFor(db, fakeKicksDb({})), actor: ACTOR, nowMs: NOW });
  const row = db.data[DUPLICATE_CANDIDATES_PATH].p1__p2;
  assert.strictEqual(row.status, "open");
  assert.strictEqual(row.detectedAt, NOW);
});

// ── THE CACHE-OCCUPANT SIGNAL ────────────────────────────────────────────────
// "The stored row is corrupt" must be established by VERIFYING the row, not
// inferred from `!chain.fromCache` — which also becomes false when tier 1 could
// not READ at all. Fails closed: a row we cannot verify is treated as absent.
test("a VALID cache row is left alone when tier 1 merely failed to READ it", async () => {
  const db = fakeDb({
    sneaker_models: { IE3437: { styleCode: "IE3437", brand: "adidas", model: "Samba OG", source: "api", fetchedAt: 1 } },
  });
  // A cache provider that THROWS (RTDB read error) rather than declining.
  const brokenCache = { name: "cache", tier: 1, async resolve() { throw new Error("RTDB read failed"); } };
  const kdb = fakeKicksDb({ "IE3437": [KDB_RECORD("IE3437", "REPLACEMENT", "https://img/x.jpg")] });
  const providers = [
    brokenCache,
    makeKicksDbProvider({ apiKey: "k", fetchImpl: kdb.fetchImpl, baseUrl: "https://api.test", nowMs: NOW }),
    makeWebSearchProvider(),
  ];
  const out = await runResolve(db, { code: "IE3437", providers, actor: ACTOR, nowMs: NOW });

  assert.strictEqual(out.found, true);
  assert.strictEqual(out.cacheCorrected, false, "nothing was corrected — the stored row is valid");
  assert.strictEqual(out.cached, false, "a create-once node must not be rewritten without cause");
  assert.strictEqual(db.data.sneaker_models.IE3437.model, "Samba OG", "the valid row survived");
  assert.strictEqual(out.errors.length, 1, "the read failure is still reported");
});

test("an UNVERIFIABLE row is treated as absent and re-fetched", async () => {
  for (const bad of [
    { styleCode: "CT8527-700", model: "wrong shoe" }, // wrong code for this key
    { styleCode: "", model: "blank" },
    { model: "no styleCode at all" },
    { styleCode: 42, model: "not a string" },
  ]) {
    const db = fakeDb({ sneaker_models: { CT8527016: bad } });
    const kdb = fakeKicksDb({ "CT8527-016": [KDB_RECORD("CT8527-016", "Nike Dunk Low", "https://img/a.jpg")] });
    const out = await runResolve(db, { code: "CT8527-016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });
    assert.strictEqual(out.cacheCorrected, true, `must correct ${JSON.stringify(bad)}`);
    assert.strictEqual(db.data.sneaker_models.CT8527016.model, "Nike Dunk Low");
  }
});

test("an EMPTY slot is a create, never a correction", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({ "IE3437": [KDB_RECORD("IE3437", "adidas Samba OG", "https://img/s.jpg")] });
  const out = await runResolve(db, { code: "IE3437", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });
  assert.strictEqual(out.cached, true);
  assert.strictEqual(out.cacheCorrected, false);
});

// ── THE ROUTE AND SHAPE, PINNED TO WHAT THE VENDOR ACTUALLY SERVES ───────────
// The adapter originally called /v3/unified/products/{id}, which returns 403
// "This route requires a subscription" on our plan — every code, every time.
// That shipped, and staff could not add products. These pin the working route
// and the real payload shape so it cannot drift back.
const { upscaleVendorImage, colorwayFromTitle, IMAGE_TARGET_PX } = require("../lib/style-code-providers.cjs");

test("the adapter calls the StockX route with the code as a QUERY param", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({ "CT8527-016": [KDB_RECORD("CT8527-016", "Jordan 4 Retro Red Thunder", "https://img/a.jpg", "Jordan 4 Retro")] });
  await runResolve(db, { code: "CT8527-016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  assert.ok(kdb.calls.length > 0);
  for (const u of kdb.calls) {
    assert.match(u, /\/v3\/stockx\/products\?sku=/, `wrong route: ${u}`);
    assert.ok(!u.includes("/v3/unified/"), "the unified route 403s on our plan — never call it");
  }
});

test("REAL SHAPE: title becomes the display name, and the brand is not duplicated", async () => {
  // StockX `model` already contains the brand, so composing brand + model reads
  // "Jordan Jordan 4 Retro". `name` carries the vendor's full title instead.
  const db = fakeDb({});
  const kdb = fakeKicksDb({ "CT8527-016": [KDB_RECORD("CT8527-016", "Jordan 4 Retro Red Thunder", "https://img/a.jpg", "Jordan 4 Retro")] });
  const out = await runResolve(db, { code: "CT8527-016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  assert.strictEqual(out.model.name, "Jordan 4 Retro Red Thunder");
  assert.strictEqual(out.model.model, "Jordan 4 Retro");
  assert.strictEqual(out.model.brand, "Jordan");
  // The colourway is not a field on this route — it is derived from the title.
  assert.strictEqual(out.model.colorwayName, "Red Thunder");
  const composed = [out.model.brand, out.model.model].join(" ");
  assert.strictEqual(composed, "Jordan Jordan 4 Retro", "this is exactly why `name` exists");
  assert.notStrictEqual(out.model.name, composed);
});

test("REAL SHAPE: adidas and Puma map the same way", async () => {
  const cases = [
    ["IE3437", "adidas Samba OG Collegiate Green", "adidas Samba OG", "Collegiate Green"],
    ["396463-01", "Puma Palermo Pele Yellow Club Red", "Puma Palermo", "Pele Yellow Club Red"],
  ];
  for (const [sku, title, model, colorway] of cases) {
    const db = fakeDb({});
    const kdb = fakeKicksDb({ [sku]: [KDB_RECORD(sku, title, "https://img/x.jpg", model)] });
    const out = await runResolve(db, { code: sku, providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });
    assert.strictEqual(out.found, true, `${sku} should resolve`);
    assert.strictEqual(out.model.name, title);
    assert.strictEqual(out.model.colorwayName, colorway);
  }
});

test("the 140x100 thumbnail is upscaled — the confirm screen must show the shoe", () => {
  const thumb = "https://images.stockx.com/images/Air-Jordan-4.jpg?fit=fill&bg=FFFFFF&w=140&h=100&fm=webp&q=90";
  const big = upscaleVendorImage(thumb);
  assert.match(big, new RegExp(`w=${IMAGE_TARGET_PX}`));
  assert.match(big, new RegExp(`h=${IMAGE_TARGET_PX}`));
  assert.ok(!big.includes("w=140"), "still a thumbnail");
  // Everything else about the URL survives.
  assert.match(big, /fit=fill/);
  assert.match(big, /fm=webp/);
});

test("a URL with no size params, or an unparseable one, is returned untouched", () => {
  for (const u of ["https://cdn.example/x.jpg", "https://cdn.example/x.jpg?v=2", "not a url", "", null]) {
    assert.strictEqual(upscaleVendorImage(u), u);
  }
});

test("colorwayFromTitle refuses to guess when the title is not model-prefixed", () => {
  assert.strictEqual(colorwayFromTitle("Something Else Entirely", "Jordan 4 Retro"), null);
  assert.strictEqual(colorwayFromTitle("Jordan 4 Retro", "Jordan 4 Retro"), null, "no remainder = no colourway");
  assert.strictEqual(colorwayFromTitle(null, "x"), null);
  assert.strictEqual(colorwayFromTitle("x", null), null);
  // Case-insensitive prefix, exact remainder.
  assert.strictEqual(colorwayFromTitle("JORDAN 4 RETRO Red Thunder", "Jordan 4 Retro"), "Red Thunder");
});

test("gtin is null on this route — StockX serves no barcode", async () => {
  const db = fakeDb({});
  const kdb = fakeKicksDb({ "IE3437": [KDB_RECORD("IE3437", "adidas Samba OG Green", "https://img/s.jpg", "adidas Samba OG")] });
  const out = await runResolve(db, { code: "IE3437", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });
  assert.strictEqual(out.model.gtin, null);
});

test("the anti-collapse guard still holds on the new shape", async () => {
  // Ask for CT8527-016, vendor hands back the sibling colorway.
  const db = fakeDb({});
  const kdb = fakeKicksDb({
    "CT8527-016": [KDB_RECORD("CT8527-700", "Jordan 4 Retro Varsity Maize", "https://img/700.jpg", "Jordan 4 Retro")],
    "CT8527016": [KDB_RECORD("CT8527-700", "Jordan 4 Retro Varsity Maize", "https://img/700.jpg", "Jordan 4 Retro")],
  });
  const out = await runResolve(db, { code: "CT8527-016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });
  assert.strictEqual(out.found, false, "a different SKU is not a match, whatever the shape");
  assert.strictEqual(db.data.sneaker_models, undefined);
});

test("the RESOLVED model carries the upscaled image, not the thumbnail", async () => {
  // Testing upscaleVendorImage alone does not prove firstImage actually calls
  // it — this asserts the end-to-end result the confirm screen renders.
  const thumb = "https://images.stockx.com/images/AJ4.jpg?fit=fill&bg=FFFFFF&w=140&h=100&fm=webp&q=90";
  const db = fakeDb({});
  const kdb = fakeKicksDb({ "CT8527-016": [KDB_RECORD("CT8527-016", "Jordan 4 Retro Red Thunder", thumb, "Jordan 4 Retro")] });
  const out = await runResolve(db, { code: "CT8527-016", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });

  assert.match(out.model.imageUrl, /w=1000/, "the confirm screen must not get a 140px thumbnail");
  assert.match(out.model.imageUrl, /h=1000/);
  assert.ok(!out.model.imageUrl.includes("w=140"));
  // And what was cached is the upscaled one too, so a cache hit is not degraded.
  assert.match(db.data.sneaker_models.CT8527016.imageUrl, /w=1000/);
});

test("a gallery-only record is upscaled as well", async () => {
  const thumb = "https://images.stockx.com/images/S.jpg?fit=fill&w=140&h=100";
  const rec = KDB_RECORD("IE3437", "adidas Samba OG Green", thumb, "adidas Samba OG");
  rec.image = ""; // no direct image, only gallery
  const db = fakeDb({});
  const kdb = fakeKicksDb({ "IE3437": [rec] });
  const out = await runResolve(db, { code: "IE3437", providers: providersFor(db, kdb), actor: ACTOR, nowMs: NOW });
  assert.match(out.model.imageUrl, /w=1000/);
});
