// ─── DISPLAY CHECKS — PURE TRIGGER LOGIC (no Firebase, node:test-able) ────────
// Everything the onClothingSale trigger decides, as pure functions: is this
// movement a clothing sale, which existing check does it land on, what does the
// resolver assign. The trigger file (onClothingSale.js) does ONLY IO around
// these. Same split as lib/reorder-demand.cjs (pure reasoner) and
// lib/refill-engine.cjs — see functions/test/display-checks.test.cjs.
//
// SALE SOURCE (proven, docs/display-checks-sale-source.md): /stock_movements
// `type === "sold"`, one movement per (sale, product, size) CELL, `from` = the
// selling shop, `qty` = units. Writer contract: marathon-pos-app (documented at
// src/utils/clothingSold.js:11-13); store-app validator applyMovement.js:39.

"use strict";

// ── Per-store trigger flags ───────────────────────────────────────────────────
// Functions-side mirror of the client flags in src/config/displayChecks.js
// (functions are CJS and cannot import that ES module — same mirror-with-a-
// header-comment pattern as lib/auth-utils.cjs). The client MASTER flag gates
// only the UI; this map alone gates the trigger. Phase 1: PE + Trophy write,
// Pine dark. A non-shop `from` (hub1/hub2/central/…) is simply absent → off.
const TRIGGER_STORE_FLAGS = {
  "marathon-pe": true,
  "trophy": true,
  "marathon-pine": false,
};

function isTriggerStoreEnabled(storeId) {
  return TRIGGER_STORE_FLAGS[storeId] === true;
}

