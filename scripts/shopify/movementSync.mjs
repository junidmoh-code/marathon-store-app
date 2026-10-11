// ─── INVENTORY FROM THE MOVEMENT LEDGER — the path that needs no trigger ─────
//
// WHY A THIRD PATH. inventorySync.mjs already has two: dirty markers written by
// a Cloud Function on every /stock write (fast), and a backstop that walks the
// live catalogue 40 products per sweep (a full pass takes ~14 daytime hours).
// Both stayed in place. What neither gave was a path that (a) depends on no
// Cloud Function having fired and (b) reaches every moved product within one
// tick, so this one reads the app's own book of record for movement —
// /stock_movements — from a stored cursor, and pushes exactly the products
// that moved. (Junid's brief, 2026-10-11: docs/SHOPIFY-STOCK-TRUTH.md.)
//
// ── HOW IT READS WITHOUT A WHOLE-NODE READ ───────────────────────────────────
// /stock_movements is ~32 MB. It carries `.indexOn: ["ts"]` (App.jsx already
// depends on it), so a ts-ordered range query from the cursor returns only the
// rows written since — a few KB on a trading-hours tick. `appliedAt` (when a
// row actually reached RTDB) would be the better cursor, but it is not indexed,
// and an unindexed orderByChild is REFUSED by the server, not slow.
//
// ── WHY THE WINDOW LOOKS BACK ────────────────────────────────────────────────
// `ts` is the REAL event time — an offline till's sale keeps the time it was
// rung, and arrives when the till reconnects. Measured over the 7 days to
// 2026-10-11 (4,019 rows): p99 lag 0.2 min, max 61 min. So each tick reads
// from `cursor − LOOKBACK_MS` and remembers which rows it has already pushed
// (`seen`), so a late row is caught and an old one is not pushed twice. A row
// later than the lookback is still caught by the markers (any /stock write)
// and by the nightly sweep (stock-truth-sweep.mjs).
//
// ── THE CURSOR ONLY MOVES PAST WHAT WAS PUSHED ───────────────────────────────
// A product whose push fails keeps its rows out of `seen`, and the cursor is
// held at the earliest of them, so the next tick reads them again. A failed
// push can never look like a done one — the same rule the markers live by.
//
// State lives at /shopify_sync/_movementCursor (beside _reconcileState, which
// this directory already keeps there). It is server-only: the Admin SDK
// writes it and no client reads it, so no rule is needed.

export const MOVEMENTS_PATH = "stock_movements";
export const CURSOR_PATH = "shopify_sync/_movementCursor";
// 90 minutes: one and a half times the worst lag measured (61 min).
export const LOOKBACK_MS = 90 * 60 * 1000;
// Products pushed per tick. A bulk receive can move hundreds at once; the rest
// stay unseen and the cursor stays behind them, so the next tick continues.
export const MAX_PRODUCTS_PER_TICK = 60;

const msOf = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/**
 * Pure: given the rows the range query returned and the stored state, which
 * products need pushing and which rows each one stands for.
 *
 * Rows already in `seen` are skipped. A row with no productId or no readable
 * ts is ignored — it cannot be pushed and cannot be ordered.
 */
export function planMovementPass(rows, state = {}) {
  const seen = state.seen || {};
  const byPid = new Map();
  for (const [key, row] of Object.entries(rows || {})) {
    if (seen[key] != null) continue;
    const pid = row?.productId;
    const at = msOf(row?.ts);
    if (!pid || at === null) continue;
    if (!byPid.has(pid)) byPid.set(pid, { pid, keys: [], earliest: at, latest: at });
    const p = byPid.get(pid);
    p.keys.push([key, at]);
    p.earliest = Math.min(p.earliest, at);
    p.latest = Math.max(p.latest, at);
  }
  // Oldest first, so a capped tick takes the work in the order it happened and
  // the cursor can advance as far as the oldest product left behind.
  return [...byPid.values()].sort((a, b) => a.earliest - b.earliest || (a.pid < b.pid ? -1 : 1));
}

// A product that keeps failing holds the cursor for at most this long. After
// that its rows are left to the nightly sweep (stock-truth-sweep.mjs), which
// reads every listing whatever the ledger says, so one permanently stuck
// product cannot make every tick re-read an ever-growing window for ever.
export const MAX_HOLD_MS = 6 * 60 * 60 * 1000;

/**
 * Pure: the state to store after a pass.
 *
 *   done      products whose rows may be marked seen (pushed, or nothing to push)
 *   failed    products whose push failed this tick
 *   deferred  products past the per-tick cap (not attempted)
 *
 * THE CURSOR NEVER ADVANCES ON A FAILURE: with anything failed it stays where
 * it was (or moves BACK to the failed row, if that row arrived late). With
 * only deferred work it advances to the oldest deferred row. With everything
 * done it moves to the latest row. `seen` keeps only rows still inside the
 * next tick's window. A failure older than MAX_HOLD_MS no longer holds it.
 */
