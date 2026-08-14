// ── Collections-on-Shopify tests ─────────────────────────────────────────────
// The pure halves: the 2026-07 condition-source input shape, the drift
// fingerprints that keep a re-run from rewriting an unchanged collection, and
// the description builder. ensureCollection itself is exercised against a fake
// graphql so the create/reconcile/noop branches are pinned without a shop.
import { describe, it, expect } from "vitest";
import {
  buildCollectionDescriptionHtml, buildConditionsSourceInput,
  desiredConditionsFingerprint, actualConditionsFingerprint, ensureCollection,
  planCollectionMembership, manualGidsFrom, readProductCollections, applyCollectionMembership,
  requireOnlineStorePublication, sweepIntent,
} from "./collections.mjs";
import { COLLECTION_BY_KEY } from "./collectionMap.mjs";

const NEW_IN = COLLECTION_BY_KEY.get("new-in");
const UNDER = COLLECTION_BY_KEY.get("under-r500");
const SALE = COLLECTION_BY_KEY.get("sale");
const SNEAKERS = COLLECTION_BY_KEY.get("sneakers");

describe("buildCollectionDescriptionHtml", () => {
  it("wraps one paragraph and escapes HTML", () => {
    expect(buildCollectionDescriptionHtml("Shoes & socks <b>")).toBe("<p>Shoes &amp; socks &lt;b&gt;</p>");
  });
  it("refuses an empty description", () => {
    expect(() => buildCollectionDescriptionHtml("   ")).toThrow(/may not be empty/);
  });
});

describe("buildConditionsSourceInput — the API 2026-07 shape", () => {
  it("product status, for New In", () => {
    expect(buildConditionsSourceInput(NEW_IN)).toEqual({
      title: "New In",
      targetType: "PRODUCTS",
      inclusion: {
        matchType: "ALL",
        conditions: [{ productStatus: { relation: "EQUALS", values: ["ACTIVE"], matchType: "ANY" } }],
      },
    });
  });

  it("variant price carries the shop currency, behind an ACTIVE gate", () => {
    expect(buildConditionsSourceInput(UNDER).inclusion.conditions).toEqual([
      { productStatus: { relation: "EQUALS", values: ["ACTIVE"], matchType: "ANY" } },
      { variantPrice: { relation: "LESS_THAN", value: { amount: "500.00", currencyCode: "ZAR" } } },
    ]);
  });

  it("IS_SET is a presence test and carries NO money value", () => {
    expect(buildConditionsSourceInput(SALE).inclusion.conditions).toEqual([
      { productStatus: { relation: "EQUALS", values: ["ACTIVE"], matchType: "ANY" } },
      { variantCompareAtPrice: { relation: "IS_SET" } },
    ]);
  });

  it("every cross-cutting collection gates on ACTIVE — the shop still holds 2,452 archived products", () => {
    for (const spec of [NEW_IN, SALE, UNDER]) {
      const statuses = spec.conditions.all.filter((c) => c.productStatus);
      expect({ key: spec.key, gated: statuses.length }).toEqual({ key: spec.key, gated: 1 });
      expect(statuses[0].productStatus).toEqual({ relation: "EQUALS", values: ["ACTIVE"] });
    }
  });

  it("refuses a smart collection with no conditions", () => {
    expect(() => buildConditionsSourceInput({ key: "x", title: "X", conditions: { all: [] } }))
      .toThrow(/carries no conditions/);
  });

  it("refuses a condition it does not understand rather than pushing a guess", () => {
    expect(() => buildConditionsSourceInput({ key: "x", title: "X", conditions: { all: [{ productWeight: {} }] } }))
      .toThrow(/unsupported condition/);
  });
});

