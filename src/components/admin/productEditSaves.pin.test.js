// The product edit page (AdminProductDetail in App.jsx) must read the product
// LIVE and save every field through saveProductPatch — the two halves of the
// 26 Sep 2026 "nothing saves" report. Read as text: App.jsx pulls Firebase in
// at import time.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const app = readFileSync(join(__dirname, "../../App.jsx"), "utf8");
const start = app.indexOf("function AdminProductDetail(");
const end = app.indexOf("\nfunction ", start + 10);
const body = app.slice(start, end);

describe("the product edit page", () => {
  it("draws the product the server holds", () => {
    expect(body).toMatch(/function AdminProductDetail\(\{ product: listProduct,/);
    expect(body).toMatch(/const product = useLiveProduct\(listProduct\);/);
  });
  it("saves type, sizes, hubs, shoebox and name through the one save path", () => {
    for (const re of [/save\(patch, `the type/, /save\(\{ sizes: next \}/, /save\(\{ hubs: next \}/,
      /save\(\{ hasShoeBoxOption: next \}/, /save\(\{ name: next \}/]) expect(body).toMatch(re);
  });
  it("has no write on /products/{id} left that could fail silently", () => {
    // The photo upload is the one direct write left; it has its own alert.
    const direct = body.match(/update\(ref\(database, `products\/\$\{product\.id\}`\)[^;]*;/g) || [];
    expect(direct).toHaveLength(1);
    expect(direct[0]).toMatch(/photoUrl: url/);
    expect(body).not.toMatch(/updateProductSizes\(|updateProductHubs\(|console\.warn\("update hasShoeBoxOption/);
  });
  it("shows a failed save", () => {
    expect(body).toMatch(/\{saveError && \(/);
    expect(body).toMatch(/role="alert" data-product-save-error=""/);
  });
});
