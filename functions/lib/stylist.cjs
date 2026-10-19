// ─── THE STYLIST: WHICH PIECES MAKE ONE DELIBERATE LOOK ──────────────────────
// Every multi-product post (lookbook, flat-lay, pairing, outfit) is chosen
// here, against the style guide (docs/style-guide.md → style-guide.json) and
// each product's style tags (lib/style-tags.cjs). Pure: no RTDB, no network.
//
//   0. EXCLUDE     before anything is scored: a piece that is not menswear
//                  (gender womens or unknown, or a women's-only cut such as
//                  bike shorts, by tag OR by name), and headwear the season
//                  does not allow (no beanie Oct–Mar: the guide's
//                  seasonRules). Junid's review of samples 06–08, 19 Oct.
//   1. ENUMERATE   every combination the post's slot template allows, from
//                  the best `perSlot` candidates per slot, once per named look
//                  (that look's palette, and for the lookbook only the
//                  optional slots that look declares) and once with no
//                  palette filter.
//   2. REFUSE      anything that breaks a hard rule: two accent hues, two loud
//                  pieces, formality more than 2 apart, all oversized, two
//                  style families that do not border each other. Never the
//                  price: no outfit is refused on its total.
//   3. SCORE       what is left, out of 100: colour harmony, silhouette
//                  balance, one style family, formality, season (and the
//                  season's outer-layer and knitwear penalty), how cleanly it
//                  matches a named look, freshness (+ a few points per
//                  lookbook piece over three).
//   4. SHORTLIST   the best `shortlist` outfits within `tieWindow` points of
//                  the top, each differing from the others by two pieces. An
//                  exact tie (to 0.1 point) goes to the total inside the
//                  preferred price range, `prefer`.
//
// A text model then picks one of the shortlist and writes the styling note
// (buildChoicePrompt / readChoice); the scores decide everything else, so the
// model only ever breaks a near-tie. With no model answer the top outfit and
// the deterministic note stand.
"use strict";

const GUIDE = require("./style-guide.json");
const { nameGender, nameHeadwear, nameKnit, WOMENS_CUTS } = require("./style-tags.cjs");

const ACCESSORY_SLOTS = new Set(["hat", "bag", "fragrance"]);
const GARMENT_SLOTS = new Set(["jacket", "tee", "bottoms"]);
const ANCHORS = new Set(["black", "white", "off-white"]);
const ORDER = ["tee", "bottoms", "sneakers", "jacket", "hat", "bag", "fragrance"];

/** "summer" | "winter" | "shoulder" for a 1–12 month in Durban. Pure. */
function seasonOf(month, guide = GUIDE) {
  return guide.seasons[String(month)] || guide.seasons[month] || "shoulder";
}

/** The guide's rules for a season: { outerPenalty, knitPenalty, headwear: [...] }. Pure. */
function seasonRulesFor(season, guide = GUIDE) {
  return (guide.seasonRules && guide.seasonRules[season]) || { outerPenalty: 0, knitPenalty: 0, headwear: ["cap", "beanie", "bucket", "visor"] };
}

// The words a piece is known by: its till name and its website name.
const namesOf = (p) => [p.displayName, p.websiteName, p.label].filter(Boolean).join(" ");

/**
 * Why a piece cannot go on a men's post, or null. Hard: decided before any
 * scoring. Women's by tag, a women's-only cut by tag, women's words or a
 * women's cut in either name (Alo "High-waisted compression bike shorts",
 * sample 08), or no gender tag at all: unknown is never assumed unisex. Pure.
 */
function menswearRefusal(p) {
  const t = p.tags || {};
  const byName = nameGender(namesOf(p));
  if (t.gender === "womens") return "womenswear";
  if (t.cut && WOMENS_CUTS.includes(t.cut)) return `a women's cut (${t.cut})`;
  if (byName.cut) return `a women's cut (${byName.cut}) by its name`;
  if (byName.gender) return "womenswear by its name";
  if (t.gender !== "mens" && t.gender !== "unisex") return "no gender tag";
  return null;
}

