// ─── MISSING PRODUCTS — WHAT IS ON THE LIST (pure, no firebase, no React) ─────
// Junid, 22 Nov 2026. The rule of the rebuilt screen, applied WHERE THE LIST IS
// BUILT and nowhere later:
//
//   A product is on a division's list only if a tap would send something.
//
// "Missing" is still decided by the two cores that always decided it
// (missingProductsCore / missingFootwearCore). This module takes each of their
// cards and asks the Solve's OWN planner — handed in as `planFor`, the very
// function the write plans with — what a solve to each destination would send.
// A destination that would send nothing is a dead button; a card whose every
// destination is dead is not a row at all. So the screen can never show
// "Central holds 3" beside "Central has none": the stock line is summed over
// exactly the sizes a tap sends.
//
// Nothing here decides a quantity, a target or a request. It reads the plan.
import { decodedCellKey } from "../../utils/sizeKey";
import { centralReservedBySize, centralFreeFor, lockKeyFor, isSneakerOrSlide } from "./firstBatchCore";

export const rowKey = (section, kind, pid) => `${section}:${kind}:${pid}`;

// A product id is `p<epoch ms>` — the moment it was uploaded.
export function uploadedAtOf(pid) {
  const m = /^p(\d{11,14})$/.exec(String(pid || ""));
  return m ? Number(m[1]) : 0;
}
/** The order a list OPENS in: newest upload first, then by name. */
export function openingOrder(cards) {
  return [...(cards || [])].sort((a, b) => uploadedAtOf(b.pid) - uploadedAtOf(a.pid) || String(a.name || "").localeCompare(String(b.name || "")));
}

// ── WHAT CENTRAL HAS ALREADY PROMISED, FROM THE REQUEST RECORDS ──────────────
// The Solve's write reads the engine's lock table live, one product at a time.
// A list of hundreds cannot (and must not: no whole-node read is added), so
// the list nets Central's shelf against the OPEN REQUESTS the screen already
// holds — the same records Central picks from in Source. Shaped like the lock
// table ({ loc: { sizeKey: { qty, source } } }) so the Solve's own planner
// takes it unchanged. The write still judges with the live locks.
export function openRequestsByProduct(requests) {
  const out = new Map();
  for (const r of Array.isArray(requests) ? requests : Object.values(requests || {})) {
    if (!r || typeof r !== "object" || r.status !== "open" || r.shadow || !r.productId || !r.requestingLocation) continue;
    const left = Math.max((Number(r.qty) || 0) - (Number(r.sentQty) || 0), 0);
    if (!left) continue;
    let byLoc = out.get(r.productId);
    if (!byLoc) { byLoc = {}; out.set(r.productId, byLoc); }
    const at = (byLoc[r.requestingLocation] ||= {});
    const k = lockKeyFor(r.size);
    const source = r.createdFrom && typeof r.createdFrom === "object" ? r.createdFrom.source : undefined;
    at[k] = { qty: (at[k]?.qty || 0) + left, ...(source || at[k]?.source ? { source: source || at[k].source } : {}) };
  }
  return out;
}

const qtyIn = (cells, size) => Math.max(Number(cells?.[decodedCellKey(size)]?.qty) || 0, 0);

/**
 * One row for a card of missingProductsCore (everything that is not a
 * sneaker), or null when no destination would send anything.
 *
 *   dests       the division's shops, in button order
 *   tickable    the shops this card may be solved into (the hook's own list)
 *   planFor     (card, [shop], openByLoc) → planSectionSolve's answer
 *   openByLoc   this product's open requests, lock-table shaped (may be {})
 *
 * PINE OR CONCRETE is one tap on one card: the card leaves with the tap, so
 * the same card can never send to both. (A shop that already keeps every size
 * it needs is a dead button by the plan itself.)
 */
export function productRow(args) { return decideProductRow(args).row; }

// "Pine's" / "Concrete's" — the owner's short name, possessive.
const OWNER_SHORT = Object.freeze({ "marathon-pine": "Pine", concrete: "Concrete" });
export function ownerNote(owner, nameOf = (x) => x) {
  const n = OWNER_SHORT[owner] || nameOf(owner) || owner;
  return `${n}\u2019s`;
}

