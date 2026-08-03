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

export const normalizeName = (s) =>
  s.trim().replace(/\s+/g, " ").toLowerCase().replace(/\s*-\s*/g, "-");

// Sentinel marking a name that maps to MORE than one product id. Kept as a
// value (not absence) so "seen twice" can't be re-set by a third duplicate.
const AMBIGUOUS = Symbol("ambiguous-product-name");

// products: array of catalog records ({ id, name, ... }).
// Returns { exact, norm, duplicates }:
//   exact/norm — Map(name → pid | AMBIGUOUS)
//   duplicates — [{ name, ids }] one entry per exact name shared by >1 id,
//                for the caller to warn about (this is the collision the old
//                warning never caught: byte-identical names never differed).
export function buildProductIdIndex(products) {
  const exact = new Map();
  const norm = new Map();
  const dupIds = new Map(); // exact name → Set(ids), only for duplicated names
  const mark = (map, key, id) => {
    if (!map.has(key)) { map.set(key, id); return; }
    if (map.get(key) !== id) map.set(key, AMBIGUOUS);
  };
  (products || []).forEach((p) => {
    if (!p || !p.name || !p.id) return;
    if (exact.has(p.name) && exact.get(p.name) !== p.id) {
      if (!dupIds.has(p.name)) dupIds.set(p.name, new Set([exact.get(p.name) === AMBIGUOUS ? null : exact.get(p.name)].filter(Boolean)));
      dupIds.get(p.name).add(p.id);
    }
    mark(exact, p.name, p.id);
    mark(norm, normalizeName(p.name), p.id);
  });
  const duplicates = Array.from(dupIds.entries()).map(([name, ids]) => ({ name, ids: Array.from(ids) }));
  return { exact, norm, duplicates };
}

// pid when the name is UNIQUE in the catalog; null when unknown OR ambiguous.
// Never guesses: a wrong pid here becomes a wrong /stock write downstream.
export function resolveProductIdByName(index, name) {
  if (!index || !name) return null;
  const hitExact = index.exact.get(name);
  if (hitExact && hitExact !== AMBIGUOUS) return hitExact;
  const hitNorm = index.norm.get(normalizeName(name));
  if (hitNorm && hitNorm !== AMBIGUOUS) return hitNorm;
  return null;
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
