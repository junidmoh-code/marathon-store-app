// ── ID-map tests: mapping shape + idempotency planner ────────────────────────
// Pure-function tests (no RTDB, no emulator): buildMapping's key encoding and
// gid validation, and planIdMapWrite's create / noop / merge / refuse matrix —
// the idempotency contract the live writer rides on.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { buildMapping, planIdMapWrite, claimKeyFor, planClaim, claimShopifyProduct, releaseClaim, ensureClaimIndex, isProductRecordKey } from "./idMap.mjs";

const gid = {
  product: (n) => `gid://shopify/Product/${n}`,
  variant: (n) => `gid://shopify/ProductVariant/${n}`,
  item: (n) => `gid://shopify/InventoryItem/${n}`,
};

const rows = [
  { size: "5.5", variantId: gid.variant(1), inventoryItemId: gid.item(11) },
  { size: "6", variantId: gid.variant(2), inventoryItemId: gid.item(12) },
  { size: "M", variantId: gid.variant(3), inventoryItemId: gid.item(13) },
  { size: "_", variantId: gid.variant(4), inventoryItemId: gid.item(14) },
];

describe("buildMapping", () => {
  it("keys variants by the app's RTDB size encoding (5.5 → 5_5, sentinel intact)", () => {
    const m = buildMapping(gid.product(9), rows);
    expect(Object.keys(m.variants).sort()).toEqual(["5_5", "6", "M", "_"].sort());
    expect(m.variants["5_5"]).toEqual({
      shopifyVariantId: gid.variant(1),
      shopifyInventoryItemId: gid.item(11),
    });
    expect(m.shopifyProductId).toBe(gid.product(9));
  });

  it("rejects non-gid IDs and empty rows", () => {
    expect(() => buildMapping("123456", rows)).toThrow(/Product gid/);
    expect(() =>
      buildMapping(gid.product(9), [{ size: "6", variantId: "42", inventoryItemId: gid.item(1) }])
    ).toThrow(/ProductVariant gid/);
    expect(() => buildMapping(gid.product(9), [])).toThrow(/no variants/);
  });

  it("rejects two rows that collapse onto one size key", () => {
    expect(() =>
      buildMapping(gid.product(9), [
        { size: "5.5", variantId: gid.variant(1), inventoryItemId: gid.item(1) },
        { size: "5_5", variantId: gid.variant(2), inventoryItemId: gid.item(2) },
      ])
    ).toThrow(/duplicate size key/);
  });
});

describe("planIdMapWrite — idempotency contract", () => {
  const mapping = buildMapping(gid.product(9), rows);

  it("no existing node → create", () => {
    expect(planIdMapWrite(null, mapping)).toEqual({ action: "create" });
  });

  it("identical existing node → noop (re-run safe)", () => {
    const existing = JSON.parse(JSON.stringify(mapping));
    expect(planIdMapWrite(existing, mapping)).toEqual({ action: "noop" });
  });

  it("same product, strictly new size keys → merge of ONLY the new keys", () => {
    const existing = {
      shopifyProductId: gid.product(9),
      variants: { "5_5": mapping.variants["5_5"], 6: mapping.variants["6"] },
    };
    expect(planIdMapWrite(existing, mapping)).toEqual({ action: "merge", newKeys: ["M", "_"] });
  });

  it("pending node (product id only, no variants yet) → merge of every key", () => {
    // round-trip --commit writes {shopifyProductId, variants:{}} immediately
    // after creation; the full mapping after read-back must merge cleanly.
    const existing = { shopifyProductId: gid.product(9) };
    const plan = planIdMapWrite(existing, mapping);
    expect(plan.action).toBe("merge");
    expect(plan.newKeys.sort()).toEqual(["5_5", "6", "M", "_"].sort());
  });

  it("different shopifyProductId → refuses (duplicate-product guard)", () => {
    const existing = { ...JSON.parse(JSON.stringify(mapping)), shopifyProductId: gid.product(8) };
    expect(() => planIdMapWrite(existing, mapping)).toThrow(/refusing to overwrite/);
  });

  it("same size key with different variant IDs → refuses", () => {
    const existing = JSON.parse(JSON.stringify(mapping));
    existing.variants["6"].shopifyVariantId = gid.variant(999);
    expect(() => planIdMapWrite(existing, mapping)).toThrow(/refusing to overwrite variant 6/);
  });
});

