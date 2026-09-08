// ─── STOCK AUDIT — THE WRITERS ───────────────────────────────────────────────
// Everything the two lists can DO. Three rules hold the whole module together:
//
//   1. NO DIRECT /stock WRITE, EVER. Every quantity change goes through
//      applyMovement — the single writer — so the version guard, the atomic
//      cell+ledger pair, the idempotency key and the negative floor all apply
//      exactly as they do to a receive or a sale. The audit trail for a
//      correction is /stock_movements, not this feature's own nodes.
//
//   2. THE SNAPSHOT'S QUANTITY IS EVIDENCE, NOT A BASE. It can be up to a day
//      old. A delta computed against it would be applied to a number nobody
//      counted — the exact hazard applyMovement's `expect` precondition exists
//      for. So an adjustment reads the LIVE cell at the moment of the tap,
//      computes the delta from that, and passes the same value as `expect`, so
//      the read-decide-write is atomic end to end and a concurrent sale makes
//      the write REFUSE rather than land on the wrong base.
//
//   3. AN OUTCOME IS RECORDED ONLY AFTER THE STOCK WRITE LANDS. Recording
//      first would let a refused adjustment disappear off the list as "done"
//      with the phantom still in the database — the one failure that makes an
//      audit worse than no audit.
//
// State: /settings/stockAudit/{store}/results/{saDate}/{key} (what was
// actioned today, so a row does not come back) and
// /settings/stockAudit/rotation/{store}/{productId} (the check stamp that
// drives the rotation order). /settings already has working console rules —
// this feature ships no rules change.

import { ref, get, update } from "firebase/database";
import { database, auth } from "../../firebase";
import { stockCellPath, decodeSizeKey } from "../../utils/sizeKey";
import { serverNowMs } from "../../utils/serverTime";
import { applyMovement } from "./applyMovement";
import { resultsPath, rotationPath, saDateOf } from "../../config/stockAudit";

// Named on the movement so a year from now the ledger says which screen asked
// for the correction and why — "adjustment" alone tells nobody anything.
export const REASON_PREFIX = "Stock Audit";
const reasonFor = (what, store) => `${REASON_PREFIX} — ${what} (${store})`;

// The outcomes, as they are stored. Kept as one list so the view, the stamp and
// the tests cannot drift apart.
export const OOS_OUTCOMES = ["confirmed_empty", "adjusted", "flagged"];
export const ROTATION_OUTCOMES = ["present", "not_there", "not_on_display", "slow"];

function actor() {
  const u = auth.currentUser;
  return u ? u.uid : null;
}

// ── the one adjustment path ──────────────────────────────────────────────────
// Bring a cell to `actual`, whatever it holds now. Returns applyMovement's own
// result shape so a caller never has to guess whether the stock moved.
//
// A cell already at the actual quantity is not an error and not a movement —
// there is nothing to correct, and writing a zero-quantity adjustment would put
// noise in the ledger. It reports { ok: true, noop: true }.
export async function adjustCellTo({ loc, productId, size, actual, what, store, actorRole }) {
  // `Number(null)` and `Number("")` are both 0, so a blank input would zero the
  // shelf on a tap nobody meant — the emptiest possible instruction reading as
  // the most destructive one. An absolute quantity must be typed to count.
  if (actual === null || actual === undefined || String(actual).trim() === "") return { ok: false, reason: "invalid_quantity" };
  const target = Number(actual);
  // WHOLE UNITS ONLY. The /stock rule requires qty % 1 === 0, so "3.5" is
  // rejected by the database as PERMISSION_DENIED — indistinguishable from a
  // version conflict, so applyMovement burns all six retries and returns
  // write_failed, which the screen renders as "try again in a moment". It never
  // works. Refusing here says the true thing on the first tap.
  if (!Number.isFinite(target) || target < 0 || !Number.isInteger(target)) {
    return { ok: false, reason: "invalid_quantity" };
  }

  // The LIVE cell, read at the moment of the tap — never the snapshot's number.
  const snap = await get(ref(database, stockCellPath(loc, productId, size)));
  const live = Number(snap.val()?.qty) || 0;
  const delta = target - live;
  if (delta === 0) return { ok: true, noop: true, live };

  return applyMovement({
    type: "adjustment",
    productId, size,
    qty: Math.abs(delta),
    to: delta > 0 ? loc : null,
    from: delta < 0 ? loc : null,
    reason: reasonFor(what, store),
    actorRole,
    // Closes the window between the read above and applyMovement's own read.
    // Without it a sale landing in that gap would be silently absorbed into the
    // delta and the shelf would end on a number nobody counted.
    expect: { qty: live },
  });
}

