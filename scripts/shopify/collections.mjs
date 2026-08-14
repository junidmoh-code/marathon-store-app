// ── Collections on Shopify: create, reconcile, publish, record ───────────────
// The Shopify-facing half of collectionMap.mjs. Same discipline as the product
// reconciler: IDEMPOTENT — a re-run reconciles what is there and NEVER creates
// a second collection. Three ways a collection is recognised, in order:
//
//   1. the id recorded at /shopify_sync/_collections/{key} (ours, authoritative)
//   2. the handle, probed with collectionByIdentifier (handles are unique per
//      shop and ours are deterministic, so a crashed earlier run surfaces here)
//   3. neither ⇒ create
//
// A recorded id that no longer resolves (deleted in the admin) falls through to
// the handle probe and is re-recorded rather than crashing the run.
//
// EVERY string is validated by validateCollectionPayload BEFORE any mutation.
// Nothing reaches Shopify without a pass — same contract as the product push.
//
// ── API 2026-07 NOTES (these changed; the old recipes do not work) ───────────
// • `ruleSet` is DEPRECATED on Collection and absent from CollectionCreateInput.
//   Smart membership is a CONDITIONS SOURCE: sources[].source.inclusion with a
//   matchType and a list of typed conditions.
// • CollectionCreateInput has NO `products` field. Manual membership is written
//   from the PRODUCT side — productSet(collections:) on create,
//   productUpdate(collectionsToJoin/collectionsToLeave) after. That is what the
//   reconciler does; this module never writes membership.
// • A collection is Publishable. Creating it is NOT enough: it must be
//   published to the Online Store channel or the storefront 404s on its URL and
//   the menu link goes nowhere. publishToOnlineStore below is not optional.
//
// ── WHERE THE IDS LIVE ───────────────────────────────────────────────────────
// /shopify_sync/_collections/{collectionKey} = {
//   shopifyCollectionId: "gid://shopify/Collection/…", handle, updatedAt
// }
// Alongside the product map, Admin-SDK-only, same node, same posture. The key
// `_collections` cannot collide with a product entry: product ids are "p" +
// digits (src/App.jsx), and idMap.mjs's claim transaction only ever inspects a
// child's `shopifyProductId`, which this subtree does not have at its top level.
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { COLLECTIONS, COLLECTION_BY_KEY, validateCollectionPayload, CURRENCY } from "./collectionMap.mjs";

export const COLLECTIONS_NODE = "shopify_sync/_collections";

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The collection body as pushed. One paragraph, plain, escaped. */
export function buildCollectionDescriptionHtml(description) {
  const text = String(description ?? "").trim();
  if (!text) throw new Error("a collection description may not be empty — it is customer-facing copy");
  return `<p>${escapeHtml(text)}</p>`;
}

// ── The conditions source, in the 2026-07 input shape ────────────────────────
// Our data shape (collectionMap.mjs) is deliberately smaller than Shopify's:
// one inclusion, no exclusions, no explicit selections. Anything richer would
// be membership logic hiding in the wrong file.
export function buildConditionsSourceInput(spec) {
  const conds = spec?.conditions?.all ?? [];
  if (!conds.length) throw new Error(`collection "${spec?.key}" is smart but carries no conditions`);
  return {
    title: spec.title,
    inclusion: {
      matchType: spec.conditions.matchType ?? "ALL",
      conditions: conds.map((c) => {
        if (c.productStatus) {
          return { productStatus: { relation: c.productStatus.relation, values: c.productStatus.values, matchType: "ANY" } };
        }
        if (c.variantPrice) {
          return { variantPrice: { relation: c.variantPrice.relation, value: { amount: c.variantPrice.amount, currencyCode: CURRENCY } } };
        }
        if (c.variantCompareAtPrice) {
          const rel = c.variantCompareAtPrice.relation;
          // IS_SET / IS_NOT_SET are presence tests and carry no money value.
          return {
            variantCompareAtPrice: {
              relation: rel,
              ...(rel === "IS_SET" || rel === "IS_NOT_SET"
                ? {}
                : { value: { amount: c.variantCompareAtPrice.amount, currencyCode: CURRENCY } }),
            },
          };
        }
        throw new Error(`unsupported condition on "${spec.key}": ${JSON.stringify(Object.keys(c))}`);
      }),
    },
    targetType: "PRODUCTS",
  };
}

