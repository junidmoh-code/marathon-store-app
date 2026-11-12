// ─── HUB 3 CLOTHING → CONCRETE (Junid, 12 Nov 2026) — the pure plan + the apply ─
// Junid: "Hub 3 holds NO non-footwear stock." His addition, overriding anything
// that conflicts: Hub 3's clothing WAS counted, so its quantities are real and
// move automatically; the scope is EVERYTHING at Hub 3 that is not footwear
// (clothing, accessories, caps, bags, belts, perfumes, no-size, uncategorised),
// decided by the engine's own footwear test; perfumes move too but get no keep
// and no seat; zero and negative cells are brought to zero with an adjustment
// tagged hub3_clothing_cleanup, and Hub 3 ends with no non-footwear rows at all.
//
//   • a cell above zero → ONE transfer movement of its full quantity, Hub 3 →
//     Concrete, through applyMovementAdmin, id h3cl_<runId>_<pid>_<sizeKey>,
//     reason hub3_clothing_to_concrete (a cell that moved since the read is
//     re-read alone and the movement re-planned at its new quantity — the same
//     id, because a refused movement writes nothing);
//   • a cell below zero → ONE adjustment up to zero, id h3cc_<runId>_…, reason
//     hub3_clothing_cleanup, guarded by expectQty;
//   • every non-footwear cell then at zero is removed (a transaction that
//     removes only a cell still at exactly 0 with no movement in flight);
//   • each product that moved units is seated at Concrete (never a perfume:
//     Concrete never keeps one), its Concrete release tombstone cleared; every
//     Hub 3 non-footwear seat is switched off;
//   • every open Hub 3 non-footwear request, and every open Concrete/Pine
//     non-footwear request sourced from Hub 3, is withdrawn if untouched
//     (status cancelled, cancelReason hub3_clothing_to_concrete) with its lock.
// Nothing here writes outside stock/hub3, stock/concrete (through the
// movement writer), stock_movements, refill_engine/seats, refill_engine/
// seatReleases/concrete, refill_engine/open and refill_requests.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const dv = require("../../functions/lib/concrete-division.cjs");
const { requestUntouched } = require("../../functions/lib/shop-source-rule.cjs");