// ── TAB A outcomes ───────────────────────────────────────────────────────────
// `row` is a snapshot row: { k, p, n, s, sk, w, q, r }.
//
// "Confirmed empty" means the human walked to the shelf and there is nothing on
// it. What that implies depends on what the system believed:
//
// It always drives the cell to zero, and it does NOT ask the snapshot first.
//
// It used to: `Number(row.q) !== 0` decided whether a correction happened at
// all — which is Rule 2 broken by the code four lines under the comment
// stating it. The snapshot can be nine hours old. A cell that read 0 at 07:00
// and was credited 4 by a mis-scanned transfer at 09:00 would take the
// no-correction branch at 15:00: the check recorded, the row gone, and hub2
// still reading 4 with an empty shelf. By the next pass the triggering request
// has aged out of the lookback window, so it never returns — the exact burial
// this button was already fixed once for.
//
// The gate was never needed. adjustCellTo reads the LIVE cell and returns
// { ok: true, noop: true } when the delta is zero, which is precisely the
// "shelf and system agree, write no ledger noise" behaviour that was wanted.
// One source of truth for the quantity, and it is never the snapshot.
//
// This button used to record in both cases. That was the worst hole in the
// feature: staff confirming an empty shelf would close the row, no correction
// would be written, and the cell would never come back — not negative, and its
// triggering request aged past the lookback window by the next pass. The tool
// would have quietly buried the very defect it was built to surface, behind
// the one button whose label best describes what the person just did.
// (Adversarial architecture review, PR #580.)
export async function recordOutOfStockOutcome({ store, row, outcome, actual, actorRole, nowMs = serverNowMs() }) {
  if (!OOS_OUTCOMES.includes(outcome)) return { ok: false, reason: "unknown_outcome" };
  const uid = actor();
  if (!uid) return { ok: false, reason: "not_authenticated" };

  let movementId = null;
  if (outcome === "confirmed_empty") {
    const res = await adjustCellTo({
      loc: row.w, productId: row.p, size: decodeSizeKey(row.sk),
      actual: 0, what: "confirmed empty", store, actorRole,
    });
    if (!res.ok) return res;                       // NOT recorded — rule 3 (confirm)
    movementId = res.movementId || null;
  }
  if (outcome === "adjusted") {
    // The row's size key is what /stock is keyed by; applyMovement re-encodes,
    // so it must be handed the DECODED size or a half size would round-trip
    // through the encoder twice. Clothing sizes are unaffected either way; the
    // decode is here so the path is correct for any size the catalogue grows.
    const res = await adjustCellTo({
      loc: row.w, productId: row.p, size: decodeSizeKey(row.sk),
      actual, what: "out of stock check", store, actorRole,
    });
    if (!res.ok) return res;                       // NOT recorded — rule 3
    movementId = res.movementId || null;
  }

  const saDate = saDateOf(nowMs);
  await update(ref(database), {
    [`${resultsPath(store, saDate)}/${row.k}`]: {
      outcome, at: nowMs, by: uid,
      productId: row.p, sizeKey: row.sk, where: row.w,
      believed: row.q,
      ...(outcome === "adjusted" ? { actual: Number(actual), movementId } : {}),
      ...(outcome === "confirmed_empty" && movementId ? { actual: 0, movementId } : {}),
    },
  });
  return { ok: true, movementId };
}

// ── TAB B outcomes ───────────────────────────────────────────────────────────
// Every outcome stamps the rotation, and every stamp sends the product to the
// BACK of the queue — including "present but slow", which is the point of that
// button: the line is correct and genuinely slow, so it must settle rather than
// be re-raised as a problem next cycle. The snapshot reads the stamp back as
// `slow` and the card shows it as settled.
//
// "Not there" is the only one that moves stock, and it moves it to zero through
// the same single adjustment path. `sizes` is what the human confirmed absent:
// one entry from the size view, every held size from the product view.
export async function recordRotationOutcome({ store, row, outcome, sizes = null, actorRole, nowMs = serverNowMs() }) {
  if (!ROTATION_OUTCOMES.includes(outcome)) return { ok: false, reason: "unknown_outcome" };
  const uid = actor();
  if (!uid) return { ok: false, reason: "not_authenticated" };

  const movementIds = [];
  if (outcome === "not_there") {
    const targets = (sizes && sizes.length ? sizes : row.z || []);
    if (!targets.length) return { ok: false, reason: "no_sizes" };
    for (const z of targets) {
      const res = await adjustCellTo({
        loc: store, productId: row.p, size: decodeSizeKey(z.sk),
        actual: 0, what: "not on the floor", store, actorRole,
      });
      // ALL OR NOTHING IS NOT AVAILABLE HERE — applyMovement is atomic per
      // movement, not across several. So a partial failure is REPORTED with
      // what did land rather than swallowed: the row stays on the list, the
      // stamp is not written, and the sizes that moved are named so the next
      // attempt is not a mystery.
      if (!res.ok) return { ...res, partial: movementIds };
      if (res.movementId) movementIds.push(res.movementId);
    }
  }

  const saDate = saDateOf(nowMs);
  await update(ref(database), {
    [`${rotationPath(store)}/${row.p}`]: { at: nowMs, o: outcome, by: uid },
    [`${resultsPath(store, saDate)}/${row.p}`]: {
      outcome, at: nowMs, by: uid,
      productId: row.p,
      ...(movementIds.length ? { movementIds } : {}),
    },
  });
  return { ok: true, movementIds };
}
