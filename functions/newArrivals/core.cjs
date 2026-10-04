// ─── NEW ARRIVALS — THE QUEUE'S PURE CORE ────────────────────────────────────
// One record per uploaded product at /new_arrivals/items/{pid}, plus a small
// per-status index at /new_arrivals/by_status/{status}/{pid} = enqueuedAt.
//
// THE ITEM IS THE TRUTH; THE INDEX IS A HINT. Every move is a transaction on
// the item that checks the status it is moving FROM, followed by an index
// update. If the second write is lost, the reader that finds an index entry
// whose item says otherwise repairs it (indexRepair) — so a crash between the
// two writes can delay an item, never mis-route it.
//
// WHY AN INDEX AT ALL: the card and the Mac mini agents must never read a
// whole node. by_status/new is a handful of keys; /products is the catalogue.
// No query on /new_arrivals needs an .indexOn rule — every read here is a
// child path or orderByKey — so database.rules.json is untouched.
//
// Statuses (lanes), and the card tab each one shows under:
//   new, generating, ready, rejected → New  (ONE place to generate and approve,
//                                     3 Oct night: the lanes stay in the data as
//                                     the checker's state and the poster's work
//                                     queue, but never move an item between tabs
//                                     or hide it; the card orders them photo
//                                     ready → generating → no photo yet)
//   approved, chaining, done   → Done      (Junid tapped Approve; where it went, and when)
//   skipped                    → Skipped   (Junid: "don't advertise" — never generated,
//                                            posted or published; only Restore brings it back)
//
// CALIBRATION (owner, 3 Oct; contract ~/.marathon-group-poster/work/calibration-contract.md):
// nothing is generated automatically. Junid taps Generate on the card, which
// sets items/{pid}.generateRequest; the poster takes it, generates ONCE and
// puts the result on the same card (lane ready / rejected) with the checker's
// verdict as a LABEL only. Every
// action Junid takes is logged to new_arrivals/decisions/{push} by the
// callables here (decisionRecord), with a snapshot of the generation it was
// taken on.
"use strict";

const { availableUnits, stockSizeKey, ONLINE_EXCLUDED_LOCATIONS } = require("../lib/social-select.cjs");
const sourcePhoto = require("./sourcePhoto.cjs");

const ROOT = "new_arrivals";
const ITEMS = `${ROOT}/items`;
const BY_STATUS = `${ROOT}/by_status`;

const DECISIONS = `${ROOT}/decisions`;

const STATUSES = Object.freeze(["new", "generating", "ready", "rejected", "approved", "chaining", "done", "skipped"]);
const TAB_OF = Object.freeze({
  new: "new", generating: "new", ready: "new", rejected: "new",
  approved: "done", chaining: "done", done: "done", skipped: "skipped",
});
const TABS = Object.freeze(["new", "done", "skipped"]);
const STATUSES_IN_TAB = Object.freeze(TABS.reduce((acc, t) => {
  acc[t] = STATUSES.filter((s) => TAB_OF[s] === t);
  return acc;
}, {}));
// The lanes the New tab merges — where Junid generates and approves.
const NEW_LANES = Object.freeze(STATUSES_IN_TAB.new);
// An older card bundle still asks for the Ready / Rejected tabs: both are New now.
const LEGACY_TABS = Object.freeze({ ready: "new", rejected: "new" });
/** The tab a request means (an old bundle's "ready"/"rejected" → "new"), or null. Pure. */
function normalizeTab(t) {
  const k = String(t || "");
  if (TABS.includes(k)) return k;
  return LEGACY_TABS[k] || null;
}

