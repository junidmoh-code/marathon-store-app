// ─── THE FIT RULEBOOK, MADE CHECKABLE ────────────────────────────────────────
// Junid, 26 Oct 2026: "the outfit posts look good but the fits are trash" —
// a washed black Sonic Youth tee, sage G-Star cargos and spiked brown
// Louboutins, titled "Earth Tone Street", captioned "raw denim". The scorer
// in lib/stylist.cjs picked it at 93/100: its tags called the cargos olive
// and the Louboutins olive, so the palette maths said "earth tone", and it has
// no idea a band tee and studded designer shoes are two different worlds.
//
// From now on a fit is BUILT by claude-opus-5-5 (the stylist) from the
// written rulebook (lib/fit-rulebook.md, sent word for word) and SCORED by a
// second, separate claude-opus-5-5 call (the critic) that sees the real
// product photos. lookbook/fit-agent.cjs makes the calls; this file is
// everything about them that is pure:
//
//   · the formula table parsed out of the rulebook (10 named formulas);
//   · who is offered to the stylist: in stock in at least 2 sizes (a true
//     one-size accessory in its one size), with real names and prices;
//   · the catalogue the stylist reads and the two prompts;
//   · the answer checks code can make without a model: every pid is offered,
//     one per slot, the core is there, the hero is in the fit, the theme is
//     a formula name, at most 3 colours with a neutral, and a caption with no
//     price, no shop and no brand that is not in the fit;
//   · the critic's verdict: every one of the four scores 8 or more, or rebuild;
//   · the cost of an answer and the per-outfit budget ($0.15, retries
//     included), checked BEFORE each call against its worst case.
"use strict";

const fs = require("fs");
const path = require("path");
const { sizesInStock } = require("./social-select.cjs");

const RULEBOOK_PATH = path.join(__dirname, "fit-rulebook.md");
const FIT_MODEL = "claude-opus-5-5";
// claude-opus-5-5, Anthropic API pricing (Oct 2026): $4 in, $20 out per
// million tokens; a cache write is 1.25x input, a cache read $0.20.
const PRICE = { inPerMtok: 4, outPerMtok: 20, cacheWritePerMtok: 5, cacheReadPerMtok: 0.2 };
// Junid's ceiling: stylist + critic, retries included, per finished outfit.
const BUDGET_USD = 0.15;
// The critic's pass mark, on every one of the four scores.
const PASS_SCORE = 8;
// One build and at most two rebuilds, then the fit is skipped.
const MAX_ROUNDS = 3;
// Output ceilings. Both calls run at effort "low": an answer is a few hundred
// tokens of JSON after a short think, and these bound the worst case the
// budget check charges before each call.
// Measured on live data (26 Oct): a stylist answer is 280–800 tokens with its
// thinking; a critic answer 400–900+ (its thinking alone reached 460, and a
// 900 ceiling cut one off). The ceilings leave room above both; the budget
// check prices them.
const STYLIST_MAX_TOKENS = 1400;
const CRITIC_MAX_TOKENS = 1400;
// No call is made with less room than this to answer in (every answer seen
// so far fits; a cut-off answer is a failed call). Each call's ceiling is the
// smaller of its MAX and what the budget left can pay for (fit-agent.cjs).
const MIN_OUT_TOKENS = 1000;
// The critic's input at its worst, kept back before the stylist is called
// until a critic request of this run has been priced: a first critic call
// with its rulebook cache write and four photos.
const CRITIC_INPUT_RESERVE_USD = 0.02;
// Tokens an attached product photo costs at CRITIC_PHOTO_PX on its long side
// (width x height / 750, rounded up): the budget check's estimate.
const CRITIC_PHOTO_PX = 384;
const PHOTO_TOKENS = Math.ceil((CRITIC_PHOTO_PX * CRITIC_PHOTO_PX) / 750);
const CRITERIA = ["colour", "formality", "theme", "caption"];

