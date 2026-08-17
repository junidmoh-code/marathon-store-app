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

// The most a healthy sweep should ever remove, as a fraction of the index. A
// real day sees a handful of products come off; anything approaching the whole
// index means the LIVE set is wrong, not that the shop emptied.
const MAX_REMOVAL_FRACTION = 0.5;

export async function sweepSearchIndex(db, adminApp, {
  livePids, buildDoc, max = 50,
} = {}) {
  const summary = { indexed: 0, removed: 0, missing: 0, orphans: 0, capped: false, failed: 0 };

  // ── THE FLOOR, and it is the most important line in this file ─────────────
  // Every doc in the index is an "orphan" the moment livePids is empty, and the
  // removal loop below is uncapped. readAllPublishNodes returns `{}` on a read
  // that comes back empty for ANY reason — a momentary permission problem, a
  // wiped node, a bad deploy — so one bad tick could delete the entire
  // storefront search index. That is the exact failure this whole file exists
  // to prevent, inverted and worse: 0 documents instead of 200.
  //
  // A live storefront with ZERO live products is not a state this sweep should
  // ever act on. If it is genuinely true, the per-product OFF hook has already
  // removed each one as it went; there is nothing here to do that has not been
  // done. So refuse, loudly. (Review finding, 2026-08-17.)
  if (!Array.isArray(livePids) || livePids.length === 0) {
    console.error(
      "  ⚠ search-index sweep REFUSED — the live set is empty. Every indexed " +
      "product would have been treated as an orphan and removed. If the shop " +
      "really has nothing live, the per-product hooks have already cleared the " +
      "index; otherwise /shopify_publish did not read correctly."
    );
    return { ...summary, skipped: true, refused: "empty live set" };
  }
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

  // A SECOND FLOOR, for the case the first cannot see: livePids is non-empty
  // but badly short (a truncated read, a half-applied migration). Removing most
  // of the index is never a routine outcome, so it needs a human rather than a
  // best guess.
  const removalLimit = Math.max(1, Math.floor(indexedPids.size * MAX_REMOVAL_FRACTION));
  if (orphans.length > removalLimit) {
    console.error(
      `  ⚠ search-index sweep REFUSED the removals — ${orphans.length} of ` +
      `${indexedPids.size} indexed products look orphaned (over the ${Math.round(MAX_REMOVAL_FRACTION * 100)}% ceiling). ` +
      `That is a bad live set far more often than it is a real take-down. ` +
      `Additions still applied. Run build-search-index.mjs --commit if the index really should shrink.`
    );
    summary.refused = "removal ceiling";
  } else {
    // Otherwise uncapped: removals are cheap (no Shopify read) and they are the
    // half with a customer consequence — an orphan answers searches with a link
    // to a product that is no longer published.
    for (const pid of orphans) {
      const r = await unindexProduct(db, pid, "sweep");
      if (r === "unindexed") summary.removed += 1;
      else if (String(r).startsWith("failed")) summary.failed += 1;
    }
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
