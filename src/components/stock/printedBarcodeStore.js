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
import {
  indexCodesFor, printedBarcodeOutcome, normalisePrintedBarcode,
  PRINTED_FREE, PRINTED_ALREADY, PRINTED_CONFLICT, PRINTED_INVALID, PRINTED_SIZE_MISMATCH,
} from "../../utils/eanBarcode";

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
    out.push({
      code,
      productId: val && typeof val.productId === "string" ? val.productId : null,
      // The SIZE the row resolves to is carried, not discarded. A row that is
      // ours but points at a different size is not "already registered" — it
      // is a scan that deducts the wrong cell. (Codex review, PR #340.)
      size: val && val.size != null ? val.size : null,
    });
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
export async function inspectPrintedBarcode(code, productId = null, size = ONE_SIZE) {
  // An unusable code must not read as "free" — that made registerPrintedBarcode
  // report ok with nothing written, a silent success for garbage. It is refused
  // here, once, for every caller. (Kimi review, PR #340.)
  if (!normalisePrintedBarcode(code).ok) {
    return { kind: PRINTED_INVALID, code: String(code ?? ""), codes: [], indexCodes: [] };
  }
  const codes = indexCodesFor(code);
  const owners = await readBarcodeOwners(codes);
  return { ...printedBarcodeOutcome(owners, productId, size), indexCodes: codes };
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
  const verdict = await inspectPrintedBarcode(code, productId, size);
  if (verdict.kind !== PRINTED_FREE) {
    // "already" is success with nothing to do. "conflict", "size_mismatch" and
    // "invalid" are refusals. Reported as-is — the caller decides, this never
    // guesses, and it never writes on a verdict it did not understand.
    return { ok: verdict.kind === PRINTED_ALREADY, written: [], failed: [], ...verdict };
  }

  // ── PER-CODE, NOT ALL-OR-NOTHING ──────────────────────────────────────────
  // A UPC-A writes two rows and RTDB gives us no client-side transaction across
  // them. If the second is denied after the first landed, throwing would report
  // a total failure while one form is live and scanning — so the caller would
  // mint a shop code the product did not need. What actually happened is
  // returned instead, and a partial result is still a success: the primary form
  // is written first, so the number on the box resolves. (Kimi review, #340.)
  const written = [];
  const failed = [];
  for (const c of verdict.codes) {
    try {
      await set(ref(database, `barcodes/${c}`), barcodeIndexRecord(productId, size, serverNowIso()));
      written.push(c);
    } catch (err) {
      failed.push({ code: c, reason: String(err?.message || err) });
    }
  }
  if (!written.length) {
    // Nothing landed at all — a rules denial (no stockRole) or an outage. This
    // is the caller's signal to fall back, so it must be an exception, not a
    // quiet {ok:false} that an `if (!reg.ok)` might read as a mere conflict.
    throw new Error(failed[0]?.reason || "printed barcode registration wrote nothing");
  }

  // ── READ BACK, BECAUSE A WRITE THAT "SUCCEEDED" MAY NOT HAVE ──────────────
  // The read-before-write is TOCTOU: between our read and our set, another
  // client can claim the same code (or the twin form of it) for a different
  // product, and under the create-only rule the loser's write is DENIED — which
  // the SDK may surface late, or not at all if the winner's value is identical
  // in shape. So the rows are read back and must actually name us. We cannot
  // undo the other client's row from here (no delete permission), but the
  // caller must never be told a code is ours when it is not. (Codex, #340.)
  const owners = await readBarcodeOwners(written);
  const stolen = owners.filter((o) => o.productId !== productId);
  if (stolen.length) {
    return {
      ok: false, kind: PRINTED_CONFLICT, written: [], failed,
      code: stolen[0].code, otherProductId: stolen[0].productId,
    };
  }
  return { ok: true, written, failed, kind: PRINTED_FREE };
}

// ─── WHAT A REFUSAL MEANS, IN WORDS ──────────────────────────────────────────
// registerPrintedBarcode returns a VERDICT, not a boolean, because the four
// ways it can refuse need four different things from the operator. Pure, and
// living beside the verdicts it describes, so the two capture surfaces cannot
// word the same outcome differently.
export function registrationRefusalText(reg, code) {
  if (!reg) return "the barcode index refused it";
  if (reg.kind === PRINTED_CONFLICT) {
    return `it is already registered to another product${reg.otherProductId ? ` (${reg.otherProductId})` : ""}` +
           `, so an admin should check whether these are the same product (Stock → Merge Products)`;
  }
  if (reg.kind === PRINTED_SIZE_MISMATCH) {
    return `the barcode index already points it at size “${reg.indexedSize}” instead of one-size, ` +
           `which an admin must reconcile before it can be trusted`;
  }
  if (reg.kind === PRINTED_INVALID) return `“${code}” is not a valid printed barcode`;
  return "the barcode index refused it";
}

// ─── ATTACHING A CODE TO A PRODUCT — THE ORDERING, IN ONE PLACE ──────────────
// Two writes, and their order is the whole safety property:
//   1. /barcodes/{code}  — the scan resolution. This is the one that can be
//      REFUSED (create-only, needs stockRole), so it goes first.
//   2. /products/{id}/printedBarcode — the product's copy, which MEANS "this
//      code is registered". Writing it first would show a barcode on screen,
//      and return the product from a search for it, while no scanner could
//      resolve it.
//
// Both capture surfaces route through here so the ordering is defined once and
// TESTED once — previously each surface open-coded it, and swapping the two
// writes broke no test at all. (Kimi + Codex review, PR #340.)
//
// `writeProductField` is injected: the Add Product flow has already written the
// field as part of the product record, so it passes a no-op and only needs the
// index half plus the removal-on-failure.
//
// @returns {{ok:true, kind}|{ok:false, kind, reason, indexed:boolean}}
export async function attachPrintedBarcode({ productId, code, writeProductField, size = ONE_SIZE }) {
  let reg;
  try {
    reg = await registerPrintedBarcode(productId, code, size);
  } catch (err) {
    // Nothing was written at all — the index half never landed.
    return { ok: false, kind: "denied", indexed: false, reason: String(err?.message || err) };
  }
  if (!reg.ok) {
    return { ok: false, kind: reg.kind, indexed: false, reason: registrationRefusalText(reg, code), verdict: reg };
  }
  // The code now resolves. Only now may the product record claim it.
  if (writeProductField) {
    try {
      await writeProductField(code);
    } catch (err) {
      // The index row is PERMANENT — it cannot be deleted from the client (the
      // rule permits a write only into an empty slot). So this is a partial
      // success, and saying otherwise would send an operator to register a code
      // that is already registered.
      return { ok: false, kind: "record_write_failed", indexed: true, reason: String(err?.message || err) };
    }
  }
  return { ok: true, kind: reg.kind, indexed: true, written: reg.written, failed: reg.failed };
}