/** The kind of hat a piece is: the name first (it says "beanie"), then the tag, then the category. Pure. */
const HEADWEAR_BY_KEY = { "fitted-caps": "cap", visors: "visor" };
function headwearOf(p) {
  return nameHeadwear(namesOf(p)) || (p.tags && p.tags.headwear && p.tags.headwear !== "n/a" ? p.tags.headwear : null)
    || HEADWEAR_BY_KEY[p.categoryKey] || null;
}

/** Is the piece knitwear (a sweater, cardigan, sweater vest)? Tag or name. Pure. */
function isKnitwear(p) {
  if (!GARMENT_SLOTS.has(p.slot)) return false;
  return Boolean(p.tags && p.tags.knit) || nameKnit(namesOf(p));
}

/**
 * The season's points off for one piece: an outer layer (the jacket slot:
 * jackets, hoodies, cardigans) or knitwear, the larger of the two (a knitted
 * cardigan is not charged twice). Pure.
 */
function layerPenalty(p, season, guide = GUIDE) {
  const sr = seasonRulesFor(season, guide);
  return Math.max(p.slot === "jacket" ? sr.outerPenalty : 0, isKnitwear(p) ? sr.knitPenalty : 0);
}

const fam = (c, guide) => (guide.palette[c] ? guide.palette[c].family : null);
const isLoud = (t, guide) => t.pattern !== "solid" || Boolean(guide.palette[t.dominant] && guide.palette[t.dominant].loud);
const borders = (a, b, guide) => a === b
  || (guide.families[a] && guide.families[a].borders.includes(b))
  || (guide.families[b] && guide.families[b].borders.includes(a));

/** The accent hues used as a DOMINANT colour. Pure. */
function dominantAccents(pieces, guide = GUIDE) {
  return new Set(pieces.map((p) => p.tags.dominant).filter((c) => fam(c, guide) === "accent"));
}

/**
 * The first hard rule the pieces break, or null. `partial` skips the rule
 * that only a finished outfit can break (all oversized), so the enumerator
 * can prune on the rest as it builds. Pure.
 */
function hardRule(pieces, guide = GUIDE, { partial = false } = {}) {
  const r = guide.rules;
  const acc = dominantAccents(pieces, guide);
  if (acc.size > r.maxAccentHues) return `${acc.size} accent colours (${[...acc].join(", ")}) — the guide allows ${r.maxAccentHues}`;
  const loud = pieces.filter((p) => isLoud(p.tags, guide));
  if (loud.length > r.maxLoudPieces) return `${loud.length} loud pieces — the guide allows ${r.maxLoudPieces}`;
  const f = pieces.map((p) => p.tags.formality);
  if (f.length && Math.max(...f) - Math.min(...f) > r.maxFormalitySpread) return `formality ${Math.min(...f)}–${Math.max(...f)} is more than ${r.maxFormalitySpread} apart`;
  if (r.oneFamilyOrBorder) {
    const core = pieces.filter((p) => !ACCESSORY_SLOTS.has(p.slot));
    for (let i = 0; i < core.length; i++) for (let j = i + 1; j < core.length; j++) {
      if (!borders(core[i].tags.family, core[j].tags.family, guide)) return `${core[i].tags.family} with ${core[j].tags.family} — the families do not border`;
    }
  }
  if (!partial && r.neverAllOversized) {
    const g = pieces.filter((p) => GARMENT_SLOTS.has(p.slot) && p.tags.silhouette !== "n/a");
    if (g.length >= 2 && g.every((p) => p.tags.silhouette === "oversized")) return "every garment is oversized";
  }
  return null;
}

/** Is every dominant colour in one neutral family, black/white as anchors? Pure. */
function isMono(pieces, guide = GUIDE) {
  const ds = pieces.map((p) => p.tags.dominant);
  if (!ds.every((c) => ["dark", "light"].includes(fam(c, guide)))) return false;
  const nonWhite = ds.filter((c) => c !== "white" && c !== "off-white");
  const nonBlack = ds.filter((c) => c !== "black");
  return nonWhite.every((c) => fam(c, guide) === "dark") || nonBlack.every((c) => fam(c, guide) === "light");
}

function earthCount(pieces, guide) { return pieces.filter((p) => fam(p.tags.dominant, guide) === "earth").length; }