// ── The claim index ──────────────────────────────────────────────────────────
// The uniqueness guarantee moved off a whole-node transaction and onto one
// child of /shopify_sync/_claims. These are the two pure pieces that decide it.
describe("claimKeyFor", () => {
  it("keys on the numeric id, because a gid cannot be an RTDB path segment", () => {
    expect(claimKeyFor(gid.product(9339656536213))).toBe("9339656536213");
  });

  it("refuses anything that is not a Product gid rather than inventing a key", () => {
    expect(() => claimKeyFor(gid.variant(1))).toThrow(/Product gid/);
    expect(() => claimKeyFor("9339656536213")).toThrow(/Product gid/);
    expect(() => claimKeyFor(null)).toThrow(/Product gid/);
    expect(() => claimKeyFor("gid://shopify/Product/12ab")).toThrow(/Product gid/);
  });
});

describe("planClaim", () => {
  it("claims a gid nobody holds", () => {
    expect(planClaim(null, "p1")).toEqual({ action: "claim" });
  });

  it("treats a claim this record already holds as held, not as a conflict", () => {
    expect(planClaim("p1", "p1")).toEqual({ action: "held" });
  });

  it("REFUSES a gid another record holds — the guarantee the root transaction existed for", () => {
    const plan = planClaim("p2", "p1");
    expect(plan.action).toBe("refuse");
    expect(plan.refusal).toMatch(/already claimed by record p2/);
  });
});

// ── The claim, exercised for REAL against a fake RTDB ────────────────────────
// The pure planClaim matrix above says what SHOULD happen; these say that
// claimShopifyProduct does it, through the transaction semantics that actually
// bite. The one that bites hardest: an RTDB transaction callback's first
// invocation is not guaranteed the server value — it can fire against a stale
// local cache — and returning `undefined` from it aborts ONE-SHOT, with no
// server round trip and no retry. Taking that abort as proof of a conflict
// would fail a publish over an owner the server does not have.
//
// The fake models exactly that: `cached` is what the first callback invocation
// sees, `server` is the truth. A real RTDB transaction would re-run the
// callback against the server value on a WRITE conflict — but an abort is not
// a write, so it never gets that far. That asymmetry is the bug.
function fakeDb({ cached, server, mine = null, pointerCached }) {
  const state = { server, mine, sets: [], callbackValues: [], transactions: 0, claimReads: 0 };
  let firstTransaction = true;
  let firstPointer = true;
  const node = (path) => ({
    async get() {
      if (path === "shopify_sync/_claims/_builtAt") return { val: () => 1 };
      if (path.endsWith("/shopifyProductId")) return { val: () => state.mine };
      if (path.startsWith("shopify_sync/_claims/")) { state.claimReads += 1; return { val: () => state.server }; }
      throw new Error(`unexpected get: ${path}`);
    },
    async set(v) { state.sets.push([path, v]); state.mine = v; },
    async transaction(fn) {
      // The record's own gid pointer is a DIFFERENT node from the claim, with
      // no stale-cache game to play — it is written once, at the end, under a
      // transaction so a gid written in between is not overwritten.
      if (path.endsWith("/shopifyProductId")) {
        // `pointerCached` models a stale FIRST view of the pointer node, the
        // same way `cached` does for the claim. An abort is one-shot, so that
        // first view is the only one the callback ever sees.
        const seen = firstPointer && pointerCached !== undefined ? pointerCached : state.mine;
        firstPointer = false;
        const out = fn(seen);
        if (out === undefined) return { committed: false, snapshot: { val: () => seen } };
        state.sets.push([path, out]);
        state.mine = out;
        return { committed: true, snapshot: { val: () => out } };
      }
      state.transactions += 1;
      // First invocation sees the (possibly stale) cache; later ones see truth.
      const seen = firstTransaction ? cached : state.server;
      firstTransaction = false;
      state.callbackValues.push(seen);
      const out = fn(seen);
      if (out === undefined) return { committed: false, snapshot: { val: () => seen } };
      state.server = out;
      return { committed: true, snapshot: { val: () => out } };
    },
  });
  return { ref: (p) => node(p), state };
}

