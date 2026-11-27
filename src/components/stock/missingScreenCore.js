// ─── MISSING PRODUCTS — THE SCREEN'S OWN RULES (pure, no firebase) ────────────
// Junid, 22 Nov 2026. Missing Products is its own screen now. This module is
// everything that screen decides that is NOT refill logic: which cards are
// already queued at Central and so leave the list, how the two kinds of card
// become one list, the order, the search and the filters, and the plain-words
// sentence on each card.
//
// IT IS DISPLAY ONLY. Nothing here creates, changes or closes a request, a
// target or a stock cell. What is "missing" is still decided by the two cores
// that always decided it (missingProductsCore.js for everything that is not
// footwear, missingFootwearCore.js for footwear); this only chooses which of
// their cards to show, and how.

// ── QUEUED AT CENTRAL: THE CARD LEAVES THE LIST ──────────────────────────────
// A sneaker card is "missing" while no hub of its division holds a unit, so a
// Request did not retire it: the card sat there until Central picked the
// shoes, looking as if nothing had been done. Now a card whose request is
// OPEN at one of the division's hubs is taken off that division's list, and
// comes back by itself if the request is cancelled or rejected before stock
// moves (it stops being open, and the hub still holds nothing).
//
// Driven by the request records that already exist — the screen loads
// /refill_requests for its reservation arithmetic already. Only requests
// raised FROM this screen count (the Solve vias): a single scan row for one
// size of a sold-out shoe does not mean "this product has been dealt with".
//
// PER DIVISION, by construction: the hubs handed in are one division's. A
// request into Hub 1 hides the card on Marathon and leaves it on Concrete.
//
// (Everything that is not footwear already leaves by itself: its Solve seeds
// the product at the shop, which is the very thing "missing" tests for, in the
// database, for one division. Nothing is added for those cards.)
export const QUEUED_VIAS = Object.freeze(["missing_sneakers", "missing_sneakers_pick", "hub3_solve"]);

export function isQueuedFromHere(r) {
  if (!r || typeof r !== "object") return false;
  if (r.status !== "open" || r.shadow) return false;
  const via = r.createdFrom && typeof r.createdFrom === "object" ? r.createdFrom.via : null;
  return QUEUED_VIAS.includes(via);
}

/**
 * pid → { hubs: [hub…], units, sizes: [{ hub, size, qty }] } for every product
 * with a request from this screen still open at one of `hubs`.
 */
export function queuedAtHubs(requests, hubs) {
  const want = new Set(hubs || []);
  const out = new Map();
  for (const r of Array.isArray(requests) ? requests : Object.values(requests || {})) {
    if (!isQueuedFromHere(r) || !want.has(r.requestingLocation) || !r.productId) continue;
    const q = out.get(r.productId) || { hubs: [], units: 0, sizes: [] };
    if (!q.hubs.includes(r.requestingLocation)) q.hubs.push(r.requestingLocation);
    const qty = Math.max(Number(r.qty) || 0, 0);
    q.units += qty;
    q.sizes.push({ hub: r.requestingLocation, size: String(r.size ?? ""), qty });
    out.set(r.productId, q);
  }
  return out;
}

/**
 * Split one division's sneaker cards into the ones still to do and the ones
 * already queued. `justQueued` is { pid: true } for a request this device
 * raised a moment ago, so the card leaves on the tap and not on the echo.
 * Order is preserved; the cards themselves are never changed.
 */
export function partitionQueued(cards, requests, hubs, justQueued = null) {
  const queued = queuedAtHubs(requests, hubs);
  const todo = [], waiting = [];
  for (const c of cards || []) {
    const q = queued.get(c.pid);
    if (q) waiting.push({ card: c, queue: q });
    else if (justQueued && justQueued[c.pid]) waiting.push({ card: c, queue: null });
    else todo.push(c);
  }
  return { todo, waiting };
}

// ── ONE LIST PER DIVISION: BOTH KINDS OF CARD, NEWEST UPLOAD FIRST ───────────
// A product id is `p<epoch ms>` — the moment it was uploaded — so the id is the
// upload time (older records with another id shape sort last).
export function uploadedAtOf(pid) {
  const m = /^p(\d{11,14})$/.exec(String(pid || ""));
  return m ? Number(m[1]) : 0;
}

const titleCase = (s) => String(s).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
/** The category a person would call it: the category key, else the old leaf. */
export function categoryLabelOf(product, categoryKey) {
  if (categoryKey) return titleCase(categoryKey);
  const sub = typeof product?.subcategory === "string" ? product.subcategory.trim() : "";
  if (sub && !/uncategori[sz]ed/i.test(sub)) return sub;
  const cat = typeof product?.category === "string" ? product.category.trim() : "";
  return cat || "No category";
}
export const brandOf = (product) => (typeof product?.brand === "string" && product.brand.trim() ? product.brand.trim() : "No brand");

