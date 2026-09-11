// ─── PROBE — the fulfil-credit gap (Diesel Slide Full Black, Hub 1, size 6) ──
// ONE-OFF, READ-ONLY FORENSIC SCRIPT. It writes nothing to RTDB. It never ships
// into the bundle. It reads the whole /stock_movements ledger ONCE (paged, via
// the shared pager — a deliberate one-off broad read for forensics, the kind
// the live app must never do) and answers, from data rather than inference:
//
//   PHASE A — the Diesel case
//     • did Central's size-6 cell decrement at the fulfil, and which movement;
//     • where the unit is now (the cells the fulfil touched, before → after);
//     • what "In Transit (2)" is made of — every stock/in_transit cell with
//       units, its parking movement, age, destination, shipment id;
//     • is /settings/stockHold/config/enabled on;
//     • did the fulfil's movement id collide with a pre-existing id;
//     • what Central held at 14:00 SA on 9 Sep and holds now, and what the
//       policy target resolves to — so "qty 1" is settled as gate-or-defect.
//
//   PHASE B — blast radius, last 30 days, every location and product
//     • every fulfilled refill request whose destination cell shows no
//       corresponding credit, with the cause;
//     • every unit sitting in stock/in_transit older than 24 hours;
//     • every fulfilled engine request granted less than the policy need,
//       split into correctly capped by source on-hand vs unexplained.
//
// HOW ON-HAND-AT-TIME IS RECONSTRUCTED. Movements written by applyMovement
// carry a per-location before/after snapshot; POS `sold` and `return`
// movements do not. On-hand at instant T for a cell = the `before` of the
// first snapshot-bearing movement AFTER T on that cell, minus the signed net
// of every snapshot-less movement between T and it (a sale −, a return +;
// those are already inside that `before`). With no later snapshot, the live
// cell minus the signed net of the snapshot-less movements after T.
//
// Usage:
//   node scripts/probe-fulfil-credit-gap.mjs --dump <dir>        # live read → dump + report
//   node scripts/probe-fulfil-credit-gap.mjs --from-dump <dir>   # re-analyse a saved dump
// Output: <dir>/probe-report.json and a markdown summary on stdout.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { adminRequire } from "./adminRequire.mjs";
import { readMapPaged } from "./lib/rtdbPaged.mjs";

const require = createRequire(import.meta.url);
const engine = require("../functions/lib/refill-engine.cjs");
const { encodeSizeKey, resolveTarget } = engine;

const args = process.argv.slice(2);
const argOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const FROM = argOf("--from-dump");
const DUMP = argOf("--dump");
if (!FROM && !DUMP) { console.error("usage: --dump <dir> | --from-dump <dir>"); process.exit(2); }
const DIR = FROM || DUMP;

// ── THE CASE ──────────────────────────────────────────────────────────────────
const CASE = {
  pid: "p1778157967464",                 // resolved from barcodes 00005410..15 below
  barcodes: ["00005410", "00005411", "00005412", "00005413", "00005414", "00005415"],
  size: "6", dest: "hub1", src: "central",
  requestId: "-P151_2zzLyo57i8j7Ll",
  raisedAt: "2026-09-09T12:00:04.905Z",  // 14:00 SA release window, 9 Sep
  fulfilledAt: "2026-09-10T08:01:49.727Z",
};

const DAY = 86400000;
const ms = (iso) => Date.parse(iso || "") || 0;
const q = (c) => (c && typeof c.qty === "number" ? c.qty : 0);

