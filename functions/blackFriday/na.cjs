// ─── BLACK FRIDAY 2026 — NEW ARRIVALS ON THE BLACK FRIDAY CARD (Junid, 20 Nov) ─
// The card's "New Arrivals" tab is the New Arrivals queue itself
// (new_arrivals/items, the same data the New Arrivals card shows):
//   • ONE APPROVAL. A New Arrival is approved, rejected (skipped) or taken
//     back through New Arrivals' own moves (newArrivals.js approve / useCurrent
//     / skip / restore / unapprove), and its Black Friday pick
//     (bf_campaign_2026/picks/{pid}, src "na") MIRRORS the New Arrivals item —
//     written right after the tap here, and by bfNaMirror for a tap on the New
//     Arrivals card. Approving in either place is one approval.
//   • ONE PHOTO. The approved photo is the item's generatedUrl (its New
//     Arrivals AI photo, or the app photo for "Use current photo"); pick.shown
//     pins it and the posting brain sends exactly that.
//   • Uploaded in the past 20 days (the New Arrivals window, by key), still
//     in the New lanes, in stock, never a paper bag or a price placeholder,
//     any quantity. A product that is both new and 13+ shows ONLY here.
// Pure helpers first; the database work below takes `db`.
"use strict";

const naCore = require("../newArrivals/core.cjs");

const ROOT = "bf_campaign_2026";
// The campaign began 19 Nov 2026 (SAST): an approval on the New Arrivals card from then on also posts here.
const CAMPAIGN_START_MS = Date.UTC(2026, 10, 18, 22, 0, 0);

// ── the kind (marathon-group-poster src/bf/core.mjs kindOf, the build's own rule) ─
const FOOTWEAR_KEYS = Object.freeze(["sneakers", "running-shoes", "boots", "soccer-boots", "slides", "loafers", "kids-shoes", "designer-shoes", "sandals"]);
const HEADWEAR_KEYS = Object.freeze(["caps-beanies", "fitted-caps", "visors", "caps", "beanies"]);
const ACCESSORY_KIND = Object.freeze({ bags: "bags", belts: "belts", sunglasses: "sunglasses", watches: "watches", "chains-bracelets": "jewellery" });
const SUBCATEGORY_KIND = Object.freeze({ "Eyewear": "sunglasses", "Belts": "belts", "Jewellery": "jewellery", "Watches": "watches", "Bags": "bags", "Caps & Hats": "headwear", "Hats": "headwear", "Caps": "headwear", "Beanies": "headwear", "Sneakers": "sneakers", "Soccer Boots": "sneakers", "Slides": "sneakers", "Perfume": "perfume" });
const NAME_KIND = Object.freeze([
  [/\b(perfume|eau de|edp|edt|cologne|fragrance)\b/i, "perfume"],
  [/\b(caps?|beanies?|bucket hat|hats?|visors?|snapback|trucker)\b/i, "headwear"],
  [/\b(sunglass(es)?|shades|eyewear)\b/i, "sunglasses"],
  [/\b(belts?)\b/i, "belts"],
  [/\b(watch(es)?)\b/i, "watches"],
  [/\b(chains?|bracelets?|necklaces?|earrings?|rings?|pendants?)\b/i, "jewellery"],
  [/\b(bags?|backpacks?|pouch|wallets?|sling)\b/i, "bags"],
]);
/** sneakers · clothing · headwear · perfume · bags · belts · sunglasses · watches · jewellery · accessories. Pure. */
function kindOf(p) {
  const k = String((p && p.categoryKey) || ""), c = String((p && p.category) || "");
  const name = String((p && p.name) || "");
  if (k === "perfumes" || c === "Perfume") return "perfume";
  if (FOOTWEAR_KEYS.includes(k)) return "sneakers";
  if (HEADWEAR_KEYS.includes(k)) return "headwear";
  const byName = () => { for (const [re, kind] of NAME_KIND) if (re.test(name)) return kind; return null; };
  if (k === "chains-bracelets" || (k && c === "Accessories" && !ACCESSORY_KIND[k])) return byName() || ACCESSORY_KIND[k] || "accessories";
  if (ACCESSORY_KIND[k]) return ACCESSORY_KIND[k];
  if (k && /^belts?\b/i.test(name)) return "belts";
  if (k) return c === "Accessories" ? "accessories" : "clothing";
  const sub = SUBCATEGORY_KIND[String((p && p.subcategory) || "")];
  if (sub) return sub;
  if (c === "Footwear") return "sneakers";
  for (const [re, kind] of NAME_KIND) if (re.test(name)) return kind;
  return c === "Accessories" ? "accessories" : "clothing";
}
const isPaperBag = (p) => String((p && p.categoryKey) || "") === "packaging" || /paper\s*-?\s*bag/i.test(String((p && p.name) || ""));
const isPricePlaceholder = (p) => String((p && p.category) || "") === "Price Products";
/** New Arrivals' generator frames footwear and clothing only (its plates): Generate is offered for these. Pure. */
const naCanGenerate = (kind) => kind === "sneakers" || kind === "clothing";

