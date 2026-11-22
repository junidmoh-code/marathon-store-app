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
export function productRow({ card, section, product, dests = [], tickable = [], planFor, openByLoc = {}, allStock, central = "central", routes, nameOf = (x) => x }) {
  if (!card || !product || isSneakerOrSlide(product)) return null;
  const can = new Set(tickable);
  const reserved = centralReservedBySize({ openByLoc, routes });
  const sourceCells = allStock?.[card.source]?.[card.pid];
  const free = (size) => (card.source === central
    ? centralFreeFor({ qtyAt: (x) => qtyIn(sourceCells, x), reserved, size })
    : qtyIn(sourceCells, size));
  const counted = new Map();   // size → free units, over every size any live button sends
  const out = dests.map((id) => {
    const dead = { id, name: nameOf(id), ok: false, sizes: [], units: 0 };
    if (!can.has(id)) return dead;
    let line;
    try { line = planFor(card, [id], openByLoc)?.lines?.[0]; } catch { line = null; }
    if (!line || !(line.sizes || []).length) return dead;
    // A shop fed straight from Central is sent the sizes Central has, and
    // nothing is written for the rest. A shop behind a hub is seeded for every
    // size its policy covers; what MOVES is what the source holds.
    const direct = !line.hub;
    const sizes = direct ? (line.got || []).map((g) => String(g.size)) : line.sizes.map(String).filter((s) => free(s) > 0);
    if (!sizes.length) return dead;
    // (never below what the plan sends of that size — the two read one shelf)
    for (const s of sizes) counted.set(s, Math.max(free(s), direct ? Number((line.got || []).find((g) => String(g.size) === s)?.qty) || 0 : 0));
    return { id, name: nameOf(id), ok: true, sizes, units: line.units || 0 };
  });
  if (!out.some((d) => d.ok)) return null;
  return {
    key: rowKey(section, "clothing", card.pid), kind: "clothing", section, pid: card.pid,
    name: card.name || card.pid, photo: card.photo || null, card,
    source: card.source, sourceName: nameOf(card.source),
    stock: [...counted.values()].reduce((t, n) => t + n, 0),
    dests: out, twin: null,
  };
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
// NEEDS POLICY — the one card that is shown although nothing can be sent
// (Junid, 22 Nov 2026). A shoe Central holds, that nobody has requested, whose
// sizes NO policy names at any of the list's hubs (a kids shoe, 24–35, under a
// footwear run that speaks for 3–13) is not "queued" and is not "out of
// stock": it is waiting for Junid to give it numbers, and he has to SEE it to
// do that. `hasPolicy(card, hub)` says whether any of its sizes has a number
// there; `requested` whether any open request for it exists.
export function sneakerRow({ card, section, dests = [], planFor, refusal = () => null, blocked = false, central = "central", nameOf = (x) => x, hasPolicy = null, requested = false }) {
  if (!card || blocked) return null;
  const counted = new Map();
  const out = dests.map((id) => {
    const dead = { id, name: nameOf(id), ok: false, sizes: [], units: 0 };
    let lines;
    try { lines = planFor(card, id) || []; } catch { lines = []; }
    if (!lines.length || refusal(card, [id])) return dead;
    for (const l of lines) counted.set(String(l.size), Math.max(Number(l.avail) || 0, 0));
    return { id, name: nameOf(id), ok: true, sizes: lines.map((l) => String(l.size)), units: lines.reduce((t, l) => t + l.qty, 0) };
  });
  const base = {
    key: rowKey(section, "sneakers", card.pid), kind: "sneakers", section, pid: card.pid,
    name: card.name || card.pid, photo: card.photo || null, card,
    source: central, sourceName: nameOf(central), twin: card.duplicateOf || null,
  };
  if (!out.some((d) => d.ok)) {
    const unarmed = typeof hasPolicy === "function" && dests.length > 0 && !requested && !dests.some((d) => hasPolicy(card, d));
    return unarmed ? { ...base, needsPolicy: true, stock: Math.max(Number(card.centralUnits) || 0, 0), dests: out } : null;
  }
  return { ...base, stock: [...counted.values()].reduce((t, n) => t + n, 0), dests: out };
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