/** Colour harmony, 0–1, and the words that explain it. Pure. */
function colourScore(pieces, guide = GUIDE) {
  const r = guide.rules;
  const acc = [...dominantAccents(pieces, guide)];
  const secondAcc = new Set(pieces.map((p) => p.tags.secondary).filter((c) => c && fam(c, guide) === "accent" && !acc.includes(c)));
  const why = [];
  let s;
  const earth = earthCount(pieces, guide);
  const earthCoherent = earth >= 2 && pieces.every((p) => ["earth", "light"].includes(fam(p.tags.dominant, guide)) || ANCHORS.has(p.tags.dominant));
  if (!acc.length) {
    if (isMono(pieces, guide)) { s = 1; why.push("monochrome"); }
    else if (earthCoherent) { s = 1; why.push("one earth-tone family"); }
    else { s = r.noAccentScore; why.push("all neutrals"); }
  } else {
    s = 1;
    const a = acc[0];
    const on = pieces.filter((p) => p.tags.dominant === a || p.tags.secondary === a).length;
    const asDominant = pieces.filter((p) => p.tags.dominant === a).length;
    why.push(`neutral base with one ${a} accent`);
    if (on === 2) { s += r.echoBonus; why.push(`${a} echoed on two pieces`); }
    if (asDominant > 2) { s -= 0.2; why.push(`too much ${a}`); }
  }
  if (secondAcc.size) { s -= r.secondAccentPenalty * secondAcc.size; why.push(`a second accent in the details (${[...secondAcc].join(", ")})`); }
  const shoes = pieces.find((p) => p.slot === "sneakers");
  if (shoes && (shoes.tags.dominant === "white" || shoes.tags.dominant === "off-white")) { s += r.whiteSneakerBonus; why.push("white sneakers anchor it"); }
  return { score: Math.max(0, Math.min(1, s)), why };
}

const SIL = {
  "oversized|oversized": 0.4, "oversized|regular": 1, "oversized|slim": 1, "regular|oversized": 1, "slim|oversized": 1,
  "regular|regular": 0.8, "slim|slim": 0.7, "slim|regular": 0.85, "regular|slim": 0.85,
};
/** Volume balance between the outer top and the bottoms, 0–1. Pure. */
function silhouetteScore(pieces) {
  const top = pieces.find((p) => p.slot === "jacket") || pieces.find((p) => p.slot === "tee");
  const bottom = pieces.find((p) => p.slot === "bottoms");
  if (!top || !bottom || top.tags.silhouette === "n/a" || bottom.tags.silhouette === "n/a") return { score: 0.75, why: [] };
  const k = `${top.tags.silhouette}|${bottom.tags.silhouette}`;
  const score = SIL[k] ?? 0.75;
  const words = { oversized: "loose", regular: "straight", slim: "slim" };
  return { score, why: [`${words[top.tags.silhouette]} ${top.slot === "jacket" ? "layer" : "top"} over ${words[bottom.tags.silhouette]} bottoms`] };
}

/** One style family, 0–1: bordering families cost, a stray accessory a little. Pure. */
function familyScore(pieces, guide = GUIDE) {
  const core = pieces.filter((p) => !ACCESSORY_SLOTS.has(p.slot));
  const list = (core.length ? core : pieces).map((p) => p.tags.family);
  const counts = list.reduce((m, f) => ((m[f] = (m[f] || 0) + 1), m), {});
  const [main, n] = Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0] || ["", 0];
  let s = list.length ? 1 - 0.4 * (list.length - n) / list.length : 1;
  for (const p of pieces) if (ACCESSORY_SLOTS.has(p.slot) && !borders(p.tags.family, main, guide)) s -= 0.1;
  return { score: Math.max(0, s), main, why: [n === list.length ? `all ${main}` : `${main} with a ${Object.keys(counts).filter((f) => f !== main).join("/")} piece`] };
}

function formalityScore(pieces) {
  const f = pieces.map((p) => p.tags.formality);
  const spread = f.length ? Math.max(...f) - Math.min(...f) : 0;
  return { score: Math.max(0, 1 - 0.2 * spread), why: [spread ? `formality ${Math.min(...f)}–${Math.max(...f)}` : `formality ${f[0]} throughout`] };
}

