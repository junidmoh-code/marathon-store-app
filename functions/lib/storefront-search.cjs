// ─── STOREFRONT SEARCH — the pure matcher and scorer ─────────────────────────
// The storefront's own search, over the app's TRUE product data, because
// Shopify's search cannot work here: every brand, sub-label and silhouette term
// is stripped before a product is pushed, so the words a shopper actually types
// are exactly the words the Shopify catalogue does not contain.
//
// The failing case, read off the live shop on 2026-08-16:
//
//   TRUE name in the app          Shopify title on the storefront
//   "Lacoste Gripshot Lace Boot"  "Lace Boot White Navy"
//   "Adidas Samba White Core"     "Sneaker White Core Black"
//   "Nike Air Force 1 Shell Grn"  "Boots Shell Green"
//
// Searching "gripshot" or "samba" on the shop returns nothing. This module is
// how it returns the right product instead. It matches on the TRUE data and
// hands back the Shopify handle — the brand never leaves this system.
//
// ── PURE. NO I/O, NO FIREBASE, NO NETWORK ────────────────────────────────────
// The endpoint (functions/storefrontSearch/) does the reading; this file does
// the thinking, so the whole matcher is unit-testable without a network.
//
// ── THE TWIN, AND WHY ────────────────────────────────────────────────────────
// The token-matching semantics here are DELIBERATELY the same as the app's own
// product search (src/utils/productSearch.js): case- and punctuation-
// insensitive, substring, word-initial acronym ("af1"), and bounded-Levenshtein
// typo tolerance with a budget that scales with token length. A shopper typing
// on the storefront should get the same forgiveness a colleague gets typing
// into the stock picker. The two are pinned equal by a parity test
// (storefrontSearch.parity.test.js) so they cannot drift.
//
// What this file ADDS, and why it is not just an import: the app's matcher is a
// BOOLEAN (does this product match?) and sorts alphabetically. A storefront
// needs RANKING — the best answer first — and it must never match on a barcode
// or SKU, which the app's matcher does. So the predicate is shared in spirit
// and the scoring is new.
"use strict";

// ── Normalisation ────────────────────────────────────────────────────────────
// Lowercase, strip accents, reduce to alphanumeric words. "Aïr-Force1" and
// "air force 1" and "AIRFORCE1" all normalise into comparable shapes.
function normWords(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Bounded edit distance: the true distance, or max+1 as soon as the whole
// in-progress row exceeds `max`, so far-misses bail early and a query stays
// cheap over a few hundred documents.
function boundedEdit(a, b, max) {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 1; i <= la; i++) {
    const cur = new Array(lb + 1);
    cur[0] = i;
    let rowBest = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < rowBest) rowBest = v;
    }
    if (rowBest > max) return max + 1;
    prev = cur;
  }
  return prev[lb];
}

// Typo budget scales with token length. 1–2 characters must be near-exact (a
// budget there matches almost anything); 3–5 tolerate one edit ("nke" → "nike",
// "samba" → "samb a"); longer tolerate two ("gripshoot" → "gripshot").
function typoBudget(len) {
  return len <= 2 ? 0 : len <= 5 ? 1 : 2;
}

/**
 * The searchable shape of one document, computed ONCE at index-build time so a
 * query never re-normalises the corpus.
 *   words     the token list
 *   squash    the tokens joined, for multi-word-span substring hits
 *   initials  first letters, for acronyms
 */
function searchContext(text) {
  const words = normWords(text).split(" ").filter(Boolean);
  return { words, squash: words.join(""), initials: words.map((w) => w[0]).join("") };
}

// ── Token matching ───────────────────────────────────────────────────────────
// Returns a QUALITY, not a boolean, so the scorer can prefer an exact word hit
// over a rescued typo. 0 means no match.
//   1.00  exact whole word
//   0.85  word prefix (the shopper is still typing)
//   0.70  substring anywhere, including across a word join
//   0.55  word-initial acronym
//   0.40  rescued by edit distance
const Q_EXACT = 1;
const Q_PREFIX = 0.85;
const Q_SUBSTR = 0.7;
const Q_ACRONYM = 0.55;
const Q_FUZZY = 0.4;

function tokenQuality(token, ctx) {
  if (!token) return 0;
  if (ctx.words.includes(token)) return Q_EXACT;
  for (const w of ctx.words) if (w.startsWith(token)) return Q_PREFIX;
  if (ctx.squash.includes(token)) return Q_SUBSTR;
  if (token.length >= 2 && ctx.initials.includes(token)) return Q_ACRONYM;
  const budget = typoBudget(token.length);
  if (budget === 0) return 0;
  for (const w of ctx.words) {
    if (boundedEdit(token, w, budget) <= budget) return Q_FUZZY;
    // A typo inside a PARTIAL word the shopper is still typing:
    // "gripsho" against "gripshot".
    if (w.length > token.length &&
        boundedEdit(token, w.slice(0, token.length), budget) <= budget) return Q_FUZZY;
  }
  return 0;
}