describe("claimShopifyProduct does not mistake a one-shot abort for a conflict", () => {
  const GID = gid.product(9339656536213);

  it("a STALE cached owner does not refuse a claim the server has free", async () => {
    // The cache still holds a claim that was released; the server has null.
    const db = fakeDb({ cached: "p2", server: null });
    await expect(claimShopifyProduct(db, "p1", GID)).resolves.toBeUndefined();
    // It re-read the claim from the server, then retried; the second pass claimed it.
    expect(db.state.claimReads).toBe(1);
    expect(db.state.transactions).toBe(2);
    expect(db.state.server).toBe("p1");
    expect(db.state.sets).toEqual([["shopify_sync/p1/shopifyProductId", GID]]);
  });

  it("a REAL conflict still throws, and does not spin", async () => {
    // Cache and server agree: another record holds it.
    const db = fakeDb({ cached: "p2", server: "p2" });
    await expect(claimShopifyProduct(db, "p1", GID))
      .rejects.toThrow(/already claimed by record p2/);
    // It DID confirm against the server rather than trusting the abort —
    // and, the server agreeing, it threw without re-running the transaction.
    // That is the bound: one confirming read, no second write attempt, no spin.
    expect(db.state.claimReads).toBe(1);
    expect(db.state.transactions).toBe(1);
    expect(db.state.sets).toEqual([]);
  });

  it("a claim this record already holds is held, not refused, and writes nothing new", async () => {
    const db = fakeDb({ cached: "p1", server: "p1", mine: GID });
    await expect(claimShopifyProduct(db, "p1", GID)).resolves.toBeUndefined();
    expect(db.state.transactions).toBe(1);
    // The pointer already exists — writing it again is a needless write.
    expect(db.state.sets).toEqual([]);
  });

  it("a gid written into our pointer AFTER the pre-check does not get overwritten", async () => {
    // mineGid is read BEFORE the claim is taken. A plain set() at the end would
    // clobber whatever landed in between — reintroducing at the bottom of this
    // function the exact double-mapping the read at the top refuses.
    const db = fakeDb({ cached: null, server: null });
    let preCheckDone = false;
    const inner = db.ref;
    db.ref = (path) => {
      if (path.endsWith("/shopifyProductId")) {
        // First touch is the pre-check read (must still see null); the race
        // lands between it and the write.
        if (preCheckDone) db.state.mine = gid.product(999);
        preCheckDone = true;
      }
      return inner(path);
    };
    await expect(claimShopifyProduct(db, "p1", GID))
      .rejects.toThrow(/record already maps to gid:\/\/shopify\/Product\/999/);
    expect(db.state.mine).toBe(gid.product(999));   // the other writer's value survives
    // AND the claim taken moments earlier is handed back. Holding it would
    // block this gid for every other record permanently: nothing else releases
    // a claim except the deleted-product path, and that only runs for a record
    // whose own map still points at the gid — which this one no longer does.
    expect(db.state.server).toBe(null);
  });

  it("a record that already maps a DIFFERENT gid is refused before it takes a claim", async () => {
    const db = fakeDb({ cached: null, server: null, mine: gid.product(111) });
    await expect(claimShopifyProduct(db, "p1", GID))
      .rejects.toThrow(/record already maps to/);
    // Refused BEFORE the transaction — it must not take a claim it would then
    // have to give back.
    expect(db.state.transactions).toBe(0);
  });
});