// The same decision, with WHY when there is no row (notListedCore.REASONS —
// "Nothing disappears silently", Junid 23 Nov 2026). The row is exactly
// productRow's; the reason only says which gate stopped it.
export function decideProductRow({ card, section, product, dests = [], tickable = [], planFor, openByLoc = {}, allStock, central = "central", routes, nameOf = (x) => x, owners = null }) {
  const none = (why) => ({ row: null, why });
  if (!card) return none("unknown");
  if (!product) return none("noRecord");
  if (isSneakerOrSlide(product)) return none("noView");
  // ONE OWNER (Pine / Concrete — Junid, 22 Nov 2026): a product that already
  // belongs to one shop is offered to that shop only; one that belongs to
  // both (a data question for Junid) is offered to neither, so never to both.
  if (Array.isArray(owners) && owners.length > 1) return none("bothShops");
  // The shops held back by the one-owner rule, in button order, so the card
  // can say WHOSE the product is where the missing button would be (Junid,
  // 24 Nov 2026: a small "Pine's" note — nobody should have to guess).
  const allDests = dests;
  let heldFor = null;
  if (Array.isArray(owners) && owners.length === 1) {
    heldFor = owners[0];
    dests = dests.filter((d) => d === owners[0]);
  }
  const can = new Set(tickable);
  const reserved = centralReservedBySize({ openByLoc, routes });
  const sourceCells = allStock?.[card.source]?.[card.pid];
  const free = (size) => (card.source === central
    ? centralFreeFor({ qtyAt: (x) => qtyIn(sourceCells, x), reserved, size })
    : qtyIn(sourceCells, size));
  const counted = new Map();   // size → free units, over every size any live button sends
  // Why each dead destination is dead, to say why a dropped row was dropped.
  let anyShop = false, anySizes = false, anyHeld = false;
  const out = dests.map((id) => {
    const dead = { id, name: nameOf(id), ok: false, sizes: [], units: 0 };
    if (!can.has(id)) return dead;
    anyShop = true;
    let line;
    try { line = planFor(card, [id], openByLoc)?.lines?.[0]; } catch { line = null; }
    if (!line || !(line.sizes || []).length) return dead;
    anySizes = true;
    // A shop fed straight from Central is sent the sizes Central has, and
    // nothing is written for the rest. A shop behind a hub is seeded for every
    // size its policy covers; what MOVES is what the source holds.
    const direct = !line.hub;
    const sizes = direct ? (line.got || []).map((g) => String(g.size)) : line.sizes.map(String).filter((s) => free(s) > 0);
    if (!sizes.length) {
      // The source has units of a size the shop needs — all of them promised.
      if (line.sizes.some((s) => qtyIn(sourceCells, s) > 0)) anyHeld = true;
      return dead;
    }
    // (never below what the plan sends of that size — the two read one shelf)
    for (const s of sizes) counted.set(s, Math.max(free(s), direct ? Number((line.got || []).find((g) => String(g.size) === s)?.qty) || 0 : 0));
    return { id, name: nameOf(id), ok: true, sizes, units: line.units || 0 };
  });
  if (!out.some((d) => d.ok)) {
    if (!anyShop) return none("noShop");
    if (anyHeld) return none("allPromised");
    // The units the source holds are all in sizes the product's own size list
    // does not name — nothing plans them (a catalogue question, not policy).
    const declared = new Set((Array.isArray(product.sizes) ? product.sizes : []).map((z) => decodedCellKey(String(z))));
    const held = Object.keys(sourceCells || {}).filter((k) => k !== "_meta" && qtyIn(sourceCells, k) > 0);
    if (held.length && !held.some((k) => declared.has(decodedCellKey(k)))) return none("undeclaredSize");
    return none(!anySizes ? "noPolicy" : "noSize");
  }
  return { why: null, row: {
    key: rowKey(section, "clothing", card.pid), kind: "clothing", section, pid: card.pid,
    name: card.name || card.pid, photo: card.photo || null, card,
    source: card.source, sourceName: nameOf(card.source),
    stock: [...counted.values()].reduce((t, n) => t + n, 0),
    // A location is OFFERED or ABSENT — never a dead button on the card.
    dests: out.filter((d) => d.ok), twin: null,
    // Shops left off because another shop owns the product: a note, never a
    // button. `order` is every location in button order (offered + held).
    held: heldFor ? allDests.filter((d) => d !== heldFor).map((id) => ({ id, owner: heldFor, note: ownerNote(heldFor, nameOf) })) : [],
    order: allDests.filter((id) => out.some((d) => d.ok && d.id === id) || (heldFor && id !== heldFor)),
  } };
}

/**
 * One row for a card of missingFootwearCore, or null when no hub would be
 * sent anything.
 *
 *   dests       the division's hubs a sneaker may be requested into
 *   planFor     (card, hub) → footwearSolvePlan's lines [{ size, qty, avail }]
 *   refusal     (card, [hub]) → why that hub may not take it (the other
 *               Marathon hub already has it), or null
 */
// NO POLICY IS NOT A CARD (Junid, 24 Nov 2026). Until today a kids shoe whose
// sizes no policy named at the list's hubs was drawn as a "No policy yet" card
// with NO location button — its only control was the division button, and on
// 24 Nov three kids shoes were moved to Concrete by a tap meant for something
// else. A card always offers at least one location. A shoe nothing can be sent
// for because no policy names its sizes is "Not listed", reason "No policy",
// and from there opens the Engine Policy card. `hasPolicy(card, hub)` says
// whether any of its sizes has a number there; `requested` whether any open
// request for it exists.
export function sneakerRow(args) { return decideSneakerRow(args).row; }

