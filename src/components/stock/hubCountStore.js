// ─── HUB SNEAKER COUNT — DATA LAYER ───────────────────────────────────────────
// Every read and write this feature performs, in one file. Two rules govern it:
//
//   1. NO onValue, ANYWHERE. Every read is a one-shot get(). Hub 2 alone holds
//      cells for 1,971 products; a live subscription over that on a tablet
//      re-renders the count list under the counter's thumb every time a POS sale
//      lands. The snapshot is taken on entry, held in component state, and only
//      the individual cell being written is ever re-read.
//
//   2. NO NEW STOCK WRITE PATH. Quantity changes go through applyMovement — the
//      single writer to /stock — unchanged and un-forked. This module adds a
//      fence in FRONT of it, never a substitute for it.
//
// ── WHY lastType IS "adjustment" AND NOT "count" ─────────────────────────────
// The spec asked for lastType "count". The LIVE rules (fetched 2026-08-02 from
// .settings/rules.json — the local database.rules.json is known to drift, though
// for /stock it turns out to match) permit "count" on exactly ONE branch:
//
//   (!data.exists() && qty === 0 && v === 0 && lastType === 'count' && mv === 'seed')
//
// i.e. seeding a fresh EMPTY cell. Every quantity-CHANGING write must carry
// lastType ∈ received|opening|sold|transfer_in|transfer_out|adjustment|return,
// so an Adjust stamped "count" would be rejected by RTDB 100% of the time. An
// Adjust is therefore an `adjustment` (reason "hub_sneaker_count"), which is
// what the rules and the existing Count tab already use. No rules change needed.
// Reported to the owner rather than worked around silently.
//
// ── WHERE SESSION STATE LIVES ────────────────────────────────────────────────
// /settings/hubSneakerCount/** — the only subtree the live rules let a signed-in
// app user write without a rules change (/settings is read: auth != null,
// write: any non-anon auth, with no child validation). Shape:
//
//   sessions/{hub}                 { sessionId, openedAt, openedBy, totalCells }
//   counted/{hub}/{sessionId}/{productId::sizeKey}
//                                  { productId, sizeKey, expected, actual,
//                                    action, at, by, movementId }
//
// Keyed by hub and session so a second counter resumes exactly what the first
// left, and a reload restores it. NOTHING here is ever deleted.

import { useEffect, useState } from "react";
import { ref, child, get, update, push, runTransaction } from "firebase/database";
import { onAuthStateChanged } from "firebase/auth";
import { database, auth } from "../../firebase";
import { applyMovement } from "./applyMovement";
import { stockCellPath, stockSizeKey, decodeSizeKey } from "../../utils/sizeKey";
import { serverNowIso } from "../../utils/serverTime";
import { getDeviceId } from "../../device/deviceId";
import { HUB_COUNT_ROOT } from "../../config/hubSneakerCount";
import { cellKey } from "./hubCountCore";

// The hub the counter last chose, handed from the home card to the count view
// and restored after a reload so a resumed count reopens where it left off.
// sessionStorage, not RTDB: this is one person's UI position, not shared state.
const HUB_MEMO_KEY = "marathon.hubSneakerCount.hub";
export function rememberHub(hub) {
  try { sessionStorage.setItem(HUB_MEMO_KEY, hub || ""); } catch { /* private mode */ }
}
export function rememberedHub() {
  try { return sessionStorage.getItem(HUB_MEMO_KEY) || ""; } catch { return ""; }
}

const sessionPath = (hub) => `${HUB_COUNT_ROOT}/sessions/${hub}`;
const countedPath = (hub, sessionId) => `${HUB_COUNT_ROOT}/counted/${hub}/${sessionId}`;

const one = async (path) => (await get(child(ref(database), path))).val();

/** One-shot snapshot of /stock/{hub} — RAW, encoded size keys, exactly as stored. */
export async function loadHubStock(hub) {
  return (await one(`stock/${hub}`)) || {};
}

