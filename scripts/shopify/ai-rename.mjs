// ── AI rename pass — RESIDUE ONLY ────────────────────────────────────────────
// The deterministic lexicon (shopifyTriggers.js) is the PRIMARY naming path;
// this script exists solely for the names it cannot clean (digit-leading
// supplier codes, brand-only names with no category noun, …). ~53 of 4,166
// records at the 2026-08-13 census — never run it over the whole catalogue.
//
//   node scripts/shopify/ai-rename.mjs             generate + cache residue names
//   node scripts/shopify/ai-rename.mjs --dry-run   print the worklist, no API, no writes
//   node scripts/shopify/ai-rename.mjs --limit 5   cap this run
//
// Contract (owner spec 2026-08-13):
//   • API key from env ANTHROPIC_API_KEY (or the git-ignored .env). ABSENT →
//     stop and report, exit 2. NO stub fallback, ever.
//   • The LLM never polices itself: every output goes back through the
//     commit-1 trigger check + title guards. A violating output is REJECTED,
//     retried ONCE with the violation named, then the product is flagged for
//     manual naming. Nothing non-compliant is ever cached.
//   • Results cache to /shopify_publish/{pid}.cleanName (cachePublishName —
//     merge, never clobber, never regenerate an existing name).
//   • Never writes /products. RTDB writes: /shopify_publish only.
import { createRequire } from "module";
import "./env.mjs"; // side effect: tops up process.env from the repo-root .env
import { cleanTitleFor, triggersInText, isTriggerFree } from "../../src/utils/shopifyTriggers.js";
import { cachePublishName, readPublishNode } from "./publishNode.mjs";

const flags = process.argv.slice(2);
const DRY = flags.includes("--dry-run");
const limIdx = flags.indexOf("--limit");
const LIMIT = limIdx !== -1 ? Number(flags[limIdx + 1]) : Infinity;
if (limIdx !== -1 && !(LIMIT > 0)) {
  console.error("--limit needs a positive number");
  process.exit(2);
}

if (!DRY && !process.env.ANTHROPIC_API_KEY) {
  console.error(
    "ANTHROPIC_API_KEY is absent — stopping. Set it in the environment or the " +
      "git-ignored .env at the repo root. This script has NO stub fallback: " +
      "without the key there is no AI pass, and residue products remain " +
      "un-named (use the home-page card's manual naming instead)."
  );
  process.exit(2);
}

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// ── Build the residue worklist from the live catalogue ───────────────────────
const all = (await db.ref("products").get()).val() || {};
const residue = [];
for (const [pid, p] of Object.entries(all)) {
  if (!p || typeof p !== "object" || p.mergedInto) continue;
  const r = cleanTitleFor(p);
  if (r.needsAI) residue.push({ pid, product: p, reason: r.reason });
}
console.log(`residue needing AI/manual naming: ${residue.length}`);

// Colour words are the one product fact safe to hand the model verbatim —
// they come straight out of the existing name.
const COLOURS = new Set([
  "black", "white", "green", "grey", "gray", "blue", "brown", "red", "cream",
  "navy", "pink", "yellow", "orange", "purple", "gold", "silver", "maroon",
  "beige", "khaki", "olive", "lime", "charcoal", "teal", "tan", "mint",
  "turquoise", "mustard", "wheat", "camo", "camouflage", "multi", "denim",
]);
const coloursIn = (name) =>
  [...new Set(String(name).toLowerCase().match(/[a-z]+/g)?.filter((w) => COLOURS.has(w)) ?? [])];

// ── The rename loop ──────────────────────────────────────────────────────────
// claude-opus-5, one product per request (tiny prompts, residue is ~dozens).
// max_tokens leaves room for the model's (default-on) thinking + a short title.
let generated = 0, cached = 0, kept = 0, manual = 0, skippedDone = 0;
const manualList = [];

let client = null;
if (!DRY) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  client = new Anthropic();
}

const SYSTEM = `You name products for a South African clothing/footwear reseller's online store.
Return ONLY a short descriptive product title — no quotes, no explanation, no punctuation at the end.
The title must contain NO brand name, NO model or silhouette name, NO collaboration or sub-label name of any kind.
Describe only: the product type, its style or material, and its colour. Do not invent facts not given to you.
The title must start with a letter and be 3 to 60 characters long.`;

async function askOnce(product, feedback) {
  const colours = coloursIn(product.name);
  const user =
    `Original name: ${product.name}\n` +
    `Category: ${product.category ?? "unknown"}\n` +
    `Subcategory: ${product.subcategory ?? "unknown"}\n` +
    `Colour: ${colours.length ? colours.join(", ") : "unknown"}` +
    (feedback ? `\n\nYour previous suggestion was rejected: ${feedback}. Provide a different compliant title.` : "");
  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 1500,
    output_config: { effort: "low" },
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });
  if (response.stop_reason === "refusal") throw new Error("model refused the request");
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  return text.trim().replace(/^["']|["'.]$/g, "").trim();
}

// The commit-1 gate, applied to AI output. Returns null when compliant,
// else the human-readable rejection reason fed back on the one retry.
function violationOf(title) {
  if (!title) return "empty title";
  if (/^\d/.test(title)) return "title starts with a digit";
  if (title.length < 3) return "title under 3 characters";
  if (title.length > 80) return "title too long";
  const hits = triggersInText(title);
  if (hits.length) return `contains brand trigger(s): ${hits.join(", ")}`;
  return null;
}

for (const { pid, product, reason } of residue.slice(0, LIMIT)) {
  const node = await readPublishNode(db, pid);
  if (node?.cleanName) {
    // Cache hit — generated once, never regenerated. A stale cached name that
    // no longer passes the (grown) lexicon is surfaced, not silently reused.
    skippedDone++;
    if (!isTriggerFree(node.cleanName)) {
      console.error(`⚠ ${pid}: cached cleanName "${node.cleanName}" now trips the lexicon — needs manual review`);
    }
    continue;
  }
  if (DRY) {
    console.log(`  would rename [${reason}] ${pid}  "${product.name}"  (${product.category}/${product.subcategory})`);
    continue;
  }

  let title = null;
  try {
    title = await askOnce(product, null);
    generated++;
    let bad = violationOf(title);
    if (bad) {
      console.error(`  reject ${pid}: "${title}" — ${bad}; retrying once`);
      title = await askOnce(product, bad);
      generated++;
      bad = violationOf(title);
      if (bad) {
        manual++;
        manualList.push({ pid, name: product.name, lastTry: title, why: bad });
        continue;
      }
    }
  } catch (e) {
    manual++;
    manualList.push({ pid, name: product.name, lastTry: title, why: String(e?.message || e) });
    continue;
  }

  const outcome = await cachePublishName(db, pid, {
    cleanName: title,
    source: "ai",
    updatedBy: "script:ai-rename",
  });
  if (outcome === "cached") {
    cached++;
    console.log(`  ✓ ${pid}  "${product.name}"  →  "${title}"`);
  } else {
    kept++; // raced another writer — theirs stands
  }
}

console.log(
  `\ndone: ${cached} cached, ${skippedDone} already named (skipped), ` +
    `${kept} kept existing, ${manual} flagged for manual naming, ${generated} API calls`
);
if (manualList.length) {
  console.log("manual-naming worklist (set a name on the home-page Shopify card):");
  for (const m of manualList) console.log(`  ${m.pid}  "${m.name}"  — ${m.why}`);
}
process.exit(0);
