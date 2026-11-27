// ─── MISSING PRODUCTS → SOLVED — the history behind the Solved tab ───────────
// Junid, 20 Nov 2026: the growing Undo strip moves off the main list into a
// "Solved" tab — everything solved and everything marked Concrete, newest
// first, photo, where it went, who, when, with Undo per row.
//
// WHERE: /settings/missingProductsSolved/{key}. The key (newSolvedKey) starts
// with the server time, so it is chronological and the tab pages with
// orderByKey + limitToLast — no index, no whole-node read. /settings is already writable by every signed-in staff
// account on the live rules, so this works before any rule is pasted.
//
// WHAT A ROW HOLDS — exactly what Undo needs, nothing more:
//   kind "solve":    the solve's own undo record (solveUndo.js / NetworkTransfer):
//                    store, locs, paths (the EXACT cells it created), priorOpen
//                    (lock identities only), firstBatch { solveId, requestIds,
//                    store, units } — Undo reverses exactly these.
//   kind "concrete": the product was marked Concrete-only from Missing
//                    Products; Undo returns it to Marathon.
//   + pid, name, photo, msg ("where it went"), at (serverNowMs), by (uid),
//     byName, division, status "done" | "undone" (+ undoneAt, undoneBy).
//
// THE LOG IS WRITTEN AFTER THE ACTION COMMITS, never inside the same update:
// a refused log write (a rule pasted later, a dropped line) must never be able
// to fail a Solve. A row that could not be written is kept for this visit
// only (HealthView state) and the tab says so.
//
// REAL RTDB DROPS EMPTY ARRAYS AND NULLS — normalizeSolvedEntry restores them.
export const SOLVED_ROOT = "settings/missingProductsSolved";
export const SOLVED_PAGE = 25;

/** A chronological, collision-safe row key: zero-padded server ms + random. */
export function newSolvedKey(nowMs, rand = Math.random) {
  const tail = Array.from({ length: 6 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rand() * 36)]).join("");
  return `k${String(Math.max(0, Math.floor(nowMs))).padStart(14, "0")}${tail}`;
}

const str = (v, max = 300) => (typeof v === "string" ? v.slice(0, max) : v == null ? null : String(v).slice(0, max));
const arr = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []);

/** Lock identity only (solveUndo.lockId reads refillId, else runId|createdAt). */
export function slimPriorOpen(priorOpen) {
  const out = {};
  for (const [loc, bySize] of Object.entries(priorOpen || {})) {
    if (!bySize || typeof bySize !== "object") continue;
    const sizes = {};
    for (const [sz, lock] of Object.entries(bySize)) {
      if (!lock || typeof lock !== "object") continue;
      const id = {};
      for (const f of ["refillId", "runId", "createdAt", "orderId"]) if (lock[f] != null) id[f] = lock[f];
      if (Object.keys(id).length) sizes[sz] = id;
    }
    if (Object.keys(sizes).length) out[loc] = sizes;
  }
  return out;
}

function base({ pid, name, photo, at, by, byName, division }) {
  if (typeof pid !== "string" || !pid) throw new Error("solved log: pid is required");
  if (!(Number.isFinite(at) && at > 0)) throw new Error("solved log: `at` must be server epoch ms");
  return {
    pid, name: str(name, 200) || pid, ...(photo ? { photo: str(photo, 600) } : {}),
    at, by: by || "unknown", ...(byName ? { byName: str(byName, 80) } : {}),
    ...(division != null ? { division } : {}), status: "done",
  };
}

/** A Solve's row, from its undo record (`entry`) and its sentence (`msg`). */
export function buildSolveLogEntry(entry, { at, by, byName, photo, msg, division }) {
  const fb = entry.firstBatch;
  return {
    ...base({ pid: entry.pid, name: entry.name, photo, at, by, byName, division }),
    kind: "solve",
    store: entry.store, locs: arr(entry.locs), paths: arr(entry.paths),
    ...(entry.priorOpen ? { priorOpen: slimPriorOpen(entry.priorOpen) } : {}),
    ...(fb ? { firstBatch: { solveId: fb.solveId, requestIds: arr(fb.requestIds), store: fb.store, units: fb.units } } : {}),
    ...(msg ? { msg: str(msg, 600) } : {}),
  };
}

/** A Concrete mark's row. */
export function buildConcreteLogEntry({ pid, name, photo, at, by, byName, division }) {
  return {
    ...base({ pid, name, photo, at, by, byName, division }),
    kind: "concrete",
    msg: "Marked Concrete-only — now handled by the Concrete division and sold on the Concrete website only.",
  };
}

/** A row as read back: arrays restored (RTDB drops empty ones), key attached. */
export function normalizeSolvedEntry(key, raw) {
  if (!raw || typeof raw !== "object") return null;
  const e = { ...raw, key };
  e.locs = arr(raw.locs);
  e.paths = arr(raw.paths);
  if (raw.firstBatch) e.firstBatch = { ...raw.firstBatch, requestIds: arr(raw.firstBatch.requestIds) };
  e.priorOpen = raw.priorOpen || {};
  e.kind = raw.kind === "concrete" ? "concrete" : "solve";
  e.status = raw.status === "undone" ? "undone" : "done";
  return e;
}

/**
 * Newest first, de-duplicated by key (a session row never doubles a saved
 * one). A row Undone in EITHER copy stays Undone — another device may have
 * undone a saved solve this session still holds as done (CodeRabbit, PR #952).
 */
export function mergeSolved(saved, session) {
  const byKey = new Map();
  for (const e of [...(session || []), ...(saved || [])]) {
    if (!e) continue;
    const had = byKey.get(e.key);
    if (!had) { byKey.set(e.key, e); continue; }
    if (e.status === "undone" && had.status !== "undone") byKey.set(e.key, { ...had, status: "undone", undoneAt: e.undoneAt, undoneBy: e.undoneBy });
  }
  return [...byKey.values()].sort((a, b) => (b.at || 0) - (a.at || 0) || (a.key < b.key ? 1 : -1));
}

/** The update that marks a row undone. */
export function undoneUpdate(key, { at, by }) {
  return {
    [`${SOLVED_ROOT}/${key}/status`]: "undone",
    [`${SOLVED_ROOT}/${key}/undoneAt`]: at,
    [`${SOLVED_ROOT}/${key}/undoneBy`]: by || "unknown",
  };
}

/** Rows still standing — the siblings an undo must not take shared cells from. */
export const standing = (entries) => (entries || []).filter((e) => e && e.status !== "undone" && e.kind === "solve");

const KEY_RE = /^[-A-Za-z0-9_]{1,64}$/;
/**
 * Is this row safe to undo? null = yes, else the reason. A row read back from
 * the staff-writable history must only name THIS product's /stock cells at
 * locations the network knows, and plain request keys (Sonnet review, PR #952).
 */
export function undoRecordProblem(u, knownLocs) {
  if (!u || typeof u.pid !== "string" || !KEY_RE.test(u.pid)) return "no product id";
  const known = knownLocs instanceof Set ? knownLocs : new Set(knownLocs || []);
  const locs = arr(u.locs);
  if (locs.some((l) => typeof l !== "string" || !known.has(l))) return "an unknown location";
  const own = new Set(locs);
  for (const p of arr(u.paths)) {
    const m = /^stock\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(String(p));
    if (!m || m[2] !== u.pid || !own.has(m[1])) return "a cell that is not this product's";
  }
  if (u.firstBatch && arr(u.firstBatch.requestIds).some((id) => !KEY_RE.test(String(id)))) return "a malformed request id";
  return null;
}