/**
 * The location registry, read ONCE.
 *
 * The app's shared useLocations() hook is an onValue subscription, and this
 * feature is onValue-free by instruction — so it reads /locations itself, one
 * shot, and holds it. The node is ten small objects; the cost is nothing and the
 * hub picker stops depending on a live listener.
 *
 * Gated on auth: RTDB rules require auth != null, and a read fired before
 * sign-in is REJECTED and does not auto-retry. So if there is no user yet we
 * wait for the first auth callback and read then.
 */
export function useLocationRegistryOnce() {
  const [registry, setRegistry] = useState({});
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      one("locations")
        .then((v) => { if (!cancelled) setRegistry(v || {}); })
        .catch(() => { /* pickers fall back to the DEFAULT_LOCATIONS seed */ });
    };
    if (auth.currentUser) { load(); return () => { cancelled = true; }; }
    const unsub = onAuthStateChanged(auth, (u) => { if (u) { unsub(); load(); } });
    return () => { cancelled = true; unsub(); };
  }, []);
  return registry;
}

/**
 * Open the hub's count session, or resume the one already running.
 *
 * One live session per hub, shared by every counter — that is what makes "a
 * second counter sees what's already done" true across devices rather than just
 * across reloads. The id is an RTDB push key: key-safe and time-sortable. It is
 * deliberately NOT a timestamp string — an ISO value in a key is the bug that
 * crashed the engine's retryHistory scans (#269).
 */
export async function openOrResumeSession(hub) {
  const user = auth.currentUser;
  const candidate = {
    sessionId: push(child(ref(database), `${HUB_COUNT_ROOT}/sessions`)).key,
    hub,
    openedAt: serverNowIso(),
    openedBy: user ? user.uid : null,
  };

  // COMPARE-AND-SET, not read-then-write. The obvious `get()` then `update()`
  // is a check-then-act race, and the scenario that triggers it is the exact one
  // this feature is for: two counters opening the same hub for the first time at
  // the start of a shift. Both would read null, both would mint an id, and the
  // second full-node write would REPLACE the first — leaving the loser writing
  // counts under a session id nothing will ever load again. Their /stock
  // corrections would survive (those are independent movements) but their
  // progress would silently vanish from the card, from a reload, and from the
  // other counter's screen.
  //
  // The transaction makes first-write-wins atomic, and the loser adopts the
  // winner's session from the committed snapshot rather than trusting the id it
  // minted locally.
  const res = await runTransaction(ref(database, sessionPath(hub)), (cur) =>
    (cur && cur.sessionId) ? cur : candidate
  );
  const committed = res && res.snapshot ? res.snapshot.val() : null;
  return committed && committed.sessionId ? committed : candidate;
}

/** Every cell already recorded in this session → { "pid::sizeKey": record }. */
export async function loadCounted(hub, sessionId) {
  return (await one(countedPath(hub, sessionId))) || {};
}

/**
 * Publish the session's cell total so the home card can show "N of M" without
 * pulling the whole hub stock node itself. The card reads ONLY the tiny session
 * record; the expensive snapshot stays inside the count view.
 */
export async function publishSessionTotal(hub, sessionId, totalCells) {
  await update(ref(database), { [`${sessionPath(hub)}/totalCells`]: totalCells });
}

/**
 * The home card's cheap read: the session record and NOTHING else.
 *
 * This used to pull the whole counted/{hub}/{sessionId} node and use only
 * Object.keys().length — several thousand eight-field records at hub 2, i.e.
 * hundreds of kilobytes transferred on every app open and every hub switch, to
 * render one number. Exactly the cost this module's header refuses to pay for
 * /stock, and at its worst on the last day of the count when the node is
 * biggest. The tally is now maintained as `doneCells` on the session record
 * itself (see writeRecord), so the card reads one small object.
 */