// ── LOAD ──────────────────────────────────────────────────────────────────────
async function load() {
  const readJson = (n) => JSON.parse(readFileSync(`${DIR}/${n}.json`, "utf8"));
  if (FROM) {
    return {
      movements: readJson("movements"), requests: readJson("requests"), stock: readJson("stock"),
      stockHold: readJson("stockHold"), targets: readJson("targets"), config: readJson("engineConfig"),
      products: readJson("products"), barcodes: readJson("barcodes"),
      caseExtra: existsSync(`${DIR}/caseExtra.json`) ? readJson("caseExtra") : {},
    };
  }
  const adminReq = adminRequire(import.meta.url);
  const admin = adminReq("firebase-admin");
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
  const db = admin.database();
  const one = async (p) => (await db.ref(p).once("value")).val();
  mkdirSync(DIR, { recursive: true });
  const out = {};
  out.movements = await readMapPaged(db, "stock_movements", { pageSize: 3000 });
  out.requests = await readMapPaged(db, "refill_requests", { pageSize: 3000 });
  out.stock = {};
  for (const loc of ["central", "hub1", "hub2", "hub3", "trophy", "marathon-pe", "marathon-pine", "in_transit"]) {
    out.stock[loc] = await readMapPaged(db, `stock/${loc}`, { pageSize: 1000 });
  }
  out.stockHold = (await one("settings/stockHold")) || {};
  out.targets = (await one("stock_targets")) || {};
  out.config = (await one("config/refillEngine")) || {};
  out.products = await readMapPaged(db, "products", { pageSize: 500 });
  out.barcodes = {};
  for (const b of CASE.barcodes) out.barcodes[b] = await one(`barcodes/${b}`);
  out.caseExtra = {
    request: await one(`refill_requests/${CASE.requestId}`),
    openLock: await one(`refill_engine/open/${CASE.dest}/${CASE.pid}`),
    transitConfig: await one("config/transit"),
    hubCountSessions: await one("settings/hubSneakerCount/sessions"),
  };
  for (const [k, v] of Object.entries(out)) writeFileSync(`${DIR}/${k === "config" ? "engineConfig" : k}.json`, JSON.stringify(v));
  return out;
}

const data = await load();
const { movements: MV, requests: REQ, stock: STOCK, stockHold: HOLD, targets, config, products: PRODUCTS, barcodes } = data;
const NOW = Date.now();
const WINDOW_START = NOW - 30 * DAY;

// ── LEDGER INDEX BY CELL ──────────────────────────────────────────────────────
const byCell = new Map();
for (const [id, m] of Object.entries(MV)) {
  if (!m || !m.productId) continue;
  const sk = encodeSizeKey(String(m.size));
  for (const loc of new Set([m.from, m.to].filter(Boolean))) {
    const k = `${loc}|${m.productId}|${sk}`;
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push({ id, ...m, _ts: ms(m.appliedAt || m.ts) });
  }
}
for (const arr of byCell.values()) arr.sort((a, b) => a._ts - b._ts);
const cellNow = (loc, pid, sk) => STOCK[loc]?.[pid]?.[sk] || null;
function onHandAt(loc, pid, sk, T) {
  // Every snapshot-less movement between T and the next snapshot is backed
  // out with its SIGN: a `sold` (−from) and a POS `return` (+to) alike
  // (second-brain review, PR #602 — returns were previously ignored).
  let net = 0;
  for (const m of byCell.get(`${loc}|${pid}|${sk}`) || []) {
    if (m._ts <= T) continue;
    if (m.before && typeof m.before[loc] === "number") return m.before[loc] - net;
    if (m.from === loc) net -= Number(m.qty) || 0;
    if (m.to === loc) net += Number(m.qty) || 0;
  }
  return q(cellNow(loc, pid, sk)) - net;
}
const name = (pid) => PRODUCTS[pid]?.name || "(product record missing)";
const releasedLineFor = (dest, lineId) => {
  for (const [shipmentId, lines] of Object.entries(HOLD?.released?.[dest] || {})) if (lines[lineId]) return { shipmentId, ...lines[lineId] };
  return null;
};

