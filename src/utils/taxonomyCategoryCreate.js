// ─── CATEGORY CREATION — behaviour in, legacy fields out ─────────────────────
// The admin Taxonomy tab creates categories from BEHAVIOUR ANSWERS, never from
// free-form legacy fields. The owner picks:
//   • refill lane: clothing / sneaker / none
//   • display checks: yes / no
// and this module derives the legacy `category` / `subcategory` / `productType`
// triple those answers actually mean — through the same contract PR #280
// documented and isLegalLegacy polices. The operator never types a legacy
// value, so a typo like productType "apparel" (which would silently drop a
// product out of refill AND Display Checks) is unrepresentable.
//
// THE LANE ↔ CHECKS COUPLING IS REAL, NOT A UI CHOICE. Live automations read:
//   refill engine  isClothing():     explicit productType wins, else the
//                                    letter-size heuristic
//   Display Checks isClothingSale(): category === "Perfume" OR
//                                    productType === "clothing"
// So some combinations cannot exist: productType "clothing" ALWAYS fires
// checks; "sneaker" never does. deriveNewCategory therefore FORCES the checks
// answer where the lane decides it, and says so in the preview instead of
// pretending the choice existed. The one free pairing is lane "none":
//   checks yes → the Perfume pattern (category "Perfume", productType omitted)
//   checks no  → Accessories with productType omitted — with a stated caveat
//                that letter sizes still trip the engine's size heuristic.
// Perfume deliberately OMITS productType; Accessories deliberately keeps
// "clothing" (both existing behaviours, preserved bit-for-bit by these rules).

import { isLegalLegacy, ONE_SIZE_SENTINEL, FLAG_UNSET } from "./productTaxonomy.js";
import { sizeRunsOf, runSizes } from "./sizeRuns.js";

export const REFILL_LANES = ["clothing", "sneaker", "none"];

/** "Chains & Bracelets" → "chains-bracelets" (the existing key style). */
export function slugForLabel(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Which display-checks answers are actually available for a lane, and why.
 * Returns { forced: true|false|null, why } — null means both answers are real.
 */
export function checksChoiceForLane(lane) {
  if (lane === "clothing") return { forced: true, why: "Product type \"clothing\" always fires a Display Check on sale — the trigger reads that field." };
  if (lane === "sneaker") return { forced: false, why: "Sneaker-lane products never fire Display Checks — the trigger only reacts to clothing and perfume." };
  return { forced: null, why: null };
}

/**
 * THE derivation. Input: { label, top ("footwear"|"clothing"), oneSize (bool),
 * sizeRunKey (when !oneSize), refillLane, displayChecks (bool) } plus the live
 * registry. Output:
 *   { ok:true, key, record, preview } — record is the full /cats/{key} value
 *   { ok:false, message }             — refuse, with an operator-facing reason
 * Never throws on bad input; never returns a record isLegalLegacy rejects.
 */
export function deriveNewCategory(input, registry) {
  const label = String(input.label || "").trim();
  if (label.length < 2) return { ok: false, message: "Give the category a name (2+ characters)." };
  const key = slugForLabel(label);
  if (!key) return { ok: false, message: "That name has no usable characters for a key." };
  const cats = (registry && registry.cats) || {};
  if (cats[key]) return { ok: false, message: `"${label}" already exists as "${key}" — edit that category instead.` };

  const top = input.top === "footwear" ? "footwear" : "clothing";
  const lane = REFILL_LANES.includes(input.refillLane) ? input.refillLane : null;
  if (!lane) return { ok: false, message: "Pick a refill lane." };

  // Checks: apply the forcing before deriving, so the preview never lies.
  const forced = checksChoiceForLane(lane).forced;
  const checks = forced == null ? !!input.displayChecks : forced;

  const oneSize = !!input.oneSize;
  let sizes, sizeRunKey = null;
  if (oneSize) {
    sizes = [ONE_SIZE_SENTINEL];
  } else {
    const runs = sizeRunsOf(registry);
    const run = runs[input.sizeRunKey];
    if (!run) return { ok: false, message: "Pick a size run." };
    sizeRunKey = input.sizeRunKey;
    sizes = runSizes(run);
  }

  // The legacy triple the behaviour answers mean (see header).
  let legacy;
  if (lane === "sneaker") {
    legacy = { category: "Footwear", subcategory: label, productType: "sneaker" };
  } else if (lane === "clothing") {
    legacy = { category: oneSize ? "Accessories" : "Clothing", subcategory: label, productType: "clothing" };
  } else if (checks) {
    legacy = { category: "Perfume", subcategory: label, productType: null };
  } else {
    legacy = { category: "Accessories", subcategory: label, productType: null };
  }
  if (!isLegalLegacy(legacy)) return { ok: false, message: "Derived legacy fields failed validation — refusing to create." };

  const maxOrder = Math.max(0, ...Object.values(cats).map((c) => (c && typeof c.order === "number" ? c.order : 0)));
  const record = {
    key, label, top,
    order: maxOrder + 1,
    sizeMode: oneSize ? "one" : "list",
    sizes,
    ...(sizeRunKey ? { sizeRunKey } : {}),
    legacy,
    flags: { refillManaged: FLAG_UNSET, displayChecks: FLAG_UNSET, oneSize: FLAG_UNSET },
    active: true,
  };

  // Plain-English preview — what saving will actually do, before it does it.
  const letterSized = !oneSize && sizes.some((s) => /[A-Za-z]/.test(s));
  const preview = [
    lane === "clothing" ? "Refill: products enter the CLOTHING refill lane (the engine manages them)."
      : lane === "sneaker" ? "Refill: products enter the SNEAKER refill lane (refills are created from sales only)."
      : "Refill: no lane — the engine does not manage these products."
      + (letterSized ? " CAVEAT: letter sizes (S/M/L…) still match the engine's size heuristic, so letter-sized products may be picked up anyway." : ""),
    checks ? "Display Checks: YES — every sale asks the floor to check the display."
      : "Display Checks: NO — sales pass silently.",
    `Legacy fields written on every product: category "${legacy.category}", subcategory "${legacy.subcategory}"` +
      (legacy.productType ? `, product type "${legacy.productType}".` : " — product type deliberately OMITTED (the perfume/none pattern)."),
    oneSize ? "Sizes: one-size (the single \"_\" stock cell)." : `Sizes: the "${sizeRunKey}" run (${sizes.join(", ")}).`,
    "POS note: this does NOT create a browse chip on the till — categoryTree.js lives in marathon-pos-app and is a separate change.",
  ];

  return { ok: true, key, record, preview, checks, forcedChecks: forced != null };
}