// ── Drift detection ──────────────────────────────────────────────────────────
// A canonical string for a condition set, comparable between what we WANT
// (our data) and what Shopify HOLDS (the read-back). Money is compared
// numerically — Shopify returns "500.0" for the "500.00" we sent, and a string
// compare would rewrite the source on every single run.
const money = (v) => (v == null || v === "" ? "-" : String(Number(v)));

export function desiredConditionsFingerprint(spec) {
  if (spec?.kind !== "smart") return "";
  const parts = (spec.conditions.all ?? []).map((c) => {
    if (c.productStatus) return `productStatus:${c.productStatus.relation}:${[...c.productStatus.values].sort().join(",")}`;
    if (c.variantPrice) return `variantPrice:${c.variantPrice.relation}:${money(c.variantPrice.amount)}`;
    if (c.variantCompareAtPrice) return `variantCompareAtPrice:${c.variantCompareAtPrice.relation}:${money(c.variantCompareAtPrice.amount)}`;
    return `unknown:${JSON.stringify(c)}`;
  });
  return `${spec.conditions.matchType ?? "ALL"}|${parts.sort().join(";")}`;
}

const TYPENAME_TO_NAME = {
  CollectionSourceInclusionConditionProductStatus: "productStatus",
  CollectionSourceInclusionConditionVariantPrice: "variantPrice",
  CollectionSourceInclusionConditionVariantCompareAtPrice: "variantCompareAtPrice",
};

// A conditions source that carries NO conditions is how API 2026-07 stores a
// MANUAL collection's membership: the products sit in inclusion.selections and
// the source exists only to hold them. Shopify creates it the first time a
// product joins via collectionsToJoin.
//
// This cost a live run to learn. Treating a selection-only source as "a rule
// that should not be here" made the reconciler try to delete it, and Shopify
// refused with "A condition based source must have at least one product
// selection or condition" — it was being asked to throw away the collection's
// entire membership. So: RULE-BEARING sources are the only ones this module
// compares or deletes. A selection-only source is the manual membership and is
// never touched here; membership is written from the product side.
const isRuleBearing = (s) =>
  s?.__typename === "CollectionConditionsSource" && (s.inclusion?.conditions?.length ?? 0) > 0;

/** The rule-bearing sources on a collection — the only ones we compare or delete. */
export function ruleBearingSources(sources) {
  return (sources ?? []).filter(isRuleBearing);
}

/** The same fingerprint, computed from a Collection.sources read-back. */
export function actualConditionsFingerprint(sources) {
  const conditionSources = ruleBearingSources(sources);
  if (conditionSources.length !== 1) return conditionSources.length === 0 ? "" : "MULTIPLE_SOURCES";
  const inc = conditionSources[0].inclusion;
  const parts = (inc?.conditions ?? []).map((c) => {
    const name = TYPENAME_TO_NAME[c.__typename];
    if (!name) return `unknown:${c.__typename}`;
    if (name === "productStatus") return `productStatus:${c.relation}:${[...(c.values ?? [])].sort().join(",")}`;
    return `${name}:${c.relation}:${money(c.value?.amount)}`;
  });
  return `${inc?.matchType ?? "ALL"}|${parts.sort().join(";")}`;
}

// ── RTDB: the recorded ids ───────────────────────────────────────────────────
export async function readCollectionIds(db) {
  return (await db.ref(COLLECTIONS_NODE).get()).val() || {};
}

export async function recordCollectionId(db, key, gid, handle) {
  assertSafeSegment(key, "collection key");
  if (!String(gid ?? "").startsWith("gid://shopify/Collection/")) {
    throw new Error(`refusing to record a non-Collection gid for "${key}": ${gid}`);
  }
  await db.ref(`${COLLECTIONS_NODE}/${key}`).update({
    shopifyCollectionId: gid,
    handle,
    updatedAt: Date.now(),
  });
}

// ── GraphQL ──────────────────────────────────────────────────────────────────
const COLLECTION_FIELDS = `
  id handle title descriptionHtml sortOrder
  seo { title description }
  productsCount { count }
  sources {
    __typename
    ... on CollectionConditionsSource {
      id
      inclusion {
        matchType
        conditions {
          __typename
          ... on CollectionSourceInclusionConditionProductStatus { relation values }
          ... on CollectionSourceInclusionConditionVariantPrice { relation value { amount } }
          ... on CollectionSourceInclusionConditionVariantCompareAtPrice { relation value { amount } }
        }
      }
    }
  }`;

async function fetchById(graphql, gid) {
  const d = await graphql(`query ($id: ID!) { collection(id: $id) { ${COLLECTION_FIELDS} } }`, { id: gid });
  return d.collection ?? null;
}