export async function loadCardSummary(hub) {
  const session = await one(sessionPath(hub));
  if (!session || !session.sessionId) return { session: null, done: 0, total: 0 };
  return {
    session,
    done: Number(session.doneCells) || 0,
    total: Number(session.totalCells) || 0,
  };
}

function recordFor({ productId, sizeKey, expected, actual, action, movementId, live, settled, offShelf = 0, offShelfNote = null }) {
  const user = auth.currentUser;
  return {
    productId,
    sizeKey,
    expected: Number(expected),
    actual: Number(actual),                  // what the counter said was on the shelf
    action,                                  // "confirm" | "adjust"
    // Units the system KNOWS are booked here but not on this shelf (displays at
    // shops, ready orders — offShelf.js). The counter was asked about
    // expected − offShelf, and every delta below is computed so these units
    // are never destroyed by an honest shelf count. Legacy records (absent
    // field) read as 0 — the old behaviour, exactly.
    offShelf: Number(offShelf) || 0,
    offShelfNote: offShelfNote || null,      // "1 on display at Marathon PE" — for History
    at: serverNowIso(),
    by: user ? user.uid : null,
    movementId: movementId || null,
    // What /stock actually held immediately after the write, and whether that
    // agreed with the count. Persisted rather than left as a toast: an unsettled
    // adjust means a human has to go and physically re-check that cell, and a
    // 9-second toast is not a work item. `settled: false` survives the reload,
    // and the Variance tab surfaces it.
    live: live == null ? Number(actual) : Number(live),
    settled: settled !== false,
  };
}

async function writeRecord(hub, sessionId, rec) {
  const path = `${countedPath(hub, sessionId)}/${cellKey(rec.productId, rec.sizeKey)}`;

  // CREATION is a transaction on the record path itself, so RTDB serializes two
  // counters hitting the same fresh cell: exactly one commit observes null and
  // creates; the other re-runs against the record, aborts, and falls through to
  // a plain overwrite. `committed` is therefore the truth about who created —
  // the old read-then-write asked "did it exist a moment ago?", and two
  // concurrent first-writers both heard "no" and both bumped the tally.
  const res = await runTransaction(ref(database, path), (cur) => (cur === null ? rec : undefined));

  if (res && res.committed) {
    // We created it → count it, once. The tally only feeds the home card, so a
    // failure here is cosmetic and must never fail the count itself.
    try {
      await runTransaction(ref(database, `${sessionPath(hub)}/doneCells`),
        (cur) => (typeof cur === "number" ? cur : 0) + 1);
    } catch { /* card progress only — the count is already saved */ }
  } else {
    // Overwrite of an existing record: a recount, an admin apply landing over a
    // flag, or the loser of the create race. No tally change. A flag CAN land
    // over an applied adjust — but only when the counter's expected equals the
    // post-apply live value (the fence rejects anything else), and that is a
    // genuinely NEW discrepancy against current stock, not a resurrection.
    await update(ref(database), { [path]: rec });
  }
}

/**
 * CONFIRM — "the shelf agrees with the system".
 *
 * Records the count and touches /stock NOT AT ALL: no movement, no cell write,
 * not even a state flip. The existing Count tab flips the cell to `live` on a
 * matching count, but that is a rollout-gate concern for seeding tracked stock,
 * and this is a temporary audit — "records the count, no stock change" is taken
 * literally. The record itself is the evidence the cell was verified.
 *
 * ── THE SHELF, NOT THE TOTAL (owner spec 2026-08-12) ─────────────────────────
 * `expected` stays the BOOKED quantity (the fence compares it to the live
 * cell); `offShelf` is what the system knows is booked here but standing
 * elsewhere (displays at shops, ready orders). The counter confirms
 * expected − offShelf — the number physically in front of them — and a
 * confirm can therefore never invite destroying an off-shelf unit.
 */
