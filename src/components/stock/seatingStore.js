// ─── SEATING — THE WRITES ─────────────────────────────────────────────────────
//
// ── SWITCHING OFF IS A FACT, NOT A DELETION ──────────────────────────────────
// Nothing here deletes a stock cell. The live rules would allow it — /stock's
// $size .write is any stockRole holder and RTDB skips .validate on a delete
// (checked against /.settings/rules.json on 2026-08-24) — so the refusal has to
// be this file's rule. A cell delete writes no ledger record, leaves no trace,
// and under the cell-existence engine silently changes what a shop is armed
// for. An explicit row says the same thing out loud, reversibly, with a name and
// a time on it, and that record IS the audit trail.
//
// ── THE MECHANISM ALREADY EXISTED; THIS IS NOT A SECOND ONE ──────────────────
// An explicit /stock_targets row is the FIRST branch of the engine's
// resolveTarget (refill-engine.cjs:468) and outranks the category policy, the
// footwear rule, the kill switch and the size run. `target: 0` therefore means
// "deliberately excluded" and always has — it is what the Decision Queue's
// Exclude button writes (NoTargetQueue.jsx:325). This file writes through THAT
// mechanism. A second off switch would be a second answer to one question.
//
// TWO THINGS EXCLUDE DOES NOT DO, AND THIS MUST:
//
//   1. COVER EVERY SIZE THE ENGINE ARMS. Exclude iterates the card's STOCKED
//      sizes. The engine's sizesFor() walks every DECLARED catalogue size once a
//      rule manages the product, so a size with no cell stays armed and the shop
//      keeps being asked for it. seatingSizes() returns the full union.
//
//   2. BE REVERSIBLE WITHOUT GUESSING. Exclude overwrites whatever row was
//      there and keeps no memory of it, so "undo" would have to invent numbers.
//      Each row written here carries the row it replaced (`prevRow`) or the fact
//      that there was none (`prevAbsent`). Re-seat restores exactly that and
//      touches nothing else — in particular it NEVER removes a hand-made row.
//      The 7,797 explicit rows on this node are the source of truth for the
//      products that carry them; they are edited in place and never deleted.
//
// ── OPEN REFILLS RETRACT THEMSELVES ──────────────────────────────────────────
// The engine's own withdrawal pass computes needGone as
// `!t || t.target <= 0 || …` from resolveTarget (refill-engine.cjs:774) and
// closes the request as `no_longer_needed`. A target-0 row therefore retracts
// every open request for that line at that location on the next scan, with no
// human rejecting anything — and that is true of the build actually DEPLOYED
// (the cell-existence one, verified by source zip 2026-08-24), not only of the
// reverted provenance build. Nobody is sent to the queue to tidy up.

import { ref, get, update } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowMs } from "../../utils/serverTime";
import { seatingSizes, seatingAt, SEATING_OFF_SOURCE } from "./seatingCore";
import { applyMovement } from "./applyMovement";
import { isTransitLane } from "./transitLanes";

