// ─── NEW PRODUCT RECORD BUILDER ───────────────────────────────────────────────
// The pure shape-building half of Add Product, split out of the App.jsx save
// handler so THE critical guarantee is directly testable:
//
//   a product created through the new category form must be indistinguishable,
//   to every existing automation, from one created through the old form.
//
// "Every existing automation" means, concretely:
//   • functions/lib/refill-engine.cjs  isClothing()      → productType
//   • functions/displayChecks/lib.cjs  isClothingSale()  → category | productType
//   • marathon-pos-app ProductSearchScreen               → category / subcategory / brand
//   • marathon-pos-app shoeboxToggle                     → the size STRING only
//
// So this writes the legacy triple derived from the chosen category, and only
// ADDS `categoryKey` alongside. It never removes or rewrites a legacy field.

import { legacyFor, sizesOf, catByKey } from "./productTaxonomy.js";
import { normaliseStyleCode, formatStyleCodeForDisplay } from "./styleCode.js";
import { normalisePrintedBarcode } from "./eanBarcode.js";
import { isPerfume } from "./productCategory.js";

// A printed manufacturer code is only ever accepted through the ONE gate — the
// right length AND its own check digit. Same function the capture UI uses, so
// the two can never disagree about what a valid code is.
const isPrintedBarcode = (v) => normalisePrintedBarcode(v).ok;

export const VALID_HUBS = ["hub1", "hub2", "hub3"];

/**
 * Phase 14A rule, unchanged: clothing cannot be stocked at Hub 1. Strips hub1
 * for clothing, drops anything that isn't a real hub, and falls back to a
 * sensible default rather than writing an empty list.
 */
export function cleanHubs(hubs, isClothing) {
  const cleaned = (Array.isArray(hubs) ? hubs : [])
    .filter((h) => (isClothing ? h !== "hub1" : true))
    .filter((h) => VALID_HUBS.includes(h));
  if (cleaned.length) return [...new Set(cleaned)];
  return isClothing ? ["hub2"] : ["hub1"];
}

/**
 * Build the /products record for a new product.
 *
 * Returns null when the category does not resolve — the caller must refuse the
 * save rather than write a product with no legacy fields, which would fall out
 * of refill, Display Checks and POS browse silently.
 *
 * @param {object}   registry   live taxonomy registry
 * @param {object}   form       { name, categoryKey, photo, hubs, stockPrice, retailPrice, hasShoeBoxOption }
 * @param {object}   extras     { id, photoUrl, brand, photoUploaded, styleCode,
 *                                 exempt: { reason, by, at } }
 */
