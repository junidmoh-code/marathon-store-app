// ─── PRICE BATCH — PURE CORE ─────────────────────────────────────────────────
// Every price write in this app flows through ONE guarded path (priceStore's
// applyPriceBatch), and this module is that path's brain: it builds the single
// atomic multi-path update that changes product prices AND records who, when,
// from, to and batchId — in the same write, so a price can never change without
// its history landing beside it. It also builds the exact inverse: a restore
// that returns every product in a batch to its precise prior values, itself
// recorded as a batch (auditable, re-restorable), stamping the original as
// restored so it cannot be double-reversed.
//
// ── THE SHAPE ────────────────────────────────────────────────────────────────
//   /price_history/{batchId} = {
//     action: "single_edit"|"bulk_fill"|"bulk_change"|"special_start"|
//             "special_end"|"restore",
//     at (ISO), atMs, by (uid|null), byEmail (|null), label, count,
//     lines: { [productId]: {
//       name,                                   // display only, never joined on
//       from: { stockPrice?, retailPrice? },    // ONLY the fields this batch
//       to:   { stockPrice?, retailPrice? },    //   changed; null = "not set"
//     }},
//     aux?: [ { path, from, to } ],             // non-price paths carried by the
//                                               //   batch (the specials entry);
//                                               //   restore writes `from` back
//     restoresBatchId?,                         // set on action:"restore"
//     restoredAt?, restoredBy?, restoredByBatchId?,   // stamped when reversed
//   }
//   /price_history_index/{batchId} = { action, at, atMs, by, byEmail, label,
//                                      count, restoredAt? }
//     — the COMPACT twin, written in the same update. History lists read ONLY
//     the index (limitToLast); the full record (which can carry thousands of
//     lines) is read one batch at a time, by id, when restoring. This split is
//     the live-bandwidth rule: no surface ever pulls every line of every batch.
//
// batchId keys are `pb_<ms>_<suffix>`: fixed-width epoch-ms prefix makes
// lexicographic key order chronological, so orderByKey().limitToLast(n) IS
// "most recent n" with no index rule needed.
//
// Price invariant (inherited from the POS contract): a price is a positive
// finite number or null ("not set") — never 0, never a string. `to: null` is
// allowed only for single_edit (the detail page's explicit clear) and restore
// (returning to a prior "not set"); the bulk tools may only assign real prices.

export const PRICE_FIELDS = ["stockPrice", "retailPrice"];

export const BATCH_ACTIONS = [
  "single_edit", "bulk_fill", "bulk_change", "special_start", "special_end", "restore",
];

// Actions whose `to` may be null (clearing / returning to unset).
const NULLABLE_TO = new Set(["single_edit", "restore", "special_end"]);

const isKeySafe = (s) => typeof s === "string" && /^[A-Za-z0-9_-]+$/.test(s);

/**
 * Normalise a value read off a product record to the price contract: a
 * positive finite number, else null. Legacy junk (0, "", strings) reads as
 * "not set" — so a `from` recorded off live data is always restorable.
 */
export const asStoredPrice = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

// null = "not set". Anything else must be a positive finite number.
const validPrice = (v) => v === null || (typeof v === "number" && Number.isFinite(v) && v > 0);

const err = (code, message) => {
  const e = new Error(message);
  e.code = code;
  return e;
};

/** Normalise a from/to side to exactly {field: number|null} over known fields. */
function normaliseSide(side, lineId, which) {
  if (!side || typeof side !== "object") throw err("bad_line", `${lineId}: missing ${which}`);
  const out = {};
  for (const k of Object.keys(side)) {
    if (!PRICE_FIELDS.includes(k)) throw err("bad_field", `${lineId}: unknown price field "${k}"`);
    const v = side[k] === undefined ? null : side[k];
    if (!validPrice(v)) throw err("bad_value", `${lineId}: ${which}.${k} must be a positive number or null, got ${JSON.stringify(v)}`);
    out[k] = v;
  }
  return out;
}