function seasonScore(pieces, season, guide = GUIDE) {
  const v = pieces.map((p) => (guide.seasonFit[p.tags.season] || guide.seasonFit.all)[season]);
  const score = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 1;
  const off = pieces.filter((p) => p.tags.season !== "all" && p.tags.season !== season && season !== "shoulder");
  return { score, why: off.length ? [`${off.map((p) => p.slot).join(", ")} is a ${off[0].tags.season} piece`] : [`right for a Durban ${season}`] };
}

/** How cleanly the pieces match one look, 0–1, or null when its conditions fail. Pure. */
function lookMatch(pieces, look, { season, template = true, lookSlots = false, guide = GUIDE } = {}) {
  const has = (slot) => pieces.some((p) => p.slot === slot || (slot === "bottoms" && p.fullBody));
  if (template && !look.core.every((alts) => alts.some(has))) return null;
  // The lookbook: a look wears only the optional pieces it declares.
  if (lookSlots && !pieces.every((p) => lookAllows(look, p.slot))) return null;
  for (const w of look.requires) {
    if (w === "mono" && !isMono(pieces, guide)) return null;
    if (w === "noaccent" && dominantAccents(pieces, guide).size) return null;
    if (w === "accent=1" && dominantAccents(pieces, guide).size !== 1) return null;
    if ((w === "summer" || w === "winter") && season !== w) return null;
    if (w.startsWith("earth>=") && earthCount(pieces, guide) < Number(w.slice(7))) return null;
    const bottoms = pieces.find((p) => p.slot === "bottoms");
    if (w === "denim" && !(bottoms && fam(bottoms.tags.dominant, guide) === "denim")) return null;
    if (w === "shorts" && !(bottoms && bottoms.categoryKey === "shorts")) return null;
  }
  const coverage = pieces.filter((p) => look.palette.includes(p.tags.dominant)).length / pieces.length;
  if (coverage < 0.6) return null;
  const core = pieces.filter((p) => !ACCESSORY_SLOTS.has(p.slot));
  const famFrac = core.length ? core.filter((p) => look.families.includes(p.tags.family)).length / core.length : 1;
  return 0.6 * coverage + 0.4 * famFrac;
}

/** Does a look's template have room for this slot (core or extras)? Pure. */
function lookAllows(look, slot) {
  return look.core.some((alts) => alts.includes(slot)) || look.extras.includes(slot);
}

/** The best-matching look, or null. Ties go to the guide's order. Pure. */
function bestLook(pieces, ctx = {}) {
  const guide = ctx.guide || GUIDE;
  let best = null;
  for (const look of guide.looks) {
    const m = lookMatch(pieces, look, { ...ctx, guide });
    if (m !== null && (!best || m > best.match + 1e-9)) best = { look, match: m };
  }
  return best;
}

/**
 * Score one finished outfit. `ctx` = { season, template, minPieces, perPieceBonus, guide }.
 * @returns { score, parts, look, lookMatch, reasoning }
 */
function scoreOutfit(pieces, ctx = {}) {
  const guide = ctx.guide || GUIDE;
  const r = guide.rules;
  const season = ctx.season || "summer";
  const c = colourScore(pieces, guide), s = silhouetteScore(pieces), f = familyScore(pieces, guide);
  const fo = formalityScore(pieces), se = seasonScore(pieces, season, guide);
  const bl = bestLook(pieces, { season, template: ctx.template !== false, lookSlots: Boolean(ctx.lookSlots), guide });
  const fresh = pieces.length ? pieces.reduce((a, p) => a + Math.max(0, Math.min(1, Number(p.fresh) || 0)), 0) / pieces.length : 0;
  const parts = {
    colour: r.weightColour * c.score, silhouette: r.weightSilhouette * s.score, family: r.weightFamily * f.score,
    formality: r.weightFormality * fo.score, season: r.weightSeason * se.score,
    look: r.weightLook * (bl ? bl.match : 0), fresh: r.weightFresh * fresh,
    pieces: ctx.perPieceBonus ? r.perPieceOverMin * Math.max(0, pieces.length - (ctx.minPieces || pieces.length)) : 0,
    // A piece made for the other season costs on its own, not just as a share
    // of the average: one beanie in January must not ride along for a row.
    offSeason: season === "shoulder" ? 0 : -r.offSeasonPenalty * pieces.filter((p) => p.tags.season !== "all" && p.tags.season !== season).length || 0,
    // The season's hard penalty on outer layers and knitwear (guide
    // seasonRules): a cardigan over a sweater vest in a Durban October.
    layers: -pieces.reduce((a, p) => a + layerPenalty(p, season, guide), 0) || 0,
  };
  for (const k of Object.keys(parts)) parts[k] = Math.round(parts[k] * 100) / 100;
  const score = Math.round(Object.values(parts).reduce((a, b) => a + b, 0) * 100) / 100;
  const layered = pieces.filter((p) => layerPenalty(p, season, guide) > 0);
  const lw = layered.length ? [`${layered.map((p) => (isKnitwear(p) ? "knitwear" : "an outer layer")).join(" and ")} in the Durban ${season} season`] : [];
  const reasoning = [...c.why, ...s.why, ...f.why, ...fo.why, ...se.why, ...lw].join("; ");
  return { score, parts, look: bl ? bl.look.key : null, lookMatch: bl ? Math.round(bl.match * 100) / 100 : 0, reasoning };
}