export const HUB = "hub3";
export const DEST = "concrete";
export const REASON = "hub3_clothing_to_concrete";
export const CLEANUP_REASON = "hub3_clothing_cleanup";
export const ACTOR = "system:hub3-clothing-to-concrete";
export const SEAT_VIA = "hub3_transfer";
const UNSAFE = /[.#$/[\]\s]/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const qtyOf = (c) => (isObj(c) && typeof c.qty === "number" && Number.isFinite(c.qty) ? c.qty : null);

export const transferIdFor = (runId, pid, sizeKey) => `h3cl_${runId}_${pid}_${sizeKey}`;
export const cleanupIdFor = (runId, pid, sizeKey) => `h3cc_${runId}_${pid}_${sizeKey}`;
// The size a cell key stands for: the product's declared size whose cell key it
// is ("5.5" for "5_5"), else the key itself. Only the ledger row's `size` reads
// it — the movement carries sizeKey, so the writer lands on exactly this cell.
const { stockCellKey } = require("../../functions/lib/admin-movement.cjs");
export function sizeOfKey(k, product) {
  const hit = ((product && product.sizes) || []).find((s) => s != null && stockCellKey(s) === k);
  return hit != null ? String(hit) : k;
}

export const isFootwear = (product) => dv.isDivisionFootwear(product);

// Which shop "owned" a Hub 3 product: no seat ever carried an owner, so the
// shops it is seated at today stand in for it (both, one, or neither).
export function owningShop(seats, pid) {
  const c = !!seats?.concrete?.[pid], p = !!seats?.["marathon-pine"]?.[pid];
  return c && p ? "both" : c ? "concrete" : p ? "marathon-pine" : "neither";
}

/** The plan, from one read of /stock/hub3 plus products, seats and requests. */
export function planHub3ClothingTransfer({ hub3Stock, products, seats = {}, requests = {}, locks = {}, runId }) {
  if (!runId || UNSAFE.test(String(runId))) throw new Error("runId required (a safe key)");
  const transfers = [], cleanups = [], zeros = [], skipped = [], footwearKept = [];
  const seatOn = new Set(), perfumes = new Set(), noRecord = new Set();
  for (const [pid, row] of Object.entries(hub3Stock || {})) {
    if (pid === "_meta") continue;
    const product = products?.[pid] || null;
    if (isFootwear(product)) { footwearKept.push(pid); continue; }
    if (!product) noRecord.add(pid);
    if (!isObj(row) && !Array.isArray(row)) { skipped.push({ pid, why: "row_not_object" }); continue; }
    for (const [sizeKey, cell] of Object.entries(row)) {
      if (cell == null) continue;
      const q = qtyOf(cell);
      if (UNSAFE.test(pid) || UNSAFE.test(sizeKey)) { skipped.push({ pid, sizeKey, qty: q, why: "unsafe_key" }); continue; }
      const base = { pid, sizeKey, size: sizeOfKey(sizeKey, product), path: `stock/${HUB}/${pid}/${sizeKey}`, name: product?.name || null, category: product ? (product.categoryKey || product.category || "uncategorised") : "no product record", owner: owningShop(seats, pid) };
      if (q === null) { zeros.push({ ...base, qty: null, why: "no_numeric_qty" }); continue; }
      if (q > 0) {
        transfers.push({ ...base, qty: q, movementId: transferIdFor(runId, pid, sizeKey) });
        if (product && dv.divisionRefuses(DEST, product)) perfumes.add(pid); else if (product) seatOn.add(pid);
      } else if (q < 0) cleanups.push({ ...base, qty: q, movementId: cleanupIdFor(runId, pid, sizeKey) });
      else zeros.push({ ...base, qty: 0 });
    }
  }
  const seatsOff = Object.keys(seats?.[HUB] || {}).filter((pid) => !isFootwear(products?.[pid]));
  // Requests to withdraw: open, not a shadow, non-footwear, and either INTO
  // Hub 3 or into a division shop FROM Hub 3. Lock-backed ones are found via
  // their lock even when the request is older than the requests read.
  const srcOf = (r) => r?.createdFrom?.source || r?.source || null;
  const wanted = (r) => !!r && r.status === "open" && !r.shadow && !!r.productId && !isFootwear(products?.[r.productId])
    && (r.requestingLocation === HUB || (dv.DIVISION_SHOPS.includes(r.requestingLocation) && srcOf(r) === HUB));
  const withdraw = new Map();
  for (const [id, r] of Object.entries(requests || {})) if (wanted(r)) withdraw.set(id, { id, dest: r.requestingLocation, pid: r.productId, size: r.size ?? null, qty: Number(r.qty) || 0, lock: null });
  for (const [dest, byPid] of Object.entries(locks || {})) {
    for (const [pid, bySize] of Object.entries(byPid || {})) {
      if (isFootwear(products?.[pid])) continue;
      for (const [sizeKey, e] of Object.entries(bySize || {})) {
        if (!e?.refillId) continue;
        if (!(dest === HUB || (dv.DIVISION_SHOPS.includes(dest) && e.source === HUB))) continue;
        const w = withdraw.get(e.refillId) || { id: e.refillId, dest, pid, size: null, qty: Number(e.qty) || 0, lock: null, viaLockOnly: !requests?.[e.refillId] };
        w.lock = `refill_engine/open/${dest}/${pid}/${sizeKey}`;
        withdraw.set(e.refillId, w);
      }
    }
  }
  const sum = (l) => l.reduce((t, c) => t + (c.qty || 0), 0);
  const pidsOf = (l) => new Set(l.map((c) => c.pid));
  const byOwner = {};
  for (const t of transfers) { const o = (byOwner[t.owner] ||= { products: new Set(), units: 0 }); o.products.add(t.pid); o.units += t.qty; }
  return {
    runId, transfers, cleanups, zeros, skipped, footwearKept,
    seatOn: [...seatOn].sort(), seatsOff: seatsOff.sort(), perfumes: [...perfumes].sort(), noRecord: [...noRecord].sort(),
    withdraw: [...withdraw.values()],
    summary: {
      transferCells: transfers.length, transferProducts: pidsOf(transfers).size, transferUnits: sum(transfers),
      cleanupCells: cleanups.length, cleanupUnits: sum(cleanups), zeroCells: zeros.length,
      byOwner: Object.fromEntries(Object.entries(byOwner).map(([k, v]) => [k, { products: v.products.size, units: v.units }])),
      perfumeProducts: perfumes.size, perfumeUnits: sum(transfers.filter((t) => perfumes.has(t.pid))),
      seatOn: seatOn.size, seatsOff: seatsOff.length, withdraw: withdraw.size,
    },
  };
}

/** Refuse a plan that would touch a footwear product or write outside its paths. */
export function assertPlanScope(plan, products, { allowNoRecord = false } = {}) {
  // A cell above zero whose product record is gone cannot be classified: it
  // might be footwear. Refused unless the operator has looked and said so.
  const blind = plan.transfers.filter((c) => !products?.[c.pid]);
  if (blind.length && !allowNoRecord) throw new Error(`REFUSED: ${blind.length} cell(s) above zero have no product record (${[...new Set(blind.map((c) => c.pid))].join(", ")}) — review them, then pass --allow-no-record`);
  for (const c of [...plan.transfers, ...plan.cleanups, ...plan.zeros]) {
    if (isFootwear(products?.[c.pid])) throw new Error(`REFUSED: ${c.pid} is footwear`);
    if (!c.path.startsWith(`stock/${HUB}/`) || c.path.split("/").length !== 4) throw new Error(`REFUSED: ${c.path} is outside stock/${HUB}/`);
  }
  for (const pid of plan.seatOn) if (dv.divisionRefuses(DEST, products?.[pid])) throw new Error(`REFUSED: ${pid} may not be seated at Concrete`);
}

const transferMovement = (c, qty, nowIso, runId) => ({
  type: "transfer_in", productId: c.pid, size: c.size, sizeKey: c.sizeKey, qty, from: HUB, to: DEST,
  reason: REASON, movementId: c.movementId, actor: ACTOR, actorRole: "admin", ts: nowIso,
  link: { deviceId: null, hub3ClothingRun: runId },
});
const cleanupMovement = (c, before, nowIso, runId) => ({
  type: "adjustment", productId: c.pid, size: c.size, sizeKey: c.sizeKey, qty: Math.abs(before), from: before > 0 ? HUB : null, to: before < 0 ? HUB : null,
  reason: CLEANUP_REASON, movementId: c.movementId, actor: ACTOR, actorRole: "admin", expectQty: before, ts: nowIso,
  link: { deviceId: null, hub3ClothingRun: runId, cleanupBefore: before },
});

/** One cell → Concrete in full; a cell that moved is re-read ALONE and re-planned. */
async function moveCell({ db, c, applyMovementAdmin, nowIso, runId, log }) {
  let qty = c.qty;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!(qty > 0)) return { ...c, moved: 0, note: qty === 0 ? "now_zero" : "now_negative", now: qty };
    const r = await applyMovementAdmin(db, transferMovement(c, qty, nowIso, runId), { nowIso });
    if (r.ok) return { ...c, moved: r.idempotent ? 0 : qty, idempotent: !!r.idempotent, plannedQty: c.qty, qty };
    if (r.reason !== "insufficient_stock") return { ...c, moved: 0, refused: r.reason, r };
    const now = qtyOf((await db.ref(c.path).once("value")).val());
    log(`  moved since read: ${c.path} ${qty} → ${now}, re-planning`);
    if (now === null) return { ...c, moved: 0, refused: "cell_gone" };
    qty = now;
  }
  return { ...c, moved: 0, refused: "kept_moving" };
}

