// ─── SOLVE, BOTH SECTIONS, ONE CONFIRM (pure, testable) ──────────────────────
// The Missing Products Solve used to nominate ONE of Marathon PE / Trophy.
// With two sections it is one screen: a block per section, a tick per store,
// and one confirm. This module is the part of that screen that DECIDES — which
// stores may be ticked, in what order Central's units are dealt, and what each
// ticked store will actually get — so the panel can show it before the confirm
// and the write can do exactly what was shown.
//
// IT IS THE SAME SOLVE, per store. Each ticked store goes through the very
// functions a single-store Solve always used — qualifyingSizes, firstBatchSplit,
// buildFirstBatchSolveUpdate, seedLocations — with one thing passed in that
// used to be a constant: the HUB, which is that store's own back-stock hub
// (sectionRouting.solveHubFor — Hub 2 for Marathon PE and Trophy, Hub 3 for
// Pine, Hub 3 or the Concrete Stockroom for Concrete). A confirm with one
// Section 2 store ticked is, write for write, the Solve it replaced.
//
// THE WALL holds by construction: a store's excess goes to ITS hub, and the
// registry only ever maps a store to a hub on its own side. Central feeds
// both, so one product can be solved into both sections in one confirm.
//
// LIVE: a store that is not live (or whose hub is not) is shown, and cannot
// be ticked; nothing is planned or written for it (sectionRouting.solveStoreBlock).
//
// CENTRAL CAN RUN SHORT across several stores. The units are dealt
// deterministically — store by store in the order they were ticked, each
// taking min(its policy, what is left, the per-request cap) per size — and no
// unit is promised twice: what a store takes is gone for the next.

import { firstBatchSplit } from "./firstBatchCore";
import { net, storeIds, nameOf, solveHubFor, solveStoreBlock } from "./sectionRouting";
import { sectionName, sectionsInOrder } from "../../utils/networkRegistry";

// The blocks the panel renders: one per section the viewer may see, each with
// its stores in registry order.
//   { section, name, stores: [{ id, name, hub, hubName, blocked }] }
// `blocked` is null (tickable) or the plain sentence shown beside the tick.
export function solveBlocks({ network, sections = [1, 2], source, product, productId } = {}) {
  const N = net(network);
  return sectionsInOrder(N, sections).map((section) => ({
    section,
    name: sectionName(N, section),
    stores: storeIds(N, { section }).map((id) => {
      const hub = solveHubFor(N, id, product, productId);
      return { id, name: nameOf(id, N), hub, hubName: hub ? nameOf(hub, N) : null, blocked: solveStoreBlock(N, { source, store: id, hub }) };
    }),
  })).filter((b) => b.stores.length > 0);
}

// The order Central's units are dealt in: the order the stores were ticked.
// Stores that arrive with no order of their own (a default selection of
// several) fall in registry sort order. A store ticked twice counts once; a
// store that may not be ticked is dropped.
export function allocationOrder({ network, ticked = [], tickable } = {}) {
  const N = net(network);
  const rank = new Map(storeIds(N).map((id, i) => [id, i]));
  const seen = new Set();
  const out = [];
  for (const s of ticked) {
    if (seen.has(s) || !rank.has(s)) continue;
    if (typeof tickable === "function" && !tickable(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
// A selection with no order (e.g. restored from a set): registry order.
export const registryOrder = (network, stores) => {
  const all = storeIds(net(network));
  return [...new Set(stores || [])].filter((s) => all.includes(s)).sort((a, b) => all.indexOf(a) - all.indexOf(b));
};

// What each ticked store will get.
//   stores        the allocation order (allocationOrder)
//   storeInfo(s)  → { hub, sizes, eligible, sizeHints } for one store:
//                   `sizes` its qualifying sizes (solvePlan.qualifyingSizes
//                   with its hub), `eligible` whether its Solve takes the
//                   first-batch path (firstBatchCore.firstBatchEligible with
//                   its hub), `sizeHints` its history hints (optional)
//   run           resolvedRun's map
//   centralFree   (size) → Central's units free of open reservations
// Returns one line per store, in order:
//   { store, hub, sizes, split, firstBatch, units, got: [{ size, qty }] }
// and `centralLeft(size)` — what Central still has after every store took its
// share. `split` is firstBatchSplit's own answer, computed over what the
// stores before it left, so the request quantities written are the ones
// shown. A store off the first-batch path takes nothing from Central in the
// Solve itself (it only seeds; the engine refills it), so it leaves the pool
// untouched.
export function planSectionSolve({ stores = [], storeInfo, run, centralFree, maxUnitsPerIntent } = {}) {
  const taken = {};   // size → units already dealt to an earlier store
  const free = (size) => Math.max((Number(typeof centralFree === "function" ? centralFree(size) : 0) || 0) - (taken[String(size)] || 0), 0);
  const lines = [];
  for (const store of stores) {
    const info = (typeof storeInfo === "function" ? storeInfo(store) : null) || {};
    const sizes = info.sizes || [];
    let split = null;
    if (info.eligible && sizes.length) {
      split = firstBatchSplit({ sizes, run, store, centralAvail: free, maxUnitsPerIntent, sizeHints: info.sizeHints });
      for (const l of split.firstBatch) taken[String(l.size)] = (taken[String(l.size)] || 0) + l.qty;
    }
    const got = split ? split.firstBatch.map((l) => ({ size: l.size, qty: l.qty })) : [];
    lines.push({
      store, hub: info.hub || null, sizes, split,
      firstBatch: !!(split && split.firstBatch.length),
      units: got.reduce((t, l) => t + l.qty, 0),
      got,
    });
  }
  return { lines, centralLeft: free, taken: { ...taken } };
}

// One multi-path update out of several stores' updates. Seeds are
// seed-if-absent and every seed of one confirm is the same cell value, so a
// path two stores share (both shops' hub) is written once; a request path is
// unique by construction. Returns the merged update.
export function mergeSolveUpdates(parts) {
  const out = {};
  for (const u of parts || []) for (const [k, v] of Object.entries(u || {})) if (!(k in out)) out[k] = v;
  return out;
}

// The seed paths an undo may delete: its own, minus any that another solve of
// the same product still standing in the undo list also wrote (two shops of
// one confirm share their hub's seeds — the hub must stay seeded while either
// shop's solve stands).
export function undoablePaths(entry, others) {
  const kept = new Set();
  for (const o of others || []) {
    if (!o || o.key === entry.key || o.pid !== entry.pid) continue;
    for (const p of o.paths || []) kept.add(p);
  }
  return (entry.paths || []).filter((p) => !kept.has(p));
}
