// ─── BARCODE STORE (Firebase) ─────────────────────────────────────────────────
// The permanence + concurrency wiring for the per-(product,size) barcode value
// model (see barcode.js for the pure model + format docs). Three RTDB locations:
//   /products_meta.lastBarcode          — the ONE shared sequential counter
//   /products/{id}/barcodes/{sizeKey}   — the permanent code for that product+size
//   /barcodes/{code} -> {productId,size}— reverse index for POS scan-to-sell
//
// ensureBarcode is GENERATE-IF-MISSING / REUSE-IF-PRESENT / NEVER-OVERWRITE:
//   1. Read the slot. If it already holds a valid code → reuse it (no reservation).
//   2. Else reserve the next number from the shared counter in a runTransaction
//      (25 people printing during the seed can't collide — each gets a distinct
//      number).
//   3. Claim the slot in a runTransaction that ABORTS if a concurrent printer
//      already wrote a code for the SAME product+size — so a stored code is never
//      overwritten. If we lose the claim, our reserved number is burned (a gap in
//      the sequence — acceptable, exactly as App.jsx's reservation already notes)
//      and we reuse the winner's code.
//   4. Write the reverse index for the live code so the POS lookup will resolve.

import { ref, get, set, runTransaction } from "firebase/database";
import { database } from "../../firebase";
import { isValidBarcode, nextBarcodeFromMeta, barcodeSizeKey } from "./barcode";

// Reserve the next 8-digit code from /products_meta.lastBarcode, atomically.
// Only advances lastBarcode (sku is per-product, reserved elsewhere).
export async function reserveNextBarcode() {
  let code = null;
  const tx = await runTransaction(ref(database, "products_meta"), (cur) => {
    const { next, code: c } = nextBarcodeFromMeta(cur);   // throws on exhaustion → aborts tx
    code = c;
    return { ...(cur || {}), lastBarcode: next };
  });
  if (!tx.committed || !code) throw new Error("Barcode counter exhausted or reservation aborted.");
  return code;
}

// NIT: only PER-SIZE codes are indexed here. The product-level `barcode` field
// (App.jsx reservation) is NOT written to /barcodes — per-size is the scan target,
// so a POS scan resolves only per-size codes via this index.
async function writeIndexIfMissing(code, productId, size) {
  const idxRef = ref(database, `barcodes/${code}`);
  const snap = await get(idxRef);
  if (!snap.exists()) {
    // Create-only at the rules layer (!data.exists()) — a concurrent winner's
    // write makes ours a rejected no-op; that's fine, the index already exists.
    await set(idxRef, { productId, size, at: new Date().toISOString() });
  }
}

// Best-effort reverse-index write: NEVER on the ensure critical path. A failure
// (rules reject / network / outage) costs only POS resolvability, which self-heals
// on the next ensure (writeIndexIfMissing re-runs); it must never lose the
// reserved/stored code or block the label/preview workflow.
async function tryWriteIndex(code, productId, size) {
  try { await writeIndexIfMissing(code, productId, size); }
  catch { /* slot saved; index heals on next open */ }
}

// Returns { code, reused }. Permanent once assigned; safe under concurrency.
export async function ensureBarcode(productId, size) {
  if (!productId || size == null || size === "") {
    throw new Error("ensureBarcode requires productId and size");
  }
  const sizeKey = barcodeSizeKey(size);
  const slotPath = `products/${productId}/barcodes/${sizeKey}`;

  // 1. Reuse-if-present (no number burned, no overwrite). Index write is
  //    best-effort — the stored code returns regardless.
  const existing = (await get(ref(database, slotPath))).val();
  if (isValidBarcode(existing)) {
    await tryWriteIndex(existing, productId, size); // heal index if ever absent
    return { code: existing, reused: true };
  }

  // 2. Reserve a fresh number from the shared counter.
  const reserved = await reserveNextBarcode();

  // 3. Claim the slot — abort only if a VALID code already exists (matches the
  //    reuse guard). A non-null-but-invalid/corrupt slot is claimable, so it
  //    self-corrects instead of throwing forever.
  const claim = await runTransaction(ref(database, slotPath), (cur) => (isValidBarcode(cur) ? undefined : reserved));
  const finalCode = claim.snapshot.val();

  if (claim.committed && finalCode === reserved) {
    // We won the slot → the code is saved. Index write is best-effort: an outage
    // costs only POS resolvability (heals next open), never the label/preview.
    await tryWriteIndex(reserved, productId, size);
    return { code: reserved, reused: false };
  }

  // 4. Lost the claim → our `reserved` is burned (gap, OK). Reuse the winner's.
  if (isValidBarcode(finalCode)) {
    await tryWriteIndex(finalCode, productId, size);
    return { code: finalCode, reused: true };
  }
  throw new Error("Barcode slot claim failed unexpectedly");
}

// Ensure barcodes for several sizes of one product. Sequential (not parallel) so
// the shared-counter transactions don't thrash. Returns { [size]: { code, reused } }.
export async function ensureBarcodes(productId, sizes) {
  const out = {};
  for (const size of sizes) {
    out[size] = await ensureBarcode(productId, size);
  }
  return out;
}
