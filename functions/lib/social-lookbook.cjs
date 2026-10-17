// ─── THE LOOKBOOK POSTER: WHAT GOES IN IT, AND WHICH DAY IT RUNS ─────────────
//
// The daily still alternates between two formats (owner addendum, 2026-10-17):
// day A is the current designed still (generateOnePost, story + feed twin,
// untouched), day B is the Lookbook poster. This file is the pure half of the
// lookbook: the outfit picker, the price and photo resolver, the rotation, the
// hero prompt and the reading of the no-text check. No RTDB, no network, no
// clock of its own; functions/lookbook/lookbook.cjs does the I/O.
//
// ── EVERY NUMBER ON THE POSTER COMES FROM /products ──────────────────────────
// The price on a row is products/{pid}/retailPrice, rounded to whole rand, and
// the TOTAL is the sum of the rows actually drawn. A product without a usable
// price is not drawn with a gap. It is skipped and the next one in its slot is
// tried, and if the slot runs dry the row is dropped. A poster that cannot
// reach MIN_ROWS is not made: the day posts the current style instead.
"use strict";

const { isGeneratedPhoto } = require("../newArrivals/sourcePhoto.cjs");
const { fitsWith } = require("./social-select.cjs");

// ── THE SIX ROWS, HEAD TO TOE ────────────────────────────────────────────────
// `keys` are products/{pid}/categoryKey values from the live catalogue (the
// same vocabulary social-select.cjs SLOT_MATCHERS was counted against).
// `guess` is only a READ-ORDER hint over the storefront title. It decides which
// products are worth reading first. The record's categoryKey decides the slot.
//
// `anchor` is where the model-side dot of the leader line sits when the vision
// check gives no position for the item. It is a fraction of the generated photo, and
// the hero prompt pins the composition (full length, body at 58% of the
// width, head ~12% from the top, feet ~15% above the bottom) so these land on
// the body. Rows are head to toe and so are these, so the lines never cross.
const LOOKBOOK_SLOTS = [
  { slot: "hat",      label: "hat",      keys: ["caps-beanies", "fitted-caps", "visors"],
    guess: /\b(cap|caps|beanie|bucket|visor|fitted|snapback|hat)\b/i, anchor: { x: 0.58, y: 0.135 } },
  { slot: "jacket",   label: "jacket",   keys: ["jackets", "hoodies"],
    guess: /\b(jackets?|hoodies?|puffer|windbreaker|windrunner|anorak|bomber|sweaters?|pullover|cardigan|quarter-zip)\b/i, anchor: { x: 0.53, y: 0.29 } },
  { slot: "tee",      label: "tee",      keys: ["t-shirts", "golf-t-shirts"],
    guess: /\b(t-shirts?|tees?|t|polo|henley|shirt|top)\b/i, anchor: { x: 0.60, y: 0.34 } },
  { slot: "bottoms",  label: "bottoms",  keys: ["shorts", "pants", "jeans"],
    guess: /\b(shorts?|pants|jeans?|cargo|trousers?|joggers?|chinos?)\b/i, anchor: { x: 0.55, y: 0.54 } },
  { slot: "bag",      label: "bag",      keys: ["bags"],
    guess: /\b(bag|backpack|crossbody|sling|pouch|tote|duffel|messenger)\b/i, anchor: { x: 0.72, y: 0.58 } },
  { slot: "sneakers", label: "sneakers", keys: ["sneakers"],
    guess: /\b(sneakers?|low-top|mid-top|high-top|trainers?|runners?)\b/i, anchor: { x: 0.58, y: 0.82 } },
];
const SLOT_KEYS = LOOKBOOK_SLOTS.map((s) => s.slot);
const SLOT_BY_KEY = new Map(LOOKBOOK_SLOTS.map((s) => [s.slot, s]));

// Fewer than four rows is not a lookbook, it is a pairing with a big panel.
const MIN_ROWS = 4;
// "Not used in the last 14 lookbooks".
const HISTORY_DEPTH = 14;
// How many of each guessed slot the loader reads per round. Six slots at eight
// is 48 product reads, which is less than the 80 the reel shortlist reads.
const READS_PER_SLOT = 8;

