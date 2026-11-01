// ─── THE LOCAL STYLIST: RULES, LEDGER, SHORTLIST, VALIDATOR, HAND-OFF ────────
// Junid, 1 Nov 2026: every outfit styled like a real stylist would, South
// African streetwear, variety across days, picked by a FREE local model.
//
// The picking runs on the Mac mini (stylist/run.mjs): Fashion-CLIP reads each
// product photo (colour, style, statement, an embedding), this file builds a
// shortlist of colour- and style-compatible outfits that respect the variety
// ledger and the price ceiling, Gemma 4 (Ollama, localhost) sees the shortlist
// as photos and picks one, writing the theme, note and caption, and this
// file's validator checks the answer. The result is written to
// social_stylist/picks/{saDate}/{kind}; the Cloud Functions read it
// (lookbook/engines.cjs localFitAgentFor) and draw it exactly as they drew
// an opus fit. No paid model chooses an outfit any more.
//
// Everything here is pure, so the mini, the Cloud Functions and the tests run
// the same rules.
"use strict";

const fr = require("./fit-rules.cjs");

const PICKS_PATH = "social_stylist/picks";
const LOCAL_MODEL_DEFAULT = "gemma4:12b-it-qat";
// Junid's standing lookbook decisions: an outfit total under R2,000, aimed at
// R1,400–R1,800 by picking cheaper items.
const PRICE_CEILING = 2000;
const PRICE_BAND = { min: 1400, max: 1800 };
// No piece (or a colourway of it) twice in 14 days; never the same top +
// bottoms pairing twice in 30.
const NO_REPEAT_DAYS = 14;
const PAIR_DAYS = 30;
// Two pieces of one slot whose photos Fashion-CLIP reads as near-identical
// are one garment for the no-repeat (the same jeans in another wash).
const NEAR_DUPLICATE = 0.93;
const TOP_SLOTS = ["tee", "jacket"];
const CORE = [["tee"], ["bottoms"], ["sneakers"]];
const EXTRAS = ["hat", "jacket", "bag"];
const SLOT_ORDER = ["hat", "jacket", "tee", "bottoms", "bag", "sneakers"];
// How many outfits Gemma is shown, and how often one piece may appear across them.
const SHORTLIST = 5;
const MAX_SHARE = 2;

// Colours Fashion-CLIP is asked about (stylist/embed.py), and which count as
// neutrals: one hero colour, neutrals around it.
const COLOURS = ["black", "white", "cream", "grey", "navy", "blue denim", "light blue", "red", "green", "olive", "khaki", "brown", "tan", "beige", "orange", "yellow", "pink", "purple", "burgundy"];
const NEUTRAL_COLOURS = new Set(["black", "white", "cream", "grey", "navy", "blue denim", "beige"]);
// Earth tones read as one colour family for the hero-colour rule.
const COLOUR_FAMILY = { olive: "earth", khaki: "earth", brown: "earth", tan: "earth", "light blue": "blue", burgundy: "red" };
const STYLES = ["streetwear", "smart casual", "sportswear", "luxury designer", "preppy"];

const familyOfColour = (c) => (NEUTRAL_COLOURS.has(c) ? `n:${c}` : COLOUR_FAMILY[c] || c);

// ── THE VARIETY LEDGER ──────────────────────────────────────────────────────
// { entries: [{ date, kind, pids, families, pair, status: "planned"|"posted", total, theme }] }
// Kept on the mini (~/.marathon-stylist/ledger.json), written every run, and
// reconciled with what really went out (social_lookbook/history, social_posts).
const dayMs = (d) => Date.parse(`${d}T12:00:00Z`);
const daysBetween = (a, b) => Math.round((dayMs(b) - dayMs(a)) / 86400000);