// ── Field weights ────────────────────────────────────────────────────────────
// A hit on the true product name is worth much more than a hit on its category,
// or every query for "boots" would rank the whole Boots lane above the product
// actually called a boot. Weights are relative and only affect ORDER.
const FIELDS = [
  ["name", 1],       // the TRUE, brand-carrying identity — what shoppers type
  ["extras", 0.9],   // brand / model / colourway a vision pass read off the
                     // photo. Just under `name`: it is the same KIND of fact,
                     // but it is a guess, and a product whose stored identity
                     // says the word should outrank one where a model thought
                     // it saw it.
  ["aliases", 0.85], // canonical spellings of the brand/model terms the
                     // identity carries — how "timberland" finds a record
                     // spelt "Timbalend". Just under the identity itself.
  ["title", 0.8],    // the compliant Shopify title
  ["colour", 0.5],   // dominant colours read off the photo
  ["category", 0.3], // "Footwear", "Boots"
];

/**
 * Score one document against a normalised token list.
 * EVERY query token must hit SOMETHING, in any field — an AND across tokens.
 * "samba white" must not return every white shoe.
 * → 0 when the document does not match at all.
 */
function scoreDoc(doc, tokens) {
  if (!tokens.length) return 0;
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const [field, weight] of FIELDS) {
      const ctx = doc.ctx?.[field];
      if (!ctx) continue;
      const q = tokenQuality(token, ctx) * weight;
      if (q > best) best = q;
    }
    if (best === 0) return 0; // one token unmatched ⇒ not a result
    total += best;
  }
  // Average, so a two-word query is comparable to a one-word query, then a
  // small nudge for documents that still have stock — a shopper would rather
  // see something buyable first, and it breaks ties deterministically.
  const avg = total / tokens.length;
  return avg + (doc.inStock ? 0.02 : 0);
}

/**
 * THE SEARCH. docs is the in-memory index; query is the raw user string.
 * → [{ doc, score }], best first, capped.
 *
 * Ties break on `handle`, not on insertion order: the same query must return
 * the same order on every instance, or a shopper who reloads sees the results
 * shuffle for no reason.
 */
function search(docs, query, { limit = 24 } = {}) {
  const tokens = normWords(query).split(" ").filter(Boolean);
  if (!tokens.length) return [];
  const hits = [];
  for (const doc of docs) {
    const score = scoreDoc(doc, tokens);
    if (score > 0) hits.push({ doc, score });
  }
  hits.sort((a, b) => b.score - a.score || String(a.doc.handle).localeCompare(String(b.doc.handle)));
  return hits.slice(0, limit);
}

// ── THE PUBLIC SHAPE ─────────────────────────────────────────────────────────
// ASSUME THIS RESPONSE IS PUBLIC. It is the whole of what a search result may
// carry, and it is an ALLOW-LIST built field by field rather than a stored doc
// with things deleted from it — a delete-list silently leaks whatever gets
// added to the index later.
//
// NEVER in here, and each for its own reason:
//   name / brand    the TRUE brand-carrying name. The entire point of the
//                   compliance work is that the brand does not reach Shopify;
//                   it must not reach the public through this door either.
//   stockPrice      a B2B wholesale SELLING price, not a cost — and either way
//                   nobody outside the business sees what we pay or charge trade.
//   sku / barcode   internal codes; a barcode is a key into /barcodes.
//   productId       the internal pid; it is the key to every other node.
//   per-location    where the stock physically is. Not a shopper's business,
//   quantities      and a map of where to find inventory is not something to
//                   publish. Only a BOOLEAN in-stock flag per size leaves here.
function publicResult({ doc, score }) {
  return {
    handle: doc.handle,                 // the Shopify product handle — the link
    title: doc.title,                   // the compliant Shopify title
    price: doc.price,                   // minor units, integer
    currency: doc.currency,
    image: doc.image || null,
    // Availability as BOOLEANS per size. Never a quantity: "3 left in size 8"
    // is inventory intelligence, and this response is public.
    sizes: (doc.sizes || []).map((s) => ({ size: s.size, available: !!s.available })),
    inStock: !!doc.inStock,
    collection: doc.collection || null, // the storefront lane's handle
    score: Math.round(score * 1000) / 1000,
  };
}

module.exports = {
  normWords,
  boundedEdit,
  typoBudget,
  searchContext,
  tokenQuality,
  scoreDoc,
  search,
  publicResult,
  FIELDS,
  Q_EXACT, Q_PREFIX, Q_SUBSTR, Q_ACRONYM, Q_FUZZY,
};
