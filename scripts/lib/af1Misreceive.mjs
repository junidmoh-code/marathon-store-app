// ─── AF1 white received on the wrong product — facts + correction plan ───────
// One-off (Junid, 28 Nov 2026). New plain white Air Force 1 stock was received
// onto "Nike Air Force 1 White Yellow Logo" (DD1525-100, the WRONG product)
// instead of "Nike Air Force 1 White" (315122-111, the RIGHT product).
//
// This module is PURE: it never reads or writes the database. The scripts
// scripts/af1-misreceive-investigate.mjs (live, read-only) and
// scripts/af1-misreceive-plan.mjs (dry run) feed it ledger rows and cells.
//
// The plan follows Junid's brief, per size and location:
//   RIGHT delta = +R − M − Ys        WRONG delta = −R + Ys
// R  = units received onto WRONG, followed through later WRONG transfers to
//      the place they sit now;
// M  = the manual add(s) on RIGHT on the manual day;
// Ys = WRONG sales since the receive (white shoes sold under the wrong name),
//      unless that cell held real WRONG stock before the receive → ambiguous.
// Check: the two products together change by exactly −M.
//
// It also refuses to call a plan applicable when the brief's own premise does
// not hold — see BLOCKERS below. A blocked plan is printed, never applied.

export const SAST_OFFSET_MS = 2 * 3600 * 1000;
export const REASON = "Correction: AF1 white received on wrong product (DD1525-100 → 315122-111); manual add of 28 Nov reversed";

/** SAST calendar day ("YYYY-MM-DD") of an ISO timestamp. */
export const sastDay = (iso) => new Date(Date.parse(iso) + SAST_OFFSET_MS).toISOString().slice(0, 10);

