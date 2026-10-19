// ─── docs/style-guide.md → functions/lib/style-guide.json ────────────────────
// The markdown is the source Junid edits; the JSON is what the stylist reads
// (a Cloud Function ships functions/ only, so it cannot read docs/). Run after
// every edit to the guide; --check fails when the JSON is stale, without
// writing anything.
//
//   node scripts/social/build-style-guide.mjs [--check]
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { parseStyleGuide } = require("../../functions/lib/style-guide-parse.cjs");

const MD = new URL("../../docs/style-guide.md", import.meta.url);
const JSON_PATH = new URL("../../functions/lib/style-guide.json", import.meta.url);

const guide = parseStyleGuide(await readFile(MD, "utf8"));
const text = JSON.stringify(guide, null, 2) + "\n";
if (process.argv.includes("--check")) {
  const now = await readFile(JSON_PATH, "utf8").catch(() => "");
  if (now !== text) {
    console.error("functions/lib/style-guide.json is stale — run node scripts/social/build-style-guide.mjs");
    process.exit(1);
  }
  console.log("style-guide.json matches docs/style-guide.md");
} else {
  await writeFile(JSON_PATH, text);
  console.log(`wrote functions/lib/style-guide.json: ${Object.keys(guide.palette).length} colours, ${Object.keys(guide.families).length} families, ${guide.looks.length} looks`);
}
