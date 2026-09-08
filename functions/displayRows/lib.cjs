// ─── DISPLAY ROW CLOSE — the decisions, pure ─────────────────────────────────
//
// (Owner spec clause 3, 2026-09-08.) Everything the sale trigger decides lives
// here, with no admin SDK and no firebase-functions import, so `node --test`
// can drive it directly. The trigger itself (closeDisplayRowOnSale.js) is the
// plumbing around these answers.
//
// ── WHY THE TRIGGER IS ON /stock_movements AND NOT ON THE POS ────────────────
// marathon-pos-app must not change. It already writes ONE `sold` movement per
// (sale, product, size) cell with `from` = the selling shop — proven for the
// Display Checks work (docs/display-checks-sale-source.md) and the same source
// onClothingSale has fired off since it shipped. So the close fires from ANY
// till, on any device, with no POS deploy and no POS awareness that this exists.
//
// ── WHAT COUNTS AS A CLOSE ───────────────────────────────────────────────────
//   SOLD      a `sold` movement at a display store, matching an open row's
//             product AND the row's CAPTURED SIZE. The size match is what stops
//             an ordinary shelf sale of size 8 closing the display record for
//             the size 10 standing on the wall.
//   RETURNED  a `transfer_out` FROM the display store TO a hub, same product,
//             same size — the display came back off the wall.
// Anything else is ignored, loudly doing nothing.
//
// ── SIZE MATCHING IS ON THE KEY, NOT THE LABEL ───────────────────────────────
// A movement carries a human size ("9.5"); a row carries both `size` and
// `sizeKey`. They are compared as KEYS, through the same encoder the app uses,
// because "9.5" and "9,5" and " 9.5 " are the same shelf and three different
// strings. The encoder is duplicated from src/utils/sizeKey.js the way
// displayChecks/lib.cjs duplicates it — functions/ cannot import from src/ —
// and functions/test/display-rows-sizekey.test.cjs differential-tests the two
// copies over a shared corpus so a drift is a red test, not a silent mismatch.
//
// ── ONE SALE MUST NOT CLOSE TWO PAIRS ────────────────────────────────────────
// A movement of qty 1 closes AT MOST ONE row. When a wall has duplicates (the
// state the Duplicate Displays tab exists for), the OLDEST matching open row
// goes first — it is the one that has been claimed longest and is likeliest to
// be the stale record. `qty` may close more, bounded by the matching rows.
//
// ── IDEMPOTENCY ──────────────────────────────────────────────────────────────
// Gen-2 RTDB triggers are at-least-once. A lease at
// /settings/displayRows_meta/{store}/processed/{movementId} is claimed before
// any write and marked done after; a replay of the same movement finds the
// lease and returns without touching a row. A STALE lease (a crashed execution)
// is stealable after LEASE_MS so a crash retries instead of wedging.
//
// The lease alone is not the whole guarantee, and the second half matters more:
// the close is EXPRESSED AS FIELD WRITES ON A NAMED ROW, and closing an already
// closed row is a no-op by construction — `decideCloses` only ever returns rows
// whose status is "open". So even a lease that is lost cannot double-close: the
// second run sees no open row to close. Belt and braces, in that order.

"use strict";

/** The stores whose walls this trigger watches. Hub 1 and Hub 2 serve these two;
 *  Pine's displays are booked at hub3 and are out of scope by owner constraint
 *  (GATED_SNEAKER_HUBS). A store not in this list returns immediately, which is
 *  also what makes the trigger cheap on every unrelated stock movement. */
const DISPLAY_STORES = ["marathon-pe", "trophy"];

/** The hubs a display may be booked at, and therefore returned to. */
const DISPLAY_HUBS = ["hub1", "hub2"];

const LEASE_MS = 5 * 60 * 1000;

