// ── EVERY WORD THE THEME PUTS ON THE PAGE IS A CATALOGUE FIELD ───────────────
// The payment gateway keyword-flags brand terms wherever they appear, so a
// heading, a menu label, a button, a status message or an alt attribute is
// exactly as dangerous as a product title. The product push has had this gate
// since slice 1; the theme did not, because until this rebuild the theme
// authored almost no text of its own.
//
// This walks the shipped theme files, pulls out every string the THEME itself
// authors, and refuses any that carries a brand, sub-label, collab or
// silhouette trigger — the same validator the product push uses.
//
// WHAT IS DELIBERATELY OUT OF SCOPE: strings the theme RENDERS from the
// catalogue — product titles, and the alt text derived from them. Those are
// validated where they are created (scripts/shopify/compliance.mjs, at push
// time) and re-validating them here would either duplicate that gate badly or
// force the theme to mangle the only description a screen reader gets. A dirty
// product title is a catalogue defect, not a theme defect, and is reported as
// such.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { triggersInText } from "../../src/utils/shopifyTriggers.js";

const THEME = new URL("../../theme/", import.meta.url).pathname;

function themeFiles() {
  const out = [];
  for (const dir of ["sections", "snippets"]) {
    for (const f of readdirSync(join(THEME, dir))) {
      if (f.endsWith(".liquid")) out.push(join(THEME, dir, f));
    }
  }
  out.push(join(THEME, "assets", "marathon-storefront.js"));
  return out;
}

// A {% schema %} block is JSON, and its KEYS are Shopify's vocabulary, not
// ours: a range setting is REQUIRED to carry "min", "max" and "step", and "max"
// is itself a silhouette trigger. Scanning the raw text would fail on a key no
// shopper ever sees and that cannot be renamed. So the schema is pulled out and
// checked separately, by VALUE — which is the half that matters, because a
// setting's `default` becomes storefront text.
function schemaStrings(src) {
  const m = src.match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/);
  if (!m) return [];
  let json;
  try { json = JSON.parse(m[1]); } catch { throw new Error("schema block is not valid JSON"); }
  const out = [];
  (function walk(v) {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  })(json);
  return out;
}

// Text the theme authors: literal strings inside Liquid quotes, the visible
// text between tags, and the JS status messages. Liquid/JS syntax, comment
// blocks, {{ output }} and the schema block are stripped first so the rationale
// comments — which legitimately DISCUSS the rule — cannot fail the rule.
function authoredStrings(src) {
  const noComments = src
    .replace(/\{%-?\s*schema\s*-?%\}[\s\S]*?\{%-?\s*endschema\s*-?%\}/g, " ")
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/^\s*#.*$/gm, " ");

  const strings = [];
  // Quoted literals in Liquid tags and JS
  for (const m of noComments.matchAll(/'([^'\n]{2,120})'|"([^"\n]{2,120})"/g)) {
    strings.push(m[1] ?? m[2]);
  }
  // Visible text nodes: whatever sits between > and < with no Liquid output in it
  const html = noComments.replace(/\{\{[\s\S]*?\}\}/g, " ").replace(/\{%[\s\S]*?%\}/g, " ");
  for (const m of html.matchAll(/>([^<>{}]{2,200})</g)) strings.push(m[1]);
  return strings.map((s) => s.trim()).filter(Boolean);
}

describe("theme-authored strings carry no brand triggers", () => {
  for (const file of themeFiles()) {
    const name = file.slice(file.indexOf("/theme/") + 1);
    it(name, () => {
      const src = readFileSync(file, "utf8");
      const dirty = [];
      for (const s of [...authoredStrings(src), ...schemaStrings(src)]) {
        const hits = triggersInText(s);
        if (hits.length) dirty.push(`${JSON.stringify(s)} → ${hits.join(", ")}`);
      }
      expect(dirty).toEqual([]);
    });
  }
});

// The navigation and rail labels are the ones a shopper actually reads, so they
// are also pinned by name — a refactor that stopped the walker above from
// seeing them would otherwise silently stop checking them.
describe("navigation and rail labels", () => {
  const LABELS = [
    "Everything", "New In", "New in", "Footwear", "Clothing", "Bags", "Perfume",
    "Under R500", "Sneakers", "Boots", "Sandals & Slides", "Soccer Boots",
    "Tracksuits & Sets", "Caps & Hats", "Jerseys", "Polos", "Jeans & Denim",
    "Jackets & Coats", "Hoodies & Sweatshirts", "T-Shirts", "Shorts & Vests",
    "Sold out", "Add to cart", "View full details", "Condition:", "Size",
  ];
  for (const label of LABELS) {
    it(`"${label}"`, () => expect(triggersInText(label)).toEqual([]));
  }
});