// ── releaseClaim frees OUR slot, never someone else's ────────────────────────
// It is a cleanup path, and a cleanup path that can free a claim a live product
// holds would undo the single guarantee the claim index exists to give.
// A FAITHFUL transaction fake. The version this replaced modelled a local cache
// that warmed after one call, so the second transaction was guaranteed the
// server value — which asserted by construction the property the real SDK does
// NOT provide, and let a broken releaseClaim pass. What @firebase/database does:
// the callback runs against the local cache; `undefined` aborts there with no
// server contact and no second invocation; a `get()` leaves nothing cached; only
// a WRITE reaches the server, and only then is the callback re-invoked with the
// true value. So `cached` is what the cache shows on EVERY call — it never warms.
function claimsDb(initial, { cached } = {}) {
  const claims = { ...initial };
  const state = { claims, gets: 0, aborts: 0, invocations: 0 };
  return {
    claims,
    state,
    ref: (path) => {
      const key = path.replace("shopify_sync/_claims/", "");
      const server = () => (key in claims ? claims[key] : null);
      return {
        async get() { state.gets += 1; return { val: server }; },
        async transaction(fn) {
          const seen = cached !== undefined ? cached : server();
          state.invocations += 1;
          let out = fn(seen);
          if (out === undefined) {
            state.aborts += 1;
            return { committed: false, snapshot: { val: () => seen } };
          }
          // It wanted to write, so the server is reached. If what the callback
          // saw was not what the server holds, the SDK re-invokes with the
          // truth before committing.
          if (seen !== server()) {
            state.invocations += 1;
            out = fn(server());
            if (out === undefined) {
              state.aborts += 1;
              return { committed: false, snapshot: { val: () => server() } };
            }
          }
          if (out === null) delete claims[key];
          else claims[key] = out;
          return { committed: true, snapshot: { val: () => (key in claims ? claims[key] : null) } };
        },
      };
    },
  };
}

describe("releaseClaim", () => {
  const GID = gid.product(9339656536213);
  const KEY = "9339656536213";

  it("releases a claim this record holds", async () => {
    const db = claimsDb({ [KEY]: "p1" });
    await expect(releaseClaim(db, "p1", GID)).resolves.toBe("released");
    expect(KEY in db.claims).toBe(false);
  });

  it("REFUSES to release a claim another record holds", async () => {
    const db = claimsDb({ [KEY]: "p2" });
    await expect(releaseClaim(db, "p1", GID)).resolves.toBe("held-by-other");
    // Untouched — freeing it would let a third record double-claim a product
    // p2 is legitimately live on.
    expect(db.claims[KEY]).toBe("p2");
  });

  it("is a no-op on a claim that is already gone", async () => {
    const db = claimsDb({});
    await expect(releaseClaim(db, "p1", GID)).resolves.toBe("absent");
    expect(db.claims).toEqual({});
  });
});

