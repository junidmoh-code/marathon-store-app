// ─── CARRIAGE — UNSEAT / RESEAT (pure core, no firebase imports) ──────────────
// CARRIAGE is "this location carries this product", and in this database it is
// spelled exactly one way: a /stock/{loc}/{pid}/{size} node EXISTS. Not the qty
// — the NODE. functions/lib/refill-engine.cjs says so in one line:
//
//     function storeCarries(stock, loc, pid) {
//       return !!stock?.[loc]?.[pid] && Object.keys(stock[loc][pid]).length > 0;
//     }
//
// and nothing anywhere ever deletes a cell (applyMovement writes qty, never
// removes). So carriage is CREATE-ONLY today: every route that has ever touched
// a location — a Solve seed, a counted zero, a transfer that later drained, a
// receive typed into the wrong picker — leaves a permanent claim that the
// location stocks the product. That claim then feeds managedPids(), so the
// engine keeps refilling a shop the stock was never meant to sit in, and no
// Stock screen shows it: Counted hides a group with no non-zero size, and
// Locator drops a location whose sizes all read 0. Carriage was writable and
// invisible at the same time.
//
// This module is the ERASER the write side never had. It decides, purely:
//   • which product×location groups are CARRIED-ONLY (a claim with no stock),
//   • whether a given group may be unseated, and what would be deleted,
//   • the per-cell transaction decision that makes the delete safe under a
//     racing sale/count,
//   • what a MOVE of the carriage (not just the quantity) has to write.
//
// WHY DELETE AND NOT A FLAG. A cell is a re-derivable cache of the ledger
// (SCHEMA.md), and a carriage-only cell has NO ledger rows behind it — a Solve
// seed is a direct write with mv:"seed", never a movement. Deleting it removes
// something the ledger cannot reconstruct anyway, and it is the only edit
// storeCarries() can actually see: a `carried:false` field would need a
// functions deploy to be honoured, and until that deploy landed the engine
// would go on refilling a shop the UI now showed as unseated. Delete is the
// change that is true the moment it is written.
//
// WHY NO RULES DEPLOY. /stock/$loc/$pid/$size `.write` is "signed in and has a
// stockRole"; `.validate` is not evaluated for a delete (newData is null), so
// the shape rules never see it. This is the same door solveUndo already deletes
// through in production (PR #361) — no new grant, no wider one.

import { stockSizeKey } from "../../utils/sizeKey";

// The audit node. /settings is app-owned feature state with a live rule that
// already grants read to any authed user and write to non-anonymous ones (the
// same node missingProductsHidden, stockHold and displaySlots live under), so
// this ships without a rules change. It exists because a delete leaves NO
// ledger row — unseating is the one stock-shaped action /stock_movements can
// never record, and an un-audited invisible delete is how this mess started.
export const CARRIAGE_LOG = "settings/carriageLog";

// ── CLASSIFICATION ───────────────────────────────────────────────────────────
// `sizes` is the [{ size, qty }] shape the Counted tab already builds. A group
// is CARRIED-ONLY when every cell it holds reads 0 — the claim with nothing
// behind it. A negative cell is NOT carried-only: it is a real (broken) balance
// and must be corrected, never silently erased.
export function isCarriedOnly(sizes) {
  const cells = (sizes || []).filter((s) => s && s.hasCell);
  return cells.length > 0 && cells.every((s) => Number(s.qty || 0) === 0);
}

// Every size that has an actual cell — the only ones an unseat can delete. The
// Counted tab pads its grid with the product's catalogue sizes at qty 0 so a
// never-counted size is tappable; those pads have no node and must not be
// mistaken for carriage.
export const cellSizes = (sizes) => (sizes || []).filter((s) => s && s.hasCell);

