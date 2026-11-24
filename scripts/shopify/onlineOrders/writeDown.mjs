// ── The poller's side of the single-piece write-down (functions/lib/web-writedown.cjs) ──
// Junid, 24 Nov 2026. The rule, the row and the reversal live in that one
// CommonJS module so the cloud function (a shop's Not found) and this tick (a
// hub's Out of Stock, the sweep) cannot disagree. Best-effort here: a failure
// is logged and never stops the order being kept; the shelf hold written just
// before still keeps the piece off the website.
import { createRequire } from "node:module";
import { storeNode, STORES } from "../storeConfig.mjs";

const require = createRequire(import.meta.url);
const lib = require("../../../functions/lib/web-writedown.cjs");
export const { WRITEDOWNS_PATH, writeDownSingle, restoreFound, sweepDecision } = lib;

export const WRITEDOWN_CONFIG_PATH = "config/onlineOrders/writeDown";
export const SWEEP_EVERY_MS = 10 * 60e3;
const ALL_DIRTY = Object.values(STORES).map((st) => storeNode("shopify_inventory_dirty", st));

/** Kill switch: /config/onlineOrders/writeDown/off = true. Read once per tick. */
async function writeDownOn(ctx) {
  if (ctx.writeDownOn === undefined) {
    try { ctx.writeDownOn = (await ctx.get(`${WRITEDOWN_CONFIG_PATH}/off`)) !== true; } catch { ctx.writeDownOn = false; }
  }
  return ctx.writeDownOn;
}

const markDirty = async (ctx, pid) => { for (const dirty of ALL_DIRTY) await ctx.db.ref(`${dirty}/${pid}`).set(ctx.increment(1)); };

/** A place said no: zero its shelf when that shelf shows exactly one piece. → true when written down. */
export async function writeDownRejected(ctx, w) {
  try {
    if (!(await writeDownOn(ctx))) return false;
    const res = await lib.writeDownSingle(ctx.db, w, { nowIso: new Date(ctx.now).toISOString() });
    if (!res.ok) { ctx.log?.(`  ⚠ write-down for ${w.pid}/${w.sizeKey} at ${w.loc} refused (${res.reason})`); return false; }
    if (!res.wroteDown) { if (res.qty > 1) ctx.log?.(`  ~ ${w.pid} size ${w.sizeKey} at ${w.loc} shows ${res.qty}: count NOT changed — held off the website, on the "wrong by more than one" list`); return false; }
    if (!res.idempotent) {
      await markDirty(ctx, w.pid);
      ctx.log?.(`  ↓ written to zero: ${w.pid} size ${w.sizeKey} at ${w.loc} (${w.kind}, the one piece shown; undoes itself if it is sold, picked or found there)`);
    }
    return true;
  } catch (e) {
    ctx.log?.(`  ⚠ write-down for ${w.pid}/${w.sizeKey} at ${w.loc} failed (${String(e?.message || e)})`);
    return false;
  }
}

/** The self-reversal sweep, at most every SWEEP_EVERY_MS (the stamp lives in the poller's meta node). */
export async function sweepWriteDowns(ctx, metaPath) {
  try {
    if (ctx.now - (Number(ctx.meta?.writeDownSweepAt) || 0) < SWEEP_EVERY_MS) return null;
    const out = await lib.sweepWriteDowns(ctx.db, { nowIso: new Date(ctx.now).toISOString(), nowMs: ctx.now, log: ctx.log });
    await ctx.db.ref(`${metaPath}/writeDownSweepAt`).set(ctx.now);
    if (out.restored || out.closed) ctx.log?.(`  write-downs: ${out.rows} open, ${out.restored} undone (sold or picked there), ${out.closed} closed (the shelf moved)`);
    return out;
  } catch (e) {
    ctx.log?.(`  ⚠ write-down sweep failed (${String(e?.message || e)})`);
    return null;
  }
}
