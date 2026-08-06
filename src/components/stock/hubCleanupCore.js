// ─── HUB STOCK CLEANUP — PURE CORE ───────────────────────────────────────────
// The decision logic behind the combined Display Register + Hub Sneaker Count
// card: display registration (pass one), the scan-first count (pass two), the
// Leftovers list, and scan resolution. No firebase imports — everything here is
// a pure function over plain data, which is what the mutation tests exercise.
//
// THE MODEL (owner spec 2026-08-06): a display shoe sitting on a shop shelf IS
// hub stock. Registering it ADDS one unit to the hub's existing quantity for
// that size, through applyMovement like every other stock write. Scope is
// HUB 1 and HUB 2 only — Pine (marathon-pine / hub3) is entirely out of scope
// and no id from it may ever appear here.

import { normaliseStyleCode } from "../../utils/styleCode.js";
import { isMergedAway } from "../../utils/mergedProducts.js";
import { productIsFootwear } from "../../utils/footwearLine.js";

// The ONLY hubs this feature touches. A closed list, deliberately NOT derived
// from the location registry: the registry contains hub3 (Pine's lane), and
// "everything warehouse-shaped" is exactly the derivation that would leak it in.
export const CLEANUP_HUBS = Object.freeze(["hub1", "hub2"]);
export const CLEANUP_HUB_LABELS = Object.freeze({ hub1: "Hub 1", hub2: "Hub 2" });

export function isCleanupHub(hub) {
  return CLEANUP_HUBS.includes(hub);
}

// ── REGISTRATION KEYS ────────────────────────────────────────────────────────
// One registration slot per (product, size) per hub, and a DETERMINISTIC
// movement id derived from that slot. The movement id is the idempotency key
// applyMovement enforces, so scanning the same display twice — same device,
// other device, retry after a network drop — collapses to ONE stock unit.
export function registerKey(productId, sizeKey) {
  return `${productId}__${sizeKey}`;
}

export function registerMovementId(hub, productId, sizeKey) {
  return `dispreg_${hub}_${productId}_${sizeKey}`;
}

// The n-th EXTRA unit (a second physical display of the same product+size) gets
// its own deterministic id, derived from the quantity already registered — two
// devices racing to add "one more" onto the same base build the SAME id, and
// applyMovement lets exactly one of them count.
export function extraUnitMovementId(hub, productId, sizeKey, priorQty) {
  return `dispreg_${hub}_${productId}_${sizeKey}_a${priorQty}`;
}

// ── SCAN RESOLUTION ──────────────────────────────────────────────────────────
// A scan is one of: an 8-digit shop label (the /barcodes index answers, with a
// size when the label was per-size), a manufacturer style code off the tongue
// label (matched on styleCodeNormalised), or noise. The decision is pure; the
// caller does the /barcodes lookup and hands the row in.
//
//   { kind: "product", product, size|null }   resolved (size known when per-size)
//   { kind: "unresolved", code }              nothing owns this code — NOT an
//                                             error: in pass two this is the
//                                             signal the item was never
//                                             registered as a product at all.
export function resolveCleanupScan(raw, { products = [], barcodeRow = null } = {}) {
  const code = String(raw ?? "").trim();
  if (!code) return { kind: "unresolved", code };

  if (barcodeRow && barcodeRow.productId) {
    const p = (products || []).find((x) => x && x.id === barcodeRow.productId);
    if (p && !isMergedAway(p)) {
      return { kind: "product", product: p, size: barcodeRow.size != null ? String(barcodeRow.size) : null };
    }
    // A row pointing at a merged-away or unknown product: follow the pointer if
    // the survivor is in the catalogue; otherwise it is unresolved.
    if (p && isMergedAway(p)) {
      const survivor = (products || []).find((x) => x && x.id === p.mergedInto);
      if (survivor) return { kind: "product", product: survivor, size: barcodeRow.size != null ? String(barcodeRow.size) : null };
    }
    return { kind: "unresolved", code };
  }

  const normalised = normaliseStyleCode(code);
  if (normalised) {
    const owners = (products || []).filter((p) => p && !isMergedAway(p) && p.styleCodeNormalised === normalised);
    if (owners.length === 1) return { kind: "product", product: owners[0], size: null };
    if (owners.length > 1) {
      // Two live products claiming one code IS the duplicate case — surface it,
      // never guess which one the operator is holding.
      return { kind: "duplicate", code, products: owners };
    }
  }
  return { kind: "unresolved", code };
}

// ── REGISTRATION ENTRY (owner correction 2026-08-06) ─────────────────────────
// Nothing is CREATED during registration — every shoe already has a product
// record. The operator FINDS the shoe first (name search, or the not-yet-
// registered list; a barcode scan is only an optional shortcut), and the panel
// then captures TWO facts in one save: the manufacturer style number off the
// INNER TONGUE LABEL, and the size on display. Every entry path builds its
// panel through THIS one function, so search, the list and the shortcut are
// provably the same screen.
export function registerPanelFor(product, size = null) {
  if (!product || !product.id) return null;
  return { mode: "register", product, size: size != null ? String(size) : null, code: null };
}

// The style-number step's outcome, from a tongue-label read or typing. The
// register save refuses to complete until one of these holds:
//   on file  — the product already carries an immutable styleCodeNormalised
//   captured — a code was read from the label or typed (normalises non-empty)
//   skipped  — a deliberate, reasoned "this shoe has no readable style number"
export const STYLE_SKIP_REASONS = Object.freeze(["label_unreadable", "label_missing", "no_code_exists"]);

