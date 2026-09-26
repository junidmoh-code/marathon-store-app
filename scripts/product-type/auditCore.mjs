// ─── WHICH "CLOTHING" PRODUCTS ARE REALLY SHOES — THE CLASSIFIER, PURE ───────
// Three independent signals, each worth 2:
//   footwear — category "Footwear" or a footwear categoryKey
//   sizes    — every declared size is a shoe size (3–13, halves, kids 26–35)
//   history  — the order log recorded this product as "sneaker"
// A product with ≥4 (two signals) is a real sneaker typed Clothing by mistake
// and is restored; 2 is listed for a person to look at, never flipped.
import { isShoeSize } from "./sneakerRestoreCore.mjs";

export const FOOTWEAR_KEYS = new Set(["sneakers", "slides", "soccer-boots", "running-shoes", "boots", "loafers", "designer-shoes", "kids-shoes"]);

export function classifyClothingProduct(p, typeHistory = {}) {
  if (!p || p.mergedInto || p.productType !== "clothing") return null;
  const sizes = (p.sizes || []).map(String);
  const signals = {
    footwear: p.category === "Footwear" || FOOTWEAR_KEYS.has(p.categoryKey),
    sizes: sizes.length > 0 && sizes.every(isShoeSize),
    history: (typeHistory.sneaker?.n || 0) > 0,
  };
  const score = Object.values(signals).filter(Boolean).length * 2;
  if (!score) return null;
  return { signals, score, verdict: score >= 4 ? "restore" : "look" };
}