/** What the ledger forbids on `saDate`. Pure. */
function ledgerBlocks(ledger, saDate, { repeatDays = NO_REPEAT_DAYS, pairDays = PAIR_DAYS } = {}) {
  const pids = new Set(), families = new Set(), pairs = new Set(), lastUsed = new Map(), familyLast = new Map();
  for (const e of (ledger && ledger.entries) || []) {
    if (!e || !e.date) continue;
    const age = daysBetween(e.date, saDate);
    if (!Number.isFinite(age)) continue;
    for (const p of e.pids || []) if (!lastUsed.has(p) || lastUsed.get(p) < e.date) lastUsed.set(p, e.date);
    for (const f of e.families || []) if (f && (!familyLast.has(f) || familyLast.get(f) < e.date)) familyLast.set(f, e.date);
    if (age < 0 && e.status !== "planned") continue;
    if (age < repeatDays) {
      for (const p of e.pids || []) pids.add(p);
      for (const f of e.families || []) if (f) families.add(f);
    }
    if (age < pairDays && e.pair) pairs.add(e.pair);
  }
  return { pids, families, pairs, lastUsed, familyLast };
}

/** The pairing key: top pid + bottoms pid. Pure. */
function pairKey(pieces) {
  const top = pieces.find((p) => p.slot === "tee") || pieces.find((p) => TOP_SLOTS.includes(p.slot));
  const bottom = pieces.find((p) => p.slot === "bottoms");
  return top && bottom ? `${top.pid}+${bottom.pid}` : null;
}

/** A ledger entry for a pick. Pure. */
function ledgerEntry(saDate, kind, pieces, { status = "planned", theme = null } = {}) {
  return {
    date: saDate, kind, status, theme,
    pids: pieces.map((p) => p.pid), families: pieces.map((p) => p.family).filter(Boolean),
    pair: pairKey(pieces), total: pieces.reduce((t, p) => t + (Number(p.price) || 0), 0),
  };
}

/** The ledger with `entry` in place of any entry of the same date and kind; older than 60 days dropped. Pure. */
function ledgerWith(ledger, entry, { keepDays = 60 } = {}) {
  const entries = ((ledger && ledger.entries) || []).filter((e) => !(e.date === entry.date && e.kind === entry.kind)
    && daysBetween(e.date, entry.date) < keepDays);
  return { entries: [...entries, entry].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind < b.kind ? -1 : 1)) };
}

/** One line per entry of the last `days`, for the daily log. Pure. */
function ledgerLines(ledger, saDate, days = PAIR_DAYS) {
  return ((ledger && ledger.entries) || []).filter((e) => daysBetween(e.date, saDate) < days)
    .map((e) => `${e.date} ${String(e.kind).padEnd(8)} ${String(e.status).padEnd(7)} R${String(e.total || 0).padStart(5)} ${e.theme || "-"} · ${(e.pids || []).join(", ")}`);
}

// ── THE POOL ────────────────────────────────────────────────────────────────
/**
 * The offered pieces the ledger allows: not a pid, a colourway (family) or a
 * near-duplicate photo of anything worn in the last 14 days. A core slot the
 * ledger empties falls back to its LEAST recently worn pieces (the pairing
 * rule still applies), so a thin slot never cancels the day. Pure.
 * pieces: [{ pid, slot, family, emb: { vec } }]; recentVecs: [{ slot, vec }]
 */
function poolOf(pieces, blocks, { recentVecs = [], saDate = "" } = {}) {
  const banned = (p) => blocks.pids.has(p.pid) || (p.family && blocks.families.has(p.family))
    || (p.emb && p.emb.vec && recentVecs.some((r) => r.slot === p.slot && cosine(r.vec, p.emb.vec) >= NEAR_DUPLICATE));
  const kept = pieces.filter((p) => !banned(p));
  const relaxed = [];
  for (const [slot] of CORE) {
    if (kept.some((p) => p.slot === slot)) continue;
    // When a garment (its colourway family included) was last worn: a black
    // tee's white colourway is as recent as the black tee (architect review).
    const worn = (p) => [blocks.lastUsed.get(p.pid), p.family && blocks.familyLast && blocks.familyLast.get(p.family)].filter(Boolean).sort().pop() || "";
    const old = pieces.filter((p) => p.slot === slot)
      .sort((a, b) => worn(a).localeCompare(worn(b)) || jitter(`${saDate}|${a.pid}`) - jitter(`${saDate}|${b.pid}`));
    kept.push(...old.slice(0, 3));
    if (old.length) relaxed.push(slot);
  }
  return { pool: kept, relaxed, removed: pieces.filter((p) => banned(p)).length };
}

