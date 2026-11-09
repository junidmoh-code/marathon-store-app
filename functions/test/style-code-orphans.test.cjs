// ─── DEAD STYLE-CODE CLAIMS — the release rule and the self-healing lookup ───
// The fake speaks real RTDB where it matters here: set(null) deletes and prunes,
// a transaction's first pass sees null (the Admin SDK's empty cache), and a
// failure can be injected into any one write.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  inspectClaim,
  releaseDeadClaim,
  resolveOwner,
  sweepOrphanClaims,
  STYLE_CODE_ORPHANS_PATH,
  CLAIM_LIVE,
  CLAIM_DEAD,
  CLAIM_REDIRECTED,
  CLAIM_SIBLINGS_ONLY,
  CLAIM_UNRESOLVED,
} = require("../lib/style-code-orphans.cjs");
const { runResolve, STYLE_CODE_INDEX_PATH } = require("../styleCode/resolveStyleCode.js");
const { makeWebSearchProvider } = require("../lib/style-code-providers.cjs");

const NOW = 1790000000000;
const ACTOR = { uid: "staff1" };
const CODE = "CW3398105";

function fakeDb(initial) {
  const data = JSON.parse(JSON.stringify(initial));
  const fail = { set: new Set(), txn: new Set(), read: new Set() };
  const reads = [];
  const at = (path) => path.split("/").filter(Boolean)
    .reduce((n, k) => (n == null || typeof n !== "object" ? undefined : n[k]), data);
  const put = (path, value) => {
    const parts = path.split("/").filter(Boolean);
    const last = parts.pop();
    if (value === null || value === undefined) {
      const trail = [];
      let node = data;
      for (const k of parts) {
        if (node[k] == null) return;
        trail.push([node, k]);
        node = node[k];
      }
      delete node[last];
      for (const [parent, k] of trail.reverse()) {
        if (Object.keys(parent[k]).length) break;
        delete parent[k];
      }
      return;
    }
    let node = data;
    for (const k of parts) {
      if (node[k] == null || typeof node[k] !== "object") node[k] = {};
      node = node[k];
    }
    node[last] = JSON.parse(JSON.stringify(value));
  };
  const snap = (v) => ({ val: () => (v === undefined ? null : v), exists: () => v !== undefined && v !== null });
  const matches = (set, path) => [...set].some((s) => path.includes(s));
  return {
    data, fail, reads,
    /** Runs between the transaction's first pass and its server pass. */
    onTxnServerPass: null,
    ref(path) {
      const db = this;
      return {
        async get() {
          reads.push(path);
          if (matches(fail.read, path)) throw new Error("read failed");
          const v = at(path);
          return snap(v === undefined ? v : JSON.parse(JSON.stringify(v))); // a snapshot, not a live reference
        },
        async set(value) {
          if (matches(fail.set, path)) throw new Error("set failed");
          put(path, value);
        },
        async transaction(fn) {
          if (matches(fail.txn, path)) throw new Error("transaction failed");
          // First pass: the Admin SDK's local cache is empty.
          const first = fn(null);
          if (first === undefined) return { committed: false, snapshot: snap(null) };
          if (db.onTxnServerPass) await db.onTxnServerPass();
          const out = fn(at(path) === undefined ? null : at(path));
          if (out === undefined) return { committed: false, snapshot: snap(at(path)) };
          put(path, out);
          return { committed: true, snapshot: snap(out) };
        },
        orderByChild(field) {
          return {
            equalTo(target) {
              return {
                async get() {
                  const node = at(path) || {};
                  const out = Object.fromEntries(Object.entries(node).filter(([, v]) => v && v[field] === target));
                  return { val: () => (Object.keys(out).length ? out : null) };
                },
              };
            },
          };
        },
      };
    },
  };
}

