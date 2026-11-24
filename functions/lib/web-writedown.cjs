// ─── A REJECTED WEBSITE PICK CORRECTS THE COUNT — single pieces only ─────────
//
// Junid, 24 Nov 2026 (his decision on docs/audits/web-unavailable-2026-11-24,
// "whether a website rejection should also correct the app's count"). This is
// the ONE count change a website order makes before packing, and Junid asked
// for it knowing the refill scan reads the corrected count. Nothing here reads
// or writes a policy, a target or a request.
//
// THE RULE. A place rejects a website pick (a hub's Out of Stock, a shop's or
// Central's Not found, Not found on the daily shelf check):
//   • its shelf shows exactly ONE piece → that shelf is written to ZERO, as a
//     stock movement of its own type (`web_not_found`) carrying who, when and
//     the order, and a row is kept so it can undo itself:
//       /online_writedowns/{pid}/{sizeKey}/{loc} =
//           { at, mvId, qty: 1, kind, orderId, orderNumber, line, by, size }
//   • its shelf shows TWO OR MORE → the count is NOT touched. The shelf hold
//     (scripts/shopify/pickableStock.mjs, /online_cell_holds) keeps it off the
//     website and out of routing, and it is on the "count wrong by more than
//     one" list a person settles on the daily shelf check.
//
// SELF-REVERSING. The piece turned up after all when
//   • it is scanned at a till or picked there — the sale / transfer takes the
//     shelf below zero, which only a real piece can do. sweepWriteDowns (the
//     orders poller, every few minutes) sees it and writes `web_found` +1, so
//     the shelf lands on zero again and the ledger says why; or
//   • a person taps Found on a check, or sends the line back with Order it now
//     — restoreFound, at once.
// Any OTHER movement on the shelf (a delivery, a transfer in, a count) settles
// the question by itself: the row is simply closed. A row lives 60 days at most.
// /online_writedowns is a WORKING SET (a row exists only until its shelf next
// moves), read whole by the sweep every ten minutes; it is not a history.
//
// `db` is injected (firebase-admin Database or a test fake).
"use strict";
const { applyMovementAdmin } = require("./admin-movement.cjs");

const WRITEDOWNS_PATH = "online_writedowns";
const WRITEDOWN_KINDS = Object.freeze(["hub_out_of_stock", "shop_not_found", "central_not_found", "shelf_check_not_found", "backfill"]);
const ROW_MAX_AGE_MS = 60 * 864e5;

