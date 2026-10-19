// ─── THE STYLE GUIDE, READ FROM docs/style-guide.md ──────────────────────────
// Junid edits the markdown; the stylist reads functions/lib/style-guide.json,
// which scripts/social/build-style-guide.mjs writes with THIS parser. Only the
// tables that follow a `<!-- config: NAME -->` marker are read. Anything the
// stylist would not understand (an unknown colour, family, slot, season or
// `requires` word) is refused here with the table and row, so a typo in the
// guide fails the build instead of quietly changing what gets posted. Pure.
"use strict";

const SLOTS = ["hat", "jacket", "tee", "bottoms", "bag", "sneakers", "fragrance"];
const COLOUR_FAMILIES = ["dark", "light", "earth", "denim", "accent"];
const SEASONS = ["summer", "winter", "shoulder"];
const PIECE_SEASONS = ["summer", "winter", "all"];
const HEADWEAR_KINDS = ["cap", "beanie", "bucket", "visor"];
const REQUIRE_WORDS = /^(mono|denim|shorts|summer|winter|noaccent|accent=1|earth>=\d)$/;
// Every rule the stylist reads. A missing one is a build error, not a default.
const RULE_KEYS = [
  "maxAccentHues", "maxLoudPieces", "maxFormalitySpread", "neverAllOversized", "oneFamilyOrBorder",
  "weightColour", "weightSilhouette", "weightFamily", "weightFormality", "weightSeason", "weightLook", "weightFresh",
  "offSeasonPenalty", "perPieceOverMin", "whiteSneakerBonus", "echoBonus", "secondAccentPenalty", "noAccentScore",
  "tieWindow", "shortlist", "perSlot",
];

/** The rows of every marked table: { name: [ { header: cell } ] }. */
function markedTables(md) {
  const lines = String(md || "").split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /<!--\s*config:\s*([A-Za-z]+)\s*-->/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    const rows = [];
    for (; j < lines.length && lines[j].trim().startsWith("|"); j++) rows.push(cells(lines[j]));
    if (rows.length < 2) throw new Error(`style guide: table "${m[1]}" has no rows`);
    const header = rows[0].map((h) => h.toLowerCase());
    out[m[1]] = rows.slice(2).map((r, k) => {
      if (r.length !== header.length) throw new Error(`style guide: table "${m[1]}" row ${k + 1} has ${r.length} cells, the header has ${header.length}`);
      return Object.fromEntries(header.map((h, x) => [h, r[x]]));
    });
  }
  return out;
}