async function cleanupCell({ db, c, applyMovementAdmin, nowIso, runId, log }) {
  let before = c.qty;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (before === 0) return { ...c, applied: 0, note: "already_zero" };
    if (before > 0) return { ...c, applied: 0, note: "now_positive", now: before };
    const r = await applyMovementAdmin(db, cleanupMovement(c, before, nowIso, runId), { nowIso });
    if (r.ok) return { ...c, applied: r.idempotent ? 0 : -before, idempotent: !!r.idempotent };
    if (r.reason !== "cell_changed") return { ...c, applied: 0, refused: r.reason };
    const now = qtyOf((await db.ref(c.path).once("value")).val());
    log(`  moved since read: ${c.path} ${before} → ${now}, retrying`);
    if (now === null) return { ...c, applied: 0, refused: "cell_gone" };
    before = now;
  }
  return { ...c, applied: 0, refused: "kept_moving" };
}

// Remove a non-footwear Hub 3 cell only while it holds exactly 0 and carries no
// in-flight movement stamp. Anything else is left and reported.
async function removeZeroCell(db, path) {
  let seen = null;
  const pre = (await db.ref(path).once("value")).val();
  if (pre === null) return { path, removed: false, note: "absent" };
  const res = await db.ref(path).transaction((raw) => {
    const cur = raw === null ? pre : raw;
    seen = cur;
    if (cur === null) return null;
    if (!isObj(cur) || cur.relMv) return undefined;
    if (cur.qty !== 0 && cur.qty !== undefined) return undefined;
    return null;
  });
  return { path, removed: !!res.committed && res.snapshot.val() === null, before: seen };
}