describe("drift fingerprints", () => {
  it("a manual collection has an empty desired fingerprint", () => {
    expect(desiredConditionsFingerprint(SNEAKERS)).toBe("");
  });

  it("desired and actual agree for New In — a re-run must NOT rewrite it", () => {
    const actual = [{
      __typename: "CollectionConditionsSource",
      id: "gid://shopify/CollectionConditionsSource/1",
      inclusion: {
        matchType: "ALL",
        conditions: [{ __typename: "CollectionSourceInclusionConditionProductStatus", relation: "EQUALS", values: ["ACTIVE"] }],
      },
    }];
    expect(actualConditionsFingerprint(actual)).toBe(desiredConditionsFingerprint(NEW_IN));
  });

  it("money compares numerically — Shopify's \"500.0\" is our \"500.00\"", () => {
    const actual = [{
      __typename: "CollectionConditionsSource", id: "s1",
      inclusion: { matchType: "ALL", conditions: [
        { __typename: "CollectionSourceInclusionConditionProductStatus", relation: "EQUALS", values: ["ACTIVE"] },
        { __typename: "CollectionSourceInclusionConditionVariantPrice", relation: "LESS_THAN", value: { amount: "500.0" } },
      ] },
    }];
    expect(actualConditionsFingerprint(actual)).toBe(desiredConditionsFingerprint(UNDER));
  });

  it("condition ORDER is not drift — the fingerprint sorts", () => {
    const actual = [{
      __typename: "CollectionConditionsSource", id: "s1",
      inclusion: { matchType: "ALL", conditions: [
        { __typename: "CollectionSourceInclusionConditionVariantPrice", relation: "LESS_THAN", value: { amount: "500.00" } },
        { __typename: "CollectionSourceInclusionConditionProductStatus", relation: "EQUALS", values: ["ACTIVE"] },
      ] },
    }];
    expect(actualConditionsFingerprint(actual)).toBe(desiredConditionsFingerprint(UNDER));
  });

  it("a changed threshold IS drift", () => {
    const actual = [{
      __typename: "CollectionConditionsSource", id: "s1",
      inclusion: { matchType: "ALL", conditions: [
        { __typename: "CollectionSourceInclusionConditionProductStatus", relation: "EQUALS", values: ["ACTIVE"] },
        { __typename: "CollectionSourceInclusionConditionVariantPrice", relation: "LESS_THAN", value: { amount: "300" } },
      ] },
    }];
    expect(actualConditionsFingerprint(actual)).not.toBe(desiredConditionsFingerprint(UNDER));
  });

  it("a DROPPED condition is drift — an ACTIVE gate removed in the admin must be restored", () => {
    const actual = [{
      __typename: "CollectionConditionsSource", id: "s1",
      inclusion: { matchType: "ALL", conditions: [{ __typename: "CollectionSourceInclusionConditionVariantPrice", relation: "LESS_THAN", value: { amount: "500.00" } }] },
    }];
    expect(actualConditionsFingerprint(actual)).not.toBe(desiredConditionsFingerprint(UNDER));
  });

  it("a manual collection that has grown a RULE reads as drift", () => {
    const actual = [{
      __typename: "CollectionConditionsSource", id: "s1",
      inclusion: { matchType: "ALL", conditions: [{ __typename: "CollectionSourceInclusionConditionProductType", relation: "EQUALS", values: ["Boots"] }] },
    }];
    expect(actualConditionsFingerprint(actual)).not.toBe(desiredConditionsFingerprint(SNEAKERS));
  });

  it("no sources at all is the empty fingerprint, matching a manual collection", () => {
    expect(actualConditionsFingerprint([])).toBe(desiredConditionsFingerprint(SNEAKERS));
    expect(actualConditionsFingerprint(undefined)).toBe("");
  });

  it("more than one RULE-bearing source is never mistaken for agreement", () => {
    const rule = (n) => ({
      __typename: "CollectionConditionsSource", id: n,
      inclusion: { matchType: "ALL", conditions: [{ __typename: "CollectionSourceInclusionConditionProductStatus", relation: "EQUALS", values: ["ACTIVE"] }] },
    });
    const two = [rule("a"), rule("b")];
    expect(actualConditionsFingerprint(two)).toBe("MULTIPLE_SOURCES");
    expect(actualConditionsFingerprint(two)).not.toBe(desiredConditionsFingerprint(NEW_IN));
  });

  it("a sub-collections source is ignored — only conditions sources count", () => {
    expect(actualConditionsFingerprint([{ __typename: "CollectionSubCollectionsSource", id: "x" }])).toBe("");
  });
});

// ── ensureCollection against a fake shop ─────────────────────────────────────
const fakeDb = () => {
  const writes = [];
  return {
    writes,
    ref: (path) => ({
      get: async () => ({ val: () => null }),
      update: async (v) => { writes.push({ path, ...v }); },
    }),
  };
};

const collectionShape = (spec, over = {}) => ({
  id: "gid://shopify/Collection/111",
  handle: spec.handle,
  title: spec.title,
  descriptionHtml: buildCollectionDescriptionHtml(spec.description),
  sortOrder: spec.sortOrder,
  seo: { title: spec.seoTitle, description: spec.seoDescription },
  productsCount: { count: 0 },
  sources: [],
  ...over,
});

// calls: an ordered log; handlers: query-substring → response
const fakeGraphql = (handlers) => {
  const calls = [];
  return {
    calls,
    fn: async (query, variables) => {
      calls.push({ query: query.replace(/\s+/g, " ").trim(), variables });
      for (const [needle, respond] of handlers) {
        if (query.includes(needle)) return typeof respond === "function" ? respond(variables) : respond;
      }
      throw new Error(`fake graphql: no handler for ${query.slice(0, 80)}`);
    },
  };
};