// ── PHASE A ───────────────────────────────────────────────────────────────────
const A = {};
A.barcodes = Object.fromEntries(CASE.barcodes.map((b) => [b, barcodes[b] ? { productId: barcodes[b].productId, size: barcodes[b].size } : null]));
A.resolvedPids = [...new Set(Object.values(A.barcodes).filter(Boolean).map((b) => b.productId))];
A.twinsByName = Object.entries(PRODUCTS)
  .filter(([, p]) => String(p?.name || "").trim().toLowerCase() === String(PRODUCTS[CASE.pid]?.name || "").trim().toLowerCase())
  .map(([id, p]) => ({ id, name: p.name, mergedInto: p.mergedInto || null, deactivated: !!p.deactivated }));
const sk6 = encodeSizeKey(CASE.size);
const fulfilMvId = `rrf_${CASE.requestId}`;
const fm = MV[fulfilMvId] || null;
A.fulfilMovement = fm && { id: fulfilMvId, type: fm.type, from: fm.from, to: fm.to, qty: fm.qty, before: fm.before, after: fm.after, appliedAt: fm.appliedAt, actor: fm.actor, reason: fm.reason };
A.centralDecremented = !!(fm && fm.from === CASE.src && fm.before && fm.after && fm.after[CASE.src] === fm.before[CASE.src] - Number(fm.qty));
A.destCredited = !!(fm && fm.to === CASE.dest && fm.before && fm.after && fm.after[CASE.dest] === fm.before[CASE.dest] + Number(fm.qty));
A.destBeforeWasNegative = !!(fm && fm.before && typeof fm.before[CASE.dest] === "number" && fm.before[CASE.dest] < 0);
A.unitNow = {
  central: cellNow(CASE.src, CASE.pid, sk6),
  hub1: cellNow(CASE.dest, CASE.pid, sk6),
  in_transit: cellNow("in_transit", CASE.pid, sk6),
};
A.hub1Size6History = (byCell.get(`${CASE.dest}|${CASE.pid}|${sk6}`) || []).map((m) => ({
  ts: m.appliedAt || m.ts, id: m.id, type: m.type, qty: m.qty, from: m.from || null, to: m.to || null,
  before: m.before?.[CASE.dest] ?? null, after: m.after?.[CASE.dest] ?? null, reason: m.reason || null, actor: m.actor,
}));
A.holdEnabled = HOLD?.config?.enabled === true;
A.holdConfig = HOLD?.config || null;
A.heldLinesNow = Object.values(HOLD?.held || {}).reduce((n, byLine) => n + Object.keys(byLine || {}).length, 0);
// Id collision: a movement id derived from the request id can only collide if
// the same id existed BEFORE this fulfil. Evidence: the recorded movement's
// link.refillId and productId match the request, and its appliedAt equals the
// request's resolution — the record IS this fulfil, not an older one.
A.idCollision = fm ? {
  collided: !(fm.link?.refillId === CASE.requestId && fm.productId === CASE.pid && String(fm.size) === CASE.size && Math.abs(ms(fm.appliedAt) - ms(CASE.fulfilledAt)) < 5000),
  recordedRefillId: fm.link?.refillId || null, recordedProductId: fm.productId, recordedAppliedAt: fm.appliedAt,
  trancheIds: Object.keys(MV).filter((id) => id.startsWith(`${fulfilMvId}_`)),
} : { collided: false, note: "no movement under the derived id" };
// In Transit (2): every in_transit cell holding units.
A.inTransitCells = [];
for (const [pid, bySize] of Object.entries(STOCK.in_transit || {})) {
  for (const [sk, c] of Object.entries(bySize || {})) {
    if (!(q(c) > 0)) continue;
    const pm = MV[c.mv] || null;
    A.inTransitCells.push({
      productId: pid, name: name(pid), productExists: !!PRODUCTS[pid], sizeKey: sk, qty: q(c),
      parkedBy: c.mv, parkedAt: c.updatedAt, ageHours: Math.round((NOW - ms(c.updatedAt)) / 3600000),
      destination: pm?.link?.holdDest || null, refillId: pm?.link?.refillId || null,
      heldLine: pm?.link?.holdDest ? (HOLD?.held?.[pm.link.holdDest]?.[c.mv] || null) : null,
      releasedArchive: pm?.link?.holdDest ? releasedLineFor(pm.link.holdDest, c.mv) : null,
      releaseMovementExists: !!MV[`rel_${c.mv}`],
    });
  }
}
const T_RAISED = ms(CASE.raisedAt);
A.centralAtRaise = onHandAt(CASE.src, CASE.pid, sk6, T_RAISED);
A.centralNow = q(A.unitNow.central);
A.hub1AtRaise = onHandAt(CASE.dest, CASE.pid, sk6, T_RAISED);
A.policy = resolveTarget({ targets, config, products: PRODUCTS, stock: STOCK }, CASE.dest, CASE.pid, CASE.size);
A.needAtRaise = A.policy ? Math.max(A.policy.target - Math.max(A.hub1AtRaise, 0), 0) : null;
A.qtyGranted = Number(REQ[CASE.requestId]?.fulfilledBy?.qty ?? REQ[CASE.requestId]?.qty) || null;
A.gateVerdict = A.needAtRaise != null
  ? (A.qtyGranted === Math.min(A.needAtRaise, Math.max(A.centralAtRaise, 0), Number(config?.maxUnitsPerIntent) || 20) ? "source gate worked: qty = min(need, central on-hand)" : "qty does not equal min(need, central on-hand) — needs explanation")
  : "no policy target resolves";
