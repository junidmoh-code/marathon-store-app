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
    // SCOPE NOTE: the transaction is applied to /insights_rollup/meta, which
    // also holds the day index. That is fine today — the whole node is about
    // 9 KB and a transaction re-reads and retries on conflict, so a concurrent
    // index write is not clobbered — but it is the reason not to put anything
    // LARGE under meta. A big node here would make every sweep read and
    // rewrite it four times a day.
    // `replace: true` SETS the counter instead of adding to it. That is for a
    // full recount — a pass that has walked the whole log from nothing and
    // therefore knows the answer, rather than a delta to fold in. It still
    // goes through the same compare-and-set, so a recount that raced a sweep
    // is refused rather than silently overwriting its work.
    async advanceCursor({ expect, cursor, seen, at, replace = false }) {
      const ref = db.ref(`${ROLLUP_ROOT}/meta`);

      // ── THE NULL-FIRST TRAP ───────────────────────────────────────────────
      //
      // RTDB runs a transaction's update function against whatever the client
      // has CACHED, which for a node it has never read whole is `null`, and
      // only then retries against the server. A callback that aborts on
      // "the cursor is not what I expected" therefore aborts on that first
      // null — before any round trip — and the transaction reports
      // committed: false for ever. Nothing else in the sweep reads this node
      // whole (readCursor and listDayKeys read children), so the cache is
      // always cold and the advance would NEVER have happened: the cursor
      // would have stayed at wherever the backfill left it, every run would
      // re-walk a growing backlog, and the counter would never move.
      //
      // once("value") is NOT enough, which was the second thing this taught:
      // it fetches, but it keeps nothing, so the cache is cold again by the
      // time the transaction starts. Measured against production — the run
      // still reported "saw a null after priming".
      //
      // What does work is holding a LISTENER open across the transaction. With
      // an active on("value") the SDK keeps the node's server value, and the
      // update function is called with it rather than with null. The listener
      // is detached in a finally, so a throw cannot leak it.
      // (This project has met the null-first trap before —
      // reference-attribute-extraction-traps.)
      const noop = () => {};
      ref.on("value", noop);
      try {
        await ref.once("value");
        return await runAdvance();
      } finally {
        ref.off("value", noop);
      }

      // eslint-disable-next-line no-unreachable
      async function runAdvance() {
      let sawNullFirst = false;
      const resP = ref.transaction((meta) => {
        // A null here AFTER priming means one of two things: the node really
        // is empty, or this is the cache talking anyway. If we expected a
        // cursor, it cannot be the former — so abort rather than write a
        // counter on top of nothing, and say that is what happened.
        if (meta === null && (expect ?? null) !== null) { sawNullFirst = true; return undefined; }
        const cur = meta || {};
        const have = cur.cursor ?? null;
        if (have !== (expect ?? null)) return undefined;             // somebody else moved it
        const base = replace ? {} : (cur.logTotals || {});
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
      const res = await resP;
      if (!res.committed && sawNullFirst) {
        console.warn("insightsRollup: cursor advance saw a null /insights_rollup/meta even with a listener open — not advancing");
      }
      return !!res.committed;
      }
    },

    async commit({ updates }) {
      // ONE multi-path update for everything that is a RECOMPUTATION: the day
      // nodes, the day index, the late bucket, the run record. All idempotent,
      // so a repeat writes the same bytes.
      //
      // The cursor is NOT here. It moves with the running counter, which is a
      // fold and has to be applied exactly once — see advanceCursor — and it
      // moves AFTER this lands, so it can only ever be behind the aggregates
      // it justified, never ahead of them.
      await db.ref().update(updates);
    },
  };
}

module.exports = { makeIo };
