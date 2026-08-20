// ── Vision naming, in batches ────────────────────────────────────────────────
// Reads a product's PHOTO and proposes two things from one call: the item's
// true identity (internal, for search) and a compliant public listing name
// (proposed, never applied). See src/utils/visionNaming.js for why, and for the
// measurement that motivated it — 69% of live titles begin with the single word
// "Sneaker", and 11% carry one descriptive word or fewer.
//
//   node scripts/shopify/vision-name.mjs                        quote only, nothing spent
//   node scripts/shopify/vision-name.mjs --live-only            scope: on the storefront now
//   node scripts/shopify/vision-name.mjs --category sneakers    scope: one categoryKey
//   node scripts/shopify/vision-name.mjs --subcategory Boots    scope: one legacy subcategory
//   node scripts/shopify/vision-name.mjs --pids p1,p2           scope: named products
//   node scripts/shopify/vision-name.mjs --unnamed-only         only products with no cleanName
//   node scripts/shopify/vision-name.mjs --limit 50             cap the scope
//   node scripts/shopify/vision-name.mjs --confirm-batch 50     SPEND. Must equal the scope size.
//
// ── NOTHING IS SPENT WITHOUT --confirm-batch, AND IT MUST MATCH ───────────────
// The default run is a QUOTE: it resolves the scope, prints the projected cost,
// and stops. Spending requires --confirm-batch N where N is exactly the number
// of products in scope. A mismatch refuses and prints the real number. This is
// deliberate friction: the catalogue is 4,148 products and "I thought it was
// only doing the boots" is the mistake worth making impossible, not merely
// unlikely.
//
// ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────────
//   • It never touches /products. Not the name, not anything.
//   • It never writes cleanName. Proposals go to
//     /shopify_publish/{pid}/nameProposal and wait for review.
//   • It NEVER re-names a product whose cleanNameSource is "manual" — that is
//     Junid's decision (owner spec).
//   • It never invents identity. "identified: false" writes no identity at all.
//   • Identity is written through shouldReplaceIdentity, so a guess can fill a
//     gap or beat a weaker guess but can never overwrite supplier data.
//
// WRITES: /shopify_publish/{pid}/nameProposal and /product_identity/{pid}.
import { createRequire } from "module";
import "./env.mjs"; // side effect: tops up process.env from the git-ignored .env
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { isPriceRecord } from "../../src/utils/productCategory.js";
import {
  VISION_PROMPT, regenerationNote, parseVisionResponse, validateVisionName,
  buildNameProposal, identityTextFrom, projectCost, mayProposeFor,
  NAME_PROPOSAL_KEY, VISION_NAME_SOURCE,
  visionModel, THINKING_CONFIG, costFromUsage, leadShapeHint, USD_TO_ZAR,
} from "../../src/utils/visionNaming.js";
import {
  SEARCH_IDENTITY_PATH, shouldReplaceIdentity,
} from "../../src/utils/searchIdentity.js";
import { readMapPaged } from "../lib/rtdbPaged.mjs";

const MODEL = visionModel(process.env);
const API = "https://generativelanguage.googleapis.com/v1beta/models";

const flags = process.argv.slice(2);
const arg = (name) => {
  const i = flags.indexOf(name);
  if (i === -1) return null;
  const v = flags[i + 1];
  if (!v || v.startsWith("--")) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  return v;
};
const LIVE_ONLY = flags.includes("--live-only");
const UNNAMED_ONLY = flags.includes("--unnamed-only");
const CATEGORY = arg("--category");
const SUBCATEGORY = arg("--subcategory");
const PIDS = arg("--pids");
const LIMIT = arg("--limit") ? Number(arg("--limit")) : null;
const CONFIRM = arg("--confirm-batch") ? Number(arg("--confirm-batch")) : null;
if (LIMIT !== null && !(LIMIT > 0)) { console.error("--limit needs a positive number"); process.exit(2); }

// ── THE KEY. Absent ⇒ DISABLED, with a plain message. No stub, no fallback. ──
const API_KEY = process.env.GEMINI_API_KEY || "";
const QUOTE_ONLY = CONFIRM === null;
if (!API_KEY && !QUOTE_ONLY) {
  console.error(
    "GEMINI_API_KEY is not set — vision naming is DISABLED.\n" +
    "Set it in the environment or in the git-ignored .env at the repo root, then re-run.\n" +
    "There is no fallback: without the key there is no vision pass, and nothing is written.\n" +
    "Everything else in the publishing flow works exactly as before."
  );
  process.exit(2);
}

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const confirmedOn = (n) => n?.state === "live" && n?.liveState === "on";