// Size → the /stock cell key. Byte-identical to encodeSizeKey/stockSizeKey in
// src/utils/sizeKey.js, INCLUDING the "Free Size" fold and the whitespace class
// in the character set. A first cut of this file trimmed and used a narrower
// character class; it agreed on every size anybody types and disagreed on " 8"
// and "Free Size", which is precisely the kind of near-miss a differential test
// exists to catch. functions/test/display-rows-close.test.cjs runs both copies
// over a shared corpus.
const ILLEGAL_RTDB_CHARS = /[.#$[\]/\s]/g;

function encodeSizeKey(size) {
  if (typeof size === "number") size = String(size);
  if (typeof size !== "string") return size;
  return size.replace(ILLEGAL_RTDB_CHARS, "_");
}

function stockSizeKey(size) {
  if (size == null || size === "" || size === "Free Size") return "_";
  return encodeSizeKey(size);
}

/**
 * Is this movement one that can close a display row, and at which store?
 * → { kind: "sold" | "returned", store, productId, sizeKey, qty } | null
 */
function classifyMovement(m) {
  if (!m || typeof m !== "object") return null;
  if (!m.productId) return null;
  const sizeKey = stockSizeKey(m.size);
  // "_" is the one-size sentinel and can never be a display row. A key of
  // NOTHING BUT underscores is the same statement in a longer form — it is what
  // the shared encoder makes of a whitespace-only size ("   " → "___"), and it
  // carries no size at all. The encoder is deliberately left byte-identical to
  // the app's (a differential test pins that), so the refusal lives here rather
  // than in a private variant of the encoder. Found by the test below.
  if (/^_+$/.test(sizeKey)) return null;
  const qty = Math.max(1, Number(m.qty) || 1);

  if (m.type === "sold" && DISPLAY_STORES.includes(m.from)) {
    return { kind: "sold", store: m.from, productId: m.productId, sizeKey, qty };
  }
  // A display coming back off the wall: out of the SHOP, into a HUB.
  if (m.type === "transfer_out" && DISPLAY_STORES.includes(m.from) && DISPLAY_HUBS.includes(m.to)) {
    return { kind: "returned", store: m.from, productId: m.productId, sizeKey, qty };
  }
  return null;
}

/** Positive test for an open row, matching src/components/stock/displayRowCore.js. */
function rowIsOpen(row) {
  return !!row && row.status === "open" && typeof row.sizeKey === "string"
    && row.sizeKey.length > 0 && row.sizeKey !== "_";
}

/**
 * Which rows this movement closes.
 *
 * @param byRow  /settings/displayRows/{store}/{productId} → { rowId: row }
 * @param sizeKey the movement's size, as a key
 * @param qty     how many units moved
 * → [{ rowId, row }] — oldest first, at most `qty` of them, possibly empty.
 */
function decideCloses(byRow, sizeKey, qty) {
  const open = Object.entries(byRow || {})
    .map(([rowId, row]) => ({ rowId, row }))
    .filter(({ row }) => rowIsOpen(row) && row.sizeKey === sizeKey);
  open.sort((a, b) =>
    String(a.row.openedAt || "").localeCompare(String(b.row.openedAt || "")) || a.rowId.localeCompare(b.rowId));
  return open.slice(0, Math.max(0, Number(qty) || 0));
}

/** The field writes for ONE close, relative to the row's own path. Mirrors the
 *  client's closeFields — the same shape, so a row closed by the till and one
 *  closed by an operator are indistinguishable to every reader. */
function closeUpdates(basePath, { at, reason, via, movementId }) {
  const eventId = `closed_${String(at).replace(/[.#$/[\]\s:]/g, "-")}`;
  return {
    [`${basePath}/status`]: "closed",
    [`${basePath}/closedAt`]: at,
    [`${basePath}/closedBy`]: `system:${via}`,
    [`${basePath}/closedReason`]: reason,
    [`${basePath}/closedVia`]: via,
    [`${basePath}/closedRef`]: movementId || null,
    [`${basePath}/events/${eventId}`]: {
      at, what: "closed", by: `system:${via}`,
      detail: { reason, movementId: movementId || null },
    },
  };
}

/**
 * The lease decision — returns the record to write, or undefined to ABORT the
 * transaction (already done, or somebody else holds a fresh lease).
 * Same shape as displayChecks/lib.cjs processedClaimDecision, deliberately.
 */
function leaseDecision({ cur, nowMs }) {
  if (cur && cur.done === true) return undefined;                        // already processed
  if (cur && Number(cur.at) && nowMs - Number(cur.at) < LEASE_MS) return undefined;  // fresh lease held
  return { at: nowMs, done: false };
}

module.exports = {
  DISPLAY_STORES, DISPLAY_HUBS, LEASE_MS,
  encodeSizeKey, stockSizeKey, classifyMovement, rowIsOpen, decideCloses, closeUpdates, leaseDecision,
};
