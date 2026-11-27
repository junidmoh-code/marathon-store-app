// ─── FIX THE PAST: counts made while stock was still on the way ──────────────
//
//   node scripts/online/on-the-way-backfill.mjs [--since 2026-11-24T11:30:00.000Z] --until <rule live> [--commit]
//   node scripts/online/on-the-way-backfill.mjs --rollback <file> [--commit]
//
// Junid, 24 Nov 2026 evening (commit 2 of his brief; functions/lib/on-the-way.cjs
// has the rule). Every write-down or shelf-check count since 13:30 SAST on
// 24 Nov 2026 (when the write-down went live) that hit a shelf with units on
// the way at that moment is corrected to counted + on the way:
//
//   • a web_not_found write-down (a website rejection, or Not found on a shelf
//     check) of a shelf whose one piece was still travelling → the piece goes
//     back (+1), the write-down's self-reversing row is closed (so it can never
//     add it a second time);
//   • a shelf-check count ("shelf check: counted N, the app showed S") → the
//     units that were on the way are added back.
//
// SKIPPED, and listed: a shelf counted or written down again since (newer
// evidence), a write-down already undone (web_found), and one whose correction
// would be refused because the cell moved while this ran.
//
// Each correction is ONE `adjustment` movement of its own (id otw_fix_<movement>,
// so a repeat never adds twice) with the reason saying why, written through the
// server writer (functions/lib/admin-movement.cjs). DRY RUN unless --commit;
// with --commit the rollback file is written to ~/marathon-rollbacks BEFORE the
// first write. --rollback takes each correction back (an adjustment the other
// way, only while the shelf still holds at least what was added) and puts back
// each write-down row it closed.
//
// READS: the ledger by its `ts` index from four days before --since to now (the
// rows that decide what was on the way, and the corrections themselves), and one
// cell per corrected shelf. Never a whole node. The bytes downloaded are printed.
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createRequire } from "node:module";
import { fileURLToPath } from "url";
import { adminRequire } from "../adminRequire.mjs";

const require = createRequire(import.meta.url);
const O = require("../../functions/lib/on-the-way.cjs");
const { applyMovementAdmin } = require("../../functions/lib/admin-movement.cjs");
const DB_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const SINCE_DEFAULT = "2026-11-24T11:30:00.000Z"; // 13:30 SAST, 24 Nov 2026
const LOOKBACK_MS = 8 * 864e5; // the longest a piece can be on the way (six closed days in a row, then the cutoff)
const keyOf = (loc, pid, sizeKey) => `${loc}|${pid}|${sizeKey}`;
const tsOf = (m) => { const t = Date.parse((m && (m.ts || m.appliedAt)) || ""); return Number.isFinite(t) ? t : null; };
// A later movement of these kinds on the same shelf is a person (or the write-down) settling the count again.
const SETTLING = new Set(["adjustment", "web_not_found", "web_found", "refusal_writeoff"]);

/** Is this movement one of the counts to look at? → { loc, kind: "write_down" | "count", counted? } | null. PURE. */
export function countMovement(m) {
  if (!m || !m.productId) return null;
  // A write-down the on-the-way rule itself made already left what was on the way: never corrected again.
  if (m.type === "web_not_found" && m.from && !(m.web && m.web.onTheWay != null) && !/on the way/.test(String(m.reason || ""))) return { loc: m.from, kind: "write_down" };
  const r = String(m.reason || "");
  const hit = /^shelf check: counted (\d+)(?: \+ \d+ on the way = \d+)?, the app showed (\d+)$/.exec(r);
  if (m.type === "adjustment" && hit && !/on the way/.test(r)) return { loc: m.from || m.to, kind: "count", counted: Number(hit[1]), shown: Number(hit[2]) };
  return null;
}

/**
 * The corrections, from the ledger rows. PURE.
 *   ledger   { [movementId]: row }   from (since − lookback) to now
 * → { fixes: [{ mvId, loc, pid, sizeKey, size, kind, at, otw, delta, before, after }], skipped: [{ mvId, loc, pid, sizeKey, why }] }
 */
