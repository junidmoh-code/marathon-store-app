// Copies the pure modules the alternatives trigger shares with the app into
// functions/lib/alt-shared/, byte for byte. The functions deploy packages only
// functions/, so the server cannot import src/ directly; a copy that is
// checked byte-identical by src/utils/altShared.parity.test.js is how the
// trigger and the order screen are guaranteed to rank by the same rules.
//
//   node scripts/alternatives/sync-alt-shared.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const ALT_SHARED_FILES = Object.freeze([
  "altProfile.js", "modelFamily.js", "productAttributes.js", "productNeighbours.js",
  "shoeSize.js", "attributeExtraction.js", "visionNaming.js", "shopifyTriggers.js", "footwearLine.js",
]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dest = path.join(root, "functions/lib/alt-shared");
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ALT_SHARED_FILES) fs.copyFileSync(path.join(root, "src/utils", f), path.join(dest, f));
  console.log(`synced ${ALT_SHARED_FILES.length} file(s) into functions/lib/alt-shared/`);
}