// ── THE NEW TAB'S ORDER (owner, 3 Oct night) ─────────────────────────────────
// Within each group: items with a finished photo first ("photo ready —
// approve"), then "generating…", then items with no photo yet; within a
// bucket, key order (oldest upload first).
//   photo:      lane ready; lane rejected with a generatedUrl; any lane with
//               currentGen — and no pending request
//   generating: lane generating, or a pending request (requests/{pid})
//   none:       everything else
// A pending request wins: while it is pending the photo cannot be approved.
const BUCKETS = Object.freeze(["photo", "generating", "none"]);
/** "photo" | "generating" | "none" for one New-tab item. Pure. */
function photoBucket({ lane, requested = false, currentGen = null, generatedUrl = null } = {}) {
  if (lane === "generating" || requested) return "generating";
  if (lane === "ready" || currentGen || (lane === "rejected" && generatedUrl)) return "photo";
  return "none";
}
const bucketRank = (b) => { const i = BUCKETS.indexOf(b); return i < 0 ? BUCKETS.length : i; };
/** Compare two pids by (bucket, key). `bucketOf` maps pid → bucket. Pure. */
/** "<rank>:<pid>" → { rank, pid }, or null for any other cursor. Pure. */
function parseBucketCursor(cursor) {
  const m = /^(\d):(.+)$/.exec(String(cursor || ""));
  return m && PID_RE.test(m[2]) ? { rank: Number(m[1]), pid: m[2] } : null;
}

function bucketCmp(bucketOf) {
  return (a, b) => bucketRank(bucketOf(a)) - bucketRank(bucketOf(b)) || keyCmp(a, b);
}

// The upload path stamps createdBy.at with serverNowMs() at save time. A
// product created by anything else (a merge, an import, a restore script)
// carries no createdBy and is not a new arrival. The window absorbs a slow
// trigger delivery; the negative slack absorbs client/server clock skew.
const ENQUEUE_WINDOW_MS = 15 * 60 * 1000;
const ENQUEUE_SKEW_MS = 5 * 60 * 1000;
const PRICE_RECORD_CATEGORY = "Price Products"; // src/utils/productCategory.js PRICE_RECORD_CATEGORY

const PID_RE = /^p\d{10,}$/;

function enqueueDecision(pid, product, nowMs) {
  if (!PID_RE.test(String(pid || ""))) return { ok: false, why: "not an uploaded product id" };
  if (!product || typeof product !== "object") return { ok: false, why: "no record" };
  if (product.mergedInto) return { ok: false, why: "merged record" };
  if (product.category === PRICE_RECORD_CATEGORY) return { ok: false, why: "price record" };
  // THE MARKER the upload form writes (addProductOnce: newArrivalAt). Explicit,
  // so no time window applies — a late trigger delivery still queues it.
  if (Number.isFinite(Number(product.newArrivalAt)) && Number(product.newArrivalAt) > 0) return { ok: true };
  // Fallback for devices still running the previous bundle (no marker yet):
  // the upload form's own createdBy stamp, if fresh.
  const at = Number(product.createdBy && product.createdBy.at);
  if (!Number.isFinite(at)) return { ok: false, why: "not created by the upload form" };
  if (nowMs - at > ENQUEUE_WINDOW_MS) return { ok: false, why: "created too long ago to be a new upload" };
  if (at - nowMs > ENQUEUE_SKEW_MS) return { ok: false, why: "creation stamp is in the future" };
  if (product.mergedInto) return { ok: false, why: "merged record" };
  if (product.category === PRICE_RECORD_CATEGORY) return { ok: false, why: "price record" };
  return { ok: true };
}

function buildItem(pid, product, at) {
  const item = {
    pid,
    status: "new",
    enqueuedAt: at,
    statusAt: at,
    name: String(product.name || "").slice(0, 200),
    attempts: 0,
    attemptsSinceRetry: 0,
  };
  // Optional fields are OMITTED, never written as undefined (the SDK throws on
  // undefined, and null would just be dropped).
  if (product.categoryKey) item.categoryKey = String(product.categoryKey);
  // NO photo is copied onto the item: the product's photo is read live every
  // time (sourcePhoto.cjs). A copy made here went stale the moment the photo
  // was replaced in admin — the card, the generator and the chain all kept
  // using the old one.
  return item;
}

/**
 * A transaction mutator that moves an item from one of `from` to `to`.
 * `fields` are merged into the item; a field set to null is removed, exactly
 * as RTDB would.
 *
 * THE COLD-CACHE TRAP: the SDK's first call passes null even when the item
 * exists. Aborting there would refuse every move made from a cold process, so
 * a null `cur` returns null — the server's compare-and-retry then supplies the
 * real value. If the item truly is absent, null commits as a no-op. Either
 * way the caller decides by `moved(res, to)`, never by `committed` alone.
 * A present item in the wrong status aborts (undefined) with `out.refusal`.
 */