export async function confirmCell({ hub, sessionId, productId, sizeKey, expected, offShelf = 0, offShelfNote = null }) {
  const shelf = Number(expected) - (Number(offShelf) || 0);
  // A negative shelf expectation is the books DISAGREEING (more units known
  // off-shelf than booked at all) — there is no shelf count that "matches",
  // and notarising one as a confirm would mark an inconsistent cell complete.
  // It must go through adjust/flag with the real shelf number instead
  // (CodeRabbit, PR #347).
  if (shelf < 0) {
    return { ok: false, message: "The books disagree here — more units are known to be off the shelf than are booked. Enter what you actually see so it records as a correction, not a confirm." };
  }
  const live = await readLiveQty(hub, productId, sizeKey);
  if (live.error) return live;
  if (Number(live.qty) !== Number(expected)) return staleResult(live.qty, expected);

  const rec = recordFor({ productId, sizeKey, expected, actual: shelf, action: "confirm",
                          live: Number(expected), offShelf, offShelfNote });
  // A confirm changed no stock, so a failed record write means simply nothing
  // happened — safe to report as a failure and let the counter tap again.
  try {
    await writeRecord(hub, sessionId, rec);
  } catch (err) {
    return { ok: false, message: `Could not save the count: ${String(err?.message || err)}` };
  }
  return { ok: true, record: rec };
}

/**
 * FLAG — record a mismatched count WITHOUT touching stock.
 *
 * The warehouse counter's mismatch path. The live rules permit `adjustment`
 * movements only for stockRole "admin", so a warehouse counter cannot write the
 * correction — but /settings is open to any staff account, so they CAN record
 * what the shelf actually holds. The record lands in the Variance list with
 * action "flag", and an admin applies the correction from there via adjustCell,
 * which re-runs the SAME fence: if the cell moved between the count and the
 * apply, the apply rejects and the row needs a fresh count, never a blind write.
 *
 * Same staleness fence as confirm/adjust — a count against a shelf that no
 * longer matches the number the counter was shown is not a count.
 */
export async function flagCell({ hub, sessionId, productId, sizeKey, expected, actual, offShelf = 0, offShelfNote = null }) {
  const target = Number(actual);            // the SHELF count the counter typed
  if (!Number.isInteger(target) || target < 0) {
    return { ok: false, message: "Enter a whole number of pairs (0 or more)." };
  }
  const live = await readLiveQty(hub, productId, sizeKey);
  if (live.error) return live;
  if (Number(live.qty) !== Number(expected)) return staleResult(live.qty, expected);
  if (target === Number(expected) - (Number(offShelf) || 0)) {
    // The shelf matches once the off-shelf units are accounted for — a confirm.
    return confirmCell({ hub, sessionId, productId, sizeKey, expected, offShelf, offShelfNote });
  }

  // Stock stays exactly where it is: `live` on the record is the UNCHANGED cell
  // value, and settled is true because nothing was written that could fail to
  // settle. `action: "flag"` is what marks it as awaiting an admin.
  const rec = recordFor({ productId, sizeKey, expected, actual: target, action: "flag", live: Number(expected), settled: true, offShelf, offShelfNote });
  try {
    await writeRecord(hub, sessionId, rec);
  } catch (err) {
    return { ok: false, message: `Could not save the count: ${String(err?.message || err)}` };
  }
  return { ok: true, record: rec };
}

async function readLiveQty(hub, productId, sizeKey) {
  // The encoded key we hold must survive a decode→re-encode round trip, because
  // applyMovement takes a RAW size and re-encodes it to find the cell. If the
  // round trip is not identity, the movement would land on a DIFFERENT cell from
  // the one we fenced — so we refuse rather than write blind. (Identity holds for
  // every real size: "5_5"→"5.5"→"5_5", "8"→"8"→"8".)
  const rawSize = decodeSizeKey(sizeKey);
  if (stockSizeKey(rawSize) !== sizeKey) {
    return { ok: false, error: true, reason: "unroundtrippable_size", message: `Size key "${sizeKey}" cannot be written safely — skipped.` };
  }
  const cell = await one(stockCellPath(hub, productId, rawSize));
  return { qty: cell && typeof cell.qty === "number" ? cell.qty : 0, rawSize };
}

