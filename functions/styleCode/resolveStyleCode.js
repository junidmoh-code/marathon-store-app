// ─── resolveStyleCode CALLABLE — ONE SIGNATURE, THREE TIERS ──────────────────
// The single entry point the client uses to turn a manufacturer style code into
// a product identity. Everything about HOW that happens lives behind this call:
// the client passes a code and gets back an answer, and never learns (or cares)
// which tier produced it.
//
//   TIER 1  /sneaker_models cache   free, instant, permanent
//   TIER 2  KicksDB catalog API     costs a request; key from a Firebase secret
//   TIER 3  web-search fallback     stub, always not-found (reserved)
//
// See functions/lib/style-code-providers.cjs for the provider contract. Tiers are
// swappable without touching this file or any caller.
//
// ── WHY THE KEY LIVES HERE AND NOT IN THE BROWSER ────────────────────────────
// KICKSDB_API_KEY is a Firebase secret read inside this function. The client
// NEVER calls the vendor directly and never sees the key. Bundling a vendor key
// into a PWA publishes it to every device in every shop.
//
// ── WHAT THIS FUNCTION WILL NOT DO ───────────────────────────────────────────
// It does not write to /products. It does not rename, re-photo or re-categorise
// anything. Its only writes are the /sneaker_models cache entry (new knowledge,
// never a product) and a /duplicate_candidates flag (a note for a human, never a
// merge). Confirming suggested data onto a product is a separate, human-gated
// step — see captureStyleCode.
//
// DEPLOY (scoped, when the owner chooses to):
//   firebase deploy --only functions:resolveStyleCode

"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