// The same decision, with WHY when there is no row (see decideProductRow).
export function decideSneakerRow({ card, section, dests = [], planFor, refusal = () => null, blocked = false, central = "central", nameOf = (x) => x, hasPolicy = null, requested = false }) {
  if (!card) return { row: null, why: "unknown" };
  if (blocked) return { row: null, why: "notLive" };
  const counted = new Map();
  let refused = 0;
  const out = dests.map((id) => {
    const dead = { id, name: nameOf(id), ok: false, sizes: [], units: 0 };
    let lines;
    try { lines = planFor(card, id) || []; } catch { lines = []; }
    if (!lines.length) return dead;
    if (refusal(card, [id])) { refused += 1; return dead; }
    for (const l of lines) counted.set(String(l.size), Math.max(Number(l.avail) || 0, 0));
    return { id, name: nameOf(id), ok: true, sizes: lines.map((l) => String(l.size)), units: lines.reduce((t, l) => t + l.qty, 0) };
  });
  const base = {
    key: rowKey(section, "sneakers", card.pid), kind: "sneakers", section, pid: card.pid,
    name: card.name || card.pid, photo: card.photo || null, card,
    source: central, sourceName: nameOf(central), twin: card.duplicateOf || null,
  };
  if (!out.some((d) => d.ok)) {
    const policied = typeof hasPolicy === "function" ? dests.some((d) => hasPolicy(card, d)) : true;
    const why = !dests.length ? "noShop" : refused === dests.length ? "otherHub" : requested ? "requested" : !policied ? "noPolicy" : "noSize";
    return { row: null, why };
  }
  return { why: null, row: { ...base, stock: [...counted.values()].reduce((t, n) => t + n, 0), dests: out.filter((d) => d.ok) } };
}

// ── THE ORDER IS FROZEN WHILE THE SCREEN IS OPEN ─────────────────────────────
// A list remembers the order its rows were first seen in. A row that leaves
// keeps its place (so an Undo puts it back where it was); a row never seen
// before joins at the END. Nothing visible is ever re-sorted.
export function createFrozenOrder() {
  return { order: [], seen: new Set() };
}
/** Fold the keys currently on the list into the frozen order; returns it. */
export function freezeOrder(frozen, keys) {
  for (const k of keys || []) {
    if (frozen.seen.has(k)) continue;
    frozen.seen.add(k);
    frozen.order.push(k);
  }
  return frozen.order;
}

// ── THE DIVISION GATE, AT THE TAP ────────────────────────────────────────────
/** Why this tap must not go through — or null. The row is the one on screen. */
export function tapProblem({ row, dest }) {
  const d = row?.dests?.find((x) => x.id === dest);
  if (!d) return "That is not a destination on this list.";
  if (!d.ok) return `Nothing to send to ${d.name}.`;
  return null;
}

// pid → Set(location) of every OPEN request (fully sent or not — units in
// transit still mean the product belongs there). For ownership, not reserving.
export function openLocationsByProduct(requests) {
  const out = new Map();
  for (const r of Array.isArray(requests) ? requests : Object.values(requests || {})) {
    if (!r || typeof r !== "object" || r.status !== "open" || r.shadow || !r.productId || !r.requestingLocation) continue;
    let s = out.get(r.productId);
    if (!s) { s = new Set(); out.set(r.productId, s); }
    s.add(r.requestingLocation);
  }
  return out;
}
// A seat is a record (an object) — the engine's own test (concreteDivision.js).
export const isSeat = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// ── WHO OWNS A PRODUCT, AMONG ONE-OR-THE-OTHER SHOPS ─────────────────────────
// Junid's words (22 Nov 2026): a product belongs to a shop when it has STOCK
// there (units, not an empty row left by a count), is SEATED there, or has a
// request QUEUED for it there. Returns the shops of `shops` that own it.
//   cells     { shop: { size: cell } } for this product (decoded cells)
//   seated    (shop) → bool
//   queued    (shop) → bool
export function shopOwners({ shops = [], cells = {}, seated = () => false, queued = () => false }) {
  return shops.filter((s) => Object.values(cells[s] || {}).some((c) => Number(c?.qty) > 0) || seated(s) || queued(s));
}

// ── A CHOICE ON ONE CARD ─────────────────────────────────────────────────────
// Tap a location: chosen; tap it again: not. Where the locations are one or
// the other (Pine / Concrete, Hub 1 / Hub 2) a tap switches the other off.
export function pickNext(current, dest, { exclusive = false } = {}) {
  const cur = Array.isArray(current) ? current : [];
  if (cur.includes(dest)) return cur.filter((d) => d !== dest);
  return exclusive ? [dest] : [...cur, dest];
}
