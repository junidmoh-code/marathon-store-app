// ─── PRINTED BARCODE STORE (Firebase) ────────────────────────────────────────
// Registers a manufacturer's own printed code (EAN-13 / UPC-A / EAN-8) into the
// SAME /barcodes reverse index the POS already scans against. The pure value
// model — check digit, UPC↔EAN twins, what an already-taken code means — lives
// in utils/eanBarcode.js; this file is only the Firebase half.
//
// ── READ BEFORE WRITE, BECAUSE THE RULES SAY SO ──────────────────────────────
// The live rule on /barcodes/$code is:
//     ".write": "… stockRole exists && !data.exists()"
// CREATE-ONLY. A code already in the index cannot be overwritten from the
// client — the write is simply DENIED, and a denied write that nobody reads
// back is indistinguishable from a successful one. So this reads the slot
// first, decides from what it finds, and only writes into genuinely empty
// slots. Nothing here ever tries to repoint an existing entry; repointing is a
// server-side merge operation (functions/lib/product-merge.cjs) and stays there.
//
// ── MANY-TO-ONE IS THE POINT ─────────────────────────────────────────────────
// /barcodes maps code → { productId, size }. Several codes may resolve to one
// product+size, which is how a perfume can carry BOTH the shop code already
// printed on a label stuck to its box AND its manufacturer EAN. Registering the
// EAN never removes, replaces or invalidates an auto-generated code: every
// label already in circulation keeps scanning.

import { ref, get, set } from "firebase/database";
import { database } from "../../firebase";
import { barcodeIndexRecord } from "./barcode";
import { serverNowIso } from "../../utils/serverTime";
import { indexCodesFor, printedBarcodeOutcome, PRINTED_FREE } from "../../utils/eanBarcode";

// Perfume is one-size: the "_" sentinel, the SAME one /stock and the per-size
// barcode slots use. It is passed through barcodeIndexRecord (which omits a
// blank size and writes a raw size otherwise) rather than being written by
// hand, so a display label can never reach an index row.
export const ONE_SIZE = "_";

/**
 * Who currently owns each form of this code. One read per index code (at most
 * two — a UPC-A and its EAN-13 twin), returning null where the slot is free.
 */
export async function readBarcodeOwners(codes) {
  const out = [];
  for (const code of codes) {
    const snap = await get(ref(database, `barcodes/${code}`));
    const val = snap.val();
    out.push({ code, productId: val && typeof val.productId === "string" ? val.productId : null });
  }
  return out;
}

/**
 * Check a captured code against the live index WITHOUT writing anything.
 *
 * This runs at CAPTURE time, not at save time, so the operator learns that a
 * code is already on another product while the box is still in their hand —
 * not after a product has been created that should not exist.
 *
 * `productId` is null when capturing for a product that has not been created
 * yet; every existing owner is then necessarily a different product.
 *
 * @returns the printedBarcodeOutcome verdict, plus the index codes it covers.
 */
export async function inspectPrintedBarcode(code, productId = null) {
  const codes = indexCodesFor(code);
  if (!codes.length) return { kind: "free", codes: [], indexCodes: [] };
  const owners = await readBarcodeOwners(codes);
  return { ...printedBarcodeOutcome(owners, productId), indexCodes: codes };
}

/**
 * Register the code against a product that ALREADY EXISTS.
 *
 * Order matters and is not negotiable: /barcodes/$code's .validate requires
 *     root.child('products').child(newData.child('productId').val()).exists()
 * so this must run AFTER the product write, never before — the same ordering
 * constraint the style-code claim already lives under.
 *
 * Re-inspects immediately before writing rather than trusting the capture-time
 * verdict: minutes may have passed, and a code claimed in between must not be
 * written over (it would be denied anyway, silently).
 *
 * @returns {{ok:true, written:string[], kind:string} | {ok:false, kind:"conflict", …}}
 */
export async function registerPrintedBarcode(productId, code, size = ONE_SIZE) {
  if (!productId) throw new Error("registerPrintedBarcode requires productId");
  const verdict = await inspectPrintedBarcode(code, productId);
  if (verdict.kind !== PRINTED_FREE) {
    // "already" is success with nothing to do; "conflict" is a refusal. Both
    // are reported as-is — the caller decides, this never guesses.
    return { ok: verdict.kind !== "conflict", written: [], ...verdict };
  }
  const written = [];
  for (const c of verdict.codes) {
    await set(ref(database, `barcodes/${c}`), barcodeIndexRecord(productId, size, serverNowIso()));
    written.push(c);
  }
  return { ok: true, written, kind: PRINTED_FREE };
}