export function nextCursorState(state = {}, { done = [], failed = [], deferred = [], nowMs = null } = {}) {
  const seen = { ...(state.seen || {}) };
  for (const p of done) for (const [key, at] of p.keys) seen[key] = at;
  const prev = Number(state.cursorMs) || null;
  const holding = Number.isFinite(nowMs) ? failed.filter((p) => p.earliest >= nowMs - MAX_HOLD_MS) : failed;
  let cursorMs;
  if (holding.length) {
    const oldest = Math.min(...holding.map((p) => p.earliest));
    cursorMs = prev === null ? oldest : Math.min(prev, oldest);
  } else if (deferred.length) {
    cursorMs = Math.min(...deferred.map((p) => p.earliest));
  } else {
    const latest = done.length ? Math.max(...done.map((p) => p.latest)) : null;
    cursorMs = latest === null ? prev : Math.max(prev ?? latest, latest);
  }
  // A till whose clock runs FAST stamps rows in the future. A cursor that
  // followed one there would start the next window past every honest row
  // written in between, so it is never allowed ahead of the server clock.
  if (cursorMs !== null && Number.isFinite(nowMs) && cursorMs > nowMs) cursorMs = nowMs;
  if (cursorMs !== null) {
    const floor = cursorMs - LOOKBACK_MS;
    for (const [k, at] of Object.entries(seen)) if (at < floor) delete seen[k];
  }
  return { cursorMs, seen, abandoned: failed.length - holding.length };
}

/**
 * One pass of the movement path.
 *
 * deps:
 *   db          Admin SDK database (or a fake)
 *   push(pid)   pushes one product → { ok, ... }; may throw
 *   isListed(pid) → whether the product has a Shopify listing to correct
 *   nowMs       server clock, for a first run with no cursor
 *   commit      false = plan and report, store nothing
 *   skip        pids already pushed successfully this tick by another path
 */
export async function sweepMovements(db, {
  push, isListed, nowMs, commit = false, max = MAX_PRODUCTS_PER_TICK,
  skip = new Set(), log = () => {}, meter = () => {},
} = {}) {
  const state = (await db.ref(CURSOR_PATH).get()).val() || {};
  // A first run starts one lookback ago: it catches the recent past and never
  // reaches for the whole ledger.
  const cursorMs = Number(state.cursorMs) || (nowMs - LOOKBACK_MS);
  const fromIso = new Date(cursorMs - LOOKBACK_MS).toISOString();
  const rows = (await db.ref(MOVEMENTS_PATH).orderByChild("ts").startAt(fromIso).get()).val() || {};
  meter("stock_movements (ts window)", rows);

  const plan = planMovementPass(rows, state);
  const done = [];
  const failedP = [];
  const deferred = [];
  const results = [];
  let pushed = 0, failed = 0, notListed = 0;
  for (const [i, p] of plan.entries()) {
    if (i >= max) { deferred.push(p); continue; }
    if (skip.has(p.pid)) { done.push(p); continue; }
    try {
      if (!(await isListed(p.pid))) { notListed++; done.push(p); continue; }
      const r = await push(p.pid);
      results.push(r);
      // ── WHAT COUNTS AS DONE ────────────────────────────────────────────
      // ok:true — pushed or already right. A product Shopify has DELETED is
      // also done: retrying cannot change it, and holding the cursor behind it
      // would stall every product after it for ever (the zombie failure the
      // marker sweep had to rotate around). It is reported every time it moves.
      if (r?.ok === true || r?.productGone === true) {
        done.push(p);
        if (r?.changed) pushed++;
      } else {
        failed++;
        failedP.push(p);
        log(`  ⚠ movement sync ${p.pid}: ${r?.why || r?.skipped || "not pushed"} — rows kept, the next tick retries`);
      }
    } catch (e) {
      failed++;
      failedP.push(p);
      results.push({ pid: p.pid, ok: false, why: String(e?.message || e) });
      log(`  ⚠ movement sync ${p.pid}: ${String(e?.message || e)} — rows kept, the next tick retries`);
    }
  }
  const next = nextCursorState({ ...state, cursorMs }, { done, failed: failedP, deferred, nowMs });
  if (next.abandoned) log(`  ⚠ movement sync: ${next.abandoned} product(s) failing for over ${MAX_HOLD_MS / 3600e3} h no longer hold the cursor — the nightly sweep owns them`);
  if (commit) {
    await db.ref(CURSOR_PATH).set({
      cursorMs: next.cursorMs,
      // RTDB stores no empty object; null says "nothing seen" honestly.
      seen: Object.keys(next.seen).length ? next.seen : null,
      updatedAt: nowMs,
    });
  }
  return {
    rows: Object.keys(rows).length,
    products: plan.length,
    pushed, failed, notListed,
    deferred: Math.max(0, plan.length - max),
    cursorMs: next.cursorMs,
    advanced: next.cursorMs !== (Number(state.cursorMs) || null),
    results,
  };
}
