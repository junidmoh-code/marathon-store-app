// ─── PRODUCT IDENTITY — name→id resolution that REFUSES to guess ─────────────
// The catalog allows duplicate product names (2026-08-03: 177 exact-duplicate
// groups covering 515 products, incl. three byte-identical "Nike SB Dunk Low
// Green White" records). Any name→product lookup is therefore ambiguous by
// construction, and the old last-writer-wins maps silently picked one twin —
// which is how a refill card could deduct stock from the wrong colourway
// (see _twin-name-collision-forensic-report.md).
//
// This module is the single home for name-based product resolution:
//   • buildProductIdIndex  — name → pid, with every duplicated name marked
//     AMBIGUOUS instead of overwritten. `duplicates` lists them for warnings.
//   • resolveProductIdByName — returns a pid ONLY when the name is unique;
//     ambiguous or unknown names return null and the caller must degrade
//     (Source cards fall back to their non-transfer buttons).
//   • buildPhotoIndex / photoForProduct — photo joins prefer the product id;
//     the name maps remain only as a fallback for pid-less legacy records
//     (last-writer-wins there is unavoidable and display-only).
// Names are matched raw and normalized (trim, collapse spaces, lowercase,
// collapse spaced hyphens) — the same normalization the old maps used.

// String()-coerced on the way in: /products has no schema, so a numeric or
// object `name` reaches here unchanged (the catalog already holds names like
// "2598" that are one careless re-save away from being stored as a number).
// Both index builders run inside a useMemo in SourceView, so a TypeError here
// would white-screen the ENTIRE Source view rather than degrade one card.
export const normalizeName = (s) =>
  String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase().replace(/\s*-\s*/g, "-");

// Sentinel marking a name that maps to MORE than one product id. Kept as a
// value (not absence) so "seen twice" can't be re-set by a third duplicate.
const AMBIGUOUS = Symbol("ambiguous-product-name");

// products: array of catalog records ({ id, name, ... }).
// Returns { exact, norm, duplicates, normalizedDuplicates }:
//   exact/norm           — Map(name → pid | AMBIGUOUS)
//   duplicates           — [{ name, ids }] per exact name shared by >1 id (the
//                          collision the old warning never caught: byte-
//                          identical names never differed as strings).
//   normalizedDuplicates — names that differ as strings but collide once
//                          normalized ("Air Max 90" / "air  max 90"). These
//                          also refuse to resolve, so they must be warned about
//                          too or the operator gets a silently disabled Fulfil
//                          button with no diagnostic. Groups already reported in
//                          `duplicates` are filtered out so nothing warns twice.
// Collected id-first (Set per name) rather than by overwriting as we go: the
// same record appearing twice is not a collision, and a third twin must not
// reset the verdict.
export function buildProductIdIndex(products) {
  const exactIds = new Map(); // name            → Set(pid)
  const normIds = new Map();  // normalized name → Set(pid)
  const add = (map, key, id) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(id);
  };
  (products || []).forEach((p) => {
    if (!p || !p.name || !p.id) return;
    // String()-keyed, not raw: a numeric name 2598 and a string "2598" are
    // DIFFERENT Map keys, so an uncoerced index would resolve a lookup for
    // "2598" to whichever one happened to be the string — silently picking
    // between two products a human calls the same name, which is the exact
    // class of bug this module exists to refuse.
    add(exactIds, String(p.name), p.id);
    add(normIds, normalizeName(p.name), p.id);
  });
  // One id → that id; more than one → AMBIGUOUS, never a guess.
  const resolveMap = (idMap) => {
    const out = new Map();
    idMap.forEach((ids, key) => out.set(key, ids.size === 1 ? [...ids][0] : AMBIGUOUS));
    return out;
  };
  const collisions = (idMap) => Array.from(idMap.entries())
    .filter(([, ids]) => ids.size > 1)
    .map(([name, ids]) => ({ name, ids: Array.from(ids) }));
  const duplicates = collisions(exactIds);
  const sig = (ids) => ids.slice().sort().join("|");
  const exactSigs = new Set(duplicates.map((d) => sig(d.ids)));
  return {
    exact: resolveMap(exactIds),
    norm: resolveMap(normIds),
    duplicates,
    normalizedDuplicates: collisions(normIds).filter((d) => !exactSigs.has(sig(d.ids))),
  };
}

// pid when the name is UNIQUE in the catalog; null when unknown OR ambiguous.
// Never guesses: a wrong pid here becomes a wrong /stock write downstream.
export function resolveProductIdByName(index, name) {
  if (!index || !name) return null;
  // Coerced to match the index's String() keying — see buildProductIdIndex.
  const hitExact = index.exact.get(String(name));
  if (hitExact && hitExact !== AMBIGUOUS) return hitExact;
  const hitNorm = index.norm.get(normalizeName(name));
  if (hitNorm && hitNorm !== AMBIGUOUS) return hitNorm;
  return null;
}

// THE product-id resolver for a Source card / on-hold item. Its own productId
// wins; only a record that predates the field falls back to the name index,
// which refuses duplicated names. Exported (rather than inlined in the
// component) so App.jsx and its tests exercise the same function and cannot
// drift apart. product: { productId?, productName? }.
export function resolveProductId(product, index) {
  if (!product) return null;
  if (product.productId) return product.productId;
  return resolveProductIdByName(index, product.productName);
}

// The Source card's stock-transfer gate. A card may move stock ONLY with a
// resolved, unambiguous product id — resolveProductIdByName returning null for
// an ambiguous name must DISABLE Fulfil, not fall through to a guess. Callers
// with a null id keep their plain Available/Sent buttons (safe: the response is
// recorded, no stock moves).
export function canFulfilCard({ enabled, productId }) {
  return !!(enabled && productId);
}

// Photo lookup: byId is authoritative (one photo per product, twins can't
// cross); the name maps are the display-only fallback for pid-less records.
export function buildPhotoIndex(products) {
  const byId = new Map();
  const byName = new Map();
  const byNorm = new Map();
  (products || []).forEach((p) => {
    if (!p) return;
    const entry = { photoUrl: p.photoUrl || null, photo: p.photo || "" };
    if (p.id) byId.set(p.id, entry);
    if (p.name) {
      byName.set(p.name, entry);
      byNorm.set(normalizeName(p.name), entry);
    }
  });
  return { byId, byName, byNorm };
}

const NO_PHOTO = { photoUrl: null, photo: "" };

// product: anything carrying { productId?, productName? } (a Source group, an
// on-hold item, a log event). Id wins; name only fills in for legacy records.
export function photoForProduct(index, product) {
  if (!index || !product) return NO_PHOTO;
  if (product.productId && index.byId.has(product.productId)) return index.byId.get(product.productId);
  const name = product.productName;
  if (!name) return NO_PHOTO;
  return index.byName.get(name) || index.byNorm.get(normalizeName(name)) || NO_PHOTO;
}
