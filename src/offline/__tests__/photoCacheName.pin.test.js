// main.jsx clears Cache Storage wholesale on every boot — that line predates
// the photo mirror and would delete 111 MB of thumbnails on each load, which
// the photos leg would then re-download for ever.
//
// It now spares the photo cache by name, with a LITERAL fallback for the case
// where the dynamic import fails (a failed import must not mean "spare
// nothing"). This pins the literal against the constant, because a rename that
// updated one and not the other is silent: every device just starts paying for
// its pictures again.
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PHOTO_CACHE_NAME } from "../photoCache";

const main = readFileSync(new URL("../../main.jsx", import.meta.url), "utf8");

test("main.jsx spares the photo cache by the name photoCache.js actually uses", () => {
  expect(main).toContain(`.catch(() => "${PHOTO_CACHE_NAME}")`);
});

test("the clear filters rather than deleting every key", () => {
  expect(main).toContain("keys.filter((k) => k !== spare)");
  expect(main).not.toContain("keys.map((k) => caches.delete(k))");
});