function moveMutator({ from, to, fields = {}, at }, out = {}) {
  if (!STATUSES.includes(to)) throw new Error(`unknown status ${to}`);
  const allowed = Array.isArray(from) ? from : [from];
  return (cur) => {
    if (!cur) { out.refusal = "not in the New Arrivals queue"; return null; }
    if (!allowed.includes(cur.status)) { out.refusal = `it is ${cur.status}, not ${allowed.join(" or ")}`; return undefined; }
    out.refusal = null;
    out.from = cur.status;
    const next = { ...cur, ...fields, status: to, statusAt: at };
    for (const [k, v] of Object.entries(next)) if (v === null || v === undefined) delete next[k];
    return next;
  };
}

/** Did a moveMutator transaction actually land the item in `to`? */
function moved(res, to) {
  if (!res || !res.committed) return null;
  const v = res.snapshot && res.snapshot.val();
  return v && v.status === to ? v : null;
}

/** The index writes that follow a committed move: one multi-path update at ROOT. */
function indexMove(pid, from, to, enqueuedAt) {
  const u = {};
  if (from && from !== to) u[`by_status/${from}/${pid}`] = null;
  u[`by_status/${to}/${pid}`] = Number(enqueuedAt) || 0;
  return u;
}

/**
 * The repair for an index entry that disagrees with its item. Returns the
 * multi-path update to apply at ROOT, or null if the entry is right.
 */
function indexRepair(pid, listedUnder, item) {
  if (!item) return { [`by_status/${listedUnder}/${pid}`]: null };
  if (item.status === listedUnder) return null;
  return indexMove(pid, listedUnder, item.status, item.enqueuedAt);
}

// One page of a tab. The card loads 30 at a time ("Load more" for the next).
const LIST_LIMIT_DEFAULT = 30;
const LIST_LIMIT_MAX = 100;
function listLimit(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return LIST_LIMIT_DEFAULT;
  return Math.min(v, LIST_LIMIT_MAX);
}

/** What the card needs from /products/{pid}. Price and sizes are read live. */
function productSummary(p) {
  if (!p) return null;
  const sizes = Array.isArray(p.sizes) ? p.sizes.filter((s) => s !== null && s !== undefined && s !== "")
    : (p.sizes && typeof p.sizes === "object" ? Object.values(p.sizes).filter(Boolean) : []);
  return {
    name: p.name || "",
    brand: p.brand || null,
    retailPrice: Number.isFinite(Number(p.retailPrice)) ? Number(p.retailPrice) : null,
    // Cost too: the Ready card fills BOTH missing prices through the Missing
    // prices save, so the product leaves Missing prices.
    stockPrice: Number.isFinite(Number(p.stockPrice)) ? Number(p.stockPrice) : null,
    sizes: sizes.map(String),
    photoUrl: p.photoUrl || null,
    photoUrlOriginal: p.photoUrlOriginal || null,
    // When staff last replaced the photo (human uploads only): a generation older than this was made from the photo before.
    photoUpdatedAt: Number.isFinite(Number(p.photoUpdatedAt)) && Number(p.photoUpdatedAt) > 0 ? Number(p.photoUpdatedAt) : null,
    categoryKey: p.categoryKey || null,
  };
}

// ── CLASSES ──────────────────────────────────────────────────────────────────
// Mirror of the poster's src/plates.mjs key lists (kindFor). The plate class
// is what calibration, agreement % and modes are kept per.
const FOOTWEAR_KEYS = Object.freeze(["sneakers", "running-shoes", "boots", "soccer-boots", "slides", "loafers", "kids-shoes", "designer-shoes", "sandals"]);
const TWOPIECE_KEYS = Object.freeze(["tracksuits"]);
const SINGLE_KEYS = Object.freeze(["t-shirts", "golf-t-shirts", "hoodies", "sweaters", "jackets", "pants", "jeans", "shorts",
  "cargo-pants", "basketball-vests", "baseball-shirts", "soccer-jerseys", "dresses", "underwear"]);
