// ─── SECTIONS RETURN REPAIR — THE PLAN (PURE) ────────────────────────────────
//
// Before the section wall, a return taken at Marathon PE or Trophy could be
// booked to a Section 1 location. This decides, for each such return in the
// window, whether the unit can be moved back to the Section 2 hub the ORIGINAL
// SALE deducted from — and refuses to guess when it cannot.
//
//   moves           safe to apply: one corrective transfer each
//   shortAtSource   the Section 1 cell no longer holds the unit (sold or moved
//                   since) — listed, never forced
//   undetermined    the original sale, or the hub it deducted, cannot be found
//                   as a Section 2 hub — listed, NO fallback applied
//   notSection2     the return was taken in Section 1 itself: nothing to repair
//   alreadyRepaired the repair log already has it
//
// No I/O. The runner (return-repair.mjs) gathers the inputs and applies the
// plan; the same function plans the dry run and the live run.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const reg = require("../../functions/lib/network-registry.cjs");

export const REPAIR_REASON = "sections-return-repair";
export const LOG_ROOT = "sections_repair/returns";

const encodeSizeKey = (size) => String(size).replace(/\./g, "_");
// An RTDB key cannot hold . $ # [ ] /. Movement ids use ":" and encoded sizes,
// so this is the id itself in practice; the replace is the guarantee.
export const logKeyFor = (returnMvId) => String(returnMvId).replace(/[.$#[\]/]/g, "_");
export const repairMovementId = (returnMvId) => `repair:sections-return:${logKeyFor(returnMvId)}`;
export const cellKey = (loc, pid, size) => `${loc}|${pid}|${encodeSizeKey(size)}`;
export const soldKey = (saleId, pid, size) => `${saleId}|${pid}|${encodeSizeKey(size)}`;

// A layby's completion sale is "<id>~C"; its goods were deducted under "<id>".
export function deductionRecordIds(recordId) {
  if (typeof recordId !== "string" || recordId.length < 3) return [];
  return recordId.endsWith("~C") ? [recordId, recordId.slice(0, -2)] : [recordId];
}

// Which original sale(s) a return movement points at, from the return record.
export function originalSaleIdsFor(ret, record) {
  const ids = new Set();
  for (const l of Object.values(record?.lineItems || {})) {
    if (!l || l.productId !== ret.productId) continue;
    if (encodeSizeKey(l.size ?? "_") !== encodeSizeKey(ret.size)) continue;
    if (l.originalSaleId) for (const id of deductionRecordIds(l.originalSaleId)) ids.add(id);
  }
  // Refund / void / layby cancel rebuild their moves from ONE stored record and
  // key the movement by it: the record itself is the original.
  if (!ids.size) for (const id of deductionRecordIds(ret.recordId)) ids.add(id);
  return [...ids];
}

export function planRepair({ returns = [], records = {}, soldCells = {}, cells = {}, log = {}, registry = null } = {}) {
  const R = registry || reg.SEED_REGISTRY;
  const out = { moves: [], shortAtSource: [], undetermined: [], notSection2: [], alreadyRepaired: [], notSection1Destination: [] };
  const spoken = new Map();   // source cell → units already claimed by an earlier move in THIS plan

  const ordered = [...returns].sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.mvId).localeCompare(String(b.mvId)));
  for (const ret of ordered) {
    const base = { returnMovementId: ret.mvId, returnRecordId: ret.recordId, productId: ret.productId, size: ret.size, qty: Number(ret.qty) || 0, bookedTo: ret.to, ts: ret.ts };
    if (reg.sectionOf(R, ret.to) !== 1) { out.notSection1Destination.push(base); continue; }
    const record = records[ret.recordId];
    const takenAt = record ? reg.locationOf(R, record.storeId) : null;
    if (!takenAt || takenAt.type !== "store") {
      out.undetermined.push({ ...base, why: record ? `the return record names no known store (${record.storeId ?? "none"})` : "the return record was not found" });
      continue;
    }
    if (takenAt.section !== 2) { out.notSection2.push({ ...base, takenAt: takenAt.id }); continue; }
    const withStore = { ...base, takenAt: takenAt.id };

    const entry = log[logKeyFor(ret.mvId)];
    if (entry && entry.status === "done") { out.alreadyRepaired.push({ ...withStore, toHub: entry.toHub }); continue; }

    const originals = originalSaleIdsFor(ret, record);
    const found = [...new Set(originals.map((id) => soldCells[soldKey(id, ret.productId, ret.size)]).filter(Boolean))];
    if (found.length !== 1) {
      out.undetermined.push({ ...withStore, originalSaleIds: originals, why: found.length ? `the original sale deducted more than one cell (${found.join(", ")})` : "no sold movement was found for the original sale" });
      continue;
    }
    const hub = reg.locationOf(R, found[0]);
    if (!hub || hub.type !== "hub" || hub.section !== 2) {
      out.undetermined.push({ ...withStore, originalSaleIds: originals, soldFrom: found[0], why: `the original sale deducted ${reg.locationName(R, found[0])}, which is not a Section 2 hub` });
      continue;
    }
    if (!(withStore.qty > 0)) { out.undetermined.push({ ...withStore, why: "the return movement has no quantity" }); continue; }

    const src = cellKey(ret.to, ret.productId, ret.size);
    const onHand = Number(cells[src]) || 0;
    const taken = spoken.get(src) || 0;
    if (onHand - taken < withStore.qty) {
      out.shortAtSource.push({ ...withStore, toHub: hub.id, onHand, alreadyClaimedByEarlierMoves: taken });
      continue;
    }
    spoken.set(src, taken + withStore.qty);
    out.moves.push({
      ...withStore, from: ret.to, toHub: hub.id, originalSaleIds: originals,
      movementId: repairMovementId(ret.mvId), logKey: logKeyFor(ret.mvId),
    });
  }
  return out;
}

