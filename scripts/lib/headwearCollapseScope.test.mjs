// ─── THE HEADWEAR COLLAPSE STILL EXCLUDES PINE ───────────────────────────────
// The merge path's Pine refusal was removed on 2026-08-22 (see
// MERGE-PINE-INVESTIGATION.md): a merge never moves stock between locations, so
// no location can make one unsafe. The HEADWEAR one-size collapse is a different
// operation — it rewrites size keys and mints /stock_targets rows — and Pine's
// cells there are qty-0 reconciliation husks. Its exclusion is legitimate and
// must survive the merge fix, so it is pinned here.
//
// The scope lives in a default, not a constant, and the script cannot be
// imported (it opens a live Admin SDK connection), so the default is read out of
// the source. That is deliberate: what protects Pine is the value an operator
// gets when they type nothing.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../model-headwear-onesize-policy.mjs", import.meta.url));
const PINE = ["marathon-pine", "hub3"];

function shopsDefault(source) {
  const m = source.match(/const SHOPS = \[\.\.\.new Set\(\(process\.env\.SHOPS \|\| "([^"]*)"\)/);
  if (!m) throw new Error("the SHOPS default could not be located — the collapse scope moved");
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}

describe("headwear one-size collapse scope", () => {
  const source = readFileSync(SRC, "utf8");

  it("defaults to Marathon PE alone — Pine is not in scope", () => {
    expect(shopsDefault(source)).toEqual(["marathon-pe"]);
  });

  it("names neither Pine location in its default scope", () => {
    const shops = shopsDefault(source);
    for (const loc of PINE) expect(shops).not.toContain(loc);
  });

  it("still records WHY Pine is out of scope, so the exclusion is not lost to a refactor", () => {
    expect(source).toMatch(/marathon-pine's three cap cells are all qty 0/);
  });
});

// The other half of the same contract: the merge core carries no location list
// at all any more, so no future edit can quietly reinstate one by importing it.
describe("the merge core has no location scope", () => {
  it("exports no Pine constant", async () => {
    const mod = await import("../../functions/lib/product-merge.cjs");
    const exported = mod.default || mod;
    expect(Object.keys(exported).sort()).toEqual(
      ["MergeRefused", "decodeSizeKey", "encodeSizeKey", "performMerge"],
    );
  });

  it("mentions no location id in its source", () => {
    const merge = readFileSync(fileURLToPath(new URL("../../functions/lib/product-merge.cjs", import.meta.url)), "utf8");
    // Only the removal note may name Pine, and it names it as history.
    const codeLines = merge.split("\n").filter((l) => !l.trim().startsWith("//"));
    for (const loc of PINE) expect(codeLines.join("\n")).not.toContain(loc);
  });
});
