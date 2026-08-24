// ─── SOCIAL — WHAT IS WORTH POSTING, AND WHAT MUST NEVER BE ──────────────────
// Pure selection logic for the social generator. No I/O, no Firebase, no
// network — the caller (generateSocialPosts in functions/index.js) does every
// read and hands the values in, so every rule below is node-testable against
// hand-built fixtures and against real production shapes.
//
// ── THE TWO HARD REFUSALS ────────────────────────────────────────────────────
// The brief names two things that must never happen, and they are enforced
// here as filters that run BEFORE any ranking, not as tie-breakers inside it:
//
//   NOT ON THE STOREFRONT — a candidate must have /shopify_publish state
//     "live" AND liveState "on". Those are the reconciler's CONFIRMED fields,
//     written only after Shopify agreed; `desiredState` is an intent and is
//     deliberately ignored. Posting a link to a product that is still
//     "publishing…" is posting a 404.
//
//   OUT OF STOCK — network availability must be > 0, summed exactly the way
//     the storefront's own inventory push sums it: every /stock location
//     except in_transit, negative cells clamped to zero. The clamp is the
//     app's long-standing convention (a negative cell is a bookkeeping
//     artefact, never sellable) and matching scripts/shopify/inventory.mjs
//     matters more than the number itself: if this file and the inventory
//     push disagreed, we would advertise stock the shop refuses to sell.
//
// Neither refusal is a score of zero. A scored-zero candidate reappears the
// moment the weights are retuned; a filtered one cannot.
//
// ── WHAT MAKES SOMETHING WORTH POSTING ───────────────────────────────────────
// Two real signals, and no invented ones:
//
//   WHAT SELLS — units rung up on the tills, per product, over the sell-through
//     window. The tills are the only honest evidence the shop has: the
//     storefront went live weeks ago and its traffic would rank noise. Same
//     source and same counting rules as scripts/shopify/sell-through.mjs
//     (dedupe on the daily-reset order number, drop returns).
//
//   WHAT IS NEWLY LIVE — /shopify_publish liveAt, the moment the reconciler
//     last switched a product ON. Stamped by confirmLiveState, so it is a fact
//     about the storefront rather than a guess from a product id.
//
// The two are normalised independently and blended. A blend rather than a
// tie-break because the shop has both kinds of thing worth showing: a proven
// seller nobody has seen on Instagram, and a box that landed on Tuesday.
"use strict";

// KEEP IN SYNC with src/components/social/socialCore.js POST_KINDS — the
// browser prices the Generate buttons from its copy and this file decides what
// they produce. social-select.test.cjs pins the two equal, field by field.
const POST_KINDS = [
  { key: "single", label: "Single product", minProducts: 1, maxProducts: 1, generates: true, costUSD: 0.134 },
  { key: "flatlay", label: "Flat-lay", minProducts: 3, maxProducts: 5, generates: true, costUSD: 0.134 },
  { key: "new_arrivals", label: "New arrivals", minProducts: 2, maxProducts: 10, generates: false, costUSD: 0.0004 },
  { key: "outfit", label: "Full outfit", minProducts: 3, maxProducts: 5, generates: true, costUSD: 0.134 },
];
const KIND_KEYS = POST_KINDS.map((k) => k.key);

// /stock/in_transit is not sellable — boxes that left their source and have
// not landed, count-integrity holds included. Copied from
// scripts/shopify/inventory.mjs UNSELLABLE_LOCATIONS, and pinned to it by test:
// the two must agree or the storefront and the social engine would disagree
// about what the shop has.
const UNSELLABLE_LOCATIONS = new Set(["in_transit"]);

// How long after a product appears in a post before it may appear in another.
// Not a rule anybody asked for — a decision, made because a queue that
// proposes the same three best-sellers every week is a queue Junid stops
// reading. 45 days is roughly six posting weeks at three a week.
const REPOST_COOLDOWN_DAYS = 45;

// The blend. Sales lead because they are the strongest evidence the shop has;
// newness is a real signal but a thinner one (a product can be new and dull).
const W_SALES = 0.62;
const W_NEW = 0.38;
// Anything switched on within this many days counts as "new" at full strength;
// beyond it the newness term decays linearly to zero at NEW_ZERO_DAYS.
const NEW_FULL_DAYS = 10;
const NEW_ZERO_DAYS = 60;