// RTDB path segments: a junk size key must fail loudly here rather than write
// somewhere else. (Same guard as utils/sizeKey assertSafeSegment.)
const UNSAFE = /[.#$[\]/]/;

// ── THE REFUSAL ──────────────────────────────────────────────────────────────
// Switching off must never make stock disappear. A cell holding anything but
// zero blocks the action and the screen offers Move instead.
//
// NON-ZERO, NOT MERELY POSITIVE. A negative cell holds no units, but it is a
// live accuracy signal (only a `sold` may drive a cell below zero — see
// applyMovement's negative floor), and abandoning it at a shop that no longer
// carries the line hides a count error for good. Move carries negatives across
// with their sign intact, so the remedy this refusal points at handles the case.
export function switchOffBlockers(seat) {
  const held = seat.sizes.filter((s) => s.qty !== 0);
  if (!held.length) return null;
  const units = held.reduce((n, s) => n + s.qty, 0);
  return {
    sizes: held.map((s) => ({ size: s.size === "" ? "One size" : s.size, qty: s.qty })),
    units,
    negativeOnly: held.every((s) => s.qty < 0),
  };
}

// ── THE PLAN ─────────────────────────────────────────────────────────────────
// Every size the engine would arm here, each with the row it will replace.
// Pure — the screen can show it before anything is written.
export function switchOffPlan(ctx, loc, pid) {
  const rows = ctx.targets?.[loc]?.[pid] || {};
  return seatingSizes(ctx, loc, pid).slice().sort().map((sizeKey) => ({
    sizeKey,
    prev: rows[sizeKey] ?? null,
  }));
}

// The row that goes on the node. Kept separate from the write so a test can
// read it without a database.
export function offRow({ prev, actor, at, batchId }) {
  const row = {
    target: 0,
    minQty: 0,
    source: SEATING_OFF_SOURCE,
    batchId,
    offAt: at,
    offBy: actor.uid,
  };
  if (actor.email) row.offByEmail = actor.email;
  // RTDB deletes a key written null, so "there was no row" cannot be recorded
  // as `prevRow: null` — it has to be its own flag, or Re-seat could not tell
  // "restore nothing" from "restore a row I failed to capture".
  if (prev && typeof prev === "object") row.prevRow = prev;
  else row.prevAbsent = true;
  return row;
}

function actorOf(viewer) {
  const uid = auth?.currentUser?.uid;
  if (!uid) throw new Error("Not signed in.");
  return { uid, email: viewer?.email || auth?.currentUser?.email || null };
}

// ── SWITCH OFF ───────────────────────────────────────────────────────────────
// One location. One multi-path update, so the row set lands whole or not at all
// — a half-written switch-off would leave the shop armed for the sizes that
// missed, which is the failure this feature exists to end.
export async function switchOff({ seat, ctx, viewer }) {
  const blockers = switchOffBlockers(seat);
  if (blockers) return { ok: false, reason: "holds_units", blockers };

  const actor = actorOf(viewer);
  const at = serverNowMs();                       // never Date.now() — the tills
  const batchId = `seating_${at.toString(36)}`;   // and this browser disagree
  const plan = switchOffPlan(ctx, seat.loc, seat.pid);
  if (!plan.length) return { ok: false, reason: "no_sizes" };

  const upd = {};
  for (const { sizeKey, prev } of plan) {
    if (UNSAFE.test(sizeKey) || UNSAFE.test(seat.loc) || UNSAFE.test(seat.pid)) {
      return { ok: false, reason: "unsafe_key", sizeKey };
    }
    upd[`stock_targets/${seat.loc}/${seat.pid}/${sizeKey}`] = offRow({ prev, actor, at, batchId });
  }
  await update(ref(database), upd);
  return { ok: true, batchId, rowCount: plan.length };
}

// ── RE-SEAT ──────────────────────────────────────────────────────────────────
// Removes the delist fact and NOTHING else. Only rows this screen wrote are
// touched (`source === "seating_off"`); a hand-made row, or one the Decision
// Queue wrote, is somebody else's decision and is left exactly as it is.
//
// A row stamped by this screen but missing its provenance is NOT guessed at —
// it is reported and left, because inventing a target is the one outcome worse
// than doing nothing.
export function reseatPlan(ctx, loc, pid) {
  const rows = ctx.targets?.[loc]?.[pid] || {};
  const restore = [];
  const stuck = [];
  for (const sizeKey of Object.keys(rows).sort()) {
    const r = rows[sizeKey];
    if (r?.source !== SEATING_OFF_SOURCE) continue;
    if (r.prevAbsent === true) restore.push({ sizeKey, to: null });
    else if (r.prevRow && typeof r.prevRow === "object") restore.push({ sizeKey, to: r.prevRow });
    else stuck.push(sizeKey);
  }
  return { restore, stuck };
}

export async function reseat({ seat, ctx }) {
  const { restore, stuck } = reseatPlan(ctx, seat.loc, seat.pid);
  if (!restore.length) return { ok: false, reason: "nothing_to_undo", stuck };
  const upd = {};
  for (const { sizeKey, to } of restore) {
    upd[`stock_targets/${seat.loc}/${seat.pid}/${sizeKey}`] = to;
  }
  await update(ref(database), upd);
  return { ok: true, rowCount: restore.length, stuck };
}

// A live re-read of one (location, product) target row set — used after a write
// so the screen never renders a plan against numbers it no longer holds.
export async function readTargets(loc, pid) {
  const snap = await get(ref(database, `stock_targets/${loc}/${pid}`));
  return snap.exists() ? snap.val() : {};
}


// ═════════════════════════════════════════════════════════════════════════════
// MOVE AND SWITCH OFF
// ═════════════════════════════════════════════════════════════════════════════
//
// Every size of one product out of one location, into another, and the source
// switched off in the same action. EVERY stock write goes through
// applyMovement — the single writer to /stock — so the cells and the ledger
// movement land in one atomic update, the version guard holds, and a repeat is
// idempotent on the movement id.
//
// ── NEGATIVES ARE CARRIED, WITH THEIR SIGN ───────────────────────────────────
// A -2 cell holds no units; it is an accuracy signal, and only a `sold` can
// create one (applyMovement's negative floor). Leaving it behind at a shop that
// no longer carries the line hides a count error for good, and "moving" it as
// if it were +2 would invent two units out of nothing.
//
// So a negative line is sent THE OTHER WAY: a transfer_out of 2 from the
// DESTINATION to the SOURCE. The source cell rises -2 → 0 and the destination
// falls by 2, which is the same debt in the same network, now sitting where the
// line does. That leg needs allowNegative because it is the one case where
// driving a cell below zero is the correct outcome; the live rule permits it
// (a transfer_out may be negative — /stock's .validate, checked 2026-08-24).
//
// ── THE DESTINATION IS NOT WRITTEN A SEATING FACT ────────────────────────────
// It establishes carriage naturally: applyMovement creates its cell, and cell
// existence is what the deployed engine's storeCarries answers. Writing it a row
// as well would put a second, weaker answer next to the real one.

// Lines are per SIZE, in size-key order, and only cells that hold something.
export function movePlan(ctx, loc, pid) {
  const seat = seatingAt(ctx, loc, pid);
  return seat.sizes
    .filter((s) => s.qty !== 0)
    .map((s) => ({ sizeKey: s.sizeKey, size: s.size, qty: s.qty }));
}

// Why a destination cannot be chosen — null when it can.
export function moveBlockers(from, to) {
  if (!to) return "Pick where it goes.";
  if (to === from) return "That is the same location.";
  // Cross-building sends out of Central are a TWO-STEP transit lane (T1): stock
  // parks in in_transit and reaches the destination only when somebody scans it
  // in. This screen does one confirm and one hop, so it declines the lane rather
  // than quietly bypassing the receive step. Transfer already does it properly.
  if (isTransitLane(from, to)) return "That lane goes through Transit — use the Transfer screen.";
  return null;
}

// ── the action ───────────────────────────────────────────────────────────────
// Lines first, THEN the switch-off — and the switch-off re-reads before it
// decides. A sale landing mid-move must not be switched off out of existence:
// the re-read sees the non-zero cell, the refusal fires, the stock is already
// safely moved, and the screen says the seat is still on.
export async function moveAndSwitchOff({ seat, ctx, viewer, dest, alsoSwitchOff = true, locations }) {
  const blocked = moveBlockers(seat.loc, dest);
  if (blocked) return { ok: false, reason: "destination", message: blocked };

  const lines = movePlan(ctx, seat.loc, seat.pid);
  if (!lines.length) return { ok: false, reason: "nothing_to_move" };

  const actor = actorOf(viewer);
  const at = serverNowMs();
  const batchId = `seatmove_${at.toString(36)}`;
  let moved = 0;
  const failed = [];

  for (const line of lines) {
    const negative = line.qty < 0;
    const qty = Math.abs(line.qty);
    let res;
    try {
      res = await applyMovement({
        type: "transfer_out",
        productId: seat.pid,
        size: line.size,
        qty,
        from: negative ? dest : seat.loc,
        to: negative ? seat.loc : dest,
        actorRole: "admin",
        reason: "seating_move",
        movementId: `${batchId}_${seat.pid}_${line.sizeKey}`,
        link: { transferId: batchId },
        ...(negative ? { allowNegative: true } : null),
      });
    } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
    if (res.ok) moved += qty;
    else failed.push(`${line.size === "" ? "One size" : line.size}: ${res.reason}`);
  }

  if (!alsoSwitchOff) return { ok: true, moved, failed, batchId, switchedOff: false };
  if (failed.length) return { ok: true, moved, failed, batchId, switchedOff: false, offSkipped: "lines_failed" };

  // RE-READ, do not trust the plan. The cells this screen was rendering are
  // several round trips old by now, and the switch-off's whole guarantee is
  // that it never fires over stock.
  const fresh = await readSeatingContext(locations, seat.pid);
  const freshCtx = { ...ctx, stock: fresh.stock, targets: fresh.targets };
  const freshSeat = seatingAt(freshCtx, seat.loc, seat.pid);
  const off = await switchOff({ seat: freshSeat, ctx: freshCtx, viewer });
  return { ok: true, moved, failed, batchId, switchedOff: off.ok, offReason: off.ok ? null : off.reason };
}

// The same scoped read the tab makes, so the re-read above cannot drift from it.
export async function readSeatingContext(locs, pid) {
  const stock = {};
  const targets = {};
  await Promise.all((locs || []).flatMap((loc) => [
    get(ref(database, `stock/${loc}/${pid}`)).then((s) => { if (s.exists()) stock[loc] = { [pid]: s.val() }; }),
    get(ref(database, `stock_targets/${loc}/${pid}`)).then((s) => { if (s.exists()) targets[loc] = { [pid]: s.val() }; }),
  ]));
  return { stock, targets };
}