export function buildNewProduct(registry, form, extras = {}) {
  const cat = catByKey(registry, form && form.categoryKey);
  // legacyFor returns null for an unknown key, a RETIRED category, or a legacy
  // block whose category/productType are not legal values — see isLegalLegacy.
  // Refusing here is the guard that stops a console typo (productType
  // "apparel") from creating a product that silently sits outside the refill
  // sweep and Display Checks with nothing on screen to say so.
  const legacy = legacyFor(registry, form && form.categoryKey);
  if (!cat || !legacy) return null;

  const runSizes = sizesOf(cat);
  if (!runSizes.length) return null;

  // ── THE SIZE RUN IS CHOSEN, NOT ASSUMED (owner fix 3, 2026-08-06) ──────────
  // For a multi-size category the operator SELECTS which sizes this product
  // actually comes in; only those become product.sizes — so only those get a
  // stock cell or a barcode, and the refill engine (which infers what a
  // location carries from CELL PRESENCE) never learns about a size we will
  // never stock. Selection is validated against the category's own run,
  // preserving the run's canonical order. Nothing selected → refuse the save:
  // choosing the run is a deliberate act, and a shoe with no sizes is not a
  // product. One-size categories are UNTOUCHED — they stay the "_" sentinel
  // straight from the taxonomy, never a display label.
  let sizes;
  if (runSizes.length === 1 && runSizes[0] === "_") {
    sizes = runSizes;
  } else {
    const chosen = new Set(
      (Array.isArray(form.sizeRun) ? form.sizeRun : []).map((x) => String(x).trim()).filter(Boolean)
    );
    sizes = runSizes.filter((sz) => chosen.has(String(sz)));
    if (!sizes.length) return null;
  }

  const isClothing = legacy.productType === "clothing";

  const product = {
    name: String(form.name || "").trim(),
    // ── NEW — inert. Nothing in either repo reads it yet.
    categoryKey: cat.key,
    // ── LEGACY — load-bearing. Do not remove.
    category: legacy.category,
    brand: extras.brand ?? null,
    photo: form.photo,
    photoUrl: extras.photoUrl ?? null,
    hubs: cleanHubs(form.hubs, isClothing),
    sizes,
    id: extras.id,
  };

  // OMITTED, not written as null, when the category has no legacy equivalent:
  // Loafers and Dresses have no leaf in the old tree, and Perfume deliberately
  // carries no productType so it matches the 53 live perfume records and stays
  // out of the refill lane while Display Checks still fire on its CATEGORY.
  if (legacy.subcategory != null) product.subcategory = legacy.subcategory;
  if (legacy.productType != null) product.productType = legacy.productType;

  // Prices: empty / non-finite / non-positive → omit entirely. Writing 0 would
  // make the POS treat the product as free.
  const stockNum = Number(form.stockPrice);
  const retailNum = Number(form.retailPrice);
  if (Number.isFinite(stockNum) && stockNum > 0) product.stockPrice = stockNum;
  if (Number.isFinite(retailNum) && retailNum > 0) product.retailPrice = retailNum;

  // Explicit for POS (legacy products without it read as false per SCHEMA.md).
  // Clothing NEVER has a shoebox regardless of form state.
  product.hasShoeBoxOption = isClothing ? false : !!form.hasShoeBoxOption;

  if (extras.photoUploaded && extras.photoUpdatedAt != null) product.photoUpdatedAt = extras.photoUpdatedAt;

  // ── STYLE CODE — the manufacturer code off the inside-tongue label ─────────
  // Two fields, both written or neither:
  //   styleCode            the human-readable form, as the brand prints it
  //   styleCodeNormalised  the identity key — uppercase, separators stripped.
  //                        THIS is what lookups, the /sneaker_models cache and
  //                        the duplicate check match on, and what the /products
  //                        .indexOn covers.
  // OMITTED (not written as null) when there is no code: clothing, accessories
  // and perfume have no style code, and a null on every one of them is 5,000
  // pointless bytes that also make "has a code" a two-condition test everywhere.
  // Absent means "no code" — every reader must tolerate it.
  const styleCodeNormalised = normaliseStyleCode(extras.styleCode);
  if (styleCodeNormalised) {
    // Keep the operator's spelling when they gave one; otherwise render the
    // canonical form. The KEY is always the normalised value either way.
    const typed = String(extras.styleCode || "").trim();
    product.styleCode = typed || formatStyleCodeForDisplay(styleCodeNormalised);
    product.styleCodeNormalised = styleCodeNormalised;
  }

  // ── LABEL EXTRAS — what else the tongue label printed ─────────────────────
  // (Owner spec 2026-08-07.) A colourway line when the label carries one
  // (RTFKT-style Nike prints "WOLF GREY/PHOTO BLUE"; the standard label prints
  // none), the model-name line, and the UPC. All three are EVIDENCE, not keys:
  // the UPC especially is NON-AUTHORITATIVE — this stock reuses one UPC across
  // a size run, so nothing may ever assume one UPC means one shoe, and it is
  // never written to /barcodes (our own minted namespace). OMITTED when
  // absent, never null — an `undefined` anywhere in the record aborts the
  // whole save client-side (the 2026-08-06 outage).
  if (typeof extras.labelColorway === "string" && extras.labelColorway.trim()) {
    product.labelColorway = extras.labelColorway.trim().slice(0, 64);
  }
  if (typeof extras.labelUpc === "string" && /^\d{12,14}$/.test(extras.labelUpc)) {
    product.labelUpc = extras.labelUpc;
  }
  if (typeof extras.labelModelName === "string" && extras.labelModelName.trim()) {
    product.labelModelName = extras.labelModelName.trim().slice(0, 64);
  }
  // ── THE MANUFACTURER'S OWN PRINTED BARCODE (perfume) ──────────────────────
  // Perfume boxes carry a real EAN-13 from the factory, so we capture theirs
  // instead of minting ours. Two things are written for it, and they are NOT
  // the same thing:
  //   • THIS field — the product's copy, so the detail page can show it, search
  //     can find it, and a later capture can tell "already registered" from
  //     "not captured yet". Nothing resolves a scan through it.
  //   • /barcodes/{code} → { productId, size:"_" } — the reverse index the POS
  //     actually scans against. Written after the product exists, by
  //     components/stock/printedBarcodeStore.js, because the rule on that path
  //     requires the referenced product to exist and is CREATE-ONLY.
  // Validated here as a last line of defence rather than trusted: the value has
  // already passed normalisePrintedBarcode at capture, and a record that
  // somehow carries an unchecked number would put a code on a product that no
  // physical box matches. OMITTED when absent — never null (see the 2026-08-06
  // undefined/omission outage above).
  // GATED ON THE CATEGORY, not merely on a value being present. The Add Product
  // form keeps one draft across a category change, so an operator who captures
  // a perfume EAN and then switches to Sneakers would otherwise carry that code
  // onto a SIZED product — and it would be registered against size "_", so a
  // POS scan would resolve to a one-size cell on a product whose real sizes are
  // "9" and "10". Wrong cell, wrong deduction. The form clears the field on a
  // category change; this refuses it outright, so no caller can reintroduce the
  // bug. (Codex review, PR #340.)
  if (isPerfume(legacy)
      && typeof extras.printedBarcode === "string"
      && isPrintedBarcode(extras.printedBarcode)) {
    product.printedBarcode = extras.printedBarcode;
  }

  // Dominant colours off a photo of the shoe — an ORDERING signal for the
  // sibling-colourway picker, never a selector (utils/dominantColours.js).
  if (Array.isArray(extras.dominantColours) && extras.dominantColours.length) {
    const clean = extras.dominantColours
      .filter((s) => s && Number.isFinite(s.r) && Number.isFinite(s.g) && Number.isFinite(s.b))
      .slice(0, 3)
      .map((s) => ({ r: s.r, g: s.g, b: s.b, w: Number.isFinite(s.w) ? s.w : 0 }));
    if (clean.length) product.dominantColours = clean;
  }

  // ── STYLE CODE EXEMPTION ──────────────────────────────────────────────────
  // Some footwear genuinely has no manufacturer style code — designer and
  // unbranded stock especially. Those products can never satisfy the gate, so
  // the bypass records WHY rather than leaving a silent hole.
  //
  // This matters beyond bookkeeping: an exempt product gets NO
  // /style_code_index claim, so it has no uniqueness guard at all. The reason
  // is what makes the bypass rate countable — a rising `no_code_exists` means
  // the product mix is shifting, a rising `label_*` means something is wrong
  // with how stock reaches us. Different problems, different fixes.
  //
  // Written only when a reason is present; a bypass with no reason is not a
  // bypass, it is a gap, and buildNewProduct will not create one.
  const exempt = extras.exempt;
  if (exempt && typeof exempt.reason === "string" && exempt.reason) {
    product.styleCodeExempt = true;
    product.styleCodeExemptReason = exempt.reason;
    product.styleCodeExemptBy = exempt.by ?? null;
    // serverNowMs() upstream — never the device clock. /products timestamp
    // validators compare against the SERVER clock, and a fast tablet writes a
    // value that is silently rejected.
    product.styleCodeExemptAt = Number.isFinite(exempt.at) ? exempt.at : null;
  }

  return product;
}

