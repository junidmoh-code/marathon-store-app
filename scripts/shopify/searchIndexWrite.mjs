// ── Keeping the search index fresh as products go live and come off ──────────
// The full rebuild (build-search-index.mjs) is the ground truth and can be run
// at any time. This is the INCREMENTAL half: the reconciler calls it at the
// exact moment it confirms a product on or off, so the index tracks the
// storefront within one reconciler tick (two minutes on the Mac mini) instead
// of waiting for someone to remember to rebuild.
//
// Two entry points and one rule between them: a document exists at
// /search_index/docs/{pid} IF AND ONLY IF that product is confirmed ON. A
// search result that leads to an unpublished product is worse than no result,
// so coming off REMOVES the document rather than flagging it.
//
// BEST EFFORT, DELIBERATELY. A failure here must never turn a successful
// publish into a refusal — the product IS live, and the worst case is that it
// is missing from search until the next rebuild. So both functions swallow
// their errors into a warning and return a status the caller logs.
import { buildIndexDoc, SEARCH_INDEX_PATH } from "./searchIndexDoc.mjs";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";

// Stamping meta.version on every write is what makes the endpoint notice. It
// polls a few bytes at /search_index/meta and reloads the corpus only when this
// number changes, so an incremental write costs the endpoint one small read and
// one reload — not a read per query.
async function bumpVersion(db, note) {
  await db.ref(`${SEARCH_INDEX_PATH}/meta`).update({
    version: Date.now(),
    touchedAt: new Date().toISOString(),
    touchedBy: note,
  });
}

/** A product just went ON: upsert its document. → "indexed" | "skipped: …" */
export async function indexProductLive(db, pid, { product, shopifyProduct, collection }) {
  assertSafeSegment(pid, "productId");
  try {
    const doc = buildIndexDoc({ product, shopifyProduct, collection });
    if (!doc.handle) return "skipped: no handle on the Shopify read-back";
    await db.ref(`${SEARCH_INDEX_PATH}/docs/${pid}`).set(doc);
    await bumpVersion(db, "script:reconcile(on)");
    return "indexed";
  } catch (e) {
    console.error(`  ⚠ ${pid}: search index write failed (${String(e?.message || e)}) — the product IS live; it will be missing from search until the next build-search-index run`);
    return `failed: ${String(e?.message || e)}`;
  }
}

/** A product went OFF (or was refused): remove its document. */
export async function unindexProduct(db, pid, why = "off") {
  assertSafeSegment(pid, "productId");
  try {
    const ref = db.ref(`${SEARCH_INDEX_PATH}/docs/${pid}`);
    // Only bump the version if something was actually there. An off-product
    // that was never indexed is the common case, and pointlessly bumping would
    // make every endpoint instance re-download the corpus for no change.
    const existed = (await ref.get()).exists();
    if (!existed) return "not-indexed";
    await ref.remove();
    await bumpVersion(db, `script:reconcile(${why})`);
    return "unindexed";
  } catch (e) {
    console.error(`  ⚠ ${pid}: search index removal failed (${String(e?.message || e)}) — it may still answer searches with a link to an unpublished product until the next build-search-index run`);
    return `failed: ${String(e?.message || e)}`;
  }
}

// ── THE SELF-HEALING SWEEP — why the index cannot rot again ──────────────────
// The per-product hooks above only fire when the reconciler CHANGES a state.
// That was not enough, and the live numbers said so: on 2026-08-17 the index
// held 200 documents while 373 products were live. 173 products — 46% of the
// storefront — were unfindable, and not one of them for want of identity. The
// index had been built once and never refreshed.
//
// Anything that can drift silently, will. So every commit run ends by
// COMPARING the two sets and repairing the difference:
//
//   live but not indexed  → index it (the 173)
//   indexed but not live  → remove it (a result leading to an unpublished
//                           product is worse than no result)
//
// COST. The live set is already in memory — the reconciler read
// /shopify_publish to build its worklist. The indexed set is one REST
// ?shallow=true read: KEYS ONLY, a few KB, no document bodies. So a healthy
// tick costs one small read and zero writes, and the expensive part (a Shopify
// read per product) happens only for products that are actually missing.
//
// BEST EFFORT, like everything else here. A sweep failure is a warning; the
// reconciler's real work has already succeeded by the time it runs.
import { shallowKeys } from "../lib/rtdbPaged.mjs";

export async function sweepSearchIndex(db, adminApp, {
  livePids, buildDoc, max = 50,
} = {}) {
  const summary = { indexed: 0, removed: 0, missing: 0, orphans: 0, capped: false, failed: 0 };
  let indexedPids;
  try {
    indexedPids = new Set(await shallowKeys(adminApp, `${SEARCH_INDEX_PATH}/docs`));
  } catch (e) {
    console.error(`  ⚠ search-index sweep skipped — could not list the index (${String(e?.message || e)})`);
    return { ...summary, skipped: true };
  }
  const live = new Set(livePids);
  const missing = [...live].filter((pid) => !indexedPids.has(pid));
  const orphans = [...indexedPids].filter((pid) => !live.has(pid));
  summary.missing = missing.length;
  summary.orphans = orphans.length;
  if (!missing.length && !orphans.length) return summary;

  // Removals first, and uncapped: they are cheap (no Shopify read) and they
  // are the half with a customer consequence — an orphan answers searches with
  // a link to a product that is no longer published.
  for (const pid of orphans) {
    const r = await unindexProduct(db, pid, "sweep");
    if (r === "unindexed") summary.removed += 1;
    else if (String(r).startsWith("failed")) summary.failed += 1;
  }

  // Additions are capped per run: each needs a Shopify read, and a 173-product
  // catch-up must not turn a two-minute tick into a rate-limit incident. The
  // remainder is picked up by the next tick, and the cap is REPORTED rather
  // than silently truncating.
  const take = missing.slice(0, max);
  summary.capped = missing.length > take.length;
  for (const pid of take) {
    try {
      const doc = await buildDoc(pid);
      if (!doc) { summary.failed += 1; continue; }
      const r = await indexProductLive(db, pid, doc);
      if (r === "indexed") summary.indexed += 1; else summary.failed += 1;
    } catch (e) {
      summary.failed += 1;
      console.error(`  ⚠ ${pid}: sweep could not index it (${String(e?.message || e)})`);
    }
  }
  return summary;
}