/** Which lookbook row a product fills, or null. Pure. */
function lookbookSlot(product) {
  const key = String((product && product.categoryKey) || "").toLowerCase();
  if (!key) return null;
  for (const s of LOOKBOOK_SLOTS) if (s.keys.includes(key)) return s.slot;
  return null;
}

/** The slot a storefront title SUGGESTS, for read ordering only. Pure. */
// Never a lookbook row, whatever else the title says: a suit jacket is
// categorised "suits" and a tracksuit is top AND bottom. Reading them first
// starved the jacket slot on the first live dry run (2026-10-17).
const NOT_A_ROW = /\b(suit|suits|tracksuits?|two-piece|set)\b/i;

function guessSlot(cleanName) {
  const name = String(cleanName || "");
  if (NOT_A_ROW.test(name)) return null;
  // The catalogue's titles are "<adjectives> <noun> in <colour> with <detail>",
  // so the noun is the LAST slot word before the first in/with/and/on/for:
  // "Textured knit runner in orange" is a runner, not a knit.
  const head = name.split(/\s+(?:in|with|and|on|for)\s+/i)[0];
  const lastHit = (text) => {
    let best = null, at = -1;
    for (const s of LOOKBOOK_SLOTS) {
      const re = new RegExp(s.guess.source, "gi");
      let m;
      while ((m = re.exec(text))) if (m.index >= at) { at = m.index; best = s.slot; }
    }
    return best;
  };
  return lastHit(head) || lastHit(name);
}

/**
 * The retail price as whole rand, or null when the record has none.
 * Never typed and never guessed: products/{pid}/retailPrice is the only source,
 * and anything that is not a positive finite number is "no price". Pure.
 */
function priceOf(product) {
  const raw = product && product.retailPrice;
  if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean") return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.round(v);
}

/**
 * "R1,399": a comma for thousands and no decimals. The ONLY place a lookbook
 * price becomes text. Written out rather than taken from toLocaleString,
 * whose separator for en-ZA is a narrow no-break space that depends on the
 * ICU build. Pure.
 */
