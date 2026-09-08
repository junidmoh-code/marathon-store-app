// ─── A SAVE THAT HALF-SUCCEEDS MUST NOT LOOK LIKE ONE THAT FAILED ────────────
// addProduct writes /products/{id} and then does follow-up work: a style-code
// claim, a barcode, opening stock. None of that can un-create the product, so a
// throw after the write leaves a SAVED product — and the old code reported it
// through the same path as a total failure: `console.error` plus a failure
// alert. The operator saw a failure message about a save that had succeeded, and
// the natural response is to save again, which creates a second copy.
//
// Two things had to hold, and both are structural rather than about wording:
//   1. the photo blob is released the moment the product lands, so no later
//      failure can leave it in form state for the NEXT save to upload;
//   2. the catch distinguishes half-success from failure, and the finally
//      guarantees the release on every path out of the function.
//
// This pins them by reading the source, because the alternative is mounting the
// whole admin screen with firebase, storage, auth and a dozen stores mocked —
// and a structural guarantee is exactly the thing a source-level pin states
// well. (Same approach as the existing gate pins in src/.)
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const src = readFileSync(fileURLToPath(new URL("./App.jsx", import.meta.url)), "utf8");

// The add-product save, from `setSaving(true)` to its `finally`.
function addProductBody() {
  const start = src.indexOf('const id = "p" + serverNowMs();');
  expect(start).toBeGreaterThan(0);
  const head = src.lastIndexOf("setSaving(true);", start);
  const end = src.indexOf("setSaving(false);", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(head, src.indexOf("};", end));
}

describe("addProduct — the half-success contract", () => {
  const body = addProductBody();
  const writeAt = body.indexOf("await addProductToFirebase(newProduct);");
  const catchAt = body.indexOf("} catch (err) {");
  const finallyAt = body.indexOf("} finally {");

  it("has the shape this test assumes: a write, then a catch, then a finally", () => {
    expect(writeAt).toBeGreaterThan(0);
    expect(catchAt).toBeGreaterThan(writeAt);
    expect(finallyAt).toBeGreaterThan(catchAt);
  });

  it("records that the product landed, immediately after the write", () => {
    const after = body.slice(writeAt, writeAt + 700);
    expect(after).toMatch(/savedProductId\s*=\s*id;/);
    // …and the flag is declared OUTSIDE the try, or the catch cannot read it.
    expect(body.slice(0, body.indexOf("try {"))).toMatch(/let savedProductId\s*=\s*null;/);
  });

  it("RELEASES THE PHOTO as soon as the product exists — not at the end of the happy path", () => {
    const between = body.slice(writeAt, writeAt + 900);
    expect(between).toMatch(/photoBlob:\s*null/);
    // The clear must come before any of the follow-up work that can throw.
    const clearAt = writeAt + between.indexOf("photoBlob: null");
    for (const later of ["claimStyleCode", "attachPrintedBarcode", "applyMovement"]) {
      const at = body.indexOf(later);
      if (at !== -1) expect(clearAt).toBeLessThan(at);
    }
  });

  it("clears the photo in the FINALLY too, so no path out can leave it behind", () => {
    const fin = body.slice(finallyAt);
    expect(fin).toMatch(/savedProductId/);
    expect(fin).toMatch(/photoBlob:\s*null/);
  });

  it("tells the operator it SAVED, and not to add the product again", () => {
    const cat = body.slice(catchAt, finallyAt);
    expect(cat).toMatch(/if \(savedProductId\)/);
    expect(cat).toMatch(/SAVED/);
    expect(cat).toMatch(/DO NOT add this product again/);
    // It must name the product, so the operator knows which one landed.
    expect(cat).toMatch(/savedProductName/);
  });

  it("still reports a REAL failure as a failure when nothing was written", () => {
    const cat = body.slice(catchAt, finallyAt);
    expect(cat).toMatch(/else\s*\{[\s\S]*saveFailureMessage\(err\)/);
  });

  it("never treats a half-success as a reason to keep the form open with its photo", () => {
    // The specific regression: on the old code the only reset lived at the end
    // of the happy path, so a throw left `photoBlob` populated and the form
    // open. There must be no path where savedProductId is set and the blob
    // survives — the finally is what makes that true.
    const fin = body.slice(finallyAt);
    expect(fin).toMatch(/if \(savedProductId\) setForm/);
  });
});