const CLASSES = Object.freeze(["footwear", "single", "twopiece"]);

/** "footwear" | "single" | "twopiece" | null, from a categoryKey. Pure. */
function CLASS_OF(categoryKey) {
  const k = String(categoryKey || "").trim();
  if (!k) return null;
  if (FOOTWEAR_KEYS.includes(k)) return "footwear";
  if (TWOPIECE_KEYS.includes(k)) return "twopiece";
  if (SINGLE_KEYS.includes(k)) return "single";
  return null;
}

// ── THE NEW TAB'S CATEGORY FILTER ────────────────────────────────────────────
// Junid's four chips, mapped onto the plate classes:
//   sneakers  = every footwear key EXCEPT slides and sandals (running shoes,
//               boots, soccer boots, loafers, kids' and designer shoes too —
//               they are all shot on the footwear plate as "a shoe")
//   slides    = slides + sandals
//   clothing  = the single-garment class (t-shirts … underwear)
//   twopiece  = the two-piece class (tracksuits)
// A key in none of the lists matches no chip (it still shows unfiltered).
const SLIDE_KEYS = Object.freeze(["slides", "sandals"]);
const FILTER_CLASSES = Object.freeze(["sneakers", "slides", "clothing", "twopiece"]);
function filterClassOf(categoryKey) {
  const k = String(categoryKey || "").trim();
  const cls = CLASS_OF(k);
  if (cls === "footwear") return SLIDE_KEYS.includes(k) ? "slides" : "sneakers";
  if (cls === "single") return "clothing";
  if (cls === "twopiece") return "twopiece";
  return null;
}

/** The filter the card sent, cleaned; null when it filters nothing. Pure. */
function normalizeFilter(f) {
  if (!f || typeof f !== "object") return null;
  const out = {};
  if (f.oneSize === true) out.oneSize = true;
  if (f.noStockPrice === true) out.noStockPrice = true;
  if (FILTER_CLASSES.includes(f.cls)) out.cls = f.cls;
  return Object.keys(out).length ? out : null;
}

// ── THE CARD'S TWO GROUPS (owner, 3 Oct) ─────────────────────────────────────
// The New tab (every lane in it) is split into exactly TWO groups, flipped
// with the switcher bar:
//   sneakers = all footwear (sneakers, slides, sandals, boots, …): a categoryKey
//              in FOOTWEAR_KEYS, or — with no known categoryKey — the legacy
//              category "Footwear"
//   clothing = everything else (garments, tracksuits/sets, accessories, caps,
//              bags, perfume) AND anything uncategorised: an item goes to
//              Sneakers only when it is CLEARLY footwear.
const GROUPS = Object.freeze(["sneakers", "clothing"]);
const GROUP_TABS = Object.freeze(["new"]);
const KNOWN_KEYS = new Set([...FOOTWEAR_KEYS, ...TWOPIECE_KEYS, ...SINGLE_KEYS]);
/** "sneakers" | "clothing" from a product's { categoryKey, category }. Pure. */
function groupOf(p) {
  const k = String((p && p.categoryKey) || "").trim();
  if (FOOTWEAR_KEYS.includes(k)) return "sneakers";
  if (KNOWN_KEYS.has(k)) return "clothing";
  return p && p.category === "Footwear" ? "sneakers" : "clothing";
}
const normalizeGroup = (g) => (GROUPS.includes(g) ? g : null);

/**
 * Sizes in stock and units, for ONE product, from { loc: { sizeKey: cell } }
 * read per pid (stock/{loc}/{pid}, keyed — never the /stock node).
 *
 * Counted exactly as social-select availableUnits counts (the Shopify push's
 * rule): only the record's own sizes, and never the ONLINE_EXCLUDED_LOCATIONS
 * (in_transit, and the untrusted hub3 / marathon-pine). totalUnits IS
 * availableUnits — one answer, not a second source of truth.
 * stockKnown: any counted location holds a cell node for this product.
 */