const claimOf = (db, code = CODE) => (db.data[STYLE_CODE_INDEX_PATH] || {})[code];
const logOf = (db, code = CODE) => (db.data[STYLE_CODE_ORPHANS_PATH] || {})[code];
const DEAD = { productId: "pGONE", claimedAt: 111, claimedBy: "old" };
const providers = (found = false) => [
  found
    ? { name: "stub", tier: 2, resolve: async () => ({ styleCode: "CW3398-105", name: "Stub" }) }
    : makeWebSearchProvider(),
];
const resolve = (db, opts = {}) =>
  runResolve(db, { code: "CW3398-105", providers: providers(opts.found), actor: "actor" in opts ? opts.actor : ACTOR, nowMs: NOW });

// ── resolveOwner / inspectClaim ──────────────────────────────────────────────

test("a product that exists but has no id child is LIVE, never dead", async () => {
  const db = fakeDb({ products: { pOLD: { name: "legacy row, no id child" } } });
  assert.deepStrictEqual(await resolveOwner(db, "pOLD"), { state: "live", id: "pOLD" });
  assert.strictEqual((await inspectClaim(db, { productId: "pOLD" })).kind, CLAIM_LIVE);
});

test("a hidden or deactivated product is LIVE: the flag sits on an existing record", async () => {
  const db = fakeDb({ products: { pOFF: { id: "pOFF", deactivated: { at: 1 }, hidden: true } } });
  assert.strictEqual((await inspectClaim(db, { productId: "pOFF" })).kind, CLAIM_LIVE);
});

test("a read error propagates: it must not read as 'does not exist'", async () => {
  const db = fakeDb({ products: {} });
  db.fail.read.add("products/pGONE");
  await assert.rejects(inspectClaim(db, DEAD), /read failed/);
});

test("a merged primary follows the chain to its survivor", async () => {
  const db = fakeDb({ products: { a: { mergedInto: "b" }, b: { mergedInto: "c" }, c: { id: "c" } } });
  assert.deepStrictEqual(await inspectClaim(db, { productId: "a" }), { kind: CLAIM_REDIRECTED, owners: ["c"] });
});

test("a merge cycle and a dangling redirect are unresolved, never dead", async () => {
  const cycle = fakeDb({ products: { a: { mergedInto: "b" }, b: { mergedInto: "a" } } });
  assert.deepStrictEqual(await inspectClaim(cycle, { productId: "a" }),
    { kind: CLAIM_UNRESOLVED, owners: [], reason: "merge-cycle" });
  const dangling = fakeDb({ products: { a: { mergedInto: "gone" } } });
  assert.deepStrictEqual(await inspectClaim(dangling, { productId: "a" }),
    { kind: CLAIM_UNRESOLVED, owners: [], reason: "merge-dangling" });
});

test("every owner absent is DEAD, including a dead sibling", async () => {
  const db = fakeDb({ products: {} });
  assert.strictEqual((await inspectClaim(db, { ...DEAD, siblings: { gone2: { addedAt: 1 } } })).kind, CLAIM_DEAD);
});

test("a dead primary with a live sibling is NOT dead: that is PO7548922", async () => {
  const db = fakeDb({ products: { s1: { id: "s1" }, s2: { id: "s2" } } });
  const verdict = await inspectClaim(db, { ...DEAD, siblings: { s1: { addedAt: 1 }, s2: { addedAt: 2 } } });
  assert.deepStrictEqual(verdict, { kind: CLAIM_SIBLINGS_ONLY, owners: ["s1", "s2"] });
});

test("a dead primary whose only sibling cannot be followed is not released", async () => {
  const db = fakeDb({ products: { s1: { mergedInto: "gone" } } });
  const verdict = await inspectClaim(db, { ...DEAD, siblings: { s1: { addedAt: 1 } } });
  assert.deepStrictEqual(verdict, { kind: CLAIM_UNRESOLVED, owners: [], reason: "merge-dangling" });
});

test("a live primary reads no sibling records", async () => {
  const db = fakeDb({ products: { p1: { name: "no id child" }, s1: { id: "s1" } } });
  await inspectClaim(db, { productId: "p1", siblings: { s1: { addedAt: 1 } } });
  assert.deepStrictEqual(db.reads, ["products/p1"]);
});

// ── releaseDeadClaim ─────────────────────────────────────────────────────────