// ── UNSEAT PLAN ──────────────────────────────────────────────────────────────
// What unseating this group would delete, and every reason it must refuse.
// Blockers are operator-readable sentences, not codes — the panel prints them.
//
// THE ONE HARD REFUSAL is a non-zero cell. Unseat removes a CLAIM; it must
// never remove a QUANTITY, because a quantity is ledger history and deleting
// its cell would silently unbalance the network total with no movement to
// explain it. A group holding stock is told to Move or Clear first — both of
// which are movements, both of which are reversible.
export function unseatPlan({ loc, pid, name, sizes, openLocks } = {}) {
  const blockers = [];
  const cells = cellSizes(sizes);
  const label = name || pid;

  if (!loc || !pid) blockers.push("Missing location or product — nothing to unseat.");
  if (!cells.length) blockers.push(`${label} is not carried at this location — there is nothing to unseat.`);

  const held = cells.filter((s) => Number(s.qty || 0) !== 0);
  if (held.length) {
    const detail = held.map((s) => `${s.size}: ${s.qty}`).join(", ");
    blockers.push(
      `${label} still holds stock here (${detail}). Move it to the location that really has it, or Clear it to 0 — then unseat.`
    );
  }

  // The engine may already have an open refill lock against a size we would
  // delete. Deleting the cell under a live intent orphans the lock (the engine
  // would keep a claim on a cell that no longer exists), so the operator has to
  // reject the request first — the same ordering solveUndoBlockers enforces.
  for (const s of cells) {
    const lock = openLocks?.[stockSizeKey(s.size)];
    if (!lock) continue;
    blockers.push(
      `The engine has an open refill for ${label} · ${s.size} here${lock.orderId ? ` (${lock.orderId})` : ""} — reject it in the queue first, then unseat.`
    );
  }

  // `expect` is the optimistic guard: the (qty, v, mv) triple as READ when the
  // operator was shown the row. The transaction below commits only if the cell
  // still matches, so anything landing in between aborts that cell instead of
  // erasing it. Recorded per PATH, so a delete can never reach a cell the plan
  // did not name.
  const paths = cells.map((s) => ({
    path: `stock/${loc}/${pid}/${stockSizeKey(s.size)}`,
    size: s.size,
    expect: { qty: Number(s.qty || 0), v: Number(s.v || 0), mv: s.mv ?? null },
  }));

  return { loc, pid, name: label, paths, blockers, ok: blockers.length === 0 && paths.length > 0 };
}

// ── THE PER-CELL TRANSACTION DECISION ────────────────────────────────────────
// Returning null → commit the delete; undefined → ABORT, keep the cell.
//
// Deliberately NOT a read-then-write. A sale, count or transfer landing between
// the plan and the delete would otherwise erase a cell that had just taken real
// history — the TOCTOU that solveUndo was fixed for (PR #361), reproduced here
// because this delete is strictly wider than that one (it takes cells that a
// Solve did not write).
//
// The null-input branch commits a no-op delete rather than aborting, for the
// reason undoCellTxn documents: RTDB runs the decision against the local cache
// first, which is often null, and aborting there would give up before the real
// value ever arrived.
// `expect.v` / `expect.mv` are OPTIONAL, and their absence means "don't compare
// this one" — not "compare against 0". A null v is exactly what a caller has
// when it could not read the cell (moveCarriage's post-transfer re-read finding
// nothing there), and treating that as `v === 0` would abort every cell a
// transfer had legitimately bumped. Absent both, qty 0 is the whole guard, which
// is still the guarantee that matters: an unseat never removes stock.
export function unseatCellTxn(expect) {
  return (cell) => {
    if (cell === null || cell === undefined) return null;
    if (Number(cell.qty || 0) !== 0) return undefined;                     // took stock — keep it
    if (expect?.v != null && Number(cell.v || 0) !== Number(expect.v)) return undefined;   // moved since we looked
    if (expect?.mv !== undefined && expect?.mv !== null && (cell.mv ?? null) !== expect.mv) return undefined;  // another writer
    return null;
  };
}

// ── SEED (the reseat half) ───────────────────────────────────────────────────
// The qty-0 carriage cell, byte-identical to what NetworkTransfer's Solve and
// applyMovement's setCellState write — because the SEED branch of the /stock
// validate rule accepts exactly this shape and nothing else:
//   !data.exists() && qty === 0 && v === 0 && lastType === 'count' && mv === 'seed'
// Any drift here is a rejected write, so the shape is defined once and both
// halves of a move share it.
export function seedCell({ uid = null, now } = {}) {
  return { qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: now, updatedBy: uid };
}

