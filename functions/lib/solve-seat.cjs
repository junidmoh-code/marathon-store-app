// ─── HUB 1 / HUB 2 NEVER SHARE A SNEAKER — the server's refusal ──────────────
// Called by refillRequestSourceGuard for every new sneaker Solve line at Hub 1
// or Hub 2. A line that would seat the product at one hub while the other has it
// seated is cancelled (cancelReason seated_at_other_marathon_hub) and logged for
// Junid. Keyed reads only: the other hub's cell node, its target rows, one claim.
"use strict";

const { marathonHubSeated } = require("./concrete-division.cjs");
const rs = require("./request-source.cjs");

const val = async (db, path) => (await db.ref(path).once("value")).val();

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
        if ((await val(db, `refill_requests/${r}/status`)) !== "open") staleIds.push(r);
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
  await db.ref(`${rs.REJECTED_LOG}/${id}`).set(rs.rejectionRecord(id, after || seen || rr, { nowIso, cancelled, reason: rs.SEAT_REJECT_REASON }));
  return { checked: true, refused: true, cancelled };
}

module.exports = { enforceMarathonSolveSeat };
