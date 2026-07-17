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
// SA calendar day of an epoch-ms instant — byte-identical to saDateStringFromMs
// (functions/index.js:562-563): UTC+2 shift then date-slice (§0.6 of the design;
// SAST has no DST). The trigger anchors the DAY NODE on SERVER receipt time,
// not the movement's till-clock ts — the 2026-07-17 order-counter incident
// (tills 24h behind, fixed with a server-time anchor, #236/#237) is exactly the
// failure this avoids: a skewed till must not file a check into a day node
// nobody is looking at. The movement ts still lands on the check verbatim as
// firstSoldAt/lastSoldAt (the record); the day bucket is operational.
function saDateStringFromMs(ms) {
  return new Date(ms + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

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
function resolveSale(dayNode, key, nowMs) {
  const checks = dayNode || {};
  let latestCompleted = null;
  for (const [checkId, c] of Object.entries(checks)) {
    if (!c || c.dedupeKey !== key) continue;
    if (c.status === "open") return { kind: "bump", checkId, logType: "sale_bumped" };
    if (c.status === "held") return { kind: "bump", checkId, logType: "held_resale" };
    if (c.status === "completed") {
      if (!latestCompleted || (c.completedAt || 0) > (latestCompleted.c.completedAt || 0)) {
        latestCompleted = { checkId, c };
      }
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

// ── New-check body ────────────────────────────────────────────────────────────
// The denormalised record (§4.1 + PR-2 spec). photoUrl is the FULL-SIZE product
// photo — Phase 0 found no thumbnail derivative.
// TODO(thumbnails): switch to a resized derivative once the Firebase "Resize
// Images" extension (or equivalent) produces one; do not build a resizer here.
function buildNewCheck({
  productId, product, rawSize, key, movementId, saleId,
  movementTs, qty, status, assignedTo, repeat, nowMs,
}) {
  const check = {
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

module.exports = {
  TRIGGER_STORE_FLAGS,
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
