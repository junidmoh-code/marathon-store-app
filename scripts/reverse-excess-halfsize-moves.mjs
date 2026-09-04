// ─── REVERSE THE HALF-SIZE EXCESS MOVES ──────────────────────────────────────
//
// The Excess Inventory screen carded half sizes against a target of 0 instead
// of their real Keep (docs/EXCESS-55-INVESTIGATION.md): seatingCore's
// sizeUnitsAnywhere asked the DECODED client cell map for the ENCODED key
// "5_5", read "no units anywhere", and the dead-size rule handed back 0. Every
// unit of every half-size hub cell was therefore offered as excess, and a
// handful were actually sent to Central — taking those cells BELOW their Keep.
//
// This script sends back exactly the units that should never have moved, and
// nothing else.
//
// ── WHAT IT REVERSES, AND BY HOW MUCH ────────────────────────────────────────
// Evidence-driven, never a hardcoded list. It walks /stock_movements for
// `reason == "excess_rebalance"` movements whose id starts with `exchc_` (the
// Hub → Central screen's own prefix) on a HALF size, and for each one:
//
//   before      = the cell's on-hand at the time = mv.before[from]  (the ledger
//                 records it; the same read that computed the write)
//   keep        = the live category-policy row for that location and size key
//   legitimate  = max(0, before - keep)      — what the screen SHOULD have said
//   wrong       = qty - legitimate           — what it must send back
//
// A move is SKIPPED, loudly, when:
//   • the source cell has been touched since (cell.mv is no longer that
//     movement id) — the arithmetic above would then be guesswork;
//   • an Undo already reversed it (the mirrored central→hub movement exists);
//   • wrong <= 0 (the move was legitimate);
//   • Central no longer holds enough to send back;
//   • no policy row exists for that size (nothing to measure "wrong" against).
//
// ── HOW IT MOVES ─────────────────────────────────────────────────────────────
// The transfer contract of src/components/stock/applyMovement.js, field for
// field, atomically: both cells and the ledger row in ONE multi-path update,
// the movement id as the idempotency key, `v` incremented by exactly 1 per
// cell, a negative-going leg refused rather than overdrawn, before/after
// derived from the SAME read that computes the write, and — because the Admin
// SDK bypasses the security rule that enforces `v == data.v + 1` — a re-read of
// every touched cell immediately before the write, retrying on any change.
// (The same pattern, and the same reasoning, as applyMovementAdmin in
// scripts/lib/headwearCollapseCore.mjs.)
//
// Movement ids are deterministic — `exrev_<original movement id>` — so a
// re-run is a no-op rather than a second reversal.
//
// DRY RUN BY DEFAULT. --execute writes. A rollback/report file is written
// BEFORE any write.
//
// Usage:  node scripts/reverse-excess-halfsize-moves.mjs [--execute]
import { adminRequire } from "./adminRequire.mjs";
import { writeFileSync } from "fs";

const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");

const EXECUTE = process.argv.includes("--execute");
const ACTOR = "system:excess-halfsize-reversal";
const REASON = "excess_reversal";
const CONFLICT_RETRIES = 5;

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const read = async (p) => (await db.ref(p).once("value")).val();

