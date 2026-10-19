// ─── THE STYLIST FOR THE OTHER MULTI-PRODUCT POSTS ───────────────────────────
// Flat-lays, pairings and outfits (generateOnePost in functions/index.js)
// choose their products with the same stylist as the lookbook (lib/stylist.cjs)
// and the same style guide. Single products and new-arrivals carousels are
// untouched: social-select pickForKind still makes those.
//
//   pairing  each of social-select's PAIRING_SHAPES, exactly that many pieces;
//            the owner's preference order is a small bonus, never a filter.
//            Never a top + bottom + shoe set: that is an outfit.
//   outfit   top, bottoms and shoes (a tracksuit is top and bottoms), up to
//            the kind's maxProducts with cap, bag and fragrance as extras.
//   flatlay  three to five pieces from different slots, no template.
//
// No price rule at all, the same hard rules, the same menswear and season
// exclusions, the same score,
// the same shortlist and the same one text-model tie-break. Pure.
//
// Only products with an outfit slot (social-select outfitSlot: shoes, tops,
// bottoms, caps, bags, fragrance) can be styled, so a flat-lay no longer
// takes an unslotted product the old ranking could. A pairing's look is kept
// on the post record for the report; its caption never names it.
"use strict";

const socialSelect = require("./social-select.cjs");
const styleTags = require("./style-tags.cjs");
const stylist = require("./stylist.cjs");
const { displayNameRefusal, displayNameOf } = require("./social-lookbook.cjs");

const STYLED_KINDS = new Set(["pairing", "outfit", "flatlay"]);
// The stylist's slot for a social outfit slot (social-select SLOT_MATCHERS).
const TOP_LAYERS = new Set(["jackets", "hoodies"]);
const FULL_BODY = new Set(["tracksuits", "dresses"]);
function stylistSlot(c) {
  const key = String((c.product && c.product.categoryKey) || c.categoryKey || "").toLowerCase();
  switch (c.slot) {
    case "shoe": return "sneakers";
    case "top": return TOP_LAYERS.has(key) ? "jacket" : "tee";
    case "bottom": return "bottoms";
    case "cap": return "hat";
    case "bag": return "bag";
    case "fragrance": return "fragrance";
    default: return null;
  }
}
// Social outfit slot → the stylist's alternatives for it.
const SHAPE_SLOT = { top: ["tee", "jacket"], shoe: ["sneakers"], bottom: ["bottoms"], cap: ["hat"], bag: ["bag"], fragrance: ["fragrance"] };
// Enumeration width per slot for these kinds: seven slots, so narrower than
// the lookbook's six to keep a run to a second or two.
const SOCIAL_PER_SLOT = 4;
const SHAPE_BONUS = 0.5;

/**
 * A social-select candidate as a stylist piece, or null. A product whose
 * display name (the label these posts print) is a category and colour only
 * or a bare stock number with no brand is never a piece (Junid, 19 Oct). Who
 * it is cut for is decided in the stylist (menswearRefusal). Pure.
 */
function pieceOf(c, tags) {
  const slot = stylistSlot(c);
  if (!slot) return null;
  const displayName = displayNameOf(c);
  if (displayNameRefusal(displayName, c.product)) return null;
  const p = c.product || {};
  const key = String(p.categoryKey || "").toLowerCase();
  return {
    pid: c.pid, slot, price: Number(c.retailPrice) || null, categoryKey: key,
    fullBody: FULL_BODY.has(key),
    fresh: Math.max(0, Math.min(1, Number(c.score) || 0)),
    tags: (tags && tags.get(c.pid)) || styleTags.nameTags({ name: p.name, websiteName: c.name, brand: p.brand, categoryKey: p.categoryKey }),
    displayName, websiteName: c.name || "",
    label: c.displayName || c.name || c.pid, ref: c,
  };
}

/**
 * Choose the products for ONE styled post.
 * @param kind  "pairing" | "outfit" | "flatlay"
 * @param opts  { used: Set, tags: Map pid → tags, month 1–12 }
 * @returns { picks, reason, shortlist: [{ picks, score, look, reasoning, pieces }], shape? }
 */