function formatRand(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  return "R" + String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * The approved photo for a product: the New Arrivals studio photo where one
 * exists, else the storefront's lead photo, else the record's hero. An
 * approved studio photo REPLACES products/{pid}/photoUrl (see
 * newArrivals/sourcePhoto.cjs), so "studio" is photoUrl being a generated one.
 * Returns { url, studio } or null. Pure.
 */
function approvedPhoto(product, node) {
  const p = product || {};
  if (p.photoUrl && isGeneratedPhoto(p.photoUrl)) return { url: String(p.photoUrl), studio: true };
  const photos = Array.isArray(node && node.photos)
    ? node.photos
    : node && node.photos && typeof node.photos === "object" ? Object.values(node.photos) : [];
  const lead = photos.find((u) => typeof u === "string" && u.trim());
  if (lead) return { url: lead, studio: false };
  if (typeof p.photoUrl === "string" && p.photoUrl.trim()) return { url: p.photoUrl, studio: false };
  return null;
}

/**
 * A candidate (social-select buildCandidates row) resolved to a poster row, or
 * { skip } saying exactly why it cannot be one. Pure.
 */
function resolveRow(candidate) {
  const c = candidate || {};
  const slot = lookbookSlot(c.product);
  if (!slot) return { skip: "no lookbook slot for its category" };
  const price = priceOf(c.product);
  if (price === null) return { skip: "no retail price" };
  const photo = approvedPhoto(c.product, c.node);
  if (!photo) return { skip: "no approved photo" };
  return {
    row: {
      pid: c.pid, slot, price, priceText: formatRand(price),
      photoUrl: photo.url, studio: photo.studio,
      displayName: c.displayName || c.name || "",
      name: c.name || null, handle: c.handle || null, link: c.link || null,
      liveAt: Number(c.liveAt) || 0,
      newNorm: Number(c.newNorm) || 0,
      score: Number(c.score) || 0,
    },
  };
}

/**
 * The pids used in the last HISTORY_DEPTH lookbooks.
 *
 * `history` is the value of social_lookbook/history as RTDB hands it back:
 * { [saDate]: { pids: [...], at } }. RTDB DELETES an empty array, so a day
 * with no pids comes back with no `pids` key at all, not `pids: []`. It can
 * also turn an array into an object { "0": ..., "1": ... } when keys are
 * sparse. Both are read here, and anything else is ignored. Pure.
 */
function recentLookbookPids(history, depth = HISTORY_DEPTH) {
  const out = new Set();
  if (!history || typeof history !== "object") return out;
  const days = Object.keys(history).sort().slice(-depth);
  for (const d of days) {
    const entry = history[d];
    const raw = entry && entry.pids;
    const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
    for (const pid of list) if (typeof pid === "string" && pid) out.add(pid);
  }
  return out;
}

/**
 * Pick one product per slot, head to toe.
 *
 * Bias, in order of weight: not in the last 14 lookbooks, then an approved
 * New Arrivals studio photo (it is on plain grey, so it cuts out cleanly and
 * is the best reference the model can be given), then newness, then the
 * shared sales and newness score. Every term is a preference. Only price, photo
 * and slot are refusals. Ties break on pid so two runs on the same data agree.
 *
 * A piece that does not share a wardrobe context with what is already chosen
 * (social-select fitsWith: no soccer boot with jeans) is passed over for the
 * next one in its slot. A slot with nothing that fits is dropped.
 *
 * @param candidates  social-select buildCandidates rows (live, in stock)
 * @param opts.recent Set of pids used in recent lookbooks
 * @param opts.used   Set of pids already spoken for today (never picked)
 * @returns { rows, total, reason, skipped: [{ pid, slot, why }] }
 */
function pickLookbookOutfit(candidates, { recent = new Set(), used = new Set() } = {}) {
  const skipped = [];
  const bySlot = new Map(SLOT_KEYS.map((k) => [k, []]));
  for (const c of candidates || []) {
    if (!c || !c.pid || used.has(c.pid)) continue;
    const r = resolveRow(c);
    if (r.skip) {
      if (lookbookSlot(c.product)) skipped.push({ pid: c.pid, slot: lookbookSlot(c.product), why: r.skip });
      continue;
    }
    bySlot.get(r.row.slot).push({ row: r.row, candidate: c });
  }
  const rank = (e) => (recent.has(e.row.pid) ? 0 : 4) + (e.row.studio ? 1 : 0)
    + e.row.newNorm + 0.5 * e.row.score;
  for (const list of bySlot.values()) {
    list.sort((a, b) => rank(b) - rank(a) || (a.row.pid < b.row.pid ? -1 : 1));
  }

  // The core of the look first (what is on the body), then the finishing
  // pieces, so a hat can never be the reason a pair of shorts is refused.
  const ORDER = ["tee", "bottoms", "sneakers", "jacket", "hat", "bag"];
  const chosen = new Map();
  const chosenCandidates = [];
  for (const slot of ORDER) {
    const pick = bySlot.get(slot).find((e) => fitsWith(chosenCandidates, e.candidate));
    if (pick) { chosen.set(slot, pick.row); chosenCandidates.push(pick.candidate); }
  }
  const rows = SLOT_KEYS.filter((k) => chosen.has(k)).map((k) => chosen.get(k));
  const missing = SLOT_KEYS.filter((k) => !chosen.has(k));
  if (rows.length < MIN_ROWS) {
    return {
      rows: [], total: 0, skipped,
      reason: `no eligible outfit — only ${rows.length} of the six slots could be filled (nothing for: ${missing.join(", ")}); a lookbook needs ${MIN_ROWS}`,
    };
  }
  return { rows, total: rows.reduce((s, r) => s + r.price, 0), reason: null, skipped, missing };
}

/** The history entry a finished lookbook writes. Pure. */
function historyEntry(rows, atMs) {
  return { pids: (rows || []).map((r) => r.pid), at: atMs };
}

// ── THE ROTATION ─────────────────────────────────────────────────────────────
const STILL_FORMAT_KEYS = ["current", "lookbook"];
const DEFAULT_STILL_FORMATS = ["current", "lookbook"];

/**
 * STILL_FORMATS as configured: a JSON array of format names, in rotation
 * order. A name may repeat to weight it (["current","lookbook","lookbook"]).
 * Unknown names are dropped. LOOKBOOK_ENABLED=false removes "lookbook". An
 * unreadable value falls back to the default rather than turning the still
 * off, because a typo should not silently cost a post a day. An explicit "[]"
 * does turn it off. Pure.
 */
function parseStillFormats(raw, { lookbookEnabled = true } = {}) {
  let list = DEFAULT_STILL_FORMATS;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) list = v;
    } catch { /* default */ }
  } else if (Array.isArray(raw)) {
    list = raw;
  }
  return list
    .map((s) => String(s || "").trim().toLowerCase())
    .filter((s) => STILL_FORMAT_KEYS.includes(s))
    .filter((s) => lookbookEnabled || s !== "lookbook");
}