A.caseExtra = data.caseExtra || {};

// ── PHASE B1 — fulfilled requests with no corresponding credit ────────────────
const B1 = { rows: [], byCause: {} };
const tally = (cause, units) => { const t = (B1.byCause[cause] = B1.byCause[cause] || { count: 0, units: 0 }); t.count++; t.units += units; };
for (const [id, r] of Object.entries(REQ)) {
  if (!r || r.status !== "fulfilled" || ms(r.resolvedAt) < WINDOW_START) continue;
  const dest = r.requestingLocation; const sk = encodeSizeKey(String(r.size));
  // every fulfil movement for this request: the recorded id plus any tranche
  // (link.refillId), EXCLUDING release legs (rel_…) which are judged with their fulfil.
  const ids = new Set([r.fulfilledBy?.movementId].filter(Boolean));
  // Adjustments are excluded: an adjustment nets against a negative by
  // design (the repair's own fcr_ rows link the request too and must not read
  // as a second absorption).
  for (const [mid, m] of Object.entries(MV)) if (m?.link?.refillId === id && !mid.startsWith("rel_") && m.type !== "sold" && m.type !== "adjustment") ids.add(mid);
  if (!ids.size) {
    // A store leg (trophy / marathon-pe ← hub2) is closed by the ENGINE when
    // its R### order is dispatched; the stock moves under the order's own
    // dispatch movement (link.orderId), never under the request id. Counted
    // separately — not a credit gap, not traceable per request from the ledger.
    if (!r.fulfilledBy) { B1.storeLegsClosedByEngine = (B1.storeLegsClosedByEngine || 0) + 1; continue; }
    tally("movement_missing", Number(r.fulfilledBy?.qty) || 0);
    B1.rows.push({ requestId: id, dest, productId: r.productId, name: name(r.productId), size: r.size, cause: "movement_missing", units: Number(r.fulfilledBy?.qty) || 0 });
    continue;
  }
  for (const mid of ids) {
    const m = MV[mid];
    const base = { requestId: id, movementId: mid, dest, productId: r.productId, name: name(r.productId), size: r.size, qty: m?.qty ?? null, resolvedAt: r.resolvedAt };
    if (!m) { tally("movement_missing", Number(r.fulfilledBy?.qty) || 0); B1.rows.push({ ...base, cause: "movement_missing", units: Number(r.fulfilledBy?.qty) || 0 }); continue; }
    if (m.to === dest) {
      const b = m.before?.[dest], a = m.after?.[dest];
      if (typeof b !== "number") { tally("no_snapshot", 0); B1.rows.push({ ...base, cause: "no_snapshot", units: 0 }); }
      else if (b < 0) { const u = Math.min(Number(m.qty), -b); tally("credit_absorbed_by_negative_destination_cell", u); B1.rows.push({ ...base, cause: "credit_absorbed_by_negative_destination_cell", units: u, before: b, after: a, cellNow: q(cellNow(dest, r.productId, sk)) }); }
      else if (a !== b + Number(m.qty)) { tally("credit_arithmetic_mismatch", Number(m.qty)); B1.rows.push({ ...base, cause: "credit_arithmetic_mismatch", units: Number(m.qty), before: b, after: a }); }
    } else if (m.to === "in_transit") {
      const rel = MV[`rel_${mid}`];
      if (!rel) {
        const held = HOLD?.held?.[dest]?.[mid] || null; const archived = releasedLineFor(dest, mid);
        const cause = held ? "parked_in_transit_awaiting_release" : "parked_in_transit_stranded";
        tally(cause, Number(m.qty));
        B1.rows.push({ ...base, cause, units: Number(m.qty), inTransitNow: q(cellNow("in_transit", r.productId, sk)), heldLine: !!held, releasedArchive: archived ? { shipmentId: archived.shipmentId, releasedAt: archived.releasedAt, releaseMovementId: archived.releaseMovementId } : null, productExists: !!PRODUCTS[r.productId] });
      } else {
        const b = rel.before?.[dest];
        if (typeof b === "number" && b < 0) { const u = Math.min(Number(rel.qty), -b); tally("credit_absorbed_by_negative_destination_cell", u); B1.rows.push({ ...base, movementId: `rel_${mid}`, qty: rel.qty, cause: "credit_absorbed_by_negative_destination_cell", units: u, before: b, after: rel.after?.[dest], cellNow: q(cellNow(dest, r.productId, sk)), viaRelease: true }); }
      }
    } else { tally("credited_elsewhere", Number(m.qty)); B1.rows.push({ ...base, cause: "credited_elsewhere", units: Number(m.qty), to: m.to }); }
  }
}
B1.rows.sort((a, b) => String(a.resolvedAt).localeCompare(String(b.resolvedAt)));

