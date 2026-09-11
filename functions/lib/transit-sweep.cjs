// ─── STRANDED-TRANSIT SWEEP — the hold lane's automatic release ──────────────
//
// WHY THIS EXISTS (FULFIL-CREDIT-GAP.md, 2026-09-11). The central→hub hold lane
// parks a fulfil's destination credit at stock/in_transit and waits for a
// human tap on the release card. A tap is a manual step, and manual steps
// quietly stop happening: two units parked on 4 Sep are still in in_transit a
// week later, their release archived with no movement behind it. Nothing in
// the system would ever have moved them. This sweep is the timer the lane
// never had — every parked unit either lands at its destination on its own,
// or is reported with the one reason a human must decide (a product record
// that no longer exists).
//
// THE THREE STRANDED SHAPES, and what the sweep does with each:
//   1. HELD LINE past its window — /settings/stockHold/held/{dest}/{lineId}
//      exists. Released automatically once the switch is OFF (nothing new
//      parks; nothing old should wait for a tap) or, with the switch ON, once
//      the shipment's release instant is more than RELEASE_GRACE_MS behind us
//      (the box has arrived by then; a tap that has not happened in a day is
//      not going to). Inside the grace window the card is still the owner's
//      — the line is reported as pending, untouched.
//   2. ARCHIVED-BUT-NOT-MOVED — the line sits under released/ with a
//      releaseMovementId that is not in the ledger and units still parked.
//      Re-applied under the SAME movement id the tap would have used, so a
//      tap that did land is a no-op and a tap that did not is completed.
//   3. ORPHAN CELL — units parked by a hold-lane movement (link.holdDest) with
//      no line and no archive: the fulfil crashed between the movement and
//      the line write. Released after ORPHAN_MIN_AGE_MS so an in-flight
//      fulfil is never raced.
//
// REFUSALS ARE REPORTED, NEVER SILENT: a product whose /products record is
// gone has nothing to credit (and the live rules would refuse the movement
// for anyone but this SDK) — the units are listed under
// /stock_exceptions/strandedTransit for the owner to place. A manual
// transit-lane transfer (no holdDest on the parking movement) is not this
// lane's and is skipped by name.
//
// SIZE OF THE READ. stock/in_transit is ~500 KB (3,175 cells, 1,157 products,
// almost all qty 0 — measured 2026-09-11) and is read ONCE per run; the run
// is hourly inside trading hours. Candidate lines are only the ones whose cell
// actually holds units, so the per-line lookups (ledger row, product record)
// are a handful, never the archive's hundreds.
//
// THE REFILL ENGINE NEVER WRITES /stock. This is not the engine: a separate,
// explicitly named function (strandedTransitSweep) with one job.
//
// Pure planning here; I/O in strandedTransitSweep.cjs. Movement ids, reasons
// and the archive shape are byte-identical to the client release path
// (stockHoldStore.js releaseShipment) so a device and the sweep can never
// double-credit the same line.

"use strict";

const { applyMovementAdmin } = require("./admin-movement.cjs");
const { encodeSizeKey } = require("./refill-engine.cjs");

const SA_OFFSET_MS = 2 * 60 * 60 * 1000;
const RELEASE_GRACE_MS = 24 * 60 * 60 * 1000;   // switch ON: a window this far past is released anyway
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;       // a cell with no line is left alone this long
const ACTOR = "system:strandedTransitSweep";
const IN_TRANSIT = "in_transit";
const UNFILED_SHIPMENT = "unfiled";

// "2026-09-04_1400" → release instant (ms). Mirrors stockHoldCore.shipmentReleaseMs.
function shipmentReleaseMs(shipmentId) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})$/.exec(String(shipmentId || ""));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - SA_OFFSET_MS;
}

/** Every in_transit cell holding units → [{ productId, sizeKey, qty, mv, updatedAt }]. */
function cellsWithUnits(inTransit) {
  const out = [];
  for (const [pid, bySize] of Object.entries(inTransit || {})) {
    for (const [sizeKey, c] of Object.entries(bySize || {})) {
      const qty = c && typeof c.qty === "number" ? c.qty : 0;
      if (qty > 0) out.push({ productId: pid, sizeKey, qty, mv: c.mv || null, updatedAt: c.updatedAt || null });
    }
  }
  return out;
}

/**
 * Step 1 (pure): which LINES might be stranded, given the cells that hold units.
 * → { lines: [{ lineId, dest, shipmentId, source: "held"|"released"|null, line }],
 *     lookups: { movementIds: [...], productIds: [...] } }
 * The caller resolves the lookups (ledger rows, product existence) and hands
 * everything to planTransitSweep.
 */
