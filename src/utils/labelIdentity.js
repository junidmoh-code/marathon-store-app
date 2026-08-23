// ─── PRODUCT IDENTITY, CLIENT SIDE — registered, and what it answers to ──────
// (Owner spec 2026-08-23.)
//
// THE RULE THIS FILE EXISTS FOR, stated once:
//
//     A PRODUCT REGISTERED WITH A LABEL NUMBER IS NOT A LEFTOVER. EVER.
//
// Registered means it carries a style code, OR any label alias, OR any label
// code record — by ANY route, at ANY time, from ANY surface. Three stores hold
// those facts and only one of them (products/{id}.styleCodeNormalised) is
// visible to a browser; the other two are Admin-SDK-only and arrive as the
// `productIdentity` callable's map. See functions/lib/label-identity.cjs.
//
// Everything here is PURE. Fetching and caching is labelIdentityStore.js;
// keeping the two apart is what lets the Leftovers rule be tested without a
// network, and what lets a screen fall back safely when the map has not
// arrived: an EMPTY map degrades to exactly the old behaviour (the style-code
// field alone), never to "everything is registered" and never to "nothing is".

// The map arrives as parsed JSON, so it has Object.prototype — and a product id
// of "constructor" or "toString" would resolve to an inherited function rather
// than an entry. Every lookup goes through this one guard.
function entryFor(identityMap, id) {
  if (!id || !identityMap || !Object.prototype.hasOwnProperty.call(identityMap, id)) return null;
  const entry = identityMap[id];
  return entry && typeof entry === "object" ? entry : null;
}

/** The identity entry for one product, normalised. Never null. */
export function identityFor(product, identityMap) {
  const id = product && product.id;
  const entry = entryFor(identityMap, id);
  const codes = [];
  const push = (c) => { if (c && !codes.includes(c)) codes.push(c); };
  // The product's own field leads — it is the canonical code, and it is the one
  // an operator sees on the label they are holding.
  push(product && product.styleCodeNormalised);
  for (const c of (entry && entry.c) || []) push(c);
  return {
    codes,
    aliases: (entry && Array.isArray(entry.a)) ? entry.a : [],
  };
}

/**
 * IS THIS PRODUCT REGISTERED?
 *
 * True on ANY of: the style-code field, a code that resolves to it (claim,
 * sibling claim or code alias), or a wording alias. False only when all three
 * stores are silent about it.
 */
export function isRegistered(product, identityMap) {
  if (!product) return false;
  if (product.styleCodeNormalised) return true;
  const entry = entryFor(identityMap, product.id);
  if (!entry) return false;
  return (Array.isArray(entry.c) && entry.c.length > 0)
      || (Array.isArray(entry.a) && entry.a.length > 0);
}

/**
 * WHY it counts as registered — one of "code" | "claim-or-alias" | null.
 * Used by the census/report and by the "already registered" note on a card, so
 * the answer is never just an assertion.
 */
export function registrationRoute(product, identityMap) {
  if (!product) return null;
  if (product.styleCodeNormalised) return "code";
  const entry = entryFor(identityMap, product.id);
  if (!entry) return null;
  if (Array.isArray(entry.c) && entry.c.length) return "claim-or-alias";
  if (Array.isArray(entry.a) && entry.a.length) return "claim-or-alias";
  return null;
}

/**
 * Every string this product should be findable by, besides its name: every
 * code and every alias token. The merge search matches against this so a code
 * read off a tongue label, or a word off it, finds the product — the whole
 * point of showing the code on the count screen in the first place.
 */
export function searchTermsFor(product, identityMap) {
  const { codes, aliases } = identityFor(product, identityMap);
  const out = [...codes];
  if (product && product.styleCode) out.push(String(product.styleCode));
  for (const tokens of aliases) for (const t of tokens) out.push(t);
  return out;
}
