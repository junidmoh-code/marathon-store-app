// ── Collections-on-Shopify tests ─────────────────────────────────────────────
// The pure halves: the 2026-07 condition-source input shape, the drift
// fingerprints that keep a re-run from rewriting an unchanged collection, and
// the description builder. ensureCollection itself is exercised against a fake
// graphql so the create/reconcile/noop branches are pinned without a shop.
import { describe, it, expect } from "vitest";
import {
  buildCollectionDescriptionHtml, buildConditionsSourceInput,
  desiredConditionsFingerprint, actualConditionsFingerprint, ensureCollection,
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

  it("variant price carries the shop currency", () => {
    expect(buildConditionsSourceInput(UNDER).inclusion.conditions).toEqual([
      { variantPrice: { relation: "LESS_THAN", value: { amount: "500.00", currencyCode: "ZAR" } } },
    ]);
  });

  it("IS_SET is a presence test and carries NO money value", () => {
    expect(buildConditionsSourceInput(SALE).inclusion.conditions).toEqual([
      { variantCompareAtPrice: { relation: "IS_SET" } },
    ]);
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
      inclusion: { matchType: "ALL", conditions: [{ __typename: "CollectionSourceInclusionConditionVariantPrice", relation: "LESS_THAN", value: { amount: "500.0" } }] },
    }];
    expect(actualConditionsFingerprint(actual)).toBe(desiredConditionsFingerprint(UNDER));
  });

  it("a changed threshold IS drift", () => {
    const actual = [{
      __typename: "CollectionConditionsSource", id: "s1",
      inclusion: { matchType: "ALL", conditions: [{ __typename: "CollectionSourceInclusionConditionVariantPrice", relation: "LESS_THAN", value: { amount: "300" } }] },
    }];
    expect(actualConditionsFingerprint(actual)).not.toBe(desiredConditionsFingerprint(UNDER));
  });

  it("a manual collection that has grown a conditions source reads as drift", () => {
    const actual = [{ __typename: "CollectionConditionsSource", id: "s1", inclusion: { matchType: "ALL", conditions: [] } }];
    expect(actualConditionsFingerprint(actual)).not.toBe(desiredConditionsFingerprint(SNEAKERS));
  });

  it("no sources at all is the empty fingerprint, matching a manual collection", () => {
    expect(actualConditionsFingerprint([])).toBe(desiredConditionsFingerprint(SNEAKERS));
    expect(actualConditionsFingerprint(undefined)).toBe("");
  });

  it("more than one conditions source is never mistaken for agreement", () => {
    const two = [
      { __typename: "CollectionConditionsSource", id: "a", inclusion: { matchType: "ALL", conditions: [] } },
      { __typename: "CollectionConditionsSource", id: "b", inclusion: { matchType: "ALL", conditions: [] } },
    ];
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
    expect(created.sources[0].source.inclusion.conditions[0].variantPrice.value).toEqual({ amount: "500.00", currencyCode: "ZAR" });
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

  it("a manual collection that grew a conditions source has it deleted", async () => {
    let updated = null;
    const g = fakeGraphql([
      ["collection(id:", { collection: collectionShape(SNEAKERS, {
        sources: [{ __typename: "CollectionConditionsSource", id: "gid://shopify/CollectionConditionsSource/7", inclusion: { matchType: "ALL", conditions: [] } }],
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
    expect(updated.sourcesToCreate[0].source.inclusion.conditions[0].variantPrice.value.amount).toBe("500.00");
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