// ── The one-time backfill fills gaps and never overwrites ────────────────────
// The paged read it derives from is not a snapshot. A claim committed while it
// was in flight is absent from the derived map, and a bulk update() would
// revert it — silently downgrading the guarantee the old root transaction gave
// unconditionally.
describe("ensureClaimIndex", () => {
  function backfillDb({ syncNodes, claims = {} }) {
    const state = { claims: { ...claims }, sentinelWrittenAfter: null, writes: [] };
    const keys = Object.keys(syncNodes).sort();
    return {
      state,
      ref(path) {
        if (path === "shopify_sync") {
          const page = (from, limit) => {
            const slice = keys.filter((k) => (from ? k >= from : true)).slice(0, limit);
            return {
              val: () => Object.fromEntries(slice.map((k) => [k, syncNodes[k]])),
              forEach: (cb) => { for (const k of slice) cb({ key: k }); },
              child: (k) => ({ val: () => syncNodes[k] }),
            };
          };
          const q = { _from: null, _limit: 500 };
          const api = {
            orderByKey: () => api,
            limitToFirst: (n) => { q._limit = n; return api; },
            startAt: (k) => { q._from = k; return api; },
            once: async () => page(q._from, q._limit),
          };
          return api;
        }
        if (path === "shopify_sync/_claims/_builtAt") {
          return {
            get: async () => ({ val: () => state.claims._builtAt ?? null }),
            set: async (v) => { state.claims._builtAt = v; state.sentinelWrittenAfter = state.writes.length; },
          };
        }
        const key = path.replace("shopify_sync/_claims/", "");
        return {
          async transaction(fn) {
            const out = fn(key in state.claims ? state.claims[key] : null);
            state.writes.push(key);
            if (out !== undefined) state.claims[key] = out;
            return { committed: out !== undefined, snapshot: { val: () => out } };
          },
        };
      },
    };
  }

  it("does NOT overwrite a claim that committed while the paged read was in flight", async () => {
    // The page says gid 111 belongs to p1. Reality has moved on: p3 claimed it.
    const db = backfillDb({
      syncNodes: { p1: { shopifyProductId: gid.product(111) }, p2: { shopifyProductId: gid.product(222) } },
      claims: { 111: "p3" },
    });
    const res = await ensureClaimIndex(db);
    expect(res.built).toBe(true);
    // p3 keeps it. A bulk update() would have written "p1" here and locked p3
    // out of a product it legitimately holds.
    expect(db.state.claims["111"]).toBe("p3");
    // The genuinely missing one is filled.
    expect(db.state.claims["222"]).toBe("p2");
    expect(res.filled).toBe(1);
    expect(res.kept).toBe(1);
  });

  it("writes the sentinel LAST, so a crash midway cannot mark a part-built index done", async () => {
    const db = backfillDb({
      syncNodes: { p1: { shopifyProductId: gid.product(111) }, p2: { shopifyProductId: gid.product(222) } },
    });
    await ensureClaimIndex(db);
    expect(db.state.sentinelWrittenAfter).toBe(2);   // both entries already in
  });

  it("ONE malformed gid does not take the whole backfill down with it", async () => {
    // The filter used to be startsWith("gid://shopify/Product/"), which is
    // looser than claimKeyFor's `\d+$`. So a single bad value made claimKeyFor
    // throw out of the loop — and because the sentinel is written LAST, that
    // backfill would never complete: retried every tick for ever, with every
    // claim behind it failing. One bad record must not be able to do that.
    const db = backfillDb({
      syncNodes: {
        p1: { shopifyProductId: gid.product(111) },
        bad1: { shopifyProductId: "gid://shopify/Product/12ab" },
        bad2: { shopifyProductId: "gid://shopify/Product/333 " },
        bad3: { shopifyProductId: gid.variant(444) },
        p2: { shopifyProductId: gid.product(222) },
      },
    });
    const res = await ensureClaimIndex(db);
    expect(res.built).toBe(true);
    // The good ones are indexed...
    expect(db.state.claims["111"]).toBe("p1");
    expect(db.state.claims["222"]).toBe("p2");
    expect(res.entries).toBe(2);
    // ...and the sentinel is set, so this never runs again.
    expect(db.state.claims._builtAt).toBeTruthy();
  });

  it("skips bookkeeping siblings and records with no Shopify mapping", async () => {
    const db = backfillDb({
      syncNodes: {
        _collections: { anything: 1 },
        _reconcile: { watermark: 1 },
        p1: { shopifyProductId: gid.product(111) },
        p2: {},
        p3: { shopifyProductId: "not-a-gid" },
      },
    });
    const res = await ensureClaimIndex(db);
    expect(res.entries).toBe(1);
    expect(Object.keys(db.state.claims).filter((k) => k !== "_builtAt")).toEqual(["111"]);
  });

  it("does nothing at all once the sentinel is set", async () => {
    const db = backfillDb({ syncNodes: { p1: { shopifyProductId: gid.product(111) } }, claims: { _builtAt: 123 } });
    const res = await ensureClaimIndex(db);
    expect(res).toEqual({ built: false });
    expect(db.state.writes).toEqual([]);
  });

  // ── A double mapping in the EXISTING data ────────────────────────────────
  // Two records mapping one gid is the state this index exists to prevent —
  // and it is possible in what the backfill reads, because the index did not
  // exist when that data was written. `index[key] = pid` alone is last-one-wins
  // by iteration order: the loser keeps a legitimate mapping the index does not
  // know about and is refused this gid for ever after, with the sentinel
  // guaranteeing nothing ever looks again.
  it("names both records on a double mapping instead of silently dropping one", async () => {
    const warned = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m) => warned.push(String(m)));
    try {
      const GID = gid.product(9339656536213);
      const db = backfillDb({ syncNodes: { p9: { shopifyProductId: GID }, p2: { shopifyProductId: GID } } });
      await ensureClaimIndex(db);
      // Lowest pid wins, so a re-run reaches the same answer rather than
      // depending on which page the read happened to return first.
      expect(db.state.claims["9339656536213"]).toBe("p2");
      const line = warned.find((m) => m.includes("BOTH map"));
      expect(line, "the clash must be reported").toBeTruthy();
      expect(line).toContain("p9");
      expect(line).toContain("p2");
    } finally { spy.mockRestore(); }
  });
});