/**
 * Validate and freeze one batch's lines. Throws (with .code) on anything that
 * would write a malformed price or a history record that can't restore.
 */
export function normaliseLines(lines, action) {
  if (!lines || typeof lines !== "object" || Object.keys(lines).length === 0) {
    throw err("empty_batch", "A price batch must contain at least one product.");
  }
  const out = {};
  for (const [pid, line] of Object.entries(lines)) {
    if (!isKeySafe(pid)) throw err("bad_product_id", `Unsafe product id "${pid}"`);
    const from = normaliseSide(line.from, pid, "from");
    const to = normaliseSide(line.to, pid, "to");
    const fromKeys = Object.keys(from).sort().join(",");
    const toKeys = Object.keys(to).sort().join(",");
    if (!toKeys) throw err("bad_line", `${pid}: no price fields`);
    if (fromKeys !== toKeys) throw err("bad_line", `${pid}: from records [${fromKeys}] but to writes [${toKeys}] — history must cover exactly what changes`);
    // A line where nothing changes is a caller bug — plans must drop no-ops so
    // the preview count is honest. EXCEPT restore and special_end: a hand-edit
    // back to the prior value makes such a line a no-op, and the batch must
    // still succeed — a restore for the rest of its lines, a special end
    // because the /specials entry (aux) must be deleted regardless.
    if (action !== "restore" && action !== "special_end" && !Object.keys(to).some((k) => to[k] !== from[k])) {
      throw err("noop_line", `${pid}: every field already holds the target value — drop no-op lines before applying`);
    }
    for (const k of Object.keys(to)) {
      if (to[k] === null && !NULLABLE_TO.has(action)) {
        throw err("bad_value", `${pid}: ${action} may not clear ${k} — bulk tools only assign real prices`);
      }
    }
    out[pid] = { name: String(line.name ?? ""), from, to };
  }
  return out;
}

// aux exists for exactly one thing: the /specials entry that rides a
// special_start / special_end batch. The whitelist is the money-safety fence —
// a price batch can touch price fields, its own history, and specials, and
// STRUCTURALLY nothing else (/pos/sales, /laybys, /orders, /stock are
// unreachable even from a buggy or hostile plan).
function normaliseAux(aux) {
  if (aux == null) return null;
  if (!Array.isArray(aux) || aux.length === 0) throw err("bad_aux", "aux must be a non-empty array when present");
  return aux.map((a, i) => {
    if (!a || typeof a.path !== "string" || !/^specials\/[A-Za-z0-9_-]+$/.test(a.path)) {
      throw err("bad_aux", `aux[${i}]: only specials/{productId} may ride a price batch`);
    }
    return { path: a.path, from: a.from === undefined ? null : a.from, to: a.to === undefined ? null : a.to };
  });
}

/**
 * Build the ONE atomic update for a price batch: every changed product field,
 * every aux path, the full history record and its compact index twin.
 * Returns { updates, record, meta }. Pure — stamps are passed in.
 */
export function buildPriceBatch({ batchId, action, lines, aux = null, label = "", at, atMs, by = null, byEmail = null, restoresBatchId = null }) {
  if (!isKeySafe(batchId)) throw err("bad_batch_id", `Unsafe batchId "${batchId}"`);
  if (!BATCH_ACTIONS.includes(action)) throw err("bad_action", `Unknown action "${action}"`);
  if (typeof at !== "string" || !at) throw err("bad_stamp", "at (ISO) is required");
  if (typeof atMs !== "number" || !Number.isFinite(atMs)) throw err("bad_stamp", "atMs is required");
  if (action === "restore" && !isKeySafe(restoresBatchId || "")) throw err("bad_batch_id", "restore needs restoresBatchId");

  const cleanLines = normaliseLines(lines, action);
  const cleanAux = normaliseAux(aux);
  const count = Object.keys(cleanLines).length;

  const updates = {};
  for (const [pid, line] of Object.entries(cleanLines)) {
    for (const [field, v] of Object.entries(line.to)) {
      updates[`products/${pid}/${field}`] = v; // null deletes = "not set"
    }
  }
  if (cleanAux) for (const a of cleanAux) updates[a.path] = a.to;

  const record = {
    action, at, atMs, by, byEmail, label: String(label || ""), count,
    lines: cleanLines,
    ...(cleanAux ? { aux: cleanAux } : {}),
    ...(restoresBatchId ? { restoresBatchId } : {}),
  };
  const meta = { action, at, atMs, by, byEmail, label: record.label, count,
                 ...(restoresBatchId ? { restoresBatchId } : {}) };
  updates[`price_history/${batchId}`] = record;
  updates[`price_history_index/${batchId}`] = meta;
  return { updates, record, meta };
}