/**
 * The transaction body for social_lookbook/rotation. Advances the sequence ONCE
 * per SA date, so a re-invoked or retried run on the same day gets the same
 * format and never skips one. A cold-cache null returns a value so that
 * Firebase re-runs against the server's real one (the trap social-budget.cjs
 * documents). Pure.
 */
function advanceRotation(cur, saDate, formats) {
  if (!formats || !formats.length) return undefined;
  if (cur && cur.lastDate === saDate) return undefined;   // already advanced today
  const prev = cur && Number.isInteger(cur.seq) && cur.seq >= 0 ? cur.seq : -1;
  const seq = prev + 1;
  return { seq, lastDate: saDate, format: formats[seq % formats.length] };
}

/** The format the rotation gives a sequence number. Pure. */
function formatForSeq(seq, formats) {
  if (!formats || !formats.length || !Number.isInteger(seq) || seq < 0) return null;
  return formats[seq % formats.length];
}

/**
 * The next `days` days of the still, from the stored rotation. A day that has
 * already advanced keeps its format, and each later day takes the next one. Pure.
 */
function stillCalendar(rotation, todayDate, formats, days = 7) {
  const out = [];
  const advancedToday = rotation && rotation.lastDate === todayDate;
  const lastSeq = rotation && Number.isInteger(rotation.seq) ? rotation.seq : -1;
  const start = new Date(`${todayDate}T00:00:00Z`).getTime();
  for (let i = 0; i < days; i++) {
    const date = new Date(start + i * 86400000).toISOString().slice(0, 10);
    const seq = advancedToday ? lastSeq + i : lastSeq + 1 + i;
    out.push({ date, format: formatForSeq(seq, formats) });
  }
  return out;
}

// ── THE HERO PROMPT ──────────────────────────────────────────────────────────
// The picture is the ONLY thing the model makes. Type, prices, the wordmark,
// the badge, the panel and the leader lines are all drawn in code. The
// composition is pinned so the category anchors land on the body.
function buildHeroPrompt(rows) {
  const garments = (rows || []).map((r, i) =>
    `- ${SLOT_BY_KEY.get(r.slot).label.toUpperCase()}: ${r.displayName} — exactly as in REFERENCE ${i + 1}`).join("\n");
  return [
    "Editorial fashion photograph, portrait orientation.",
    "A male model, full length, head to toe in frame, standing upright and relaxed, facing the camera at a slight three-quarter angle, arms loose at his sides.",
    "Composition: the model's body is centred at about 58% of the frame width (slightly right of centre); the top of his head is about 12% below the top edge and his shoes rest on the paving about 15% above the bottom edge, with open paving below them. Nothing crops him.",
    "Location: he stands on large pale stone paving slabs in a lush garden — tall palm trees and dense tropical greenery behind him, a weathered stone bench to one side.",
    "Light: soft overcast daylight, no hard shadows. Grade: muted, editorial, slightly desaturated greens, natural skin tones.",
    "He wears the complete outfit below, every garment reproduced faithfully from its attached reference photo — same colour, fabric, cut, graphics and logos as the real item:",
    garments,
    "Any item not listed is plain and unbranded (or absent).",
    "Keep the upper-left of the frame calm and uncluttered — soft foliage and sky only — and the bottom 15% plain paving.",
    "No text, no logos other than those on the garments, no captions, no watermark. No lettering, signage, numbers, borders, frames or graphic overlays of any kind.",
  ].join("\n");
}