function sweepCandidates({ inTransit, held, released }) {
  const cells = cellsWithUnits(inTransit);
  const cellKey = new Set(cells.map((c) => `${c.productId}|${c.sizeKey}`));
  const lines = [];
  const seen = new Set();
  const add = (lineId, dest, shipmentId, source, line) => {
    const k = `${dest}|${lineId}`;
    if (seen.has(k)) return;
    seen.add(k);
    lines.push({ lineId, dest, shipmentId: shipmentId || null, source, line: line || null });
  };
  // EVERY held line is a candidate (the node is small and a line is a claim
  // on units that must either land or be reported as phantom); the archive is
  // hundreds of lines and only its rows whose cell still holds units matter.
  for (const [dest, byLine] of Object.entries(held || {})) {
    for (const [lineId, line] of Object.entries(byLine || {})) {
      if (!line) continue;
      add(lineId, dest, line.shipmentId, "held", line);
    }
  }
  for (const [dest, byShipment] of Object.entries(released || {})) {
    for (const [shipmentId, byLine] of Object.entries(byShipment || {})) {
      for (const [lineId, line] of Object.entries(byLine || {})) {
        if (!line || !cellKey.has(`${line.productId}|${line.sizeKey || encodeSizeKey(line.size)}`)) continue;
        add(lineId, dest, shipmentId, "released", line);
      }
    }
  }
  // Orphans: cells whose parking movement is not any line — the caller must
  // read the parking movement to know its destination.
  const orphanCells = cells.filter((c) => c.mv && !lines.some((l) => l.lineId === c.mv));
  const movementIds = [...new Set([
    ...lines.map((l) => `rel_${l.lineId}`),        // has the release already landed?
    ...orphanCells.map((c) => c.mv),               // where was this parked to?
    ...orphanCells.map((c) => `rel_${c.mv}`),
  ])];
  const productIds = [...new Set([...lines.map((l) => l.line && l.line.productId), ...orphanCells.map((c) => c.productId)].filter(Boolean))];
  return { cells, lines, orphanCells, lookups: { movementIds, productIds } };
}

/**
 * Step 2 (pure): decide. movements = { id: row|null } for every id in lookups;
 * productExists = { pid: boolean }; config = /settings/stockHold/config.
 * → { releases: [...], refusals: [...], pending: [...], skipped: [...] }
 */
function planTransitSweep({ candidates, movements, productExists, config, nowMs }) {
  const releases = [], refusals = [], pending = [], skipped = [];
  const holdOn = !!(config && config.enabled === true);
  const cellQty = new Map(candidates.cells.map((c) => [`${c.productId}|${c.sizeKey}`, c.qty]));
  const cellMv = new Map(candidates.cells.map((c) => [`${c.productId}|${c.sizeKey}`, c.mv]));

  for (const cand of candidates.lines) {
    const line = cand.line || {};
    const sizeKey = line.sizeKey || encodeSizeKey(line.size);
    const base = {
      lineId: cand.lineId, dest: cand.dest, shipmentId: cand.shipmentId, productId: line.productId,
      productName: line.productName || null, size: String(line.size), sizeKey, qty: Number(line.qty) || 1,
      refillId: line.refillId || null, source: cand.source, inTransitQty: cellQty.get(`${line.productId}|${sizeKey}`) || 0,
    };
    if (movements[`rel_${cand.lineId}`]) { skipped.push({ ...base, why: "release movement already in the ledger" }); continue; }
    if (productExists[line.productId] === false) { refusals.push({ ...base, why: "product record missing — nothing to credit; owner must place these units" }); continue; }
    // A line whose transit cell holds fewer units than it claims is a phantom:
    // the fulfil never parked them (or something else drained the cell). The
    // writer's negative floor would refuse it anyway; say so up front rather
    // than fail every hour.
    if (base.inTransitQty < base.qty) { refusals.push({ ...base, why: `phantom line — ${base.inTransitQty} unit(s) in transit for a line of ${base.qty}; nothing was parked` }); continue; }
    if (cand.source === "released") {
      // The cell must still name THIS line as its last parking. A newer line
      // parked on the same pid/size after the archive would otherwise be
      // spent on the old claim and refuse itself as a phantom (Fable-vs-spec
      // review, PR #602). Reported, not guessed.
      const lastMv = cellMv.get(`${line.productId}|${sizeKey}`);
      if (lastMv !== cand.lineId) { pending.push({ ...base, why: `archived as released but a later parking (${lastMv}) sits on this cell — needs a human look` }); continue; }
      releases.push({ ...base, why: "archived as released but the release movement was never written", archived: true });
      continue;
    }
    // held
    const releaseMs = shipmentReleaseMs(cand.shipmentId);
    if (!holdOn) { releases.push({ ...base, why: "holding is off — nothing waits for a tap" }); continue; }
    if (releaseMs != null && nowMs >= releaseMs + RELEASE_GRACE_MS) { releases.push({ ...base, why: `release window more than ${RELEASE_GRACE_MS / 3600000}h past` }); continue; }
    pending.push({ ...base, why: releaseMs == null ? "shipment id unreadable — left for the card" : "inside the release window's grace — the card's" });
  }

  for (const c of candidates.orphanCells) {
    const pm = movements[c.mv];
    const base = { lineId: c.mv, productId: c.productId, sizeKey: c.sizeKey, qty: c.qty, inTransitQty: c.qty, source: "orphan" };
    if (!pm) { skipped.push({ ...base, why: "parking movement not in the ledger" }); continue; }
    const dest = pm.link && pm.link.holdDest;
    if (!dest) { skipped.push({ ...base, why: "not a hold-lane parking (manual transit lane) — receive it there" }); continue; }
    if (movements[`rel_${c.mv}`]) { skipped.push({ ...base, dest, why: "release movement already in the ledger" }); continue; }
    if (productExists[c.productId] === false) { refusals.push({ ...base, dest, size: String(pm.size), why: "product record missing — nothing to credit; owner must place these units" }); continue; }
    const parkedMs = Date.parse(pm.appliedAt || pm.ts || "") || 0;
    if (nowMs - parkedMs < ORPHAN_MIN_AGE_MS) { pending.push({ ...base, dest, why: "parked less than an hour ago — a fulfil may still be filing its line" }); continue; }
    releases.push({
      ...base, dest, shipmentId: null, size: String(pm.size), qty: Math.min(Number(pm.qty) || 1, c.qty),
      refillId: (pm.link && pm.link.refillId) || null, productName: null,
      why: "parked with no shipment line (fulfil crashed after the movement)", orphan: true,
    });
  }
  return { releases, refusals, pending, skipped };
}