const NEUTRALS = new Set(["black", "charcoal", "grey", "white", "off-white", "cream", "light-grey", "navy", "denim-light", "denim-mid", "denim-dark"]);
// Shades the rulebook counts as one colour (section 2).
const SAME_COLOUR = { charcoal: "black", "off-white": "white", "light-grey": "grey", "denim-light": "denim", "denim-mid": "denim", "denim-dark": "denim" };
// The luxury tier (rulebook section 3), matched on the brand the poster prints.
const LUXURY_BRANDS = [
  "Christian Louboutin", "Amiri", "Alexander McQueen", "Gucci", "Balenciaga", "Prada", "Dior",
  "Louis Vuitton", "Saint Laurent", "Bottega Veneta", "Golden Goose", "Dolce & Gabbana",
  "Philipp Plein", "Givenchy", "Valentino", "Versace",
];
// The till spells some of them its own way ("CHRISTINA LOUBOUTIN").
const LUXURY_ALIASES = [[/\blouboutin\b/i, "Christian Louboutin"], [/\bmc\s*queen\b/i, "Alexander McQueen"]];
// Words a caption may not use (the online-only policy, as social-caption's prompt states it).
// "pop in" only as a visit ("pop in to the store"), never "a pop in green".
const SHOP_WORDS = /\b(in[\s-]?store|visit us|come see us|pop (?:in|into|by)(?: to)? (?:our|the|a) (?:shop|store|branch)|our (?:shop|store|branch)|branch(?:es)?)\b/i;
// R + digits is a price only in capitals ("R1,300"); "NMD r1" and "the R1" model are
// caught by needing two digits or a separator.
const PRICE_WORDS = /(?:\bZAR\b)|(?:\brand(?:s)?\s+\d|\b\d+\s?rand\b|\bon sale\b|\bdiscount|\d+\s?%\s?off\b)/i;
const PRICE_CAPITAL = /\bR ?\d[\d,]{2,}/;

