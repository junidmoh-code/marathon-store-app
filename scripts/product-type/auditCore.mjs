// ─── WHICH "CLOTHING" PRODUCTS ARE REALLY SHOES — THE CLASSIFIER, PURE ───────
// Four independent signals, each worth 2:
//   footwear  — category "Footwear" or a footwear categoryKey
//   sizes     — every declared size is a shoe size (3–13, halves, kids 26–35)
//   history   — the order log recorded this product as "sneaker"
//   styleCode — it shares a style code with a Footwear product (one code,
//               several colourways — a clothing item never shares a shoe's)
// Considered and REJECTED as a signal (26 Sep 2026): a Hub 1 cell. Clothing
// "cannot be stocked at Hub 1", yet 19 real garments (suits, T-shirts, bags)
// hold Hub 1 cells — it would have flipped suits to sneakers.
// A product with ≥4 (two signals) is a real sneaker typed Clothing by mistake
// and is restored; 2 is listed for a person to look at, never flipped.
import { isShoeSize, FOOTWEAR_KEYS } from "./sneakerRestoreCore.mjs";

export { FOOTWEAR_KEYS };

// A bottoms waist run (28, 30, 32 …) is not a kids shoe run.
const isWaistSet = (sizes) => sizes.every((s) => /^\d{2}$/.test(s) && Number(s) >= 28 && Number(s) % 2 === 0);

export function classifyClothingProduct(p, typeHistory = {}, { footwearStyleCodes = new Set() } = {}) {
  if (!p || p.mergedInto || p.productType !== "clothing") return null;
  const sizes = (p.sizes || []).map(String);
  const signals = {
    footwear: p.category === "Footwear" || FOOTWEAR_KEYS.has(p.categoryKey),
    sizes: sizes.length > 0 && sizes.every(isShoeSize) && !isWaistSet(sizes),
    history: (typeHistory.sneaker?.n || 0) > 0,
    styleCode: !!p.styleCodeNormalised && footwearStyleCodes.has(p.styleCodeNormalised),
  };
  const score = Object.values(signals).filter(Boolean).length * 2;
  if (!score) return null;
  return { signals, score, verdict: score >= 4 ? "restore" : "look" };
}