/**
 * Drift check for a restore preview: which products no longer hold the value
 * this batch wrote (someone edited them since)? Restoring still returns them
 * to the batch's `from` — the preview just makes that visible first.
 * productsById: { pid: productRecord } from the caller's live subscription.
 */
export function computeRestoreDrift(record, productsById) {
  const drift = [];
  for (const [pid, line] of Object.entries(record.lines || {})) {
    const p = productsById[pid];
    for (const [field, expected] of Object.entries(line.to)) {
      // asStoredPrice, not a raw number check: a legacy 0 must read as "not
      // set", exactly as every writer treats it (CodeRabbit, PR #355).
      const current = p ? asStoredPrice(p[field]) : null;
      if (!p) { drift.push({ pid, field, expected, current: null, missing: true }); continue; }
      if (current !== expected) drift.push({ pid, name: line.name, field, expected, current });
    }
  }
  return drift;
}

/**
 * Build the atomic restore for a batch: every line's product fields back to
 * `from`, every aux path back to `from`, a NEW history record (action
 * "restore") so the reversal is itself audited and reversible, and the
 * restored-stamps on the original record + index.
 * currentById supplies live values for the restore record's own `from` side
 * (falling back to the original's `to` when a product is absent).
 */
export function buildRestoreBatch({ record, batchId, restoreBatchId, at, atMs, by = null, byEmail = null, currentById = {} }) {
  if (!record || typeof record !== "object") throw err("not_found", `Batch not found`);
  if (record.restoredAt) throw err("already_restored", `Batch was already restored at ${record.restoredAt}`);
  if (record.action === "special_start" || record.action === "special_end") {
    throw err("use_specials_card", "Specials batches are reversed on the Specials card (start ↔ end), so the specials node and the retail price move together.");
  }
  if (!isKeySafe(batchId) || !isKeySafe(restoreBatchId)) throw err("bad_batch_id", "Unsafe batch id");

  const lines = {};
  for (const [pid, line] of Object.entries(record.lines || {})) {
    const p = currentById[pid];
    const from = {};
    for (const field of Object.keys(line.to)) {
      // asStoredPrice: a product holding a legacy 0 must record from:null, not
      // from:0 — a raw 0 would fail validation and BLOCK the undo entirely
      // (CodeRabbit, PR #355). Product gone → fall back to the batch's to.
      from[field] = p ? asStoredPrice(p[field]) : line.to[field];
    }
    lines[pid] = { name: line.name || "", from, to: { ...line.from } };
  }
  const aux = record.aux
    ? record.aux.map((a) => ({ path: a.path, from: a.to === undefined ? null : a.to, to: a.from === undefined ? null : a.from }))
    : null;

  const { updates, record: restoreRecord, meta } = buildPriceBatch({
    batchId: restoreBatchId, action: "restore", lines, aux,
    label: `Restore of ${batchId}${record.label ? ` (${record.label})` : ""}`,
    at, atMs, by, byEmail, restoresBatchId: batchId,
  });
  updates[`price_history/${batchId}/restoredAt`] = at;
  updates[`price_history/${batchId}/restoredBy`] = by;
  updates[`price_history/${batchId}/restoredByBatchId`] = restoreBatchId;
  updates[`price_history_index/${batchId}/restoredAt`] = at;
  return { updates, record: restoreRecord, meta };
}