/** The upload time: the product id is "p" + the creation time (New Arrivals' window is by this key). Pure. */
function uploadedAtOf(pid, product = null) {
  return naCore.uploadedAt(pid, product).at;
}

const APPROVED = naCore.APPROVED_LANES;
const NEW = naCore.NEW_LANES;

/**
 * The Black Friday pick a New Arrivals item stands for, or undefined to leave
 * the pick alone. item: new_arrivals/items/{pid} (status, generatedUrl,
 * approvedAt, approvedBy, skippedAt); facts: { price, kind, name, sizes, qty };
 * cur: the pick now. Pure.
 */
function mirrorPick(pid, item, facts, cur, { inWindow = false } = {}) {
  const status = item && item.status;
  const ours = !!cur && cur.src === "na";
  if (status && APPROVED.includes(status)) {
    const at = Number(item.approvedAt) || 0;
    // An approval made before the campaign (even of a product still in the 20-day window) is not a
    // Black Friday approval: its chain moves (approved → chaining → done) must never post it here.
    if (!ours && !(at >= CAMPAIGN_START_MS)) return undefined;
    const shown = item.generatedUrl || null;
    if (!shown || !(at > 0)) return undefined;
    if (ours && cur.state === "approved" && Number(cur.at) === at && cur.shown === shown) return undefined;
    return {
      state: "approved", src: "na", sig: "na", shown, at, by: item.approvedBy || null, section: "newArrivals",
      price: facts.price ?? null, kind: facts.kind || "clothing", name: facts.name || "", sizes: facts.sizes || "",
      ...(item.useCurrentPhoto ? { useCurrent: true } : {}),
    };
  }
  if (status === "skipped") {
    if (!ours && (!inWindow || !(Number(item.skippedAt) >= CAMPAIGN_START_MS))) return undefined;
    if (ours && cur.state === "rejected") return undefined;
    return { state: "rejected", src: "na", at: Number(item.skippedAt) || Date.now(), by: item.skippedBy || null, section: "newArrivals", name: facts.name || "" };
  }
  if (status && NEW.includes(status)) {
    // Taken back on either card: back to review. A Black Friday approval made on its own (src not "na") stays.
    if (ours && cur.state) return { name: cur.name || facts.name || "" };
    return undefined;
  }
  return undefined;
}

/**
 * One New Arrivals row as the Black Friday card shows it (the same shape as
 * core.viewItem). base: the build's row (items/main|under) or one made live;
 * na: { status, generatedUrl, currentGen, generateRequest, useCurrentPhoto }. Pure.
 */