describe("ensureCollection", () => {
  it("dry run reports would-create and mutates nothing", async () => {
    const g = fakeGraphql([
      ["collectionByIdentifier", { collectionByIdentifier: null }],
    ]);
    const db = fakeDb();
    const r = await ensureCollection(g.fn, db, SNEAKERS, { commit: false, recorded: {} });
    expect(r.action).toBe("would-create");
    expect(db.writes).toEqual([]);
    expect(g.calls.every((c) => !c.query.includes("mutation"))).toBe(true);
  });

  it("creates, records the id, and publishes to the Online Store channel", async () => {
    const g = fakeGraphql([
      ["collectionByIdentifier", { collectionByIdentifier: null }],
      ["collectionCreate", { collectionCreate: { collection: { id: "gid://shopify/Collection/9", handle: "sneakers" }, userErrors: [] } }],
      ["publishablePublish", { publishablePublish: { userErrors: [] } }],
    ]);
    const db = fakeDb();
    const r = await ensureCollection(g.fn, db, SNEAKERS, { commit: true, recorded: {}, onlinePublicationId: "gid://shopify/Publication/1" });
    expect(r).toMatchObject({ action: "created", gid: "gid://shopify/Collection/9" });
    expect(db.writes[0]).toMatchObject({
      path: "shopify_sync/_collections/sneakers",
      shopifyCollectionId: "gid://shopify/Collection/9",
      handle: "sneakers",
    });
    expect(g.calls.some((c) => c.query.includes("publishablePublish"))).toBe(true);
  });

  it("a manual collection is created with NO sources", async () => {
    let created = null;
    const g = fakeGraphql([
      ["collectionByIdentifier", { collectionByIdentifier: null }],
      ["collectionCreate", (v) => { created = v.input; return { collectionCreate: { collection: { id: "gid://shopify/Collection/9", handle: "sneakers" }, userErrors: [] } }; }],
    ]);
    await ensureCollection(g.fn, fakeDb(), SNEAKERS, { commit: true, recorded: {} });
    expect(created.sources).toBeUndefined();
    expect(created.sortOrder).toBe("CREATED_DESC");
  });

  it("a smart collection is created WITH its conditions source", async () => {
    let created = null;
    const g = fakeGraphql([
      ["collectionByIdentifier", { collectionByIdentifier: null }],
      ["collectionCreate", (v) => { created = v.input; return { collectionCreate: { collection: { id: "gid://shopify/Collection/9", handle: "under-r500" }, userErrors: [] } }; }],
    ]);
    await ensureCollection(g.fn, fakeDb(), UNDER, { commit: true, recorded: {} });
    const conds = created.sources[0].source.inclusion.conditions;
    expect(conds.find((c) => c.variantPrice).variantPrice.value).toEqual({ amount: "500.00", currencyCode: "ZAR" });
    expect(conds.find((c) => c.productStatus).productStatus.values).toEqual(["ACTIVE"]);
  });

  it("an unchanged collection is a noop — no update mutation, no duplicate", async () => {
    const g = fakeGraphql([
      ["collection(id:", { collection: collectionShape(SNEAKERS) }],
      ["publishablePublish", { publishablePublish: { userErrors: [] } }],
    ]);
    const r = await ensureCollection(g.fn, fakeDb(), SNEAKERS, {
      commit: true,
      recorded: { sneakers: { shopifyCollectionId: "gid://shopify/Collection/111" } },
      onlinePublicationId: "gid://shopify/Publication/1",
    });
    expect(r.action).toBe("noop");
    expect(g.calls.some((c) => c.query.includes("collectionUpdate"))).toBe(false);
    // Publication IS re-asserted every run — a collection unpublished in the
    // admin looks correct while being invisible.
    expect(g.calls.some((c) => c.query.includes("publishablePublish"))).toBe(true);
  });

  it("edited copy in the admin is reconciled back to the map", async () => {
    let updated = null;
    const g = fakeGraphql([
      ["collection(id:", { collection: collectionShape(SNEAKERS, { title: "SNEAKERZ!!", descriptionHtml: "<p>lol</p>" }) }],
      ["collectionUpdate", (v) => { updated = v.input; return { collectionUpdate: { collection: { id: "gid://shopify/Collection/111", handle: "sneakers" }, userErrors: [] } }; }],
      ["publishablePublish", { publishablePublish: { userErrors: [] } }],
    ]);
    const r = await ensureCollection(g.fn, fakeDb(), SNEAKERS, {
      commit: true, recorded: { sneakers: { shopifyCollectionId: "gid://shopify/Collection/111" } },
    });
    expect(r.action).toBe("updated");
    expect(r.notes[0]).toMatch(/title/);
    expect(updated.title).toBe("Sneakers");
    expect(updated.sourcesToCreate).toBeUndefined(); // manual: conditions untouched
  });

  it("a manual collection that grew a RULE has it deleted", async () => {
    let updated = null;
    const g = fakeGraphql([
      ["collection(id:", { collection: collectionShape(SNEAKERS, {
        sources: [{ __typename: "CollectionConditionsSource", id: "gid://shopify/CollectionConditionsSource/7",
          inclusion: { matchType: "ALL", conditions: [{ __typename: "CollectionSourceInclusionConditionProductType", relation: "EQUALS", values: ["Boots"] }] } }],
      }) }],
      ["collectionUpdate", (v) => { updated = v.input; return { collectionUpdate: { collection: { id: "gid://shopify/Collection/111", handle: "sneakers" }, userErrors: [] } }; }],
    ]);
    const r = await ensureCollection(g.fn, fakeDb(), SNEAKERS, {
      commit: true, recorded: { sneakers: { shopifyCollectionId: "gid://shopify/Collection/111" } },
    });
    expect(r.action).toBe("updated");
    expect(updated.sourcesToDelete).toEqual(["gid://shopify/CollectionConditionsSource/7"]);
    expect(updated.sourcesToCreate).toBeUndefined();
  });

  it("a smart collection whose conditions drifted is replaced in ONE mutation", async () => {
    let updated = null;
    const g = fakeGraphql([
      ["collection(id:", { collection: collectionShape(UNDER, {
        sources: [{ __typename: "CollectionConditionsSource", id: "src-1", inclusion: { matchType: "ALL", conditions: [{ __typename: "CollectionSourceInclusionConditionVariantPrice", relation: "LESS_THAN", value: { amount: "300" } }] } }],
      }) }],
      ["collectionUpdate", (v) => { updated = v.input; return { collectionUpdate: { collection: { id: "gid://shopify/Collection/111", handle: "under-r500" }, userErrors: [] } }; }],
    ]);
    const r = await ensureCollection(g.fn, fakeDb(), UNDER, {
      commit: true, recorded: { "under-r500": { shopifyCollectionId: "gid://shopify/Collection/111" } },
    });
    expect(r.action).toBe("updated");
    expect(updated.sourcesToDelete).toEqual(["src-1"]);
    const rebuilt = updated.sourcesToCreate[0].source.inclusion.conditions;
    expect(rebuilt.find((c) => c.variantPrice).variantPrice.value.amount).toBe("500.00");
  });

  it("a recorded id that no longer resolves falls back to the handle and re-records", async () => {
    const g = fakeGraphql([
      ["collection(id:", { collection: null }],
      ["collectionByIdentifier", { collectionByIdentifier: collectionShape(SNEAKERS, { id: "gid://shopify/Collection/222" }) }],
    ]);
    const db = fakeDb();
    const r = await ensureCollection(g.fn, db, SNEAKERS, {
      commit: true, recorded: { sneakers: { shopifyCollectionId: "gid://shopify/Collection/DEAD" } },
    });
    expect(r).toMatchObject({ action: "noop", gid: "gid://shopify/Collection/222" });
    expect(r.notes.some((n) => /no longer resolves/.test(n))).toBe(true);
    expect(db.writes[0]).toMatchObject({ shopifyCollectionId: "gid://shopify/Collection/222" });
  });

  it("an unrecorded collection is adopted by handle, never duplicated", async () => {
    const g = fakeGraphql([
      ["collectionByIdentifier", { collectionByIdentifier: collectionShape(SNEAKERS, { id: "gid://shopify/Collection/333" }) }],
    ]);
    const db = fakeDb();
    const r = await ensureCollection(g.fn, db, SNEAKERS, { commit: true, recorded: {} });
    expect(r).toMatchObject({ action: "noop", gid: "gid://shopify/Collection/333" });
    expect(g.calls.some((c) => c.query.includes("collectionCreate"))).toBe(false);
    expect(db.writes[0]).toMatchObject({ shopifyCollectionId: "gid://shopify/Collection/333" });
  });

  it("userErrors from Shopify throw rather than being reported as success", async () => {
    const g = fakeGraphql([
      ["collectionByIdentifier", { collectionByIdentifier: null }],
      ["collectionCreate", { collectionCreate: { collection: null, userErrors: [{ field: ["handle"], message: "taken" }] } }],
    ]);
    await expect(ensureCollection(g.fn, fakeDb(), SNEAKERS, { commit: true, recorded: {} }))
      .rejects.toThrow(/userErrors/);
  });

  it("refuses BEFORE any Shopify call when the copy carries a brand trigger", async () => {
    const g = fakeGraphql([]);
    await expect(ensureCollection(g.fn, fakeDb(), { ...SNEAKERS, title: "Nike Sneakers" }, { commit: true, recorded: {} }))
      .rejects.toThrow(/fails compliance/);
    expect(g.calls).toEqual([]);
  });
});

