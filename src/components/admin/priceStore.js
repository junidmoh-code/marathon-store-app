// ─── PRICE STORE — DATA LAYER ────────────────────────────────────────────────
// The ONLY module that writes product prices. Every surface — the Missing
// Prices modal, the product detail page, the bulk tools, the Specials card —
// calls applyPriceBatch / restorePriceBatch here; nothing else touches
// products/{id}/stockPrice or retailPrice. The pure batch construction (shapes,
// guards, the atomic update object) lives in src/utils/priceBatch.js; this
// layer adds the live pieces: identity stamps, server time, the specials
// interlock, and the actual RTDB writes.
//
// Reads follow the house bandwidth rules: one-shot get()s only, and only of
// small purpose-built nodes — /specials (compact by design), the
// /price_history_index tail (limitToLast), and single /price_history/{batchId}
// records by id. Never a whole big node.
//
// ── THE SPECIALS INTERLOCK ───────────────────────────────────────────────────
// While a product is on special, products/{id}/retailPrice IS the special
// price, and the pre-special price is parked at /specials/{id}/wasPrice. Any
// ordinary write to retailPrice would make wasPrice a lie — the special would
// later "end" by restoring a stale number. So applyPriceBatch refuses
// retailPrice lines for products with an active special (code "on_special")
// unless the caller is the specials flow itself (allowSpecials: true). Ending
// the special first is the supported way to reprice such a product.

import { ref, get, child, query, orderByKey, limitToLast } from "firebase/database";
import { update as rtdbUpdate } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowIso, serverNowMs } from "../../utils/serverTime";
import { buildPriceBatch, buildRestoreBatch, computeRestoreDrift } from "../../utils/priceBatch";

const one = async (path) => (await get(child(ref(database), path))).val();

/**
 * pb_<13-digit-ms>_<suffix> — key-safe, lexicographically chronological. The
 * ms prefix is forced strictly increasing within a session so two batches
 * minted in the same millisecond (apply + its immediate undo) still list in
 * true order; the random suffix only disambiguates across devices.
 */
let lastMintedMs = 0;
export function mintBatchId() {
  const ms = Math.max(serverNowMs(), lastMintedMs + 1);
  lastMintedMs = ms;
  const rand = Math.random().toString(36).slice(2, 8);
  return `pb_${String(ms).padStart(13, "0")}_${rand}`;
}

const stamps = () => {
  const user = auth.currentUser;
  return { at: serverNowIso(), atMs: serverNowMs(), by: user ? user.uid : null, byEmail: user?.email || null };
};

/** One-shot read of the (compact) specials node. Absent → {}. */
export async function loadSpecials() {
  return (await one("specials")) || {};
}

/**
 * Apply one price batch atomically. lines/aux per priceBatch.js. Returns
 * { ok:true, batchId } or { ok:false, code, message, products? } — never
 * throws. A failed write writes NOTHING (single update() call).
 */
export async function applyPriceBatch({ action, lines, aux = null, label = "", allowSpecials = false }) {
  let specials = {};
  if (!allowSpecials) {
    try {
      specials = (await loadSpecials()) || {};
    } catch (e) {
      return { ok: false, code: "specials_unreadable", message: `Could not check active specials — nothing was written. (${e?.message || e})` };
    }
    const blocked = Object.keys(lines || {}).filter(
      (pid) => specials[pid] && lines[pid]?.to && "retailPrice" in lines[pid].to,
    );
    if (blocked.length > 0) {
      return {
        ok: false, code: "on_special", products: blocked,
        message: `${blocked.length} selected product${blocked.length === 1 ? " is" : "s are"} on special — end the special first, then reprice.`,
      };
    }
  }

  const batchId = mintBatchId();
  let built;
  try {
    built = buildPriceBatch({ batchId, action, lines, aux, label, ...stamps() });
  } catch (e) {
    return { ok: false, code: e.code || "invalid_batch", message: String(e.message || e) };
  }
  try {
    await rtdbUpdate(ref(database), built.updates);
    return { ok: true, batchId, count: built.record.count };
  } catch (e) {
    return { ok: false, code: "write_failed", message: String(e?.message || e) };
  }
}

/** Full record for one batch, by id. */
export async function loadPriceBatch(batchId) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(batchId || ""))) return null;
  return await one(`price_history/${batchId}`);
}

/**
 * Most recent n batch metas, newest first: [{ batchId, ...meta }]. Reads ONLY
 * the compact index tail — never the full records.
 */
export async function loadRecentBatches(n = 20) {
  const snap = await get(query(ref(database, "price_history_index"), orderByKey(), limitToLast(n)));
  const val = snap.val() || {};
  return Object.entries(val)
    .map(([batchId, meta]) => ({ batchId, ...meta }))
    .sort((a, b) => (a.batchId < b.batchId ? 1 : -1));
}

/**
 * Restore preview: the batch record plus drift — products whose current value
 * is no longer what the batch wrote (edited since). productsById comes from
 * the caller's existing /products subscription; no extra reads.
 */
export async function previewRestore(batchId, productsById) {
  const record = await loadPriceBatch(batchId);
  if (!record) return { ok: false, code: "not_found", message: "Batch not found." };
  if (record.restoredAt) return { ok: false, code: "already_restored", message: `Already restored at ${record.restoredAt}.` };
  return { ok: true, record, drift: computeRestoreDrift(record, productsById || {}) };
}

/**
 * Restore a batch by id — THE undo. One atomic update returns every product in
 * the batch to its exact prior values (and reverses any aux paths), records the
 * reversal as its own batch, and stamps the original restored. Refuses a
 * second restore of the same batch.
 */
export async function restorePriceBatch(batchId, productsById) {
  const record = await loadPriceBatch(batchId);
  if (!record) return { ok: false, code: "not_found", message: "Batch not found." };
  const restoreBatchId = mintBatchId();
  let built;
  try {
    built = buildRestoreBatch({ record, batchId, restoreBatchId, currentById: productsById || {}, ...stamps() });
  } catch (e) {
    return { ok: false, code: e.code || "invalid_restore", message: String(e.message || e) };
  }
  try {
    await rtdbUpdate(ref(database), built.updates);
    return { ok: true, batchId: restoreBatchId, restored: batchId, count: built.record.count };
  } catch (e) {
    return { ok: false, code: "write_failed", message: String(e?.message || e) };
  }
}