// ── Resolve the scope ────────────────────────────────────────────────────────
// PAGED, never one whole-node read: /shopify_publish is 1,400 nodes and
// growing toward one per product, and a single get() of it is exactly the
// read that spikes the bandwidth bill (same rule the browser store follows).
const publish = await readMapPaged(db, "shopify_publish", { pageSize: 400 });
const onlyPids = PIDS ? new Set(PIDS.split(",").map((s) => s.trim()).filter(Boolean)) : null;
if (onlyPids && onlyPids.size === 0) { console.error("--pids parsed to an empty list"); process.exit(2); }

const products = await readMapPaged(db, "products", { pageSize: 500 });

const skipped = { manual: 0, priceRecord: 0, noPhoto: 0, merged: 0 };
const scope = [];
for (const [pid, p] of Object.entries(products)) {
  if (!p || typeof p !== "object" || !p.id) continue;
  if (p.mergedInto) { skipped.merged += 1; continue; }
  if (onlyPids && !onlyPids.has(pid)) continue;
  if (CATEGORY && p.categoryKey !== CATEGORY) continue;
  if (SUBCATEGORY && p.subcategory !== SUBCATEGORY) continue;
  if (LIVE_ONLY && !confirmedOn(publish[pid])) continue;
  if (isPriceRecord(p)) { skipped.priceRecord += 1; continue; }
  const node = publish[pid];
  // THE ONE HARD EXCLUSION. A name Junid typed is his decision.
  if (!mayProposeFor(node)) { skipped.manual += 1; continue; }
  if (UNNAMED_ONLY && node?.cleanName) continue;
  // One image per call, so a product with no photo has nothing to read.
  const photo = String(p.photoUrl || "").trim();
  if (!photo) { skipped.noPhoto += 1; continue; }
  scope.push({ pid, product: p, node, photo });
}
scope.sort((a, b) => a.pid.localeCompare(b.pid));
const work = LIMIT ? scope.slice(0, LIMIT) : scope;

const quote = projectCost(work.length);
console.log(`scope: ${work.length} product(s)${LIMIT && scope.length > LIMIT ? ` (capped from ${scope.length} by --limit)` : ""}`);
console.log(`  skipped — manual name: ${skipped.manual} · price record: ${skipped.priceRecord} · no photo: ${skipped.noPhoto} · merged: ${skipped.merged}`);
console.log(`\nPROJECTED COST: $${quote.usd} (~R${quote.zar}) at $${quote.perNameUsd}/name, one image per call`);
console.log(`FOR REFERENCE, the whole catalogue (${Object.keys(products).length} records): $${projectCost(Object.keys(products).length).usd} (~R${projectCost(Object.keys(products).length).zar})`);

if (QUOTE_ONLY) {
  console.log(`\nQUOTE ONLY — nothing sent, nothing written, nothing spent.`);
  console.log(`To run it: re-run with --confirm-batch ${work.length}`);
  if (!API_KEY) console.log(`NOTE: GEMINI_API_KEY is not set, so the run itself would be DISABLED.`);
  process.exit(0);
}
if (CONFIRM !== work.length) {
  console.error(`\nREFUSED: --confirm-batch ${CONFIRM} does not match the ${work.length} product(s) in scope.`);
  console.error(`This guard exists so a run can never be bigger than intended. Re-run with --confirm-batch ${work.length} if that is really what you want.`);
  process.exit(2);
}
if (!work.length) { console.log("nothing in scope."); process.exit(0); }

// ── One call per photo ───────────────────────────────────────────────────────
// The photo download is the fragile step, and it fails for reasons that have
// nothing to do with this program: on the first full run 2,479 of 2,916 products
// failed with a bare "fetch failed" because the machine's network dropped
// mid-run. None of them reached the API, so nothing was charged — but the run
// reported 85% failure for a transient cause. A bounded retry with backoff turns
// that into a pause instead of a loss.
async function fetchWithRetry(url, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((res) => setTimeout(res, 1000 * 2 ** i));
    }
  }
  throw new Error(`could not fetch the photo after ${attempts} attempts (${String(last?.message || last)})`);
}

