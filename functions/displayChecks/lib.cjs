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
// `activeRecord` is the SINGLE record at /displayChecks_active/{store}/{dedupeKey}
// (one active record per SKU, whole active life — never moves, never null while
// active). Read by an O(1) keyed get. The day node is NOT consulted: the latest
// completed check for a SKU is exactly this record while it is a `completed`
// tombstone (before the next sale overwrites it), so repeat/contradiction is
// derived from it.
//   open      → sale_bumped
//   held      → held_resale (till sold what inventory says is at zero)
//   completed → repeat/contradiction; a NEW check OVERWRITES the tombstone (its
//               checkId is archived to the day node first — the create path)
//   null      → fresh create
function resolveSale(activeRecord, key, nowMs) {
  const c = activeRecord;
  if (!c || c.dedupeKey !== key) return { kind: "create", repeat: null, overwrite: false };
  if (c.status === "open") return { kind: "bump", checkId: c.checkId, logType: "sale_bumped" };
  if (c.status === "held") return { kind: "bump", checkId: c.checkId, logType: "held_resale" };
  if (c.status === "completed") {
    const followedResult = c.result === "no_stock" ? "no_stock" : "confirmed";
    // Number.isFinite, not `||` — a legitimate 0/epoch completedAt is real.
    const rawCompletedAt = Number(c.completedAt);
    const completedAt = Number.isFinite(rawCompletedAt) ? rawCompletedAt : nowMs;
    return {
      kind: "create",
      overwrite: true,            // overwrite this completed tombstone at the dedupeKey
      archiveCheckId: c.checkId,  // ensure it's archived to the day node first (idempotent)
      repeat: {
        repeatOf: c.checkId,
        followedResult,
        repeatWithinMinutes: Math.max(0, Math.round((nowMs - completedAt) / 60000)),
        logType: followedResult === "no_stock" ? "contradiction_detected" : "repeat_detected",
      },
    };
  }
  // Unknown status (e.g. a partial write) → treat as absent, create fresh.
  return { kind: "create", repeat: null, overwrite: false };
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

// ── New-check body ────────────────────────────────────────────────────────────
// The denormalised record (§4.1 + PR-2 spec). photoUrl is the FULL-SIZE product
// photo — Phase 0 found no thumbnail derivative.
// TODO(thumbnails): switch to a resized derivative once the Firebase "Resize
// Images" extension (or equivalent) produces one; do not build a resizer here.
function buildNewCheck({
  productId, product, rawSize, key, checkId, movementId, saleId,
  movementTs, qty, status, assignedTo, activatedSaDate, repeat, nowMs,
}) {
  const check = {
    // Stored as a FIELD (not just the RTDB key): the active index is keyed by
    // dedupeKey, so its checkId — the identity used in log events, the bumpTxn
    // checkId fence, and when a completed check is archived to the day node —
    // must live on the record.
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
    // The SA day this check went OPEN. The active index is dateless, so a check
    // that opens on day 1 and is still open past 03:00 rollover carries no other
    // record of its opening day; PR 12 attributes its mark to THIS day's
    // assignee. Stamped at open, frozen. (Window #3.)
    check.activatedSaDate = activatedSaDate || null;
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
function bumpTxn(check, { qty, movementTs, movementId, expectedCheckId }) {
  if (!check || (check.status !== "open" && check.status !== "held")) return undefined;
  // CHECKID FENCE (the class-killer): the active index is keyed by dedupeKey, so
  // a SKU's slot can be OVERWRITTEN by a fresh check after the previous one
  // completes. A sale that resolved against the OLD check must never bump the
  // NEW one — its bumpCheck passes the checkId it resolved, and a mismatch
  // aborts (→ the trigger re-resolves onto the current check). This also means a
  // completed-then-overwritten slot can't be mis-credited, and — with the
  // never-null invariant (records are overwritten, not deleted, during active
  // life) — there is no deleted-record path for `cur ?? preRead` to resurrect.
  if (expectedCheckId != null && check.checkId !== expectedCheckId) return undefined;
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
  const ms = (Number.isFinite(m) && m >= 0 ? m : WAKE_DEFAULT_DELAY_MINUTES) * 60000;
  // Guard the multiplication: a huge finite minutes value overflows to Infinity,
  // which would poison wakeAt (now + Infinity) and fail the write (CodeRabbit).
  return Number.isFinite(ms) ? ms : WAKE_DEFAULT_DELAY_MINUTES * 60000;
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
function applyWakeTransition(check, action, { nowMs, delayMs, assignedTo, clearedStockSeenAt, activatedSaDate }) {
  if (!check || check.status !== "held") return undefined; // moved under us
  if (action === "stock_seen") {
    if (check.stockSeenAt != null) return undefined;       // another run claimed it
    return { ...check, stockSeenAt: nowMs, wakeAt: nowMs + delayMs };
  }
  if (action === "activate") {
    const seenAt = Number(check.stockSeenAt);
    if (!Number.isFinite(seenAt) || nowMs < seenAt + delayMs) return undefined; // not ready / cleared
    // Flip held → open IN PLACE (never-null invariant: the record stays at its
    // dedupeKey, no move, no relocation race). Strip the grace fields; stamp the
    // opening SA day for PR-12 mark attribution (window #3).
    const next = { ...check, status: "open", activatedAt: nowMs, activatedSaDate: activatedSaDate || null };
    delete next.stockSeenAt;
    delete next.wakeAt;
    // Assign explicitly to null (not `if (assignedTo)`) so a held record that
    // somehow carries a stale assignedTo can't reopen under the wrong person —
    // null CLEARS the field in the transaction write (CodeRabbit).
    next.assignedTo = assignedTo || null;
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

// ── Feed / cleanup predicates over the active index ───────────────────────────
// WINDOW #1 — the feed keys on the STATUS FIELD, never on "present in the active
// index". A completed tombstone still occupying its dedupeKey (until the next
// sale overwrites it, or the sweep cleans it) must NOT render as active work.
// PR 5's feed filters active checks with this; a `completed` (or any non
// held/open) record is excluded regardless of how long it lingers.
function isActiveCheck(record) {
  return !!record && (record.status === "held" || record.status === "open");
}

// WINDOW #2 — a completed tombstone is safe for the sweep to DELETE once it is
// from a PRIOR SA day. Proof it can't resurrect: a bump only reaches this key
// via bumpCheck, whose whole execution is seconds long, so any in-flight bump
// that saw the record while it was open/held settled the same day it acted;
// a tombstone whose completedAt is on an earlier SA day has NO in-flight bump.
// And even a hypothetical late bump aborts — bumpTxn rejects a `completed`
// status (write-once) and the checkId fence rejects a mismatch — so `cur ??
// preRead` has nothing bumpable to write back. `todaySaDate` is the sweep's
// current SA day.
function isStaleTombstone(record, todaySaDate) {
  if (!record || record.status !== "completed") return false;
  const completedAt = Number(record.completedAt);
  if (!Number.isFinite(completedAt)) return true; // malformed/undated → safe to reap
  return saDateStringFromMs(completedAt) < todaySaDate;
}

// ── Completion (PR 7) — pure decision + record builder ────────────────────────
// A staff member CLOSES an OPEN check with one of two results: "confirmed" (the
// display was restocked) or "no_stock" (there was nothing to put out). The
// decision is pure so the write-once + no-stock-soft-block rules are unit-tested
// without Firebase; completeCheck.js does the IO (auth, reads, the tombstone
// transaction, the day-node archive) around it.
//
// Rules (owner directives):
//  • WRITE-ONCE — a check with a completedAt (or already `completed`) can never
//    be re-completed; the first result stands.
//  • OPEN-ONLY — only an open check completes. A held check has no stock to
//    confirm and is not actionable; a missing/mismatched record is rejected.
//  • NO-STOCK SOFT-BLOCK — if the till/inventory shows stock > 0 for the SKU, a
//    "no_stock" close is contradicted; it is BLOCKED (needs_override) until the
//    staff member explicitly overrides, and the override is logged with the qty
//    as evidence (the system contradicting a person, calmly, with a number).
// Returns exactly one of:
//   { kind:"reject", code }                     code ∈ not-found | stale-check |
//                                               already-completed | not-open | bad-result
//   { kind:"needs_override", stockQty }          no_stock but stock>0 and no override
//   { kind:"complete", overridden }              proceed; overridden true iff it was
//                                               a no_stock close over real stock
function completionDecision({ record, expectedCheckId, result, override, stockQty }) {
  if (!record) return { kind: "reject", code: "not-found" };
  if (expectedCheckId != null && record.checkId !== expectedCheckId) {
    return { kind: "reject", code: "stale-check" };
  }
  // WRITE-ONCE first: an already-completed record (or one carrying completedAt)
  // is closed forever — report that, not "not-open".
  if (record.status === "completed" || record.completedAt != null) {
    return { kind: "reject", code: "already-completed" };
  }
  if (record.status !== "open") return { kind: "reject", code: "not-open" };
  if (result !== "confirmed" && result !== "no_stock") {
    return { kind: "reject", code: "bad-result" };
  }
  const stock = Number(stockQty) || 0;
  if (result === "no_stock" && stock > 0 && override !== true) {
    return { kind: "needs_override", stockQty: stock };
  }
  return { kind: "complete", overridden: result === "no_stock" && stock > 0 && override === true };
}

// Build the completed record written to BOTH the day-node archive and the active
// index (as an in-place `completed` TOMBSTONE — never a deletion; the tombstone
// is what keeps the cold-cache resurrection class closed). Preserves everything
// on the open record — crucially `activatedSaDate`, the SA day the check opened,
// which is the anchor PR-12 attributes the mark to. Grace fields are long gone
// on an open check; stripped defensively.
function buildCompletedRecord(record, { result, nowMs, saDate, actor, overridden }) {
  const next = {
    ...record,
    status: "completed",
    result,                            // "confirmed" | "no_stock"
    completedAt: nowMs,
    completedSaDate: saDate,           // server SA day of completion (day-node key)
    completedBy: actor || null,        // { uid, name, email } — the logged-in user, NO PIN
    resultOverridden: !!overridden,    // a no_stock close over real stock (amber flag)
  };
  delete next.stockSeenAt;
  delete next.wakeAt;
  return next;
}

module.exports = {
  TRIGGER_STORE_FLAGS,
  WAKE_DEFAULT_DELAY_MINUTES,
  wakeDelayMs,
  wakeTransition,
  applyWakeTransition,
  isActiveCheck,
  isStaleTombstone,
  PROCESS_LEASE_MS,
  processedClaimDecision,
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
  completionDecision,
  buildCompletedRecord,
};
