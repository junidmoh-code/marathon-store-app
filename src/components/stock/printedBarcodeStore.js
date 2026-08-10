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

import { ref, get, update } from "firebase/database";
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
  let owners;
  try {
    owners = await readBarcodeOwners(codes);
  } catch (err) {
    // Tagged so callers can tell "could not reach the index" from "the index
    // said no" — two failures with two different instructions for the operator.
    err.printedBarcodeStage = "inspect";
    throw err;
  }
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
export async function registerPrintedBarcode(productId, code, size = ONE_SIZE, extraUpdates = null) {
  if (!productId) throw new Error("registerPrintedBarcode requires productId");
  const verdict = await inspectPrintedBarcode(code, productId, size);
  if (verdict.kind !== PRINTED_FREE) {
    // "already" is success with nothing to do. "conflict", "size_mismatch" and
    // "invalid" are refusals. Reported as-is — the caller decides, this never
    // guesses, and it never writes on a verdict it did not understand.
    return { ok: verdict.kind === PRINTED_ALREADY, written: [], ...verdict };
  }

  // ── ONE ATOMIC MULTI-PATH UPDATE, NOT A LOOP OF set() CALLS ───────────────
  // A UPC-A registers two rows (itself and its EAN-13 spelling). Writing them
  // one at a time meant the second could be denied after the first had landed,
  // leaving ONE spelling of a number registered and the other free for another
  // product to claim — the same physical barcode resolving to two products
  // depending on which reader you used. RTDB multi-path update() is atomic and
  // evaluates each path's rules independently, so either both forms land or
  // neither does, and the create-only rule still arbitrates each one.
  //
  // `extraUpdates` lets the caller put a value that must agree with these rows
  // INTO THE SAME COMMIT — see attachPrintedBarcode, which uses it for
  // products/{id}/printedBarcode. That is what makes "the field means
  // registered" an invariant rather than a convention maintained by
  // compensating writes. (CodeRabbit, PR #340.)
  const record = barcodeIndexRecord(productId, size, serverNowIso());
  const updates = {};
  for (const c of verdict.codes) updates[`barcodes/${c}`] = record;
  Object.assign(updates, extraUpdates || {});
  // ── LOSING THE RACE LOOKS EXACTLY LIKE BEING FORBIDDEN ────────────────────
  // The read-before-write is TOCTOU: between our inspect and this commit,
  // another client can claim the code for a different product. Under the
  // create-only rule (`!data.exists()`) our commit is then rejected — with the
  // SAME permission error a user without stockRole gets. Same failure, two
  // completely different remedies: "ask an admin for stock permission" versus
  // "this is a duplicate, go and merge the records". Reporting the first for
  // the second sends the operator to the wrong person entirely.
  //
  // So a rejection is DIAGNOSED, once, by re-reading the index. If the code is
  // now owned elsewhere we lost the race and say so; anything else is a genuine
  // denial and propagates.
  //
  // (This replaces a post-success read-back, which Kimi's review correctly
  // identified as unreachable: the commit is atomic, so if it resolves, every
  // row was written by us. Verifying that told us nothing, while the case that
  // actually happens went undiagnosed.)
  try {
    await update(ref(database), updates);
  } catch (err) {
    const after = await inspectPrintedBarcode(code, productId, size).catch(() => null);
    if (after && after.kind === PRINTED_CONFLICT) {
      return {
        ok: false, kind: PRINTED_CONFLICT, written: [],
        code: after.code, otherProductId: after.otherProductId,
      };
    }
    throw err;                          // a real denial — the caller falls back
  }
  return { ok: true, written: verdict.codes, kind: PRINTED_FREE };
}

// ─── DOES THIS PRODUCT STILL NEED A PRINTED LABEL? ───────────────────────────
// The one question both receive surfaces ask before deciding whether to offer
// the barcode print sheet. PURE, so every transition is testable — it used to
// be an inline boolean guarded only by source-text pins, and a source pin
// cannot exercise loading, rejection, a stale result, or a product change.
//
// A label is redundant ONLY when the index has been CONFIRMED to resolve this
// exact code to this product. Every other state offers the label:
//   • no captured code at all                     → ordinary shop barcode
//   • the check has not resolved yet              → not evidence
//   • the check failed (read error)               → not evidence
//   • the check warned (missing / wrong product / wrong size) → not scannable
//   • the check confirmed a DIFFERENT code        → stale, belongs to the
//     product that was open before this one
//
// Erring toward offering a label is deliberate: a redundant sticker is waste,
// a missing one is stock nobody can scan. (Kimi + Codex review, PR #340.)
export function labelIsRedundant(printedCode, indexCheck) {
  if (!printedCode) return false;
  if (!indexCheck || indexCheck.status !== "confirmed") return false;
  return indexCheck.code === printedCode;
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
  if (reg.kind === "unavailable") {
    return "the barcode index could not be reached — try again in a moment, nothing was changed";
  }
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
// ── ONE COMMIT, SO THE FIELD CANNOT LIE ──────────────────────────────────────
// The product field rides the SAME atomic multi-path update as the index rows.
// Previously it was a second write afterwards, which left a window where the
// index said one thing and the record another, and required a compensating
// removal to clean up after a failure — compensation that could itself fail.
// Now the database enforces the invariant: either the code resolves AND the
// record claims it, or neither happened. (CodeRabbit, PR #340.)
//
// This function owns BOTH paths — there is no opt-out, because a caller that
// registered the index without recording the field would recreate exactly the
// disagreement this exists to prevent.
//
// @returns {{ok:true, kind, written}|{ok:false, kind, reason, indexed:boolean}}
export async function attachPrintedBarcode({ productId, code, size = ONE_SIZE }) {
  const extraUpdates = { [`products/${productId}/printedBarcode`]: code };
  let reg;
  try {
    reg = await registerPrintedBarcode(productId, code, size, extraUpdates);
  } catch (err) {
    // ── COULD NOT REACH IT vs WAS NOT ALLOWED ─────────────────────────────
    // A failure to READ the index is not a refusal, and telling the operator
    // they lack stock permission when the connection dropped sends them to
    // ask an admin for something they already have. The two carry different
    // instructions: retry, versus get permission. (CodeRabbit, PR #340.)
    const kind = err && err.printedBarcodeStage === "inspect" ? "unavailable" : "denied";
    return {
      ok: false, kind, indexed: false,
      reason: kind === "unavailable"
        ? `the barcode index could not be reached (${err?.message || err}) — try again in a moment, nothing was changed`
        : `it could not be written (${err?.message || err}) — you may not have stock permission`,
    };
  }
  if (!reg.ok) {
    return { ok: false, kind: reg.kind, indexed: false, reason: registrationRefusalText(reg, code), verdict: reg };
  }
  // ALREADY: the rows were there before, so the commit above never ran and the
  // product field may still be missing. Write it on its own — safe, because the
  // code demonstrably resolves to this product already.
  if (reg.kind === PRINTED_ALREADY) {
    try {
      await update(ref(database), extraUpdates);
    } catch (err) {
      return { ok: false, kind: "record_write_failed", indexed: true, reason: String(err?.message || err) };
    }
  }
  return { ok: true, kind: reg.kind, indexed: true, written: reg.written };
}