// ── The bookkeeping siblings are excluded by PREFIX, not by name ─────────────
// /shopify_sync holds product records beside this module's own siblings. There
// used to be exactly one (`_collections`) and callers hardcoded a name compare;
// adding `_reconcile` and `_claims` would have walked straight through those
// filters and been processed as products.
describe("isProductRecordKey", () => {
  it("rejects every bookkeeping sibling, present and future", () => {
    for (const k of ["_collections", "_reconcile", "_claims", "_builtAt", "_anythingLater"]) {
      expect(isProductRecordKey(k)).toBe(false);
    }
  });

  it("accepts ordinary product ids", () => {
    for (const k of ["-NabcDEF123", "p1", "9339656536213"]) {
      expect(isProductRecordKey(k)).toBe(true);
    }
  });

  it("is not fooled by a non-string key", () => {
    expect(isProductRecordKey(undefined)).toBe(false);
    expect(isProductRecordKey(null)).toBe(false);
  });
});

// ── A retried transaction reports the LAST invocation, not the first ─────────
// An RTDB transaction callback may run several times — once against the local
// cache, again against the server value on a conflict. Only the final one
// describes what happened, so any verdict the callback records must be cleared
// at the top of every invocation or an earlier pass's answer survives into it.
describe("releaseClaim reports the final invocation's verdict", () => {
  const GID = gid.product(9339656536213);
  const KEY = "9339656536213";

  it("a first pass against a stale empty cache does not report 'absent' for a real release", async () => {
    let first = true;
    const claims = { [KEY]: "p1" };
    const db = {
      ref: () => ({
        async transaction(fn) {
          // Invocation 1: stale cache says the key is empty.
          fn(first ? null : claims[KEY]);
          first = false;
          // Invocation 2: the server value — this is the one that counts.
          const out = fn(claims[KEY]);
          if (out === null) delete claims[KEY];
          return { committed: true, snapshot: { val: () => out } };
        },
      }),
    };
    await expect(releaseClaim(db, "p1", GID)).resolves.toBe("released");
    expect(KEY in claims).toBe(false);
  });
});

// ── A decline is confirmed against the server, like every other decline here ─
// Making releaseClaim abort (rather than commit `cur`) removed a needless write
// and re-introduced the one-shot-abort hazard: the abort never reaches the
// server, so a stale cache could report "absent" for a claim the server holds
// for us — and the claim would silently not be released, which is the exact
// leak this function exists to prevent.
// ── releaseClaim never aborts, because an abort here strands a claim ─────────
// A stranded claim blocks that Shopify product for EVERY record, permanently,
// with only a hand repair. The version that aborted on a decline and then
// "confirmed with a fresh read" could not work: on a fresh process the cache is
// empty, the callback aborted with "absent", the read found the claim IS ours,
// the retry saw an empty cache again, and it returned "absent" anyway — the
// claim silently never released, which is the leak this function exists to
// prevent. These drive the cold cache that never warms.
describe("releaseClaim never abandons a claim to a cold cache", () => {
  const GID = gid.product(9339656536213);
  const KEY = "9339656536213";

  it("a cache that is EMPTY and stays empty still releases the claim", async () => {
    const db = claimsDb({ [KEY]: "p1" }, { cached: null });
    await expect(releaseClaim(db, "p1", GID)).resolves.toBe("released");
    expect(KEY in db.claims).toBe(false);
    expect(db.state.aborts).toBe(0);        // it reached the server
    expect(db.state.invocations).toBe(2);   // cold view, then the true value
  });

  it("a cache naming another owner does not abandon it either", async () => {
    const db = claimsDb({ [KEY]: "p1" }, { cached: "p2" });
    await expect(releaseClaim(db, "p1", GID)).resolves.toBe("released");
    expect(KEY in db.claims).toBe(false);
    expect(db.state.aborts).toBe(0);
  });

  it("a genuine other-owner is declined from the COMMITTED SNAPSHOT, and left alone", async () => {
    const db = claimsDb({ [KEY]: "p2" }, { cached: "p2" });
    await expect(releaseClaim(db, "p1", GID)).resolves.toBe("held-by-other");
    expect(db.claims[KEY]).toBe("p2");
  });

  it("a genuinely absent claim says so without aborting", async () => {
    const db = claimsDb({}, { cached: null });
    await expect(releaseClaim(db, "p1", GID)).resolves.toBe("absent");
    expect(db.state.aborts).toBe(0);
  });

  // The one outcome that means OUR claim may still be standing. It must be
  // distinguishable, because it is the only one the caller has to log.
  it("says 'contended' — never 'released' — when the write does not land", async () => {
    const db = claimsDb({ [KEY]: "p1" });
    db.ref = () => ({ async transaction() { return { committed: false, snapshot: { val: () => "p1" } }; } });
    await expect(releaseClaim(db, "p1", GID)).resolves.toBe("contended");
    expect(db.claims[KEY]).toBe("p1");
  });
});