/**
 * Enumerate, refuse, score and shortlist.
 *
 * @param pieces [{ pid, slot, price|null, fresh 0–1, tags, categoryKey?, fullBody?, displayName?, websiteName?, ref }]
 * @param opts {
 *   core: [[slot, …alternatives], …]   every group must be filled (null: no template)
 *   slots: the slots that may appear (default: every slot in ORDER)
 *   minPieces, maxPieces,
 *   prefer { min, max } | null           the preferred total: an exact-tie breaker only
 *   fits(chosenRefs, ref) → boolean      wardrobe context (social-select fitsWith)
 *   month, look: force one look key, perPieceBonus, template (looks' slot templates apply)
 *   lookSlots: each look enumerates only its declared optional slots, and an
 *              outfit that matches no look wears no headwear (the lookbook)
 *   noHeadwear: no hat at all (the lookbook's one-in-three rotation)
 *   requireSlots: [slot, …] every outfit must include these (the samples)
 *   menswear: false lets non-menswear through (default true: every post is men's)
 *   guide
 * }
 * @returns { outfits, shortlist, considered, refused: { reason: count }, excluded: { reason: count }, best }
 */
function styleOutfits(pieces, opts = {}) {
  const guide = opts.guide || GUIDE;
  const r = guide.rules;
  const season = seasonOf(opts.month || 1, guide);
  const slots = (opts.slots || ORDER).filter((s) => ORDER.includes(s));
  const order = ORDER.filter((s) => slots.includes(s));
  const minPieces = opts.minPieces || 2, maxPieces = opts.maxPieces || order.length;
  const core = opts.core || [];
  const prefer = opts.prefer || null;
  const fits = opts.fits || (() => true);
  const perSlot = Math.max(1, opts.perSlot || r.perSlot);
  const lookSlots = Boolean(opts.lookSlots);
  const requireSlots = opts.requireSlots || [];
  const ctx = { season, template: opts.template !== false, lookSlots, minPieces, perPieceBonus: Boolean(opts.perPieceBonus), guide };
  const forced = opts.look ? guide.looks.find((l) => l.key === opts.look) || null : null;
  if (opts.look && !forced) throw new Error(`styleOutfits: unknown look "${opts.look}"`);
  const looks = forced ? [forced] : guide.looks;
  const sr = seasonRulesFor(season, guide);
  // ── 0. EXCLUDED before scoring: not menswear, or a hat this season or
  // this rotation does not allow. Counted, so a starved day says why.
  const excluded = {};
  const exclude = (why) => { excluded[why] = (excluded[why] || 0) + 1; return false; };
  const eligible = pieces.filter((p) => {
    if (opts.menswear !== false) { const why = menswearRefusal(p); if (why) return exclude(why); }
    if (p.slot === "hat") {
      if (opts.noHeadwear) return exclude("headwear rests (one lookbook in three)");
      const kind = headwearOf(p);
      // A hat of unknown kind only where the season allows a beanie too: in
      // summer a hat must be KNOWN to be a cap.
      if (kind ? !sr.headwear.includes(kind) : !sr.headwear.includes("beanie")) return exclude(kind ? `a ${kind} in a Durban ${season}` : `headwear that is not named a ${sr.headwear.join("/")} in a Durban ${season}`);
    }
    return true;
  });
  // Each plan enumerates from its own per-slot shortlist: a look's palette
  // (so an earth-tone look is not starved by six black tees), and one with no
  // palette at all. With lookSlots a look's plan has only its declared
  // optional slots; the palette-free plan has every slot, and an outfit from
  // it keeps an optional piece only when it matches a look that declares it
  // (checked after scoring). A look's palette needs only 60% of the pieces,
  // so a cap look with olive jeans exists only in that plan (19 Oct).
  const plans = [
    ...looks.map((l) => ({ palette: new Set(l.palette), slots: lookSlots ? order.filter((s) => lookAllows(l, s) || core.some((alts) => alts.includes(s))) : order })),
    ...(opts.look ? [] : [{ palette: null, slots: order }]),
  ];
  const seen = new Map();
  const refused = {};
  let considered = 0;
  const groupOk = (chosen) => core.every((alts) => alts.some((s) => chosen.some((p) => p.slot === s || (s === "bottoms" && p.fullBody))))
    && requireSlots.every((s) => chosen.some((p) => p.slot === s));

  for (const plan of plans) {
    const bySlot = new Map(order.map((s) => [s, []]));
    for (const p of eligible) {
      if (!bySlot.has(p.slot) || !plan.slots.includes(p.slot)) continue;
      if (plan.palette && !plan.palette.has(p.tags.dominant)) continue;
      bySlot.get(p.slot).push(p);
    }
    for (const [s, list] of bySlot) {
      list.sort((a, b) => (b.fresh || 0) - (a.fresh || 0) || (a.pid < b.pid ? -1 : 1));
      // The freshest perSlot − 2, plus the two freshest QUIET pieces of the
      // rest (solid, not a loud colour), so a slot of fresh prints cannot
      // break the one-loud-piece rule for every outfit (19 Oct: the six
      // freshest tees were all graphic prints and no cap look could form).
      const top = list.slice(0, Math.max(1, perSlot - 2));
      const quiet = list.slice(top.length).filter((p) => !isLoud(p.tags, guide)).slice(0, Math.max(0, Math.min(2, perSlot - top.length)));
      const fill = list.slice(top.length).filter((p) => !quiet.includes(p)).slice(0, Math.max(0, perSlot - top.length - quiet.length));
      bySlot.set(s, [...top, ...quiet, ...fill]);
    }
    const walk = (i, chosen, sum) => {
      if (chosen.length > maxPieces) return;
      if (i === order.length) {
        if (chosen.length < minPieces || !groupOk(chosen)) return;
        considered++;
        const why = hardRule(chosen, guide);
        if (why) { const k = refusalKey(why); refused[k] = (refused[k] || 0) + 1; return; }
        const key = chosen.map((p) => p.pid).sort().join(",");
        if (seen.has(key)) return;
        const sc = scoreOutfit(chosen, ctx);
        // The lookbook: an optional piece only where a look that declares it
        // is worn; an outfit that matches no look is the core alone.
        if (lookSlots && !forced && !sc.look && chosen.some((p) => !core.some((alts) => alts.includes(p.slot)))) { refused["an optional piece with no look that wears it"] = (refused["an optional piece with no look that wears it"] || 0) + 1; return; }
        // A forced look keeps every outfit that QUALIFIES for it, not only
        // the ones it matches best, and names the outfit after it (Fable
        // review of #759: coastal-summer lost every outfit to earth-tone).
        if (forced) {
          const m = lookMatch(chosen, forced, { season, template: ctx.template, lookSlots, guide });
          if (m === null) { refused[`not ${forced.key}`] = (refused[`not ${forced.key}`] || 0) + 1; return; }
          const lookPart = Math.round(r.weightLook * m * 100) / 100;
          sc.score = Math.round((sc.score - sc.parts.look + lookPart) * 100) / 100;
          sc.parts = { ...sc.parts, look: lookPart };
          sc.look = forced.key; sc.lookMatch = Math.round(m * 100) / 100;
        }
        seen.set(key, { key, pieces: chosen.slice(), total: sum, inPrefer: !prefer || (sum >= prefer.min && sum <= prefer.max), ...sc });
        return;
      }
      const slot = order[i];
      for (const p of bySlot.get(slot)) {
        if (p.fullBody && chosen.some((x) => x.slot === "bottoms")) continue;
        if (slot === "bottoms" && chosen.some((x) => x.fullBody)) continue;
        if (chosen.some((x) => x.pid === p.pid)) continue;
        if (!fits(chosen.map((x) => x.ref), p.ref)) continue;
        chosen.push(p);
        const why = hardRule(chosen, guide, { partial: true });
        if (!why) walk(i + 1, chosen, sum + (p.price || 0));
        // Refused while building: counted under its rule.
        else { const k = refusalKey(why); refused[k] = (refused[k] || 0) + 1; }
        chosen.pop();
      }
      walk(i + 1, chosen, sum);
    };
    walk(0, [], 0);
  }

  const outfits = [...seen.values()].sort(byScore);
  return { outfits, shortlist: shortlistOf(outfits, guide), considered, refused, excluded, best: outfits[0] || null };
}