function stockSummary(sizes, stockByLocation) {
  const list = (Array.isArray(sizes) ? sizes : []).map(String);
  const perKey = {};
  for (const s of list) perKey[stockSizeKey(s)] = 0;
  let stockKnown = false;
  for (const [loc, cells] of Object.entries(stockByLocation || {})) {
    if (ONLINE_EXCLUDED_LOCATIONS.has(loc)) continue;
    if (!cells || typeof cells !== "object") continue;
    stockKnown = true;
    for (const [key, cell] of Object.entries(cells)) {
      if (!(key in perKey)) continue;
      const qty = cell !== null && typeof cell === "object" ? cell.qty : cell;
      perKey[key] += Math.max(0, Number(qty) || 0);
    }
  }
  const seen = new Set();
  const availableSizes = list.filter((s) => {
    const k = stockSizeKey(s);
    if (seen.has(k) || !(perKey[k] > 0)) return false;
    seen.add(k);
    return true;
  });
  return { availableSizes, totalUnits: availableUnits(stockByLocation, list), stockKnown };
}

/**
 * Does one item (product summary + stock summary) pass the New tab filter? Pure.
 * oneSize: exactly ONE size with stock > 0; when no stock is known for the
 * product at all, exactly one catalogue size.
 */
function matchesFilter(summary, stock, filter) {
  const f = normalizeFilter(filter);
  if (!f) return true;
  const p = summary || {};
  if (f.noStockPrice && Number(p.stockPrice) > 0) return false;
  if (f.cls && filterClassOf(p.categoryKey) !== f.cls) return false;
  if (f.oneSize) {
    const n = stock && stock.stockKnown ? (stock.availableSizes || []).length : (p.sizes || []).length;
    if (n !== 1) return false;
  }
  return true;
}

// ── DECISIONS ────────────────────────────────────────────────────────────────
const REJECT_CHIPS = Object.freeze(["background wrong", "colour off", "detail changed", "looks fake/CGI", "framing", "box wrong", "blurry"]);
// "pick" (3 Oct card fixes): Junid made an earlier generation the main photo —
// calibration counts it as an approval of THAT generation.
// "love" / "unlove" (3 Oct evening, learning log): Junid's ❤ on one generation —
// the strongest positive for calibration; an unlove cancels it.
const DECISION_ACTIONS = Object.freeze(["approve", "approve-anyway", "regenerate", "reject", "skip", "restore", "generate", "pick", "love", "unlove"]);

/**
 * The ledger row for one of Junid's actions (decisions/{push}). `item` is the
 * item as it was when he acted; the generation snapshot is taken from it, so
 * the row records what he actually looked at. Never carries undefined. Pure.
 */
function decisionRecord({ pid, at, by, action, reason = null, item, categoryKey = null, genId: pickedGen = null }) {
  if (!DECISION_ACTIONS.includes(action)) throw new Error(`unknown decision action ${action}`);
  const key = (item && item.categoryKey) || categoryKey || null;
  // A pick names the generation Junid chose; every other action is on the current one.
  const genId = pickedGen || (item && item.currentGen) || null;
  const gen = genId && item.generations && item.generations[genId] ? item.generations[genId] : null;
  return {
    pid, at, by: by || "unknown", action,
    reason: reason || null,
    class: CLASS_OF(key),
    categoryKey: key ? String(key) : null,
    genId: gen ? genId : null,
    gen: gen ? JSON.parse(JSON.stringify(gen)) : null,
    // Junid approved what the checker rejected: "checker wrong" for each rule it
    // failed, so calibration tunes those thresholds against it (3 Oct).
    checkerWrong: action === "approve-anyway" ? checkerWrongRules(gen, item) : null,
  };
}

/** The rules the checker failed on an approved-anyway generation (never empty: falls back to the rejection code). Pure. */
function checkerWrongRules(gen, item) {
  const v = gen && gen.verdict && typeof gen.verdict === "object" ? gen.verdict : null;
  const rules = Array.isArray(v && v.failed) ? v.failed : Object.values((v && v.failed) || {});
  if (rules.length) return rules.map(String);
  const code = item && item.rejection && item.rejection.code;
  return [code ? String(code) : "rejected"];
}

/**
 * The ledger action for Junid's Approve of `item` (as it was) — on generation
 * `genId`, or the current one. "approve-anyway" (with checkerWrong) when that
 * photo's verdict failed or the lane was rejected; otherwise "approve". Pure.
 */