// ── Membership ───────────────────────────────────────────────────────────────
// The gids below stand for: SNEAK/CAPS/CLOTH = manual collections in the map,
// NEWIN = a smart collection Shopify owns, HANDMADE = a merchandising
// collection somebody built in the Shopify admin.
const SNEAK = "gid://shopify/Collection/1";
const CAPS = "gid://shopify/Collection/2";
const CLOTH = "gid://shopify/Collection/3";
const NEWIN = "gid://shopify/Collection/90";
const HANDMADE = "gid://shopify/Collection/99";
const MANAGED = [SNEAK, CAPS, CLOTH];

describe("manualGidsFrom", () => {
  it("keeps manual collections and drops the smart ones Shopify owns", () => {
    const gids = { sneakers: SNEAK, "caps-hats": CAPS, "new-in": NEWIN, "under-r500": "gid://shopify/Collection/91" };
    expect(manualGidsFrom(gids).sort()).toEqual([SNEAK, CAPS].sort());
  });
  it("ignores a key that is not in the map at all", () => {
    expect(manualGidsFrom({ "some-old-key": "gid://shopify/Collection/5" })).toEqual([]);
  });
  it("survives an empty or absent record", () => {
    expect(manualGidsFrom({})).toEqual([]);
    expect(manualGidsFrom(undefined)).toEqual([]);
  });
});

