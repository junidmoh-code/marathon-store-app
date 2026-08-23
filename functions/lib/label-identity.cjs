// ─── WHAT A PRODUCT IS REGISTERED AS — one map, built server-side ─────────────
// (Owner spec 2026-08-23: "A PRODUCT REGISTERED WITH A LABEL NUMBER IS NOT A
// LEFTOVER. EVER.")
//
// A product's label identity is spread across three stores, and only ONE of
// them is visible to the client:
//
//   1. products/{id}.styleCodeNormalised   — on the product record. Client-visible.
//   2. /style_code_index/{code}            — the ownership CLAIM: `productId`
//                                            plus a `siblings` map of colourway
//                                            siblings. Client-readable one key
//                                            at a time; there is no reverse
//                                            index from product to code.
//   3. /label_aliases/{id}                 — the label-reading store. `c` is a
//                                            map of code aliases, `t` a map of
//                                            wording tokens. Admin-SDK ONLY —
//                                            no client rules exist for it and
//                                            none should.
//
// Because 2 and 3 cannot be swept from a browser, every screen that needed to
// answer "is this product registered?" or "what codes and aliases does it
// answer to?" was answering from field 1 alone. That is the whole Leftovers
// defect: a product registered by ALIAS, or claimed in the index without the
// field ever being written back, read as unregistered and stayed on the list.
//
// This module is the pure fold: two nodes in, ONE compact map out.
//
//   { [productId]: { c: ["BQ6817302", ...], a: [["NIKE","AIR","FORCE"], ...] } }
//
// `c` — every code that resolves to this product, from ANY route, sorted and
//       deduped: the claim key, a sibling claim key, and every code alias.
// `a` — every wording-token set filed against it.
//
// A product with neither is simply absent from the map. That keeps the payload
// to the products that have an identity (about a thousand of four thousand) and
// makes the client test a one-liner: in the map, or carrying the field, means
// REGISTERED.
//
// It reads two whole nodes (~150KB together) and is therefore fetched ONCE per
// session and cached on the client, never per screen and never per product.

"use strict";

/** Add a code to a product's entry, creating the entry on first use. */
function addCode(map, productId, code) {
  if (!productId || typeof productId !== "string" || !code) return;
  const entry = map[productId] || (map[productId] = { c: [], a: [] });
  if (!entry.c.includes(code)) entry.c.push(code);
}

/**
 * Fold /label_aliases and /style_code_index into the identity map.
 *
 * @param {object|null} aliasesNode      /label_aliases
 * @param {object|null} styleIndexNode   /style_code_index
 * @returns {object} { [productId]: { c: string[], a: string[][] } }
 */
function buildIdentityMap(aliasesNode, styleIndexNode) {
  const map = {};

  for (const rec of Object.values(aliasesNode || {})) {
    if (!rec || typeof rec !== "object") continue;
    const pid = rec.productId;
    if (!pid || typeof pid !== "string") continue;
    if (rec.c && typeof rec.c === "object") {
      for (const code of Object.keys(rec.c)) if (rec.c[code]) addCode(map, pid, code);
    }
    if (rec.t && typeof rec.t === "object") {
      const tokens = Object.keys(rec.t).filter((t) => rec.t[t]).sort();
      if (tokens.length) {
        const entry = map[pid] || (map[pid] = { c: [], a: [] });
        // Identical token sets get filed more than once across re-reads of the
        // same label; the screen shows a list, not a log.
        const sig = tokens.join(" ");
        if (!entry.a.some((prev) => prev.join(" ") === sig)) entry.a.push(tokens);
      }
    }
  }

  for (const [codeKey, row] of Object.entries(styleIndexNode || {})) {
    if (!row || typeof row !== "object") continue;
    addCode(map, row.productId, codeKey);
    const siblings = row.siblings && typeof row.siblings === "object" ? row.siblings : {};
    for (const sibId of Object.keys(siblings)) {
      if (siblings[sibId]) addCode(map, sibId, codeKey);
    }
  }

  for (const entry of Object.values(map)) {
    entry.c.sort();
    entry.a.sort((x, y) => x.join(" ").localeCompare(y.join(" ")));
  }
  return map;
}

module.exports = { buildIdentityMap };
