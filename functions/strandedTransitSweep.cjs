// ─── strandedTransitSweep — hourly I/O wrapper for lib/transit-sweep.cjs ─────
// Reads: settings/stockHold (config + held + released), stock/in_transit (once,
// ~500 KB), then only the ledger rows and product records the candidates name.
// Writes: release movements + archive bookkeeping (lib), and one summary at
// /stock_exceptions/strandedTransit so the Health surfaces can show what was
// released, what is pending, and what a human must place.
//
// DEPLOY: scoped only — `firebase deploy --only functions:strandedTransitSweep`.
// The project's functions are shared with marathon-pos-app; a bare
// `--only functions` would touch that app's functions too.

"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const { sweepCandidates, planTransitSweep, applyTransitSweep } = require("./lib/transit-sweep.cjs");

if (!admin.apps.length) admin.initializeApp();

async function runSweep(db = admin.database(), nowMs = Date.now()) {
  const nowIso = new Date(nowMs).toISOString();
  const read = async (p) => (await db.ref(p).once("value")).val();
  const [hold, inTransit] = await Promise.all([read("settings/stockHold"), read("stock/in_transit")]);
  const candidates = sweepCandidates({ inTransit: inTransit || {}, held: hold && hold.held, released: hold && hold.released });

  const movements = {};
  for (const id of candidates.lookups.movementIds) movements[id] = await read(`stock_movements/${id}`);
  const productExists = {};
  // The record's own `id` field, not the whole product — a product is several
  // KB with its gallery and alternatives; existence is one small read.
  for (const pid of candidates.lookups.productIds) productExists[pid] = (await read(`products/${pid}/id`)) != null || (await read(`products/${pid}/name`)) != null;

  const plan = planTransitSweep({ candidates, movements, productExists, config: hold && hold.config, nowMs });
  const applied = await applyTransitSweep(db, plan, { nowIso, nowMs });

  const summary = {
    computedAt: nowIso,
    cellsWithUnits: candidates.cells.length,
    released: applied.released, releasedUnits: applied.releasedUnits, retired: applied.retired || 0,
    failures: applied.failures,
    refusals: plan.refusals,
    pending: plan.pending,
    skipped: plan.skipped.map((s) => ({ lineId: s.lineId, productId: s.productId, sizeKey: s.sizeKey, why: s.why })),
  };
  // A malformed line (no productId) must not throw the report away after
  // stock has moved: RTDB rejects `undefined`; JSON round-trip drops it.
  await db.ref("stock_exceptions/strandedTransit").set(JSON.parse(JSON.stringify(summary)));
  return summary;
}

exports.strandedTransitSweep = onSchedule(
  {
    schedule: "every 60 minutes from 07:00 to 19:00",
    timeZone: "Africa/Johannesburg",
    region: "europe-west1",
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async () => { await runSweep(); },
);
exports._runSweep = runSweep;   // db injected — the whole path is testable against the fake