const staleResult = (live, expected) => ({
  ok: false,
  stale: true,
  live: Number(live),
  message: `This cell changed while you were counting — the system now holds ${live}, not ${expected}. Recheck the shelf and try again.`,
});

/**
 * ADJUST — write the corrected quantity, then record it.
 *
 * ── THE CONCURRENCY GUARD (two counters on one cell) ─────────────────────────
 * Three layers, none of which can silently overwrite:
 *
 *   1. PRE-FLIGHT FENCE. Re-read the cell one-shot. If it no longer holds the
 *      `expected` the counter was shown, ABORT with the exact numbers and let
 *      them recheck. This catches the realistic, human-scale race — two people
 *      on the same shelf minutes apart.
 *
 *   2. THE PRECONDITION, CHECKED BY THE WRITER ITSELF (`expect: { qty }`), plus
 *      retries OFF. This is the layer that actually makes it safe, and layer 1
 *      alone did NOT: the fence and applyMovement perform two SEPARATE reads, so
 *      a write landing in the round trip between them produced no version
 *      conflict at all — applyMovement never saw the old version. It would
 *      compute its delta against the new base and commit a number nobody
 *      counted. Passing `expect` moves the comparison inside the writer's own
 *      read-write window, and `maxRetries: 1` stops a retry re-applying a
 *      relative delta onto a base that moved. Between them the read-decide-write
 *      is atomic end to end. (Layer 1 survives because it gives fast, specific
 *      feedback without a write attempt — but it is a courtesy, not the guard.)
 *
 *      Consequence worth knowing: an ordinary POS sale landing mid-count now
 *      REJECTS the adjustment rather than composing with it. That is correct for
 *      a stock-take — if the cell moved, the shelf the counter looked at is no
 *      longer the shelf the number describes.
 *
 *   3. POST-WRITE ASSERT. Re-read and confirm the cell now holds `actual`. If it
 *      does not, PERSIST that on the record (`settled: false` + the value the
 *      cell really holds) so it survives the toast and surfaces in Variance as a
 *      cell a human must physically re-check. Never swallowed.
 */