describe("planCollectionMembership", () => {
  it("a product in nothing joins its collection", () => {
    expect(planCollectionMembership([], SNEAK, MANAGED)).toEqual({ join: [SNEAK], leave: [] });
  });

  it("a product already in the right collection is a NO-OP — no mutation at all", () => {
    expect(planCollectionMembership([SNEAK], SNEAK, MANAGED)).toEqual({ join: [], leave: [] });
  });

  it("a re-categorised product leaves the old collection and joins the new one", () => {
    expect(planCollectionMembership([CAPS], SNEAK, MANAGED)).toEqual({ join: [SNEAK], leave: [CAPS] });
  });

  it("one internal category means ONE collection — extra managed memberships are stripped", () => {
    const plan = planCollectionMembership([SNEAK, CAPS, CLOTH], SNEAK, MANAGED);
    expect(plan.join).toEqual([]);
    expect(plan.leave.sort()).toEqual([CAPS, CLOTH].sort());
  });

  it("NEVER touches a smart collection — Shopify owns those", () => {
    const plan = planCollectionMembership([NEWIN, CAPS], SNEAK, MANAGED);
    expect(plan.leave).toEqual([CAPS]);
    expect(plan.leave).not.toContain(NEWIN);
  });

  it("NEVER empties a collection somebody built by hand in the admin", () => {
    const plan = planCollectionMembership([HANDMADE, CAPS], SNEAK, MANAGED);
    expect(plan.leave).toEqual([CAPS]);
    expect(plan.leave).not.toContain(HANDMADE);
  });

  it("going OFF (desired null) leaves the managed collections and joins nothing", () => {
    const plan = planCollectionMembership([SNEAK, HANDMADE, NEWIN], null, MANAGED);
    expect(plan.join).toEqual([]);
    expect(plan.leave).toEqual([SNEAK]);
  });

  it("an unmapped category behaves exactly like OFF for membership — it joins nothing", () => {
    expect(planCollectionMembership([], null, MANAGED)).toEqual({ join: [], leave: [] });
  });

  it("with no collections recorded yet, nothing is joined and nothing is stripped", () => {
    expect(planCollectionMembership([HANDMADE], null, [])).toEqual({ join: [], leave: [] });
  });

  it("tolerates absent inputs rather than throwing mid-publish", () => {
    expect(planCollectionMembership(undefined, SNEAK, undefined)).toEqual({ join: [SNEAK], leave: [] });
  });
});

describe("readProductCollections / applyCollectionMembership", () => {
  it("reads the gids, the status, and whether it is ON THE STOREFRONT", async () => {
    // `published` is the channel fact sweepIntent judges on. `status` is
    // reporting only — in this program it is NOT a visibility signal.
    const g = fakeGraphql([["collections(first: 100)", { product: { status: "ACTIVE", publishedOnPublication: true, collections: { pageInfo: { hasNextPage: false }, nodes: [{ id: SNEAK }] } } }]]);
    expect(await readProductCollections(g.fn, "gid://shopify/Product/1", "gid://shopify/Publication/1"))
      .toEqual({ collections: [SNEAK], status: "ACTIVE", published: true });
  });

  it("an ACTIVE product that is NOT published reads as not-on-the-storefront", async () => {
    // The state every switched-off product lands in: the reconciler's OFF path
    // is a channel unpublish only, and nothing ever sets DRAFT back.
    const g = fakeGraphql([["collections(first: 100)", { product: { status: "ACTIVE", publishedOnPublication: false, collections: { pageInfo: { hasNextPage: false }, nodes: [] } } }]]);
    expect(await readProductCollections(g.fn, "gid://shopify/Product/1", "gid://shopify/Publication/1"))
      .toMatchObject({ status: "ACTIVE", published: false });
  });

  it("refuses to read visibility without a publication id", async () => {
    await expect(readProductCollections(fakeGraphql([]).fn, "gid://shopify/Product/1"))
      .rejects.toThrow(/publication id/);
  });

  it("refuses a partial read rather than stripping collections it could not see", async () => {
    const g = fakeGraphql([["collections(first: 100)", { product: { status: "ACTIVE", publishedOnPublication: true, collections: { pageInfo: { hasNextPage: true }, nodes: [] } } }]]);
    await expect(readProductCollections(g.fn, "gid://shopify/Product/1", "gid://shopify/Publication/1")).rejects.toThrow(/partial read/);
  });

  it("a missing product throws instead of reading as 'in no collections'", async () => {
    const g = fakeGraphql([["collections(first: 100)", { product: null }]]);
    await expect(readProductCollections(g.fn, "gid://shopify/Product/1", "gid://shopify/Publication/1")).rejects.toThrow(/not found/);
  });

  it("an empty plan makes NO Shopify call", async () => {
    const g = fakeGraphql([]);
    await applyCollectionMembership(g.fn, "gid://shopify/Product/1", { join: [], leave: [] });
    expect(g.calls).toEqual([]);
  });

  it("sends only the halves it has", async () => {
    let sent = null;
    const g = fakeGraphql([["productUpdate", (v) => { sent = v.input; return { productUpdate: { product: { id: "p" }, userErrors: [] } }; }]]);
    await applyCollectionMembership(g.fn, "gid://shopify/Product/1", { join: [SNEAK], leave: [] });
    expect(sent).toEqual({ id: "gid://shopify/Product/1", collectionsToJoin: [SNEAK] });
    expect(sent.collectionsToLeave).toBeUndefined();
  });

  it("userErrors throw rather than silently reporting success", async () => {
    const g = fakeGraphql([["productUpdate", { productUpdate: { product: null, userErrors: [{ field: ["id"], message: "nope" }] } }]]);
    await expect(applyCollectionMembership(g.fn, "gid://shopify/Product/1", { join: [SNEAK], leave: [] }))
      .rejects.toThrow(/collection membership userErrors/);
  });
});

