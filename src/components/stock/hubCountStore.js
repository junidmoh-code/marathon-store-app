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
import { ref, child, get, update, push } from "firebase/database";
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
  const existing = await one(sessionPath(hub));
  if (existing && existing.sessionId) return existing;

  const user = auth.currentUser;
  const session = {
    sessionId: push(child(ref(database), `${HUB_COUNT_ROOT}/sessions`)).key,
    hub,
    openedAt: serverNowIso(),
    openedBy: user ? user.uid : null,
  };
  await update(ref(database), { [sessionPath(hub)]: session });
  return session;
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

/** The home card's cheap read: session record + how many cells are recorded. */
export async function loadCardSummary(hub) {
  const session = await one(sessionPath(hub));
  if (!session || !session.sessionId) return { session: null, done: 0, total: 0 };
  const counted = await one(countedPath(hub, session.sessionId));
  return {
    session,
    done: counted ? Object.keys(counted).length : 0,
    total: Number(session.totalCells) || 0,
  };
}

function recordFor({ productId, sizeKey, expected, actual, action, movementId }) {
  const user = auth.currentUser;
  return {
    productId,
    sizeKey,
    expected: Number(expected),
    actual: Number(actual),
    action,                                  // "confirm" | "adjust"
    at: serverNowIso(),
    by: user ? user.uid : null,
    movementId: movementId || null,
  };
}

async function writeRecord(hub, sessionId, rec) {
  await update(ref(database), {
    [`${countedPath(hub, sessionId)}/${cellKey(rec.productId, rec.sizeKey)}`]: rec,
  });
}

/**
 * CONFIRM — "the shelf agrees with the system".
 *
 * Records the count and touches /stock NOT AT ALL: no movement, no cell write,
 * not even a state flip. The existing Count tab flips the cell to `live` on a
 * matching count, but that is a rollout-gate concern for seeding tracked stock,
 * and this is a temporary audit — "records the count, no stock change" is taken
 * literally. The record itself is the evidence the cell was verified.
 */
export async function confirmCell({ hub, sessionId, productId, sizeKey, expected }) {
  const live = await readLiveQty(hub, productId, sizeKey);
  if (live.error) return live;
  if (Number(live.qty) !== Number(expected)) return staleResult(live.qty, expected);

  const rec = recordFor({ productId, sizeKey, expected, actual: expected, action: "confirm" });
  await writeRecord(hub, sessionId, rec);
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
 *   2. VERSION REJECTION, with retries OFF. applyMovement carries optimistic
 *      concurrency on the cell's `v`: it reads v and writes v+1, and the rule
 *      rejects anything else. Its DEFAULT is to retry 6 times, and each retry
 *      re-reads — which is right for a relative movement (a transfer of 3 is
 *      still a transfer of 3) but WRONG for a count, whose meaning is absolute:
 *      re-applying `actual - expected` onto a base that moved produces a number
 *      nobody counted. `maxRetries: 1` turns that conflict into a visible
 *      failure instead of a silent re-application. This is a supported option on
 *      the existing writer — not a fork of it.
 *
 *   3. POST-WRITE ASSERT. Re-read and confirm the cell now holds `actual`. If it
 *      does not, someone landed in the same millisecond: report loudly WITH the
 *      movement id, so the write can be traced and reversed by hand. Never
 *      swallowed.
 */
export async function adjustCell({ hub, sessionId, productId, sizeKey, expected, actual, actorRole }) {
  const target = Number(actual);
  if (!Number.isInteger(target) || target < 0) {
    return { ok: false, message: "Enter a whole number of pairs (0 or more)." };
  }

  const live = await readLiveQty(hub, productId, sizeKey);
  if (live.error) return live;
  if (Number(live.qty) !== Number(expected)) return staleResult(live.qty, expected);   // layer 1

  const delta = target - Number(expected);
  if (delta === 0) return confirmCell({ hub, sessionId, productId, sizeKey, expected });

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
        countDelta: delta,
        countAt: serverNowIso(),
      },
    },
    { maxRetries: 1 }                        // layer 2
  );

  if (!res.ok) {
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

  const after = await readLiveQty(hub, productId, sizeKey);                            // layer 3
  const settled = !after.error && Number(after.qty) === target;

  const rec = recordFor({ productId, sizeKey, expected, actual: target, action: "adjust", movementId: res.movementId });
  await writeRecord(hub, sessionId, rec);

  if (!settled) {
    return {
      ok: true,
      record: rec,
      warning: `Recorded, but the cell now reads ${after.qty} instead of ${target} — another write landed at the same moment. Movement ${res.movementId} can be traced in History.`,
    };
  }
  return { ok: true, record: rec };
}