function styledPicksForKind(kind, candidates, { used = new Set(), tags = new Map(), month = 10 } = {}) {
  const spec = socialSelect.POST_KINDS.find((k) => k.key === kind);
  if (!spec || !STYLED_KINDS.has(kind)) return { picks: [], reason: `the stylist does not choose "${kind}" posts`, shortlist: [] };
  const pieces = (candidates || []).filter((c) => c && !used.has(c.pid)).map((c) => pieceOf(c, tags)).filter(Boolean);
  const fits = (chosen, c) => socialSelect.fitsWith(chosen, c);
  const base = { fits, month, perSlot: SOCIAL_PER_SLOT };
  let outfits = [];
  // What the stylist removed before scoring, for the skip reason (the same
  // piece counted once across the pairing shapes).
  const excluded = {};
  const noteExcluded = (res) => { for (const [k, n] of Object.entries(res.excluded || {})) excluded[k] = Math.max(excluded[k] || 0, n); return res; };
  if (kind === "pairing") {
    socialSelect.PAIRING_SHAPES.forEach((shape, i) => {
      const core = shape.map((s) => SHAPE_SLOT[s]);
      const res = noteExcluded(stylist.styleOutfits(pieces, { ...base, core, slots: [...new Set(core.flat())], minPieces: shape.length, maxPieces: shape.length, template: false }));
      // The owner's preference order, as a nudge.
      const bonus = SHAPE_BONUS * (socialSelect.PAIRING_SHAPES.length - i);
      // The shape's own groups must each hold exactly one piece (no tee + jacket as "top, shoe").
      for (const o of res.outfits) {
        if (!core.every((alts) => o.pieces.filter((p) => alts.includes(p.slot)).length === 1)) continue;
        outfits.push({ ...o, score: Math.round((o.score + bonus) * 100) / 100, shape });
      }
    });
  } else if (kind === "outfit") {
    const res = noteExcluded(stylist.styleOutfits(pieces, {
      ...base, core: [["tee", "jacket"], ["bottoms"], ["sneakers"]], slots: ["tee", "jacket", "bottoms", "sneakers", "hat", "bag", "fragrance"],
      minPieces: spec.minProducts, maxPieces: spec.maxProducts,
    }));
    outfits = res.outfits;
  } else {
    const res = noteExcluded(stylist.styleOutfits(pieces, { ...base, core: [], minPieces: spec.minProducts, maxPieces: spec.maxProducts, template: false }));
    outfits = res.outfits;
  }
  // The same products reached through two shapes are one pairing: keep the better.
  const byKey = new Map();
  for (const o of outfits) if (!byKey.has(o.key) || byKey.get(o.key).score < o.score) byKey.set(o.key, o);
  const shortlist = stylist.shortlistOf([...byKey.values()]).map((o) => ({
    picks: stylist.ORDER.flatMap((s) => o.pieces.filter((p) => p.slot === s)).map((p) => p.ref),
    score: o.score, look: o.look, reasoning: o.reasoning, pieces: o.pieces, parts: o.parts, shape: o.shape || null,
  }));
  if (!shortlist.length) {
    const ex = Object.entries(excluded).sort((a, b) => b[1] - a[1]);
    return { picks: [], shortlist, excluded, reason: `the stylist found no ${spec.label.toLowerCase()} in live stock that passes the style guide${ex.length ? ` (removed first: ${ex.slice(0, 3).map(([k, n]) => `${k} ×${n}`).join("; ")})` : ""}` };
  }
  return { picks: shortlist[0].picks, reason: null, shortlist, shape: shortlist[0].shape };
}

/**
 * The rules that need no style tags: a real display name, and nothing that
 * says it is women's by either name. The unstyled fallback uses it. Pure.
 */
function nameEligible(c) {
  const displayName = displayNameOf(c);
  if (displayNameRefusal(displayName, c && c.product)) return false;
  return !styleTags.nameGender(`${displayName} ${(c && c.name) || ""}`).gender;
}

/** The text model's prompt for a styled pick. Pure. */
function styledChoicePrompt(kind, result, { month = 10 } = {}) {
  return stylist.buildChoicePrompt(result.shortlist, { kind, season: stylist.seasonOf(month) });
}

/**
 * The model's answer applied: the chosen picks, look and note. An unreadable
 * answer keeps the top score and the scorer's note. Pure.
 */
function chooseStyledPicks(kind, result, answerText, { month = 10 } = {}) {
  if (!result || !result.shortlist || !result.shortlist.length) return result;
  const c = stylist.readChoice(answerText, result.shortlist, { kind, season: stylist.seasonOf(month) });
  const chosen = result.shortlist[c.index];
  const def = stylist.lookByKey(c.look);
  return {
    ...result, picks: chosen.picks, shape: chosen.shape,
    look: { key: c.look, name: def ? def.name : null, note: c.note, score: chosen.score, source: c.source, choice: c.index + 1, of: result.shortlist.length },
  };
}

module.exports = { STYLED_KINDS, stylistSlot, pieceOf, nameEligible, styledPicksForKind, styledChoicePrompt, chooseStyledPicks };