async function withdrawRequest(db, w, nowIso) {
  let outcome = "absent";
  const res = await db.ref(`refill_requests/${w.id}`).transaction((cur) => {
    if (cur === null) return null;
    if (cur.status !== "open") { outcome = `not_open:${cur.status}`; return undefined; }
    if (!requestUntouched(cur, Date.parse(nowIso))) { outcome = "touched"; return undefined; }
    outcome = "withdrawn";
    return { ...cur, status: "cancelled", resolvedAt: nowIso, cancelReason: REASON };
  });
  const done = outcome === "withdrawn" && !!res.committed;
  if (done && w.lock) {
    const lock = (await db.ref(w.lock).once("value")).val();
    if (lock && lock.refillId === w.id) await db.ref(w.lock).remove();
  }
  return { ...w, outcome: done ? "withdrawn" : outcome };
}

/**
 * Apply the plan. `applyMovementAdmin` is injected (functions/lib/admin-movement.cjs).
 * Returns what actually landed.
 */
export async function applyHub3ClothingTransfer({ db, plan, products, applyMovementAdmin, nowMs, concurrency = 6, log = () => {}, allowNoRecord = false }) {
  assertPlanScope(plan, products, { allowNoRecord });
  const nowIso = new Date(nowMs).toISOString();
  const pool = async (items, fn) => {
    const out = []; const q = [...items];
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => { while (q.length) out.push(await fn(q.shift())); }));
    return out;
  };
  const moved = await pool(plan.transfers, (c) => moveCell({ db, c, applyMovementAdmin, nowIso, runId: plan.runId, log }));
  const cleaned = await pool(plan.cleanups, (c) => cleanupCell({ db, c, applyMovementAdmin, nowIso, runId: plan.runId, log }));
  // Seats: Concrete on (never overwriting a seat already there), its release
  // tombstone cleared; Hub 3 non-footwear off.
  const seatUpd = {};
  for (const pid of plan.seatOn) {
    const ok = moved.some((m) => m.pid === pid && (m.moved > 0 || m.idempotent));
    if (!ok) continue;
    const cur = (await db.ref(`${dv.SEATS_PATH}/${DEST}/${pid}`).once("value")).val();
    if (!cur) seatUpd[`${dv.SEATS_PATH}/${DEST}/${pid}`] = { via: SEAT_VIA, at: nowIso, run: plan.runId };
    seatUpd[`refill_engine/seatReleases/${DEST}/${pid}`] = null;
  }
  for (const pid of plan.seatsOff) seatUpd[`${dv.SEATS_PATH}/${HUB}/${pid}`] = null;
  if (Object.keys(seatUpd).length) await db.ref().update(seatUpd);
  const withdrawn = [];
  for (const w of plan.withdraw) withdrawn.push(await withdrawRequest(db, w, nowIso));
  return { moved, cleaned, seatWrites: Object.keys(seatUpd).length, withdrawn, nowIso };
}