// ── THE NO-TEXT CHECK ────────────────────────────────────────────────────────
// One vision call on the finished hero. It answers two questions: is there any
// lettering that is NOT printed on the clothing (a caption, a watermark, a
// sign, numbers, a frame)? And roughly where is each listed item? The second
// answer places the dots. The first is the gate.
const WHERE = {
  hat: "the hat itself, on the head",
  jacket: "the outer layer (jacket, hoodie or sweater), on the chest or upper arm",
  tee: "the top worn under or as the main layer, at the middle of the torso",
  bottoms: "the trousers, jeans or shorts, on the thigh",
  bag: "the BODY of the bag (not its strap, not the hand)",
  sneakers: "the shoes, on the nearer shoe",
};
function buildHeroCheckPrompt() {
  return [
    "You are checking an AI-generated fashion photograph before it is published.",
    "Does the image contain ANY text, letters, numbers, captions, watermarks, signatures, signage or graphic overlays that are NOT physically printed or embroidered on the model's clothing, shoes, hat or bag? Brand logos and wordmarks ON the garments do not count. Everything else counts, however small.",
    "Answer with ONLY a JSON object, no prose:",
    '{"text_found": true|false, "text_seen": "what you saw, or empty"}',
  ].join("\n");
}

// ── WHERE EACH GARMENT IS: A LABELLED GRID, NOT RAW NUMBERS ─────────────────
// Asked for x/y fractions, the vision model put the same beanie at y 0.12,
// 0.21 and 0.17 on three looks at one picture. Asked for a CELL on a grid
// drawn over a copy of the picture, it answers what it can see. The grid copy
// is used for this question only. The text check above looks at the clean
// picture, so the grid's own labels can never fail it.
const GRID = { cols: 12, rows: 20 };
const COL_LETTERS = "ABCDEFGHIJKL";
function buildLocatePrompt(rows) {
  const items = (rows || []).map((r) => `"${r.slot}": ${WHERE[r.slot]}`).join("; ");
  return [
    `This photograph has a grid drawn over it: columns ${COL_LETTERS[0]}–${COL_LETTERS[GRID.cols - 1]} from left to right, rows 1–${GRID.rows} from top to bottom, labelled on the edges.`,
    `For each item the model is wearing, name the ONE grid cell that contains its visual centre. Items: ${items}. Also "head": the centre of the model's face.`,
    "Use null for anything you cannot see. Answer with ONLY a JSON object, no prose:",
    '{"head": "F5", "items": {"<slot>": "G9" | null}}',
  ].join("\n");
}

/** "G9" → the cell's centre as fractions, or null. Pure. */
function cellCentre(cell) {
  const m = /^\s*([A-Za-z])\s*(\d{1,2})\s*$/.exec(String(cell || ""));
  if (!m) return null;
  const c = COL_LETTERS.indexOf(m[1].toUpperCase()), r = Number(m[2]) - 1;
  if (c < 0 || r < 0 || r >= GRID.rows) return null;
  return { x: (c + 0.5) / GRID.cols, y: (r + 0.5) / GRID.rows };
}

/** The locate answer → { anchors, head }. Anything unreadable is simply absent. Pure. */
function readLocate(text, rows) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  let v = {};
  if (a !== -1 && b > a) { try { v = JSON.parse(s.slice(a, b + 1)); } catch { v = {}; } }
  const anchors = {};
  const items = v.items && typeof v.items === "object" ? v.items : {};
  for (const r of rows || []) {
    const p = cellCentre(items[r.slot]);
    if (p) anchors[r.slot] = p;
  }
  const head = cellCentre(v.head);
  return { anchors, head: head && head.y < 0.5 ? head : null };
}

/**
 * The text check's answer, read strictly. Anything that cannot be read FAILS
 * the gate: "I could not tell whether there was text" is not a pass. Pure.
 * @returns { ok, hasText, seen, reason }
 */