function viewNaRow(pid, base, na, { nowMs = Date.now(), uploadedAt = null } = {}) {
  const kind = base.kind || "clothing";
  const gen = na && na.generatedUrl && !na.useCurrentPhoto ? na.generatedUrl : null;
  return {
    pid, name: base.name || pid, price: base.price, qty: Number(base.qty) || 0, sizes: base.sizes || "", kind,
    big: (Number(base.qty) || 0) >= 30, na: true, src: "na",
    photo: base.photo || null, shown: gen || base.photo || null,
    // sig: the photo shown — its New Arrivals generation, "na" (its main AI photo, no generation id), or "current".
    use: gen ? "generated" : "current", genId: gen ? (na.currentGen || null) : null, sig: gen ? (na.currentGen || "na") : "current",
    generatedUrl: gen, generations: na && na.currentGen ? 1 : 0,
    generating: !!(na && naCore.requestPending(na, nowMs) && na.generateRequest && na.generateRequest.studio === true),
    styleApproved: true, canGenerate: naCanGenerate(kind),
    failed: na && na.lastAttempt && na.lastAttempt.failed && !na.currentGen ? { at: na.lastAttempt.at || null, reason: String(na.lastAttempt.reason || "") } : null,
    tab: "newArrivals", changedSinceApproval: false, posted: null,
    uploadedAt: uploadedAt || uploadedAtOf(pid),
  };
}

// ── the database side ────────────────────────────────────────────────────────
const val = async (db, path) => (await db.ref(path).once("value")).val();

/** The New Arrivals window: pid → lane, every lane, by key from the window's start (never a whole lane). */
async function windowLanes(db, nowMs) {
  const since = naCore.windowStartKey(nowMs);
  const out = new Map();
  await Promise.all(["new", "generating", "ready", "rejected", "approved", "chaining", "done", "skipped"].map(async (lane) => {
    const snap = await db.ref(`${naCore.BY_STATUS}/${lane}`).orderByKey().startAt(since).limitToLast(naCore.INDEX_CEILING).once("value");
    for (const k of Object.keys(snap.val() || {})) if (!out.has(k)) out.set(k, lane);
  }));
  return out;
}

// A product not in the 05:00 build (uploaded since, or out of stock then): read live, cached 3 minutes per instance.
const LIVE_TTL_MS = 3 * 60 * 1000;
const liveCache = new Map();
async function liveRow(db, pid, nowMs, na) {
  const hit = liveCache.get(pid);
  if (hit && nowMs - hit.at < LIVE_TTL_MS) return hit.v;
  const locs = await na._internals.stockLocations(db);
  const d = await na._internals.productDetail(db, pid, locs);
  const p = d.raw;
  let v = null;
  if (p && !p.mergedInto && !isPaperBag(p) && !isPricePlaceholder(p) && d.stock && d.stock.totalUnits > 0 && p.photoUrl) {
    v = {
      name: p.name || pid, price: naCore.stockPriceOf(p), qty: d.stock.totalUnits,
      sizes: (d.stock.availableSizes || []).map(String).join(", "), photo: p.photoUrl, kind: kindOf(p),
      uploadedAt: uploadedAtOf(pid, p),
    };
  }
  liveCache.set(pid, { v, at: nowMs });
  if (liveCache.size > 3000) for (const k of [...liveCache.keys()].slice(0, 1000)) liveCache.delete(k);
  return v;
}

/** The few New Arrivals fields a row needs — keyed scalars, never the item's generations. */
async function naFields(db, pid, lane = null) {
  // Lane "new" holds no photo yet (a landed photo moves it to "ready"): two reads instead of six.
  if (lane === "new") {
    const [generateRequest, lastAttempt] = await Promise.all([val(db, `${naCore.ITEMS}/${pid}/generateRequest`), val(db, `${naCore.ITEMS}/${pid}/lastAttempt`)]);
    return { status: "new", generatedUrl: null, currentGen: null, generateRequest, useCurrentPhoto: null, lastAttempt };
  }
  const f = ["status", "generatedUrl", "currentGen", "generateRequest", "useCurrentPhoto", "lastAttempt"];
  const vals = await Promise.all(f.map((k) => val(db, `${naCore.ITEMS}/${pid}/${k}`)));
  return Object.fromEntries(f.map((k, i) => [k, vals[i]]));
}

