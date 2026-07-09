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

// Forgiving TYPED entry (ported from POS forgivingBarcode): leading zeros are
// optional when a code is typed by hand — "1385" should find "00001385". A real
// hardware SCAN delivers the full code and is matched EXACTLY (untouched); only a
// manual miss falls back to these zero-padded variants, each looked up in the EXACT
// /barcodes index (never a substring match, so "1385" can't wrongly hit "13850").
const MAX_BARCODE_LEN = 14; // EAN-13 / UPC-A + margin
export function forgivingBarcodeCandidates(code) {
  const raw = String(code ?? "").trim();
  if (!/^\d+$/.test(raw)) return [];            // non-numeric (names/junk) → skip
  const base = raw.replace(/^0+/, "") || "0";   // zero-stripped ("0" if all zeros)
  const seen = new Set([raw]);                  // never re-try the exact code
  const out = [];
  for (let len = base.length; len <= MAX_BARCODE_LEN; len++) {
    const cand = base.padStart(len, "0");
    if (!seen.has(cand)) { seen.add(cand); out.push(cand); }
  }
  return out;
}