const release = (db, node = DEAD) =>
  releaseDeadClaim(db, { code: CODE, node, releasedBy: "staff1", nowMs: NOW, source: "resolveStyleCode" });

test("a release removes the claim and writes the record", async () => {
  const db = fakeDb({ [STYLE_CODE_INDEX_PATH]: { [CODE]: DEAD } });
  assert.deepStrictEqual(await release(db), { released: true });
  assert.strictEqual(claimOf(db), undefined);
  assert.deepStrictEqual(logOf(db), {
    productId: "pGONE", releasedAt: NOW, releasedBy: "staff1", source: "resolveStyleCode", claimedAt: 111, claimedBy: "old",
  });
});

test("the log failing leaves the claim in place: a release is never silent", async () => {
  const db = fakeDb({ [STYLE_CODE_INDEX_PATH]: { [CODE]: DEAD } });
  db.fail.set.add(STYLE_CODE_ORPHANS_PATH);
  await assert.rejects(release(db), /set failed/);
  assert.deepStrictEqual(claimOf(db), DEAD);
});

test("a claim that changed before the release is kept and the log withdrawn", async () => {
  const db = fakeDb({ [STYLE_CODE_INDEX_PATH]: { [CODE]: DEAD } });
  db.onTxnServerPass = async () => { db.data[STYLE_CODE_INDEX_PATH][CODE] = { ...DEAD, siblings: { s9: { addedAt: 5 } } }; };
  assert.deepStrictEqual(await release(db), { released: false });
  assert.ok(claimOf(db).siblings.s9, "the newer claim survives");
  assert.strictEqual(logOf(db), undefined);
});

test("a repointed claim is kept too", async () => {
  const db = fakeDb({ [STYLE_CODE_INDEX_PATH]: { [CODE]: DEAD } });
  db.onTxnServerPass = async () => { db.data[STYLE_CODE_INDEX_PATH][CODE] = { ...DEAD, productId: "pSURVIVOR" }; };
  assert.deepStrictEqual(await release(db), { released: false });
  assert.strictEqual(claimOf(db).productId, "pSURVIVOR");
});

test("the first transaction pass sees null and must not abort", async () => {
  const db = fakeDb({ [STYLE_CODE_INDEX_PATH]: { [CODE]: DEAD } });
  await release(db);
  assert.strictEqual(claimOf(db), undefined);
});

test("withdrawing the log restores an earlier release rather than erasing it", async () => {
  const earlier = { productId: "pOLDER", releasedAt: 5, releasedBy: "x", source: "sweep" };
  const db = fakeDb({ [STYLE_CODE_INDEX_PATH]: { [CODE]: DEAD }, [STYLE_CODE_ORPHANS_PATH]: { [CODE]: earlier } });
  db.onTxnServerPass = async () => { db.data[STYLE_CODE_INDEX_PATH][CODE] = { ...DEAD, productId: "pNEW" }; };
  await release(db);
  assert.deepStrictEqual(logOf(db), earlier);
});

test("a second release of a code keeps the earlier one in previous", async () => {
  const earlier = { productId: "pOLDER", releasedAt: 5, releasedBy: "x", source: "sweep" };
  const db = fakeDb({ [STYLE_CODE_INDEX_PATH]: { [CODE]: DEAD }, [STYLE_CODE_ORPHANS_PATH]: { [CODE]: earlier } });
  await release(db);
  assert.deepStrictEqual(logOf(db).previous, { productId: "pOLDER", releasedAt: 5, releasedBy: "x" });
  assert.strictEqual(logOf(db).productId, "pGONE");
});

test("a transaction that errors keeps the log: the outcome is unknown", async () => {
  const db = fakeDb({ [STYLE_CODE_INDEX_PATH]: { [CODE]: DEAD } });
  db.fail.txn.add(STYLE_CODE_INDEX_PATH);
  await assert.rejects(release(db), /transaction failed/);
  assert.strictEqual(logOf(db).productId, "pGONE");
});

// ── runResolve ───────────────────────────────────────────────────────────────

