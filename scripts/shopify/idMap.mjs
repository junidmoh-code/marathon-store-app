// ── The /shopify_sync ID map: RTDB product → Shopify IDs ─────────────────────
// One node per synced product, in a DEDICATED path (owner decision 2026-08-13):
//
//   /shopify_sync/{productId} = {
//     shopifyProductId: "gid://shopify/Product/…",
//     variants: {
//       {encodedSizeKey}: {
//         shopifyVariantId:       "gid://shopify/ProductVariant/…",
//         shopifyInventoryItemId: "gid://shopify/InventoryItem/…",
//       },
//     },
//   }
//
// NOT on the product record: /products is client-writable under live rules and
// the app saves whole records with set() — a lost mapping would silently cause
// duplicate product creation in Shopify. /shopify_sync is Admin-SDK-only (rule
// block in the PR description; console-managed, never in database.rules.json).
//
// Size keys use the app's one true RTDB encoding — encodeSizeKey from
// src/utils/sizeKey.js ("5.5" → "5_5", "_" sentinel passes through), the same
// cross-app contract /stock and /inventory are keyed with. Full gid:// strings
// are stored, never bare numeric IDs.
//
// The writer is IDEMPOTENT and never clobbers:
//   • no existing node                     → create
//   • existing node identical              → no-op
//   • same product, strictly NEW size keys → merge the new keys in
//   • same size key with different IDs, or a different shopifyProductId
//                                          → REFUSE loudly (human decision)
import { encodeSizeKey, assertSafeSegment } from "../../src/utils/sizeKey.js";
// Paged reader — the claim-index backfill reads the existing map in bounded
// pages rather than in one whole-node request.
import { readMapPaged } from "../lib/rtdbPaged.mjs";

// rows: [{ size, variantId, inventoryItemId }] with the ORIGINAL catalogue
// size token ("5.5", "M", "_") — never a Shopify display value like "One Size".
export function buildMapping(shopifyProductId, rows) {
  if (!shopifyProductId?.startsWith("gid://shopify/Product/")) {
    throw new Error(`shopifyProductId must be a Product gid, got: ${shopifyProductId}`);
  }
  const variants = {};
  for (const { size, variantId, inventoryItemId } of rows) {
    const key = assertSafeSegment(encodeSizeKey(size), "size key");
    if (variants[key]) throw new Error(`duplicate size key ${key} in variant rows`);
    if (!variantId?.startsWith("gid://shopify/ProductVariant/")) {
      throw new Error(`variantId must be a ProductVariant gid, got: ${variantId}`);
    }
    if (!inventoryItemId?.startsWith("gid://shopify/InventoryItem/")) {
      throw new Error(`inventoryItemId must be an InventoryItem gid, got: ${inventoryItemId}`);
    }
    variants[key] = { shopifyVariantId: variantId, shopifyInventoryItemId: inventoryItemId };
  }
  if (!Object.keys(variants).length) throw new Error("mapping has no variants");
  return { shopifyProductId, variants };
}

// Pure decision: what a write against `existing` must do. Kept separate from
// the Admin SDK so idempotency is unit-testable without an emulator.
//   → { action: "create" | "noop" | "merge", newKeys? }   or throws.
export function planIdMapWrite(existing, mapping) {
  if (existing == null) return { action: "create" };
  if (existing.shopifyProductId !== mapping.shopifyProductId) {
    throw new Error(
      `refusing to overwrite: node already maps to ${existing.shopifyProductId}, ` +
        `new mapping says ${mapping.shopifyProductId}. Two Shopify products for one ` +
        `record needs a human — delete the stale Shopify product or the stale node first.`
    );
  }
  const oldVars = existing.variants || {};
  const newKeys = [];
  for (const [key, v] of Object.entries(mapping.variants)) {
    const prev = oldVars[key];
    if (!prev) {
      newKeys.push(key);
    } else if (
      prev.shopifyVariantId !== v.shopifyVariantId ||
      prev.shopifyInventoryItemId !== v.shopifyInventoryItemId
    ) {
      throw new Error(
        `refusing to overwrite variant ${key}: existing IDs differ from the new ones ` +
          `(${prev.shopifyVariantId} vs ${v.shopifyVariantId}). Re-mapping a size needs a human.`
      );
    }
  }
  return newKeys.length ? { action: "merge", newKeys } : { action: "noop" };
}