// ── FASHION-CLIP SCORING ────────────────────────────────────────────────────
function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}
const styleVec = (p) => STYLES.map((s) => Number((p.emb && p.emb.style && p.emb.style[s]) || 0));

/**
 * Why an outfit's palette or statements break the stylist's rules, or null.
 * One hero colour (at most one non-neutral colour family across the pieces),
 * at most three colours, at least one neutral, at most one statement piece.
 * Pure. pieces carry emb: { colour, statement }.
 */
function paletteRefusal(pieces) {
  const colours = pieces.map((p) => p.emb && p.emb.colour).filter(Boolean);
  const fams = new Set(colours.map(familyOfColour));
  const loud = new Set(colours.filter((c) => !NEUTRAL_COLOURS.has(c)).map(familyOfColour));
  if (loud.size > 1) return `two hero colours (${[...loud].join(" and ")})`;
  if (fams.size > 3) return `${fams.size} colours`;
  if (colours.length && !colours.some((c) => NEUTRAL_COLOURS.has(c))) return "no neutral";
  const statements = pieces.filter((p) => p.emb && p.emb.statement >= 0.6);
  if (statements.length > 1) return `two statement pieces (${statements.map((p) => p.pid).join(", ")})`;
  return null;
}

/**
 * How well the pieces belong together: the mean pairwise agreement of their
 * Fashion-CLIP style readings (streetwear, smart casual, sportswear, luxury,
 * preppy), 0–1. Pure.
 */
function coherence(pieces) {
  let t = 0, n = 0;
  for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) { t += cosine(styleVec(pieces[i]), styleVec(pieces[j])); n++; }
  return n ? t / n : 0;
}

/** A small, stable 0–1 number for a key (the day's tie-breaker, never first-match). Pure. */
function jitter(key) {
  let h = 0x811c9dc5;
  for (const ch of String(key)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h % 10000) / 10000;
}

/**
 * The shortlist Gemma chooses from: every top × bottoms (no pairing worn in
 * 30 days) × sneakers whose palette passes, scored on Fashion-CLIP coherence,
 * a price inside the band, and the day's jitter; then one optional extra (cap,
 * light jacket, bag) when it keeps the palette and the price. At most
 * MAX_SHARE outfits share a piece, so Gemma sees real alternatives. Pure.
 * @returns { options: [{ pieces, total, score, coherence }], considered, refused }
 */