// The stored key shape — the ONE encoder both apps use (src/utils/sizeKey.js).
const encodeSizeKey = (s) => String(s).replace(/[.#$[\]/\s]/g, "_");
const isHalfSize = (s) => /^\d+\.5$/.test(String(s));

// ── the applyMovement transfer contract, admin-side ──────────────────────────
async function applyTransferAdmin({ movementId, productId, size, qty, from, to, nowIso }) {
  const mvId = movementId;
  const legs = [{ loc: from, delta: -qty }, { loc: to, delta: +qty }];
  const paths = legs.map((l) => `stock/${l.loc}/${productId}/${encodeSizeKey(size)}`);
  const same = (a, b) => {
    const q = (c) => (c && typeof c.qty === "number" ? c.qty : 0);
    const v = (c) => (c && typeof c.v === "number" ? c.v : null);
    return q(a) === q(b) && v(a) === v(b);
  };

  for (let attempt = 1; attempt <= CONFLICT_RETRIES; attempt++) {
    if (await read(`stock_movements/${mvId}`)) return { ok: true, movementId: mvId, idempotent: true };

    const cells = [];
    for (let i = 0; i < legs.length; i++) {
      const cell = await read(paths[i]);
      const curQty = cell && typeof cell.qty === "number" ? cell.qty : 0;
      const newQty = curQty + legs[i].delta;
      if (legs[i].delta < 0 && newQty < 0) {
        return { ok: false, reason: "insufficient_stock", location: legs[i].loc, available: curQty, requested: qty };
      }
      cells.push({ path: paths[i], cell, curQty, newQty });
    }

    const before = {}, after = {};
    cells.forEach((c, i) => { before[legs[i].loc] = c.curQty; after[legs[i].loc] = c.newQty; });

    const updates = {};
    updates[`stock_movements/${mvId}`] = {
      type: "transfer_out", productId, size, qty, from, to, before, after,
      actor: ACTOR, actorRole: "admin", ts: nowIso, appliedAt: nowIso, reason: REASON,
      link: { orderId: null, transferId: null, refillId: null, saleId: null, deviceId: null },
    };
    for (const c of cells) {
      updates[`${c.path}/qty`] = c.newQty;
      updates[`${c.path}/v`] = c.cell && typeof c.cell.v === "number" ? c.cell.v + 1 : 0;
      updates[`${c.path}/mv`] = mvId;
      updates[`${c.path}/lastType`] = "transfer_out";
      updates[`${c.path}/updatedAt`] = nowIso;
      updates[`${c.path}/updatedBy`] = ACTOR;
    }

    let stale = false;
    for (const c of cells) if (!same(c.cell, await read(c.path))) stale = true;
    if (stale) continue;                       // someone else wrote — recompute

    await db.ref().update(updates);
    return { ok: true, movementId: mvId, before, after };
  }
  return { ok: false, reason: "conflict_retries_exhausted" };
}

(async () => {
  const [products, config] = await Promise.all([read("products"), read("config/refillEngine")]);
  const moves = (await db.ref("stock_movements").orderByChild("reason").equalTo("excess_rebalance").once("value")).val() || {};

  const all = Object.entries(moves).map(([id, m]) => ({ id, ...m }));
  const byId = new Set(Object.keys(moves));
  const candidates = all
    .filter((m) => String(m.id).startsWith("exchc_") && isHalfSize(m.size) && m.to === "central")
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  console.log(`exchc_ half-size moves to Central: ${candidates.length}`);
  const plan = [], skipped = [];

  for (const m of candidates) {
    const sizeKey = encodeSizeKey(m.size);
    const note = (why, extra = {}) => skipped.push({ id: m.id, productId: m.productId, size: m.size, why, ...extra });

    // an Undo of this exact move (same batch, mirrored direction) already ran?
    const undoId = String(m.id).replace(/_([a-z0-9]+)_central$/, "_central_$1");
    const undone = [...byId].some((id) => id !== m.id && id.includes(m.productId) && id.includes(`${sizeKey}_central_${m.from}`));
    if (undone) { note("already undone in-app", { undoId }); continue; }

    const cat = products?.[m.productId]?.categoryKey;
    const keep = config?.categoryPolicy?.[cat]?.[m.from]?.sizes?.[sizeKey]?.target;
    if (typeof keep !== "number") { note("no policy row for this size — nothing to measure against"); continue; }

    const srcCell = await read(`stock/${m.from}/${m.productId}/${sizeKey}`);
    if (srcCell?.mv !== m.id) { note("source cell touched since the move — reversing would be guesswork", { cellMv: srcCell?.mv || null }); continue; }

    const beforeQty = typeof m.before?.[m.from] === "number" ? m.before[m.from] : null;
    if (beforeQty === null) { note("ledger has no before-quantity for the source"); continue; }

    const legitimate = Math.max(0, beforeQty - keep);
    const wrong = Number(m.qty) - legitimate;
    if (!(wrong > 0)) { note("move was legitimate", { beforeQty, keep, qty: m.qty }); continue; }

    const dstCell = await read(`stock/central/${m.productId}/${sizeKey}`);
    const dstQty = typeof dstCell?.qty === "number" ? dstCell.qty : 0;
    if (dstQty < wrong) { note("central no longer holds enough to send back", { dstQty, wrong }); continue; }

    plan.push({
      original: m.id, productId: m.productId, name: products?.[m.productId]?.name || m.productId,
      size: m.size, sizeKey, hub: m.from, movedQty: Number(m.qty), beforeQty, keep, legitimate,
      reverseQty: wrong,
      hubBefore: typeof srcCell?.qty === "number" ? srcCell.qty : 0,
      hubAfter: (typeof srcCell?.qty === "number" ? srcCell.qty : 0) + wrong,
      centralBefore: dstQty, centralAfter: dstQty - wrong,
      movementId: `exrev_${m.id}`,
    });
  }

  console.log(`\nSKIPPED (${skipped.length}):`);
  for (const s of skipped) console.log(`  ${s.id} — ${s.why}`);
  console.log(`\nPLAN (${plan.length} moves, ${plan.reduce((a, b) => a + b.reverseQty, 0)} units):`);
  for (const p of plan) {
    console.log(`  ${p.name} | size ${p.size} | central → ${p.hub} | ${p.reverseQty} units`);
    console.log(`     moved ${p.movedQty} from ${p.beforeQty} on hand against Keep ${p.keep} (only ${p.legitimate} was excess)`);
    console.log(`     ${p.hub}: ${p.hubBefore} → ${p.hubAfter}    central: ${p.centralBefore} → ${p.centralAfter}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `${process.env.HOME}/excess-halfsize-reversal-${stamp}.json`;
  writeFileSync(file, JSON.stringify({ plan, skipped, executed: EXECUTE }, null, 2));
  console.log(`\nreport: ${file}`);

  if (!EXECUTE) { console.log("\nDRY RUN — re-run with --execute to apply."); process.exit(0); }

  const nowIso = new Date().toISOString();
  for (const p of plan) {
    const res = await applyTransferAdmin({
      movementId: p.movementId, productId: p.productId, size: p.size, qty: p.reverseQty,
      from: "central", to: p.hub, nowIso,
    });
    console.log(res.ok
      ? `  ✓ ${p.name} ${p.size} ×${p.reverseQty}${res.idempotent ? " (already applied)" : ""} — ${JSON.stringify(res.before || {})} → ${JSON.stringify(res.after || {})}`
      : `  ✗ ${p.name} ${p.size} — ${res.reason}`);
  }
  process.exit(0);
})();