export async function adjustCell({ hub, sessionId, productId, sizeKey, expected, actual, actorRole, offShelf = 0, offShelfNote = null }) {
  const target = Number(actual);            // the SHELF count the counter typed
  if (!Number.isInteger(target) || target < 0) {
    return { ok: false, message: "Enter a whole number of pairs (0 or more)." };
  }

  const live = await readLiveQty(hub, productId, sizeKey);
  if (live.error) return live;
  if (Number(live.qty) !== Number(expected)) return staleResult(live.qty, expected);   // layer 1

  // ── AN ADJUSTMENT MOVES THE SHELF FIGURE, NEVER THE OFF-SHELF UNITS ────────
  // (Owner spec 2026-08-12.) The counter answered "what is on this shelf"; the
  // booked cell also carries `offShelf` units standing at shops. The corrected
  // BOOKED quantity is therefore shelf + offShelf — the delta below leaves
  // every known off-shelf unit alive. With offShelf 0 this is byte-for-byte
  // the old arithmetic.
  const off = Number(offShelf) || 0;
  const bookedTarget = target + off;
  const delta = bookedTarget - Number(expected);
  if (delta === 0) return confirmCell({ hub, sessionId, productId, sizeKey, expected, offShelf, offShelfNote });

  const res = await applyMovement(
    {
      type: "adjustment",
      productId,
      size: live.rawSize,                    // RAW size — applyMovement owns the encoding
      qty: Math.abs(delta),
      to: delta > 0 ? hub : null,
      from: delta < 0 ? hub : null,
      reason: "hub_sneaker_count",
      actorRole,
      // Provenance rides in `link`, which applyMovement spreads verbatim and the
      // live rules do not restrict (no $other deny under /stock_movements/$mvId).
      // This is what makes every adjustment traceable back to the session, the
      // device and the two numbers that produced it.
      link: {
        deviceId: getDeviceId(),
        countSessionId: sessionId,
        countLocation: hub,
        countSize: live.rawSize,
        countExpected: Number(expected),
        countActual: target,
        countOffShelf: off,
        countDelta: delta,
        countAt: serverNowIso(),
      },
      // layer 2 — the writer re-checks this against the cell it is about to
      // write from, so the caller's earlier read cannot go stale underneath us.
      expect: { qty: Number(expected) },
    },
    { maxRetries: 1 }
  );

  if (!res.ok) {
    if (res.reason === "stale_expectation") return staleResult(res.live, expected);
    // A version conflict and a real permission denial are indistinguishable
    // client-side (both surface as PERMISSION_DENIED), so say both plainly
    // rather than guessing.
    const denied = res.reason === "write_failed" || res.reason === "retries_exhausted";
    return {
      ok: false,
      message: denied
        ? "Write refused — either someone else counted this cell a moment ago, or this account lacks admin stock rights. Recheck and try again."
        : `Could not adjust: ${res.reason}${res.available != null ? ` (available ${res.available})` : ""}`,
    };
  }

  // layer 3 — guarded. This read used to be unprotected, and `one()` REJECTS on a
  // failed read: the rejection propagated straight out of adjustCell and the
  // record write below never ran. The movement had already committed, so /stock
  // held the corrected quantity while the session held no record for the cell —
  // it showed as uncounted, and a retry then hit the stale fence because the
  // frozen snapshot still had the old expected. A verification failure must cost
  // us the verification, never the record.
  let after;
  try {
    after = await readLiveQty(hub, productId, sizeKey);
  } catch (err) {
    after = { error: true, unverified: String(err?.message || err) };
  }
  // The cell must now hold shelf + offShelf — the booked figure, not the bare
  // shelf count (they are the same number when nothing is off-shelf).
  const settled = !after.error && Number(after.qty) === bookedTarget;

  const rec = recordFor({
    productId, sizeKey, expected, actual: target, action: "adjust",
    movementId: res.movementId,
    live: after.error ? bookedTarget : Number(after.qty),
    // An unverifiable write is recorded as settled — we have no evidence it went
    // wrong, and flagging every dropped read as a discrepancy would fill Variance
    // with noise on bad shop wifi. The caller is told separately.
    settled: after.error ? true : settled,
    offShelf, offShelfNote,
  });

  // The stock movement has ALREADY committed at this point. If the progress
  // record fails to save, reporting "failed" would be actively dangerous — the
  // counter would re-enter the number and try again. (The fence would catch the
  // second attempt, but only after telling them something confusing.) So report
  // success and say plainly what did not get saved. The count itself is not lost:
  // the movement carries the whole thing in `link.count*`.
  try {
    await writeRecord(hub, sessionId, rec);
  } catch (err) {
    return {
      ok: true,
      record: rec,
      warning: `Stock WAS updated to ${bookedTarget}${off ? ` (${target} on the shelf + ${off} off-shelf)` : ""}, but this device could not save the progress record (${String(err?.message || err)}). Movement ${res.movementId} has the full count in its provenance — do not count this cell again.`,
    };
  }

  if (after.unverified) {
    return {
      ok: true,
      record: rec,
      warning: `Recorded ${target}, but this device could not re-read the cell to confirm it (${after.unverified}). The movement committed; check History if the number looks wrong.`,
    };
  }

  if (!settled) {
    return {
      ok: true,
      record: rec,
      warning: `Recorded, but the cell now reads ${after.qty} instead of ${bookedTarget} — another write landed at the same moment. Movement ${res.movementId} can be traced in History.`,
    };
  }
  return { ok: true, record: rec };
}