const DAY_MS = 86400000;

/**
 * The stored /stock key for a catalogue size. Mirror of stockSizeKey in
 * src/utils/sizeKey.js — the ESM module cannot be required from this CJS file,
 * and socialSizeKey.diff.test.js pins the two across a table including the
 * awkward ones ("Free Size", "5.5", " 8", null).
 *
 * "Free Size" collapsing to "_" is not cosmetic: the one-size work left real
 * products carrying BOTH a "_" cell and a "Free_Size" cell, and only "_" is
 * the one the storefront sells from.
 */
function stockSizeKey(size) {
  if (size == null || size === "" || size === "Free Size") return "_";
  const s = typeof size === "number" ? String(size) : size;
  if (typeof s !== "string") return s;
  // The character class is ILLEGAL_RTDB_CHARS from src/utils/sizeKey.js,
  // verbatim: . # $ [ ] / AND WHITESPACE. The whitespace was missing in the
  // first version of this mirror, so "one size" encoded to "one size" here and
  // "one_size" there — a randomised differential caught it on its first
  // iteration. Real sizes with spaces are common ("one size", " 8" from a
  // padded import), so this was not a corner case.
  return s.replace(/[.#$[\]/\s]/g, "_");
}

/**
 * Network availability for one product, in units.
 *
 * `stockByLocation` is { location: { sizeKey: cell } } for THIS product only —
 * the caller fetches /stock/{loc}/{pid} per active location rather than
 * reading the /stock node, so this never becomes a whole-node read. A cell is
 * the movement-stamped object applyMovement writes; a bare number is tolerated
 * for old data, exactly as inventory.mjs tolerates it.
 *
 * ── `sizes` IS NOT OPTIONAL DECORATION ──────────────────────────────────────
 * It is the product record's own size list, and cells whose key is not in it
 * are NOT COUNTED — the same `if (!(key in totals)) continue` that
 * scripts/shopify/inventory.mjs networkTotals applies before pushing
 * availability to Shopify.
 *
 * An earlier version summed every cell, and the header claimed it matched the
 * inventory push. It did not, and the divergence always ran the dangerous way:
 * social saw MORE stock than the storefront would sell. The live case is the
 * documented phantom cell — a product whose sizes are ["Free Size"] has its
 * sellable stock under "_", but a stray "Free_Size" cell may also hold units.
 * Shopify pushes 0 and shows sold out; the generator saw 3 and posted a link
 * to a sold-out page.
 *
 * A product with no usable size list therefore has no countable stock, which
 * is the same answer Shopify gives it: no sizes means no variants means
 * nothing to sell.
 */
function availableUnits(stockByLocation, sizes) {
  const totals = {};
  for (const size of Array.isArray(sizes) ? sizes : []) totals[stockSizeKey(size)] = 0;
  if (!Object.keys(totals).length) return 0;
  for (const [loc, cells] of Object.entries(stockByLocation || {})) {
    if (UNSELLABLE_LOCATIONS.has(loc)) continue;
    if (!cells || typeof cells !== "object") continue;
    for (const [key, cell] of Object.entries(cells)) {
      if (!(key in totals)) continue;   // sizes not in the record don't ship
      const qty = cell !== null && typeof cell === "object" ? cell.qty : cell;
      totals[key] += Math.max(0, Number(qty) || 0);
    }
  }
  return Object.values(totals).reduce((a, b) => a + b, 0);
}

/**
 * The handle the storefront actually serves for this product.
 *
 * The reconciler sets Shopify's handle EXPLICITLY from the clean listing title
 * (scripts/shopify/compliance.mjs buildHandle) rather than letting Shopify
 * derive one, so the same transform applied to the same cleanName reproduces
 * the live URL. This is a deliberate duplicate of that function — the scripts
 * are ESM and this file is required by a CJS Cloud Function — and
 * social-select.test.cjs pins the two byte-for-byte across a table of awkward
 * titles. If they ever diverge, every caption links to a 404, so the test is
 * the load-bearing part, not the copy.
 */
function productHandle(cleanName) {
  return String(cleanName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── OUTFIT SLOTS ─────────────────────────────────────────────────────────────
// Grounded in the LIVE catalogue, not in guesses: the categoryKey values below
// were counted against the 582 products that were live and on 2026-08-22.
// `category` is the fallback for the 14 live records that carry no
// categoryKey at all.
const SLOT_MATCHERS = [
  {
    slot: "shoe",
    // designer-shoes was missing and is a real live key.
    keys: new Set(["sneakers", "slides", "soccer-boots", "boots", "designer-shoes"]),
    categories: new Set(["Footwear"]),
  },
  {
    slot: "top",
    keys: new Set(["t-shirts", "golf-t-shirts", "hoodies", "jackets", "soccer-jerseys", "tracksuits"]),
    // Deliberately NOT the whole Clothing category: pants, shorts and dresses
    // are clothing and none of them is a top.
    categories: new Set(),
  },
  {
    // ── THE SLOT THAT DID NOT EXIST ────────────────────────────────────────
    // There was no bottom slot at all, so no outfit this engine has ever built
    // could contain trousers. 38 pants and 4 shorts were live and structurally
    // unreachable, which is the main reason the "outfits" did not read as
    // looks: a top and a shoe is not something a person wears.
    slot: "bottom",
    keys: new Set(["pants", "shorts", "jeans"]),
    categories: new Set(),
  },
  {
    slot: "cap",
    keys: new Set(["caps-beanies", "fitted-caps", "visors"]),
    categories: new Set(),
  },
  {
    slot: "bag",
    keys: new Set(["bags"]),
    categories: new Set(),
  },
  {
    slot: "fragrance",
    keys: new Set(["perfumes"]),
    categories: new Set(["Perfume"]),
  },
];

// ── WHAT MAKES A LOOK, RATHER THAN A PILE ────────────────────────────────────
// An outfit needs something on top, something on the legs and something on the
// feet. cap, bag and fragrance are finishing pieces: welcome, never sufficient.
const OUTFIT_CORE = ["top", "bottom", "shoe"];

// A tracksuit IS the top and the bottom. Requiring a separate pair of trousers
// beside one would be a styling error, not a completeness check — so it
// satisfies both, and no bottom is added next to it.
const FULL_BODY_KEYS = new Set(["tracksuits", "dresses"]);
const isFullBody = (product) =>
  FULL_BODY_KEYS.has(String(product?.categoryKey || "").toLowerCase());

const OUTFIT_SLOTS = SLOT_MATCHERS.map((m) => m.slot);

/** Which outfit slot a product fills, or null when it fills none. */
function outfitSlot(product) {
  const key = String(product?.categoryKey || "").toLowerCase();
  const cat = String(product?.category || "");
  for (const m of SLOT_MATCHERS) {
    if (key && m.keys.has(key)) return m.slot;
  }
  for (const m of SLOT_MATCHERS) {
    if (m.categories.has(cat)) return m.slot;
  }
  return null;
}

/**
 * Build the scored, filtered candidate list.
 *
 * @param liveNodes    { pid: /shopify_publish node } — the caller's indexed
 *                     state=="live" query result. liveState is re-checked here.
 * @param products     { pid: /products record }
 * @param stockByPid   { pid: { location: { sizeKey: cell } } }
 * @param salesByPid   { pid: units } over the sell-through window
 * @param postedAtByPid { pid: epoch ms of the last post that used it }
 * @param nowMs
 * @returns [{ pid, product, node, name, handle, link, photoUrl, units, available,
 *             slot, liveAt, score }] sorted best first
 */
function buildCandidates({ liveNodes, products, stockByPid, salesByPid = {}, postedAtByPid = {}, nowMs = Date.now(), storefront = "https://marathonclub.co.za" }) {
  const rows = [];
  for (const [pid, node] of Object.entries(liveNodes || {})) {
    // ── REFUSAL 1: not on the storefront ───────────────────────────────────
    if (!node || node.state !== "live" || node.liveState !== "on") continue;
    const product = (products || {})[pid];
    if (!product) continue;

    // A post needs a photograph. The publishing set wins when the product has
    // one (that is what the storefront leads with); otherwise the record's
    // hero. A product with neither cannot be posted, and is not a failure to
    // report — it is simply not a candidate.
    const photos = Array.isArray(node.photos) ? node.photos.filter((u) => typeof u === "string" && u.trim()) : [];
    const photoUrl = photos[0] || product.photoUrl;
    if (!photoUrl) continue;

    // ── TWO NAMES, AND THEY ARE NOT INTERCHANGEABLE ────────────────────────
    // `name` is the STOREFRONT title from shopify_publish/{pid}/cleanName. It
    // is deliberately brand-stripped, because the payment gateway keyword-scans
    // the Shopify catalogue, and it is what the product handle and therefore
    // the product URL are derived from. It must not change.
    //
    // `displayName` is the TRUE product name from products/{pid}/name — "Nike
    // Air Force 1 Cream Black Grey" where the storefront says "Sneaker Cream
    // Black Grey", "Lacoste L12 100ML" where it says "Fragrance 100ML". Owner
    // ruling 2026-08-23: the stripping rule exists for the gateway scanning
    // Shopify, and that does not reach Instagram. Captions and on-image labels
    // use the real name; a caption that cannot say "Lacoste" is a caption that
    // cannot sell a Lacoste polo.
    //
    // Nothing that reaches Shopify uses displayName. handle and link below stay
    // derived from `name`, so storefront URLs are untouched.
    const name = typeof node.cleanName === "string" && node.cleanName.trim() ? node.cleanName.trim() : null;
    if (!name) continue;
    const trueName = typeof product.name === "string" && product.name.trim() ? product.name.trim() : null;
    const displayName = trueName || name;

    // ── REFUSAL 2: out of stock ────────────────────────────────────────────
    const available = availableUnits((stockByPid || {})[pid], product.sizes);
    if (available <= 0) continue;

    // ── COOLDOWN ───────────────────────────────────────────────────────────
    const lastPosted = Number((postedAtByPid || {})[pid]);
    if (Number.isFinite(lastPosted) && nowMs - lastPosted < REPOST_COOLDOWN_DAYS * DAY_MS) continue;

    const handle = productHandle(name);
    rows.push({
      pid,
      product,
      node,
      name,
      displayName,
      handle,
      link: handle ? `${storefront}/products/${handle}` : storefront,
      photoUrl,
      photos: photos.length ? photos : [product.photoUrl].filter(Boolean),
      units: Math.max(0, Number((salesByPid || {})[pid]) || 0),
      available,
      slot: outfitSlot(product),
      liveAt: Number(node.liveAt) || 0,
      retailPrice: Number(product.retailPrice) || null,
      category: product.category || null,
      categoryKey: product.categoryKey || null,
      productType: product.productType || null,
      score: 0,
    });
  }

  // ── NORMALISE ──────────────────────────────────────────────────────────────
  // Sales are normalised against the best seller IN THIS CANDIDATE SET, not
  // against the catalogue: the comparison that matters is "of the things I
  // could post today, which moves best".
  const maxUnits = rows.reduce((m, r) => Math.max(m, r.units), 0);
  for (const r of rows) {
    const salesNorm = maxUnits > 0 ? r.units / maxUnits : 0;
    const ageDays = r.liveAt > 0 ? (nowMs - r.liveAt) / DAY_MS : Infinity;
    const newNorm = !Number.isFinite(ageDays)
      ? 0
      : ageDays <= NEW_FULL_DAYS
        ? 1
        : ageDays >= NEW_ZERO_DAYS
          ? 0
          : 1 - (ageDays - NEW_FULL_DAYS) / (NEW_ZERO_DAYS - NEW_FULL_DAYS);
    r.salesNorm = salesNorm;
    r.newNorm = newNorm;
    r.score = W_SALES * salesNorm + W_NEW * newNorm;
  }

  // Ties break on pid so a run is reproducible — two products with identical
  // signal must not swap places between two runs of the same generator.
  rows.sort((a, b) => b.score - a.score || (a.pid < b.pid ? -1 : 1));
  return rows;
}

/**
 * Choose the products for ONE post of the given kind.
 * Returns { picks, reason } — `picks` empty and `reason` set when the kind
 * cannot be filled. A kind that cannot be filled is reported, never silently
 * downgraded to a different kind.
 *
 * `used` is the set of pids already spoken for by earlier posts in the same
 * run, so one generation of four posts does not put the same sneaker in three
 * of them.
 */
function pickForKind(kind, candidates, { used = new Set(), count = null } = {}) {
  const spec = POST_KINDS.find((k) => k.key === kind);
  if (!spec) return { picks: [], reason: `unknown post type "${kind}"` };
  const pool = candidates.filter((c) => !used.has(c.pid));

  if (kind === "new_arrivals") {
    // Purely newest-first, and ONLY things that are genuinely new — a
    // "new arrivals" post assembled from the newest of a stale catalogue is a
    // lie, so a product with no liveAt or one older than NEW_ZERO_DAYS is not
    // eligible however well it sells.
    const fresh = pool
      .filter((c) => c.newNorm > 0)
      .sort((a, b) => b.liveAt - a.liveAt || (a.pid < b.pid ? -1 : 1));
    const want = Math.min(count || spec.maxProducts, spec.maxProducts);
    if (fresh.length < spec.minProducts) {
      return { picks: [], reason: `only ${fresh.length} product(s) went live recently — a new-arrivals post needs ${spec.minProducts}` };
    }
    return { picks: fresh.slice(0, want), reason: null };
  }

  if (kind === "outfit") {
    // ── BUILD A LOOK, NOT A SHORTLIST ──────────────────────────────────────
    // Previously: one product per slot, best-scoring first, accepted down to
    // minProducts (2). With only four slots and no bottom among them, that
    // produced "outfits" of a t-shirt and a pair of shoes — which is not a
    // thing anyone wears, and is what the owner meant by the styling being
    // wrong.
    //
    // Now an outfit must cover the CORE: something on top, something on the
    // legs, something on the feet. A tracksuit satisfies top and bottom by
    // itself, so no trousers are added beside one.
    const picks = [];
    const taken = new Set(used);
    const take = (slot) => {
      const best = pool.find((c) => c.slot === slot && !taken.has(c.pid));
      if (best) { picks.push(best); taken.add(best.pid); }
      return best || null;
    };

    const top = take("top");
    const fullBody = top && isFullBody(top.product);
    if (!fullBody) take("bottom");
    take("shoe");

    // Finishing pieces, in the order a stylist would reach for them, up to the
    // kind's ceiling. Never the reason a post exists.
    for (const slot of ["cap", "bag", "fragrance"]) {
      if (picks.length >= spec.maxProducts) break;
      take(slot);
    }

    const covered = new Set(picks.map((p) => p.slot));
    const missingCore = OUTFIT_CORE.filter((s) => {
      if (s === "bottom" && fullBody) return false;   // the tracksuit is the bottom
      return !covered.has(s);
    });
    if (missingCore.length) {
      return { picks: [], reason: `not enough of an outfit in live stock — nothing available for: ${missingCore.join(", ")}` };

    }
    return { picks, reason: null };
  }

  // single + flatlay: straight down the ranking.
  const want = Math.min(count || spec.maxProducts, spec.maxProducts);
  if (pool.length < spec.minProducts) {
    return { picks: [], reason: `only ${pool.length} product(s) are live, in stock and off cooldown — this post type needs ${spec.minProducts}` };
  }
  if (kind === "flatlay") {
    // A flat-lay of five sneakers is a photograph of a shoe rack. Spread
    // across categories where the pool allows it, then top up from the
    // ranking so a thin catalogue still produces a post.
    const bySlot = new Map();
    for (const c of pool) {
      const k = c.categoryKey || c.category || "other";
      if (!bySlot.has(k)) bySlot.set(k, c);
      if (bySlot.size >= want) break;
    }
    const picks = [...bySlot.values()];
    for (const c of pool) {
      if (picks.length >= want) break;
      if (!picks.includes(c)) picks.push(c);
    }
    return { picks: picks.slice(0, want), reason: null };
  }
  return { picks: pool.slice(0, want), reason: null };
}

module.exports = {
  OUTFIT_CORE, isFullBody,
  POST_KINDS, KIND_KEYS, OUTFIT_SLOTS, UNSELLABLE_LOCATIONS,
  REPOST_COOLDOWN_DAYS, W_SALES, W_NEW, NEW_FULL_DAYS, NEW_ZERO_DAYS,
  availableUnits, stockSizeKey, productHandle, outfitSlot, buildCandidates, pickForKind,
};