/**
 * Step 3 (I/O): apply the plan. Each release = ONE idempotent movement (the id
 * the tap would have used) + ONE bookkeeping update, exactly the client's
 * order; the archive is only ever written on the strength of a movement that
 * is actually in the ledger.
 */
async function applyTransitSweep(db, plan, { nowIso, nowMs }) {
  const out = { released: 0, releasedUnits: 0, failures: [] };
  const read = async (p) => (await db.ref(p).once("value")).val();
  for (const r of plan.releases) {
    const relId = `rel_${r.lineId}`;
    const res = await applyMovementAdmin(db, {
      type: "transfer_in", productId: r.productId, size: r.size, qty: r.qty,
      from: IN_TRANSIT, to: r.dest, actor: ACTOR, actorRole: "admin",
      reason: "stock_hold_release", movementId: relId,
      link: { refillId: r.refillId || null, holdShipmentId: r.shipmentId || UNFILED_SHIPMENT, holdLineId: r.lineId, autoReleased: true },
    }, { nowIso });
    if (!res.ok) { out.failures.push({ lineId: r.lineId, dest: r.dest, reason: res.reason }); continue; }
    const recorded = await read(`stock_movements/${relId}`);
    if (!recorded || recorded.to !== r.dest) { out.failures.push({ lineId: r.lineId, dest: r.dest, reason: "release movement not in the ledger after the write — nothing archived" }); continue; }

    const shipmentKey = r.shipmentId || UNFILED_SHIPMENT;
    const archivePath = `settings/stockHold/released/${r.dest}/${shipmentKey}/${r.lineId}`;
    const updates = {};
    if (r.source === "held") updates[`settings/stockHold/held/${r.dest}/${r.lineId}`] = null;
    if (r.archived) {
      updates[`${archivePath}/releaseMovementId`] = relId;
      updates[`${archivePath}/autoRepairedAt`] = nowIso;
      updates[`${archivePath}/autoRepairedBy`] = ACTOR;
    } else {
      updates[archivePath] = {
        productId: r.productId, productName: r.productName || r.productId, size: r.size, sizeKey: r.sizeKey,
        qty: r.qty, dest: r.dest, shipmentId: shipmentKey, refillId: r.refillId || null, movementId: r.lineId,
        releasedAt: nowIso, releasedBy: ACTOR, releaseMovementId: relId, autoReleased: true, why: r.why,
      };
    }
    // The race guard the tap has: a cell counted before this credit landed is
    // no longer a settled count.
    try {
      const session = await read(`settings/hubSneakerCount/sessions/${r.dest}`);
      if (session && session.sessionId) {
        const base = `settings/hubSneakerCount/counted/${r.dest}/${session.sessionId}/${r.productId}::${r.sizeKey}`;
        const rec = await read(base);
        if (rec && !rec.staleAt) { updates[`${base}/staleAt`] = nowIso; updates[`${base}/staleDelta`] = r.qty; updates[`${base}/staleMovementId`] = relId; }
        else if (rec && rec.staleAt) updates[`${base}/staleDelta`] = (Number(rec.staleDelta) || 0) + r.qty;
      }
    } catch { /* best-effort, as on the card */ }
    try {
      await db.ref().update(updates);
      out.released++; out.releasedUnits += r.qty;
    } catch (err) {
      out.failures.push({ lineId: r.lineId, dest: r.dest, reason: `credited, bookkeeping failed (${String(err && err.message || err)}) — next run completes it` });
    }
  }
  return out;
}

module.exports = {
  sweepCandidates, planTransitSweep, applyTransitSweep, cellsWithUnits, shipmentReleaseMs,
  RELEASE_GRACE_MS, ORPHAN_MIN_AGE_MS, ACTOR, UNFILED_SHIPMENT,
};