async function fetchByHandle(graphql, handle) {
  const d = await graphql(
    `query ($h: String!) { collectionByIdentifier(identifier: { handle: $h }) { ${COLLECTION_FIELDS} } }`,
    { h: handle }
  );
  return d.collectionByIdentifier ?? null;
}

/** Publish a collection to the Online Store channel. Idempotent; a no-op when already published. */
export async function publishToOnlineStore(graphql, gid, onlinePublicationId) {
  const res = await graphql(
    `mutation ($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) { userErrors { field message } }
    }`,
    { id: gid, input: [{ publicationId: onlinePublicationId }] },
    { mutation: true }
  );
  const errs = res.publishablePublish.userErrors;
  if (errs?.length) throw new Error(`publishablePublish (collection) userErrors: ${JSON.stringify(errs)}`);
}

/**
 * Resolve the Online Store publication id.
 *
 * Matched on the CHANNEL HANDLE "online_store", not on the catalog title: the
 * title is auto-generated and localisable (this shop's reads back as "Channel
 * Catalog 188560801941 for Online Store"), so a shop in another locale — or a
 * Shopify rename — would silently match nothing and publish to no channel. The
 * handle is stable. Title matching stays as a FALLBACK for the case where the
 * channels field is unavailable, so this can only ever be more reliable than
 * what it replaces. Paginated: a shop with many sales channels must not hide
 * the online store behind a fixed page-1 cutoff.
 */
