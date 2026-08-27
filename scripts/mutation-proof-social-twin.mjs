// ─── MUTATION PROOF — THE FEED TWIN ──────────────────────────────────────────
// The twin's two load-bearing properties are both SILENT when broken: a twin
// that shares the story's empty caption just looks like a bare feed post, and
// a twin written in a second update just goes missing sometimes. A green suite
// proves neither until the property has been broken on purpose.
//
// Restores the file on every exit path. Writes nothing anywhere else.
//
//   node scripts/mutation-proof-social-twin.mjs

import { readFileSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const SRC = new URL("../functions/lib/social-twin.cjs", import.meta.url);
const FUNCTIONS_DIR = fileURLToPath(new URL("../functions/", import.meta.url));
const original = readFileSync(SRC, "utf8");

const restore = () => { try { writeFileSync(SRC, original); } catch { /* nothing left to do */ } };
process.on("exit", restore);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(130); });

const MUTATIONS = [
  ["the twin keeps the story's caption — a feed post with nothing to say",
    "    caption: caption == null ? null : caption,",
    "    caption: story.caption,"],

  // Anchored with the line above it: `captionSource: captionSource || null,`
  // now appears in buildFeedTwin AND in primaryCaptionFields, and an anchor
  // that matches twice is a mutation that never applies.
  ["captionSource stays 'not-needed' on a surface that shows one",
    "    caption: caption == null ? null : caption,\n    captionSource: captionSource || null,",
    "    caption: caption == null ? null : caption,\n    captionSource: story.captionSource,"],

  ["the twin is left as a story — two stories, nothing on the feed",
    '    format: "feed",',
    '    format: story.format,'],

  ["the twin loses the slot, so it never goes out with its story",
    "  const twin = {\n    ...story,",
    "  const twin = {\n    ...story,\n    scheduledAt: null,"],

  ["the twin loses the picture",
    "  const twin = {\n    ...story,",
    "  const twin = {\n    ...story,\n    media: [],"],

  ["a twin can be twinned — it points at itself",
    "  delete twin.twinId;",
    "  /* mutated */"],

  ["provenance is dropped",
    "    twinOf: storyId,",
    "    twinOf: null,"],

  ["a multi-image post gets twinned anyway",
    "    && Array.isArray(media)\n    && media.length === 1;",
    "    && true;"],

  ["a reel or a feed post gets twinned too",
    '    && format === "story"',
    "    && true"],

  ["the switch accepts anything truthy",
    "  return enabled === true",
    "  return !!enabled"],

  ["the two records are written separately — a crash loses the twin",
    "    updates[`${postsPath}/${twinId}`] = twin;",
    "  /* mutated */ if (false) updates[`${postsPath}/${twinId}`] = twin;"],

  ["the back-reference is written without the twin existing",
    "  if (twinId && twin) {",
    "  if (twinId) {"],

  ["an absent caption note becomes a null one",
    "  else delete twin.captionNote;",
    "  else twin.captionNote = null;"],

  // The bug found reviewing this change: only `caption` fell back to the plain
  // line while captionSource and captionNote still described the twin's.
  ["a story's captionSource still describes the twin's caption",
    '    return { caption: fallback, captionSource: "not-needed", captionNote: null };',
    "    return { caption: fallback, captionSource, captionNote: captionNote || null };"],

  ["a story inherits the twin's caption note",
    "captionSource: \"not-needed\", captionNote: null };",
    "captionSource: \"not-needed\", captionNote: captionNote || null };"],

  ["a story is given the model's caption after all",
    '  if (format === "story") {',
    "  if (false) {"],

  ["an absent note becomes undefined, which throws on an RTDB write",
    "    captionNote: captionNote || null,",
    "    captionNote,"],

  ["it builds a twin with no ids at all",
    '  if (!twinId || !storyId) throw new Error("buildFeedTwin: both ids are required");',
    "  /* mutated */"],
];

function suitePasses() {
  try {
    execFileSync("node", ["--test", "test/social-twin.test.cjs"], { cwd: FUNCTIONS_DIR, stdio: "pipe" });
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