// ── The claim index: /shopify_sync/_claims ───────────────────────────────────
// The uniqueness guarantee below — "no OTHER record already maps this Shopify
// product" — used to be enforced by a TRANSACTION ON THE /shopify_sync ROOT.
// That is correct and it was affordable at the scale the original comment
// anticipated ("handfuls; revisit with a reverse index when the sync goes
// catalogue-wide"). The sync went catalogue-wide: 3 Sep profiling measured
// ~1 MB per root transaction, three of them per created product, 22.5 MB in a
// single hour (docs/SHOPIFY-SYNC.md §9). This is that reverse index.
//
//   /shopify_sync/_claims/{numeric Shopify product id} = productId
//
// The claim is still ATOMIC and still made against the server's value — it is
// a transaction, just on ONE child instead of the whole map. A numeric key is
// used because a gid contains slashes and cannot be an RTDB path segment.
//
// The index is built ONCE, from a PAGED read (never a whole-node read), the
// first time a claim is made after this code ships; a sentinel records that it
// happened. Until it is built the index is empty and would call every existing
// gid unclaimed — hence the backfill is a precondition of the first claim, not
// a lazy nicety.
const CLAIMS_PATH = "shopify_sync/_claims";
const CLAIMS_BUILT_KEY = "_builtAt";

// How many backfill entries are written at once. One-time cost; small enough
// to stay polite to the database, large enough that a few thousand keys finish
// inside a single two-minute tick.
const CLAIM_BACKFILL_CONCURRENCY = 25;

// ── Which keys under /shopify_sync are product records ───────────────────────
// The node holds product records keyed by product id, alongside this module's
// own bookkeeping siblings. There used to be exactly one (`_collections`) and
// callers hardcoded `k !== "_collections"`; this branch added `_reconcile` and
// `_claims`, which would have walked straight through those filters and been
// processed as if they were products. The rule is the PREFIX, and it lives
// here once so the next sibling does not have to be added in five places.
export const isProductRecordKey = (key) => typeof key === "string" && !key.startsWith("_");

// A gid is "gid://shopify/Product/9339656536213". The trailing digits are the
// key. Anything else is not a Product gid and never reaches here — buildMapping
// already refuses it — but this throws rather than inventing a key.
export function claimKeyFor(shopifyProductId) {
  const m = /^gid:\/\/shopify\/Product\/(\d+)$/.exec(String(shopifyProductId || ""));
  if (!m) throw new Error(`not a Shopify Product gid: ${shopifyProductId}`);
  return m[1];
}

// Pure: what the claim transaction must do given the index entry it found.
//   → { action: "claim" | "held" | "refuse", refusal? }
export function planClaim(currentOwner, productId) {
  if (currentOwner == null) return { action: "claim" };
  if (currentOwner === productId) return { action: "held" };
  return { action: "refuse", refusal: `already claimed by record ${currentOwner}` };
}

export async function ensureClaimIndex(db) {
  const built = (await db.ref(`${CLAIMS_PATH}/${CLAIMS_BUILT_KEY}`).get()).val();
  if (built) return { built: false };
  // One paged pass over the existing map. Keys beginning with "_" are this
  // module's own bookkeeping siblings (_collections, _reconcile, _claims) and
  // are never product records.
  const all = await readMapPaged(db, "shopify_sync", { pageSize: 300 });
  const index = {};
  let n = 0;
  for (const [pid, node] of Object.entries(all)) {
    if (!isProductRecordKey(pid)) continue;
    const gid = node?.shopifyProductId;
    if (typeof gid !== "string" || !gid.startsWith("gid://shopify/Product/")) continue;
    index[claimKeyFor(gid)] = pid;
    n += 1;
  }
  // FILL GAPS, NEVER OVERWRITE. The obvious shape here is one bulk
  // `update(index)`, and it is wrong: the paged read above is not a snapshot,
  // so a claim legitimately committed while it was in flight is not in
  // `index`, and a plain update() is last-writer-wins — it would revert that
  // fresh claim to whatever the stale page said. The old root transaction was
  // correct under any overlap and this must be too, or the move to a child
  // index is a downgrade of the one guarantee it exists to provide.
  //
  // So each entry goes in under its own transaction that writes ONLY into an
  // empty slot. A key someone else has already claimed is left exactly as it
  // is: this is a backfill of history, and anything with a live owner is by
  // definition more current than the page we read.
  //
  // Bounded concurrency because this is a one-time pass over a few thousand
  // keys and the tick that runs it holds the single-flight lock.
  const entries = Object.entries(index);
  let filled = 0, kept = 0;
  for (let i = 0; i < entries.length; i += CLAIM_BACKFILL_CONCURRENCY) {
    await Promise.all(entries.slice(i, i + CLAIM_BACKFILL_CONCURRENCY).map(async ([key, owner]) => {
      const res = await db.ref(`${CLAIMS_PATH}/${key}`).transaction((cur) => (cur == null ? owner : cur));
      if (res.snapshot?.val() === owner) filled += 1; else kept += 1;
    }));
  }
  // The sentinel goes in LAST and on its own. Written first (or in the same
  // payload), a crash midway would leave the index part-built and permanently
  // marked done — and a missing entry is a gid nothing holds, which is the one
  // way a second record could claim a product that is already mapped.
  await db.ref(`${CLAIMS_PATH}/${CLAIMS_BUILT_KEY}`).set(Date.now());
  return { built: true, entries: n, filled, kept };
}

