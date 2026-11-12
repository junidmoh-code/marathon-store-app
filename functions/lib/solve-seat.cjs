// ─── HUB 1 / HUB 2 NEVER SHARE A SNEAKER — the server's refusal ──────────────
// Called by refillRequestSourceGuard for every new sneaker Solve line at Hub 1
// or Hub 2. A line that would seat the product at one hub while the other has it
// seated is cancelled (cancelReason seated_at_other_marathon_hub) and logged for
// Junid. Keyed reads only: the other hub's cell node, its target rows, one claim.
"use strict";

const { marathonHubSeated } = require("./concrete-division.cjs");
const rs = require("./request-source.cjs");

const val = async (db, path) => (await db.ref(path).once("value")).val();

// Does this claimed request no longer speak for the other hub? Cancelled or gone:
// yes. Fulfilled: only once the hub has a cell, because the seat test above has
// then read that cell and said "not seated" (it was switched off). A fulfilled
// line with no cell yet is stock still on its way, parked or in transit.
function claimRequestFinished(status, cells) {
  if (status === null || status === undefined || status === "cancelled") return true;
  return status === "fulfilled" && !!cells && Object.keys(cells).length > 0;
}

async function enforceMarathonSolveSeat({ db, id, rr, nowIso }) {
  const leg = rs.marathonSolveLeg(rr);
  if (!leg) return { checked: false };
  const { hub, other, pid } = leg;
  const [cells, rows] = await Promise.all([val(db, `stock/${other}/${pid}`), val(db, `stock_targets/${other}/${pid}`)]);
  let refused = marathonHubSeated({ cells, rows });
  if (!refused) {
    // A claim the other hub still has a live request behind is a seat too.
    const path = `${rs.SOLVE_SEATS}/${pid}`;
    const claim = await val(db, path);
    const staleIds = [];
    if (claim && claim.hub === other) {
      for (const r of Object.keys(claim.requests || {})) {
        // eslint-disable-next-line no-await-in-loop
        const status = await val(db, `refill_requests/${r}/status`);
        if (claimRequestFinished(status, cells)) staleIds.push(r);
      }
    }
    const res = await db.ref(path).transaction((cur) => rs.claimSolveSeat(cur, { hub, id, nowIso, staleIds }));
    refused = !res.committed;
  }
  if (!refused) return { checked: true, refused: false };
  let seen = null;
  const res = await db.ref(`refill_requests/${id}`).transaction((cur) => {
    seen = cur;
    return rs.rejectSeatTxn(cur, { nowIso });
  });
  const after = res.snapshot.val();
  const cancelled = !!(after && after.cancelReason === rs.SEAT_REJECT_REASON);
  // Redelivered after the line was worked or closed: nothing here to refuse.
  if (!cancelled && after && after.status !== "open") return { checked: true, refused: false };
  await db.ref(`${rs.REJECTED_LOG}/${id}`).set(rs.rejectionRecord(id, after || seen || rr, { nowIso, cancelled, reason: rs.SEAT_REJECT_REASON }));
  return { checked: true, refused: true, cancelled };
}

module.exports = { enforceMarathonSolveSeat, claimRequestFinished };