// ── The selection-only source ────────────────────────────────────────────────
// API 2026-07 stores a MANUAL collection's membership in a CollectionConditions
// Source with an EMPTY conditions list — the products sit in inclusion.selections.
// Shopify creates it the first time a product joins via collectionsToJoin.
// Mistaking it for a stray rule made a live run try to delete it, and Shopify
// refused: "A condition based source must have at least one product selection
// or condition". These pin the fix.
const SELECTION_ONLY = {
  __typename: "CollectionConditionsSource",
  id: "gid://shopify/CollectionConditionsSource/members",
  inclusion: { matchType: "ALL", conditions: [] },
};

describe("a selection-only source is MEMBERSHIP, not a rule", () => {
  it("does not read as drift on a manual collection", () => {
    expect(actualConditionsFingerprint([SELECTION_ONLY])).toBe(desiredConditionsFingerprint(SNEAKERS));
  });

  it("a populated manual collection is a NOOP — its membership source is never deleted", async () => {
    const g = fakeGraphql([
      ["collection(id:", { collection: collectionShape(SNEAKERS, { sources: [SELECTION_ONLY], productsCount: { count: 7 } }) }],
      ["publishablePublish", { publishablePublish: { userErrors: [] } }],
    ]);
    const r = await ensureCollection(g.fn, fakeDb(), SNEAKERS, {
      commit: true, recorded: { sneakers: { shopifyCollectionId: "gid://shopify/Collection/111" } },
      onlinePublicationId: "gid://shopify/Publication/1",
    });
    expect(r.action).toBe("noop");
    expect(g.calls.some((c) => c.query.includes("collectionUpdate"))).toBe(false);
  });

  it("a copy edit on a populated manual collection updates the copy and leaves the source alone", async () => {
    let updated = null;
    const g = fakeGraphql([
      ["collection(id:", { collection: collectionShape(SNEAKERS, { sources: [SELECTION_ONLY], title: "Old" }) }],
      ["collectionUpdate", (v) => { updated = v.input; return { collectionUpdate: { collection: { id: "gid://shopify/Collection/111", handle: "sneakers" }, userErrors: [] } }; }],
    ]);
    const r = await ensureCollection(g.fn, fakeDb(), SNEAKERS, {
      commit: true, recorded: { sneakers: { shopifyCollectionId: "gid://shopify/Collection/111" } },
    });
    expect(r.action).toBe("updated");
    expect(updated.title).toBe("Sneakers");
    expect(updated.sourcesToDelete).toBeUndefined();
  });

  it("a SMART collection keeps its membership source and only its rule source is replaced", async () => {
    let updated = null;
    const stale = {
      __typename: "CollectionConditionsSource", id: "rule-src",
      inclusion: { matchType: "ALL", conditions: [{ __typename: "CollectionSourceInclusionConditionVariantPrice", relation: "LESS_THAN", value: { amount: "300" } }] },
    };
    const g = fakeGraphql([
      ["collection(id:", { collection: collectionShape(UNDER, { sources: [SELECTION_ONLY, stale] }) }],
      ["collectionUpdate", (v) => { updated = v.input; return { collectionUpdate: { collection: { id: "gid://shopify/Collection/111", handle: "under-r500" }, userErrors: [] } }; }],
    ]);
    await ensureCollection(g.fn, fakeDb(), UNDER, {
      commit: true, recorded: { "under-r500": { shopifyCollectionId: "gid://shopify/Collection/111" } },
    });
    expect(updated.sourcesToDelete).toEqual(["rule-src"]);
    expect(updated.sourcesToDelete).not.toContain(SELECTION_ONLY.id);
  });

  it("a genuine hand-added RULE on a manual collection is still removed", async () => {
    let updated = null;
    const handRule = {
      __typename: "CollectionConditionsSource", id: "hand-rule",
      inclusion: { matchType: "ALL", conditions: [{ __typename: "CollectionSourceInclusionConditionProductType", relation: "EQUALS", values: ["Boots"] }] },
    };
    const g = fakeGraphql([
      ["collection(id:", { collection: collectionShape(SNEAKERS, { sources: [SELECTION_ONLY, handRule] }) }],
      ["collectionUpdate", (v) => { updated = v.input; return { collectionUpdate: { collection: { id: "gid://shopify/Collection/111", handle: "sneakers" }, userErrors: [] } }; }],
    ]);
    const r = await ensureCollection(g.fn, fakeDb(), SNEAKERS, {
      commit: true, recorded: { sneakers: { shopifyCollectionId: "gid://shopify/Collection/111" } },
    });
    expect(r.action).toBe("updated");
    expect(updated.sourcesToDelete).toEqual(["hand-rule"]);
    expect(updated.sourcesToCreate).toBeUndefined();
  });
});