// ── THE FORMULA TABLE ─────────────────────────────────────────────────────
/** The `<!-- config: formulas -->` table of a rulebook text. Throws on anything malformed. Pure. */
function parseFormulas(md) {
  const at = String(md || "").indexOf("<!-- config: formulas -->");
  if (at < 0) throw new Error("fit rulebook: no <!-- config: formulas --> table");
  const lines = md.slice(at).split("\n").slice(1).map((l) => l.trim());
  const rows = [];
  for (const l of lines) {
    if (!l.startsWith("|")) { if (rows.length) break; continue; }
    rows.push(l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  }
  const [head, sep, ...body] = rows;
  const want = ["key", "name", "season", "hero", "tops", "bottoms", "colours"];
  if (!head || head.join(",") !== want.join(",")) throw new Error(`fit rulebook: the formula table's columns must be ${want.join(" | ")}`);
  if (!sep || !sep.every((c) => /^-+$/.test(c))) throw new Error("fit rulebook: the formula table has no separator row");
  const out = body.map((cells, i) => {
    if (cells.length !== want.length || cells.some((c) => !c)) throw new Error(`fit rulebook: formula row ${i + 1} needs all ${want.length} columns`);
    const [key, name, season, hero, tops, bottoms, colours] = cells;
    if (!/^[a-z][a-z-]*$/.test(key)) throw new Error(`fit rulebook: formula key "${key}" must be lower-case words joined by hyphens`);
    if (!["any", "summer", "winter"].includes(season)) throw new Error(`fit rulebook: formula "${key}" season must be any, summer or winter`);
    return { key, name, season, hero, tops, bottoms, colours };
  });
  if (out.length < 10) throw new Error(`fit rulebook: ${out.length} formulas — the rulebook needs at least 10`);
  if (new Set(out.map((f) => f.key)).size !== out.length) throw new Error("fit rulebook: two formulas share a key");
  return out;
}

let CACHE = null;
/** The rulebook text and its formulas, read once. */
function rulebook() {
  if (!CACHE) {
    const text = fs.readFileSync(RULEBOOK_PATH, "utf8");
    CACHE = { text, formulas: parseFormulas(text) };
  }
  return CACHE;
}

/** The formulas a season allows. Pure over the rulebook. */
function formulasFor(season, book = rulebook()) {
  return book.formulas.filter((f) => f.season === "any" || f.season === season);
}

// ── WHO IS OFFERED ────────────────────────────────────────────────────────
/**
 * Junid's rule: only products in stock in at least 2 sizes. A product with
 * ONE size on its record (a cap, a bag) cannot have two: it qualifies in its
 * one size. Returns null when it qualifies, else why not. Pure.
 */
function sizeRefusal(stock) {
  const s = stock || { inStock: 0, sizes: 0 };
  if (s.sizes === 1) return s.inStock >= 1 ? null : "its one size is out of stock";
  if (s.inStock >= 2) return null;
  return `only ${s.inStock} size${s.inStock === 1 ? "" : "s"} in stock`;
}

/**
 * The offer trimmed for the stylist's catalogue: every core-slot piece, and
 * at most `perOptional` of each optional slot (freshest first; a fixed hero
 * always stays). Sixteen bags were a quarter of every stylist call and no
 * fit needs more than one (26 Oct). Pure.
 */
function trimOptional(pieces, core, { perOptional = 6, keep = null } = {}) {
  const coreSlots = new Set(core.flat());
  const bySlot = new Map();
  for (const p of pieces) { if (!bySlot.has(p.slot)) bySlot.set(p.slot, []); bySlot.get(p.slot).push(p); }
  const out = [];
  for (const [slot, list] of bySlot) {
    if (coreSlots.has(slot)) { out.push(...list); continue; }
    const sorted = list.slice().sort((a, b) => (b.fresh || 0) - (a.fresh || 0) || (a.pid < b.pid ? -1 : 1));
    out.push(...sorted.filter((p, i) => i < perOptional || p.pid === keep));
  }
  return pieces.filter((p) => out.includes(p));
}

/** The brand line's tier: "luxury" for the rulebook's designer list, else null. Pure. */
function luxuryBrand(...names) {
  const text = names.filter(Boolean).join(" ");
  for (const [re, brand] of LUXURY_ALIASES) if (re.test(text)) return brand;
  const low = text.toLowerCase();
  return LUXURY_BRANDS.find((b) => low.includes(b.toLowerCase())) || null;
}

// ── THE STYLIST'S PROMPT ──────────────────────────────────────────────────
/**
 * One catalogue line per offered piece, grouped by slot. The tags are the
 * vision tagger's reading of the photo and can be wrong; the stylist is told
 * so and the critic checks the photos. Pure.
 * piece: { pid, slot, brand, name, displayName, price, tags, sizes: { inStock, sizes }, fresh }
 */
function catalogueText(pieces, slots) {
  const out = [];
  for (const slot of slots) {
    const list = pieces.filter((p) => p.slot === slot);
    if (!list.length) continue;
    out.push(`## ${slot} (${list.length})`);
    for (const p of list) {
      const t = p.tags || {};
      const colours = [t.dominant, t.secondary].filter(Boolean).join("/");
      const lux = luxuryBrand(p.brand, p.displayName) ? " · LUXURY" : "";
      const shop = p.displayName && p.displayName.toLowerCase() !== `${p.brand} ${p.name}`.toLowerCase() ? ` (shop: ${p.displayName})` : "";
      const seen = p.seen ? ` | photo: ${p.seen}` : "";
      out.push(`- ${p.pid} | ${p.brand} — ${p.name}${shop} | R${p.price} | ${colours || "?"} ${t.pattern || "?"}, ${t.silhouette || "?"}, ${t.family || "?"}, f${t.formality || "?"}${lux}${p.fresh >= 0.75 ? ", new" : ""}${seen}`);
    }
  }
  return out.join("\n");
}

const STYLIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["formula", "theme", "hero_pid", "pids", "colours", "caption", "why"],
  properties: {
    formula: { type: "string", description: "the formula key from the rulebook table" },
    theme: { type: "string", description: "the formula's name; for colour-pop, '<Colour> Pop'" },
    hero_pid: { type: "string" },
    pids: { type: "array", items: { type: "string" }, description: "every piece in the fit, hero included, one per slot" },
    colours: { type: "array", items: { type: "string" }, description: "the fit's colours as they look in the photos, at most 3" },
    caption: { type: "string", description: "the post caption, ending with a line of at most eight hashtags" },
    why: { type: "string", description: "one sentence for the post's styling note: why these pieces work together" },
  },
};