// ── PHASE B1b — THE WIDER CLASS: every arrival onto a negative shelf ─────────
// The defect the Diesel case exposes is not specific to refill requests: ANY
// positive stock leg landing on a negative cell pays the phantom debt first.
// Counted across every relocation and receipt in the window (adjustments
// excluded — a count adjustment states an absolute intent and is judged by
// the counter, not by this arithmetic). Reported, not repaired here.
const B1b = { movements: 0, units: 0, byDestAndReason: {} };
for (const [id, m] of Object.entries(MV)) {
  if (!m || !m.to || m.to === "in_transit" || !m.before || m.type === "adjustment") continue;
  if (ms(m.appliedAt || m.ts) < WINDOW_START) continue;
  const b = m.before[m.to];
  if (typeof b !== "number" || b >= 0) continue;
  const u = Math.min(Number(m.qty) || 0, -b);
  B1b.movements++; B1b.units += u;
  const k = `${m.to} · ${m.type} · ${m.reason || "(no reason)"}`;
  const t = (B1b.byDestAndReason[k] = B1b.byDestAndReason[k] || { movements: 0, units: 0 });
  t.movements++; t.units += u;
}

// ── PHASE B2 — in_transit units older than 24h ────────────────────────────────
const B2 = A.inTransitCells.filter((c) => c.ageHours >= 24);