test("THE BUG: a dead claim is released and the code comes back free", async () => {
  const db = fakeDb({ products: {}, [STYLE_CODE_INDEX_PATH]: { [CODE]: DEAD } });
  const out = await resolve(db, { found: true });
  assert.strictEqual(out.claim, null);
  assert.deepStrictEqual(out.owners, []);
  assert.strictEqual(out.claimOrphaned, false);
  assert.strictEqual(out.found, true);
  assert.strictEqual(claimOf(db), undefined);
  assert.strictEqual(logOf(db).productId, "pGONE");
  assert.strictEqual(logOf(db).releasedBy, "staff1");
  assert.strictEqual(logOf(db).releasedAt, NOW);
});

test("a released code can be claimed by the next product", async () => {
  const db = fakeDb({ products: {}, [STYLE_CODE_INDEX_PATH]: { [CODE]: DEAD } });
  await resolve(db);
  assert.strictEqual(claimOf(db), undefined, "the create-once slot is empty");
});

test("no actor is recorded as system, never as blank", async () => {
  const db = fakeDb({ products: {}, [STYLE_CODE_INDEX_PATH]: { [CODE]: DEAD } });
  await resolve(db, { actor: null });
  assert.strictEqual(logOf(db).releasedBy, "system:resolveStyleCode");
});

test("a dead claim with a live product carrying the code hands over to the scan", async () => {
  const db = fakeDb({
    products: { pREAL: { id: "pREAL", styleCodeNormalised: CODE, name: "Real" } },
    [STYLE_CODE_INDEX_PATH]: { [CODE]: DEAD },
  });
  const out = await resolve(db);
  assert.strictEqual(out.claim, null);
  assert.deepStrictEqual(out.existingProducts.map((p) => p.id), ["pREAL"]);
  assert.strictEqual(db.data.products.pREAL.styleCodeNormalised, CODE, "the product keeps its code");
});

test("a live owner found by the scan costs no extra product read", async () => {
  const db = fakeDb({
    products: { p1: { id: "p1", styleCodeNormalised: CODE } },
    [STYLE_CODE_INDEX_PATH]: { [CODE]: { productId: "p1", claimedAt: 1 } },
  });
  const out = await resolve(db);
  assert.strictEqual(out.claim.productId, "p1");
  assert.deepStrictEqual(db.reads.filter((p) => p.startsWith("products/")), []);
});

test("a live owner the scan did not find keeps its claim", async () => {
  const db = fakeDb({
    products: { p1: { name: "unstamped, no id child" } },
    [STYLE_CODE_INDEX_PATH]: { [CODE]: { productId: "p1", claimedAt: 1 } },
  });
  const out = await resolve(db);
  assert.strictEqual(out.claim.productId, "p1");
  assert.strictEqual(out.claimOrphaned, false);
  assert.ok(claimOf(db));
  assert.strictEqual(logOf(db), undefined);
});

test("a merged-away primary answers with the survivor and writes nothing", async () => {
  const claim = { productId: "loser", claimedAt: 1 };
  const db = fakeDb({
    products: { loser: { id: "loser", styleCodeNormalised: CODE, mergedInto: "winner" }, winner: { id: "winner" } },
    [STYLE_CODE_INDEX_PATH]: { [CODE]: claim },
  });
  const out = await resolve(db);
  assert.strictEqual(out.claim.productId, "winner");
  assert.deepStrictEqual(out.owners, ["winner"]);
  assert.strictEqual(out.claimOrphaned, false);
  assert.deepStrictEqual(claimOf(db), claim, "the stored claim is untouched");
  assert.strictEqual(logOf(db), undefined);
});

test("a merged-away primary the scan did not find is followed too", async () => {
  const db = fakeDb({
    products: { loser: { id: "loser", mergedInto: "winner" }, winner: { id: "winner" } },
    [STYLE_CODE_INDEX_PATH]: { [CODE]: { productId: "loser", claimedAt: 1 } },
  });
  assert.strictEqual((await resolve(db)).claim.productId, "winner");
});

