// ─── THE ROLLUP BUILDER'S DATABASE SURFACE ───────────────────────────────────
//
// Every read here is bounded, even though the Admin SDK bypasses the rules that
// would insist on it. The rules are not why the reads are bounded — the bill
// is. This project's largest line is database egress, and a server-side
// `once("value")` on /insights_log is the same 35.99 MB a browser's would be.
//
// Separated from builder.cjs so the sweep's logic can be tested against a fake
// that actually honours the constraints, without an emulator.

const { CURSOR_PATH, INDEX_PATH } = require("./builder.cjs");

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

    async readPageAfter(after, limit) {
      let q = log.orderByKey();
      if (after) q = q.startAfter(after);
      const snap = await q.limitToFirst(limit).once("value");
      const out = [];
      snap.forEach((child) => { out.push({ key: child.key, value: child.val() }); });
      return out;
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

    async commit({ updates }) {
      // ONE multi-path update: the day nodes and the cursor land together, so
      // the cursor can never be ahead of the days it justified.
      await db.ref().update(updates);
    },
  };
}

module.exports = { makeIo };
