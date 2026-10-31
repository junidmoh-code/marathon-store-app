// ─── Layby pull ↔ parcel status audit (pure) ─────────────────────────────────
// Finds layby requests that are SENT on one node and still OPEN on another:
//
//   /laybyPulls/{pullId}.status   pending | sentToStore | rejected | returnedToStock
//   /laybys/{laybyId}.status      … pullRequested → sentToStore …
//
// The warehouse Sent writes both in ONE multi-path update (markPullSent), so a
// disagreement can only come from something outside that write. Every layby is
// judged by its LATEST pull (by requestedAt, the POS server timestamp).
//
// Classes:
//   fix             — latest pull is a collect pull marked sentToStore, the
//                     parcel still reads pullRequested, and nothing happened to
//                     the parcel after the send (no receivedAt after sentAt).
//                     The ONLY class the runner writes: parcel → sentToStore,
//                     sentToStoreAt = the pull's sentAt when absent.
//   ambiguous       — sent on one node, open on the other, but some later
//                     event (a scan-in after the send, a newer pending pull…)
//                     means the right answer is not knowable from the data.
//                     Reported with the reason, never written.
//   pendingVsSent   — the reverse: the pull is still pending while the parcel
//                     already reads sentToStore. Reported, never written (a
//                     pending pull is a live request — closing it is a person's
//                     call).
//
// Pure: no Firebase import. The runner (scripts/layby/pull-status-audit.mjs)
// reads, calls this, and writes only `fix` rows.

const OPEN_PARCEL = new Set(["pullRequested", "storedAtHub"]);

const ms = (v) => {
  if (typeof v === "number") return v;
  const t = Date.parse(v ?? "");
  return Number.isNaN(t) ? NaN : t;
};

export function latestPullByLayby(pulls) {
  const out = new Map();
  for (const [key, p] of Object.entries(pulls || {})) {
    if (!p || typeof p !== "object" || !p.laybyId) continue;
    const cur = out.get(p.laybyId);
    const t = ms(p.requestedAt);
    if (!cur || (Number.isFinite(t) && !(ms(cur.requestedAt) >= t))) out.set(p.laybyId, { ...p, pullId: p.pullId || key });
  }
  return out;
}

export function auditPullStatus(pulls, laybys) {
  const fix = [], ambiguous = [], pendingVsSent = [];
  let agree = 0;
  for (const [laybyId, pull] of latestPullByLayby(pulls)) {
    const parcel = laybys?.[laybyId];
    if (!parcel) continue;
    const ps = pull.status || "pending";
    const ls = parcel.status;
    const row = { laybyId, pullId: pull.pullId, invoiceNo: pull.invoiceNo || parcel.invoiceNo || null, storageHub: pull.storageHub || parcel.storageHub || null, pullStatus: ps, parcelStatus: ls };
    if (ps === "sentToStore" && OPEN_PARCEL.has(ls)) {
      const sentAt = ms(pull.sentAt);
      const receivedAfter = Number.isFinite(sentAt) && ms(parcel.receivedAt) > sentAt;
      const collect = (pull.disposition || "collect") === "collect";
      if (ls === "pullRequested" && collect && !receivedAfter && Number.isFinite(sentAt)) {
        fix.push({ ...row, sentAt: pull.sentAt, hasSentToStoreAt: !!parcel.sentToStoreAt });
      } else {
        ambiguous.push({ ...row, reason: receivedAfter ? "scanned in after the send" : !collect ? "return-to-stock pull" : !Number.isFinite(sentAt) ? "no sentAt on the pull" : `parcel reads ${ls}` });
      }
    } else if (ps === "pending" && ls === "sentToStore") {
      pendingVsSent.push(row);
    } else {
      agree += 1;
    }
  }
  return { fix, ambiguous, pendingVsSent, agree };
}

// The exact patch for one `fix` row — the parcel's status and, when it has
// none, its sentToStoreAt. Both are rules-legal on /laybys/{id}: status is in
// the allowed set and sentToStoreAt is an unvalidated $other child.
export function fixPatch(row) {
  const p = { status: "sentToStore" };
  if (!row.hasSentToStoreAt) p.sentToStoreAt = row.sentAt;
  return p;
}