test("a dead primary with live siblings keeps the claim and answers with them", async () => {
  const claim = { ...DEAD, siblings: { s1: { addedAt: 1 }, s2: { addedAt: 2 } } };
  const db = fakeDb({
    products: { s1: { id: "s1", styleCodeNormalised: CODE }, s2: { id: "s2", styleCodeNormalised: CODE } },
    [STYLE_CODE_INDEX_PATH]: { [CODE]: claim },
  });
  const out = await resolve(db);
  assert.strictEqual(out.claim.productId, "s1");
  assert.deepStrictEqual(out.claim.siblingIds, ["s2"]);
  assert.deepStrictEqual(out.owners, ["s1", "s2"]);
  assert.strictEqual(out.claimOrphaned, false);
  assert.deepStrictEqual(claimOf(db), claim);
  assert.strictEqual(out.duplicate, false, "registered siblings are still not a collision");
});

test("a failed release leaves the claim and reports claimOrphaned for a retry", async () => {
  const db = fakeDb({ products: {}, [STYLE_CODE_INDEX_PATH]: { [CODE]: DEAD } });
  db.fail.set.add(STYLE_CODE_ORPHANS_PATH);
  const out = await resolve(db, { found: true });
  assert.strictEqual(out.claimOrphaned, true);
  assert.strictEqual(out.found, true, "the answer already paid for is kept");
  assert.deepStrictEqual(claimOf(db), DEAD);
});

test("a claim that changed during the release is reported for a retry", async () => {
  const db = fakeDb({ products: {}, [STYLE_CODE_INDEX_PATH]: { [CODE]: DEAD } });
  db.onTxnServerPass = async () => { db.data[STYLE_CODE_INDEX_PATH][CODE] = { ...DEAD, productId: "pNEW" }; };
  const out = await resolve(db);
  assert.strictEqual(out.claimOrphaned, true);
  assert.strictEqual(claimOf(db).productId, "pNEW");
});

test("an unreadable owner degrades without releasing anything", async () => {
  const db = fakeDb({ products: {}, [STYLE_CODE_INDEX_PATH]: { [CODE]: DEAD } });
  db.fail.read.add("products/pGONE");
  const out = await resolve(db);
  assert.strictEqual(out.claimOrphaned, false);
  assert.strictEqual(out.claim.productId, "pGONE");
  assert.deepStrictEqual(claimOf(db), DEAD);
  assert.strictEqual(logOf(db), undefined);
});

test("a dangling redirect keeps the claim and reports it", async () => {
  const claim = { productId: "a", claimedAt: 1 };
  const db = fakeDb({ products: { a: { id: "a", mergedInto: "gone" } }, [STYLE_CODE_INDEX_PATH]: { [CODE]: claim } });
  const out = await resolve(db);
  assert.strictEqual(out.claimOrphaned, true);
  assert.deepStrictEqual(claimOf(db), claim);
});

test("an unclaimed code never touches the orphan log", async () => {
  const db = fakeDb({ products: {} });
  const out = await resolve(db);
  assert.strictEqual(out.claim, null);
  assert.strictEqual(db.data[STYLE_CODE_ORPHANS_PATH], undefined);
});

// ── sweepOrphanClaims ────────────────────────────────────────────────────────

const population = () => fakeDb({
  products: {
    live: { id: "live" }, loser: { mergedInto: "live" }, off: { id: "off", deactivated: { at: 1 } },
    s1: { id: "s1" }, half: { mergedInto: "gone" },
  },
  [STYLE_CODE_INDEX_PATH]: {
    LIVE1: { productId: "live", claimedAt: 1 },
    OFF1: { productId: "off", claimedAt: 1 },
    MERGED1: { productId: "loser", claimedAt: 1 },
    DEAD1: { productId: "gone1", claimedAt: 1 },
    DEAD2: { productId: "gone2", claimedAt: 2, claimedBy: "u" },
    SIB1: { productId: "gone3", claimedAt: 3, siblings: { s1: { addedAt: 1 } } },
    HALF1: { productId: "half", claimedAt: 4 },
    BAD1: { claimedAt: 5 },
  },
});
const CODES = ["LIVE1", "OFF1", "MERGED1", "DEAD1", "DEAD2", "SIB1", "HALF1", "BAD1"];
const sweep = (db, extra = {}) => sweepOrphanClaims(db, { codes: CODES, releasedBy: "script:test", nowMs: NOW, ...extra });