/**
 * After the moves: every non-footwear cell left at Hub 3 is removed when it is
 * at zero; one still above zero (an arrival in the gap) is moved with a second
 * movement (id suffix _v<pass>); one below zero is cleaned up. Repeats until
 * Hub 3 holds footwear only, or `passes` runs out. Reads /stock/hub3 alone.
 */
export async function finishAndVerify({ db, products, applyMovementAdmin, nowMs, runId, passes = 3, log = () => {}, readHub3 = null }) {
  const nowIso = new Date(nowMs).toISOString();
  const history = [];
  const removedCells = [];
  // The caller may hand in a paged reader (the runner does); the default is one
  // read of the single location node.
  const read = readHub3 || (async () => (await db.ref(`stock/${HUB}`).once("value")).val() || {});
  for (let pass = 1; pass <= passes; pass++) {
    const hub3 = await read();
    const leftovers = [];
    for (const [pid, row] of Object.entries(hub3)) {
      if (pid === "_meta" || isFootwear(products?.[pid])) continue;
      for (const [sizeKey, cell] of Object.entries(isObj(row) || Array.isArray(row) ? row : {})) if (cell != null) leftovers.push({ pid, sizeKey, qty: qtyOf(cell), path: `stock/${HUB}/${pid}/${sizeKey}` });
    }
    if (!leftovers.length) { history.push({ pass, leftovers: 0 }); return { clean: true, history, removedCells }; }
    const step = { pass, leftovers: leftovers.length, removed: 0, moved: 0, cleaned: 0, refused: [] };
    for (const l of leftovers) {
      const base = { pid: l.pid, sizeKey: l.sizeKey, size: sizeOfKey(l.sizeKey, products?.[l.pid]), path: l.path };
      if (l.qty > 0) {
        const r = await moveCell({ db, c: { ...base, qty: l.qty, movementId: `${transferIdFor(runId, l.pid, l.sizeKey)}_v${pass}` }, applyMovementAdmin, nowIso, runId, log });
        if (r.moved > 0) step.moved += r.moved; else if (r.refused) step.refused.push({ ...base, why: r.refused });
      } else if (l.qty < 0) {
        const r = await cleanupCell({ db, c: { ...base, qty: l.qty, movementId: `${cleanupIdFor(runId, l.pid, l.sizeKey)}_v${pass}` }, applyMovementAdmin, nowIso, runId, log });
        if (r.applied > 0) step.cleaned += r.applied; else if (r.refused) step.refused.push({ ...base, why: r.refused });
      }
      const after = qtyOf((await db.ref(l.path).once("value")).val());
      if (after === 0 || after === null) {
        const rm = await removeZeroCell(db, l.path);
        if (rm.removed) { step.removed++; removedCells.push({ path: l.path, before: rm.before }); }
      }
    }
    history.push(step);
  }
  const hub3 = await read();
  const left = Object.keys(hub3).filter((pid) => pid !== "_meta" && !isFootwear(products?.[pid]));
  return { clean: left.length === 0, left, history, removedCells };
}