function approveAction(item, genId = null) {
  if (!item) return "approve";
  if (item.status === "rejected") return "approve-anyway";
  const id = genId || item.currentGen || null;
  const gen = id && item.generations && item.generations[id] && typeof item.generations[id] === "object" ? item.generations[id] : null;
  // The item's verdict follows its current photo; a named other generation brings its own.
  const v = genId && genId !== item.currentGen ? gen && gen.verdict : item.verdict || (gen && gen.verdict);
  return v && typeof v === "object" && v.pass === false ? "approve-anyway" : "approve";
}

// ── PICK ANY GENERATION ──────────────────────────────────────────────────────
// Junid taps "Use this one" on any earlier generation (a checker-failed one or
// a re-check too), in any New-tab lane while no new photo is being generated.
// The item keeps its lane; the photo, its verdict and the framing flag follow
// the chosen generation. Approve then uses it (it reads generatedUrl, and the
// ledger snapshot comes from currentGen).
const SELECT_LANES = Object.freeze(["new", "ready", "rejected"]);
const GEN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const failedList = (v) => (Array.isArray(v && v.failed) ? v.failed : Object.values((v && v.failed) || {}));

// A STUDIO request (the Cloud Function's own claim, stamped studio: true) older
// than this is a run that died — the function timed out or crashed: it no
// longer blocks Approve, Skip, Use this one or a new Generate. Ten minutes is
// past the function's own 9-minute limit. An older-style request (the retired
// Mac mini queue) carries no such stamp and blocks until it is cleared.
const REQUEST_STALE_MS = 10 * 60 * 1000;
/** Is a photo being made for this item right now? Pure. */
function requestPending(item, nowMs) {
  const r = item && item.generateRequest;
  if (!r) return false;
  if (r.studio !== true) return true;
  const at = Number(r.at) || 0;
  return !(Number.isFinite(nowMs) && at > 0 && nowMs - at > REQUEST_STALE_MS);
}

/** The current generation's photo URL, or null. Pure. */
function currentGenUrl(item) {
  const g = item && item.currentGen && item.generations && item.generations[item.currentGen];
  return g && typeof g === "object" && g.url ? String(g.url) : null;
}

/** Why `genId` cannot be picked on `item`, or null. Pure. */
function selectRefusal(item, genId, nowMs = NaN) {
  if (!item) return "not in the New Arrivals queue";
  if (!SELECT_LANES.includes(item.status)) return `it is ${item.status}, not new, ready or rejected`;
  if (requestPending(item, nowMs)) return "a new photo is being generated — wait for it";
  const gen = item.generations && item.generations[genId];
  if (!gen || typeof gen !== "object") return "that generation is not on this item";
  if (!gen.url) return "that generation has no photo";
  return null;
}

/**
 * The item fields a pick sets (null = removed, as RTDB would). Pure.
 * NOTHING POSTS WITHOUT JUNID'S APPROVAL OF THAT PHOTO (3 Oct): a pick on an
 * item that was approved before (and later refused further down the line)
 * clears the old approval — the new photo needs its own Approve.
 */
function selectFields(gen, genId, at, item = null) {
  const v = gen.verdict && typeof gen.verdict === "object" ? gen.verdict : null;
  const framing = gen.framingFlag === true || failedList(v).includes("framing");
  return {
    currentGen: genId,
    generatedUrl: String(gen.url),
    generatedPath: gen.path ? String(gen.path) : null,
    verdict: v ? JSON.parse(JSON.stringify({ ...v, at })) : null,
    framingFlag: framing ? true : null,
    ...(item && item.approvedAt ? { approvedAt: null, approvedBy: null } : {}),
  };
}

// ── LOVE ONE GENERATION ──────────────────────────────────────────────────────
// Junid's ❤ on any generation, in any lane (learning log, 3 Oct evening). It
// sets generations/{genId}/loved + lovedAt; un-love removes both. It never
// moves the item, never changes the main photo and never approves anything.