async function inBatches(xs, width, fn) {
  const out = [];
  for (let i = 0; i < xs.length; i += width) out.push(...await Promise.all(xs.slice(i, i + width).map(fn)));
  return out;
}

/**
 * The New Arrivals tab. lanes: windowLanes(); items: { main, under } rows of
 * the build; picks: the Black Friday picks. → { rows, naSet } — naSet: every
 * product in the window (for "shows ONLY under New Arrivals" and the
 * Approved split).
 */
async function naTab(db, { lanes, items, picks, nowMs, na, underRow = async () => null }) {
  const rows = [];
  const pids = [...lanes.entries()].filter(([, lane]) => NEW.includes(lane)).map(([pid]) => pid);
  await inBatches(pids, 50, async (pid) => {
    const pick = picks[pid];
    if (pick && (pick.state === "rejected" || pick.state === "approved")) return; // decided: Rejected list / Approved tab
    const built = (items.main || {})[pid] || (items.under || {})[pid] || (await underRow(pid)) || null;
    const base = built ? { ...built, uploadedAt: uploadedAtOf(pid) } : await liveRow(db, pid, nowMs, na);
    if (!base) return;
    const f = await naFields(db, pid, lanes.get(pid));
    if (!f.status || !NEW.includes(f.status)) return;
    rows.push(viewNaRow(pid, base, f, { nowMs, uploadedAt: base.uploadedAt }));
  });
  rows.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0) || (a.pid < b.pid ? 1 : -1));
  return rows;
}

/** The facts a mirrored pick carries: the build's row, else the product read live. */
async function factsOf(db, pid, nowMs, na) {
  const built = (await val(db, `${ROOT}/items/main/${pid}`)) || (await val(db, `${ROOT}/items/under/${pid}`));
  if (built) return { price: built.price, kind: built.kind, name: built.name, sizes: built.sizes, qty: built.qty };
  const live = await liveRow(db, pid, nowMs, na).catch(() => null);
  if (live) return live;
  const [name, stockPrice, categoryKey, category, subcategory] = await Promise.all(["name", "stockPrice", "categoryKey", "category", "subcategory"].map((k) => val(db, `products/${pid}/${k}`)));
  return { name: name || pid, price: naCore.stockPriceOf({ stockPrice }), kind: kindOf({ name, categoryKey, category, subcategory }), sizes: "" };
}

/** Bring the Black Friday pick in line with the New Arrivals item (one approval). → { changed, pick } */
async function mirror(db, pid, nowMs, { na = require("../newArrivals/newArrivals.js"), ledger = null } = {}) {
  const item = await val(db, `${naCore.ITEMS}/${pid}`);
  if (!item) return { changed: false };
  const inWindow = String(pid) >= naCore.windowStartKey(nowMs);
  const ref = db.ref(`${ROOT}/picks/${pid}`);
  const cur0 = await val(db, `${ROOT}/picks/${pid}`);
  if (mirrorPick(pid, item, {}, cur0, { inWindow }) === undefined) return { changed: false, pick: cur0 };
  const facts = await factsOf(db, pid, nowMs, na);
  let wrote = null;
  const res = await ref.transaction((cur) => {
    const base = cur === null ? cur0 : cur;
    const next = mirrorPick(pid, item, facts, base, { inWindow });
    wrote = next === undefined ? null : next;
    return next === undefined ? undefined : { ...next, rev: ((base && base.rev) || 0) + 1 };
  });
  const pick = res && res.snapshot ? res.snapshot.val() : null;
  if (wrote && wrote.state === "approved" && ledger) await ledger(db, pid, pick).catch(() => {});
  return { changed: !!wrote, pick };
}

module.exports = {
  ROOT, CAMPAIGN_START_MS, kindOf, isPaperBag, isPricePlaceholder, naCanGenerate, uploadedAtOf,
  mirrorPick, viewNaRow, windowLanes, naTab, naFields, liveRow, factsOf, mirror,
};