/** Ledger keeps the RAW size; cells use the encoded key. Same fold as stockCellKey. */
export function sizeKey(size) {
  const s = size == null ? "" : String(size).trim();
  if (!s || s === "Free Size") return "_";
  return s.replace(/[.#$/\[\]\s]/g, "_");
}

/**
 * RTDB returns a node whose keys are all small integers as an ARRAY, with the
 * missing (deleted / empty) children as null holes — a product's size cells
 * "3","4","5" come back as [null, null, null, {qty}, …]. Normalise either shape
 * to { sizeKey: qty } and drop holes, so a hole is never read as a zero cell.
 */
export function cellsToMap(raw) {
  const out = {};
  if (raw == null) return out;
  const entries = Array.isArray(raw) ? raw.map((v, i) => [String(i), v]) : Object.entries(raw);
  for (const [k, c] of entries) {
    if (c == null || typeof c !== "object") continue;
    out[k] = typeof c.qty === "number" ? c.qty : 0;
  }
  return out;
}

const add = (obj, loc, sk, n) => {
  if (!n) return;
  obj[loc] = obj[loc] || {};
  obj[loc][sk] = (obj[loc][sk] || 0) + n;
};
const get = (obj, loc, sk) => (obj[loc] && obj[loc][sk]) || 0;
const sumNested = (obj) => Object.values(obj).reduce((t, m) => t + Object.values(m).reduce((a, b) => a + b, 0), 0);

/** Group receive rows into events: same actor + location, rows ≤ gapMs apart. */
export function groupReceiveEvents(rows, gapMs = 10 * 60 * 1000) {
  const sorted = [...rows].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const events = [];
  for (const r of sorted) {
    const last = events.find((e) => e.actor === r.actor && e.location === r.to && Date.parse(r.ts) - Date.parse(e.lastTs) <= gapMs);
    if (last) {
      last.rows.push(r.id); last.lastTs = r.ts;
      last.sizes[sizeKey(r.size)] = (last.sizes[sizeKey(r.size)] || 0) + Number(r.qty);
      last.units += Number(r.qty);
    } else {
      events.push({ productId: r.productId, actor: r.actor, location: r.to, firstTs: r.ts, lastTs: r.ts, rows: [r.id], sizes: { [sizeKey(r.size)]: Number(r.qty) }, units: Number(r.qty) });
    }
  }
  return events;
}

/** Share of sizes (by the union of both events) whose quantities are equal. */
export function sizeMatchShare(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (!keys.size) return 0;
  let same = 0;
  for (const k of keys) if ((a[k] || 0) === (b[k] || 0)) same += 1;
  return same / keys.size;
}

/**
 * The quantity a cell held just before `ts`, from the first ledger row that
 * touched it at/after `ts` (its `before`), else the current cell (nothing has
 * touched it since). `rows` must all belong to one product.
 */
export function levelBefore(rows, loc, sk, ts, nowCells) {
  const touching = rows
    .filter((r) => r.ts >= ts && sizeKey(r.size) === sk && r.before && Object.prototype.hasOwnProperty.call(r.before, loc))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  if (touching.length) return Number(touching[0].before[loc]) || 0;
  return get(nowCells, loc, sk);
}

/**
 * facts({ wrongPid, rightPid, rows, cells, receiveFrom, receiveTo, manualDay, manualActors, userNames })
 *   rows  — ledger rows {id, ts, type, productId, size, qty, from, to, actor, reason, before, after}
 *           for the two products only, covering receiveFrom → now
 *   cells — { [pid]: { [loc]: { [sizeKey]: qty } } } now
 */
export function collectFacts({ wrongPid, rightPid, rows, cells, receiveFrom, receiveTo, manualDay, manualActors = null, userNames = {} }) {
  const W = rows.filter((r) => r.productId === wrongPid);
  const Rt = rows.filter((r) => r.productId === rightPid);
  const inReceiveWindow = (r) => r.ts >= receiveFrom && r.ts < receiveTo;
  const isReceive = (r) => r.type === "received" || r.type === "opening";
  const name = (uid) => userNames[uid] || uid;

  // a) R — receives onto WRONG
  const wrongReceives = W.filter((r) => isReceive(r) && inReceiveWindow(r));
  const receiveEvents = groupReceiveEvents(wrongReceives).map((e) => ({ ...e, actorName: name(e.actor) }));
  const firstReceiveTs = wrongReceives.length ? wrongReceives.map((r) => r.ts).sort()[0] : null;

  // The same delivery received onto RIGHT too? (breaks the brief's premise)
  const rightReceives = Rt.filter((r) => isReceive(r) && inReceiveWindow(r));
  const rightEvents = groupReceiveEvents(rightReceives).map((e) => ({ ...e, actorName: name(e.actor) }));
  const mirrors = [];
  for (const we of receiveEvents) for (const re of rightEvents) {
    const share = sizeMatchShare(we.sizes, re.sizes);
    if (re.location === we.location && share >= 0.6) mirrors.push({ wrongEvent: we.rows[0], rightEvent: re.rows[0], share, wrongUnits: we.units, rightUnits: re.units, rightAt: re.firstTs, wrongAt: we.firstTs });
  }

  // Pre-receive WRONG level per cell (rule d's "real Yellow Logo stock before")
  const preLevel = (loc, sk) => (firstReceiveTs ? levelBefore(W, loc, sk, firstReceiveTs, cells[wrongPid] || {}) : get(cells[wrongPid] || {}, loc, sk));

  // e) follow R through WRONG transfers since the receive
  const since = (r) => firstReceiveTs && r.ts >= firstReceiveTs;
  const phantom = {};
  for (const r of wrongReceives) add(phantom, r.to, sizeKey(r.size), Number(r.qty));
  const transfers = [];
  const ambiguous = [];
  const movesOut = W.filter((r) => since(r) && !isReceive(r) && r.from && r.to && (r.type === "transfer_out" || r.type === "transfer_in"))
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));
  for (const r of movesOut) {
    const sk = sizeKey(r.size), qty = Number(r.qty);
    const avail = get(phantom, r.from, sk);
    const moved = Math.min(qty, Math.max(avail, 0));
    transfers.push({ id: r.id, ts: r.ts, size: sk, qty, from: r.from, to: r.to, reason: r.reason || null, phantomMoved: moved });
    if (moved) { add(phantom, r.from, sk, -moved); add(phantom, r.to, sk, moved); }
    if (moved && preLevel(r.from, sk) > 0) ambiguous.push({ kind: "transfer_mixed", product: "wrong", loc: r.from, size: sk, note: `transfer ${r.id} left a cell that also held ${preLevel(r.from, sk)} real Yellow Logo before the receive` });
  }
  // Other WRONG debits since the receive that are not sales (adjustments, write-offs) — reported, not reassigned.
  const otherWrong = W.filter((r) => since(r) && !isReceive(r) && r.type !== "sold" && r.type !== "return" && !(r.from && r.to))
    .map((r) => ({ id: r.id, ts: r.ts, type: r.type, size: sizeKey(r.size), qty: Number(r.qty), from: r.from || null, to: r.to || null, actor: name(r.actor), reason: r.reason || null }));

  // d) Ys — WRONG sales since the receive
  const ys = {}, ysLines = [];
  for (const r of W.filter((x) => since(x) && (x.type === "sold" || x.type === "return"))) {
    const loc = r.type === "sold" ? r.from : r.to, sk = sizeKey(r.size), n = r.type === "sold" ? Number(r.qty) : -Number(r.qty);
    const pre = preLevel(loc, sk);
    const line = { id: r.id, ts: r.ts, type: r.type, loc, size: sk, qty: Number(r.qty), preReceiveLevel: pre };
    if (pre > 0) { line.ambiguous = true; ambiguous.push({ kind: "wrong_sale_pre_stock", product: "wrong", loc, size: sk, note: `${r.type} ${r.id}: that cell held ${pre} real Yellow Logo before the receive` }); }
    else add(ys, loc, sk, n);
    ysLines.push(line);
  }
  // Ys can never exceed the receive units sitting in that cell: a sale beyond
  // them sold something else (Sonnet review, PR #1028) — ambiguous, not reassigned.
  for (const [loc, sz] of Object.entries(ys)) for (const [sk, n] of Object.entries(sz)) {
    const cap = Math.max(get(phantom, loc, sk), 0);
    if (n > cap) {
      ambiguous.push({ kind: "wrong_sale_beyond_receive", product: "wrong", loc, size: sk, note: `${n} Yellow Logo sold here but only ${cap} received unit(s) sit here — ${n - cap} not reassigned` });
      sz[sk] = cap;
    }
  }

  // c) Ws — RIGHT sales since the receive (stay deducted; reported only)
  const ws = {};
  for (const r of Rt.filter((x) => since(x) && (x.type === "sold" || x.type === "return"))) {
    add(ws, r.type === "sold" ? r.from : r.to, sizeKey(r.size), r.type === "sold" ? Number(r.qty) : -Number(r.qty));
  }

  // b) M — manual adds on RIGHT on the manual day
  const manualCandidates = Rt.filter((r) => sastDay(r.ts) === manualDay && r.to && !r.from && (r.type === "adjustment" || r.type === "received" || r.type === "opening"))
    .map((r) => ({ id: r.id, ts: r.ts, type: r.type, loc: r.to, size: sizeKey(r.size), qty: Number(r.qty), actor: r.actor, actorName: name(r.actor), reason: r.reason || null }));
  const manual = manualActors ? manualCandidates.filter((m) => manualActors.includes(m.actor)) : [];
  const m = {};
  for (const x of manual) add(m, x.loc, x.size, x.qty);

  return {
    wrongPid, rightPid, receiveFrom, receiveTo, manualDay, firstReceiveTs,
    receiveEvents, rightEvents, mirrors,
    R: phantom, transfers, otherWrong,
    Ys: ys, ysLines, Ws: ws,
    manualCandidates, manualActors, M: m,
    ambiguous,
    preLevels: Object.fromEntries(Object.entries(phantom).map(([loc, sz]) => [loc, Object.fromEntries(Object.keys(sz).map((sk) => [sk, preLevel(loc, sk)]))])),
    cells,
  };
}