// ── PHASE B3 — granted less than the policy need ──────────────────────────────
// Policy evaluated with TODAY's config/targets (the engine has no policy
// history); destination and source on-hand reconstructed at createdAt.
const ctx = { targets, config, products: PRODUCTS, stock: STOCK };
const B3 = { considered: 0, noTarget: 0, fullGap: 0, capped: [], unexplained: [] };
for (const [id, r] of Object.entries(REQ)) {
  if (!r || r.status !== "fulfilled" || !r.createdFrom?.engine || ms(r.resolvedAt) < WINDOW_START) continue;
  const dest = r.requestingLocation, src = r.createdFrom.source || "central", sk = encodeSizeKey(String(r.size));
  const t = resolveTarget(ctx, dest, r.productId, String(r.size));
  if (!t || !(t.target > 0)) { B3.noTarget++; continue; }
  const T = ms(r.createdAt);
  const destHave = Math.max(onHandAt(dest, r.productId, sk, T), 0);
  const srcHave = Math.max(onHandAt(src, r.productId, sk, T), 0);
  const gap = Math.max(t.target - destHave, 0);
  const asked = (Number(r.qty) || 0) + (Number(r.sentQty) || 0);
  B3.considered++;
  if (asked >= gap) { B3.fullGap++; continue; }
  const row = { requestId: id, dest, src, productId: r.productId, name: name(r.productId), footwear: engine.isClothing(PRODUCTS[r.productId]) ? false : (PRODUCTS[r.productId]?.category === "Footwear"), size: r.size, target: t.target, targetSource: t.source, destHave, srcHave, gap, asked, createdAt: r.createdAt };
  if (asked === Math.min(gap, srcHave, Number(config?.maxUnitsPerIntent) || 20)) B3.capped.push(row); else B3.unexplained.push(row);
}
B3.unexplainedFootwear = B3.unexplained.filter((r) => r.footwear).length;
B3.unexplainedClothing = B3.unexplained.length - B3.unexplainedFootwear;

// ── REPORT ────────────────────────────────────────────────────────────────────
const report = { generatedAt: new Date(NOW).toISOString(), windowStart: new Date(WINDOW_START).toISOString(), case: CASE, phaseA: A, phaseB: { creditGap: B1, arrivalsOntoNegativeCells: B1b, transitOver24h: B2, qtyBelowNeed: B3 } };
mkdirSync(DIR, { recursive: true });
writeFileSync(`${DIR}/probe-report.json`, JSON.stringify(report, null, 2));

