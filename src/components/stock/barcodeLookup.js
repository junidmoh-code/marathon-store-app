// Reverse barcode index reader: /barcodes/{code} → { productId, size?, at }.
//
// One-shot read (scan is request/response, not a live subscription). Returns the
// record or null when the code isn't indexed — the caller treats null as the
// graceful "code not found" path. The /barcodes node is written by this app's
// label-print flow (see barcodeStore.js); items never labeled are simply absent.
// Ported from the POS read side to reuse the shared /barcodes contract.

import { get, ref } from "firebase/database";
import { database } from "../../firebase";

// RTDB keys can't contain . # $ [ ] / — a real scanned barcode is digits, but a
// mistyped/garbled code might include junk; treat any such code as "not found"
// rather than mis-pathing the read.
const RTDB_RESERVED = /[.#$[\]/]/;

export async function lookupBarcode(code) {
  const key = String(code ?? "").trim();
  if (!key || RTDB_RESERVED.test(key)) return null;
  const snap = await get(ref(database, `barcodes/${key}`));
  return snap.exists() ? snap.val() : null;
}
