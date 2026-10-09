import { test, expect } from "vitest";
import fs from "fs";
import path from "path";
import { ALT_SHARED_FILES } from "../../scripts/alternatives/sync-alt-shared.mjs";

// The alternatives trigger (functions/lib/alt-enrich.mjs) builds the profile
// the order screen ranks on. The functions deploy can only package functions/,
// so it runs COPIES of these modules — and a copy that drifts would write
// profiles ranked by different rules from the ones the app reads them with.
// Fix a failure with: node scripts/alternatives/sync-alt-shared.mjs
const root = path.resolve(__dirname, "../..");
test.each(ALT_SHARED_FILES)("functions/lib/alt-shared/%s is byte-identical to src/utils", (f) => {
  const a = fs.readFileSync(path.join(root, "src/utils", f), "utf8");
  const b = fs.readFileSync(path.join(root, "functions/lib/alt-shared", f), "utf8");
  expect(b).toBe(a);
});
test("every relative import inside the shared set stays inside the set", () => {
  for (const f of ALT_SHARED_FILES) {
    const src = fs.readFileSync(path.join(root, "src/utils", f), "utf8");
    for (const m of src.matchAll(/from\s+"\.\/([^"]+)"/g)) expect(ALT_SHARED_FILES).toContain(m[1]);
  }
});