/** Why `genId` cannot be loved on `item`, or null. Pure. */
function loveRefusal(item, genId) {
  if (!item) return "not in the New Arrivals queue";
  const gen = item.generations && item.generations[genId];
  if (!gen || typeof gen !== "object") return "that generation is not on this item";
  if (!gen.url) return "that generation has no photo";
  return null;
}

/**
 * The item after a love / un-love of `genId`, or null when it already is in
 * that state (nothing to write, nothing to log). Only that generation's
 * loved / lovedAt change. Pure.
 */
function lovedItem(item, genId, loved, at) {
  const gen = item.generations[genId];
  if ((gen.loved === true) === (loved === true)) return null;
  const nextGen = { ...gen };
  if (loved === true) { nextGen.loved = true; nextGen.lovedAt = at; } else { delete nextGen.loved; delete nextGen.lovedAt; }
  return { ...item, generations: { ...item.generations, [genId]: nextGen } };
}

// THE CARD NEVER RECEIVES THE LEARNING LOG. The poster keeps the full record
// in genlog (RTDB index + ledger); should any of its heavy fields ever be
// written onto a generation, the list strips them before they reach the card.
const CARD_GEN_OMIT = Object.freeze(["promptText", "promptSha", "thoughts", "thoughtsLabel", "thoughtsUnsupported", "genlog", "inputs", "request", "usage", "timing", "errors503"]);
/**
 * What the card needs to show the product's CURRENT photo: `sourceUrl` (the
 * live source photo — never the item's old pin), `staleGens` (the generations
 * made from a photo the product no longer shows) and `sourceChanged` (the
 * photo on the card is one of them). Pure.
 */
function sourceFields(pid, item, product) {
  const sourceUrl = sourcePhoto.currentSourceUrl(pid, product, item);
  // EVERY generation made from a photo the product no longer shows (so the card
  // can refuse "Use this one" on those too, not only flag the current one).
  const staleGens = Object.entries((item && item.generations) || {})
    .filter(([, g]) => sourcePhoto.generationIsStale(g, { sourceUrl, photoUpdatedAt: product && product.photoUpdatedAt })).map(([id]) => id);
  const stale = !!(item && item.currentGen && staleGens.includes(item.currentGen));
  return { sourceUrl, ...(staleGens.length ? { staleGens } : {}), ...(stale ? { sourceChanged: true } : {}) };
}

/** Was generation `genId` of this item made from a photo the product no longer shows? Pure. */
function staleGeneration(pid, item, genId, product) {
  const gen = item && genId && item.generations && item.generations[genId];
  return !!gen && sourcePhoto.generationIsStale(gen, { sourceUrl: sourcePhoto.currentSourceUrl(pid, product, item), photoUpdatedAt: product && product.photoUpdatedAt });
}

/** The item as the card gets it: every generation without the log's heavy fields. Pure. */
function cardItem(item) {
  if (!item || !item.generations || typeof item.generations !== "object") return item;
  const generations = {};
  for (const [id, g] of Object.entries(item.generations)) {
    if (!g || typeof g !== "object") continue;
    const out = { ...g };
    for (const k of CARD_GEN_OMIT) delete out[k];
    generations[id] = out;
  }
  return { ...item, generations };
}

// ── HOW GEMINI DID IT (3 Oct, learning log) ──────────────────────────────────
// The poster keeps, per generation code, new_arrivals/genlog/{code}: Gemini's
// own summary of its thinking (verbatim, "Gemini's own account — not proof")
// and the drafts it made on the way. The card opens it on demand, one
// generation at a time, through newArrivalsHow — never in the list.
const GENLOG = `${ROOT}/genlog`;
const THOUGHTS_LABEL = "Gemini's own account — not proof";
// A code is a path key (genlog/{code}): the same safe charset as a generation id.
const CODE_RE = GEN_ID_RE;

/**
 * What the card may see of one genlog record — ONLY code, method, thoughts,
 * thoughtsLabel, drafts [{url}] and model; never promptText or anything else.
 * { code, none: true } when nothing was recorded. Pure.
 */
