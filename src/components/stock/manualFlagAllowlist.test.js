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
//   onHoldRefill.js      a refill request's createdFrom metadata
//   MissingFootwear.jsx  a refill request's createdFrom metadata (×2)
//   refill-engine.cjs    a stuck-refill report row
// A new entry here needs the same check: is the object ever handed to applyMovement?
const NOT_A_MOVEMENT = new Set([
  "src/components/stock/applyMovement.js",
  "src/components/stock/onHoldRefill.js",
  "src/components/stock/MissingFootwear.jsx",
  "functions/lib/refill-engine.cjs",
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
    const setters = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "functions", "lib"))]
      .filter((p) => /\bmanual\s*:\s*true\b/.test(readFileSync(p, "utf8").replace(/^\s*\/\/.*$/gm, "")))
      .map((p) => relative(ROOT, p));
    expect(setters.filter((p) => !ALLOWED.has(p) && !NOT_A_MOVEMENT.has(p))).toEqual([]);
    for (const f of ALLOWED) expect(setters).toContain(f);
  });
});