// ── MOVE PLAN ────────────────────────────────────────────────────────────────
// "Move the seating from Marathon to Trophy" — one gesture, up to three parts:
//
//   1. TRANSFERS: the quantities that go with it. `amounts` (per raw size) lets
//      an operator move some units by hand; absent, EVERY positive size moves
//      in full. A transfer is a real ledger movement — this plan only decides
//      the lines, applyMovement still performs them.
//   2. SEED: destination cells for sizes carrying nothing. Without this, a
//      carried-only product would move nothing at all (there is no quantity to
//      transfer) and the destination would never start carrying it — the exact
//      dead end the current Move hits, where it reports "no positive counted
//      stock" and stops.
//   3. UNSEAT: the source cells, deleted, once they are provably at 0.
//
// PART 3 IS WHAT MAKES IT A MOVE. Today's Move transfers the units and leaves
// the source cell sitting at 0 — so the stock is at Trophy and Marathon still
// carries it, still gets refilled, still shows in the engine's managed set. The
// units moved and the claim did not. That is not a relocation; it is a copy.
//
// Ordering is fixed and load-bearing: transfer, then seed, then unseat. Unseat
// last means a failed transfer leaves the claim exactly where the stock still
// is, and the operator retries against an unchanged picture.
export function movePlan({ loc, pid, name, sizes, to, amounts, moveSeating = true } = {}) {
  const blockers = [];
  const label = name || pid;
  if (!to) blockers.push("Pick a destination.");
  if (to && to === loc) blockers.push("Source and destination are the same location.");

  const cells = cellSizes(sizes);
  if (!cells.length) blockers.push(`${label} is not carried at this location.`);

  const transfers = [];
  for (const s of cells) {
    const have = Number(s.qty || 0);
    if (have <= 0) continue;
    // An explicit amount wins; absent (or not a number) means "all of it".
    const raw = amounts?.[String(s.size)];
    const want = raw === undefined || raw === null || raw === "" ? have : Number(raw);
    if (!Number.isFinite(want) || want < 0 || !Number.isInteger(want)) {
      blockers.push(`${s.size}: enter a whole number of units (0 or more).`);
      continue;
    }
    if (want > have) {
      blockers.push(`${s.size}: only ${have} here — you asked to move ${want}.`);
      continue;
    }
    if (want > 0) transfers.push({ size: s.size, qty: want });
  }

  // A partial move keeps the source carrying — it genuinely still stocks the
  // product. Saying so up front beats an unseat that silently no-ops later.
  const leftBehind = cells.filter((s) => {
    const have = Number(s.qty || 0);
    if (have <= 0) return false;
    const moving = transfers.find((t) => String(t.size) === String(s.size))?.qty || 0;
    return have - moving !== 0;
  });
  const partial = leftBehind.length > 0;

  // Destination cells to seed: every size we are NOT sending units to. Sizes
  // that receive a transfer need no seed — applyMovement creates that cell
  // itself, and a seed racing it would be rejected (the SEED branch only
  // accepts !data.exists()).
  const seeding = moveSeating
    ? cells.filter((s) => !transfers.some((t) => String(t.size) === String(s.size))).map((s) => s.size)
    : [];

  // Only the sizes that will provably be at 0 afterwards can lose their claim.
  const unseat = moveSeating
    ? cells
        .filter((s) => {
          const have = Number(s.qty || 0);
          if (have < 0) return false;                                        // broken balance — never erase
          const moving = transfers.find((t) => String(t.size) === String(s.size))?.qty || 0;
          return have - moving === 0;
        })
        .map((s) => ({
          path: `stock/${loc}/${pid}/${stockSizeKey(s.size)}`,
          size: s.size,
          // v/mv are what a transfer will have left behind, so the guard is
          // applied by the writer AFTER the movements land, from a fresh read —
          // see carriageStore.moveCarriage. Untouched sizes keep their read
          // values and are guarded exactly like a plain unseat.
          expect: transfers.some((t) => String(t.size) === String(s.size))
            ? null
            : { qty: Number(s.qty || 0), v: Number(s.v || 0), mv: s.mv ?? null },
        }))
    : [];

  // A move with nothing to send AND nothing to seat is a no-op, and a silent
  // one is worse than a refusal: the old Move reported "no positive counted
  // stock" and stopped, which is precisely how a wrongly-seated product became
  // unmovable. Say what would actually help instead.
  if (!blockers.length && !transfers.length && !seeding.length) {
    blockers.push(
      moveSeating
        ? `Nothing to move — ${label} has no stock and no seating here.`
        : `Nothing to move — ${label} holds no stock here. Tick "Move the seating too" to relocate its seating instead.`
    );
  }

  return {
    loc, pid, to, name: label,
    transfers, seeding, unseat, partial, blockers,
    ok: blockers.length === 0 && (transfers.length > 0 || seeding.length > 0),
  };
}

// ── AUDIT ────────────────────────────────────────────────────────────────────
// One entry per gesture, not per cell: the operator unseated a product at a
// location, and that is the fact worth keeping. Sizes ride along so the entry
// is enough to reconstruct the claim by hand if it ever has to come back.
//
// OMIT-DON'T-COPY on optional fields, for the reason hiddenProductsCore spells
// out: RTDB rejects `undefined` inside a multi-path update and takes the whole
// batch down with it.
export function carriageLogEntry({ action, loc, pid, name, sizes, to, by, at, note } = {}) {
  const e = {
    action: action === "move" ? "move" : "unseat",
    loc: String(loc || ""),
    pid: String(pid || ""),
    sizes: (sizes || []).map(String),
    at: Number(at) || 0,
    by: by ?? null,
  };
  if (name) e.name = String(name);
  if (to) e.to = String(to);
  if (note) e.note = String(note);
  return e;
}