function readHeroCheck(text) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a === -1 || b <= a) return { ok: false, hasText: true, seen: "", reason: "the text check gave no JSON answer" };
  let v;
  try { v = JSON.parse(s.slice(a, b + 1)); } catch { return { ok: false, hasText: true, seen: "", reason: "the text check answer was not valid JSON" }; }
  if (typeof v.text_found !== "boolean") return { ok: false, hasText: true, seen: "", reason: "the text check did not say whether text was found" };
  const seen = typeof v.text_seen === "string" ? v.text_seen.slice(0, 200) : "";
  return v.text_found
    ? { ok: false, hasText: true, seen, reason: `the hero contains text${seen ? `: ${seen}` : ""}` }
    : { ok: true, hasText: false, seen, reason: null };
}

/**
 * Where each row's leader line starts on the model. The vision position is
 * used when it is plausible for the slot (a hat in the top third, shoes in the
 * bottom quarter, and so on). Otherwise the slot's fixed anchor is used. Pure.
 */
const PLAUSIBLE_Y = {
  hat: [0.02, 0.25], jacket: [0.15, 0.5], tee: [0.18, 0.55],
  bottoms: [0.4, 0.75], bag: [0.3, 0.8], sneakers: [0.65, 0.95],
};
function anchorsFor(rows, visionAnchors = {}, head = null) {
  const out = {};
  // A hat is on the head.
  // On the first real poster the face was located to the cell every time and
  // the beanie wandered a cell above or below it, so a hat more than 0.03 from
  // "0.04 above the face" is put there.
  const HAT_ABOVE_FACE = 0.04;
  if (head && visionAnchors && visionAnchors.hat && Math.abs(visionAnchors.hat.y - (head.y - HAT_ABOVE_FACE)) > 0.03) {
    visionAnchors = { ...visionAnchors, hat: { x: head.x, y: Math.max(0.02, head.y - HAT_ABOVE_FACE) } };
  }
  // The category spots are a TEMPLATE of a body from head (y 0.16) to feet
  // (y 0.82) centred at x 0.58, the composition the prompt asks for. The model
  // does not always stand there (the first real hero put him ~10% lower), so
  // when the head is known the template is stretched onto the real body: head
  // to the vision feet, or to the same body height below the head.
  const T_HEAD = 0.16, T_FEET = SLOT_BY_KEY.get("sneakers").anchor.y, T_X = 0.58;
  const feetV = visionAnchors && visionAnchors.sneakers;
  const place = (fixed) => {
    if (!head) return fixed;
    const feet = feetV && feetV.y > head.y + 0.3 ? feetV.y : Math.min(0.97, head.y + (T_FEET - T_HEAD));
    const k = (feet - head.y) / (T_FEET - T_HEAD);
    return { x: Math.min(0.98, Math.max(0.08, fixed.x + (head.x - T_X))), y: head.y + (fixed.y - T_HEAD) * k };
  };
  // Two items answered with the same spot (the vest "found" on the bag that
  // covers it, spec review L13): the bag keeps it, the other item goes to its
  // place on the body.
  const near = (a, b) => a && b && Math.hypot(a.x - b.x, a.y - b.y) < 0.09;   // the same or a neighbouring grid cell
  const bagV = visionAnchors && visionAnchors.bag;
  for (const r of rows || []) {
    const fixed = place(SLOT_BY_KEY.get(r.slot).anchor);
    let v = visionAnchors && visionAnchors[r.slot];
    if (r.slot !== "bag" && near(v, bagV)) v = null;
    const band = PLAUSIBLE_Y[r.slot];
    out[r.slot] = v && v.y >= band[0] && v.y <= band[1] && v.x >= 0.08 && v.x <= 0.98
      ? { x: v.x, y: v.y, source: "vision" }
      : { x: fixed.x, y: fixed.y, source: head ? "body" : "category" };
  }
  return out;
}

module.exports = {
  LOOKBOOK_SLOTS, SLOT_KEYS, MIN_ROWS, HISTORY_DEPTH, READS_PER_SLOT,
  STILL_FORMAT_KEYS, DEFAULT_STILL_FORMATS,
  lookbookSlot, guessSlot, priceOf, formatRand, approvedPhoto, resolveRow,
  recentLookbookPids, pickLookbookOutfit, historyEntry,
  parseStillFormats, advanceRotation, formatForSeq, stillCalendar,
  buildHeroPrompt, buildHeroCheckPrompt, readHeroCheck, anchorsFor,
  GRID, buildLocatePrompt, cellCentre, readLocate,
};
