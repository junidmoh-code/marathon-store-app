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
} = require("../lib/style-code-providers.cjs");
const {
  normaliseStyleCode,
  formatStyleCodeForDisplay,
  styleCodeQueryCandidates,
  styleCodeFormat,
  brandFamilyForStyleCode,
} = require("../lib/style-code.cjs");
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

async function readClaim(db, normalised) {
  const val = (await db.ref(`${STYLE_CODE_INDEX_PATH}/${normalised}`).get()).val();
  if (!val || typeof val.productId !== "string" || !val.productId) return null;
  return {
    productId: val.productId,
    claimedAt: Number(val.claimedAt) || null,
    claimedBy: val.claimedBy || null,
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
async function flagDuplicates(db, normalised, matches, actor, nowMs) {
  const pairs = duplicatePairs(matches.map((m) => m.id));
  await Promise.all(pairs.map(({ pairId, productIdA, productIdB }) =>
    db.ref(`${DUPLICATE_CANDIDATES_PATH}/${pairId}`).set({
      productIdA,
      productIdB,
      reason: DUP_REASON_STYLE_CODE, // enum: styleCodeCollision | manual | heuristic
      status: "open",                // enum: open | merged | dismissed — a human closes it
      detectedAt: nowMs,
      // EXACTLY the rules-listed fields and nothing else. It is not confirmed
      // whether this node permits additional children, and an unlisted key on a
      // strictly-validated node is rejected at write time and looks like a
      // silent no-op. The style code and the detecting user are already on the
      // resolve response that raises the banner, so carrying them here too
      // would buy nothing and risk the whole write.
    })));
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
 * @returns {{
 *   normalised: string, displayCode: string, found: boolean,
 *   model: object|null, source: string|null, tier: number|null, fromCache: boolean,
 *   existingProducts: object[], duplicate: boolean, cached: boolean,
 *   errors: Array<{provider:string,message:string}>
 * }}
 */
async function runResolve(db, { code, providers, actor, nowMs }) {
  const normalised = normaliseStyleCode(code);
  if (!normalised) {
    return { kind: "reject", code: "empty-code" };
  }

  // Three independent questions, asked at once: what IS this code (tier walk),
  // who OWNS it (the claim — authoritative), and what already carries it (the
  // collision scan).
  const [chain, claim, existingProducts] = await Promise.all([
    resolveThroughProviders(providers, {
      normalised,
      raw: typeof code === "string" ? code : "",
      candidates: styleCodeQueryCandidates(code),
    }),
    readClaim(db, normalised),
    findProductsByStyleCode(db, normalised),
  ]);

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
      if (!occupant) {
        await slot.set(chain.model);
        cached = true;
      } else {
        // Occupied AND tier 1 refused it ⇒ the stored row is corrupt. Correct
        // it loudly: this is the only overwrite this function ever performs.
        console.warn(`resolveStyleCode: CORRECTING corrupt /sneaker_models/${normalised} ` +
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
  // measured per brand. Never let the bookkeeping fail the lookup.
  if (!chain.model) {
    try {
      await logMiss(db, normalised, { actor, nowMs, errors: chain.errors });
    } catch (err) {
      console.warn(`resolveStyleCode: miss log failed for ${normalised}:`, err && err.message);
    }
  }

  // ORPHAN CHECK — a claim whose product does not exist. Only asked when the
  // claimed id is not already in the scan results, so the common path costs no
  // extra read.
  let claimOrphaned = false;
  if (claim && !existingProducts.some((p) => p.id === claim.productId)) {
    claimOrphaned = !(await db.ref(`products/${claim.productId}/id`).get()).exists();
  }

  const duplicate = existingProducts.length > 1;
  let duplicatePairIds = [];
  if (duplicate) {
    try {
      duplicatePairIds = await flagDuplicates(db, normalised, existingProducts, actor, nowMs);
    } catch (err) {
      // The banner is driven off THIS response, not off the node, so a failed
      // flag write still surfaces to the person looking at the screen.
      console.warn(`resolveStyleCode: duplicate flag write failed for ${normalised}:`, err && err.message);
    }
  }

  return {
    kind: "ok",
    normalised,
    displayCode: (chain.model && chain.model.styleCode) || formatStyleCodeForDisplay(normalised),
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
    // product; route to the named product instead.
    claim,
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

    const { code } = request.data || {};
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

    const out = await runResolve(db, { code, providers, actor, nowMs });
    if (out.kind === "reject") {
      throw new HttpsError("invalid-argument", out.code);
    }
    const { kind, ...payload } = out;
    return payload;
  }
);
