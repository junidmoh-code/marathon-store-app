// ─── SEATING — THE WRITES ─────────────────────────────────────────────────────
//
// ── SWITCHING OFF IS A FACT, NOT A DELETION ──────────────────────────────────
// Nothing here deletes a stock cell. The live rules would allow it — /stock's
// $size .write is any stockRole holder and RTDB skips .validate on a delete
// (checked against /.settings/rules.json on 2026-08-24) — so the refusal has to
// be this file's rule. A cell delete writes no ledger record, leaves no trace,
// and under the cell-existence engine silently changes what a shop is armed
// for. An explicit row says the same thing out loud, reversibly, with a name and
// a time on it, and that record IS the audit trail.
//
// ── THE MECHANISM ALREADY EXISTED; THIS IS NOT A SECOND ONE ──────────────────
// An explicit /stock_targets row is the FIRST branch of the engine's
// resolveTarget (refill-engine.cjs:468) and outranks the category policy, the
// footwear rule, the kill switch and the size run. `target: 0` therefore means
// "deliberately excluded" and always has — it is what the Decision Queue's
// Exclude button writes (NoTargetQueue.jsx:325). This file writes through THAT
// mechanism. A second off switch would be a second answer to one question.
//
// TWO THINGS EXCLUDE DOES NOT DO, AND THIS MUST:
//
//   1. COVER EVERY SIZE THE ENGINE ARMS. Exclude iterates the card's STOCKED
//      sizes. The engine's sizesFor() walks every DECLARED catalogue size once a
//      rule manages the product, so a size with no cell stays armed and the shop
//      keeps being asked for it. seatingSizes() returns the full union.
//
//   2. BE REVERSIBLE WITHOUT GUESSING. Exclude overwrites whatever row was
//      there and keeps no memory of it, so "undo" would have to invent numbers.
//      Each row written here carries the row it replaced (`prevRow`) or the fact
//      that there was none (`prevAbsent`). Re-seat restores exactly that and
//      touches nothing else — in particular it NEVER removes a hand-made row.
//      The 7,797 explicit rows on this node are the source of truth for the
//      products that carry them; they are edited in place and never deleted.
//
// ── OPEN REFILLS RETRACT THEMSELVES ──────────────────────────────────────────
// The engine's own withdrawal pass computes needGone as
// `!t || t.target <= 0 || …` from resolveTarget (refill-engine.cjs:774) and
// closes the request as `no_longer_needed`. A target-0 row therefore retracts
// every open request for that line at that location on the next scan, with no
// human rejecting anything — and that is true of the build actually DEPLOYED
// (the cell-existence one, verified by source zip 2026-08-24), not only of the
// reverted provenance build. Nobody is sent to the queue to tidy up.

import { ref, get } from "firebase/database";
import { httpsCallable } from "firebase/functions";
import { database, functions, auth } from "../../firebase";
import { seatingSizes, seatingAt } from "./seatingCore";
import { switchOffDraft, clearDraft, targetPayload, isOurs, writableRow } from "./targetOverride";
import { applyMovement } from "./applyMovement";
import { isTransitLane } from "./transitLanes";
import { ADMIN_EMAIL } from "../../config/enginePolicy";