// ── Size-key mirror ───────────────────────────────────────────────────────────
// Byte-identical to stockSizeKey/encodeSizeKey in src/utils/sizeKey.js:20-47 —
// the cross-app /stock cell contract ("5.5"→"5_5", one-size/null/"" → "_").
// The trigger needs it to read stock/{loc}/{productId}/{sizeKey} and to build
// the dedupe key. Keep in sync with the src copy (see its header for the rule).
const ILLEGAL_RTDB_CHARS = /[.#$[\]/\s]/g;

function encodeSizeKey(size) {
  if (typeof size === "number") size = String(size);
  if (typeof size !== "string") return size;
  return size.replace(ILLEGAL_RTDB_CHARS, "_");
}

function stockSizeKey(size) {
  if (size == null || size === "") return "_";
  return encodeSizeKey(size);
}

// ── Clothing classifier mirror ────────────────────────────────────────────────
// Mirrors inferProductType (src/utils/insights.js:25-30) exactly as
// isClothingMovement applies it (src/utils/clothingSold.js:126-129): explicit
// productType wins; else the size-letter heuristic on the RAW movement size.
// Known bound (inherited, not new): a legacy product with no productType and a
// size outside S..XXXL (e.g. "4XL", "Free Size") classifies sneaker → skipped.
// Explicit productType covers current catalog entries.
function isClothingSale(product, rawSize) {
  const pt = product && product.productType;
  if (pt) return pt === "clothing";
  return typeof rawSize === "string" && /^(S|M|L|XL|XXL|XXXL)$/i.test(rawSize);
}

// ── Day + month anchors ───────────────────────────────────────────────────────
// SA calendar day — IMPORTED from the single functions-side source
// (lib/sa-time.cjs), not copied; a third byte-identical copy of date logic is
// the same drift trap as the PIN transform. Re-exported below so the trigger
// and tests keep one import surface. The trigger anchors the DAY NODE on
// SERVER receipt time, not the movement's till-clock ts — the 2026-07-17
// order-counter incident (tills 24h behind, fixed with a server-time anchor,
// #236/#237) is exactly the failure this avoids: a skewed till must not file
// a check into a day node nobody is looking at. The movement ts still lands
// on the check verbatim as firstSoldAt/lastSoldAt (the record); the day
// bucket is operational.
const { saDateStringFromMs } = require("../lib/sa-time.cjs");

// Log month bucket "YYYY-MM" for a day-node key "YYYY-MM-DD" (§4.2).
function saMonthOfDate(saDate) {
  return String(saDate).slice(0, 7);
}

// ── Dedupe key ────────────────────────────────────────────────────────────────
// {productId, size, storeId} — store is the path, so within a day node the key
// is productId + encoded size. No colour: Phase 0 confirmed colour is not a
// structured field (each colourway is its own product record). RTDB-safe: both
// halves are already key-safe, "__" separates them unambiguously (product ids
// are p<digits> / SYNTH_*, no underscores-then-size collisions in practice).
function dedupeKey(productId, rawSize) {
  return `${productId}__${stockSizeKey(rawSize)}`;
}

// ── Resolution ────────────────────────────────────────────────────────────────
// Given today's day-node snapshot (object of checkId → check, may be null) and
// the dedupe key, decide what this sale does. Returns one of:
//   { kind:"bump",   checkId, logType:"sale_bumped" }        open check exists
//   { kind:"bump",   checkId, logType:"held_resale" }        held check exists ← stock bug surfacing: LOUD
//   { kind:"create", repeat:{ repeatOf, followedResult, repeatWithinMinutes, logType } }
//   { kind:"create", repeat:null }
//
// Order (per the PR-2 spec): active (open|held) wins over completed — a still-
// open card absorbs the sale; only with no active check does a completed one
// spawn the repeat/contradiction follow-up. Latest completion (completedAt) is
// the one followed. followedResult:
//   "confirmed" → logType "repeat_detected"      (display failed verification)
//   "no_stock"  → logType "contradiction_detected" (till just proved the item
//                  existed — sharper than a repeat; owner directive: never
//                  collapse these two into one)
// `heldRecord` is the SINGLE flat-index entry for this exact dedupeKey — the
// result of an O(1) keyed get on `displayChecks_held/{store}/{dedupeKey}`, NOT
// a scan of every held check (Codex #245: a full-store read per sale grows
// unbounded as chronic held SKUs accumulate). The held index is keyed by
// dedupeKey precisely so at most one held record exists per SKU and it's found
// in one keyed read.
function resolveSale(dayNode, heldRecord, key, nowMs) {
  const day = dayNode || {};
  // 1. OPEN check in today's day node → bump in place (actionable wins).
  for (const [checkId, c] of Object.entries(day)) {
    if (c && c.dedupeKey === key && c.status === "open") {
      return { kind: "bump", location: "day", checkId, logType: "sale_bumped" };
    }
  }
  // 2. HELD check in the flat index (keyed by dedupeKey, so NOT day-scoped) →
  //    held_resale. This dedupes a resale of a held SKU across DAYS (a check
  //    held on Monday and resold Wednesday is this exact record). LOUD: the
  //    till just sold what inventory says is at zero.
  if (heldRecord && heldRecord.status === "held" && heldRecord.dedupeKey === key) {
    return { kind: "bump", location: "held", checkId: heldRecord.checkId, logType: "held_resale" };
  }
  // 2b. LEGACY FALLBACK — a HELD check still in TODAY's day node, written by the
  //     pre-flat-index trigger before this deploy and not yet migrated. Bump it
  //     IN PLACE (location "day") so a resale records held_resale instead of a
  //     duplicate (Codex #245). New held checks never land here; the one-time
  //     migration + the reworked sweep drain legacy day-node held records.
  for (const [checkId, c] of Object.entries(day)) {
    if (c && c.dedupeKey === key && c.status === "held") {
      return { kind: "bump", location: "day", checkId, logType: "held_resale" };
    }
  }
  // 3. COMPLETED check today → repeat / contradiction (a NEW check).
  let latestCompleted = null;
  for (const [checkId, c] of Object.entries(day)) {
    if (!c || c.dedupeKey !== key || c.status !== "completed") continue;
    if (!latestCompleted || (c.completedAt || 0) > (latestCompleted.c.completedAt || 0)) {
      latestCompleted = { checkId, c };
    }
  }
  if (latestCompleted) {
    const { checkId, c } = latestCompleted;
    const followedResult = c.result === "no_stock" ? "no_stock" : "confirmed";
    // Number.isFinite, not `||` — a legitimate 0/epoch timestamp must not be
    // swallowed as "missing" (caught by the contradiction-interval test).
    const rawCompletedAt = Number(c.completedAt);
    const completedAt = Number.isFinite(rawCompletedAt) ? rawCompletedAt : nowMs;
    return {
      kind: "create",
      repeat: {
        repeatOf: checkId,
        followedResult,
        repeatWithinMinutes: Math.max(0, Math.round((nowMs - completedAt) / 60000)),
        logType: followedResult === "no_stock" ? "contradiction_detected" : "repeat_detected",
      },
    };
  }
  return { kind: "create", repeat: null };
}

// ── Assignment resolver ───────────────────────────────────────────────────────
// The REAL resolution order (design §3.3), frozen onto the check at creation and
// never recomputed: cover-for-today → LOCKED roster weekday → null (unassigned).
// PR 11 supplies the data; this seam is already correct, so PR 11 is data, not
// surgery. Inputs are the raw settings nodes (either may be null today):
//   cover:  /displayChecks_settings/{store}/cover/{saDate} → { uid, name, … }
//   roster: /displayChecks_settings/{store}/roster → { locked, days:{mon…sun:{uid,name}} }
// An UNLOCKED roster does not assign — the lock is what makes it a standing
// rule (§3.2); drafts must not put names on permanent records.
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function weekdayOfSaDate(saDate) {
  // saDate is already the SA calendar day; UTC noon avoids any boundary wobble.
  return WEEKDAYS[new Date(`${saDate}T12:00:00.000Z`).getUTCDay()];
}

function resolveAssignment({ cover, roster, saDate }) {
  if (cover && cover.uid) return { uid: cover.uid, name: cover.name || null };
  if (roster && roster.locked === true) {
    const day = roster.days && roster.days[weekdayOfSaDate(saDate)];
    if (day && day.uid) return { uid: day.uid, name: day.name || null };
  }
  return null;
}

// ── Processed-claim (idempotency lease — stable saDate, recoverable) ──────────
// The idempotency record for one movement, at a DATE-INDEPENDENT path
// (…_meta/{store}/processed/{movementId}) so an at-least-once redelivery after
// SA midnight hits the SAME claim instead of a fresh day-bucketed one (which
// would double-process). Value: { at, saDate, done }.
//   cur == null            → claim { at, saDate, done:false }   (first fire)
//   cur.done === true      → skip  (fully processed — the normal double-fire exit)
//   cur stale (> lease)    → STEAL, preserving the ORIGINAL saDate — a crash
//     after claim but before completion must not drop the movement forever,
//     and the retry must write into the day node the first attempt targeted,
//     even if midnight passed in between.
//   cur fresh, not done    → skip  (another execution is in flight)
// Lease matches the refill engine's claim-before-act steal window
// (refill-scan.cjs LOCK_STEAL_MS). Reclamation is IDEMPOTENT at the mutation
// level: every check mutation is fenced by movementId (bumpTxn's
// appliedMovements ledger — a replayed movement is a committed no-op) and
// every audit event uses a deterministic per-(movement,type) key (a replay
// overwrites the same event, never appends a duplicate). So a steal after a
// mid-write crash re-runs the remaining writes without re-applying the landed
// ones — no over-count, no dropped movement. done:true is written only after
// every write lands.
const PROCESS_LEASE_MS = 10 * 60e3;

function processedClaimDecision({ cur, nowMs, saDate }) {
  if (cur == null) return { at: nowMs, saDate, done: false };
  if (cur.done === true) return undefined;
  const at = Number(cur.at);
  if (!Number.isFinite(at) || nowMs - at > PROCESS_LEASE_MS) {
    return { at: nowMs, saDate: cur.saDate || saDate, done: false };
  }
  return undefined;
}

// ── Create-mutex claim (TTL — self-expiring, no external release) ─────────────
// The mutex closes exactly ONE window: two concurrent trigger executions that
// both read an empty day node before either wrote (two tills, same SKU, same
// seconds). Everything non-concurrent is already covered by the day-node scan
// (resolveSale: an open/held check → bump path, which never consults the
// mutex). So the lock's useful life IS that window — seconds — and it expires
// by TTL, not by a release call. PR 2 is correct with PR 7 not existing:
// nothing anywhere is obliged to clear this key, ever. A stuck entry can cost
// at most TTL of dedupe-by-mutex; it can never block a SKU permanently.
//
// Claim rules (transaction callback semantics: return value = write, undefined
// = abort):
//   cur == null                      → claim (first creator)
//   cur older than TTL               → claim (expired — self-heal)
//   cur.checkId completed in my day  → claim (a fresh-but-stale entry must not
//     snapshot                          route a bump onto a completed check;
//                                       checks are never edited after completion)
//   otherwise (fresh, active)        → abort — caller bumps cur.checkId
const CREATE_MUTEX_TTL_MS = 120e3;

function mutexClaimDecision({ cur, nowMs, newCheckId, completedIds }) {
  if (cur == null) return { checkId: newCheckId, at: nowMs };
  const at = Number(cur.at);
  if (!Number.isFinite(at) || nowMs - at > CREATE_MUTEX_TTL_MS) {
    return { checkId: newCheckId, at: nowMs };
  }
  if (completedIds && completedIds.has(cur.checkId)) {
    return { checkId: newCheckId, at: nowMs };
  }
  return undefined;
}

// Ids in a day-node snapshot whose check is completed — feeds the claim rule
// above so a mutex loser can never bump a completed (immutable) check.
function completedIdsOf(dayNode) {
  const out = new Set();
  for (const [checkId, c] of Object.entries(dayNode || {})) {
    if (c && c.status === "completed") out.add(checkId);
  }
  return out;
}

// ── New-check body ────────────────────────────────────────────────────────────
// The denormalised record (§4.1 + PR-2 spec). photoUrl is the FULL-SIZE product
// photo — Phase 0 found no thumbnail derivative.
// TODO(thumbnails): switch to a resized derivative once the Firebase "Resize
// Images" extension (or equivalent) produces one; do not build a resizer here.
function buildNewCheck({
  productId, product, rawSize, key, checkId, movementId, saleId,
  movementTs, qty, status, assignedTo, repeat, nowMs,
}) {
  const check = {
    // Stored as a FIELD (not just the RTDB key): a HELD record is keyed by
    // dedupeKey, so its checkId — the identity used in log events and preserved
    // when the sweep relocates it into a day node — must live on the record.
    checkId,
    productId,
    productName: (product && product.name) || "Unknown",
    size: rawSize == null || rawSize === "" ? "_" : String(rawSize),
    sizeKey: stockSizeKey(rawSize),
    dedupeKey: key,
    photoUrl: (product && product.photoUrl) || null,
    triggerMovementId: movementId,
    triggerSaleId: saleId || null,
    firstSoldAt: movementTs || null,
    lastSoldAt: movementTs || null,
    saleCount: Math.max(1, Number(qty) || 1),   // units, not events — a qty-2 cell is 2 units
    // Movement fence, seeded with the creating movement: a lease-reclaimed
    // replay of this movement finds itself here (bumpTxn) and no-ops.
    appliedMovements: { [movementId]: true },
    status,                                     // "open" | "held"
    result: null,
    createdAt: nowMs,
  };
  if (status === "held") check.heldAt = nowMs;
  else {
    check.activatedAt = nowMs;
    check.assignedTo = assignedTo || null;      // frozen; null = unassigned (§17.3)
  }
  if (repeat) {
    check.repeatOf = repeat.repeatOf;
    check.followedResult = repeat.followedResult;
    check.repeatWithinMinutes = repeat.repeatWithinMinutes;
  }
  return check;
}

// ── Bump transaction body ─────────────────────────────────────────────────────
// Runs INSIDE an RTDB transaction on the whole check node, closing four races
// at once: (1) status is validated atomically — a check completed after the
// day snapshot was read aborts the bump instead of mutating an immutable
// record; (2) lastSoldAt is monotonic — out-of-order executions can't regress
// it to an older or null ts; (3) a partial node the winner hasn't finished
// publishing (no status yet) aborts rather than producing a half-bumped
// orphan; (4) MOVEMENT FENCING — appliedMovements records every movementId
// whose units this check has absorbed, so a lease-reclaimed replay of the
// same movement commits as a NO-OP instead of double-counting. Size note: one
// short key per absorbed movement, bounded by the day's sales of one SKU —
// the ×N dedupe keeps this a handful in practice.
// Returns the next node, undefined (abort), or the unchanged node (fenced no-op).
function bumpTxn(check, { qty, movementTs, movementId }) {
  if (!check || (check.status !== "open" && check.status !== "held")) return undefined;
  if (movementId && check.appliedMovements && check.appliedMovements[movementId]) {
    return check; // already absorbed this movement — idempotent replay
  }
  const next = { ...check, saleCount: (Number(check.saleCount) || 0) + qty };
  if (movementId) {
    next.appliedMovements = { ...(check.appliedMovements || {}), [movementId]: true };
  }
  if (movementTs && (!next.lastSoldAt || movementTs > next.lastSoldAt)) {
    next.lastSoldAt = movementTs;
  }
  return next;
}

// ── Wake sweep (PR 3) — pure transition decision ──────────────────────────────
// A held check (now in the flat index /displayChecks_held/{store}/{dedupeKey})
// waits for stock (§1.3). The sweep reads the SAME stock cell the trigger reads
// and moves the check: held → (stock appears) stockSeenAt + a grace window →
// (grace elapsed, stock still there) open. If stock vanishes during the grace
// it drops back to held. These functions are the PURE decision; the sweep
// (wakeHeldChecks.js) does the IO around them, including RELOCATING a waking
// check out of the flat index into today's day node.
//
// Key robustness choice: the activation threshold is derived from
// `stockSeenAt + delayMs`, NOT a separately-stored `wakeAt`. wakeAt is stored
// for display only, so a crash between writing stockSeenAt and wakeAt can't
// wedge a check.
const WAKE_DEFAULT_DELAY_MINUTES = 20;

// Grace window in ms from the store config (wakeDelayMinutes), default 20.
// Only a real, non-blank value overrides the default: null / "" / undefined /
// whitespace / non-numeric types all fall back to 20. Number("") and
// Number(null) are both 0, so a blank value is rejected BEFORE coercion —
// otherwise it silently collapses the grace window to instant activation
// (CodeRabbit + Codex). An explicit numeric 0 is still honoured.
function wakeDelayMs(config) {
  let raw = config && config.wakeDelayMinutes;
  if (typeof raw === "string") raw = raw.trim();
  if (raw === null || raw === undefined || raw === "" ||
      (typeof raw !== "number" && typeof raw !== "string")) {
    return WAKE_DEFAULT_DELAY_MINUTES * 60000;
  }
  const m = Number(raw);
  return (Number.isFinite(m) && m >= 0 ? m : WAKE_DEFAULT_DELAY_MINUTES) * 60000;
}

// Returns the transition to apply, or null (no-op). Guards on status "held" so
// a non-held record is a no-op — idempotent against a double-fire.
//   { action:"re_held", clearedStockSeenAt }  stock gone before wake
//   { action:"stock_seen" }                   stock appeared, start the grace clock
//   { action:"activate" }                     grace elapsed, stock still present
function wakeTransition(check, { qty, nowMs, delayMs }) {
  if (!check || check.status !== "held") return null;
  const hasStock = Number(qty) > 0;
  const seenAt = Number(check.stockSeenAt);
  const seen = check.stockSeenAt != null && Number.isFinite(seenAt);
  if (!hasStock) return seen ? { action: "re_held", clearedStockSeenAt: check.stockSeenAt } : null;
  if (!seen) return { action: "stock_seen" };
  if (nowMs >= seenAt + delayMs) return { action: "activate" };
  return null; // still inside the grace window
}

// Apply a decided transition INSIDE the held-record transaction — the single
// atomic write for each transition, re-validating the status-based invariants
// against the AUTHORITATIVE current record, so two overlapping sweeps are safe
// (the second sees the first's committed state and aborts). For "activate" it
// flips the record to status "open" IN PLACE (still in the flat index); the
// sweep then relocates the open record into today's day node and deletes the
// flat entry. Returns the next record, or undefined to abort. (qty is not
// re-checked here — it can't be read in a transaction; it was the decision
// input, and status + stockSeenAt + time ARE re-validated.)
function applyWakeTransition(check, action, { nowMs, delayMs, assignedTo, clearedStockSeenAt }) {
  if (!check || check.status !== "held") return undefined; // moved under us
  if (action === "stock_seen") {
    if (check.stockSeenAt != null) return undefined;       // another run claimed it
    return { ...check, stockSeenAt: nowMs, wakeAt: nowMs + delayMs };
  }
  if (action === "activate") {
    const seenAt = Number(check.stockSeenAt);
    if (!Number.isFinite(seenAt) || nowMs < seenAt + delayMs) return undefined; // not ready / cleared
    const next = { ...check, status: "open", activatedAt: nowMs };
    if (assignedTo) next.assignedTo = assignedTo;          // null → omit (unassigned)
    return next;
  }
  if (action === "re_held") {
    if (check.stockSeenAt == null) return undefined;       // already cleared
    // Fence on the OBSERVED timestamp (Codex): a delayed no-stock decision must
    // not cancel a NEWER grace window started by another sweep after the old
    // one was cleared and stock reappeared.
    if (clearedStockSeenAt != null && check.stockSeenAt !== clearedStockSeenAt) return undefined;
    const next = { ...check };
    delete next.stockSeenAt;
    delete next.wakeAt;
    return next;
  }
  return undefined;
}

module.exports = {
  TRIGGER_STORE_FLAGS,
  WAKE_DEFAULT_DELAY_MINUTES,
  wakeDelayMs,
  wakeTransition,
  applyWakeTransition,
  CREATE_MUTEX_TTL_MS,
  PROCESS_LEASE_MS,
  processedClaimDecision,
  mutexClaimDecision,
  completedIdsOf,
  bumpTxn,
  isTriggerStoreEnabled,
  encodeSizeKey,
  stockSizeKey,
  isClothingSale,
  saDateStringFromMs,
  saMonthOfDate,
  dedupeKey,
  resolveSale,
  weekdayOfSaDate,
  resolveAssignment,
  buildNewCheck,
};