// ── requireOnlineStorePublication ────────────────────────────────────────────
// The catalog title is auto-generated and localisable — this shop's reads back
// as "Channel Catalog 188560801941 for Online Store" — so the handle is the
// only stable identifier. Verified against the live shop (it resolves
// gid://shopify/Publication/188560801941 via the handle); these pin the
// branching a live check cannot exercise: pagination, the fallback, and the
// two different failure messages.
const pubPage = (nodes, hasNextPage = false, endCursor = null) => ({
  publications: { pageInfo: { hasNextPage, endCursor }, nodes },
});
const pub = (id, { handle = null, title = null } = {}) => ({
  id, catalog: title ? { title } : null,
  channels: handle ? { nodes: [{ handle }] } : { nodes: [] },
});

describe("requireOnlineStorePublication", () => {
  it("matches the stable online_store CHANNEL HANDLE, not the catalog title", async () => {
    const g = fakeGraphql([["publications(first: 50", pubPage([
      pub("gid://shopify/Publication/1", { title: "Online Store" }),          // title decoy
      pub("gid://shopify/Publication/2", { handle: "online_store", title: "Channel Catalog 999 for Online Store" }),
    ])]]);
    expect(await requireOnlineStorePublication(g.fn)).toBe("gid://shopify/Publication/2");
  });

  it("walks past a full page to find it", async () => {
    let call = 0;
    const g = fakeGraphql([["publications(first: 50", () => {
      call += 1;
      return call === 1
        ? pubPage([pub("gid://shopify/Publication/1", { handle: "pos" })], true, "CUR")
        : pubPage([pub("gid://shopify/Publication/9", { handle: "online_store" })]);
    }]]);
    expect(await requireOnlineStorePublication(g.fn)).toBe("gid://shopify/Publication/9");
    expect(g.calls[1].variables.after).toBe("CUR"); // the cursor was actually used
  });

  it("falls back to a catalog-title match when NO channel carries the handle", async () => {
    const g = fakeGraphql([["publications(first: 50", pubPage([
      pub("gid://shopify/Publication/1", { handle: "pos", title: "Point of Sale" }),
      pub("gid://shopify/Publication/7", { handle: "something-else", title: "Channel Catalog 5 for Online Store" }),
    ])]]);
    expect(await requireOnlineStorePublication(g.fn)).toBe("gid://shopify/Publication/7");
  });

  it("prefers the handle over a title match that appears on an EARLIER page", async () => {
    let call = 0;
    const g = fakeGraphql([["publications(first: 50", () => {
      call += 1;
      return call === 1
        ? pubPage([pub("gid://shopify/Publication/1", { title: "Online Store" })], true, "CUR")
        : pubPage([pub("gid://shopify/Publication/2", { handle: "online_store" })]);
    }]]);
    expect(await requireOnlineStorePublication(g.fn)).toBe("gid://shopify/Publication/2");
  });

  it("throws plainly when the shop genuinely has no online store", async () => {
    const g = fakeGraphql([["publications(first: 50", pubPage([pub("gid://shopify/Publication/1", { handle: "pos" })])]]);
    await expect(requireOnlineStorePublication(g.fn)).rejects.toThrow(/no Online Store publication found on this shop/);
  });

  it("says TRUNCATED — not 'not found' — when the page cap is hit", async () => {
    // Always another page: the walk is cut short rather than exhaustive, and
    // the two cases have different cures.
    const g = fakeGraphql([["publications(first: 50",
      () => pubPage([pub("gid://shopify/Publication/1", { handle: "pos" })], true, "CUR")]]);
    await expect(requireOnlineStorePublication(g.fn)).rejects.toThrow(/TRUNCATED/);
    expect(g.calls.length).toBe(10); // the backstop held
  });

  it("tolerates a publication with no channels and no catalog", async () => {
    const g = fakeGraphql([["publications(first: 50", pubPage([
      { id: "gid://shopify/Publication/1", catalog: null, channels: null },
      pub("gid://shopify/Publication/2", { handle: "online_store" }),
    ])]]);
    expect(await requireOnlineStorePublication(g.fn)).toBe("gid://shopify/Publication/2");
  });
});