// RTDB path segments: a junk size key must fail loudly here rather than write
// somewhere else. (Same guard as utils/sizeKey assertSafeSegment.)
const UNSAFE = /[.#$[\]/]/;

// ── THE REFUSAL ──────────────────────────────────────────────────────────────
// Switching off must never make stock disappear. A cell holding anything but
// zero blocks the action and the screen offers Move instead.
//
// NON-ZERO, NOT MERELY POSITIVE. A negative cell holds no units, but it is a
// live accuracy signal (only a `sold` may drive a cell below zero — see
// applyMovement's negative floor), and abandoning it at a shop that no longer
// carries the line hides a count error for good. Move carries negatives across
// with their sign intact, so the remedy this refusal points at handles the case.
export function switchOffBlockers(seat) {
  const held = seat.sizes.filter((s) => s.qty !== 0);
  if (!held.length) return null;
  const units = held.reduce((n, s) => n + s.qty, 0);
  return {
    sizes: held.map((s) => ({ size: s.size === "" ? "One size" : s.size, qty: s.qty })),
    units,
    negativeOnly: held.every((s) => s.qty < 0),
  };
}

// ── THE PLAN ─────────────────────────────────────────────────────────────────
// Every size the engine would arm here, each with the row it will replace.
// Pure — the screen can show it before anything is written.
export function switchOffPlan(ctx, loc, pid) {
  const rows = ctx.targets?.[loc]?.[pid] || {};
  return seatingSizes(ctx, loc, pid).slice().sort().map((sizeKey) => ({
    sizeKey,
    prev: rows[sizeKey] ?? null,
  }));
}

function actorOf(viewer) {
  const uid = auth?.currentUser?.uid;
  if (!uid) throw new Error("Not signed in.");
  return { uid, email: viewer?.email || auth?.currentUser?.email || null };
}

// ── THE ROLE THAT GOES IN THE LEDGER ─────────────────────────────────────────
// `actorRole: "admin"` used to be hardcoded on every movement this file writes.
// That was true of everyone who could reach it — until the Engine Policy
// permission let a 'store' or 'warehouse' account move stock from the Seating
// tab (PR #469), at which point every one of their transfers would have been
// filed under a role they do not hold. The uid beside it is honest; the label
// would not have been, and it is the label a movement report groups by.
//
// The RULES check the caller's real stockRole on /stock_movements/$mv/type, so
// this field never granted anything — it only ever described. It now describes
// correctly. The owner has no stockRole on his record and is 'admin' in fact,
// so he keeps the label he always had. (Adversarial delta review, PR #469.)
function actorRoleOf(viewer) {
  if (typeof viewer?.stockRole === "string" && viewer.stockRole) return viewer.stockRole;
  return viewer?.email && viewer.email === ADMIN_EMAIL ? "admin" : null;
}

// ═════════════════════════════════════════════════════════════════════════════
// THE ONE WRITE — every explicit-row change this card makes goes through here
// ═════════════════════════════════════════════════════════════════════════════
//
// ── WHY IT IS A CALLABLE AND NOT A BROWSER WRITE ANY MORE ────────────────────
// It used to be a multi-path `update()` straight from the tab. That worked, and
// it could not do three things the owner asked for: preview what the next scan
// would resolve BEFORE committing, land in the policy history with one-tap
// revert, and refuse a write whose numbers moved underneath. All three already
// existed on the category side, server-side, and duplicating them in the
// browser would have been a second implementation of the card's most careful
// code.
//
// The gate does not widen. The server re-checks `engine_policy` for itself
// (assertEnginePolicyCaller), and the tab still asks `enginePolicySeatingWritable`
// before rendering the buttons — so the same people can do the same things, and
// the write is now audited.
//
// ── ATOMICITY IS UNCHANGED ───────────────────────────────────────────────────
// The server writes one multi-path update, so the row set still lands whole or
// not at all. A half-written switch-off would leave the shop armed for the sizes
// that missed, which is the failure this feature exists to end.
const CALLABLE_TIMEOUT_MS = 300000;
const setCategoryPolicyFn = () => httpsCallable(functions, "setCategoryPolicy", { timeout: CALLABLE_TIMEOUT_MS });

// RTDB path segments: a junk key must fail loudly here rather than write
// somewhere else. The server checks the same thing; this one turns it into a
// refusal before the round trip.
function unsafeIn(payload) {
  if (UNSAFE.test(payload.loc) || UNSAFE.test(payload.pid)) return payload.loc;
  for (const r of payload.rows) if (UNSAFE.test(r.sizeKey)) return r.sizeKey;
  for (const k of payload.remove) if (UNSAFE.test(k)) return k;
  return null;
}

// `draft` is a targetOverride draft: one entry per size, "" meaning INHERIT and
// a number (0 included) meaning EXPLICIT. Returns the plan it sent alongside
// the server's answer, so the caller can report what actually changed.
export async function saveProductTargets({ ctx, loc, pid, draft, allowRemoveForeign = false, dryRun = false }) {
  const { payload, plan } = targetPayload(ctx, loc, pid, draft, { allowRemoveForeign, dryRun });
  const bad = unsafeIn(payload);
  if (bad) return { ok: false, reason: "unsafe_key", sizeKey: bad };
  if (!plan.dirty) return { ok: false, reason: "no_change", plan };
  try {
    const res = await setCategoryPolicyFn()(payload);
    return { ok: true, plan, ...res.data };
  } catch (e) {
    // A removal the server refused for want of a confirmation is not a failure
    // — it is a question, and the screen has the words to ask it.
    if (e?.details?.needsConfirm) return { ok: false, reason: "confirm_foreign", foreign: e.details.foreign, plan };
    if (e?.details?.drift) return { ok: false, reason: "drift", message: e?.message || String(e), plan };
    return { ok: false, reason: "error", message: e?.message || String(e), plan };
  }
}

// ── SWITCH OFF — AN OVERRIDE OF 0, NOT A MECHANISM OF ITS OWN ────────────────
// Every size the engine would arm here, set to 0. That is what it has always
// written; it is now expressed as the draft the editor would produce, sent
// through the write above, so the off switch, an arming and a per-size override
// are one code path with one audit trail.
export async function switchOff({ seat, ctx, viewer, locations }) {
  // RE-READ BEFORE REFUSING, ALWAYS. The cells behind `seat` were fetched when
  // the screen loaded and a sale can land at any moment after that. The
  // units-held refusal is this feature's one hard guarantee, so it must be
  // decided against live data on EVERY path — the button and the move alike.
  //
  // AND THE VERIFICATION MUST BE REAL. `locations` has to name this location:
  // readSeatingContext returns a map keyed only by the locations it was asked
  // about, so an empty or wrong list yields no cells, which reads exactly like
  // an empty shelf — a failed check that looks like a passed one, over live
  // stock. Refuse rather than guess. (CodeRabbit, PR #429.)
  if (!Array.isArray(locations) || !locations.includes(seat.loc)) {
    return { ok: false, reason: "unverified" };
  }
  actorOf(viewer);                                   // refuse before any read if not signed in
  const fresh = await readSeatingContext(locations, seat.pid);
  const liveCtx = { ...ctx, stock: fresh.stock, targets: fresh.targets };
  const liveSeat = seatingAt(liveCtx, seat.loc, seat.pid);

  const blockers = switchOffBlockers(liveSeat);
  if (blockers) return { ok: false, reason: "holds_units", blockers };

  const draft = switchOffDraft(liveCtx, seat.loc, seat.pid);
  if (!Object.keys(draft.sizes).length) return { ok: false, reason: "no_sizes" };
  const res = await saveProductTargets({ ctx: liveCtx, loc: seat.loc, pid: seat.pid, draft });
  // Already at 0 on every size is not an error — it is the state the button was
  // pressed to reach.
  if (!res.ok && res.reason === "no_change") return { ok: true, rowCount: 0, noChange: true };
  if (!res.ok) return res;
  return { ok: true, rowCount: res.rowCount ?? res.plan.rows.length, historyId: res.historyId };
}

// ── CLEAR THE OVERRIDE / RE-SEAT — ONE ACTION ────────────────────────────────
// Every size back to blank, which means back to whatever the category policy,
// the footwear rule or the size run says. A row this card wrote that carries
// the row it replaced restores THAT row rather than vanishing — clearing our
// own decision must not also delete somebody else's. A row this card did not
// write is left alone here entirely: retiring one is a deliberate act done in
// the editor, where the numbers are on screen and the confirmation names them.
export function reseatPlan(ctx, loc, pid) {
  const rows = ctx.targets?.[loc]?.[pid] || {};
  const restore = [];
  const stuck = [];
  for (const sizeKey of Object.keys(rows).sort()) {
    const r = rows[sizeKey];
    if (!isOurs(r)) continue;
    if (r.prevAbsent === true) { restore.push({ sizeKey, to: null }); continue; }
    if (!r.prevRow || typeof r.prevRow !== "object") { stuck.push(sizeKey); continue; }
    // A ROW THE RULE WOULD REFUSE MUST NOT POISON THE WHOLE UNDO. The restore
    // is one multi-path update, and one shape the rule refuses used to fail all
    // of it with a bare PERMISSION_DENIED. Such a row is reported instead, and
    // every other size still comes back. (Adversarial review, PR #429.)
    if (!writableRow(r.prevRow)) { stuck.push(sizeKey); continue; }
    restore.push({ sizeKey, to: r.prevRow });
  }
  return { restore, stuck };
}

export async function reseat({ seat, ctx, locations }) {
  // RE-READ, like switchOff does. A row edited elsewhere since the screen
  // loaded must not be blind-overwritten with the prevRow captured back then.
  if (Array.isArray(locations) && locations.includes(seat.loc)) {
    const fresh = await readSeatingContext(locations, seat.pid);
    ctx = { ...ctx, stock: fresh.stock, targets: fresh.targets };
  }
  const { restore, stuck } = reseatPlan(ctx, seat.loc, seat.pid);
  if (!restore.length) return { ok: false, reason: "nothing_to_undo", stuck };
  // The clear draft blanks every size; the plan turns a blank over one of our
  // rows into a restore or a delete, exactly as reseatPlan describes. Sizes
  // carrying somebody else's row are blanked in the draft but the plan leaves
  // them alone unless the caller confirms — which this action never does.
  const draft = clearDraft(ctx, seat.loc, seat.pid);
  // A SIZE THIS CARD DID NOT WRITE IS NOT IN THE DRAFT AT ALL. The plan acts
  // only on sizes the draft names, so dropping them here is what makes "re-seat
  // undoes this screen's decisions and nobody else's" true of the payload and
  // not merely of the sentence above it. Retiring a foreign row is a deliberate
  // act done in the editor, where its numbers are on screen.
  for (const k of Object.keys(draft.sizes)) {
    if (!isOurs(ctx.targets?.[seat.loc]?.[seat.pid]?.[k])) delete draft.sizes[k];
  }
  const res = await saveProductTargets({ ctx, loc: seat.loc, pid: seat.pid, draft });
  if (!res.ok && res.reason === "no_change") return { ok: false, reason: "nothing_to_undo", stuck };
  if (!res.ok) return res;
  return { ok: true, rowCount: res.rowCount ?? restore.length, stuck, historyId: res.historyId };
}

// A live re-read of one (location, product) target row set — used after a write
// so the screen never renders a plan against numbers it no longer holds.
export async function readTargets(loc, pid) {
  const snap = await get(ref(database, `stock_targets/${loc}/${pid}`));
  return snap.exists() ? snap.val() : {};
}


// ═════════════════════════════════════════════════════════════════════════════
// MOVE AND SWITCH OFF
// ═════════════════════════════════════════════════════════════════════════════
//
// Every size of one product out of one location, into another, and the source
// switched off in the same action. EVERY stock write goes through
// applyMovement — the single writer to /stock — so the cells and the ledger
// movement land in one atomic update, the version guard holds, and a repeat is
// idempotent on the movement id.
//
// ── NEGATIVES ARE CARRIED, WITH THEIR SIGN ───────────────────────────────────
// A -2 cell holds no units; it is an accuracy signal, and only a `sold` can
// create one (applyMovement's negative floor). Leaving it behind at a shop that
// no longer carries the line hides a count error for good, and "moving" it as
// if it were +2 would invent two units out of nothing.
//
// So a negative line is sent THE OTHER WAY: a transfer_out of 2 from the
// DESTINATION to the SOURCE. The source cell rises -2 → 0 and the destination
// falls by 2, which is the same debt in the same network, now sitting where the
// line does. That leg needs allowNegative because it is the one case where
// driving a cell below zero is the correct outcome; the live rule permits it
// (a transfer_out may be negative — /stock's .validate, checked 2026-08-24).
//
// ── THE DESTINATION IS NOT WRITTEN A SEATING FACT ────────────────────────────
// It establishes carriage naturally: applyMovement creates its cell, and cell
// existence is what the deployed engine's storeCarries answers. Writing it a row
// as well would put a second, weaker answer next to the real one.

// A 32-bit FNV-1a over the move's own content. Not a security hash — its only
// job is to give the same move the same movement id on every press, so
// applyMovement's idempotency check can recognise a repeat.
// THE CELL VERSION IS IN THE KEY, AND THAT IS THE WHOLE POINT.
//
// A hash of pid/from/to/size/qty alone is stable FOR EVER, not just across a
// double tap — so moving trophy M×4 to hub2, restocking 4 more months later and
// moving them again produced the SAME movement id, applyMovement recognised it
// as already applied, and nothing moved while the screen said "4 moved". A
// silent no-op reported as a success is worse than the duplicate it was fixing.
//
// applyMovement bumps every touched cell's `v` on every write, so the version
// identifies the STATE this move acted upon. Two presses against the same state
// collapse to one movement; the same move against a restocked cell is a
// different state and travels. (Adversarial review, PR #429.)
function moveBatchId(pid, from, to, lines) {
  // The state token, in order of preference: the version, else the last
  // movement id, else the cell's updatedAt. A cell an Admin-SDK script rewrote
  // wholesale can carry no `v` at all — the headwear and bags collapses, hub
  // cleanup and the perfume corrections all wrote cells that way — and a
  // v-only key hashed every one of them to the same constant for ever, so a
  // second legitimate move of the same quantity came back `idempotent` and
  // moved nothing. (Adversarial re-review, PR #429.)
  const state = (l) => (l.v ?? l.mv ?? l.updatedAt ?? "x");
  const s = [pid, from, to, ...lines.map((l) => `${l.sizeKey}:${l.qty}:${state(l)}`)].join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `seatmove_${h.toString(36)}`;
}

// Lines are per SIZE, in size-key order, and only cells that hold something.
export function movePlan(ctx, loc, pid) {
  const seat = seatingAt(ctx, loc, pid);
  return seat.sizes
    .filter((s) => s.qty !== 0)
    // `size` is what applyMovement receives, and it REFUSES a falsy one
    // outright: `if (!movement.productId || !movement.size) return
    // missing_product_or_size` (applyMovement.js:97). rawSizeOf answers "" for
    // the no-size cell, so every one-size line — perfume, watches, and the
    // whole collapsed estate of bags and headwear — failed with an internal
    // reason printed at the owner. stockCellPath would have folded "" to "_"
    // happily; the guard fires first. So the no-size cell travels as "_", which
    // is exactly what Transfer.jsx has always sent (its ONE_SIZE constant).
    // (Adversarial review, PR #429.)
    .map((s) => ({ sizeKey: s.sizeKey, size: s.size === "" ? "_" : s.size, qty: s.qty,
                   v: s.v, mv: s.mv, updatedAt: s.updatedAt }));
}

// Why a destination cannot be chosen — null when it can.
export function moveBlockers(from, to, lines = [], destSeat = null) {
  if (!to) return "Pick where it goes.";
  if (to === from) return "That is the same location.";
  // Cross-building sends out of Central are a TWO-STEP transit lane (T1): stock
  // parks in in_transit and reaches the destination only when somebody scans it
  // in. This screen does one confirm and one hop, so it declines the lane rather
  // than quietly bypassing the receive step. Transfer already does it properly.
  if (isTransitLane(from, to)) return "That lane goes through Transit — use the Transfer screen.";

  // A NEGATIVE LINE IS A LEG IN THE OTHER DIRECTION, and it must pass the same
  // two tests. isTransitLane is OUTBOUND-FROM-BUILDING-A ONLY, so
  // isTransitLane("trophy","central") is false while isTransitLane("central",
  // "trophy") is true — checking only the nominal direction let a negative at
  // trophy destined for Central execute an A→B lane in one hop, with no
  // in_transit parking, no /transfers doc and no receive scan. Exactly what
  // this function refuses in the forward direction.
  const negatives = lines.filter((l) => l.qty < 0);
  if (negatives.length) {
    if (isTransitLane(to, from)) return "The negative would come back through Transit — use the Transfer screen.";
    // AND A DEBT MUST NOT INVENT CARRIAGE. The reversed leg creates a cell at
    // the destination, and cell existence IS carriage for the deployed engine —
    // so moving a -2 count error to a shop that never traded the line arms it
    // for the full run and it starts receiving refills for a product nobody
    // chose to stock. Real units establishing carriage is the intended
    // behaviour; a debt doing it is not.
    if (destSeat && !destSeat.hasCell) {
      return "That location does not carry this line — a negative cannot be the thing that seats it.";
    }
  }
  return null;
}

// ── the action ───────────────────────────────────────────────────────────────
// Lines first, THEN the switch-off — and the switch-off re-reads before it
// decides. A sale landing mid-move must not be switched off out of existence:
// the re-read sees the non-zero cell, the refusal fires, the stock is already
// safely moved, and the screen says the seat is still on.
export async function moveAndSwitchOff({ seat, ctx, viewer, dest, alsoSwitchOff = true, locations }) {
  const lines = movePlan(ctx, seat.loc, seat.pid);
  if (!lines.length) return { ok: false, reason: "nothing_to_move" };
  const blocked = moveBlockers(seat.loc, dest, lines, dest ? seatingAt(ctx, dest, seat.pid) : null);
  if (blocked) return { ok: false, reason: "destination", message: blocked };

  const actor = actorOf(viewer);
  // STABLE, NOT CLOCK-DERIVED. applyMovement's whole idempotency story rests on
  // the movement id, and an id built from serverNowMs() is different on every
  // press — so two confirms a second apart (a double tap, a retried tap on a
  // shop tablet that did not repaint) sent the stock TWICE. The id is derived
  // from the move itself instead, so an identical confirm collapses to one
  // movement. A genuine repeat is not lost: this action empties the source, so
  // the second attempt has a different plan — or no plan at all.
  // (CodeRabbit, PR #429.)
  const batchId = moveBatchId(seat.pid, seat.loc, dest, lines);
  let moved = 0;
  let replayed = 0;
  const failed = [];

  for (const line of lines) {
    const negative = line.qty < 0;
    const qty = Math.abs(line.qty);
    let res;
    try {
      res = await applyMovement({
        type: "transfer_out",
        productId: seat.pid,
        size: line.size,
        qty,
        from: negative ? dest : seat.loc,
        to: negative ? seat.loc : dest,
        actorRole: actorRoleOf(viewer),
        reason: "seating_move",
        movementId: `${batchId}_${seat.pid}_${line.sizeKey}`,
        link: { transferId: batchId },
        ...(negative ? { allowNegative: true } : null),
      });
    } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
    // `idempotent` means applyMovement recognised this movement id and did
    // NOTHING. Counting it would report units as moved that never left the
    // shelf — the same lie the stable-id bug produced, one layer down.
    if (res.ok && res.idempotent) replayed += qty;
    else if (res.ok) moved += qty;
    else failed.push(`${line.size === "_" ? "One size" : line.size}: ${res.reason}`);
  }

  if (!alsoSwitchOff) return { ok: true, moved, replayed, failed, batchId, switchedOff: false };
  if (failed.length) return { ok: true, moved, replayed, failed, batchId, switchedOff: false, offSkipped: "lines_failed" };

  // switchOff re-reads for itself now, so the stale plan can never reach it.
  //
  // THE CATCH IS LOAD-BEARING. This is the one moment where real stock has
  // ALREADY moved, and a network blip on the read or the write that follows
  // would otherwise reject the whole call — the caller's catch reports the raw
  // error and the fact that N units were relocated is lost from the message
  // entirely. The move's success is reported either way; only the switch-off
  // is recorded as not done. (Senior-architect review, PR #429.)
  try {
    const off = await switchOff({ seat, ctx, viewer, locations });
    return { ok: true, moved, replayed, failed, batchId, switchedOff: off.ok, offReason: off.ok ? null : off.reason };
  } catch (e) {
    return { ok: true, moved, replayed, failed, batchId, switchedOff: false,
      offReason: "error", offError: e?.message || String(e) };
  }
}

// The same scoped read the tab makes, so the re-read above cannot drift from it.
export async function readSeatingContext(locs, pid) {
  const stock = {};
  const targets = {};
  await Promise.all((locs || []).flatMap((loc) => [
    get(ref(database, `stock/${loc}/${pid}`)).then((s) => { if (s.exists()) stock[loc] = { [pid]: s.val() }; }),
    get(ref(database, `stock_targets/${loc}/${pid}`)).then((s) => { if (s.exists()) targets[loc] = { [pid]: s.val() }; }),
  ]));
  return { stock, targets };
}