// ── EXPLICIT ROWS STILL AT THE RETIRED FROM-HUB 3 KEEP ───────────────────────
// A Solve stamped explicit /stock_targets rows at Pine/Concrete with the old
// from-Hub 3 numbers (1 per size / 5 per design, ask at 0). Junid, 12 Nov 2026:
// every Pine/Concrete non-footwear product is shop-only at 2/5. Rows are never
// deleted — exactly those rows are edited in place to the shop keep (ask-at
// removed); every other explicit row (a switch-off at 0, a hand-set number) is
// left as it is and listed.
export const RETIRED_FROM_HUB3 = Object.freeze({ perSize: 1, oneSize: 5, askAt: 0 });
export const SHOP_KEEP = Object.freeze({ perSize: 2, oneSize: 5 });
export function planRowAlign({ targets, products }) {
  const align = [], left = [];
  for (const loc of dv.DIVISION_SHOPS) {
    for (const [pid, rows] of Object.entries(targets?.[loc] || {})) {
      const p = products?.[pid];
      if (!p || isFootwear(p) || dv.divisionRefuses(loc, p)) continue;
      const one = dv.isDivisionOneSize(p);
      for (const [sizeKey, r] of Object.entries(rows || {})) {
        if (!isObj(r) || typeof r.target !== "number") continue;
        const retired = r.reorderPoint === RETIRED_FROM_HUB3.askAt && r.target === (one ? RETIRED_FROM_HUB3.oneSize : RETIRED_FROM_HUB3.perSize);
        const entry = { loc, pid, sizeKey, path: `stock_targets/${loc}/${pid}/${sizeKey}`, from: { target: r.target, minQty: r.minQty ?? null, reorderPoint: r.reorderPoint ?? null } };
        if (retired) align.push({ ...entry, to: { target: one ? SHOP_KEEP.oneSize : SHOP_KEEP.perSize, minQty: one ? SHOP_KEEP.oneSize - 1 : SHOP_KEEP.perSize - 1, reorderPoint: null } });
        else if (r.target > 0) left.push(entry);
      }
    }
  }
  return { align, left };
}
export async function applyRowAlign({ db, align, nowIso, by = ACTOR }) {
  const out = [];
  for (const a of align) {
    let outcome = "changed_since_read";
    // COLD-NULL TRAP: the first callback may see null for a row that exists;
    // judge it against a plain read instead of aborting on it.
    const pre = (await db.ref(a.path).once("value")).val();
    if (pre === null) { out.push({ ...a, outcome: "absent" }); continue; }
    await db.ref(a.path).transaction((raw) => {
      const cur = raw === null ? pre : raw;
      if (!(cur.target === a.from.target && (cur.reorderPoint ?? null) === a.from.reorderPoint)) { outcome = "changed_since_read"; return undefined; }
      outcome = "aligned";
      return { ...cur, target: a.to.target, minQty: a.to.minQty, reorderPoint: null, setAt: nowIso, setBy: by, prevRetiredHub3Keep: a.from };
    });
    out.push({ ...a, outcome });
  }
  return out;
}

// ── THE ONE-OFF RELEASE (Junid, 12 Nov 2026) ─────────────────────────────────
// The Concrete-division lines the first scan raises are released for picking
// now, through the existing urgent override (earlyRelease on the request); the
// 06:00/14:00 schedule is not changed and no Marathon line is touched.
export function planEarlyRelease({ requests, sinceIso }) {
  return Object.entries(requests || {})
    .filter(([, r]) => r && r.status === "open" && !r.shadow && !r.earlyRelease && dv.DIVISION_LOCATIONS.includes(r.requestingLocation) && String(r.createdAt || "") >= String(sinceIso))
    .map(([id, r]) => ({ id, dest: r.requestingLocation, pid: r.productId, size: r.size ?? null, qty: Number(r.qty) || 0, source: r.createdFrom?.source || r.source || null }));
}
export async function applyEarlyRelease({ db, lines, nowIso, by, reason }) {
  const out = [];
  for (const l of lines) {
    let outcome = "skipped";
    await db.ref(`refill_requests/${l.id}`).transaction((cur) => {
      if (cur === null) return null;
      if (cur.status !== "open" || cur.earlyRelease || !dv.DIVISION_LOCATIONS.includes(cur.requestingLocation)) { outcome = "skipped"; return undefined; }
      outcome = "released";
      return { ...cur, earlyRelease: { at: nowIso, by, reason } };
    });
    out.push({ ...l, outcome });
  }
  return out;
}
