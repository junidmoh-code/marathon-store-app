// ─── STYLE CODE SIBLINGS — client twin of functions/lib/style-code-siblings ──
// One style code may own SEVERAL sibling products (colourways): the standard
// Nike tongue label prints no colourway text, so one printed code on two real
// colourways is manufacturer behaviour, not a data error (owner evidence
// 2026-08-07, HF5509-002 — white US 7, white US 8 and BLACK US 8.5 all
// printing the same code and the same UPC).
//
// SERVER TWIN of functions/lib/style-code-siblings.cjs (the ESM/CJS boundary
// keeps them apart, the same arrangement as styleCode.js). Kept byte-for-byte
// equivalent in BEHAVIOUR and pinned by src/utils/styleCodeSiblings.test.js,
// which asserts both agree on every case. If you change one, change the other
// or that test fails.
//
// The claim node keeps its original shape — { productId, claimedAt, claimedBy }
// — plus one server-written child: siblings: { {productId}: {...} }. A legacy
// claim with no siblings child reads as exactly one owner, which is why no
// migration of existing claims exists: the old shape IS the one-owner case.

/**
 * Every product id that owns this code: the primary claimant first, then the
 * siblings in key order. [] when the node is empty or malformed.
 */
export function claimOwnerIds(claimNode) {
  if (!claimNode || typeof claimNode !== "object") return [];
  const out = [];
  const primary = typeof claimNode.productId === "string" && claimNode.productId ? claimNode.productId : null;
  if (primary) out.push(primary);
  const sib = claimNode.siblings;
  if (sib && typeof sib === "object" && !Array.isArray(sib)) {
    for (const id of Object.keys(sib).sort()) {
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** Are BOTH products registered owners of this code? Then their sharing it is
 *  sibling colourways, not a collision. */
export function isSiblingPair(claimNode, idA, idB) {
  const owners = claimOwnerIds(claimNode);
  return owners.includes(String(idA)) && owners.includes(String(idB)) && String(idA) !== String(idB);
}

/** Do the OWNERS of this claim fully cover this candidate set? True means the
 *  index vouches for every product shown — the picker can say "colourways",
 *  not "duplicates", and nothing needs a merge banner. */
export function allRegisteredSiblings(claimNode, productIds) {
  const ids = (productIds || []).map(String).filter(Boolean);
  if (ids.length < 2) return false;
  const owners = claimOwnerIds(claimNode);
  return ids.every((id) => owners.includes(id));
}
