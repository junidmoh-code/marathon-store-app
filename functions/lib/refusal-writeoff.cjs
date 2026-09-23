// ─── WRITE-OFF AFTER FOUR REFUSED DAYS (owner rule, 2026-09-23) ──────────────
//
// THE RULE, in Junid's words: a location that has said "out of stock" to one
// product/size on four DIFFERENT calendar days (Africa/Johannesburg), with no
// fulfilment of that size in between, does not have it. Erase it automatically
// and let the flow restart. Being over later is acceptable; a frozen size is
// not. It applies to Hub 1, Hub 2 and Central — the locations requests are
// sourced FROM. Marathon Pine is excluded (still moving off Lightspeed).
//
// WHY. Until now the fourth refusal parked the cell on Recount Needed (the
// reject-streak loop guard in refill-engine.cjs) and waited for a person to
// count it. Nobody counted, so the phantom quantity stayed on paper and the
// size was frozen — Nike Tech Fleece Tracksuit Brown 2, Hub 2 / M, refused on
// 12, 14, 16 and 17 Sep with 3 still on paper, is the case that started it.
//
// WHAT IT ERASES — and what it never does:
//   • ONE cell: the refused size at the refusing location. Never another size,
//     never another location.
//   • Only stock that was ON PAPER BEFORE THE REFUSALS. Anything that arrived
//     at the cell after the first counted refusal (a Central delivery, a #641
//     "for shop" pass-through leg that has landed, a return, a recount) is
//     protected, and stock still in transit is not in the cell at all. So:
//
//         write-off = min( today's count − arrivals since the first refusal,
//                          the count the cell held when the first refusal came )
//
//     floored at 0. The second bound is read from the ledger (the `before` of
//     the first movement to touch the cell after that refusal), so a sale that
//     happened in between can never make us erase more than was there.
//   • No reason codes, no proof-of-existence checks, no found-stock handling
//     (ruled out by the owner). Four days is the evidence.
//
// WHAT COUNTS AS A REFUSAL / A FULFILMENT. Read from /refill_requests — the one
// durable record of every request (the /orders lines behind shop legs recycle
// daily). A refusal is the shape the engine already treats as a human "no":
// status "cancelled" with NO cancelReason. A fulfilment is status "fulfilled",
// or any request the location started sending (sentQty > 0) — it found some.
// The refusing location is the request's source (createdFrom.source, else the
// route). Refusals from ANY requester count toward the location: Marathon PE
// and Trophy both asking Hub 2 are both Hub 2 saying no.
//
// A RUN is the refusals since the location last fulfilled the size AND since
// the last write-off of this cell (the cursor). One run is written off once,
// ever: the movement id is derived from the run's last refusal, and the
// cursor moves past it in the same write as the record.
//
// This module is PURE: it plans. functions/refill-scan.cjs applies the plan
// through applyMovementAdmin (the server-side applyMovement) before the
// engine plans, so the same scan sees the empty cell, drops it from Recount
// Needed, and asks upstream as usual.

"use strict";

const { stockCellKey } = require("./admin-movement.cjs");

const WRITEOFF_LOCATIONS = Object.freeze(["hub1", "hub2", "central"]);
const EXCLUDED_LOCATIONS = Object.freeze(["marathon-pine"]);
const MIN_DISTINCT_DAYS = 4;
const MOVEMENT_TYPE = "refusal_writeoff";
const ACTOR = "system:refusal-writeoff";

// Movement types that ADD units to their `to` cell. Mirrors applyMovement's
// cellDeltas (the +leg of a transfer lands on `to`). A negative adjustment
// carries `from`, never `to`, so it is not an arrival.
const ARRIVAL_TYPES = new Set(["received", "opening", "return", "adjustment", "transfer_in", "transfer_out"]);

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const msOf = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const t = Date.parse(v || "");
  return Number.isFinite(t) ? t : 0;
};