async function callGemini(photoUrl, extraInstruction, shapeHint) {
  const img = await fetchWithRetry(photoUrl);
  const mimeType = img.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const data = Buffer.from(await img.arrayBuffer()).toString("base64");
  const parts = [{ inlineData: { mimeType, data } }, { text: VISION_PROMPT }];
  // The rotating lead-shape preference. Without it the model converges on one
  // template — measured: 13 of the first 20 opened identically.
  if (shapeHint) parts.push({ text: shapeHint });
  if (extraInstruction) parts.push({ text: extraInstruction });
  // The API call gets the same treatment, but ONLY for transport failures —
  // never after a response arrives, because a completed generation has already
  // been charged and retrying would pay for it twice.
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: "application/json",
      // Thinking is billed at the OUTPUT rate and measured 46% more expensive
      // for an answer of the same quality. See THINKING_CONFIG.
      thinkingConfig: { ...THINKING_CONFIG },
    },
  });
  let res, lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(`${API}/${MODEL}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
        body,
        signal: AbortSignal.timeout(90000),
      });
      break;
    } catch (e) {
      lastErr = e;
      // A TIMEOUT IS NOT A TRANSPORT FAILURE. The retry above exists for
      // errors that prove the request never reached the server; a timeout
      // proves nothing of the kind — the server may have accepted it and
      // generated an answer, which has already been CHARGED. Retrying then
      // pays for the same photo twice, which is the exact rule the comment
      // above states and the abort quietly broke (reviewer finding). One
      // photo lost is cheaper than an unbounded double-charge, and the next
      // run picks it up because nothing was written for it.
      if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new Error(`the request timed out after 90s — not retried, because a timed-out ` +
                        `generation may already have been charged`);
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  }
  if (!res) throw new Error(`could not reach Gemini after 3 attempts (${String(lastErr?.message || lastErr)})`);
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
  if (!text) {
    const why = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason || "no text in response";
    throw new Error(`Gemini returned nothing usable (${why})`);
  }
  // The model's OWN reported usage. The projection is a constant so a batch can
  // be quoted before it runs; this is what it actually cost, so drift between
  // the two is visible instead of assumed.
  measuredUsd += costFromUsage(json.usageMetadata);
  return text;
}

const results = [];
let spent = 0;
let measuredUsd = 0;

for (const [i, { pid, product, node, photo }] of work.entries()) {
  const previousName = node?.cleanName || null;
  try {
    // INSIDE the try: thrown out here it is an unhandled rejection at module
    // top level, the process dies, and the report below never prints — losing
    // the record of every call already PAID FOR in this chunk (reviewer
    // finding). Product ids are "p<digits>" so this never fires in practice.
    assertSafeSegment(pid, "productId");
    // ── attempt 1 ──
    const shapeHint = leadShapeHint(i);
    let raw = await callGemini(photo, null, shapeHint);
    spent += 1;
    let parsed = parseVisionResponse(raw);
    if (!parsed.ok) { results.push({ pid, status: "unusable", detail: parsed.error }); continue; }
    let verdict = validateVisionName(parsed.publicName);
    let attempts = 1;

    // ── ONE regeneration, naming the offending term. Then refuse. ──
    if (!verdict.ok) {
      const first = parsed.publicName;
      raw = await callGemini(photo, regenerationNote(verdict.triggers), shapeHint);
      spent += 1;
      attempts = 2;
      const retry = parseVisionResponse(raw);
      if (retry.ok) {
        const retryVerdict = validateVisionName(retry.publicName);
        if (retryVerdict.ok) { parsed = retry; verdict = retryVerdict; }
        else {
          // REFUSED. Never quietly substituted with the lexicon's title or the
          // previous name — the proposal is kept in its own lane, with the
          // reason, and a human decides.
          await writeProposal(pid, buildNameProposal({
            publicName: retry.publicName, identity: retry.identity, previousName,
            model: MODEL, at: Date.now(), attempts,
            refusedFor: `${retryVerdict.problems.join("; ")} (first attempt also refused: ${first})`,
          }), retry.identity, product, node);
          results.push({ pid, status: "refused", detail: retryVerdict.problems.join("; ") });
          continue;
        }
      } else {
        results.push({ pid, status: "unusable", detail: `retry ${retry.error}` });
        continue;
      }
    }

    await writeProposal(pid, buildNameProposal({
      publicName: parsed.publicName, identity: parsed.identity, previousName,
      model: MODEL, at: Date.now(), attempts,
    }), parsed.identity, product, node);
    results.push({
      pid, status: "proposed",
      detail: `${JSON.stringify(previousName || "(no name)")} → ${JSON.stringify(parsed.publicName)}` +
        (parsed.identity ? ` · identity ${JSON.stringify(identityTextFrom(parsed.identity))} (conf ${parsed.identity.confidence})` : " · NOT identified"),
    });
  } catch (e) {
    results.push({ pid, status: "failed", detail: String(e?.message || e) });
  }
}

// The proposal, and — separately and only when the model actually identified
// something — the identity. Identity goes through shouldReplaceIdentity, so it
// can fill a gap or beat a weaker guess but never overwrite supplier data.
async function writeProposal(pid, proposal, identity, product, node) {
  // A proposal written onto a node that has no `state` is INVISIBLE to the
  // app: every read the review page makes is a server-filtered query on the
  // one index that exists (.indexOn ["state"]), and the live .validate on
  // /shopify_publish/$pid requires hasChildren(['state']) — so the browser
  // could not even write such a node back. The first runs produced 560 nodes
  // holding nothing but a nameProposal, and not one of them was reviewable.
  //
  // So the state is supplied when it is ABSENT, and never otherwise: "awaiting"
  // is what a node with no state already means (normalizedState), and
  // overwriting a real state here would let a naming run move a live product
  // out of the pipeline — which is why "absent" is decided on the server below
  // and not from this function's `node` argument.
  // ── STATE FIRST, PROPOSAL SECOND. The order is the whole safety property. ──
  // Written the other way round, a connection drop between the two writes
  // leaves a node carrying a nameProposal and NO state — which is invisible to
  // the review page (every read is a server-filtered query on the `state`
  // index) and unwritable by it (the live .validate requires
  // hasChildren(['state'])). And it is PERMANENT: _scope-unnamed.mjs skips any
  // node that already carries a proposal, so the product is never named again
  // and never reviewed. Nobody would ever see it (reviewer finding).
  //
  // This way round the same drop leaves a node with a state and no proposal —
  // which is exactly a product still waiting to be named, and the next run
  // picks it up.
  //
  // The state is decided against the SERVER, in a transaction on the `state`
  // child alone — never against `node`, which is the scope snapshot taken when
  // the run started. name-remaining.sh works through the backlog in chunks over
  // about four and a half hours, so that snapshot is hours old by the end: a
  // product Junid published at 10:00 would be stamped back to "awaiting" at
  // 11:00, dropping it out of the state=="live" index and out of the Live
  // filter WHILE IT IS STILL ON THE STOREFRONT. `undefined` aborts, so an
  // existing state of any value is left alone.
  await db.ref(`shopify_publish/${pid}/state`).transaction((cur) => (cur ? undefined : "awaiting"));
  await db.ref(`shopify_publish/${pid}`).update({ [NAME_PROPOSAL_KEY]: proposal });
  if (!identity) return;
  const text = identityTextFrom(identity);
  if (!text) return;
  const idRef = db.ref(`${SEARCH_IDENTITY_PATH}/${pid}`);
  const incoming = {
    text,
    source: VISION_NAME_SOURCE,
    confidence: identity.confidence,
    ...(identity.brand ? { brand: identity.brand } : {}),
    ...(identity.model ? { model: identity.model } : {}),
    ...(identity.colourway ? { colourway: identity.colourway } : {}),
    capturedAt: Date.now(),
    capturedBy: "script:vision-name",
  };
  await idRef.transaction((existing) => {
    if (!shouldReplaceIdentity(existing, incoming)) return undefined; // abort
    return { ...incoming, ...(existing?.text ? { supersededText: existing.text } : {}) };
  });
}

// ── Report ───────────────────────────────────────────────────────────────────
const BAD = new Set(["failed", "unusable"]);
for (const r of results) {
  const icon = BAD.has(r.status) ? "✗" : r.status === "refused" ? "⚠" : "✓";
  console.log(`${icon} ${r.pid.padEnd(16)} ${r.status.padEnd(10)} ${r.detail}`);
}
const tally = {};
for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
console.log(`\n${Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join(" · ") || "nothing done"}`);
console.log(`model: ${MODEL} · calls made: ${spent} (retries included)`);
console.log(`MEASURED cost from the model's own usage: $${measuredUsd.toFixed(5)} (~R${(measuredUsd * USD_TO_ZAR).toFixed(3)})` +
  (spent ? ` · $${(measuredUsd / spent).toFixed(6)}/call vs $${projectCost(1).usd} projected` : ""));
console.log(`Proposals are PENDING. Nothing is on the storefront until they are approved in the publishing page.`);
process.exit(results.some((r) => BAD.has(r.status)) ? 1 : 0);
