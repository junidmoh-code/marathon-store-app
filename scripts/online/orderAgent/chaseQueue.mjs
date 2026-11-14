// ── The order agent's hand-off to Jamie: rows in Jamie's own SQLite (~/marathon-dm-agent/data/agent.db) ──
// The contract (marathon-dm-agent src/jimmy/chaseRequests.js is the consumer): one row per ask, its id
// `${kind}:${orderKey}:${lineIndex ?? "-"}:${sastDay}` makes each kind once per order line per SAST day (INSERT OR
// IGNORE). The agent only ever INSERTS; Jamie alone moves state / tries / next_at / done_at / result.
export const CHASE_TABLE = "jamie_chase_requests";
export const CHASE_DDL = `CREATE TABLE IF NOT EXISTS ${CHASE_TABLE} (id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, order_key TEXT NOT NULL, order_number TEXT, line_index INTEGER, reason TEXT, evidence TEXT, state TEXT NOT NULL DEFAULT 'open', tries INTEGER NOT NULL DEFAULT 0, next_at INTEGER, done_at INTEGER, result TEXT)`;
export const CHASE_KINDS = Object.freeze(["follow_up", "no_answer_24h", "payment_link", "alternatives_now", "junid_escalation", "daily_summary"]);

/** A queue over an open node:sqlite DatabaseSync (injected so tests use :memory:). */
export function chaseQueueOver(sqlite) {
  sqlite.exec("PRAGMA busy_timeout = 5000");
  sqlite.exec(CHASE_DDL);
  const ins = sqlite.prepare(`INSERT OR IGNORE INTO ${CHASE_TABLE} (id, at, kind, order_key, order_number, line_index, reason, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  return {
    /** → true when the row is new (false: already asked today). */
    insert(row) {
      if (!CHASE_KINDS.includes(row.kind)) throw new Error(`unknown chase kind ${row.kind}`);
      const r = ins.run(String(row.id), Number(row.at), row.kind, String(row.order_key), row.order_number == null ? null : String(row.order_number), row.line_index == null ? null : Number(row.line_index), row.reason ?? null, row.evidence ?? null);
      return Number(r.changes) > 0;
    },
    /** Today's rows by state, e.g. { done: 4, open: 1 } (ids end with the SAST day). */
    todayCounts(day) {
      const out = {};
      for (const r of sqlite.prepare(`SELECT state, COUNT(*) AS n FROM ${CHASE_TABLE} WHERE id LIKE ? GROUP BY state`).all(`%:${day}`)) out[r.state] = Number(r.n);
      return out;
    },
    close() { try { sqlite.close(); } catch { /* already closed */ } },
  };
}

export async function openChaseQueue(path) {
  const { DatabaseSync } = await import("node:sqlite");
  return chaseQueueOver(new DatabaseSync(path));
}
