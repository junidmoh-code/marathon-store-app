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
export async function applyPriceBatch({ action, lines, aux = null, label = "", allowSpecials = false, batchId = null }) {
  let specials = {};
  if (!allowSpecials) {
    try {
      specials = (await loadSpecials()) || {};
    } catch (e) {
      // FAIL OPEN (live incident 2026-08-13): before the /specials console rule
      // was published, this read's permission denial blocked EVERY price save.
      // A special that cannot be read must never block a price — the interlock
      // is a courtesy guard for a rare state, the save is the job. Proceed as
      // if no specials exist, and log so an unreadable node is still visible.
      console.warn("specials check unreadable — price save proceeds without the interlock:", e?.message || e);
      specials = {};
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

  if (!batchId) batchId = mintBatchId();
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

/**
 * START specials from a confirmed buildSpecialStartPlan. Re-checks /specials
 * FRESH before writing: the plan was built off the card's snapshot, and a
 * special started elsewhere meanwhile must not be overwritten — that would
 * orphan its parked wasPrice. The minted batchId is stamped into every
 * /specials entry so each special names the batch that created it.
 */
export async function startSpecials(plan) {
  if (!plan?.ok || !plan.aux?.length) return { ok: false, code: "invalid_plan", message: "Nothing to start." };
  let fresh;
  try {
    fresh = (await loadSpecials()) || {};
  } catch (e) {
    // Deliberately FAIL CLOSED, unlike the price-save interlock: proceeding
    // blind here could overwrite a special that exists but couldn't be read,
    // stranding its parked wasPrice. And nothing is being "blocked" that could
    // otherwise succeed — if /specials can't be read, this batch's own write
    // to /specials would be denied by the same missing rule.
    return { ok: false, code: "specials_unreadable", message: `Could not re-check active specials — nothing was written. (${e?.message || e})` };
  }
  const clash = Object.keys(plan.lines).filter((pid) => fresh[pid]);
  if (clash.length > 0) {
    return { ok: false, code: "on_special", products: clash, message: `${clash.length} product${clash.length === 1 ? " is" : "s are"} already on special (started meanwhile) — refresh the card.` };
  }
  const batchId = mintBatchId();
  const aux = plan.aux.map((a) => ({ ...a, to: { ...a.to, batchId } }));
  return applyPriceBatch({
    action: "special_start", lines: plan.lines, aux, batchId, allowSpecials: true,
    label: `Special started — ${plan.count} product${plan.count === 1 ? "" : "s"}`,
  });
}

/** END specials from a confirmed buildSpecialEndPlan: wasPrice returns, entries delete. */
export async function endSpecials(plan) {
  if (!plan?.ok || !plan.aux?.length) return { ok: false, code: "invalid_plan", message: "Nothing to end." };
  return applyPriceBatch({
    action: "special_end", lines: plan.lines, aux: plan.aux, allowSpecials: true,
    label: `Special ended — ${plan.count} product${plan.count === 1 ? "" : "s"}`,
  });
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
 * The restore-side specials interlock (CodeRabbit, PR #355): a restore writes
 * each line's `from` retailPrice directly, so without this check the History
 * card could undo a pre-special batch UNDER an active special — retail would
 * jump while the special stayed listed, and the parked wasPrice would restore
 * a price nobody chose when the special later ends. Same rule as apply: end
 * the special first. Returns null when clear, else a refusal result.
 */
async function specialsRestoreRefusal(record) {
  let specials;
  try {
    specials = (await loadSpecials()) || {};
  } catch (e) {
    // FAIL OPEN — same rule as applyPriceBatch: an unreadable specials node
    // must never block a restore. Logged, then treated as "no active specials".
    console.warn("specials check unreadable — restore proceeds without the interlock:", e?.message || e);
    return null;
  }
  const blocked = Object.keys(record.lines || {}).filter(
    (pid) => specials[pid] && record.lines[pid]?.from && "retailPrice" in record.lines[pid].from,
  );
  if (blocked.length > 0) {
    return {
      ok: false, code: "on_special", products: blocked,
      message: `${blocked.length} product${blocked.length === 1 ? " is" : "s are"} on special — end the special first, then restore.`,
    };
  }
  return null;
}

/**
 * Restore preview: the batch record plus drift — products whose current value
 * is no longer what the batch wrote (edited since). productsById comes from
 * the caller's existing /products subscription; no extra reads. Never throws.
 */
export async function previewRestore(batchId, productsById) {
  let record;
  try {
    record = await loadPriceBatch(batchId);
  } catch (e) {
    return { ok: false, code: "read_failed", message: `Could not read batch ${batchId}: ${e?.message || e}` };
  }
  if (!record) return { ok: false, code: "not_found", message: "Batch not found." };
  if (record.restoredAt) return { ok: false, code: "already_restored", message: `Already restored at ${record.restoredAt}.` };
  const refusal = await specialsRestoreRefusal(record);
  if (refusal) return refusal;
  return { ok: true, record, drift: computeRestoreDrift(record, productsById || {}) };
}

/**
 * Restore a batch by id — THE undo. One atomic update returns every product in
 * the batch to its exact prior values (and reverses any aux paths), records the
 * reversal as its own batch, and stamps the original restored. Refuses a
 * second restore of the same batch, and refuses to reprice under an active
 * special. Never throws.
 */
export async function restorePriceBatch(batchId, productsById) {
  let record;
  try {
    record = await loadPriceBatch(batchId);
  } catch (e) {
    return { ok: false, code: "read_failed", message: `Could not read batch ${batchId}: ${e?.message || e}` };
  }
  if (!record) return { ok: false, code: "not_found", message: "Batch not found." };
  const refusal = await specialsRestoreRefusal(record);
  if (refusal) return refusal;
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