// The one multi-path update for ONE move. `fromCell` / `toCell` are the live
// cells read immediately before; returns null if the source can no longer cover it.
export function buildMoveUpdate(move, { fromCell, toCell, nowIso, actor }) {
  const fromQty = fromCell && typeof fromCell.qty === "number" ? fromCell.qty : 0;
  const toQty = toCell && typeof toCell.qty === "number" ? toCell.qty : 0;
  if (fromQty < move.qty) return null;
  const sizeKey = encodeSizeKey(move.size);
  const stamp = (cell, qty) => ({ ...(cell || {}), qty, v: (Number(cell?.v) || 0) + 1, lastType: "transfer_out", mv: move.movementId, updatedAt: nowIso, updatedBy: actor });
  return {
    [`stock/${move.from}/${move.productId}/${sizeKey}`]: stamp(fromCell, fromQty - move.qty),
    [`stock/${move.toHub}/${move.productId}/${sizeKey}`]: stamp(toCell, Math.max(toQty, 0) + move.qty),
    [`stock_movements/${move.movementId}`]: {
      type: "transfer_out", productId: move.productId, size: sizeKey, qty: move.qty,
      from: move.from, to: move.toHub, reason: REPAIR_REASON, actor, ts: nowIso,
      link: { returnMovementId: move.returnMovementId, returnRecordId: move.returnRecordId, originalSaleIds: move.originalSaleIds },
      before: { [move.from]: fromQty, [move.toHub]: toQty },
      after: { [move.from]: fromQty - move.qty, [move.toHub]: Math.max(toQty, 0) + move.qty },
    },
    [`${LOG_ROOT}/${move.logKey}`]: {
      status: "done", returnMovementId: move.returnMovementId, returnRecordId: move.returnRecordId,
      productId: move.productId, size: sizeKey, qty: move.qty, from: move.from, toHub: move.toHub,
      takenAt: move.takenAt, repairMovementId: move.movementId, at: nowIso, by: actor,
    },
  };
}

export function unitsByProductSizeHub(moves) {
  const out = {};
  for (const m of moves) {
    const k = `${m.productId}|${encodeSizeKey(m.size)}|${m.toHub}`;
    out[k] = (out[k] || 0) + m.qty;
  }
  return out;
}
