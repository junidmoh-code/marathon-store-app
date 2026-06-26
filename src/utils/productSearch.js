// ─── FORGIVING PRODUCT SEARCH ─────────────────────────────────────────────────
// One shared, typo-tolerant matcher reused by every product search box (stock
// pickers, admin list, etc.) so they all behave the same. "Forgiving" means:
//   • case-insensitive
//   • space/punctuation-insensitive ("air-force" == "air force" == "airforce")
//   • partial / substring ("air force" finds "Nike Air Force 1")
//   • minor-typo / transposition tolerant ("Nke Air Force" finds "Nike Air Force 1")
//   • acronym aware ("af1" finds "Air Force 1" via word initials)
//   • matches NAME and every code (barcode / sku / per-size barcodes)
// It's pure string math (bounded Levenshtein with early-exit) — no index to build,
// so it stays fast on a few-thousand-product catalogue filtered per keystroke.

// Lowercase + reduce to alphanumeric "words" (drops spaces/punctuation).
function normWords(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Bounded edit distance: returns the true distance, or max+1 as soon as the whole
// in-progress row exceeds `max` (so near-misses are cheap and far-misses bail early).
function boundedEdit(a, b, max) {
  const la = a.length, lb = b.length;
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

// Typo budget scales with token length: 1-2 char tokens must be near-exact (a typo
// budget there matches almost anything), 3-5 chars tolerate one edit ("nke"→"nike"),
// longer tokens tolerate two.
function typoBudget(len) {
  return len <= 2 ? 0 : len <= 5 ? 1 : 2;
}

// Per-product, per-query-token reusable context (name words/squash/initials).
function nameContext(name) {
  const words = normWords(name).split(" ").filter(Boolean);
  return { words, squash: words.join(""), initials: words.map((w) => w[0]).join("") };
}

// Does ONE query token occur in the name — as a substring, a word-initial acronym,
// or a near-miss (bounded edit distance vs a word or its same-length prefix)?
function tokenInName(token, ctx) {
  if (!token) return true;
  if (ctx.squash.includes(token)) return true;                 // partial / multi-word span
  if (token.length >= 2 && ctx.initials.includes(token)) return true; // acronym e.g. "af1"
  const budget = typoBudget(token.length);
  if (budget === 0) return false;
  for (const w of ctx.words) {
    if (w.includes(token)) return true;
    if (boundedEdit(token, w, budget) <= budget) return true;            // whole-word typo ("nke"→"nike")
    // also tolerate a typo in a PARTIAL word the user is still typing ("ultrabo"→"ultraboost")
    if (w.length > token.length && boundedEdit(token, w.slice(0, token.length), budget) <= budget) return true;
  }
  return false;
}

// All codes attached to a product: top-level barcode/sku + every per-size barcode.
function productCodes(p) {
  const codes = [];
  if (p.barcode != null) codes.push(String(p.barcode));
  if (p.sku != null) codes.push(String(p.sku));
  if (p.barcodes && typeof p.barcodes === "object") {
    for (const c of Object.values(p.barcodes)) if (c != null) codes.push(String(c));
  }
  return codes;
}

// Code match: only when the query carries a digit; exact, or a 3+-char substring.
export function codeMatchesQuery(p, rawQuery) {
  const q = String(rawQuery ?? "").trim();
  if (!q || !/\d/.test(q)) return false;
  const ql = q.toLowerCase();
  return productCodes(p).some((c) => {
    const cl = c.toLowerCase();
    return cl === ql || (q.length >= 3 && cl.includes(ql));
  });
}

// Name match: EVERY query token must occur somewhere in the product name.
export function nameMatchesQuery(p, rawQuery) {
  const tokens = normWords(rawQuery).split(" ").filter(Boolean);
  if (!tokens.length) return false;
  const ctx = nameContext(p.name);
  return tokens.every((t) => tokenInName(t, ctx));
}

// Boolean: does this product match the query at all (name OR code)? Empty query → true.
export function productMatchesQuery(p, rawQuery) {
  const q = String(rawQuery ?? "").trim();
  if (!q) return true;
  if (!p || !p.name) return false;
  return codeMatchesQuery(p, q) || nameMatchesQuery(p, q);
}

// Search a product list: returns the matches, code-hits first then name matches
// (alphabetical), deduped by id and capped at `limit`. `predicate` pre-filters which
// products are eligible (e.g. require sizes). Empty query → [] (pickers stay empty).
export function searchProducts(products, rawQuery, { limit = 50, predicate } = {}) {
  const q = String(rawQuery ?? "").trim();
  const eligible = (products || []).filter(
    (p) => p && p.id && p.name && (!predicate || predicate(p))
  );
  if (!q) return [];
  const codeHits = [];
  const nameHits = [];
  const hasDigit = /\d/.test(q);
  for (const p of eligible) {
    if (hasDigit && codeMatchesQuery(p, q)) codeHits.push(p);
    else if (nameMatchesQuery(p, q)) nameHits.push(p);
  }
  nameHits.sort((a, b) => a.name.localeCompare(b.name));
  const out = [];
  const seen = new Set();
  for (const p of codeHits.concat(nameHits)) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}