export function planFixes(ledger, sinceMs, cfg = O.configFrom(null), untilMs = Infinity) {
  const byShelf = new Map();
  for (const [id, m] of Object.entries(ledger || {})) {
    const sk = O.sizeKeyOf(m && m.size);
    for (const loc of [m && m.from, m && m.to]) {
      if (!loc || !m.productId) continue;
      const k = keyOf(loc, m.productId, sk);
      if (!byShelf.has(k)) byShelf.set(k, []);
      byShelf.get(k).push({ id, ...m });
    }
  }
  const fixes = [], skipped = [];
  for (const [mvId, m] of Object.entries(ledger || {})) {
    const c = countMovement(m);
    const at = tsOf(m);
    if (!c || at == null || at < sinceMs || at > untilMs) continue;
    const sizeKey = O.sizeKeyOf(m.size);
    const rows = byShelf.get(keyOf(c.loc, m.productId, sizeKey)) || [];
    const otw = O.onTheWayAt(rows.filter((r) => r.id !== mvId), at, cfg, c.loc);
    if (!(otw > 0)) continue;
    const base = { mvId, loc: c.loc, pid: m.productId, sizeKey, size: String(m.size), kind: c.kind, at, otw };
    const later = rows.filter((r) => r.id !== mvId && tsOf(r) != null && tsOf(r) > at && SETTLING.has(r.type));
    if (c.kind === "write_down" && later.some((r) => r.type === "web_found" && r.web && r.web.undoes === mvId)) { skipped.push({ ...base, why: "already put back (found)" }); continue; }
    if (later.length) { skipped.push({ ...base, why: `counted again since (${later[0].type} ${later[0].id})` }); continue; }
    const before = Number(m.before && m.before[c.loc]);
    const after = Number(m.after && m.after[c.loc]);
    // A write-down took ONE piece: under the rule it should not have been taken while that piece was still travelling.
    const delta = c.kind === "write_down" ? Math.min(otw, Number.isFinite(before) && Number.isFinite(after) ? before - after : 1) : otw;
    if (!(delta > 0)) continue;
    // The newest movement the ledger snapshot saw on this shelf: the correction is refused if anything landed since.
    const newest = rows.filter((r) => tsOf(r) != null).sort((a, b) => tsOf(a) - tsOf(b)).at(-1);
    fixes.push({ ...base, delta, before: Number.isFinite(before) ? before : null, after: Number.isFinite(after) ? after : null, counted: c.counted ?? null, expectMv: newest ? newest.id : mvId });
  }
  fixes.sort((a, b) => a.at - b.at);
  return { fixes, skipped };
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const COMMIT = argv.includes("--commit");
  const admin = adminRequire(import.meta.url)("firebase-admin");
  const app = admin.initializeApp({ databaseURL: DB_URL });
  const db = admin.database();
  const token = (await app.options.credential.getAccessToken()).access_token;
  let bytes = 0;
  const rest = async (path, query = "") => {
    const res = await fetch(`${DB_URL}/${path}.json${query ? `?${query}` : ""}`, { headers: { Authorization: `Bearer ${token}` } });
    const t = await res.text(); bytes += t.length;
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${t.slice(0, 200)}`);
    return JSON.parse(t);
  };
  const nowIso = new Date().toISOString();

  if (opt("--rollback")) {
    const file = opt("--rollback");
    const rb = JSON.parse(readFileSync(file, "utf8"));
    let undone = 0, refused = 0;
    for (const f of rb.fixes || []) {
      // Only a correction that was really written (a run that stopped half-way lists some that were not).
      if (!(await rest(`stock_movements/${f.fixId}`))) { console.log(`  · ${f.fixId}: never written — nothing to take back`); continue; }
      const cell = await rest(`stock/${f.loc}/${f.pid}/${f.sizeKey}`);
      const qty = Number(cell && cell.qty) || 0;
      if (qty < f.delta) { console.log(`  ✗ ${f.loc} ${f.pid} ${f.sizeKey}: holds ${qty}, less than the ${f.delta} added — left as it is`); refused += 1; continue; }
      console.log(`  ↺ ${f.loc} ${f.pid} ${f.sizeKey}: −${f.delta} (takes back ${f.fixId})`);
      if (!COMMIT) continue;
      const res = await applyMovementAdmin(db, { type: "adjustment", productId: f.pid, size: f.size, sizeKey: f.sizeKey, qty: f.delta, from: f.loc, expectQty: qty, movementId: `${f.fixId}_rollback`, actor: "system:on-the-way-backfill", actorRole: "admin", reason: `rollback of ${f.fixId} (on-the-way correction)`, link: {} }, { nowIso });
      if (!res.ok) { console.log(`    refused: ${res.reason}`); refused += 1; continue; }
      // The write-down's self-reversing row comes back, tied to the debit that now stands on the shelf.
      if (f.row) await db.ref(`online_writedowns/${f.pid}/${f.sizeKey}/${f.loc}`).transaction((cur) => (cur == null ? { ...f.row, mvId: `${f.fixId}_rollback` } : undefined));
      undone += 1;
    }
    console.log(`${COMMIT ? "" : "dry run: "}${undone} taken back, ${refused} left · downloaded ${(bytes / 1e6).toFixed(2)} MB`);
    process.exit(0);
  }

  const since = opt("--since") || SINCE_DEFAULT;
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) throw new Error(`--since ${since} is not a time`);
  // --until: when the on-the-way rule went live. Counts after it were already made under the rule. Required to write.
  const until = opt("--until");
  const untilMs = until ? Date.parse(until) : Infinity;
  if (until && !Number.isFinite(untilMs)) throw new Error(`--until ${until} is not a time`);
  if (COMMIT && !until) throw new Error("--commit needs --until <when the on-the-way rule went live>: counts after it are already right");
  const from = new Date(sinceMs - LOOKBACK_MS).toISOString();
  const ledger = (await rest("stock_movements", `orderBy=${encodeURIComponent('"ts"')}&startAt=${encodeURIComponent(`"${from}"`)}`)) || {};
  const cfg = O.configFrom(await rest(O.OTW_CONFIG_PATH));
  const { fixes, skipped } = planFixes(ledger, sinceMs, cfg, untilMs);
  console.log(`ledger rows read since ${from}: ${Object.keys(ledger).length}`);
  console.log(`counts since ${since} on a shelf with stock on the way: ${fixes.length + skipped.length} — to correct ${fixes.length}, skipped ${skipped.length}`);
  for (const f of fixes) console.log(`  + ${f.loc} ${f.pid} size ${f.size}: ${f.kind === "write_down" ? "written down" : `counted ${f.counted}`} at ${new Date(f.at).toISOString()} with ${f.otw} on the way → +${f.delta} (${f.mvId})`);
  for (const s of skipped) console.log(`  · ${s.loc} ${s.pid} size ${s.size}: skipped — ${s.why} (${s.mvId})`);
  if (!COMMIT) { console.log(`dry run: nothing written. Add --commit. · downloaded ${(bytes / 1e6).toFixed(2)} MB`); process.exit(0); }

  // The rollback file FIRST, with each write-down row that will be closed.
  for (const f of fixes) {
    f.fixId = `otw_fix_${f.mvId}`.replace(/[.#$/[\]\s]/g, "_");
    if (f.kind === "write_down") { const row = await rest(`online_writedowns/${f.pid}/${f.sizeKey}/${f.loc}`); if (row && row.mvId === f.mvId) f.row = row; }
  }
  const dir = join(homedir(), "marathon-rollbacks");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `on-the-way-fix-${nowIso.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ at: nowIso, since, fixes, skipped }, null, 2));
  console.log(`rollback file: ${file}`);
  let done = 0, refused = 0;
  for (const f of fixes) {
    const cell = await rest(`stock/${f.loc}/${f.pid}/${f.sizeKey}`);
    const qty = Number(cell && cell.qty) || 0;
    const res = await applyMovementAdmin(db, {
      type: "adjustment", productId: f.pid, size: f.size, sizeKey: f.sizeKey, qty: f.delta, to: f.loc, expectQty: qty, expectMv: f.expectMv,
      movementId: f.fixId, actor: "system:on-the-way-backfill", actorRole: "admin",
      reason: f.kind === "write_down"
        ? `on the way at the time: written down by ${f.mvId} while ${f.otw} piece(s) were still travelling — put back (Junid, 24 Nov 2026)`
        : `on the way at the time: counted ${f.counted} by ${f.mvId} without the ${f.otw} piece(s) still travelling — added back (Junid, 24 Nov 2026)`,
      link: {},
    }, { nowIso });
    if (!res.ok) { console.log(`  ✗ ${f.fixId}: ${res.reason}`); refused += 1; continue; }
    // The write-down's self-reversing row must not add the same piece a second time.
    if (f.row) await db.ref(`online_writedowns/${f.pid}/${f.sizeKey}/${f.loc}`).transaction((cur) => (cur && cur.mvId === f.mvId ? null : undefined));
    for (const dirty of ["shopify_inventory_dirty", "shopify_inventory_dirty_concrete"]) { try { await db.ref(`${dirty}/${f.pid}`).set(admin.database.ServerValue.increment(1)); } catch { /* the nightly sweep corrects it */ } }
    done += 1;
  }
  console.log(`corrected ${done}, refused ${refused} · downloaded ${(bytes / 1e6).toFixed(2)} MB`);
  console.log(`restore: node scripts/online/on-the-way-backfill.mjs --rollback ${file} --commit`);
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e?.message || e); process.exit(1); });