// Africa/Johannesburg is UTC+2 all year (no daylight saving).
function sastDay(ms) {
  return new Date(ms + 2 * 3600e3).toISOString().slice(0, 10);
}

function refusingLocation(rr, routes) {
  return rr?.createdFrom?.source || rr?.source || routes?.[rr?.requestingLocation] || null;
}

// A request the location actually SENT is a fulfilment whatever its status
// says: an "Out of Stock" tap on a stale list can overwrite a row that was
// already fulfilled (live: -P28C3fKttMx5YtJGvp2, cancelled with fulfilledBy
// and a real transfer out of Central — second-brain review, PR #642).
const isFulfilment = (rr) => rr.status === "fulfilled" || num(Number(rr.sentQty)) > 0
  || !!(rr.fulfilledBy && typeof rr.fulfilledBy === "object");
// Stock physically LEAVING the cell by transfer is the location finding the
// size, whether or not a request row says so (the sale-driven queue's
// srcful_* sends never appear in /refill_requests at all).
const SENT_TYPES = new Set(["transfer_out", "transfer_in"]);
// Central's "Out of Stock" on a first-batch shop leg is stamped with this
// reason (RefillQueue.jsx) so it is not a strike at the SHOP's cell — but it is
// still Central saying the size is not there.
const CENTRAL_DECLINED_REASON = "first_batch_central_declined";
const isRefusal = (rr) => rr.status === "cancelled" && !(num(Number(rr.sentQty)) > 0)
  && (!rr.cancelReason || rr.cancelReason === CENTRAL_DECLINED_REASON);