// "| a | b\|c |" → ["a", "b|c"]: a backslash-escaped pipe stays in its cell.
function cells(line) {
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const out = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (s[i] === "|") { out.push(cur.trim()); cur = ""; continue; }
    cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
const lower = (s) => String(s || "").trim().toLowerCase();

function parseStyleGuide(md) {
  const t = markedTables(md);
  for (const need of ["palette", "families", "rules", "seasons", "seasonFit", "seasonRules", "looks"]) {
    if (!t[need]) throw new Error(`style guide: the "${need}" table is missing`);
  }
  const fail = (table, i, msg) => { throw new Error(`style guide: ${table} row ${i + 1}: ${msg}`); };

  const palette = {};
  t.palette.forEach((r, i) => {
    const c = lower(r.colour);
    if (!/^[a-z-]+$/.test(c)) fail("palette", i, `colour "${r.colour}" must be lower-case words joined by -`);
    if (palette[c]) fail("palette", i, `colour "${c}" is listed twice`);
    if (!COLOUR_FAMILIES.includes(lower(r.family))) fail("palette", i, `family "${r.family}" is not one of ${COLOUR_FAMILIES.join(", ")}`);
    if (!["yes", "no"].includes(lower(r.loud))) fail("palette", i, `loud must be yes or no`);
    palette[c] = { family: lower(r.family), loud: lower(r.loud) === "yes", aliases: list(r["also called"]).map(lower) };
  });

  const families = {};
  t.families.forEach((r, i) => {
    const f = lower(r.family);
    if (families[f]) fail("families", i, `family "${f}" is listed twice`);
    families[f] = { borders: list(r.borders).map(lower), brands: list(r.brands), categories: list(r.categories).map(lower) };
  });
  for (const [f, v] of Object.entries(families)) {
    for (const b of v.borders) if (!families[b]) throw new Error(`style guide: family "${f}" borders "${b}", which is not a family`);
  }

  const rules = {};
  t.rules.forEach((r, i) => {
    const v = Number(r.value);
    if (!RULE_KEYS.includes(r.rule)) fail("rules", i, `unknown rule "${r.rule}"`);
    if (!Number.isFinite(v)) fail("rules", i, `"${r.rule}" needs a number, not "${r.value}"`);
    rules[r.rule] = v;
  });
  for (const k of RULE_KEYS) if (!(k in rules)) throw new Error(`style guide: rule "${k}" is missing`);

  const seasons = {};
  t.seasons.forEach((r, i) => {
    const m = Number(r.month);
    if (!(Number.isInteger(m) && m >= 1 && m <= 12)) fail("seasons", i, `month "${r.month}" is not 1–12`);
    if (!SEASONS.includes(lower(r.season))) fail("seasons", i, `season "${r.season}" is not one of ${SEASONS.join(", ")}`);
    seasons[m] = lower(r.season);
  });
  for (let m = 1; m <= 12; m++) if (!seasons[m]) throw new Error(`style guide: month ${m} has no season`);

  const seasonFit = {};
  t.seasonFit.forEach((r, i) => {
    const p = lower(r.piece);
    if (!PIECE_SEASONS.includes(p)) fail("seasonFit", i, `piece "${r.piece}" is not one of ${PIECE_SEASONS.join(", ")}`);
    seasonFit[p] = {};
    for (const s of SEASONS) {
      const v = Number(r[s]);
      if (!(Number.isFinite(v) && v >= 0 && v <= 1)) fail("seasonFit", i, `${s} must be 0–1`);
      seasonFit[p][s] = v;
    }
  });
  for (const p of PIECE_SEASONS) if (!seasonFit[p]) throw new Error(`style guide: seasonFit has no "${p}" row`);

  const seasonRules = {};
  t.seasonRules.forEach((r, i) => {
    const se = lower(r.season);
    if (!SEASONS.includes(se)) fail("seasonRules", i, `season "${r.season}" is not one of ${SEASONS.join(", ")}`);
    if (seasonRules[se]) fail("seasonRules", i, `season "${se}" is listed twice`);
    const outerPenalty = Number(r["outer layer penalty"]), knitPenalty = Number(r["knitwear penalty"]);
    for (const [k, v] of [["outer layer penalty", outerPenalty], ["knitwear penalty", knitPenalty]]) {
      if (!(Number.isFinite(v) && v >= 0 && v <= 100)) fail("seasonRules", i, `${k} must be 0–100 points`);
    }
    const headwear = list(r.headwear).map(lower);
    for (const h of headwear) if (!HEADWEAR_KINDS.includes(h)) fail("seasonRules", i, `headwear "${h}" is not one of ${HEADWEAR_KINDS.join(", ")}`);
    seasonRules[se] = { outerPenalty, knitPenalty, headwear };
  });
  for (const se of SEASONS) if (!seasonRules[se]) throw new Error(`style guide: seasonRules has no "${se}" row`);

  const looks = t.looks.map((r, i) => {
    const key = lower(r.key);
    if (!/^[a-z0-9-]+$/.test(key)) fail("looks", i, `key "${r.key}" must be lower-case words joined by -`);
    const fams = list(r.families).map(lower);
    for (const f of fams) if (!families[f]) fail("looks", i, `family "${f}" is not in the families table`);
    const pal = list(r.palette).map(lower);
    for (const c of pal) if (!palette[c]) fail("looks", i, `colour "${c}" is not in the palette`);
    const core = list(r.core).map((alt) => alt.split("|").map(lower));
    const extras = list(r.extras).map(lower);
    for (const s of [...core.flat(), ...extras]) if (!SLOTS.includes(s)) fail("looks", i, `slot "${s}" is not one of ${SLOTS.join(", ")}`);
    const requires = list(r.requires).map(lower);
    for (const w of requires) if (!REQUIRE_WORDS.test(w)) fail("looks", i, `requires "${w}" is not a known condition`);
    const header = String(r.header || "").split("|").map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (!header.length || header.length > 2) fail("looks", i, "header needs one or two lines");
    return { key, name: r.name.trim(), header, families: fams, palette: pal, core, extras, requires };
  });
  const keys = new Set();
  for (const l of looks) { if (keys.has(l.key)) throw new Error(`style guide: look "${l.key}" is listed twice`); keys.add(l.key); }
  // Headwear is a finishing piece, never the rule (Junid, 19 Oct): at most a
  // third of the looks wear it, a summer look never does, and no look makes
  // it core.
  const hatLooks = looks.filter((l) => l.extras.includes("hat"));
  for (const l of looks) {
    if (l.core.some((alts) => alts.includes("hat"))) throw new Error(`style guide: look "${l.key}" makes the hat core — headwear is only ever an extra`);
    if (l.requires.includes("summer") && l.extras.includes("hat")) throw new Error(`style guide: look "${l.key}" is a summer look and wears a hat`);
  }
  if (hatLooks.length > Math.floor(looks.length / 3)) {
    throw new Error(`style guide: ${hatLooks.length} looks wear a hat (${hatLooks.map((l) => l.key).join(", ")}) — at most ${Math.floor(looks.length / 3)} of ${looks.length}`);
  }

  return { version: 1, source: "docs/style-guide.md", palette, families, rules, seasons, seasonFit, seasonRules, looks };
}

module.exports = { parseStyleGuide, markedTables, SLOTS, COLOUR_FAMILIES, PIECE_SEASONS, HEADWEAR_KINDS, RULE_KEYS };