// Atomically claim a Shopify product for ONE record. Two guarantees, unchanged
// from the root-transaction version:
//   · no other record may map this gid (the transaction on the claim child);
//   · this record may not already map a DIFFERENT gid (checked against its own
//     node, a single small read).
// Throws with the same wording as before if either is violated; on success the
// record's pending {shopifyProductId} pointer exists, exactly as before.
export async function claimShopifyProduct(db, productId, shopifyProductId) {
  assertSafeSegment(productId, "productId");
  const key = claimKeyFor(shopifyProductId);
  await ensureClaimIndex(db);

  // This record's own pointer first — a record that already maps elsewhere must
  // be refused before it can take a claim it would then have to give back.
  const mineGid = (await db.ref(`shopify_sync/${productId}/shopifyProductId`).get()).val();
  if (mineGid && mineGid !== shopifyProductId) {
    throw new Error(`refusing to claim ${shopifyProductId}: record already maps to ${mineGid}`);
  }

  // Same one-shot-abort hazard writeIdMap guards below, and for the same
  // reason: returning `undefined` aborts the transaction WITHOUT a server
  // round trip, and the update function's first invocation is not guaranteed
  // the server value — it may fire against a stale local cache. A refusal
  // taken at face value there would report "already claimed by record X"
  // about an owner the server no longer has (a released claim, a claim this
  // very record holds), and the product would fail to publish for a conflict
  // that does not exist. So a refusal is CONFIRMED against a fresh server read
  // before it is thrown, and the transaction retried once if the server value
  // does not refuse. A real conflict reads the same twice and still throws.
  const ref = db.ref(`${CLAIMS_PATH}/${key}`);
  for (let attempt = 0; ; attempt++) {
    let refusal = null;
    const result = await ref.transaction((cur) => {
      refusal = null;
      const plan = planClaim(cur, productId);
      if (plan.action === "refuse") { refusal = plan.refusal; return undefined; }
      if (plan.action === "held") return cur;
      return productId;
    });
    if (refusal) {
      if (attempt === 0 && planClaim((await ref.get()).val(), productId).action !== "refuse") continue;
      throw new Error(`refusing to claim ${shopifyProductId}: ${refusal}`);
    }
    if (!result.committed) throw new Error("claim transaction did not commit");
    break;
  }

  // The durable pointer. Written AFTER the claim so a crash between the two
  // leaves an index entry naming this record and no mapping — the next attempt
  // by the SAME record finds "held" and completes; an attempt by any other
  // record is still refused, which is the direction that matters.
  // A TRANSACTION, not a set(). `mineGid` was read before the claim was taken,
  // so a plain set() here would overwrite a different gid written in between —
  // exactly the double-mapping the read at the top of this function refuses,
  // reintroduced at the bottom. Commit only into an empty slot or onto the same
  // gid; anything else aborts and is reported, leaving the other writer's value
  // alone.
  if (!mineGid) {
    let clash = null;
    await db.ref(`shopify_sync/${productId}/shopifyProductId`).transaction((cur) => {
      clash = null;   // same rule: only the LAST invocation's verdict counts
      if (cur == null || cur === shopifyProductId) return shopifyProductId;
      clash = cur;
      return undefined;
    });
    if (clash) {
      // GIVE THE CLAIM BACK. It was taken a few lines above and this record is
      // now known to map somewhere else, so holding it would block the gid for
      // every other record forever — a leak with no way back, because nothing
      // else releases a claim except the deleted-product path, and that only
      // runs for a record whose own map still points at the gid. The release is
      // ownership-checked, so it can only ever free the entry we just made.
      try {
        await releaseClaim(db, productId, shopifyProductId);
      } catch (e) {
        // Swallowed so the clash below is what surfaces — but NOT silently.
        // If this release fails, the exact leak this branch exists to prevent
        // has happened, and the clash message names the OTHER gid, not the one
        // stranded. Without this line, recovering means deducing which key is
        // stuck from a message that does not mention it.
        console.error(`  ⚠ could not release claim ${claimKeyFor(shopifyProductId)} after a pointer clash (${String(e?.message || e)}) — that claim key is now stranded and will block this gid until it is cleared by hand`);
      }
      throw new Error(`refusing to claim ${shopifyProductId}: record already maps to ${clash}`);
    }
  }
}