// "2 accent colours (red, green) — the guide allows 1" → "N accent colours — the guide allows N"
const refusalKey = (why) => why.replace(/\(.*?\)/g, "").replace(/\d+/g, "N").replace(/\s+/g, " ").trim();
// Score first. Only an exact tie (to 0.1 point) looks at the price: the total
// inside the preferred range wins it (Junid, 19 Oct: price never refuses).
const byScore = (a, b) => Math.round(b.score * 10) - Math.round(a.score * 10)
  || (b.inPrefer === true) - (a.inPrefer === true) || b.score - a.score || (a.key < b.key ? -1 : 1);

/**
 * The best `shortlist` outfits within `tieWindow` points of the top. Five
 * near-copies of one outfit (the same look with a different cap) is not a
 * choice: each one differs from every other by two pieces (a two-piece
 * pairing by one). Pure.
 */
function shortlistOf(outfits, guide = GUIDE) {
  const r = guide.rules;
  const sorted = outfits.slice().sort(byScore);
  const best = sorted[0];
  const out = [];
  for (const o of sorted) {
    if (out.length >= r.shortlist) break;
    if (best && o.score < best.score - r.tieWindow) break;
    const ids = new Set(o.pieces.map((p) => p.pid));
    // A two-piece pairing may share one piece with another option.
    if (out.some((s) => s.pieces.filter((p) => ids.has(p.pid)).length > Math.max(1, Math.max(s.pieces.length, o.pieces.length) - 2))) continue;
    out.push(o);
  }
  return out;
}