// RTDB-safe, deterministic, and ordered by the run's last refusal — the id is
// the movement id, the record key and the idempotency key all at once.
function writeoffId(loc, pid, cellKey, lastRefusalMs) {
  return `rwo_${lastRefusalMs}_${loc}_${pid}_${cellKey}`.replace(/[.#$/\[\]\s]/g, "_");
}

// A /stock row can be ARRAY-coerced (dense integer size keys): index access
// works on both shapes, and a hole reads null.
function cellAt(stock, loc, pid, cellKey) {
  const row = stock?.[loc]?.[pid];
  if (!row || typeof row !== "object") return null;
  const c = row[cellKey];
  return c && typeof c === "object" ? c : null;
}

/**
 * snapshot: { nowMs, config, stock, products, refillRequests, movements,
 *             cursors, windowStartMs }
 *   cursors        /refill_engine/refusalWriteoffCursor — {loc:{pid:{cellKey:{throughMs}}}}
 *   windowStartMs  the start of the movements read (the scan's ledger window);
 *                  arrivals older than it are invisible, so a run whose first
 *                  refusal predates it is judged only when the cell has not
 *                  been written since (see below).
 * → { writeoffs: [...], deferred: [...] }
 */
function planRefusalWriteoffs(snapshot) {
  const {
    config = {}, stock = {}, products = {}, refillRequests = {}, movements = [],
    cursors = {}, windowStartMs = 0,
  } = snapshot || {};
  const out = { writeoffs: [], deferred: [] };
  if (config?.refusalWriteoff?.enabled === false) return out;   // live kill switch
  const routes = config?.routes || {};
  const allowed = new Set(WRITEOFF_LOCATIONS);

  // ── group every request by the cell it asked (location × product × size) ──
  const groups = new Map();
  const openAt = new Set();   // cells with a request still OPEN against them
  for (const [id, rr] of Object.entries(refillRequests || {})) {
    if (!rr || !rr.productId || rr.size == null) continue;
    // Shadow-mode PREVIEW rows (refill-scan shadowSyncUpdates) are never
    // picked, fulfilled or refused — they say nothing. (CodeRabbit)
    if (rr.shadow === true || String(id).startsWith("SHDWrr-")) continue;
    const loc = refusingLocation(rr, routes);
    if (!allowed.has(loc)) continue;
    const cellKey = stockCellKey(rr.size);
    const key = `${loc}|${rr.productId}|${cellKey}`;
    if (rr.status === "open") { openAt.add(key); continue; }
    const fulfilled = isFulfilment(rr);
    if (!fulfilled && !isRefusal(rr)) continue;   // an engine withdrawal says nothing
    if (!fulfilled && rr.cancelReason === CENTRAL_DECLINED_REASON && loc !== "central") continue;
    // Pine's refusals never count toward a write-off. A fulfilment TO Pine
    // still does — the location found the size — and so does an open Pine
    // request above (someone may be picking it). Found by the property fuzz.
    if (!fulfilled && EXCLUDED_LOCATIONS.includes(rr.requestingLocation)) continue;
    // When the refusal was SAID: a hub's shop-line refusal carries refusedAt
    // (copied from the order by the scan's close); otherwise resolvedAt.
    const ts = (!fulfilled && msOf(rr.refusedAt)) || msOf(rr.resolvedAt) || msOf(rr.createdAt);
    if (!ts) continue;
    if (!groups.has(key)) groups.set(key, { loc, pid: rr.productId, cellKey, size: String(rr.size), events: [] });
    groups.get(key).events.push({
      id, ts, fulfilled,
      dest: rr.requestingLocation || null,
      byUid: typeof rr.resolvedBy === "string" && rr.resolvedBy ? rr.resolvedBy : null,
      byRole: typeof rr.rejectedBy === "string" && rr.rejectedBy ? rr.rejectedBy : null,
      byLoc: loc,
    });
  }

  // Every transfer OUT of a candidate cell in the ledger window is a
  // fulfilment event too (see SENT_TYPES).
  for (const m of movements || []) {
    if (!m || !SENT_TYPES.has(m.type) || !m.from || !m.productId || m.size == null) continue;
    if (!(num(Number(m.qty)) > 0) || m.from === m.to) continue;
    const g = groups.get(`${m.from}|${m.productId}|${stockCellKey(m.size)}`);
    const ts = msOf(m.ts);
    if (g && ts) g.events.push({ id: `ledger:${m.ts}`, ts, fulfilled: true, dest: m.to || null, byUid: null, byRole: null, byLoc: m.from });
  }

  // Ledger per cell — only cells that have a candidate run are ever looked up.
  let ledger = null;
  const ledgerFor = (loc, pid, cellKey) => {
    if (!ledger) {
      ledger = new Map();
      for (const m of movements || []) {
        if (!m || !m.productId || m.size == null) continue;
        const ck = stockCellKey(m.size);
        for (const l of new Set([m.from, m.to].filter(Boolean))) {
          const k = `${l}|${m.productId}|${ck}`;
          if (!groups.has(k)) continue;
          if (!ledger.has(k)) ledger.set(k, []);
          ledger.get(k).push(m);
        }
      }
      for (const arr of ledger.values()) arr.sort((a, b) => msOf(a.ts) - msOf(b.ts));
    }
    return ledger.get(`${loc}|${pid}|${cellKey}`) || [];
  };

  for (const [key, g] of groups) {
    const { loc, pid, cellKey } = g;
    if (!products?.[pid]) {   // a deleted product has nothing to erase — say so
      if (g.events.length >= MIN_DISTINCT_DAYS) out.deferred.push({ id: null, loc, pid, size: g.size, cellKey, reason: "product_deleted" });
      continue;
    }
    const through = num(cursors?.[loc]?.[pid]?.[cellKey]?.throughMs);
    const evs = g.events.filter((e) => e.ts > through).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    // The run = refusals after the last fulfilment.
    let run = [];
    for (const e of evs) { if (e.fulfilled) run = []; else run.push(e); }
    const days = [...new Set(run.map((e) => sastDay(e.ts)))];
    if (days.length < MIN_DISTINCT_DAYS) continue;

    const cell = cellAt(stock, loc, pid, cellKey);
    const paperQty = num(cell?.qty);
    const last = run[run.length - 1];
    const id = writeoffId(loc, pid, cellKey, last.ts);
    const base = { id: null, loc, pid, size: g.size, cellKey };
    const refusals = run.map((e) => ({
      rrId: e.id, atMs: e.ts, day: sastDay(e.ts), dest: e.dest, byUid: e.byUid, byRole: e.byRole, byLoc: e.byLoc,
    }));

    // REPAIR: this run's write-off already reached the cell (the cell still
    // carries its movement id) but the cursor did not move — a scan that died
    // between the two writes. Re-apply by the same id: the writer answers
    // idempotently from the ledger and the record + cursor are written.
    if (cell && (cell.mv === id || cell.lastRelMv === id || cell.relMv === id)) {
      const resumedQty = cell.relMv === id ? num(cell.relBefore) - paperQty : 0;
      out.writeoffs.push({
        ...base, id, repair: true, qty: Math.max(resumedQty, 1), paperQty: null,
        protectedQty: null, preRefusalQty: null,
        firstRefusalMs: run[0].ts, lastRefusalMs: last.ts, days, refusals, lastRefillId: last.id,
      });
      continue;
    }
    if (paperQty <= 0) continue;   // nothing on paper — the refusals agree with the count
    if (openAt.has(key)) {
      // Someone may be picking it right now — never yank a cell from under an
      // open request. It resolves (fulfilled breaks the run, refused adds to
      // it, withdrawn clears it) and the next scan decides.
      out.deferred.push({ ...base, reason: "request_open", days });
      continue;
    }

    // ── which refusals the arrival check can stand behind ──────────────────
    // Arrivals are read from the ledger window. A run that began before the
    // window can still be judged when the cell has not been WRITTEN since the
    // first refusal (its updatedAt says so) — nothing arrived. Otherwise the
    // run is judged on its in-window refusals alone, if those still make four
    // days; if not, it waits (reported, never guessed).
    let counted = run;
    const updatedMs = msOf(cell?.updatedAt);
    const untouchedSince = updatedMs > 0 && updatedMs <= run[0].ts;
    if (run[0].ts < windowStartMs && !untouchedSince) {
      counted = run.filter((e) => e.ts >= windowStartMs);
      if (new Set(counted.map((e) => sastDay(e.ts))).size < MIN_DISTINCT_DAYS) {
        out.deferred.push({ ...base, reason: "history_before_ledger_window", days });
        continue;
      }
    }
    const firstMs = counted[0].ts;

    // ── protected: everything that landed at the cell after the first refusal
    let protectedQty = 0;
    let preRefusalQty = paperQty;
    if (!(untouchedSince && counted === run)) {
      const rows = ledgerFor(loc, pid, cellKey).filter((m) => msOf(m.ts) > firstMs);
      for (const m of rows) {
        if (m.to === loc && ARRIVAL_TYPES.has(m.type) && num(Number(m.qty)) > 0) protectedQty += num(Number(m.qty));
      }
      // What the cell held when the first refusal came: the `before` of the
      // first movement to touch it afterwards. None since → today's count.
      const first = rows[0];
      const b = first?.before && typeof first.before[loc] === "number" ? first.before[loc] : null;
      if (first && b != null) preRefusalQty = Math.max(b, 0);
      else if (first && b == null) preRefusalQty = paperQty;   // a legacy row with no before: fall back to the arrival bound alone
    }
    const qty = Math.max(0, Math.min(paperQty - protectedQty, preRefusalQty));
    if (qty <= 0) continue;

    out.writeoffs.push({
      ...base, id,
      qty, paperQty, protectedQty, preRefusalQty,
      firstRefusalMs: firstMs, lastRefusalMs: last.ts,
      days: [...new Set(counted.map((e) => sastDay(e.ts)))],
      refusals: refusals.map((r) => ({ ...r, counted: r.atMs >= firstMs })),
      lastRefillId: last.id,
    });
  }
  out.writeoffs.sort((a, b) => a.lastRefusalMs - b.lastRefusalMs || (a.id < b.id ? -1 : 1));
  return out;
}

// ─── APPLY (called by functions/refill-scan.cjs, before the engine plans) ────
// For each planned write-off, in this order:
//   1. applyMovementAdmin — the cell debit (a transaction guarded by
//      expectQty) and the ledger row, type refusal_writeoff, keyed by the
//      write-off id. A cell that moved since the snapshot refuses
//      (cell_changed) and the next scan re-plans from the new count.
//   2. ONE multi-path update: the record (what the Health card and the digest
//      read), the cursor (so this run is never written off twice), the digest
//      queue entry, and the reject-streak nodes the refusals built for this
//      cell — which is what takes the item off Recount Needed.
//   3. The scan's in-memory snapshot is patched to match (cell qty, ledger
//      row, streaks) so the engine plans this same scan from the empty cell:
//      no Recount Needed row, and the cell asks upstream as usual.
// `update(patch, label)` is the scan's safeUpdate (sanitised, never throws).
async function applyRefusalWriteoffs({ db, writeoffs, snapshot, update, nowMs, runId, maxPerRun, deadlineMs = Infinity, clock = Date.now }) {
  const { applyMovementAdmin } = require("./admin-movement.cjs");
  const nowIso = new Date(nowMs).toISOString();
  const res = { applied: [], skipped: [], units: 0 };
  const names = new Map();
  const nameOf = async (uid) => {
    if (!uid) return null;
    if (!names.has(uid)) {
      let n = null;
      try { n = (await db.ref(`users/${uid}/displayName`).once("value")).val() || null; } catch { n = null; }
      names.set(uid, typeof n === "string" ? n : null);
    }
    return names.get(uid);
  };
  const products = snapshot.products || {};
  const routes = snapshot.config?.routes || {};
  const cap = Math.max(1, Number(maxPerRun) || 200);
  const list = (writeoffs || []).slice(0, cap);
  for (let i = 0; i < list.length; i++) {
    // Time budget: the scan has its own work to do in the same 300 s. What is
    // left is planned again, identically, by the next scan.
    if (clock() > deadlineMs) { res.deferredForTime = list.length - i; break; }
    const w = list[i];
    const productName = products[w.pid]?.name || null;
    const reason = `refused on ${w.days.length} different days (${w.days.join(", ")}) — written off as not there`;
    let r;
    try {
      r = await applyMovementAdmin(db, {
        type: MOVEMENT_TYPE, productId: w.pid, size: w.size, sizeKey: w.cellKey, qty: w.qty,
        from: w.loc, to: null, movementId: w.id, actor: ACTOR, actorRole: "system", reason,
        link: { refillId: w.lastRefillId || null },
        ...(w.repair ? {} : { expectQty: w.paperQty }),
        writeoff: {
          days: w.days, refusalIds: w.refusals.map((x) => x.rrId), protectedQty: w.protectedQty ?? null,
          // Who said no, per refusal (same order as refusalIds): the account
          // where the app recorded one, else the refusing location.
          refusedBy: w.refusals.map((x) => x.byUid || (x.byRole ? `role:${x.byRole}` : `location:${x.byLoc || w.loc}`)),
        },
      }, { nowIso });
    } catch (e) {
      r = { ok: false, reason: `threw: ${String(e?.message || e)}` };
    }
    if (!r || !r.ok) { res.skipped.push({ id: w.id, reason: r?.reason || "unknown", available: r?.available ?? null }); continue; }
    // The ledger row is the truth for what landed (an idempotent answer
    // carries no before/after of its own).
    let row = null;
    try { row = (await db.ref(`stock_movements/${w.id}`).once("value")).val(); } catch { row = null; }
    const qty = Number(row?.qty) || w.qty;
    const before = typeof row?.before?.[w.loc] === "number" ? row.before[w.loc] : null;
    const after = typeof row?.after?.[w.loc] === "number" ? row.after[w.loc] : null;
    const refusals = [];
    for (const x of w.refusals) {
      refusals.push({
        rrId: x.rrId, at: new Date(x.atMs).toISOString(), day: x.day, dest: x.dest || null,
        byUid: x.byUid || null, byName: await nameOf(x.byUid), byRole: x.byRole || null, byLoc: x.byLoc || w.loc,
        counted: x.counted !== false,
      });
    }
    const record = {
      id: w.id, loc: w.loc, pid: w.pid, productName, size: w.size, cellKey: w.cellKey,
      qty, before, after, paperQty: w.paperQty ?? before, protectedQty: w.protectedQty ?? null,
      preRefusalQty: w.preRefusalQty ?? null, days: w.days, refusals,
      firstRefusalAt: new Date(w.firstRefusalMs).toISOString(), lastRefusalAt: new Date(w.lastRefusalMs).toISOString(),
      writtenAt: nowIso, writtenAtMs: nowMs, runId: runId || null, movementId: w.id,
      ...(w.repair ? { repaired: true } : {}),
    };
    const patch = {
      [`refill_engine/refusalWriteoffs/${w.id}`]: record,
      [`refill_engine/refusalWriteoffCursor/${w.loc}/${w.pid}/${w.cellKey}`]: { throughMs: w.lastRefusalMs, id: w.id },
      [`refill_engine/refusalWriteoffDigestQueue/${w.id}`]: nowMs,
    };
    // Recount Needed: the streaks these refusals built — at every requester
    // this location refused for this size. (A streak node is keyed by the
    // REQUESTER; `by` names who said no.)
    const { encodeSizeKey } = require("./refill-engine.cjs");
    const sk = encodeSizeKey(w.size);
    const streaks = snapshot.rejectStreak || {};
    const cleared = [];
    for (const dest of Object.keys(streaks)) {
      const s = streaks[dest]?.[w.pid]?.[sk];
      if (!s) continue;
      if ((s.by || routes[dest]) !== w.loc) continue;
      patch[`refill_engine/rejectStreak/${dest}/${w.pid}/${sk}`] = null;
      cleared.push(dest);
    }
    const ok = await update(patch, `refusal write-off ${w.id}`);
    if (!ok) { res.skipped.push({ id: w.id, reason: "record_write_failed" }); }
    // The cell and the ledger changed whether or not the record landed — the
    // snapshot must say so, or the engine plans from the phantom again.
    // A repair (idempotent answer) may find the cell moved on since the
    // write-off landed — take the live count, never the old ledger `after`.
    let liveQty = after;
    if (r.idempotent) {
      try { const lc = (await db.ref(`stock/${w.loc}/${w.pid}/${w.cellKey}`).once("value")).val(); liveQty = typeof lc?.qty === "number" ? lc.qty : after; } catch { /* keep after */ }
    }
    const stockRow = snapshot.stock?.[w.loc]?.[w.pid];
    if (stockRow && typeof stockRow === "object" && liveQty != null) {
      const c = stockRow[w.cellKey];
      stockRow[w.cellKey] = { ...(c && typeof c === "object" ? c : {}), qty: liveQty, ...(r.idempotent ? {} : { mv: w.id, lastType: "adjustment" }) };
    }
    if (row && Array.isArray(snapshot.movements)) snapshot.movements.push(row);   // a duplicate of an in-window row is harmless: a from-only debit is no arrival
    if (ok) for (const dest of cleared) { if (streaks[dest]?.[w.pid]) delete streaks[dest][w.pid][sk]; }
    if (ok) { res.applied.push(record); res.units += w.repair ? 0 : qty; }
  }
  return res;
}

module.exports = {
  planRefusalWriteoffs, applyRefusalWriteoffs, refusingLocation, sastDay, writeoffId,
  WRITEOFF_LOCATIONS, EXCLUDED_LOCATIONS, MIN_DISTINCT_DAYS, MOVEMENT_TYPE, ACTOR,
};