const md = [];
md.push(`# Fulfil-credit gap probe — ${report.generatedAt}`);
md.push(`\n## Phase A — ${name(CASE.pid)} (${CASE.pid}) size ${CASE.size}`);
md.push(`- barcodes resolve to: ${A.resolvedPids.join(", ")}; same-name records: ${A.twinsByName.map((t) => `${t.id}${t.mergedInto ? " (merged)" : ""}`).join(", ")}`);
md.push(`- fulfil movement: ${JSON.stringify(A.fulfilMovement)}`);
md.push(`- Central decremented: ${A.centralDecremented}; destination credited by arithmetic: ${A.destCredited}; destination cell was NEGATIVE before the credit: ${A.destBeforeWasNegative}`);
md.push(`- cells now: central ${q(A.unitNow.central)}, hub1 ${q(A.unitNow.hub1)}, in_transit ${q(A.unitNow.in_transit)}`);
md.push(`- hold enabled: ${A.holdEnabled} (config ${JSON.stringify(A.holdConfig)}); held lines now: ${A.heldLinesNow}`);
md.push(`- id collision: ${JSON.stringify(A.idCollision)}`);
md.push(`- in_transit cells with units (${A.inTransitCells.length}):`);
for (const c of A.inTransitCells) md.push(`  - ${c.name} [${c.productId}] size ${c.sizeKey} qty ${c.qty}, parked ${c.parkedAt} (${c.ageHours}h) by ${c.parkedBy}, dest ${c.destination}, shipment ${c.releasedArchive?.shipmentId || c.heldLine?.shipmentId || "—"}, held line ${!!c.heldLine}, released archive ${!!c.releasedArchive}, release movement exists ${c.releaseMovementExists}, product exists ${c.productExists}`);
md.push(`- Central size ${CASE.size} at raise (${CASE.raisedAt}): ${A.centralAtRaise}; now: ${A.centralNow}; hub1 at raise: ${A.hub1AtRaise}`);
md.push(`- policy: ${JSON.stringify(A.policy)}; need at raise: ${A.needAtRaise}; granted: ${A.qtyGranted} → ${A.gateVerdict}`);
md.push(`- hub1 size ${CASE.size} ledger:`);
for (const h of A.hub1Size6History) md.push(`  - ${h.ts} ${h.type} ${h.qty} ${h.from || ""}→${h.to || ""} before ${h.before} after ${h.after} ${h.reason || ""} (${h.id})`);
md.push(`\n## Phase B — last 30 days (from ${report.windowStart})`);
md.push(`### B1 fulfilled requests with no corresponding destination credit`);
md.push(`| cause | requests | units |\n|---|---|---|`);
for (const [c, t] of Object.entries(B1.byCause)) md.push(`| ${c} | ${t.count} | ${t.units} |`);
md.push(`\n| resolved | dest | product | size | qty | cause | units | detail |\n|---|---|---|---|---|---|---|---|`);
for (const r of B1.rows) md.push(`| ${r.resolvedAt || ""} | ${r.dest} | ${r.name} [${r.productId}] | ${r.size} | ${r.qty ?? ""} | ${r.cause}${r.viaRelease ? " (at release)" : ""} | ${r.units} | ${r.before != null ? `before ${r.before} → after ${r.after}, cell now ${r.cellNow}` : r.releasedArchive ? `archived as released ${r.releasedArchive.releasedAt} (${r.releasedArchive.releaseMovementId}, movement absent); in_transit now ${r.inTransitNow}; product exists ${r.productExists}` : ""} |`);
md.push(`- store legs closed by the engine on order dispatch (no per-request movement, not a gap): ${B1.storeLegsClosedByEngine || 0}`);
md.push(`\n### B1b the wider class — arrivals onto negative shelves (30 days, adjustments excluded): ${B1b.movements} movements, ${B1b.units} units absorbed`);
md.push(`| destination · type · reason | movements | units |\n|---|---|---|`);
for (const [k, t] of Object.entries(B1b.byDestAndReason).sort((a, b) => b[1].units - a[1].units)) md.push(`| ${k.slice(0, 90)} | ${t.movements} | ${t.units} |`);
md.push(`\n### B2 stock/in_transit units older than 24h: ${B2.length} cells, ${B2.reduce((n, c) => n + c.qty, 0)} units`);
for (const c of B2) md.push(`- ${c.name} [${c.productId}] size ${c.sizeKey} qty ${c.qty}, ${c.ageHours}h, parked by ${c.parkedBy}, dest ${c.destination}, shipment ${c.releasedArchive?.shipmentId || "—"}`);
md.push(`\n### B3 engine requests granted below the policy need (policy = today's config)`);
md.push(`- considered ${B3.considered}; no target today ${B3.noTarget}; asked the full gap ${B3.fullGap}; capped by source on-hand ${B3.capped.length}; unexplained ${B3.unexplained.length} (footwear ${B3.unexplainedFootwear}, clothing ${B3.unexplainedClothing})`);
for (const r of B3.unexplained.filter((x) => x.footwear)) md.push(`  - FOOTWEAR ${r.createdAt} ${r.dest}←${r.src} ${r.name} size ${r.size}: target ${r.target} (${r.targetSource}), dest had ${r.destHave}, src had ${r.srcHave}, gap ${r.gap}, asked ${r.asked}`);
console.log(md.join("\n"));
console.log(`\nJSON: ${DIR}/probe-report.json`);
process.exit(0);