// Release a claim. Used only where a mapping is being removed because Shopify
// says the product does not exist — leaving the index entry behind would block
// the gid forever for a product that is gone.
//
// OWNERSHIP IS CHECKED, not assumed. An unconditional remove() frees the slot
// whoever holds it, so if the index had drifted — a legacy entry, or a claim
// re-pointed by another record — this would quietly release a claim a
// different, still-live product legitimately holds, and the gid could then be
// double-claimed with nothing left to stop it. The uniqueness guarantee is the
// entire reason this index exists; it must not be undone by a cleanup path.
// A transaction that removes ONLY our own entry keeps it. Returns what it did.
export async function releaseClaim(db, productId, shopifyProductId) {
  assertSafeSegment(productId, "productId");
  // `outcome` is reset at the TOP of every invocation, like `refusal` and
  // `clash` elsewhere in this file. The callback may run more than once — the
  // first against a local cache, again against the server value on a conflict —
  // and only the last invocation describes what happened. Setting it without
  // clearing it lets an earlier invocation's verdict survive into the answer:
  // a first pass seeing null ("absent") followed by a real release would still
  // report "absent", and the caller logs that as "nothing to do".
  let outcome = "released";
  await db.ref(`${CLAIMS_PATH}/${claimKeyFor(shopifyProductId)}`).transaction((cur) => {
    outcome = "released";
    // `undefined` ABORTS with no write. Returning `cur` on these two paths
    // committed a write of the value that was already there — a pointless
    // round trip and a change event on a key nothing changed, from a function
    // whose whole job on those paths is to decline.
    if (cur == null) { outcome = "absent"; return undefined; }
    if (cur !== productId) { outcome = "held-by-other"; return undefined; }
    return null;   // null DELETES the key, which is the release
  });
  return outcome;
}

// db = admin.database(). Returns the plan it executed.
//
// Runs as an RTDB TRANSACTION, not read-then-write: two concurrent writers
// (or a writer racing a partial earlier run) each get planIdMapWrite re-run
// against the CURRENT server value, so a conflicting mapping aborts instead
// of silently replacing what the other writer just committed. The update
// function may be invoked more than once (first against the local cache) —
// plan and conflict are recomputed every invocation and only the final,
// committed invocation's plan is returned.
export async function writeIdMap(db, productId, mapping) {
  const ref = db.ref(`shopify_sync/${assertSafeSegment(productId, "productId")}`);
  for (let attempt = 0; ; attempt++) {
    let plan = null;
    let conflict = null;
    const result = await ref.transaction((existing) => {
      conflict = null;
      try {
        plan = planIdMapWrite(existing, mapping);
      } catch (e) {
        conflict = e;
        return undefined; // abort the transaction, existing data untouched
      }
      if (plan.action === "noop") return existing;
      if (plan.action === "create") return mapping;
      const merged = { ...existing, variants: { ...(existing.variants || {}) } };
      for (const key of plan.newKeys) merged.variants[key] = mapping.variants[key];
      return merged;
    });
    if (conflict) {
      // An abort is one-shot and may have fired against a STALE LOCAL CACHE
      // (the update function's first invocation is not guaranteed the server
      // value). Confirm against a fresh server read before surfacing it —
      // planIdMapWrite throws here iff the conflict is real; otherwise retry
      // the transaction once with the cache now warmed.
      if (attempt === 0) {
        planIdMapWrite((await ref.get()).val(), mapping);
        continue;
      }
      throw conflict;
    }
    if (!result.committed) throw new Error("ID-map transaction did not commit");
    return plan;
  }
}
