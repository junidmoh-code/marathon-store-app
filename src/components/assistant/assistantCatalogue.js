// ─── THE ASSISTANT'S POOL — ONE FILTER, BROWSE AND SEARCH BOTH ───────────────
// (Owner spec 2026-09-05, BUG 1 + BUG 1b.)
//
// AssistantView derives EVERYTHING from one candidate set: the browse grid, the
// Fuse index, the barcode/SKU code-hit branch, the 1-char substring branch, the
// desktop overlay's catalog, and the tongue-label finder. So the deactivation
// gate belongs here, in the pool — not on the grid, where SEARCH walked around
// it and cost the sale this build exists to stop:
//
//   the assistant searched, found the zero-size deactivated duplicate, told the
//   customer there was no stock — and the sizes were under the other copy.
//
// Pure and exported so the contract is proved by running it, not by pinning a
// string in a 19k-line file: src/components/assistant/assistantCatalogue.test.js.
//
// The two rules that were already here are UNCHANGED and still composed in the
// same order — mode (sneaker vs clothing; a record with no productType is a
// sneaker) and, for sneakers only, the store's hub universe (Pine sees hub3,
// central sees hub1/hub2; a product tagged with no hub at all is visible to
// central, which is the pre-existing "hubs.length &&" allowance).

/** Phase 14A `hubs: [...]` or legacy `hub: "hub1"`, unified. */
export function productHubsOf(product) {
  return product?.hubs || (product?.hub ? [product.hub] : []);
}

/**
 * @param {object[]} products    the live catalogue (already merge-filtered upstream)
 * @param {boolean}  wantsClothing  clothing mode (customer or CR) vs sneakers
 * @param {string}   storeMode   routing universe: "pine" | "central"
 * @param {boolean}  showDeactivated  the per-shop exemption (config/assistantVisibility)
 * @param {(p) => boolean} isDeactivated  the shared predicate, injected so this
 *        module stays free of the deactivation import cycle and the test can
 *        prove the gate is CONSULTED rather than re-implemented.
 */
export function assistantCatalogue({ products = [], wantsClothing, storeMode, showDeactivated = false, isDeactivated }) {
  return (products || []).filter((p) => {
    if (!p) return false;
    if (!showDeactivated && isDeactivated(p)) return false;
    const isClothingProduct = (p.productType || "sneaker") === "clothing";
    if (isClothingProduct !== wantsClothing) return false;
    if (!wantsClothing) {
      const hubs = productHubsOf(p);
      if (storeMode === "pine") {
        if (!hubs.includes("hub3")) return false;
      } else if (hubs.length && !hubs.includes("hub1") && !hubs.includes("hub2")) {
        return false;
      }
    }
    return true;
  });
}