const keyOk = (k) => typeof k === "string" && k !== "" && !/[.#$[\]/]/.test(k);
const safeId = (s) => String(s ?? "").replace(/[.#$/\[\]\s]/g, "_");
const read = async (db, path) => (await db.ref(path).once("value")).val();
const rowPath = (pid, sizeKey, loc) => `${WRITEDOWNS_PATH}/${pid}/${sizeKey}/${loc}`;
const cellQty = (cell) => (cell && typeof cell.qty === "number" ? cell.qty : Number(cell) || 0);

/**
 * Write a rejecting shelf to zero when it shows exactly one piece.
 *   { pid, size, sizeKey, loc, kind, orderId?, orderNumber?, line?, gen?, by?, at, idTag? }
 * → { ok: true, wroteDown: true, movementId }      the shelf is now zero
 *   { ok: true, wroteDown: false, qty }             not a single piece: nothing changed
 *   { ok: false, reason }
 * Idempotent: the movement id is fixed by (order, line, route generation, place).
 */
async function writeDownSingle(db, w, { nowIso }) {
  if (!keyOk(w?.pid) || !keyOk(w?.sizeKey) || !keyOk(w?.loc) || !WRITEDOWN_KINDS.includes(w.kind)) return { ok: false, reason: "bad_request" };
  const at = Number(w.at);
  if (!Number.isFinite(at) || at <= 0) return { ok: false, reason: "bad_time" };
  const movementId = `web_nf_${safeId(w.idTag || `${w.orderId}_${w.line}_g${Number(w.gen) || 0}`)}_${safeId(w.loc)}`;
  const cellP = `stock/${w.loc}/${w.pid}/${w.sizeKey}`;
  const existing = await read(db, rowPath(w.pid, w.sizeKey, w.loc));
  let planned; // the movement the shelf carried when it was judged: the debit is refused if anything lands in between
  if (!(existing && existing.mvId === movementId) && !(await read(db, `stock_movements/${movementId}`))) {
    const cell = await read(db, cellP);
    planned = { mv: (cell && cell.mv) ?? null };
    const qty = cellQty(cell);
    if (qty !== 1) return { ok: true, wroteDown: false, qty };
    // The shelf moved AFTER the rejection (a delivery, a count): that is newer evidence, leave it.
    const stamp = Date.parse(cell && cell.updatedAt);
    if (Number.isFinite(stamp) && stamp > at) return { ok: true, wroteDown: false, qty, movedSince: true };
  }
  const size = w.size != null && w.size !== "" ? String(w.size) : w.sizeKey;
  const label = w.orderNumber != null ? ` #${w.orderNumber}` : "";
  const res = await applyMovementAdmin(db, {
    type: "web_not_found", productId: w.pid, size, sizeKey: w.sizeKey, qty: 1, from: w.loc, expectQty: 1, ...(planned ? { expectMv: planned.mv } : {}),
    movementId, actor: w.by ? String(w.by) : "system:website-order", actorRole: "admin",
    reason: `website pick not found${label}: the one piece shown is not on the shelf`,
    link: { orderId: w.orderId != null ? String(w.orderId) : null },
    web: clean({ kind: w.kind, orderId: w.orderId != null ? String(w.orderId) : null, orderNumber: w.orderNumber ?? null, line: w.line ?? null, by: w.by ?? null, rejectedAt: at }),
  }, { nowIso });
  if (!res.ok) return res.reason === "cell_changed" ? { ok: true, wroteDown: false, qty: res.available } : res;
  // The row is what makes it undo itself. Create-once: a retry never moves `at`.
  // …and only when THIS call moved the stock: a heal that finds the movement already made must not bring back a row
  // the sweep or a Found has since closed (it would later undo a write-down that was already settled).
  if (!res.idempotent) {
    await db.ref(rowPath(w.pid, w.sizeKey, w.loc)).transaction((cur) => (cur != null && cur.mvId === movementId ? undefined : clean({
      at, mvId: movementId, qty: 1, kind: w.kind, size, orderId: w.orderId != null ? String(w.orderId) : null, orderNumber: w.orderNumber ?? null, line: w.line ?? null, by: w.by ?? null,
    })));
  }
  return { ok: true, wroteDown: true, movementId, idempotent: !!res.idempotent };
}

/**
 * The piece turned up: put it back and close the row.
 *   { pid, sizeKey, loc, why, by? }   why: "found_on_check" | "order_it_now" | "sold_or_picked" | "rollback"
 * → { ok: true, restored: true|false }
 */
async function restoreFound(db, f, { nowIso }) {
  if (!keyOk(f?.pid) || !keyOk(f?.sizeKey) || !keyOk(f?.loc)) return { ok: false, reason: "bad_request" };
  const path = rowPath(f.pid, f.sizeKey, f.loc);
  const row = await read(db, path);
  if (!row || !row.mvId) return { ok: true, restored: false };
  // Only the write-down the caller meant (the sweep passes the row it judged), and never on the word of a Found
  // given BEFORE that write-down (a replayed old confirmation must not undo a newer rejection).
  if (f.expectMvId && row.mvId !== f.expectMvId) return { ok: true, restored: false };
  if (Number.isFinite(Number(f.at)) && Number(f.at) > 0 && Number(f.at) < Number(row.at)) return { ok: true, restored: false };
  // THE SHELF AS IT STANDS decides, and the write is pinned to it (expectQty). The piece goes back only when the shelf
  // is still exactly as the write-down left it, or has gone below zero (a sale or pick took a piece the count said
  // was not there). Any other movement since — a delivery, a count — has already settled the count: adding one on
  // top would leave a unit too many, so the row is simply closed.
  const cell = await read(db, `stock/${f.loc}/${f.pid}/${f.sizeKey}`);
  const qtyNow = cellQty(cell);
  const closeRow = () => db.ref(path).transaction((cur) => (cur == null ? null : cur.mvId === row.mvId ? null : undefined));
  if (!cell || !(cell.mv === row.mvId || qtyNow < 0)) { await closeRow(); return { ok: true, restored: false, settled: true }; }
  const res = await applyMovementAdmin(db, {
    type: "web_found", productId: f.pid, size: row.size != null ? String(row.size) : f.sizeKey, sizeKey: f.sizeKey, qty: Math.max(1, Number(row.qty) || 1), to: f.loc, expectQty: qtyNow, expectMv: cell.mv ?? null,
    movementId: `web_found_${safeId(row.mvId)}`, actor: f.by ? String(f.by) : "system:website-order", actorRole: "admin",
    reason: `found after a website not-found${row.orderNumber != null ? ` #${row.orderNumber}` : ""} (${String(f.why || "found").replace(/_/g, " ")})`,
    link: { orderId: row.orderId ?? null },
    web: clean({ kind: f.why || "found", undoes: row.mvId, orderId: row.orderId ?? null, orderNumber: row.orderNumber ?? null, by: f.by ?? null }),
  }, { nowIso });
  // The shelf moved between the read and the write: nothing was added; the next look decides again.
  if (!res.ok) return res.reason === "cell_changed" ? { ok: true, restored: false, retry: true } : res;
  // Only the row this reversal answered: a NEW write-down on the same shelf stays.
  await closeRow();
  return { ok: true, restored: true, movementId: res.movementId };
}

/** What the sweep does with one row, from the shelf as it stands. PURE. → "keep" | "restore" | "close" */
function sweepDecision(row, cell, nowMs) {
  if (!row || !row.mvId) return "close";
  if (!cell) return nowMs - Number(row.at) > ROW_MAX_AGE_MS ? "close" : "keep";
  if (cell.mv === row.mvId) return nowMs - Number(row.at) > ROW_MAX_AGE_MS ? "close" : "keep";
  // The shelf moved since. Below zero = a sale or a pick took a piece the count said was not there.
  return cellQty(cell) < 0 ? "restore" : "close";
}

/**
 * Look at every open write-down once. Reads /online_writedowns (a small working
 * set: a row lives only until its shelf next moves) and one cell per row.
 * → { rows, restored, closed }
 */
async function sweepWriteDowns(db, { nowIso, nowMs, log = () => {} }) {
  const all = (await read(db, WRITEDOWNS_PATH)) || {};
  const out = { rows: 0, restored: 0, closed: 0 };
  const rows = [];
  for (const [pid, bySize] of Object.entries(all)) for (const [sizeKey, byLoc] of Object.entries(bySize || {})) for (const [loc, row] of Object.entries(byLoc || {})) rows.push({ pid, sizeKey, loc, row });
  out.rows = rows.length;
  const one = async ({ pid, sizeKey, loc, row }) => {
    try {
      const cell = await read(db, `stock/${loc}/${pid}/${sizeKey}`);
      const what = sweepDecision(row, cell, nowMs);
      if (what === "keep") return;
      if (what === "restore") {
        const r = await restoreFound(db, { pid, sizeKey, loc, why: "sold_or_picked", expectMvId: row.mvId }, { nowIso });
        if (r.ok && r.restored) { out.restored += 1; log(`  ↺ write-down undone: ${pid} size ${sizeKey} at ${loc} — a piece was sold or picked there after the website not-found${row.orderNumber != null ? ` #${row.orderNumber}` : ""}`); }
        else if (r.ok && r.settled) out.closed += 1;
        return;
      }
      await db.ref(rowPath(pid, sizeKey, loc)).transaction((cur) => (cur == null ? null : cur.mvId === row.mvId ? null : undefined));
      out.closed += 1;
    } catch (e) {
      log(`  ⚠ write-down ${pid}/${sizeKey}/${loc} not swept (${String((e && e.message) || e)})`);
    }
  };
  // Side by side, a dozen at a time: one small read per row, never one after another for the whole list.
  for (let i = 0; i < rows.length; i += 12) await Promise.all(rows.slice(i, i + 12).map(one));
  return out;
}

function clean(o) { const out = {}; for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== "") out[k] = v; return out; }

module.exports = { WRITEDOWNS_PATH, WRITEDOWN_KINDS, ROW_MAX_AGE_MS, writeDownSingle, restoreFound, sweepDecision, sweepWriteDowns, rowPath };
