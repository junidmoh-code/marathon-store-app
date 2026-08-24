// ─── CARRIAGE STORE — the writes behind Unseat / Move seating ─────────────────
// Firebase edge for carriageCore. Every decision lives in the pure core; this
// file only performs, and the split is the point — the guards are unit-testable
// without a database, exactly like solveUndo/solveUndoBlockers.
//
// THREE WRITES, and each is deliberately shaped:
//
//   unseatCarriage  — per-cell TRANSACTIONS, never a multi-path delete. A batch
//                     delete cannot be conditional, so it would erase a cell
//                     that took a sale between the operator reading the row and
//                     tapping the button. One transaction per cell means the
//                     racing cell ABORTS and survives while its siblings go, and
//                     the report says which ones stayed.
//   seatCarriage    — seed-if-absent qty-0 cells, ONE atomic multi-path update.
//                     Opposite shape on purpose: a seed is safe to lose whole
//                     (nothing is destroyed by not writing it) and a half-seeded
//                     destination is the failure that matters, so it is
//                     all-or-nothing — the same call NetworkTransfer's Solve makes.
//   logCarriage     — the audit row. A delete leaves no /stock_movements entry,
//                     so without this the one irreversible stock action in the
//                     app would be its only unrecorded one.
//
// THE LOG IS WRITTEN FIRST, and its failure is non-blocking either way: an
// entry for an unseat that then aborted is a harmless over-record, whereas an
// unrecorded delete is the thing this module exists to stop happening again.

import { ref, get, update, push, runTransaction } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowIso, serverNowMs } from "../../utils/serverTime";
import { stockSizeKey, stockCellPath } from "../../utils/sizeKey";
import { CARRIAGE_LOG, carriageLogEntry, seedCell, unseatCellTxn, unseatPlan, movePlan } from "./carriageCore";

// The engine's open refill locks for one product at one location, as
// { sizeKey: lock } — the shape unseatPlan's `openLocks` expects. Read fresh at
// plan time: a lock claimed after this read is caught by the cell transaction
// (the engine bumps v), so this is a courtesy check that yields a readable
// sentence, not the safety guard.
export async function openLocksFor(loc, pid) {
  try {
    return (await get(ref(database, `refill_engine/open/${loc}/${pid}`))).val() || {};
  } catch {
    return {};
  }
}

