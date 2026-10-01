// ─── STOCK AUDIT — THE WRITERS ───────────────────────────────────────────────
// ONE OUTCOME PER ROW, AND IT IS "FIXED". (Owner decision 2026-09-08.)
//
// This used to offer three answers on the hub tab and four on the shop tab, and
// the adjustment among them wrote real stock through applyMovement. Every one
// of them is gone, because the question a person asks at a shelf is not which
// of four sentences describes what they found — it is whether they have dealt
// with it. One button, and the row goes away.
//
// SO THIS MODULE NO LONGER WRITES /stock AT ALL. Correcting a quantity is the
// Adjust screen's job and always was; an audit that also moved stock was a
// second writer for the same act, with its own idea of what the shelf held.
// What is recorded here is exactly what happened: a person looked, and it is
// handled. The evidence of the fix is the movement the Adjust screen writes,
// in /stock_movements, where every other quantity change already lives.
//
// State: /settings/stockAudit/{hub|store}/results/{saDate}/{key} — what was
// actioned today, so a row does not come back — and
// /settings/stockAudit/rotation/{store}/{productId}, the check stamp that
// drives the rotation order. /settings already has working console rules, so
// this feature ships no rules change.

import { ref, update } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowMs } from "../../utils/serverTime";
import { resultsPath, hubResultsPath, rotationPath, saDateOf } from "../../config/stockAudit";

// Named on the movement so a year from now the ledger says which screen asked
// for the correction and why — "adjustment" alone tells nobody anything.
// The one outcome there is. Kept as a named constant rather than a bare string
// so the writer, the stamp and the tests cannot drift apart.
export const FIXED = "fixed";

function actor() {
  const u = auth.currentUser;
  return u ? u.uid : null;
}

// ── the hub tab: a sneaker line a customer was turned away from ──────────────
// `row` is a snapshot row: { k, p, n, s, sk, w, q, r, c }. The row's own
// identity is the key, so the same cell checked tomorrow is a new question and
// today's answer does not silence it forever.
export async function markHubRowFixed({ hub, row, nowMs = serverNowMs() }) {
  const uid = actor();
  if (!uid) return { ok: false, reason: "not_authenticated" };
  if (!row || !row.k) return { ok: false, reason: "invalid_row" };

  await update(ref(database), {
    [`${hubResultsPath(hub, saDateOf(nowMs))}/${row.k}`]: {
      outcome: FIXED, at: nowMs, by: uid,
      productId: row.p, sizeKey: row.sk, where: row.w,
      // What the system believed when the list was built. Kept because it is
      // the only record of what the person was looking at when they said the
      // shelf was handled — the cell itself will have moved on.
      believed: row.q,
      answer: row.r,
    },
  });
  return { ok: true };
}

// ── the shop tab: a clothing line that has not sold in three weeks ───────────
// Stamps the rotation, which is what sends the product to the BACK of the queue
// and is the durable record a carried batch is filtered against. Both writes
// land in ONE update so a stamped product can never be missing from the day's
// results, or the reverse.
export async function markRotationRowFixed({ store, row, nowMs = serverNowMs() }) {
  const uid = actor();
  if (!uid) return { ok: false, reason: "not_authenticated" };
  if (!row || !row.p) return { ok: false, reason: "invalid_row" };

  await update(ref(database), {
    [`${rotationPath(store)}/${row.p}`]: { at: nowMs, o: FIXED, by: uid },
    [`${resultsPath(store, saDateOf(nowMs))}/${row.p}`]: {
      outcome: FIXED, at: nowMs, by: uid, productId: row.p,
    },
  });
  return { ok: true };
}
