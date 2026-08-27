// ─── MUTATION PROOF — THE REEL MOTION ────────────────────────────────────────
//
// Every way this can break is SILENT. A phase that jumps, a move that crops the
// wordmark, a duration that quietly halves, an accumulator that drifts — the
// file encodes fine every time and just looks wrong, on an account where
// nobody was watching closely enough to notice for 28 months.
//
// So the suite is broken on purpose, one property at a time.
//
// Restores the file on every exit path. Writes nothing anywhere else.
//
//   node scripts/mutation-proof-reel-motion.mjs

import { readFileSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const SRC = new URL("../scripts/social/reel.mjs", import.meta.url);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const original = readFileSync(SRC, "utf8");

const restore = () => { try { writeFileSync(SRC, original); } catch { /* nothing left to do */ } };
process.on("exit", restore);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(130); });

const MUTATIONS = [
  ["the reel goes back to six seconds",
    "export const REEL_SECONDS = 15;",
    "export const REEL_SECONDS = 6;"],

  ["the keyframes collapse to one continuous creep",
    "  { at: 4.5,  zoom: 1.14, x: 0.000,  y: 0.000 },  // push in on the product\n",
    ""],

  ["every phase becomes the same move",
    "  { at: 8.0,  zoom: 1.14, x: -0.020, y: -0.050 }, // hold and drift up",
    "  { at: 8.0,  zoom: 1.14, x: 0.000,  y: 0.000 },"],

  ["nothing ever pulls back out",
    "  { at: 11.5, zoom: 1.03, x: -0.010, y: 0.000 },  // pull back to the full scene",
    "  { at: 11.5, zoom: 1.14, x: -0.010, y: 0.000 },"],

  ["the move zooms deep enough to eat the wordmark",
    "  { at: 4.5,  zoom: 1.14, x: 0.000,  y: 0.000 },  // push in on the product",
    "  { at: 4.5,  zoom: 1.40, x: 0.000,  y: 0.000 },"],

  ["the drift pushes the shop line off the bottom",
    "  { at: 8.0,  zoom: 1.14, x: -0.020, y: -0.050 }, // hold and drift up",
    "  { at: 8.0,  zoom: 1.14, x: -0.020, y: -0.180 },"],

  ["the reel opens already zoomed in, not on the whole picture",
    "  { at: 0.0,  zoom: 1.00, x: 0.000,  y: 0.000 },  // the whole frame",
    "  { at: 0.0,  zoom: 1.06, x: 0.000,  y: 0.000 },"],

  ["a keyframe zooms below 1 and reveals the padding",
    "  { at: 11.5, zoom: 1.03, x: -0.010, y: 0.000 },  // pull back to the full scene",
    "  { at: 11.5, zoom: 0.96, x: -0.010, y: 0.000 },"],

  ["the phases stop sharing keyframes, so a jump becomes expressible",
    "    out.push({ from: a, to: b, frames, seconds: b.at - a.at });",
    "    out.push({ from: { ...a }, to: { ...b }, frames, seconds: b.at - a.at });"],

  ["the motion goes back to accumulating off the previous frame",
    "    if (frames < 2) return b.toFixed(5);\n    return `${a.toFixed(5)}+(${(b - a).toFixed(5)})*on/${frames - 1}`;",
    "    if (frames < 2) return b.toFixed(5);\n    return `min(zoom+${((b - a) / frames).toFixed(6)},${b.toFixed(5)})`;"],

  ["the input is looped again, so every branch re-emits its phase per frame",
    '    "-i", stillPath,',
    '    "-loop", "1", "-i", stillPath,'],

  ["the 4x upscale is dropped and the pan judders",
    "    `scale=${w * 4}:${h * 4}`,\n",
    ""],

  ["the upscale moves into every branch instead of before the split",
    "    `scale=${w * 4}:${h * 4}`,\n    `split=${n}`,",
    "    `split=${n}`,"],

  ["the branches stop being concatenated",
    "    `concat=n=${n}:v=1:a=0`,",
    "    `null`,"],

  ["the colour range conversion is dropped",
    "in_range=full:out_range=tv",
    ""],

  ["the silent audio track stops being mapped",
    '    "-map", "[v]", "-map", "1:a",',
    '    "-map", "[v]",'],

  ["-t stops following the keyframes",
    "  const seconds = opts.seconds ?? reelDuration({ keyframes });",
    "  const seconds = opts.seconds ?? 6;"],
];

function suitePasses() {
  try {
    execFileSync("npx", ["vitest", "run", "src/components/social/socialReel.test.js"],
      { cwd: ROOT, stdio: "pipe" });
    return true;
  } catch { return false; }
}

console.log("Baseline: the suite must be green before any of this means anything.");
if (!suitePasses()) { console.error("✗ the suite is RED before a single mutation"); process.exit(1); }
console.log("✓ baseline green\n");

let survived = 0;
for (const [name, find, replace] of MUTATIONS) {
  const hits = original.split(find).length - 1;
  if (hits !== 1) {
    console.error(`✗ MUTATION DID NOT APPLY (${hits} matches): ${name}`);
    console.error("  the source has moved under this proof — fix the anchor, do not delete the mutation");
    survived++;
    continue;
  }
  writeFileSync(SRC, original.replace(find, replace));
  const stillGreen = suitePasses();
  writeFileSync(SRC, original);
  if (stillGreen) { console.log(`✗ SURVIVED  ${name}`); survived++; }
  else { console.log(`✓ killed    ${name}`); }
}

console.log(`\n${MUTATIONS.length - survived}/${MUTATIONS.length} mutations killed.`);
if (survived) {
  console.error(`✗✗ ${survived} mutation(s) survived — the suite does not test what it appears to test.`);
  process.exit(1);
}
console.log("Every deliberate break was caught.");