const {
  SNEAKER_MODELS_PATH,
  defaultProviders,
  resolveThroughProviders,
  verifyStyleCodeMatch,
} = require("../lib/style-code-providers.cjs");
const {
  normaliseStyleCode,
  formatStyleCodeForDisplay,
  styleCodeQueryCandidates,
  styleCodeFormat,
  brandFamilyForStyleCode,
} = require("../lib/style-code.cjs");
const { confusableVariants } = require("../lib/style-code-ocr.cjs");
const { claimOwnerIds, partitionPairs } = require("../lib/style-code-siblings.cjs");
const { assertStyleCodeAccess } = require("./access.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

const kicksDbApiKey = defineSecret("KICKSDB_API_KEY");

const DUPLICATE_CANDIDATES_PATH = "duplicate_candidates";
const STYLE_CODE_MISSES_PATH = "style_code_misses";

// ── /style_code_index IS THE AUTHORITY ON WHO OWNS A CODE ────────────────────
// Uniqueness is CLAIMED, not checked. Intake writes /style_code_index/{code}
// create-once BEFORE it creates the product; the rules make the second writer
// lose. So this node — not a /products scan — answers "does this code already
// belong to something?".
//
// The /products scan below is still needed, but for a DIFFERENT question: it
// finds catalogue rows that carry a code without ever having claimed it (rows
// that predate the index, or a backfill). The index can only ever hold ONE
// claim, so a two-product collision is invisible there and visible only in the
// scan. Both are reported; only the index is authoritative.
//
// Reading the claim also catches the one failure the claim-first order can
// leave behind: a claim whose productId names a product that does not exist
// (the claim landed, the product write then failed). That is an ORPHAN, and
// intake must be told — otherwise the code looks taken and nothing owns it.
const STYLE_CODE_INDEX_PATH = "style_code_index";

// A claim can now name SEVERAL owners: the primary claimant plus registered
// colourway siblings (see lib/style-code-siblings.cjs — one printed code on
// two real colourways is manufacturer behaviour, not a data error). A legacy
// claim with no siblings child reads as exactly one owner, so nothing that
// consumed the old shape changes meaning. The RAW node rides along so the
// duplicate partition below can ask "are these two both owners?".
async function readClaim(db, normalised) {
  const val = (await db.ref(`${STYLE_CODE_INDEX_PATH}/${normalised}`).get()).val();
  if (!val || typeof val.productId !== "string" || !val.productId) return null;
  const owners = claimOwnerIds(val);
  return {
    productId: val.productId,
    claimedAt: Number(val.claimedAt) || null,
    claimedBy: val.claimedBy || null,
    siblingIds: owners.slice(1),
    node: val,
  };
}

// ── /duplicate_candidates IS KEYED BY PAIR, NOT BY CODE ──────────────────────
// The live rules validate this node as a PAIR record: productIdA, productIdB,
// reason (enum) and detectedAt are required, and status is an enum. A record
// keyed by style code holding a productIds ARRAY is rejected at write time and
// looks like a silent no-op in the UI.
//
// So N products on one code become N-1 pair rows, each pairing the
// lowest-sorted id with one of the others. The key is derived from the two ids
// (sorted), which makes it DETERMINISTIC: re-detecting the same collision
// rewrites the same row instead of piling up duplicates of the duplicate report.
const DUP_REASON_STYLE_CODE = "styleCodeCollision";

function duplicatePairId(idA, idB) {
  const [a, b] = [String(idA), String(idB)].sort();
  return `${a}__${b}`;
}

/** Every pair to record for a set of colliding product ids. */
function duplicatePairs(productIds) {
  const sorted = [...productIds].map(String).sort();
  const anchor = sorted[0];
  return sorted.slice(1).map((other) => ({
    pairId: duplicatePairId(anchor, other),
    productIdA: anchor,
    productIdB: other,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Which products already CARRY this code? (collision detection, not authority)
// ─────────────────────────────────────────────────────────────────────────────
// Queries the live `.indexOn: ["styleCodeNormalised"]` on /products. This finds
// catalogue rows stamped with a code — including rows that never claimed it —
// so it is how a two-product collision becomes visible. It does NOT decide
// ownership; readClaim() above does.
async function findProductsByStyleCode(db, normalised) {
  const snap = await db.ref("products").orderByChild("styleCodeNormalised").equalTo(normalised).get();
  const val = (snap && snap.val()) || {};
  return Object.keys(val)
    .filter((id) => val[id] && normaliseStyleCode(val[id].styleCodeNormalised) === normalised)
    .sort()
    .map((id) => ({
      id,
      name: val[id].name || null,
      photoUrl: val[id].photoUrl || null,
      category: val[id].category || null,
      productType: val[id].productType || null,
      styleCode: val[id].styleCode || null,
    }));
}

// Two products answering to ONE style code is a data problem a human has to
// look at — one of them is mislabelled, or the same shoe was added twice. We
// record the pair(s) and raise a banner. We never merge, never pick a winner,
// and never delete: an automatic merge here would destroy stock history.
//
// UNLESS the two are registered SIBLINGS of the code. A human already answered
// "different colourway" for that pair (or its ownership was registered through
// intake's sibling path), so the sharing is legitimate and flagging it would
// re-open a question that was settled — sibling pairs are filtered OUT before
// this function is called. See lib/style-code-siblings.cjs.
async function flagDuplicates(db, normalised, pairs, actor, nowMs) {
  await Promise.all(pairs.map(async ({ pairId, productIdA, productIdB }) => {
    const ref = db.ref(`${DUPLICATE_CANDIDATES_PATH}/${pairId}`);
    const prior = (await ref.get()).val();

    // ── NEVER REOPEN A PAIR A HUMAN HAS CLOSED ──────────────────────────────
    // pairId is deterministic, so re-detecting the same collision targets the
    // same row. A blind .set() would rewrite status to "open" every time.
    // And a style-code collision is PERMANENT until someone merges the
    // products — both records keep the code, so every future scan of that shoe
    // re-detects it. Rewriting the status would therefore reopen the row on
    // every scan and the duplicate queue could never be cleared, which
    // contradicts SCHEMA.md's "a human closes it; nothing else does".
    // (CodeRabbit, PR #312.)
    //
    // So: an existing row keeps its status AND its original detectedAt (when
    // the collision was first seen is the useful fact, not when it was last
    // re-observed). Only a genuinely new row is born "open".
    const status = prior && typeof prior.status === "string" ? prior.status : "open";
    const detectedAt = prior && Number.isFinite(Number(prior.detectedAt)) ? Number(prior.detectedAt) : nowMs;
    // A human's "same shoe" answer (styleCodeSibling) is the strongest
    // evidence this row can carry — stronger than any scan collision. It must
    // survive re-detection exactly like status and detectedAt do, or the next
    // scan of the same code erases it.
    const answeredSameShoeBy = prior && prior.answeredSameShoeBy ? prior.answeredSameShoeBy : null;
    const answeredSameShoeAt = prior && Number.isFinite(Number(prior.answeredSameShoeAt))
      ? Number(prior.answeredSameShoeAt) : null;

    await ref.set({
      ...(answeredSameShoeBy ? { answeredSameShoeBy } : {}),
      ...(answeredSameShoeAt ? { answeredSameShoeAt } : {}),
      productIdA,
      productIdB,
      reason: DUP_REASON_STYLE_CODE, // enum: styleCodeCollision | manual | heuristic
      status,                        // enum: open | merged | dismissed — a human closes it
      detectedAt,
      // Context. The live rule permits additional children ($other validator is
      // true) and validates both of these explicitly. NOTE the field is
      // styleCodeNormalised, NOT styleCode — the rule validates a string of at
      // most 32 characters, which the normalised form always satisfies.
      styleCodeNormalised: normalised,
      detectedBy: actor ? actor.uid : null,
    });
  }));
  return pairs.map((p) => p.pairId);
}

// ── COVERAGE BY BRAND ────────────────────────────────────────────────────────
// The KicksDB free tier is StockX-sourced, so it is materially thinner on
// adidas, Puma and Reebok than on Jordan and Dunk. Every miss is recorded with
// the brand family the code's SHAPE implies, so coverage can be MEASURED per
// brand instead of guessed at — and so the decision to pay for a tier, or to
// build tier 3, is made against numbers.
//
// Keyed by the normalised code, so repeat misses of the same shoe update one row
// (with a count) instead of flooding the node.
async function logMiss(db, normalised, { actor, nowMs, errors }) {
  const ref = db.ref(`${STYLE_CODE_MISSES_PATH}/${normalised}`);
  const prior = (await ref.get()).val() || {};
  await ref.set({
    styleCodeNormalised: normalised,
    styleCode: formatStyleCodeForDisplay(normalised),
    brandFamily: brandFamilyForStyleCode(normalised), // shape-derived; observability only
    format: styleCodeFormat(normalised),
    misses: (Number(prior.misses) || 0) + 1,
    firstMissedAt: Number(prior.firstMissedAt) || nowMs,
    lastMissedAt: nowMs,
    lastMissedBy: actor ? actor.uid : null,
    // Distinguishes "the catalog does not have this shoe" (coverage gap, the
    // number we care about) from "the tier was broken" (an outage, which must
    // NOT be counted as a coverage gap).
    lastErrors: Array.isArray(errors) && errors.length ? JSON.stringify(errors) : null,
  });
}

/**
 * The resolve core — injectable db/providers/clock so it is unit-testable
 * without firebase-admin or a network (mirrors runComplete in displayChecks).
 *
 * @param {object} opts
 *   code                  what the human typed, or what OCR read
 *   providers             the tier chain
 *   confusableRetry       enable TIER 3 (see below). Off by default: a human
 *                         who TYPED a code did not misread it, so manual entry
 *                         must not pay for variant lookups. A camera read does.
 *   maxConfusableLookups  hard cap on variant lookups (each can reach metered quota)
 *
 * @returns {object} see the return statement — `normalised` is always the
 *   EFFECTIVE identity, which is the corrected code when tier 3 fired.
 */
async function runResolve(db, {
  code, providers, actor, nowMs, confusableRetry = false, maxConfusableLookups = 6,
}) {
  const typedNormalised = normaliseStyleCode(code);
  if (!typedNormalised) {
    return { kind: "reject", code: "empty-code" };
  }

  // Three independent questions, asked at once for the common path: what IS
  // this code (tier walk), who OWNS it (the claim — authoritative), and what
  // already carries it (the collision scan).
  let [chain, claim, existingProducts] = await Promise.all([
    resolveThroughProviders(providers, {
      normalised: typedNormalised,
      raw: typeof code === "string" ? code : "",
      candidates: styleCodeQueryCandidates(code),
    }),
    readClaim(db, typedNormalised),
    findProductsByStyleCode(db, typedNormalised),
  ]);

  // ── TIER 3 — CONFUSABLE-CHARACTER RETRY (lookup only, no new vision call) ──
  // OCR reliably confuses 0/O, 1/I, 8/B, 5/S and 2/Z on a small printed label.
  // When a code misses everywhere, the likeliest explanation is one misread
  // glyph — so we retry the LOOKUP with the plausible misreadings. No image is
  // re-processed; this tier costs only the lookups it makes, and the cache tier
  // answers most variants for free.
  //
  // WHEN A VARIANT ANSWERS, THE VARIANT BECOMES THE IDENTITY. Caching the found
  // model under the MISREAD code would poison the cache permanently and stamp a
  // product with a style code that does not exist on any shoe. So the effective
  // code changes, and ownership/collision are re-asked about the corrected one.
  let correctedFrom = null;
  let normalised = typedNormalised;
  if (!chain.model && confusableRetry) {
    for (const variant of confusableVariants(typedNormalised, { max: maxConfusableLookups })) {
      const attempt = await resolveThroughProviders(providers, {
        normalised: variant,
        raw: variant,
        candidates: styleCodeQueryCandidates(variant),
      });
      if (attempt.model) {
        chain = attempt;
        correctedFrom = typedNormalised;
        normalised = variant;
        // Re-ask ownership and collisions about the code we actually resolved.
        [claim, existingProducts] = await Promise.all([
          readClaim(db, normalised),
          findProductsByStyleCode(db, normalised),
        ]);
        break;
      }
    }
  }

  // CACHE EVERY SUCCESSFUL EXTERNAL RESOLVE. This is the whole point of tier 1:
  // pay a vendor once per code, for the lifetime of the business.
  //
  // CREATE-ONCE. /sneaker_models is create-once in the rules, and an admin-SDK
  // write bypasses rules — so an unconditional set() here would quietly do the
  // one thing the rules exist to prevent. We therefore read first and only
  // write into an EMPTY slot. The single case where an existing row is wrong
  // (its own styleCode disagrees with its key, so tier 1 declined it) is a
  // deliberate, logged correction rather than an incidental overwrite.
  //
  // A cache-write failure must NOT fail the resolve — the answer in hand is
  // still correct, we just pay for it again next time.
  let cached = false;
  let cacheCorrected = false;
  if (chain.model && !chain.fromCache) {
    try {
      const slot = db.ref(`${SNEAKER_MODELS_PATH}/${normalised}`);
      const occupant = (await slot.get()).val();

      // ── THE SIGNAL IS THE OCCUPANT, NOT `fromCache` ──────────────────────
      // The previous version inferred "the stored row is corrupt" from
      // `!chain.fromCache`, which conflates two different things: tier 1 READ
      // the row and refused it, versus tier 1 could not read AT ALL (an RTDB
      // error — resolveThroughProviders records it and walks on). In the second
      // case the stored row may be perfectly valid, and we would overwrite it
      // and report `cacheCorrected: true` for a correction that was never
      // justified. The same happens if an admin fixes the row between the
      // tier-1 read and this one. So ask the row itself. (CodeRabbit #312.)
      //
      // FAIL CLOSED: an occupant we cannot VERIFY — absent, malformed, or
      // carrying a styleCode that does not normalise to this key — is treated
      // as ABSENT and re-fetched. It is never treated as valid.
      if (!occupant) {
        await slot.set(chain.model);
        cached = true;
      } else if (verifyStyleCodeMatch(occupant.styleCode, normalised)) {
        // A VERIFIED row is left alone. Tier 1 must simply have failed to read
        // it; overwriting would be an unjustified write to a create-once node.
        console.warn(`resolveStyleCode: /sneaker_models/${normalised} already holds a valid row ` +
          `that tier 1 did not serve (likely a read error) — leaving it untouched`);
      } else {
        // Verification failed ⇒ unusable ⇒ treated as absent. This is the only
        // overwrite this function ever performs, and it is logged loudly.
        console.warn(`resolveStyleCode: CORRECTING unverifiable /sneaker_models/${normalised} ` +
          `(stored styleCode ${JSON.stringify(occupant.styleCode)} does not match its key)`);
        await slot.set(chain.model);
        cached = true;
        cacheCorrected = true;
      }
    } catch (err) {
      console.warn(`resolveStyleCode: cache write failed for ${normalised}:`, err && err.message);
    }
  }

  // A miss is data, not just an absence — record it so catalog coverage can be
  // measured per brand. Logged against the code as READ, because that is the
  // code the catalog actually failed on. Never let bookkeeping fail the lookup.
  if (!chain.model) {
    try {
      await logMiss(db, typedNormalised, { actor, nowMs, errors: chain.errors });
    } catch (err) {
      console.warn(`resolveStyleCode: miss log failed for ${typedNormalised}:`, err && err.message);
    }
  }

  // ORPHAN CHECK — a claim whose product does not exist. Only asked when the
  // claimed id is not already in the scan results, so the common path costs no
  // extra read.
  let claimOrphaned = false;
  if (claim && !existingProducts.some((p) => p.id === claim.productId)) {
    try {
      claimOrphaned = !(await db.ref(`products/${claim.productId}/id`).get()).exists();
    } catch (err) {
      // Advisory flag only, and the ONE unguarded await left after the tier
      // walk. Every other post-resolve write here states the same policy —
      // bookkeeping must never fail the lookup — and this read was the
      // exception: a rejection would discard an answer we had already obtained
      // and paid the vendor for. Degrade to "not orphaned". (CodeRabbit #312.)
      console.warn(`resolveStyleCode: orphan probe failed for ${claim.productId}:`, err && err.message);
    }
  }

  // ── SIBLINGS ARE NOT DUPLICATES ────────────────────────────────────────────
  // Same code + registered as a different colourway = two real products, by
  // design. Only the pairs the index does NOT vouch for are flagged. `duplicate`
  // in the response now means "an UNEXPLAINED collision exists" — the thing a
  // human still needs to look at — never "several colourways share a code".
  const allPairs = duplicatePairs(existingProducts.map((m) => m.id));
  const { collision: collisionPairs } = partitionPairs(claim && claim.node, allPairs);
  const duplicate = collisionPairs.length > 0;
  let duplicatePairIds = [];
  if (duplicate) {
    try {
      duplicatePairIds = await flagDuplicates(db, normalised, collisionPairs, actor, nowMs);
    } catch (err) {
      // The banner is driven off THIS response, not off the node, so a failed
      // flag write still surfaces to the person looking at the screen.
      console.warn(`resolveStyleCode: duplicate flag write failed for ${normalised}:`, err && err.message);
    }
  }

  return {
    kind: "ok",
    // The EFFECTIVE identity. When tier 3 corrected a misread glyph this is the
    // corrected code — the one to claim, stamp and cache under.
    normalised,
    displayCode: (chain.model && chain.model.styleCode) || formatStyleCodeForDisplay(normalised),
    // Non-null when tier 3 fired: the code as READ, which the UI must show
    // ("read CT8527-O16, resolved as CT8527-016") so the operator can veto a
    // correction rather than have it applied behind their back.
    correctedFrom,
    found: !!chain.model,
    model: chain.model || null,
    source: chain.provider,
    tier: chain.tier,
    fromCache: chain.fromCache,
    cached,
    cacheCorrected,
    // ── AUTHORITY ──────────────────────────────────────────────────────────
    // claim: who owns this code, per /style_code_index. null = unclaimed, so
    // intake may attempt the create-once claim. Non-null = DO NOT create a new
    // product; route to the named product — or, when several owners exist,
    // make the human pick which colourway they are holding. The raw node stays
    // server-side; the client gets the digested shape.
    claim: claim ? {
      productId: claim.productId,
      claimedAt: claim.claimedAt,
      claimedBy: claim.claimedBy,
      siblingIds: claim.siblingIds,
    } : null,
    // Every registered owner of this code, primary first. Length > 1 means
    // colourway siblings — the UI must show them side by side and ask, never
    // resolve silently. See lib/style-code-siblings.cjs.
    owners: claim ? claimOwnerIds(claim.node) : [],
    // A claim pointing at a product that does not exist. The claim landed and
    // the product write then failed. Intake must show this rather than treat
    // the code as taken by something it can route to.
    claimOrphaned,
    existingProducts,
    duplicate,
    duplicatePairIds,
    // Non-empty when a tier was BROKEN rather than empty-handed. The UI must say
    // "lookup unavailable, enter it manually" for this case — never "no such
    // shoe", which would send staff off to create a duplicate product.
    errors: chain.errors,
  };
}

exports.runResolve = runResolve;
exports.findProductsByStyleCode = findProductsByStyleCode;
exports.duplicatePairId = duplicatePairId;
exports.duplicatePairs = duplicatePairs;
exports.readClaim = readClaim;
exports.DUPLICATE_CANDIDATES_PATH = DUPLICATE_CANDIDATES_PATH;
exports.STYLE_CODE_INDEX_PATH = STYLE_CODE_INDEX_PATH;
exports.STYLE_CODE_MISSES_PATH = STYLE_CODE_MISSES_PATH;
exports.DUP_REASON_STYLE_CODE = DUP_REASON_STYLE_CODE;

exports.resolveStyleCode = onCall(
  {
    region: "europe-west1",
    secrets: [kicksDbApiKey],
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (request) => {
    const db = admin.database();
    const actor = await assertStyleCodeAccess(request, db);

    const { code, confusableRetry } = request.data || {};
    if (typeof code !== "string" || !code.trim()) {
      throw new HttpsError("invalid-argument", "code is required.");
    }

    const nowMs = Date.now();
    // The secret is read HERE, at call time, and handed to the adapter. It never
    // leaves the function.
    const providers = defaultProviders({
      db,
      apiKey: kicksDbApiKey.value(),
      nowMs,
    });

    // The client sends confusableRetry ONLY when the code came off a photo (a
    // typed code was not misread). It was previously dropped here, so tier 3
    // never fired in production — coerced to a strict boolean and passed on.
    const out = await runResolve(db, { code, providers, actor, nowMs, confusableRetry: confusableRetry === true });
    if (out.kind === "reject") {
      throw new HttpsError("invalid-argument", out.code);
    }
    const { kind, ...payload } = out;
    return payload;
  }
);
