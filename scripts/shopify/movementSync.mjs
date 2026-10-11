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
// A product whose push fails (a transport error, a sale landing mid-push, a
// tracking read that failed) keeps its rows out of `seen`, and the cursor is
// held at the earliest of them, so the next tick reads them again — for up to
// MAX_HOLD_MS. A PERMANENT answer (deleted from Shopify, an id map Shopify
// does not recognise) is not a failure the next tick can fix: it is counted
// done, reported every time the product moves, and left to the nightly sweep.
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

// A product that keeps failing holds the cursor for at most this long, timed
// from its FIRST failure (not from its row's ts — a row that was already old
// when the mini came back from an outage must still get its full retries).
// After that its rows are marked seen and left to the nightly sweep
// (stock-truth-sweep.mjs), which reads every listing whatever the ledger says,
// so one stuck product cannot make every tick re-read a growing window.
export const MAX_HOLD_MS = 6 * 60 * 60 * 1000;
export const STREAK_GAP_MS = 60 * 60 * 1000;

/**
 * Pure: the state to store after a pass.
 *
 *   done      products whose rows may be marked seen (pushed, nothing to push,
 *             or a PERMANENT answer retrying cannot change)
 *   failed    products whose push failed this tick (retryable)
 *   deferred  products past the per-tick cap (not attempted)
 *
 * THE CURSOR NEVER ADVANCES ON A FAILURE: with anything failed it stays where
 * it was (or moves BACK to the failed row, if that row arrived late). With
 * only deferred work it advances to the oldest deferred row. With everything
 * done it moves to the latest row. `seen` keeps only rows still inside the
 * next tick's window. `failing` remembers when each product first failed.
 */
export function nextCursorState(state = {}, { done = [], failed = [], deferred = [], nowMs = null } = {}) {
  const seen = { ...(state.seen || {}) };
  const failing = { ...(state.failing || {}) };
  for (const p of done) delete failing[p.pid];
  const holding = [];
  const abandoned = [];
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  for (const p of failed) {
    // { since, last }. A failure streak is only continuous while the product
    // keeps being attempted: an entry not refreshed for an hour (the product
    // went quiet, or was deferred) starts a new streak, so one fresh failure
    // is never abandoned on the strength of an old one.
    const prevF = failing[p.pid];
    const prevSince = typeof prevF === "object" ? Number(prevF?.since) : Number(prevF);
    const prevLast = typeof prevF === "object" ? Number(prevF?.last) : Number(prevF);
    const continuous = Number.isFinite(prevLast) && now - prevLast < STREAK_GAP_MS;
    const since = continuous && Number.isFinite(prevSince) ? prevSince : now;
    failing[p.pid] = { since, last: now };
    if (Number.isFinite(nowMs) && nowMs - since >= MAX_HOLD_MS) abandoned.push(p);
    else holding.push(p);
  }
  for (const p of [...done, ...abandoned]) for (const [key, at] of p.keys) seen[key] = at;
  for (const p of abandoned) delete failing[p.pid];
  const prev = Number(state.cursorMs) || null;
  let cursorMs;
  if (holding.length) {
    const oldest = Math.min(...holding.map((p) => p.earliest));
    cursorMs = prev === null ? oldest : Math.min(prev, oldest);
  } else if (deferred.length) {
    cursorMs = Math.min(...deferred.map((p) => p.earliest));
  } else {
    const latest = [...done, ...abandoned].length ? Math.max(...[...done, ...abandoned].map((p) => p.latest)) : null;
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
  return { cursorMs, seen, failing, abandoned: abandoned.map((p) => p.pid) };
}

/**
 * One pass of the movement path.
 *
 * deps:
 *   db            Admin SDK database (or a fake)
 *   push(pid)     pushes one product → { ok, ... }; may throw
 *   isListed(pid) → whether the product has a Shopify listing to correct
 *   nowMs         server clock, for a first run with no cursor
 *   commit        false = plan and report, store nothing
 *
 * No product is skipped because another path pushed it earlier in the tick:
 * a sale landing between that push's stock read and this query would then be
 * marked seen without ever being pushed (reviewer finding, PR #718). A second
 * push of an unchanged product is one Shopify read and no write.
 */
export async function sweepMovements(db, {
  push, isListed, nowMs, commit = false, max = MAX_PRODUCTS_PER_TICK,
  log = () => {}, meter = () => {},
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
  const permanent = [];
  let pushed = 0, notListed = 0;
  for (const [i, p] of plan.entries()) {
    if (i >= max) { deferred.push(p); continue; }
    try {
      if (!(await isListed(p.pid))) { notListed++; done.push(p); continue; }
      const r = await push(p.pid);
      results.push(r);
      if (r?.ok === true) {
        done.push(p);
        if (r?.changed) pushed++;
      } else if (r?.permanent === true) {
        // ── A PERMANENT ANSWER IS DONE, AND SAID OUT LOUD ────────────────
        // Deleted from Shopify, an id map Shopify does not recognise, no id
        // map at all: retrying cannot change any of them, and holding the
        // cursor behind them would stall every product after them and stop
        // the watchdog's heartbeat for a reason no tick can fix. They are
        // reported every time they move, and the nightly sweep reports them.
        done.push(p);
        permanent.push({ pid: p.pid, why: r?.why || r?.skipped });
      } else {
        failedP.push(p);
        log(`  ⚠ movement sync ${p.pid}: ${r?.why || r?.skipped || "not pushed"} — rows kept, the next tick retries`);
      }
    } catch (e) {
      failedP.push(p);
      results.push({ pid: p.pid, ok: false, why: String(e?.message || e) });
      log(`  ⚠ movement sync ${p.pid}: ${String(e?.message || e)} — rows kept, the next tick retries`);
    }
  }
  const next = nextCursorState({ ...state, cursorMs }, { done, failed: failedP, deferred, nowMs });
  if (next.abandoned.length) log(`  ⚠ movement sync: ${next.abandoned.join(", ")} failing for over ${MAX_HOLD_MS / 3600e3} h — no longer holding the cursor; the nightly sweep owns them`);
  if (commit) {
    // RTDB stores no empty object; null says "nothing here" honestly.
    const orNull = (o) => (Object.keys(o).length ? o : null);
    await db.ref(CURSOR_PATH).set({
      cursorMs: next.cursorMs,
      seen: orNull(next.seen),
      failing: orNull(next.failing),
      updatedAt: nowMs,
    });
  }
  return {
    rows: Object.keys(rows).length,
    products: plan.length,
    pushed, notListed,
    // Retryable failures still holding the cursor. Only these make a pass
    // "not clean" for the watchdog.
    failed: failedP.length - next.abandoned.length,
    permanent,
    abandoned: next.abandoned,
    deferred: deferred.length,
    cursorMs: next.cursorMs,
    advanced: next.cursorMs !== (Number(state.cursorMs) || null),
    results,
  };
}