/**
 * The rows of one division's list. `productCards` / `sneakerCards` are that
 * division's cards, already less the hidden and the queued. Each row keeps its
 * card untouched; `kind` says which core built it (and so which action it has).
 */
export function buildRows({ productCards = [], sneakerCards = [], byId, categoryKeyOf }) {
  const row = (kind) => (card) => {
    const p = byId?.get ? byId.get(card.pid) : null;
    return {
      key: `${kind}:${card.pid}`, kind, pid: card.pid, card,
      name: card.name || card.pid,
      brand: brandOf(p),
      category: categoryLabelOf(p, categoryKeyOf ? categoryKeyOf(p) : null),
      uploadedAt: uploadedAtOf(card.pid),
      search: [card.name, p?.brand, p?.styleCode, p?.sku, card.pid].filter(Boolean).join(" ").toLowerCase(),
    };
  };
  return sortRows([...productCards.map(row("product")), ...sneakerCards.map(row("sneaker"))]);
}

/** Newest upload first; the same moment (or no known moment) by name. */
export function sortRows(rows) {
  return [...(rows || [])].sort((a, b) => b.uploadedAt - a.uploadedAt || String(a.name).localeCompare(String(b.name)));
}

/** Search (every word must appear) and the two filters. "" = no filter. */
export function filterRows(rows, { search = "", category = "", brand = "" } = {}) {
  const words = String(search).toLowerCase().split(/\s+/).filter(Boolean);
  return (rows || []).filter((r) =>
    (!category || r.category === category) && (!brand || r.brand === brand) && words.every((w) => r.search.includes(w)));
}

/** The values a filter can take, with how many rows each has, A–Z. */
export function facet(rows, field) {
  const n = new Map();
  for (const r of rows || []) n.set(r[field], (n.get(r[field]) || 0) + 1);
  return [...n.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => String(a.value).localeCompare(String(b.value)));
}

// ── WHY IT IS ON THE LIST, IN PLAIN WORDS ────────────────────────────────────
const list = (names) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`);
const units = (n) => `${n} unit${n === 1 ? "" : "s"}`;

/** A card from missingProductsCore. `nameOf(loc)` names a location; `central` is Central's id. */
export function whyProduct(card, { nameOf, central = "central", division = "" }) {
  const src = nameOf(card.source);
  const missing = (card.missing || []).map(nameOf);
  const none = (card.sizes || []).filter((s) => s.centralNone).map((s) => s.size);
  if (card.centralFed) {
    const shop = nameOf(card.centralFed);
    if (/^Sizes missing/.test(card.kind || "")) {
      const can = (card.sizes || []).filter((s) => !s.centralNone).map((s) => s.size);
      return { why: `${shop} is short of size${(card.sizes || []).length === 1 ? "" : "s"} ${(card.sizes || []).map((s) => (s.size === "_" ? "one size" : s.size)).join(", ")}.`,
        holds: can.length ? `${src} holds ${units(card.units)} of them${none.length ? ` — none of ${none.join(", ")}` : ""}.` : `${src} has none of them yet — nothing to send.`,
        nothingToSend: !can.length };
    }
    return { why: `Never sent to ${list(missing)} — ${src} has it.`, holds: `${src} holds ${units(card.units)}.`, nothingToSend: false };
  }
  if (card.source === central) {
    return { why: `Never sent out to ${division || "this division"} — not kept at ${list(missing)}.`, holds: `${src} holds ${units(card.units)}.`, nothingToSend: false };
  }
  return { why: `Stuck at ${src} — not kept at ${list(missing)} yet.`, holds: `${src} holds ${units(card.units)}.`, nothingToSend: false };
}

/** A card from missingFootwearCore. `hubs` is the division's hubs. */
export function whySneaker(card, { nameOf, central = "central", hubs = [] }) {
  const all = hubs.map(nameOf);
  const holds = `${nameOf(central)} holds ${card.centralUnits} pair${card.centralUnits === 1 ? "" : "s"}.`;
  if (card.kind === "sold_out") {
    return { why: `Sold out at ${list((card.carriedAt || []).map(nameOf))} — it was kept there before and ${nameOf(central)} has more.`, holds };
  }
  return { why: `Never sent out — ${nameOf(central)} has it, ${all.length === 1 ? all[0] : `${list(all).replace(" or ", " and ")}`} ${all.length === 1 ? "does" : "do"} not.`, holds };
}
