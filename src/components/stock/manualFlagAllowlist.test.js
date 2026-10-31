// ─── WHO MAY SAY "MANUAL" (owner, 31 Oct 2026) ───────────────────────────────
// `manual: true` on a movement lifts the section wall in applyMovement. Only a
// person's transfer may carry it: the Transfer screen's send and the In
// Transit receive. If any other file starts setting it — the Refill Queue,
// Solve, seating, clean-up, display requests — the wall would silently open
// for an automated route. This fails first.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const ALLOWED = new Set(["src/components/stock/Transfer.jsx", "src/components/stock/InTransit.jsx"]);

// Files whose `manual: true` is NOT on a movement — checked by hand 31 Oct 2026:
//   applyMovement.js     writes the flag it was handed back onto the ledger row
//   MissingFootwear.jsx  a refill request's createdFrom metadata (×2)
// A new entry here needs the same check: is the object ever handed to applyMovement?
const NOT_A_MOVEMENT = new Set([
  "src/components/stock/applyMovement.js",
  "src/components/stock/MissingFootwear.jsx",
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(c|m)?jsx?$/.test(name) && !/\.test\.(c|m)?jsx?$/.test(name) && !p.includes("__tests__")) out.push(p);
  }
  return out;
}

describe("only a person's transfer sets manual: true", () => {
  it("no source file outside Transfer.jsx and InTransit.jsx sets the flag", () => {
    // Only a movement handed to applyMovement can open the wall, so only files
    // that call it are scanned (functions/ has no wall: admin-movement.cjs).
    const setters = walk(join(ROOT, "src"))
      .map((p) => [p, readFileSync(p, "utf8").replace(/^\s*\/\/.*$/gm, "")])
      .filter(([, src]) => /\bapplyMovement\s*\(/.test(src))
      // Any value but a literal false ("manual": true, manual: !0, manual: x),
      // and the { manual } / , manual } shorthand.
      .filter(([, src]) => /(?<![`\w])["']?manual["']?\s*:(?!\s*false\b)|(?<![=$])\{\s*manual\s*[,}]|,\s*manual\s*[,}]/.test(src))
      .map(([p]) => relative(ROOT, p));
    expect(setters.filter((p) => !ALLOWED.has(p) && !NOT_A_MOVEMENT.has(p))).toEqual([]);
    for (const f of ALLOWED) expect(setters).toContain(f);
  });
});
