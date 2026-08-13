// ─── SOLVE UNDO (pure core, no firebase imports) ──────────────────────────────
// A Solve seeds qty-0 cells; this module decides when that seed can be safely
// taken back, and builds the exact deletion. Born from a real incident
// (2026-08-13): a Louis Vuitton bag solved to Marathon PE by mistake, reversed
// by hand with precisely these guards — this makes that reversal a button.
//
// THE RULE: an undo deletes ONLY the cells the solve itself wrote, and ONLY
// while every one of them is still the untouched seed — qty 0, version 0,
// movement marker "seed". The moment anything real lands on a cell (a count,
// a transfer, a sale), undo refuses: deleting a cell that holds history is an
// adjustment, not an undo, and belongs to the counting tools.
//
// THE ENGINE GUARD: an intent the engine raised AFTER the solve exists only
// because of the seed — deleting the cells under it would orphan open work in
// the queues, so undo refuses and points at the queue instead. An intent that
// PREDATES the solve existed without the cell (an explicit target row can arm
// one; the LV bag had exactly this) — deleting the seed merely restores the
// state that intent already lived in, so it does not block.
//
// Undo state is SESSION-LOCAL by design: the strip lists the solves made on
// this screen since it opened. A durable any-time undo would need either a
// log node or a whole-tree scan for seed cells — the first is more moving
// parts than the mistake it serves, the second is a bandwidth cost this
// project has banned. Older mistakes remain a guarded admin reversal.

// Is this cell still exactly what a Solve wrote and nothing more?
export function seedCellUntouched(cell) {
  return !!cell &&
    (Number(cell.qty) || 0) === 0 &&
    (Number(cell.v) || 0) === 0 &&
    cell.mv === "seed";
}

// Every reason this undo must refuse, as operator-readable sentences.
//   cellsByPath — { path: cell|null } as re-read at undo time
//   openByLoc   — { loc: openIndexNode|null } for each seeded location
//   solvedAtMs  — when the solve landed (serverNowMs at solve time)
export function solveUndoBlockers({ cellsByPath = {}, openByLoc = {}, solvedAtMs = 0 } = {}) {
  const blockers = [];
  for (const [path, cell] of Object.entries(cellsByPath)) {
    if (!cell) blockers.push(`${path} is already gone — nothing to undo.`);
    else if (!seedCellUntouched(cell)) blockers.push(`${path} has been touched since the solve (stock or a count landed) — undo would erase history. Use Adjust instead.`);
  }
  for (const [loc, node] of Object.entries(openByLoc)) {
    for (const e of Object.values(node || {})) {
      const created = Date.parse(e?.createdAt || "");
      if (Number.isFinite(created) && created > solvedAtMs) {
        blockers.push(`The engine has already raised a refill for ${loc}${e?.orderId ? ` (${e.orderId})` : ""} — reject it in the queue first, then undo.`);
      }
    }
  }
  return blockers;
}

// The deletion itself: null at exactly the recorded paths, nothing else.
export function undoUpdate(paths) {
  const updates = {};
  for (const p of paths || []) {
    if (p) updates[p] = null;
  }
  return updates;
}
