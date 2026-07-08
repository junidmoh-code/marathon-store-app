// ─── Scan → (product, size) resolution for the Transfer scan box ──────────────
// A barcode scan resolves via /barcodes/{code} → { productId, size? }. PER-SIZE
// codes (shoes) carry the size; PRODUCT-LEVEL codes (much clothing) do not. This
// pure helper decides what a scan should DO, so a sized-clothing scan can never
// silently move the "_" (no-size) cell — the bug we're closing.
//
// Returns one of:
//   { kind: "add",     size }  → add straight to the cart with this REAL size
//   { kind: "prompt"        }  → sized product, code carried no size → ask for size
//   { kind: "onesize"       }  → genuinely unsized product → the "_" cell (correct)

// A size is REAL when it's a non-blank value that isn't the "_" no-size sentinel.
function isRealSize(s) {
  return s != null && String(s).trim() !== "" && s !== "_";
}

// The product's real, pickable sizes (drops "_"/blank placeholders).
export function realSizesOf(product) {
  const sizes = product && Array.isArray(product.sizes) ? product.sizes : [];
  return sizes.filter(isRealSize).map(String);
}

// Decide how a scanned barcode resolves for a given catalogue product.
// `indexedSize` is the `size` field from the /barcodes index (may be absent).
export function resolveScan(product, indexedSize) {
  if (isRealSize(indexedSize)) return { kind: "add", size: String(indexedSize) };
  return realSizesOf(product).length ? { kind: "prompt" } : { kind: "onesize" };
}