const OWN_STORAGE_RE = /^https:\/\/(firebasestorage\.googleapis\.com|storage\.googleapis\.com)\//;
function howView(code, rec) {
  if (!rec || typeof rec !== "object") return { code, none: true };
  const list = Array.isArray(rec.drafts) ? rec.drafts : Object.values(rec.drafts || {});
  // Only our own storage's drafts are ever shown (the poster uploads them there).
  const drafts = list.filter((d) => d && typeof d === "object" && typeof d.url === "string" && OWN_STORAGE_RE.test(d.url)).map((d) => ({ url: d.url }));
  const thoughts = typeof rec.thoughts === "string" ? rec.thoughts : null;
  if (!thoughts && !drafts.length) return { code, none: true };
  return {
    code,
    method: METHODS.includes(rec.method) ? rec.method : null,
    // Which engine made it — only when recorded (older photos have none: Gemini).
    ...(PROVIDERS.includes(rec.provider) ? { provider: rec.provider } : {}),
    thoughts,
    thoughtsLabel: typeof rec.thoughtsLabel === "string" && rec.thoughtsLabel ? rec.thoughtsLabel : THOUGHTS_LABEL,
    drafts,
    model: typeof rec.model === "string" ? rec.model : null,
  };
}

// ── PER-ITEM METHOD (3 Oct) ──────────────────────────────────────────────────
// "split" = Gemini makes the product only, code places it on the real plate;
// "full" = the old method, Gemini makes the whole photo. The poster's default
// comes from its config; items/{pid}/method overrides it for one item (absent
// = the default). A setting, not a decision: nothing is logged.
const METHODS = Object.freeze(["full", "split"]);
// THE PROVIDER (4 Oct): which engine makes the photo — Gemini (the default) or
// OpenAI's gpt-image-1. Chosen per item beside the method; the prompt and the
// process are the same for both. items/{pid}/provider overrides the default
// (absent = Gemini). Never blended: one photo, one engine.
const PROVIDERS = Object.freeze(["gemini", "openai"]);
const PROVIDER_LABEL = Object.freeze({ gemini: "Gemini", openai: "OpenAI" });

/** Why the method of `item` cannot be changed now, or null. Pure. */
function methodRefusal(item, nowMs = NaN) {
  if (!item) return "not in the New Arrivals queue";
  if (!SELECT_LANES.includes(item.status)) return `it is ${item.status}, not new, ready or rejected`;
  if (requestPending(item, nowMs)) return "a new photo is being generated — change it when it lands";
  return null;
}

// RTDB's key order (integer-like keys first, numerically; then strings).
// Mirror of the fake's rtdbKeyCmp — the cursor walks exactly this order.
function keyCmp(a, b) {
  const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na) return -1;
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// The most index keys one list call reads per status (see listTab).
const INDEX_CEILING = 2000;

module.exports = {
  parseBucketCursor, bucketRank, REQUEST_STALE_MS, requestPending,
  currentGenUrl,
  checkerWrongRules, approveAction,
  INDEX_CEILING,
  ROOT, ITEMS, BY_STATUS, DECISIONS, STATUSES, TABS, TAB_OF, STATUSES_IN_TAB,
  NEW_LANES, LEGACY_TABS, normalizeTab, BUCKETS, photoBucket, bucketCmp,
  ENQUEUE_WINDOW_MS, ENQUEUE_SKEW_MS, PID_RE,
  enqueueDecision, buildItem, moveMutator, moved, indexMove, indexRepair,
  listLimit, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, productSummary,
  FOOTWEAR_KEYS, TWOPIECE_KEYS, SINGLE_KEYS, SLIDE_KEYS, CLASSES, CLASS_OF,
  FILTER_CLASSES, filterClassOf, normalizeFilter, GROUPS, GROUP_TABS, groupOf, normalizeGroup, stockSummary, matchesFilter,
  REJECT_CHIPS, DECISION_ACTIONS, decisionRecord, keyCmp,
  SELECT_LANES, GEN_ID_RE, selectRefusal, selectFields,
  loveRefusal, lovedItem, CARD_GEN_OMIT, cardItem, sourceFields, staleGeneration,
  GENLOG, THOUGHTS_LABEL, CODE_RE, howView, METHODS, PROVIDERS, PROVIDER_LABEL, methodRefusal,
};