/**
 * The correction plan from facts. Every line carries before → after; a line
 * that would go negative is listed under `negative` and left out of `lines`.
 * `blockers` lists every reason the brief's premise does not hold; when it is
 * non-empty the plan's status is "BLOCKED" and nothing may be applied.
 */
export function planCorrection(f, { expectedReceiveDay = null } = {}) {
  const lines = [], negative = [];
  const wrongNow = f.cells[f.wrongPid] || {}, rightNow = f.cells[f.rightPid] || {};
  const locs = new Set([...Object.keys(f.R), ...Object.keys(f.M), ...Object.keys(f.Ys)]);
  let heldM = 0;
  for (const loc of locs) {
    const sks = new Set([...Object.keys(f.R[loc] || {}), ...Object.keys(f.M[loc] || {}), ...Object.keys(f.Ys[loc] || {})]);
    for (const sk of sks) {
      const R = get(f.R, loc, sk), M = get(f.M, loc, sk), Ys = get(f.Ys, loc, sk);
      const pair = [[f.rightPid, "right", rightNow, R - M - Ys], [f.wrongPid, "wrong", wrongNow, -R + Ys]]
        .filter(([, , , d]) => d)
        .map(([productId, product, now, d]) => { const before = get(now, loc, sk); return { productId, product, loc, size: sk, delta: d, before, after: before + d }; });
      // A cell's two lines are one move: if either side would go negative, BOTH
      // are held (Sonnet review, PR #1028) — half a move would create or lose units.
      if (pair.some((l) => l.after < 0)) { negative.push(...pair); heldM += M; } else lines.push(...pair);
    }
  }
  // The check is over what WOULD be applied: those lines must change the two
  // products together by exactly −(the manual add in the cells not held).
  const totalDelta = lines.reduce((t, l) => t + l.delta, 0);
  const mUnits = sumNested(f.M);
  const blockers = [];
  if (!f.receiveEvents.length) blockers.push({ code: "no_wrong_receive", text: "No receive onto the wrong product in the window." });
  if (expectedReceiveDay && f.receiveEvents.length && !f.receiveEvents.some((e) => sastDay(e.firstTs) === expectedReceiveDay))
    blockers.push({ code: "receive_not_on_expected_day", text: `Receive(s) found on ${[...new Set(f.receiveEvents.map((e) => sastDay(e.firstTs)))].join(", ")}, not on ${expectedReceiveDay}.` });
  if (f.mirrors.length) blockers.push({ code: "right_product_also_received", text: `The right product was received in the same window with matching sizes (${f.mirrors.length} matching event pair(s)) — adding R to it would count that delivery twice.` });
  if (f.receiveEvents.length > 1) blockers.push({ code: "multiple_wrong_receives", text: `${f.receiveEvents.length} separate receive events onto the wrong product — possibly one delivery entered more than once.` });
  if (!f.manualActors || !f.manualActors.length) blockers.push({ code: "manual_add_unconfirmed", text: `Whose add is "the manual add" is not confirmed — ${f.manualCandidates.length} candidate row(s) on the manual day.` });
  // A transfer that left a cell holding real Yellow Logo too cannot say which
  // units it carried, so R at its destination is a guess — block, don't guess.
  const mixed = f.ambiguous.filter((a) => a.kind === "transfer_mixed");
  if (mixed.length) blockers.push({ code: "mixed_transfer", text: `${mixed.length} transfer(s) left a cell that also held real Yellow Logo.` });
  // Ambiguous SALES and negative cells do NOT block the plan (the brief: list
  // them, don't apply them): an ambiguous sale is left out of Ys, and a
  // negative cell's two lines are held out of `lines` above.
  return {
    status: blockers.length ? "BLOCKED" : "READY",
    reason: REASON,
    lines, negative, blockers,
    totals: {
      R: sumNested(f.R), M: mUnits, heldM, Ys: sumNested(f.Ys), Ws: sumNested(f.Ws),
      combinedDelta: totalDelta, combinedDeltaOk: totalDelta === -(mUnits - heldM),
    },
  };
}