test("the sweep is read-only by default", async () => {
  const db = population();
  const before = JSON.stringify(db.data);
  const r = await sweep(db);
  assert.strictEqual(JSON.stringify(db.data), before);
  assert.strictEqual(r.applied, false);
  assert.deepStrictEqual(r.dead.map((x) => x.code).sort(), ["DEAD1", "DEAD2"]);
  assert.deepStrictEqual(r.released, []);
});

test("only a literal true applies", async () => {
  const db = population();
  await sweep(db, { apply: "true" });
  assert.ok(claimOf(db, "DEAD1"));
});

test("apply releases only the dead and logs each one", async () => {
  const db = population();
  const r = await sweep(db, { apply: true });
  assert.deepStrictEqual(r.released.map((x) => x.code).sort(), ["DEAD1", "DEAD2"]);
  assert.strictEqual(claimOf(db, "DEAD1"), undefined);
  assert.strictEqual(claimOf(db, "DEAD2"), undefined);
  assert.strictEqual(logOf(db, "DEAD2").productId, "gone2");
  assert.strictEqual(logOf(db, "DEAD2").releasedBy, "script:test");
  assert.strictEqual(logOf(db, "DEAD2").source, "sweep");
  for (const kept of ["LIVE1", "OFF1", "MERGED1", "SIB1", "HALF1", "BAD1"]) {
    assert.ok(claimOf(db, kept), `${kept} must survive`);
    assert.strictEqual(logOf(db, kept), undefined);
  }
  assert.strictEqual(r.live, 2);
  assert.deepStrictEqual(r.redirected.map((x) => x.owners), [["live"]]);
  assert.deepStrictEqual(r.siblingsOnly.map((x) => x.code), ["SIB1"]);
  assert.deepStrictEqual(r.unresolved.map((x) => x.reason), ["merge-dangling"]);
  assert.deepStrictEqual(r.malformed, ["BAD1"]);
});

test("the sweep touches nothing outside the index and the log", async () => {
  const db = population();
  const before = JSON.parse(JSON.stringify(db.data));
  await sweep(db, { apply: true });
  assert.deepStrictEqual(db.data.products, before.products);
  assert.deepStrictEqual(Object.keys(db.data).sort(), [STYLE_CODE_INDEX_PATH, STYLE_CODE_ORPHANS_PATH, "products"].sort());
});

test("re-running the sweep finds nothing new", async () => {
  const db = population();
  await sweep(db, { apply: true });
  const r = await sweep(db, { apply: true, codes: CODES.filter((c) => !c.startsWith("DEAD")) });
  assert.deepStrictEqual(r.released, []);
});

test("one failing claim is recorded and the walk continues", async () => {
  const db = population();
  db.fail.read.add("products/gone1");
  const r = await sweep(db, { apply: true });
  assert.deepStrictEqual(r.failed.map((x) => x.code), ["DEAD1"]);
  assert.ok(claimOf(db, "DEAD1"));
  assert.strictEqual(claimOf(db, "DEAD2"), undefined);
});

test("a claim that changes mid-sweep is reported as changed, not released", async () => {
  const db = fakeDb({ products: {}, [STYLE_CODE_INDEX_PATH]: { DEAD1: { productId: "gone1", claimedAt: 1 } } });
  db.onTxnServerPass = async () => { db.data[STYLE_CODE_INDEX_PATH].DEAD1.productId = "pNEW"; };
  const r = await sweepOrphanClaims(db, { codes: ["DEAD1"], apply: true, releasedBy: "s", nowMs: NOW });
  assert.deepStrictEqual(r.changed.map((x) => x.code), ["DEAD1"]);
  assert.deepStrictEqual(r.released, []);
});