export async function requireOnlineStorePublication(graphql) {
  let after = null;
  const titleHits = [];
  for (let page = 0; page < 10; page++) {
    const d = await graphql(
      `query ($after: String) {
        publications(first: 50, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id catalog { title } channels(first: 5) { nodes { handle } } }
        }
      }`,
      { after }
    );
    const conn = d.publications;
    for (const n of conn.nodes) {
      if (n.channels?.nodes?.some((c) => c.handle === "online_store")) return n.id;
      if (/online store/i.test(n.catalog?.title ?? "")) titleHits.push(n.id);
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  if (titleHits.length) {
    console.error("  ⚠ no publication carries the online_store channel handle — falling back to a catalog-title match");
    return titleHits[0];
  }
  throw new Error("no Online Store publication found on this shop");
}

// ── ensureCollection — the one idempotent unit of work ───────────────────────
// Returns { key, action, gid, handle, notes[] }.
//   action: "would-create" | "would-update" | "created" | "updated" | "noop"
// `commit: false` performs READS ONLY and reports the action it would take.
export async function ensureCollection(graphql, db, spec, { commit = false, recorded = {}, onlinePublicationId = null } = {}) {
  const notes = [];
  // THE GATE. Nothing below runs for a collection whose copy carries a trigger.
  const verdict = validateCollectionPayload(spec);
  if (!verdict.ok) {
    throw new Error(
      `collection "${spec.key}" fails compliance: ` +
        verdict.violations.map((v) => `${v.field}: ${v.problem}`).join("; ")
    );
  }

  const descriptionHtml = buildCollectionDescriptionHtml(spec.description);
  const seo = { title: spec.seoTitle, description: spec.seoDescription };

  // 1) the recorded id, 2) the handle.
  let existing = null;
  const recordedGid = recorded?.[spec.key]?.shopifyCollectionId ?? null;
  if (recordedGid) {
    existing = await fetchById(graphql, recordedGid);
    if (!existing) notes.push(`recorded id ${recordedGid} no longer resolves — falling back to the handle probe`);
  }
  if (!existing) {
    existing = await fetchByHandle(graphql, spec.handle);
    if (existing && recordedGid) notes.push(`handle "${spec.handle}" resolves to ${existing.id}, not the recorded ${recordedGid}`);
  }

  const wantFp = desiredConditionsFingerprint(spec);

  // ── CREATE ─────────────────────────────────────────────────────────────────
  if (!existing) {
    if (!commit) return { key: spec.key, action: "would-create", gid: null, handle: spec.handle, notes };
    const input = {
      title: spec.title,
      handle: spec.handle,
      descriptionHtml,
      seo,
      sortOrder: spec.sortOrder,
      ...(spec.kind === "smart" ? { sources: [{ source: buildConditionsSourceInput(spec) }] } : {}),
    };
    const res = await graphql(
      `mutation ($input: CollectionCreateInput!) {
        collectionCreate(collection: $input) { collection { id handle } userErrors { field message } }
      }`,
      { input },
      { mutation: true }
    );
    const errs = res.collectionCreate.userErrors;
    if (errs?.length) throw new Error(`collectionCreate "${spec.key}" userErrors: ${JSON.stringify(errs)}`);
    const gid = res.collectionCreate.collection?.id;
    if (!gid) throw new Error(`collectionCreate "${spec.key}" returned no id`);
    await recordCollectionId(db, spec.key, gid, res.collectionCreate.collection.handle);
    if (onlinePublicationId) { await publishToOnlineStore(graphql, gid, onlinePublicationId); notes.push("published to the Online Store channel"); }
    return { key: spec.key, action: "created", gid, handle: res.collectionCreate.collection.handle, notes };
  }

  // ── RECONCILE ──────────────────────────────────────────────────────────────
  const haveFp = actualConditionsFingerprint(existing.sources);
  // Rule-bearing only. The selection-only source holding a manual collection's
  // products must survive every run — deleting it would empty the collection.
  const conditionSourceIds = ruleBearingSources(existing.sources).map((s) => s.id);

  const diffs = [];
  if (existing.title !== spec.title) diffs.push("title");
  if (existing.handle !== spec.handle) diffs.push("handle");
  if (existing.descriptionHtml !== descriptionHtml) diffs.push("description");
  if (existing.seo?.title !== seo.title) diffs.push("seo.title");
  if (existing.seo?.description !== seo.description) diffs.push("seo.description");
  if (existing.sortOrder !== spec.sortOrder) diffs.push("sortOrder");
  const conditionsDiffer = haveFp !== wantFp;
  if (conditionsDiffer) {
    diffs.push("conditions");
    notes.push(
      spec.kind === "smart"
        ? `conditions drift: shop holds ${JSON.stringify(haveFp)}, map wants ${JSON.stringify(wantFp)}`
        : `a manual collection is carrying ${conditionSourceIds.length} RULE-bearing source(s) — removing (its membership source is untouched)`
    );
  }

  if (!diffs.length) {
    // Publication is not part of the field diff — check it every run, because a
    // collection unpublished in the admin is invisible while looking correct.
    if (commit && onlinePublicationId) await publishToOnlineStore(graphql, existing.id, onlinePublicationId);
    if (recordedGid !== existing.id) {
      if (commit) await recordCollectionId(db, spec.key, existing.id, existing.handle);
      notes.push("re-recorded the id");
    }
    return { key: spec.key, action: "noop", gid: existing.id, handle: existing.handle, notes };
  }

  if (!commit) {
    notes.unshift(`differs: ${diffs.join(", ")}`);
    return { key: spec.key, action: "would-update", gid: existing.id, handle: existing.handle, notes };
  }

  const input = {
    id: existing.id,
    title: spec.title,
    handle: spec.handle,
    descriptionHtml,
    seo,
    sortOrder: spec.sortOrder,
    ...(conditionsDiffer
      ? {
          // Delete-and-recreate rather than a field-level source update: a
          // conditions source is derived state, so replacing it wholesale is
          // safe and is the only way to converge from an unknown shape. Both
          // halves ride ONE mutation, so the collection is never sourceless.
          ...(conditionSourceIds.length ? { sourcesToDelete: conditionSourceIds } : {}),
          ...(spec.kind === "smart" ? { sourcesToCreate: [{ source: buildConditionsSourceInput(spec) }] } : {}),
        }
      : {}),
  };
  const res = await graphql(
    `mutation ($input: CollectionUpdateInput!) {
      collectionUpdate(collection: $input) { collection { id handle } userErrors { field message } }
    }`,
    { input },
    { mutation: true }
  );
  const errs = res.collectionUpdate.userErrors;
  if (errs?.length) throw new Error(`collectionUpdate "${spec.key}" userErrors: ${JSON.stringify(errs)}`);
  await recordCollectionId(db, spec.key, existing.id, res.collectionUpdate.collection.handle);
  if (onlinePublicationId) await publishToOnlineStore(graphql, existing.id, onlinePublicationId);
  notes.unshift(`updated: ${diffs.join(", ")}`);
  return { key: spec.key, action: "updated", gid: existing.id, handle: res.collectionUpdate.collection.handle, notes };
}

/**
 * Every collection in the map, in declaration order. Refuses the WHOLE run up
 * front if any collection fails compliance — a half-built navigation is worse
 * than none, and a trigger in one title is a code fix, not a per-item skip.
 */
export async function ensureAllCollections(graphql, db, { commit = false } = {}) {
  const bad = COLLECTIONS.map((c) => ({ key: c.key, ...validateCollectionPayload(c) })).filter((v) => !v.ok);
  if (bad.length) {
    throw new Error(
      "REFUSING the whole run — collections fail compliance: " +
        bad.map((b) => `${b.key} (${b.violations.map((v) => `${v.field}: ${v.problem}`).join(", ")})`).join("; ")
    );
  }
  const recorded = await readCollectionIds(db);
  const onlinePublicationId = commit ? await requireOnlineStorePublication(graphql) : null;
  const results = [];
  for (const spec of COLLECTIONS) {
    try {
      results.push(await ensureCollection(graphql, db, spec, { commit, recorded, onlinePublicationId }));
    } catch (e) {
      results.push({ key: spec.key, action: "failed", gid: null, handle: spec.handle, notes: [String(e?.message || e)] });
    }
  }
  return results;
}

/**
 * key → gid for the collections that exist, read from RTDB. The reconciler's
 * lookup: it must NEVER guess a collection id or create one mid-publish.
 */
export async function collectionGidsByKey(db) {
  const recorded = await readCollectionIds(db);
  const out = {};
  for (const [key, node] of Object.entries(recorded)) {
    if (COLLECTION_BY_KEY.has(key) && node?.shopifyCollectionId) out[key] = node.shopifyCollectionId;
  }
  return out;
}

/** Just the MANUAL collections' gids — the only membership anything may write. */
export function manualGidsFrom(gidsByKey) {
  return Object.entries(gidsByKey ?? {})
    .filter(([key]) => COLLECTION_BY_KEY.get(key)?.kind === "manual")
    .map(([, gid]) => gid);
}

// ── MEMBERSHIP ───────────────────────────────────────────────────────────────
// Two hard rules, both enforced here rather than trusted to callers:
//
//   1. SMART COLLECTIONS ARE SHOPIFY'S. Nothing here ever joins or leaves one —
//      `managedGids` is the manual set only. New In / Sale / Under R500
//      re-evaluate themselves and a written membership would fight them.
//   2. A COLLECTION WE DID NOT MAKE IS NOT OURS TO EMPTY. `leave` is filtered to
//      collections in the map. A merchandising collection built by hand in the
//      Shopify admin keeps its products through every reconciler run.
//
// One internal category lands in exactly one collection, so joining the desired
// one means leaving every OTHER managed one — that is how a product follows its
// category when the record is re-categorised.
//
// desiredGid null (unmapped/unknown category) means "leave the managed ones,
// join nothing". The product stays published and stays in New In; it just has
// no category home. The caller warns; this function does not decide policy.
export function planCollectionMembership(currentGids, desiredGid, managedGids) {
  const managed = new Set(managedGids ?? []);
  const current = new Set(currentGids ?? []);
  return {
    join: desiredGid && !current.has(desiredGid) ? [desiredGid] : [],
    leave: [...current].filter((gid) => managed.has(gid) && gid !== desiredGid),
  };
}

/** The product's CURRENT collection gids. Refuses a >100 set rather than acting on a partial read. */
export async function readProductCollections(graphql, productGid) {
  const d = await graphql(
    `query ($id: ID!) { product(id: $id) { collections(first: 100) { pageInfo { hasNextPage } nodes { id } } } }`,
    { id: productGid }
  );
  const c = d.product?.collections;
  if (!c) throw new Error(`product ${productGid} not found while reading its collections`);
  if (c.pageInfo.hasNextPage) {
    throw new Error(`product ${productGid} is in >100 collections — refusing to act on a partial read`);
  }
  return c.nodes.map((n) => n.id);
}

/** Apply a plan. A no-op plan makes NO Shopify call. Returns the plan it applied. */
export async function applyCollectionMembership(graphql, productGid, plan) {
  if (!plan.join.length && !plan.leave.length) return plan;
  const res = await graphql(
    `mutation ($input: ProductUpdateInput!) {
      productUpdate(product: $input) { product { id } userErrors { field message } }
    }`,
    {
      input: {
        id: productGid,
        ...(plan.join.length ? { collectionsToJoin: plan.join } : {}),
        ...(plan.leave.length ? { collectionsToLeave: plan.leave } : {}),
      },
    },
    { mutation: true }
  );
  const errs = res.productUpdate.userErrors;
  if (errs?.length) throw new Error(`collection membership userErrors: ${JSON.stringify(errs)}`);
  return plan;
}