/**
 * The stylist's request. `system` is the rulebook and never changes; the
 * catalogue is the first user block and is the same for every round of a run,
 * so both are cached and a rebuild pays for them at the cache-read rate.
 * Pure.
 */
function stylistRequest({ pieces, slots, core, optional, minPieces, maxPieces, season, kind = "lookbook", heroPid = null, avoidFormulas = [], feedback = [], book = rulebook() }) {
  const forced = heroPid ? pieces.find((p) => p.pid === heroPid) : null;
  const formulas = formulasFor(season, book).map((f) => f.key);
  const brief = [
    `Build ONE ${kind === "lookbook" ? "head-to-toe outfit for a model to wear on our lookbook poster" : "complete outfit for a flat-lay post"}.`,
    `It is ${season} in South Africa.`,
    `Pieces: ${minPieces} to ${maxPieces}, at most one per slot. It must have: ${core.map((alts) => alts.join(" or ")).join(", ")}.${optional.length ? ` It may add: ${optional.join(", ")} (only when the piece helps the fit).` : ""}`,
    `Formulas allowed this season: ${formulas.join(", ")}.`,
    ...(avoidFormulas.length ? [`The last posts were ${avoidFormulas.join(", ")}: choose a DIFFERENT formula unless the catalogue cannot dress any other well.`] : []),
    "Use ONLY pids from the catalogue below. Prices and names are real; never change them. Each line: pid | brand — name | price | colour tags, pattern, silhouette, family, formality 1-5 | photo: what a critic saw in the product photo, when known. The colour tags come from a vision model and can be wrong; a 'photo:' note is right. When a name and a tag disagree, never build a theme on the doubtful tag.",
    "The caption names each piece ONLY with what the catalogue states for certain: the brand, the garment type and a colour the name or photo note confirms. Never add a detail you cannot see (plain, slim, raw, fabric, fit, sole, logo size): the critic checks every word against the photos.",
    forced
      ? `The hero is fixed: ${forced.pid} (${forced.brand} ${forced.name}). Choose the formula it suits, then the supporting pieces.`
      : "Pick the hero first (rulebook section 1), then the formula it suits, then the supporting pieces.",
  ].join("\n");
  const user = [
    { type: "text", text: `${brief}\n\n# Catalogue (in stock, at least two sizes)\n${catalogueText(pieces, slots)}`, cache_control: { type: "ephemeral" } },
  ];
  if (feedback.length) {
    user.push({ type: "text", text: `# Earlier attempts this run were rejected\n${feedback.map((f, i) => `Attempt ${i + 1}: ${f}`).join("\n")}\n\nBuild a DIFFERENT fit that fixes every point. Do not repeat a rejected combination.` });
  }
  user.push({ type: "text", text: "Answer with the JSON object only." });
  return {
    system: [{ type: "text", text: `You are the menswear stylist for Marathon Club, an online sneaker and streetwear store in South Africa. Follow this rulebook exactly.\n\n${book.text}`, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
    schema: STYLIST_SCHEMA,
    maxTokens: STYLIST_MAX_TOKENS,
  };
}

// ── WHAT CODE CAN CHECK IN THE STYLIST'S ANSWER ───────────────────────────
function colourKey(c) {
  const k = String(c || "").toLowerCase().trim().replace(/\s+/g, "-");
  if (/denim|jean/.test(k)) return "denim";
  return SAME_COLOUR[k] || k;
}
function isNeutral(c) {
  const k = String(c || "").toLowerCase().trim().replace(/\s+/g, "-");
  return NEUTRALS.has(k) || /denim|navy|black|white|grey|gray|cream|charcoal/.test(k);
}

/** A theme the formula allows: its name, or "<Colour> Pop" for colour-pop. Pure. */
function themeAllowed(formula, theme) {
  const t = String(theme || "").trim();
  if (!formula || !t) return false;
  if (formula.key === "colour-pop") return /^[A-Z][a-z]+(?:[ -][A-Z][a-z]+)? Pop$/.test(t);
  return t.toLowerCase() === formula.name.toLowerCase();
}

/** Brand names a caption mentions, from a list of known brands. Pure. */
// Apostrophes and accents off before matching: "Levi's" is "levis", "Stüssy" is "stussy".
const plainText = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/['’`]/g, "");
function brandsNamed(caption, brands) {
  const text = plainText(caption);
  brands = brands.map(plainText);
  const low = ` ${text.toLowerCase().replace(/#\S+/g, " ")} `;
  // A hashtag names a brand too: #gucci, #ChristianLouboutin.
  const tags = new Set((text.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.slice(1).toLowerCase()));
  const squash = (b) => b.toLowerCase().replace(/[^a-z0-9]/g, "");
  return brands.filter((b) => {
    const re = new RegExp(`[^a-z]${b.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s-]+/g, "[\\s-]*")}[^a-z]`);
    return re.test(low) || tags.has(squash(b));
  });
}

/**
 * The stylist's JSON checked against the offer. Returns { ok, fit, problems }.
 * `fit`: { formula, theme, hero, pieces (offered piece objects, slot order), colours, caption, why }.
 * `knownBrands`: every brand the caption could name; one not in the fit is a problem. Pure.
 */
function readStylistAnswer(json, { pieces, slots, core, minPieces, maxPieces, season, knownBrands = [], heroPid = null, banned = new Set(), book = rulebook() }) {
  const problems = [];
  const a = json && typeof json === "object" ? json : {};
  const byPid = new Map(pieces.map((p) => [p.pid, p]));
  const pids = Array.isArray(a.pids) ? [...new Set(a.pids.map(String))] : [];
  const unknown = pids.filter((p) => !byPid.has(p));
  if (unknown.length) problems.push(`pids not in the catalogue: ${unknown.join(", ")}`);
  const chosen = pids.filter((p) => byPid.has(p)).map((p) => byPid.get(p));
  const again = pids.filter((p) => banned.has(p));
  if (again.length) problems.push(`the critic said to replace ${again.join(", ")}: they cannot be used again`);
  const perSlot = {};
  for (const p of chosen) perSlot[p.slot] = (perSlot[p.slot] || 0) + 1;
  const twice = Object.entries(perSlot).filter(([, n]) => n > 1).map(([s]) => s);
  if (twice.length) problems.push(`more than one piece in: ${twice.join(", ")}`);
  for (const alts of core) if (!chosen.some((p) => alts.includes(p.slot))) problems.push(`no ${alts.join(" or ")}`);
  if (chosen.length < minPieces || chosen.length > maxPieces) problems.push(`${chosen.length} pieces — the fit needs ${minPieces} to ${maxPieces}`);
  const hero = byPid.get(String(a.hero_pid || ""));
  if (!hero || !pids.includes(hero.pid)) problems.push("the hero piece is not one of the fit's pieces");
  else if (heroPid && hero.pid !== heroPid) problems.push(`the hero must be ${heroPid}`);
  const allowed = formulasFor(season, book);
  const formula = allowed.find((f) => f.key === a.formula) || null;
  if (!formula) problems.push(`formula "${a.formula}" is not one of ${allowed.map((f) => f.key).join(", ")}`);
  else if (!themeAllowed(formula, a.theme)) problems.push(`theme "${a.theme}" is not the ${formula.key} formula's name`);
  const colours = Array.isArray(a.colours) ? a.colours.map(String).filter(Boolean) : [];
  const distinct = [...new Set(colours.map(colourKey))];
  if (!distinct.length) problems.push("no colours named");
  if (distinct.length > 3) problems.push(`${distinct.length} colours (${distinct.join(", ")}) — at most 3`);
  if (distinct.length && !colours.some(isNeutral)) problems.push("no neutral colour");
  const caption = String(a.caption || "").trim();
  if (caption.length < 12) problems.push("no caption");
  if (caption.length > 2200) problems.push("the caption is over Instagram's 2,200 characters");
  if (SHOP_WORDS.test(caption)) problems.push("the caption mentions a shop (online store only)");
  if (PRICE_CAPITAL.test(caption) || PRICE_WORDS.test(caption.replace(/\bR ?\d[\d,]*/gi, ""))) problems.push("the caption mentions a price or a sale");
  if (/https?:\/\//i.test(caption)) problems.push("the caption writes a link (it is added automatically)");
  if ((caption.match(/#[\p{L}\p{N}_]+/gu) || []).length > 8) problems.push("more than eight hashtags");
  const inFit = chosen.map((p) => `${p.brand} ${p.displayName}`).join(" ");
  const strangers = brandsNamed(caption, knownBrands).filter((b) => !brandsNamed(inFit, [b]).length && !(luxuryBrand(inFit) === b));
  if (strangers.length) problems.push(`the caption names a brand that is not in the fit: ${strangers.join(", ")}`);
  const ordered = slots.flatMap((s) => chosen.filter((p) => p.slot === s));
  return {
    ok: problems.length === 0,
    problems,
    fit: { formula: formula && formula.key, theme: String(a.theme || "").trim(), hero: hero || null, pieces: ordered, colours, caption, why: String(a.why || "").trim() },
  };
}

// ── THE CRITIC ────────────────────────────────────────────────────────────
const CRITIC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["colour", "formality", "theme", "caption", "seen", "replace", "fix"],
  properties: {
    ...Object.fromEntries(CRITERIA.map((k) => [k, {
      type: "object", additionalProperties: false, required: ["score", "reason"],
      properties: { score: { type: "integer", description: "1 to 10" }, reason: { type: "string" } },
    }])),
    seen: { type: "array", items: { type: "object", additionalProperties: false, required: ["pid", "colour", "what"], properties: { pid: { type: "string" }, colour: { type: "string" }, what: { type: "string" } } }, description: "each piece as the photo shows it" },
    replace: { type: "array", items: { type: "string" }, description: "pids of the pieces that must leave the fit (empty when only the caption or theme is wrong)" },
    fix: { type: "string", description: "what the stylist must change, or empty when every score is 8 or more" },
  },
};

const CRITIC_BRIEF = [
  "You are the critic. A stylist built the outfit below for a Marathon Club social post. You did not build it and you owe it nothing: score it honestly against the rulebook.",
  "Look at each product photo first and say what it really is (colour, fabric, print). The stylist only saw text tags, which can be wrong.",
  "Score 1 to 10:",
  "- colour: at most 3 colours with a neutral; do they work together (rulebook section 2)?",
  "- formality: do the pieces belong to the same world as the hero (section 3)? One statement piece only (section 4)? Proportions (section 5)? Season (section 6)?",
  "- theme: does the theme name describe what the photos actually show? (Sage or mint green is not an earth tone.)",
  "- caption: is every item the caption names exactly what is in the photos (colour, fabric, brand)? Any piece called something it is not scores 4 or less. Also section 7.",
  `8 means a stylist would post it as is. Anything below ${PASS_SCORE} on any score is rebuilt, so be strict and specific in each reason.`,
  "In 'replace', list the pid of every piece that must leave the fit for it to pass (never the hero when it is the reason the fit exists); leave it empty when only the caption or theme name is wrong.",
  "Be brief: each reason under 25 words, each 'what' under 10 words, the fix under 50 words.",
].join("\n");

/**
 * The critic's request: the rulebook (cached across the run), then each
 * piece's photo with its label, then the fit and its caption. `photos` is
 * [{ pid, base64, mediaType }] in the fit's order. Pure.
 */
function criticRequest(fit, photos, { book = rulebook() } = {}) {
  // The critic needs the rules and the ONE formula the fit claims, not all ten
  // rows: ~1.5k tokens less on every critic call (measured 26 Oct).
  const cut = book.text.indexOf("## 8.");
  const rules = cut > 0 ? book.text.slice(0, cut).trim() : book.text;
  const f = book.formulas.find((x) => x.key === fit.formula);
  const content = [];
  fit.pieces.forEach((p, i) => {
    const ph = photos.find((x) => x.pid === p.pid);
    content.push({ type: "text", text: `PIECE ${i + 1} — ${p.pid} — ${p.slot}${fit.hero && fit.hero.pid === p.pid ? " (HERO)" : ""}: ${p.brand} ${p.name} (shop name: ${p.displayName}), R${p.price}` });
    if (ph) content.push({ type: "image", source: { type: "base64", media_type: ph.mediaType || "image/jpeg", data: ph.base64 } });
    else content.push({ type: "text", text: "(no photo could be loaded for this piece: judge it from its name and score caption accuracy no higher than 7)" });
  });
  content.push({ type: "text", text: [
    `FORMULA: ${fit.formula}${f ? ` — ${f.name}. Hero: ${f.hero}. Tops: ${f.tops}. Bottoms: ${f.bottoms}. Colours: ${f.colours}.` : ""}`,
    `THEME NAME on the poster: ${fit.theme}`,
    `COLOURS the stylist claims: ${fit.colours.join(", ")}`,
    "CAPTION:",
    fit.caption,
    "",
    "Answer with the JSON object only.",
  ].join("\n") });
  return {
    system: [{ type: "text", text: `${CRITIC_BRIEF}\n\n# The rulebook (sections 1–7; the fit's formula is given with the fit)\n\n${rules}`, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
    schema: CRITIC_SCHEMA,
    maxTokens: CRITIC_MAX_TOKENS,
  };
}

/**
 * The critic's JSON as a verdict: { ok, pass, scores { colour, formality,
 * theme, caption }, min, reasons, seen, fix }. An answer missing a score is
 * not a pass (ok false). Pure.
 */
function readCriticAnswer(json) {
  const a = json && typeof json === "object" ? json : {};
  const scores = {}, reasons = {};
  for (const k of CRITERIA) {
    const s = Number(a[k] && a[k].score);
    if (!Number.isInteger(s) || s < 1 || s > 10) return { ok: false, pass: false, reason: `the critic gave no ${k} score` };
    scores[k] = s;
    reasons[k] = String((a[k] && a[k].reason) || "").slice(0, 300);
  }
  const min = Math.min(...Object.values(scores));
  return {
    ok: true, pass: min >= PASS_SCORE, scores, min, reasons,
    seen: Array.isArray(a.seen) ? a.seen.slice(0, 8).map((s) => ({ pid: String(s.pid || ""), colour: String(s.colour || "").slice(0, 40), what: String(s.what || "").slice(0, 120) })) : [],
    replace: Array.isArray(a.replace) ? a.replace.map(String).slice(0, 6) : [],
    fix: String(a.fix || "").slice(0, 600),
  };
}

/** The feedback line a failed round hands the next stylist call. Pure. */
function feedbackLine(fit, { problems = null, verdict = null } = {}) {
  const what = fit && fit.pieces && fit.pieces.length ? `${fit.theme || "?"}: ${fit.pieces.map((p) => `${p.pid} (${p.brand} ${p.name})`).join(" + ")}` : "no usable fit";
  if (problems) return `${what} — refused by the checks: ${problems.join("; ")}`;
  const low = CRITERIA.filter((k) => verdict.scores[k] < PASS_SCORE).map((k) => `${k} ${verdict.scores[k]}/10 (${verdict.reasons[k]})`);
  const seen = verdict.seen.length ? ` The photos actually show: ${verdict.seen.map((s) => `${s.pid} ${s.colour} ${s.what}`).join("; ")}.` : "";
  const out = verdict.replace && verdict.replace.length ? ` These pieces must NOT be used again: ${verdict.replace.join(", ")}.` : "";
  return `${what} — the critic scored ${low.join("; ")}.${seen}${out} Fix: ${verdict.fix}`;
}

// ── COST ──────────────────────────────────────────────────────────────────
/** USD for one answer's usage at claude-opus-5-5 prices. Pure. */
function costOf(usage) {
  const u = usage || {};
  return ((Number(u.input_tokens) || 0) * PRICE.inPerMtok
    + (Number(u.cache_creation_input_tokens) || 0) * PRICE.cacheWritePerMtok
    + (Number(u.cache_read_input_tokens) || 0) * PRICE.cacheReadPerMtok
    + (Number(u.output_tokens) || 0) * PRICE.outPerMtok) / 1e6;
}

/**
 * The most a request can cost. Text is counted at 2 characters a token
 * (measured 2.2 on the catalogue: pids and prices tokenise densely), each
 * photo at PHOTO_TOKENS, and every allowed output token. Input is charged
 * at the cache-WRITE rate, except `cachedTokens`: the prefix the previous
 * call of the same role in this run wrote or read seconds ago, which is
 * charged at the cache-read rate (the cache lives five minutes). Pure.
 */
function worstCaseUSD(req, { cachedTokens = 0 } = {}) {
  let chars = 0, images = 0;
  const walk = (blocks) => { for (const b of Array.isArray(blocks) ? blocks : [{ type: "text", text: String(blocks) }]) { if (b.type === "image") images++; else chars += String(b.text || "").length; } };
  walk(req.system);
  for (const m of req.messages) walk(m.content);
  chars += JSON.stringify(req.schema || {}).length;
  const inTok = Math.ceil(chars / 2) + images * PHOTO_TOKENS + 200;
  const cached = Math.min(Math.max(0, cachedTokens), inTok);
  return ((inTok - cached) * PRICE.cacheWritePerMtok + cached * PRICE.cacheReadPerMtok + req.maxTokens * PRICE.outPerMtok) / 1e6;
}

/** A theme as the poster's two header lines ("EARTH TONE|STREET" → ["EARTH TONE", "STREET"]). Pure. */
function headerOf(theme) {
  const w = String(theme || "").trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (w.length <= 1) return [w[0] || "THE EDIT"];
  const cut = Math.ceil(w.length / 2);
  return [w.slice(0, cut).join(" "), w.slice(cut).join(" ")];
}

module.exports = {
  FIT_MODEL, PRICE, BUDGET_USD, PASS_SCORE, MIN_OUT_TOKENS, CRITIC_INPUT_RESERVE_USD, MAX_ROUNDS, CRITERIA, CRITIC_PHOTO_PX,
  STYLIST_MAX_TOKENS, CRITIC_MAX_TOKENS, LUXURY_BRANDS,
  parseFormulas, rulebook, formulasFor, trimOptional, sizesInStock, sizeRefusal, luxuryBrand,
  catalogueText, stylistRequest, readStylistAnswer, themeAllowed, brandsNamed,
  criticRequest, readCriticAnswer, feedbackLine, costOf, worstCaseUSD, headerOf,
  STYLIST_SCHEMA, CRITIC_SCHEMA,
};