// ── sweepIntent — the decision that can strip a PUBLIC listing ───────────────
// reconcile.mjs joins the collection, publishes, and goes ACTIVE, and only THEN
// writes confirmLiveState. So a perfectly fresh read of /shopify_publish says
// "awaiting" for the whole tail of a publish while Shopify already holds the
// membership and, at the end, a live listing. These pin the two guards that
// stop the sweep undoing it.
describe("sweepIntent", () => {
  const LIVE_ON = { state: "live", liveState: "on", desiredState: "on" };

  it("a confirmed-ON product is assigned its collection", () => {
    expect(sweepIntent(LIVE_ON, true)).toMatchObject({ action: "assign" });
  });

  it("HOLDS a publish in flight — the node is behind, not wrong", () => {
    for (const published of [false, true]) {
      const v = sweepIntent({ state: "awaiting", desiredState: "on" }, published);
      expect({ published, action: v.action }).toEqual({ published, action: "hold" });
      expect(v.reason).toMatch(/publish is in flight/);
    }
  });

  it("HOLDS a live-OFF product being switched back on", () => {
    expect(sweepIntent({ state: "live", liveState: "off", desiredState: "on" }, false).action).toBe("hold");
  });

  it("HOLDS an UNPUBLISH in flight — the mirror guard", () => {
    // Without it the sweep re-joins a product the reconciler is taking down.
    const v = sweepIntent({ state: "live", liveState: "on", desiredState: "off" }, true);
    expect(v.action).toBe("hold");
    expect(v.reason).toMatch(/unpublish is in flight/);
  });

  it("THE REGRESSION THAT MATTERS: a switched-off product is STRIPPED, not called drift", () => {
    // The reconciler's OFF path is a channel unpublish ONLY — status stays
    // ACTIVE forever. Judging on status would call this a live listing, refuse
    // to clear its membership, and fail the run on every future pass.
    const v = sweepIntent({ state: "live", liveState: "off", desiredState: "off" }, false);
    expect(v.action).toBe("strip");
  });

  it("refuses to strip a product Shopify PUBLISHES with no intent to explain it", () => {
    const v = sweepIntent({ state: "awaiting" }, true);
    expect(v.action).toBe("drift");
    expect(v.reason).toMatch(/refusing to strip a live listing/);
  });

  it("reports drift for a mapped product with no publish node at all", () => {
    expect(sweepIntent(null, true)).toMatchObject({ action: "drift" });
    expect(sweepIntent(null, true).reason).toMatch(/no node/);
  });

  it("STRIPS the genuinely-off cases, and only those", () => {
    expect(sweepIntent({ state: "live", liveState: "off", desiredState: "off" }, false).action).toBe("strip");
    expect(sweepIntent({ state: "blocked", desiredState: "off" }, false).action).toBe("strip");
    expect(sweepIntent({ state: "awaiting" }, false).action).toBe("strip");
    expect(sweepIntent(null, false).action).toBe("strip");
  });

  it("a blocked product is stripped, not held — markBlocked sets desiredState off", () => {
    expect(sweepIntent({ state: "blocked", blockedReason: "x", desiredState: "off" }, false).action).toBe("strip");
  });
});

describe("planCollectionMembership — a join is filtered by the managed set too", () => {
  const SMART = "gid://shopify/Collection/90";
  it("refuses to write membership into a collection it does not manage", () => {
    expect(planCollectionMembership([], SMART, ["gid://shopify/Collection/1"]))
      .toEqual({ join: [], leave: [] });
  });
  it("still joins when no managed set is supplied (callers that do not manage membership)", () => {
    expect(planCollectionMembership([], SMART, []).join).toEqual([SMART]);
  });
});

// The two safety properties, over the WHOLE input space rather than examples.
// This is the function that can remove a public listing from its collection;
// an example-based test proves the cases I thought of, which is exactly the
// class of reasoning that produced the bug this function exists to fix.
describe("sweepIntent — exhaustive safety properties", () => {
  const NODES = [
    null,
    { state: "awaiting" },
    { state: "live", liveState: "on" },
    { state: "live", liveState: "off" },
    { state: "blocked" },
  ];
  const DESIRED = [undefined, "on", "off"];
  const PUBLISHED = [true, false];
  const every = [];
  for (const base of NODES) {
    for (const desiredState of DESIRED) {
      for (const published of PUBLISHED) {
        const node = base === null ? null : (desiredState === undefined ? base : { ...base, desiredState });
        every.push({ node, published, verdict: sweepIntent(node, published) });
      }
    }
  }

  it("covers 30 combinations and returns only known actions", () => {
    expect(every).toHaveLength(30);
    for (const e of every) expect(["assign", "hold", "drift", "strip"]).toContain(e.verdict.action);
  });

  it("NEVER strips a product Shopify is PUBLISHING", () => {
    const violations = every
      .filter((e) => e.published && e.verdict.action === "strip")
      .map((e) => ({ node: e.node, published: e.published }));
    expect(violations).toEqual([]);
  });

  it("NEVER assigns a collection to anything but a CONFIRMED-on product", () => {
    const violations = every
      .filter((e) => e.verdict.action === "assign")
      .filter((e) => !(e.node?.state === "live" && e.node?.liveState === "on"))
      .map((e) => ({ node: e.node, published: e.published }));
    expect(violations).toEqual([]);
  });

  it("every non-assign verdict carries a reason a human can act on", () => {
    for (const e of every) {
      if (e.verdict.action === "hold" || e.verdict.action === "drift") {
        expect(typeof e.verdict.reason).toBe("string");
        expect(e.verdict.reason.length).toBeGreaterThan(20);
      }
    }
  });
});