function shortlistOutfits(pool, { blocks, saDate, kind = "lookbook", ceiling = PRICE_CEILING, band = PRICE_BAND, size = SHORTLIST, extrasAllowed = EXTRAS, minPieces = 3, maxPieces = 6 } = {}) {
  const by = (s) => pool.filter((p) => p.slot === s);
  const tops = by("tee"), bottoms = by("bottoms"), shoes = by("sneakers");
  const refused = {};
  const note = (k) => { refused[k] = (refused[k] || 0) + 1; };
  const scored = [];
  let considered = 0;
  for (const top of tops) for (const bottom of bottoms) {
    if (blocks && blocks.pairs.has(`${top.pid}+${bottom.pid}`)) { note("pairing worn in the last 30 days"); continue; }
    for (const shoe of shoes) {
      considered++;
      const pieces = [top, bottom, shoe];
      const total = pieces.reduce((t, p) => t + p.price, 0);
      if (total > ceiling) { note("over the price ceiling"); continue; }
      const why = paletteRefusal(pieces);
      if (why) { note(why.replace(/\(.*\)/, "").trim()); continue; }
      const c = coherence(pieces);
      const inBand = total >= band.min && total <= band.max;
      scored.push({ pieces, total, coherence: c, score: c * 10 + (inBand ? 2 : total < band.min ? 1 : 0) + jitter(`${saDate}|${kind}|${pieces.map((p) => p.pid).join("+")}`) * 1.5 });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  // Add an extra where it helps (the band first: a R1,250 core earns a cap).
  const extras = pool.filter((p) => extrasAllowed.includes(p.slot) && p.slot !== "tee");
  const dressed = scored.slice(0, size * 12).map((o) => {
    if (o.pieces.length >= maxPieces) return o;
    let best = o;
    for (const x of extras) {
      if (o.pieces.some((p) => p.slot === x.slot)) continue;
      const pieces = [...o.pieces, x];
      const total = o.total + x.price;
      if (total > ceiling || paletteRefusal(pieces)) continue;
      const c = coherence(pieces);
      const inBand = total >= band.min && total <= band.max;
      const score = c * 10 + (inBand ? 2 : total < band.min ? 1 : 0) + jitter(`${saDate}|${kind}|${pieces.map((p) => p.pid).join("+")}`) * 1.5;
      if (score > best.score + 0.15 || (o.total < band.min && inBand && score > best.score - 0.4)) best = { pieces, total, coherence: c, score };
    }
    return best;
  }).filter((o) => o.pieces.length >= minPieces).sort((a, b) => b.score - a.score);
  const options = [], share = new Map();
  for (const o of dressed) {
    if (o.pieces.some((p) => (share.get(p.pid) || 0) >= MAX_SHARE)) continue;
    options.push({ ...o, pieces: SLOT_ORDER.flatMap((s) => o.pieces.filter((p) => p.slot === s)) });
    for (const p of o.pieces) share.set(p.pid, (share.get(p.pid) || 0) + 1);
    if (options.length >= size) break;
  }
  return { options, considered, refused };
}

// ── GEMMA'S ANSWER ──────────────────────────────────────────────────────────
const LOCAL_SCHEMA = {
  type: "object",
  required: ["option", "formula", "theme", "hero_pid", "colours", "caption", "why", "caption_theme", "scores"],
  properties: {
    option: { type: "integer", description: "the number of the outfit you choose" },
    formula: { type: "string" },
    theme: { type: "string" },
    hero_pid: { type: "string" },
    colours: { type: "array", items: { type: "string" } },
    caption: { type: "string" },
    why: { type: "string" },
    caption_theme: { type: "string" },
    scores: {
      type: "object", required: ["colour", "formality", "theme", "caption"],
      properties: { colour: { type: "integer" }, formality: { type: "integer" }, theme: { type: "integer" }, caption: { type: "integer" } },
    },
  },
};

/** The text half of Gemma's request (the photos travel beside it, one collage per option). Pure. */
function localPrompt({ options, kind, season, formulas, avoidFormulas = [], model = null, feedback = [] }) {
  const lines = [
    `Choose ONE of the ${options.length} outfits below for a Marathon Club ${kind === "lookbook" ? "lookbook poster worn by our house model" : "outfit post"}. It is ${season} in Durban, South Africa.`,
    ...(model ? [`The model is ${model}.`] : []),
    `Image N is outfit N: the pieces left to right in the order listed.`,
    `Formulas allowed: ${formulas.join(", ")}.${avoidFormulas.length ? ` The last posts were ${avoidFormulas.join(", ")}: choose a different formula if a good one fits.` : ""}`,
    "",
  ];
  options.forEach((o, i) => {
    lines.push(`## Outfit ${i + 1} — R${o.total}`);
    for (const p of o.pieces) lines.push(`- ${p.pid} | ${p.slot} | ${p.brand} — ${p.name} | R${p.price} | photo reads: ${p.emb ? `${p.emb.colour}, ${topStyle(p)}${p.emb.statement >= 0.6 ? ", statement" : ""}` : "?"}`);
  });
  lines.push("", "Answer with JSON: option (1-based), formula (a key above), theme (that formula's name exactly; colour-pop is '<Colour> Pop'), hero_pid (copy one pid exactly from the chosen outfit's list, usually its sneakers), colours (at most 3, with a neutral, as the photos show them), caption (2-3 short lines in South African English naming each piece only by brand, garment and a colour you can see, at most two emoji, then one line of at most 8 hashtags; no price, no shop, no link), why (one sentence: why these pieces work together), caption_theme (3-6 words), scores (your honest 1-10 for colour, formality, theme, caption).");
  if (feedback.length) lines.push("", "Your earlier answers were rejected:", ...feedback.map((f, i) => `${i + 1}. ${f}`), "Fix every point.");
  return lines.join("\n");
}
const topStyle = (p) => STYLES.slice().sort((a, b) => ((p.emb.style || {})[b] || 0) - ((p.emb.style || {})[a] || 0))[0];

/**
 * Gemma's JSON checked: the option exists, the code checks every opus fit had
 * to pass (fit-rules readStylistAnswer: formula, theme, hero, ≤3 colours with
 * a neutral, caption rules, brands), and the stylist's own rules (price
 * ceiling, ledger, pairing, palette, statements). Pure.
 * @returns { ok, problems, option, answer, fit }
 */
function validateLocal(json, options, offer, { blocks = null } = {}) {
  const problems = [];
  const a = json && typeof json === "object" ? json : {};
  const idx = Number(a.option) - 1;
  const option = Number.isInteger(idx) && options[idx] ? options[idx] : null;
  if (!option) return { ok: false, problems: [`option ${a.option} is not one of 1–${options.length}`], option: null, answer: null, fit: null };
  // A small model's slips that have one right reading are corrected, never
  // guessed (1 Nov dry runs): a hero that is not one of the outfit's pids is
  // the outfit's sneaker (rulebook: the sneaker anchors the look); a theme
  // that is exactly another allowed formula's name, or "<Colour> Pop", names
  // that formula. The corrected answer is validated like any other.
  const pidsOf = option.pieces.map((p) => p.pid);
  let hero = String(a.hero_pid || "").trim();
  if (!pidsOf.includes(hero)) hero = (pidsOf.find((p) => hero && hero.includes(p)) || (option.pieces.find((p) => p.slot === "sneakers") || option.pieces[0]).pid);
  let formula = String(a.formula || "").trim();
  let theme = String(a.theme || "").trim();
  const allowed = fr.formulasFor(offer.season);
  const named = allowed.find((f) => f.name.toLowerCase() === theme.toLowerCase());
  if (named) formula = named.key;
  else if (/^[A-Z][a-z]+(?:[ -][A-Z][a-z]+)? Pop$/.test(theme) && allowed.some((f) => f.key === "colour-pop")) formula = "colour-pop";
  // A valid formula with a theme that names neither it nor another formula
  // ("White and Black Pop" on Court Classic): the poster prints the formula's
  // own name. formulaProblems still checks that formula against the photos.
  const f = allowed.find((x) => x.key === formula);
  if (f && f.key !== "colour-pop" && !fr.themeAllowed(f, theme)) theme = f.name;
  const answer = {
    formula, theme, hero_pid: hero,
    pids: option.pieces.map((p) => p.pid), colours: Array.isArray(a.colours) ? a.colours.map(String) : [],
    caption: String(a.caption || "").trim(), why: String(a.why || "").trim(),
  };
  const read = fr.readStylistAnswer(answer, offer);
  problems.push(...read.problems);
  problems.push(...outfitProblems(option.pieces, { blocks }));
  if (read.fit && read.fit.formula) problems.push(...formulaProblems(read.fit.formula, option.pieces, read.fit.theme));
  return { ok: problems.length === 0, problems, option, answer, fit: read.fit };
}

// ── THE THEME MUST BE WHAT THE PHOTOS SHOW ───────────────────────────────────
// Gemma named a graphic tee, cargo jeans and a Lacoste mid-top "Clean Luxe" on
// the first dry run (1 Nov). Each formula's colour or tier rule, checked on the
// Fashion-CLIP colours and the brand tier. Pure.
const POP_COLOURS = new Set(["red", "green", "olive", "khaki", "brown", "tan", "orange", "yellow", "pink", "purple", "burgundy", "light blue", "blue", "royal blue", "teal", "mint", "lilac", "gold", "maroon", "lime", "coral", "sky blue", "forest green"]);
const EARTH = new Set(["olive", "khaki", "brown", "tan", "beige"]);
function formulaProblems(formulaKey, pieces, theme = "") {
  // "<Colour> Pop" names an accent: never a neutral ("White Pop", 1 Nov review).
  // ("Retro Equality Pop" is a shoe's name, not a colour.)
  if (formulaKey === "colour-pop" && String(theme).trim()) {
    const c = String(theme).trim().replace(/ Pop$/, "").toLowerCase();
    if (!POP_COLOURS.has(c)) return [`"${theme}" is not an accent colour: Colour Pop is one clear colour plus "Pop" (Red Pop, Green Pop, Orange Pop…)`];
  }
  const cols = pieces.map((p) => p.emb && p.emb.colour).filter(Boolean);
  if (cols.length < pieces.length) return [];
  const only = (set) => cols.every((c) => set.has(c));
  const bySlot = (s) => pieces.filter((p) => p.slot === s).map((p) => p.emb.colour);
  switch (formulaKey) {
    case "clean-luxe": return pieces.some((p) => fr.luxuryBrand(p.brand, p.displayName)) ? [] : ["Clean Luxe needs a designer or luxury piece (rulebook section 3): name a different formula"];
    // White only on the shoe (rulebook formula table).
    case "monochrome-black": return pieces.filter((p) => p.slot !== "sneakers").every((p) => ["black", "grey"].includes(p.emb.colour)) && cols.filter((c) => c === "black").length >= 2 ? [] : ["Monochrome Black is black head to toe, white only on the shoe: these pieces are not"];
    case "grey-scale": return only(new Set(["black", "grey", "white", "cream"])) ? [] : ["Grey Scale is grey, black and white only: these pieces are not"];
    case "summer-white": return [...bySlot("tee"), ...bySlot("bottoms")].every((c) => ["white", "cream", "beige", "grey", "light blue"].includes(c)) ? [] : ["Summer White needs a white or cream top and light bottoms"];
    case "blue-denim": return bySlot("bottoms").some((c) => ["blue denim", "light blue", "navy"].includes(c)) ? [] : ["Blue Denim needs blue denim bottoms"];
    case "earth-tone-street": return cols.filter((c) => EARTH.has(c)).length >= 2 ? [] : ["Earth Tone Street needs at least two earth tones (rulebook section 2)"];
    default: return [];
  }
}

/** The stylist's own hard rules on a set of pieces. Pure. */
function outfitProblems(pieces, { blocks = null, ceiling = PRICE_CEILING } = {}) {
  const out = [];
  const total = pieces.reduce((t, p) => t + (Number(p.price) || 0), 0);
  if (total > ceiling) out.push(`total R${total} is over R${ceiling}`);
  for (const [s] of CORE) if (!pieces.some((p) => p.slot === s)) out.push(`no ${s}`);
  if (blocks) {
    const again = pieces.filter((p) => blocks.pids.has(p.pid) || (p.family && blocks.families.has(p.family)));
    if (again.length) out.push(`worn in the last ${NO_REPEAT_DAYS} days: ${again.map((p) => p.pid).join(", ")}`);
    const pk = pairKey(pieces);
    if (pk && blocks.pairs.has(pk)) out.push(`this top and bottoms were paired in the last ${PAIR_DAYS} days`);
  }
  const why = pieces.every((p) => p.emb) ? paletteRefusal(pieces) : null;
  if (why) out.push(`palette: ${why}`);
  return out;
}

// ── THE HAND-OFF TO THE CLOUD ───────────────────────────────────────────────
/** The record written to social_stylist/picks/{saDate}/{kind}. Pure. */
function pickRecord({ saDate, kind, model, answer, option, json, attempts, ledgerSize, relaxed = [], atMs }) {
  return {
    saDate, kind, at: atMs, model, source: "local",
    answer, total: option.total,
    pieces: option.pieces.map((p) => ({ pid: p.pid, slot: p.slot, brand: p.brand, name: p.name, price: p.price, colour: (p.emb && p.emb.colour) || null })),
    captionTheme: String(json.caption_theme || "").slice(0, 80),
    scores: json.scores || null, attempts, ledgerSize, relaxed,
  };
}

/** The pick's pids, when the record is usable for `saDate`. Pure. */
function pickPids(rec, saDate) {
  if (!rec || rec.saDate !== saDate || !rec.answer || !Array.isArray(rec.answer.pids)) return [];
  return rec.answer.pids.filter((p) => typeof p === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(p));
}

/**
 * The pick as the fit the lookbook and the outfit post expect (fit-agent's
 * result shape), re-checked against TODAY's offer: every piece still offered
 * (live, in stock in two sizes, menswear, in season), the same answer checks,
 * and the price ceiling at today's prices. Pure.
 */
function fitFromPick(rec, offer, { saDate }) {
  const rounds = [];
  if (!rec) return { ok: false, reason: `no local stylist pick for ${saDate} (the Mac mini's stylist did not run)`, rounds, costUSD: 0 };
  if (rec.saDate !== saDate) return { ok: false, reason: `the local stylist pick is for ${rec.saDate}, not ${saDate}`, rounds, costUSD: 0 };
  const read = fr.readStylistAnswer(rec.answer, offer);
  const problems = [...read.problems];
  if (read.ok) {
    const total = read.fit.pieces.reduce((t, p) => t + (Number(p.price) || 0), 0);
    if (total > PRICE_CEILING) problems.push(`total R${total} is over R${PRICE_CEILING} at today's prices`);
  }
  const s = rec.scores || {};
  const scores = Object.fromEntries(fr.CRITERIA.map((k) => [k, Math.max(1, Math.min(10, Number(s[k]) || 8))]));
  rounds.push({ round: 1, fit: read.fit && { formula: read.fit.formula, theme: read.fit.theme, pids: read.fit.pieces.map((p) => p.pid), hero: read.fit.hero ? read.fit.hero.pid : null }, ...(problems.length ? { problems } : { scores }), costUSD: 0 });
  if (problems.length) return { ok: false, reason: `the local stylist pick no longer passes: ${problems.slice(0, 3).join("; ")}`, rounds, costUSD: 0 };
  const min = Math.min(...Object.values(scores));
  return {
    ok: true, source: "local", model: rec.model || LOCAL_MODEL_DEFAULT, fit: read.fit, rounds, costUSD: 0,
    verdict: { ok: true, pass: true, scores, min, reasons: {}, seen: [], replace: [], fix: "" },
  };
}

module.exports = {
  PICKS_PATH, LOCAL_MODEL_DEFAULT, PRICE_CEILING, PRICE_BAND, NO_REPEAT_DAYS, PAIR_DAYS, NEAR_DUPLICATE,
  CORE, EXTRAS, SLOT_ORDER, COLOURS, NEUTRAL_COLOURS, STYLES, SHORTLIST, LOCAL_SCHEMA,
  formulaProblems, ledgerBlocks, pairKey, ledgerEntry, ledgerWith, ledgerLines, poolOf, cosine, paletteRefusal, coherence, jitter,
  shortlistOutfits, localPrompt, validateLocal, outfitProblems, pickRecord, pickPids, fitFromPick,
};
