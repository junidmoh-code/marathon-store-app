// Pins the WIRING of the offline-mirror thumbnail into App.jsx's two photo
// upload call sites. App.jsx is a monolith whose components cannot be imported
// in isolation, so — as with the other .pin.test.js files here — the source is
// read as text and the two call sites are asserted directly.
//
// What this protects: writeProductThumb() is best-effort by contract, so a
// call site that quietly loses it fails NOTHING. The product still saves, the
// photo still uploads, every test still passes, and the only symptom is a
// blank square on an offline till weeks later. That is precisely the failure
// this whole change exists to end, so the wiring is pinned, not trusted.
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
// Line comments stripped for the "no hand-built path" checks below: the whole
// point of those is that no CODE names a thumbnail path, while the comments
// explaining the convention are expected to name it.
const appCode = app.replace(/^\s*\/\/.*$/gm, "").replace(/\/\/[^\n"'`]*$/gm, "");

test("App.jsx imports the shared path convention and the thumbnail writer", () => {
  expect(app).toContain('from "./utils/productPhotoPaths"');
  expect(app).toContain('from "./utils/productThumb"');
});

test("the add-product save writes a thumbnail from the same blob it uploaded", () => {
  const idx = app.indexOf("const sRef = storageRef(storage, productPhotoObjectPath(id));");
  expect(idx, "add-product photo upload should exist").toBeGreaterThan(-1);
  const site = app.slice(idx, idx + 1200);
  expect(site).toContain("writeProductThumb(id, form.photoBlob");
  expect(site).toContain("upload: uploadThumbObject");
  expect(site, "must pass the repair leg too").toContain("remove: removeThumbObject");
});

test("the re-shoot writes a thumbnail from the same blob it uploaded", () => {
  const idx = app.indexOf("const sRef = storageRef(storage, productPhotoObjectPath(product.id));");
  expect(idx, "re-shoot photo upload should exist").toBeGreaterThan(-1);
  const site = app.slice(idx, idx + 1200);
  expect(site).toContain("writeProductThumb(product.id, blob");
  expect(site).toContain("upload: uploadThumbObject");
  // Without the repair leg, a re-shoot whose thumbnail write fails leaves the
  // PREVIOUS photo's thumbnail standing under a marker every till believes is
  // current — invisible, and permanent.
  expect(site, "must pass the repair leg too").toContain("remove: removeThumbObject");
});

test("both call sites AWAIT the thumbnail write", () => {
  // Not for correctness — it cannot throw — but so a thumbnail is never left
  // in flight when the tab is closed the moment the product saves.
  const calls = [...app.matchAll(/(await )?writeProductThumb\(/g)];
  expect(calls.length).toBe(2);
  for (const c of calls) expect(c[1], "writeProductThumb call should be awaited").toBe("await ");
});

test("no call site builds a thumbnail path of its own", () => {
  // The one drift that is silent in both directions: the store app writing a
  // path the POS mirror does not read. Every thumbnail path must come from
  // productPhotoThumbPath(), which lives in ONE file and is pinned by
  // utils/productPhotoPaths.test.js against the POS repo's copy.
  expect(appCode).not.toMatch(/thumb_\d/);
});

test("the photo objects themselves come from the same convention module", () => {
  // photo.jpg was two hardcoded literals; the thumbnail is derived from the
  // product id, so the original had better be too, or the pair can drift apart.
  expect(appCode).not.toMatch(/products\/\$\{[^}]+\}\/photo\.jpg/);
});