// ── The pointer clash is confirmed too — the third place with this hazard ────
// This is the most expensive false alarm of the three. An unconfirmed clash
// does not merely refuse: it GIVES THE CLAIM BACK first. So a phantom gid in
// the local cache would hand away a claim this record legitimately holds and
// then refuse the publish citing a mapping the server does not have.
describe("claimShopifyProduct confirms a pointer clash before acting on it", () => {
  const GID = gid.product(9339656536213);

  it("a stale cached gid does not cost the record its claim", async () => {
    // Cache says the pointer holds 999; the server says it is empty.
    const db = fakeDb({ cached: null, server: null, mine: null, pointerCached: gid.product(999) });
    await expect(claimShopifyProduct(db, "p1", GID)).resolves.toBeUndefined();
    expect(db.state.mine).toBe(GID);        // the pointer really was written
    expect(db.state.server).toBe("p1");     // and the claim was NOT given back
  });

  it("a real clash still refuses, and hands the claim back", async () => {
    // The pre-check MUST see an empty pointer, or this never reaches the
    // pointer transaction at all — it throws at the top of the function and
    // the test passes for the wrong reason, which is exactly what an earlier
    // version of it did. So the race is staged after the pre-check read, and
    // both the cache and the server then agree on the conflicting gid.
    const db = fakeDb({ cached: null, server: null, mine: null, pointerCached: gid.product(999) });
    let preCheckDone = false;
    const inner = db.ref;
    db.ref = (path) => {
      if (path.endsWith("/shopifyProductId")) {
        if (preCheckDone) db.state.mine = gid.product(999);   // the server, too
        preCheckDone = true;
      }
      return inner(path);
    };
    await expect(claimShopifyProduct(db, "p1", GID))
      .rejects.toThrow(/record already maps to gid:\/\/shopify\/Product\/999/);
    // It got past the pre-check and really did take the claim — then gave it
    // back. A null here with the claim never taken would prove nothing.
    expect(db.state.transactions).toBeGreaterThan(0);
    expect(db.state.server).toBe(null);
  });

  // ── A stale claim says so, instead of looking impossible ─────────────────
  // The claim and the pointer are two commits. A run killed between them leaves
  // a claim whose owner maps nothing — harmless until someone adopts that draft
  // by hand months later and is refused citing a record that does not hold it.
  it("a refusal whose owner does not map the gid names itself as stale and repairable", async () => {
    const GID = gid.product(9339656536213);
    const db = fakeDb({ cached: "p1", server: "p1", mine: null });
    // p1 holds the claim but maps nothing — the crashed-run state.
    const inner = db.ref;
    db.ref = (path) => (path === "shopify_sync/p1/shopifyProductId"
      ? { async get() { return { val: () => null }; } }
      : inner(path));
    await expect(claimShopifyProduct(db, "p2", GID)).rejects.toThrow(/this claim is stale/);
    await expect(claimShopifyProduct(db, "p2", GID)).rejects.toThrow(/shopify_sync\/_claims\/9339656536213/);
  });

  it("a GENUINE conflict is not softened into a stale-claim note", async () => {
    const GID = gid.product(9339656536213);
    const db = fakeDb({ cached: "p1", server: "p1", mine: null });
    const inner = db.ref;
    db.ref = (path) => (path === "shopify_sync/p1/shopifyProductId"
      ? { async get() { return { val: () => GID }; } }   // p1 really does map it
      : inner(path));
    const err = await claimShopifyProduct(db, "p2", GID).catch((e) => e);
    expect(String(err)).toMatch(/already claimed by/);
    expect(String(err)).not.toMatch(/stale/);
  });
});