export function styleStepSatisfied(product, styleCode) {
  if (product && product.styleCodeNormalised) return true;
  if (styleCode && typeof styleCode.code === "string" && normaliseStyleCode(styleCode.code)) return true;
  if (styleCode && STYLE_SKIP_REASONS.includes(styleCode.skipped)) return true;
  return false;
}

// What a tongue-label OCR response means for the UI: one clean candidate is
// chosen outright; several become tap-chips; none falls back to typing.
export function chooseFromLabelRead(data) {
  const candidates = Array.isArray(data && data.candidates) ? data.candidates.filter(Boolean) : [];
  const display = Array.isArray(data && data.displayCandidates) && data.displayCandidates.length === candidates.length
    ? data.displayCandidates : candidates;
  if (candidates.length === 1) return { kind: "chosen", code: display[0] };
  if (candidates.length > 1) return { kind: "options", options: display };
  const broken = Array.isArray(data && data.errors) && data.errors.length > 0;
  return { kind: "none", message: broken
    ? "The label reader is unavailable right now — type the style number instead."
    : "Couldn't read a style number off that photo — try again closer, or type it." };
}

// Live products already claiming this code — the duplicate case, surfaced
// before the save so the operator routes to Merge instead of guessing.
export function styleCodeOwners(code, products, excludeId = null) {
  const normalised = normaliseStyleCode(code);
  if (!normalised) return [];
  return (products || []).filter((p) =>
    p && p.id !== excludeId && !isMergedAway(p) && p.styleCodeNormalised === normalised);
}

// An open /duplicate_candidates row involving this product, if any — the scan
// flow surfaces it as a Merge entry point.
export function openDuplicateFor(productId, duplicateRows) {
  for (const [pairId, row] of Object.entries(duplicateRows || {})) {
    if (!row || row.status !== "open") continue;
    if (row.productIdA === productId || row.productIdB === productId) {
      return { pairId, ...row, otherId: row.productIdA === productId ? row.productIdB : row.productIdA };
    }
  }
  return null;
}

// ── SIZES ────────────────────────────────────────────────────────────────────
// Real, pickable sizes: the "_" one-size sentinel is never a display size, and
// the raw size string is what callers hand BACK to the stock layer — the
// encoding into a storage key happens inside applyMovement/stockSizeKey, never
// here. Keeping label and key on separate code paths is what stops a display
// label ever minting a phantom cell.
export function realSizes(product) {
  const raw = product && product.sizes;
  const arr = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? Object.values(raw) : []);
  return arr.map(String).map((s) => s.trim()).filter((s) => s && s !== "_");
}

// ── LEFTOVERS ────────────────────────────────────────────────────────────────
// After registration: every footwear product that HOLDS stock at this hub but
// was never seen on the floor. One card per product; qty per location comes
// from `allStock` = { loc: { pid: { sizeKey: cell } } }.
export function buildLeftovers({ hub, products = [], hubStock = {}, registered = {}, allStock = null }) {
  const registeredPids = new Set(Object.values(registered || {}).map((r) => r && r.productId).filter(Boolean));
  const out = [];
  for (const p of products) {
    if (!p || !p.id || isMergedAway(p) || !productIsFootwear(p)) continue;
    const cells = hubStock[p.id];
    if (!cells) continue;
    const hubQty = totalQty(cells);
    if (hubQty <= 0) continue;                 // nothing actually held here
    if (registeredPids.has(p.id)) continue;    // seen on the floor — not a leftover
    out.push({
      product: p,
      hubQty,
      locations: allStock ? locationsHolding(p.id, allStock) : null,
    });
  }
  out.sort((a, b) => b.hubQty - a.hubQty || String(a.product.name || "").localeCompare(String(b.product.name || "")));
  return out;
}

export function totalQty(cells) {
  let sum = 0;
  for (const [k, cell] of Object.entries(cells || {})) {
    if (k === "_meta" || !cell || typeof cell !== "object") continue;
    if (typeof cell.qty === "number") sum += cell.qty;
  }
  return sum;
}

/** Every location this product holds stock at (non-zero), with qty and per-size detail. */
export function locationsHolding(productId, allStock) {
  const out = [];
  for (const [loc, prods] of Object.entries(allStock || {})) {
    const cells = prods && prods[productId];
    if (!cells) continue;
    const qty = totalQty(cells);
    const sizes = {};
    for (const [k, cell] of Object.entries(cells)) {
      if (k === "_meta" || !cell || typeof cell !== "object") continue;
      if (typeof cell.qty === "number" && cell.qty !== 0) sizes[k] = cell.qty;
    }
    if (qty !== 0 || Object.keys(sizes).length) out.push({ loc, qty, sizes });
  }
  out.sort((a, b) => b.qty - a.qty);
  return out;
}

// ── PROGRESS ─────────────────────────────────────────────────────────────────
// "Scanned versus expected" for the zone (the hub): how many stock-holding
// footwear products have been seen (registered) against how many the hub holds.
export function registrationProgress({ products = [], hubStock = {}, registered = {} }) {
  const registeredPids = new Set(Object.values(registered || {}).map((r) => r && r.productId).filter(Boolean));
  let expected = 0;
  let seen = 0;
  for (const p of products) {
    if (!p || !p.id || isMergedAway(p) || !productIsFootwear(p)) continue;
    const cells = hubStock[p.id];
    if (!cells || totalQty(cells) <= 0) {
      // Products with no hub stock can still be registered (that is how a
      // forgotten display gets its unit back) — count them as seen-extras.
      if (registeredPids.has(p.id)) seen += 0; // not part of "expected"
      continue;
    }
    expected += 1;
    if (registeredPids.has(p.id)) seen += 1;
  }
  return { seen, expected, units: Object.values(registered || {}).reduce((n, r) => n + (Number(r && r.qty) || 0), 0) };
}
