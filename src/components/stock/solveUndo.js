// ─── SOLVE UNDO (pure core, no firebase imports) ──────────────────────────────
// A Solve seeds qty-0 cells; this module decides when that seed can be safely
// taken back, and how. Born from a real incident (2026-08-13): a Louis
// Vuitton bag solved to Marathon PE by mistake, reversed by hand with
// precisely these guards — this makes that reversal a button.
//
// THE RULE: an undo deletes ONLY the cells the solve itself wrote, and ONLY
// while each is still the untouched seed. The check is NOT a read-then-write:
// the caller deletes through a per-cell TRANSACTION whose decision function
// is undoCellTxn below, so a count, sale or transfer landing between any
// pre-check and the delete makes that cell's transaction abort rather than
// erase history (Kimi + Sonnet substitute pair, PR #361 — the TOCTOU HIGH).
//
// THE ENGINE GUARD carries no clocks. An intent's createdAt is the SCAN'S
// start time, not the claim time, so "was it created after the solve" is
// unanswerable by timestamp for a scan that spans the solve (same review,
// the second HIGH). Instead the solve records the open locks that existed
// the moment it ran (priorOpen), and undo blocks on any CURRENT lock on a
// SEEDED size that was not in that snapshot — "was this lock there when I
// solved" is directly knowable, no clock needed. A lock that predates the
// solve does not block: it existed without the cell (the live LV bag carried
// exactly this — a 16:45 target-row intent under a 17:20 mistaken solve),
// and deleting the seed restores the state it already lived in. Locks on
// sizes the solve did NOT seed never block: undo does not touch their cells.
//
// Undo state is SESSION-SCOPED by design (held in HealthView, so it survives
// chip-hopping to Sneakers/Hidden — but not leaving Inventory Health). A
// durable any-time undo needs a log node or a whole-tree seed scan; the
// first is more moving parts than the mistake it serves, the second is a
// banned bandwidth cost. Older mistakes remain a guarded admin reversal.
//
// KNOWN, ACCEPTED GAPS (documented, not silent): the engine can claim a lock
// between the guard read and the cell transactions — a window of seconds
// against a 15-minute scan cadence (07:00–19:00 SAST only); closing it fully
// needs a server-side conditional (a functions change, out of scope by owner
// constraint). And a write racing the SOLVE's own seed-if-absent update can
// be overwritten by the seed itself — pre-existing solve behaviour, whose
// all-or-nothing multi-path write was itself a reviewed decision (PR #305).

// Is this cell still exactly what a Solve wrote and nothing more? qty/v/mv
// are the load-bearing triple (every real writer bumps v and replaces mv —
// verified against applyMovement); lastType pins the shape fully.
export function seedCellUntouched(cell) {
  return !!cell &&
    (Number(cell.qty) || 0) === 0 &&
    (Number(cell.v) || 0) === 0 &&
    cell.mv === "seed" &&
    cell.lastType === "count";
}

// The transaction decision for one seeded cell. Returning:
//   null      → commit a delete (cell is absent, or still the untouched seed)
//   undefined → ABORT — the cell has taken real history; keep it.
// The null-input branch commits a no-op delete rather than aborting: RTDB
// runs the function against the local cache first (often null); committing
// null-onto-null forces the server round-trip and a re-run against the real
// value, instead of aborting before the truth arrives.
export function undoCellTxn(cell) {
  if (cell === null || cell === undefined) return null;
  return seedCellUntouched(cell) ? null : undefined;
}

// stock/{loc}/{pid}/{sizeKey} → its parts (the undoable records whole paths).
export const pathLoc = (path) => String(path || "").split("/")[1] || "";
export const pathSizeKey = (path) => String(path || "").split("/")[3] || "";

// The seeded size keys per location, derived from the recorded paths.
export function seededSizesByLoc(paths) {
  const out = {};
  for (const p of paths || []) {
    const loc = pathLoc(p), sz = pathSizeKey(p);
    if (!loc || !sz) continue;
    (out[loc] = out[loc] || new Set()).add(sz);
  }
  return out;
}

// A lock's identity for snapshot comparison — refillId when present, else
// the (runId, createdAt) pair. Two reads of the SAME lock compare equal;
// a fresh claim never does.
const lockId = (e) => e?.refillId || `${e?.runId || ""}|${e?.createdAt || ""}`;

// Every reason this undo must refuse outright, as operator-readable
// sentences. Empty means: proceed to the per-cell transactions.
//   paths         — the recorded seeded cell paths
//   openByLoc     — { loc: openIndexNode|null } read at UNDO time
//   priorOpenByLoc— { loc: openIndexNode|null } recorded at SOLVE time
export function solveUndoBlockers({ paths = [], openByLoc = {}, priorOpenByLoc = {} } = {}) {
  const blockers = [];
  const seeded = seededSizesByLoc(paths);
  for (const [loc, sizes] of Object.entries(seeded)) {
    for (const sz of sizes) {
      const cur = openByLoc?.[loc]?.[sz];
      if (!cur) continue;
      const prior = priorOpenByLoc?.[loc]?.[sz];
      if (prior && lockId(prior) === lockId(cur)) continue;   // predates the solve
      blockers.push(`The engine has already raised a refill for ${loc}${cur?.orderId ? ` (${cur.orderId})` : ""} — reject it in the queue first, then undo.`);
    }
  }
  return blockers;
}