// ── The class of bug, stated mechanically ───────────────────────────────────
// Four rounds of review found the same bug four times in this file, and the
// rule that was written down after the third one — "confirm every abort with a
// fresh server read and retry once" — DOES NOT WORK. It cannot: there is no way
// to warm the cache the callback reads. `runTransaction` runs the callback
// synchronously against the local cache and, on `undefined`, unwatches and
// completes without ever contacting the server; `get()` removes its own
// registration, so it leaves nothing behind. Both verified in the installed
// @firebase/database. The retry saw exactly what the first attempt saw.
//
// THE RULE THAT DOES WORK, and it is checkable: AN ABORT MUST BE UNREACHABLE
// FROM `cur == null`. A fresh process — every tick, launchd spawns a new node —
// always presents `cur == null`, so any branch that aborts there is a branch
// that can never reach the server. Returning a value instead (even `cur`
// unchanged) forces the round trip and re-invokes the callback with the truth.
// ensureClaimIndex's backfill already obeyed this (`cur == null ? owner : cur`).
//
// Asserted BEHAVIOURALLY below, by driving each transaction-owning function
// through a cache that is empty and never warms, because a source-text guard
// cannot tell a correct verdict from a latched one — that is exactly how the
// broken version passed its own guard.
describe("no transaction in idMap.mjs aborts against a cold cache", () => {
  const SRC = readFileSync(new URL("./idMap.mjs", import.meta.url), "utf8");
  const GID = gid.product(9339656536213);
  const KEY = "9339656536213";

  it("the count of aborts is known, so a new one cannot arrive unnoticed", () => {
    const aborts = (SRC.match(/return undefined;/g) || []).length;
    // Two in claimShopifyProduct (the claim's refusal, and the pointer clash) and
    // one in writeIdMap's conflict — all three sit on branches a null `cur`
    // cannot reach, which the tests below prove. releaseClaim used to hold two
    // more and no longer aborts at all. A change to this number is the prompt to
    // check the new one against the rule, and only then update the count.
    expect(aborts).toBe(3);
  });

  it("releaseClaim reaches the server on a cold cache", async () => {
    const db = claimsDb({ [KEY]: "p1" }, { cached: null });
    await releaseClaim(db, "p1", GID);
    expect(db.state.aborts).toBe(0);
  });

  it("claimShopifyProduct takes the claim on a cold cache instead of refusing", async () => {
    // Cache empty everywhere; the server has the claim free. The claim and
    // pointer transactions both WRITE on their null branch, so both round-trip.
    const db = fakeDb({ cached: null, server: null, mine: null });
    await expect(claimShopifyProduct(db, "p1", GID)).resolves.toBeUndefined();
    expect(db.state.server).toBe("p1");
    expect(db.state.mine).toBe(GID);
  });

  it("writeIdMap creates on a cold cache instead of aborting", async () => {
    // planIdMapWrite(null, mapping) is a "create" — it does not throw, so the
    // null branch writes. This is what keeps writeIdMap's abort unreachable
    // from a cold cache, and it is the property the other two were missing.
    const plan = planIdMapWrite(null, { shopifyProductId: GID, variants: {} });
    expect(plan.action).toBe("create");
  });
});