// ── THE TIE-BREAK: ONE SHORT TEXT-MODEL CALL ────────────────────────────────
const lookByKey = (key, guide = GUIDE) => guide.looks.find((l) => l.key === key) || null;

/** The prompt that asks the model to choose among the shortlist. Pure. */
function buildChoicePrompt(shortlist, { kind = "lookbook", season = "summer", guide = GUIDE } = {}) {
  const pairing = kind === "pairing";
  const looks = guide.looks.map((l) => `- ${l.key}: ${l.name} (${l.families.join("/")}; ${l.palette.slice(0, 8).join(", ")})`).join("\n");
  const body = shortlist.map((o, i) => [
    `OPTION ${i + 1} — score ${o.score}/100, closest look: ${o.look || "none"}`,
    ...o.pieces.map((p) => `  · ${p.slot}: ${p.label || p.pid} — ${p.tags.dominant}${p.tags.secondary ? `/${p.tags.secondary}` : ""}, ${p.tags.pattern}, ${p.tags.silhouette}, ${p.tags.family}`),
    `  why it scored: ${o.reasoning}`,
  ].join("\n")).join("\n\n");
  return [
    `You are the menswear stylist for Marathon Club, a Durban streetwear and sneaker store. It is ${season} in Durban.`,
    `These ${shortlist.length} ${pairing ? "pairings" : kind === "flatlay" ? "flat-lay sets" : "outfits"} all passed the house style guide and scored within a few points of each other. Choose the ONE a good stylist would post.`,
    "",
    body,
    "",
    "The named looks:",
    looks,
    "",
    "Answer with ONLY a JSON object:",
    '{"choice": <option number>, "look": "<look key from the list>", "note": "<one line, at most 120 characters: why this works — colour, proportion, mood>"}',
    pairing
      ? "The note is about two or three pieces that go together. Never call them an outfit, a look or a fit."
      : "The note speaks to a customer, in plain words. No prices, no hashtags, no emoji.",
    "Marathon Club sells online: never mention a shop, a branch, \"in store\" or visiting.",
  ].join("\n");
}

