// ─── THE ROLLUP BUILDER'S DATABASE SURFACE ───────────────────────────────────
//
// Every read here is bounded, even though the Admin SDK bypasses the rules that
// would insist on it. The rules are not why the reads are bounded — the bill
// is. This project's largest line is database egress, and a server-side
// `once("value")` on /insights_log is the same 35.99 MB a browser's would be.
//
// Separated from builder.cjs so the sweep's logic can be tested against a fake
// that actually honours the constraints, without an emulator.

const { CURSOR_PATH, INDEX_PATH, LOG_TOTALS_PATH, ROLLUP_ROOT } = require("./builder.cjs");

/**
 * @param {import("firebase-admin").database.Database} db
 */
function makeIo(db) {
  const log = db.ref("insights_log");
  return {
    async readCursor() {
      const snap = await db.ref(CURSOR_PATH).once("value");
      const v = snap.val();
      return typeof v === "string" && v ? v : null;
    },

    async readKeyRange(startKey, endKey) {
      const snap = await log.orderByKey().startAt(startKey).endAt(endKey).once("value");
      const out = [];
      // forEach, never Object.entries(snap.val()): a query result loses its
      // ordering through val(), and RTDB array-coerces integer-looking keys.
      snap.forEach((child) => { out.push({ key: child.key, value: child.val() }); });
      return out;
    },

    // ── startAt, NOT startAfter ────────────────────────────────────────────
    // `startAfter(cursor) + limitToFirst(n)` returns n-1 children: the server
    // applies the limit counting the cursor's own row, then the SDK drops that
    // row. Measured against production on 2026-09-20. A walk that ends on "the
    // page came back short" therefore ends on its SECOND request — which is
    // exactly what this backfill's first run did, stopping at 9,999 rows of
    // 112,968 and reporting success. The same defect in the client's pager was
    // shipped and fixed separately (#626).
    //
    // So the bound is inclusive and the caller is told how many children the
    // SERVER sent, separately from how many were new.
    async readPageAfter(after, limit) {
      let q = log.orderByKey();
      if (after) q = q.startAt(after);
      const snap = await q.limitToFirst(limit).once("value");
      const out = [];
      snap.forEach((child) => {
        if (after && child.key === after) return;   // the bound's own row
        out.push({ key: child.key, value: child.val() });
      });
      out.sent = 0;
      snap.forEach(() => { out.sent += 1; });
      return out;
    },

    async readLogTotals() {
      const snap = await db.ref(LOG_TOTALS_PATH).once("value");
      return snap.val();
    },

    async listDayKeys() {
      // The INDEX, not the nodes. The Admin SDK has no shallow read, so asking
      // /insights_rollup/days which children it has would download every day
      // node — the whole rollup, once a run, to answer a question about its
      // index. /meta/built is a few hundred short keys.
      const snap = await db.ref(INDEX_PATH).once("value");
      const v = snap.val();
      return v ? Object.keys(v) : [];
    },

    // ── COMPARE-AND-SET, because the counter is a FOLD ─────────────────────
    // Everything else the sweep writes is a recomputation and can be redone.
    // The running counter cannot: two runs that both read cursor C0 and both
    // add their own walk would count the overlap twice, and a late commit from
    // a shorter walk would drag the cursor backwards so the next run re-walks
    // and re-adds. A transaction that refuses unless the cursor is still where
    // the run found it makes the fold exactly-once.
    async advanceCursor({ expect, cursor, seen, at }) {
      const ref = db.ref(`${ROLLUP_ROOT}/meta`);
      const res = await ref.transaction((meta) => {
        const cur = meta || {};
        const have = cur.cursor ?? null;
        if ((have ?? null) !== (expect ?? null)) return undefined;   // abort
        const base = cur.logTotals || {};
        return {
          ...cur,
          cursor: cursor ?? null,
          logTotals: {
            n: (Number(base.n) || 0) + (seen.n || 0),
            pe: (Number(base.pe) || 0) + (seen.pe || 0),
            trophy: (Number(base.trophy) || 0) + (seen.trophy || 0),
            pine: (Number(base.pine) || 0) + (seen.pine || 0),
            other: (Number(base.other) || 0) + (seen.other || 0),
            cursor: cursor ?? null,
            at,
          },
        };
      });
      return !!res.committed;
    },

    async commit({ updates }) {
      // ONE multi-path update: the day nodes and the cursor land together, so
      // the cursor can never be ahead of the days it justified.
      await db.ref().update(updates);
    },
  };
}

module.exports = { makeIo };