// Audit first — see the header. Never throws into the caller: a failed log must
// not abort an unseat the operator has already confirmed.
export async function logCarriage(fields) {
  try {
    const id = push(ref(database, CARRIAGE_LOG)).key;
    const entry = carriageLogEntry({ ...fields, at: serverNowMs(), by: auth.currentUser?.uid || null });
    await update(ref(database), { [`${CARRIAGE_LOG}/${id}`]: entry });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

// Delete the named cells, each under its own guarded transaction. `paths` is
// carriageCore's [{ path, size, expect }] — a shape only a plan produces, so a
// caller cannot hand-roll a path this never vetted.
//
// A null `expect` means "guard on qty 0 alone" (unseatCellTxn treats an absent
// v/mv as "don't compare"): the fallback for a size whose pre-move v/mv is stale
// by construction. The qty-0 half is never optional — that is the guarantee that
// an unseat cannot remove stock.
export async function unseatCells(paths) {
  const kept = [], gone = [];
  for (const p of paths || []) {
    try {
      const res = await runTransaction(ref(database, p.path), unseatCellTxn(p.expect ?? null), { applyLocally: false });
      // `committed:false` is the guard firing, not an error — the cell took
      // real history and is meant to survive.
      if (res.committed) gone.push(p.size);
      else kept.push({ size: p.size, why: "changed while you were looking — still carried" });
    } catch (e) {
      kept.push({ size: p.size, why: String(e?.message || e) });
    }
  }
  return { gone, kept, ok: kept.length === 0 };
}

// Seed qty-0 carriage at `to` for each size, skipping any that already has a
// cell (a real quantity is never overwritten, and the SEED validate branch
// rejects a write onto an existing cell anyway — belt and rule).
export async function seatCells(to, pid, sizes) {
  const existing = (await get(ref(database, `stock/${to}/${pid}`))).val() || {};
  const now = serverNowIso();
  const uid = auth.currentUser?.uid || null;
  const updates = {};
  const seeded = [];
  for (const size of sizes || []) {
    if (existing[stockSizeKey(size)] !== undefined) continue;
    updates[stockCellPath(to, pid, size)] = seedCell({ uid, now });
    seeded.push(size);
  }
  if (!Object.keys(updates).length) return { ok: true, seeded: [] };
  await update(ref(database), updates);
  return { ok: true, seeded };
}

// ── UNSEAT ───────────────────────────────────────────────────────────────────
// The whole gesture: re-plan against a FRESH read (the row on screen may be
// seconds old), refuse loudly on any blocker, log, then delete.
//
// Re-planning rather than trusting the passed plan is what makes the confirm
// panel safe to leave open: a sale landing while the operator reads it turns
// the plan into a blocker sentence, not a silent erase.
export async function unseatCarriage({ loc, pid, name, note } = {}) {
  const user = auth.currentUser;
  if (!user) return { ok: false, blockers: ["You are signed out — sign in and try again."] };

  const live = (await get(ref(database, `stock/${loc}/${pid}`))).val() || {};
  const sizes = Object.entries(live).map(([k, c]) => ({
    size: k, hasCell: true, qty: Number(c?.qty || 0), v: Number(c?.v || 0), mv: c?.mv ?? null,
  }));
  const openLocks = await openLocksFor(loc, pid);
  const plan = unseatPlan({ loc, pid, name, sizes, openLocks });
  if (!plan.ok) return { ok: false, blockers: plan.blockers };

  await logCarriage({ action: "unseat", loc, pid, name, sizes: plan.paths.map((p) => p.size), note });
  const res = await unseatCells(plan.paths);
  return { ok: res.ok, gone: res.gone, kept: res.kept, blockers: [] };
}

// ── MOVE THE SEATING ─────────────────────────────────────────────────────────
// Transfer, then seed, then unseat — the ordering carriageCore's movePlan
// documents. `apply` is injected (the caller passes applyMovement) so this
// module keeps ONE stock writer between it and the ledger and the sequencing
// stays testable without mocking the movement engine's internals.
//
// A FAILED TRANSFER STOPS THE UNSEAT. If any line fails, the source still holds
// stock, so its claim is exactly right and must stay — the operator retries
// against a picture that never lied to them.
export async function moveCarriage({ loc, pid, name, sizes, to, amounts, moveSeating = true, actorRole, apply } = {}) {
  const plan = movePlan({ loc, pid, name, sizes, to, amounts, moveSeating });
  if (!plan.ok) return { ok: false, blockers: plan.blockers, moved: 0 };

  const batch = `seat_${serverNowMs().toString(36)}`;
  let moved = 0; const failed = [];
  for (const line of plan.transfers) {
    let res;
    try {
      res = await apply({
        type: "transfer_out", productId: pid, size: line.size, qty: line.qty,
        from: loc, to, cellState: "live", actorRole,
        reason: "carriage: seating moved",
        movementId: `${batch}_${pid}_${stockSizeKey(line.size)}`,
        link: { transferId: batch },
      });
    } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
    if (res?.ok) moved += line.qty; else failed.push(`${line.size}: ${res?.reason || "failed"}`);
  }

  if (!moveSeating) return { ok: !failed.length, moved, failed, seeded: [], gone: [], kept: [], blockers: [] };

  // Units did not all arrive → the source genuinely still stocks this. Leave the
  // claim where the stock is.
  if (failed.length) {
    return { ok: false, moved, failed, seeded: [], gone: [], kept: [],
             blockers: [`${failed.length} size(s) did not move, so the seating stays at the source. Retry once they do.`] };
  }

  await logCarriage({ action: "move", loc, pid, name, to, sizes: plan.unseat.map((u) => u.size) });

  let seeded = [];
  try { ({ seeded } = await seatCells(to, pid, plan.seeding)); }
  catch (e) {
    return { ok: false, moved, failed, seeded: [], gone: [], kept: [],
             blockers: [`Stock moved, but the destination could not be seated (${e?.message || e}). The source keeps its seating — retry.`] };
  }

  // Only now, and only against a fresh read: the transfers above bumped v/mv on
  // every size they touched, so the pre-move guard values are stale by
  // construction. Re-read gives each cell its real current triple, and any cell
  // that is no longer 0 (a sale in the meantime) fails the qty check and stays.
  const after = (await get(ref(database, `stock/${loc}/${pid}`))).val() || {};
  const paths = plan.unseat.map((u) => {
    const cell = after[stockSizeKey(u.size)];
    return { path: u.path, size: u.size,
             expect: cell ? { qty: Number(cell.qty || 0), v: Number(cell.v || 0), mv: cell.mv ?? null } : { qty: 0, v: 0, mv: null } };
  });
  const res = await unseatCells(paths);
  return { ok: res.ok, moved, failed, seeded, gone: res.gone, kept: res.kept, blockers: [] };
}