// ─── STYLE CODE PROVENANCE STAMP ──────────────────────────────────────────────
// Where the confirmed style code came from and who accepted it — recorded so a
// wrong catalogue match is traceable later. Split out of the App.jsx save
// handler because getting this wrong took the whole Add Product flow down for
// every non-enforced category: the non-enforced path seeds a sentinel intake
// with NO provenance keys, and copying them unconditionally put `undefined`
// into the record, which the Firebase SDK rejects client-side BEFORE the write
// ("contains undefined in property 'products.<id>.styleCodeSource'"). Watches,
// clothing, perfume — every save failed with the generic alert.
//
// The invariant, matching buildNewProduct's own styleCode handling: provenance
// is written ONLY when the record actually carries a style code, and only from
// values that exist. No code → no styleCode* field of any kind, ever. A
// bypassed (exempt) product keeps its attribution in styleCodeExempt* — the
// provenance of a code it does not have would be meaningless.
export function stampStyleCodeProvenance(product, intake, confirmedBy) {
  if (!product || !intake) return product;
  if (!product.styleCodeNormalised) return product;
  if (intake.styleCodeSource != null) product.styleCodeSource = intake.styleCodeSource;
  if (intake.styleCodeFetchedAt != null) product.styleCodeFetchedAt = intake.styleCodeFetchedAt;
  if (confirmedBy != null) product.styleCodeConfirmedBy = confirmedBy;
  return product;
}

// True when a value is safe to hand to RTDB set(): the SDK throws on ANY
// `undefined` anywhere in the tree, which aborts the save before a single byte
// reaches the server. Used by tests to prove new-product records stay
// writeable; cheap enough to reuse anywhere a record is assembled from
// optional sources.
export function isSetSafe(value) {
  if (value === undefined) return false;
  if (value === null || typeof value !== "object") return true;
  return Object.values(value).every(isSetSafe);
}