const NOTE_MAX = 140;
/** A note fit for a caption: one line, short, no price, no hashtag. Pure. */
function cleanNote(note, { kind } = {}) {
  let s = String(note || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").replace(/^["'“”]+|["'“”]+$/g, "").trim();
  // Too short to say anything ("x", "Nice."), or a price, a hashtag or a link.
  if (s.length < 12 || /#|\bR\s?\d/.test(s) || /https?:/i.test(s)) return null;
  // The shop is online-only in every caption (social-caption policy): a note
  // that sends people to a branch is not used (CodeRabbit on #759).
  if (/\b(?:in[- ]?store|visit us|come see us|pop in|our (?:shop|store|branch))\b/i.test(s)) return null;
  if (kind === "pairing" && /\b(outfits?|looks?|fits?)\b/i.test(s)) return null;
  if (s.length > NOTE_MAX) {
    const cut = s.slice(0, NOTE_MAX);
    s = cut.slice(0, Math.max(cut.lastIndexOf(" "), 60)).replace(/[,;:\s—-]+$/, "") + ".";
  }
  return s;
}

/** The deterministic note, from the scoring's own reasons. Pure. */
function fallbackNote(outfit, { kind } = {}) {
  const parts = String((outfit && outfit.reasoning) || "").split("; ").filter((w) => !/^formality|^right for/.test(w)).slice(0, 3);
  const s = parts.length ? parts.join(", ") : "pieces that sit well together";
  return cleanNote(s.charAt(0).toUpperCase() + s.slice(1) + ".", { kind }) || "Pieces that sit well together.";
}

/**
 * The model's answer → { index, look, note, source }. An unreadable answer,
 * a choice out of range or an unknown look falls back to the deterministic
 * one, field by field. Pure.
 */
function readChoice(text, shortlist, { kind = "lookbook", season = "summer", guide = GUIDE } = {}) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  let v = null;
  try { v = a !== -1 && b > a ? JSON.parse(s.slice(a, b + 1)) : null; } catch { v = null; }
  const n = v ? Number(v.choice) : NaN;
  const valid = Number.isInteger(n) && n >= 1 && n <= shortlist.length;
  const index = valid ? n - 1 : 0;
  const chosen = shortlist[index];
  // A note and a look written for an option that does not exist describe
  // nothing that will be posted: both are dropped with the choice.
  if (!valid) v = null;
  const modelLook = v && lookByKey(String(v.look || "").trim().toLowerCase(), guide);
  // The model's look only where the outfit actually qualifies for it.
  const qualifies = modelLook && lookMatch(chosen.pieces, modelLook, { season, template: kind !== "pairing" && kind !== "flatlay", lookSlots: kind === "lookbook", guide }) !== null;
  const look = qualifies ? modelLook.key : chosen.look;
  const note = (v && cleanNote(v.note, { kind })) || fallbackNote(chosen, { kind });
  const source = valid ? "model" : "score";
  return { index, look, note, source };
}

/** The panel header for a look key: one or two lines, or the house fallback. Pure. */
const FALLBACK_HEADER = ["THE EVERYDAY", "LEGACY COLLECTION"];
function headerFor(lookKey, guide = GUIDE) {
  const l = lookByKey(lookKey, guide);
  return l ? l.header.slice() : FALLBACK_HEADER.slice();
}

module.exports = {
  GUIDE, ORDER, ACCESSORY_SLOTS, FALLBACK_HEADER, NOTE_MAX,
  seasonOf, seasonRulesFor, menswearRefusal, headwearOf, isKnitwear, layerPenalty, lookAllows, hardRule, isMono, colourScore, silhouetteScore, familyScore, formalityScore, seasonScore,
  lookMatch, bestLook, scoreOutfit, styleOutfits, shortlistOf,
  buildChoicePrompt, readChoice, cleanNote, fallbackNote, headerFor, lookByKey,
};
