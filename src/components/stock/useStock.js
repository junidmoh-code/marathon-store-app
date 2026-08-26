// ─── STOCK READ HOOKS ─────────────────────────────────────────────────────────
// Live onValue subscriptions for the stock paths, mirroring the useProducts/
// useOrders pattern in App.jsx. Each effect gates on auth readiness because RTDB
// rules require auth != null — a listener registered before sign-in is rejected
// and does NOT auto-retry on permission errors.

import { useEffect, useMemo, useState } from "react";
import { ref, onValue } from "firebase/database";
import { onAuthStateChanged } from "firebase/auth";
import { database, auth } from "../../firebase";
import { decodeSizeKey } from "../../utils/sizeKey";
import { STOCK_HOLD_ROOT } from "../../config/stockHold";
import { DISPLAY_SLOTS_ROOT } from "./displaySlots";
import { HIDDEN_ROOT } from "./hiddenProductsCore";

function useAuthReady() {
  const [ready, setReady] = useState(() => !!auth.currentUser);
  useEffect(() => onAuthStateChanged(auth, (u) => setReady(!!u)), []);
  return ready;
}

// Generic single-path live read. Returns the raw snapshot value (object or null).
function usePath(path, enabled = true) {
  const authReady = useAuthReady();
  const [value, setValue] = useState(null);
  useEffect(() => {
    // Drop any cached snapshot when we lose read permission (sign-out / auth loss),
    // so a previous user's stock data can't linger on screen.
    if (!authReady || !enabled || !path) { setValue(null); return; }
    const unsub = onValue(
      ref(database, path),
      (snap) => setValue(snap.val()),
      (err) => console.warn(`Stock read error on /${path}:`, err)
    );
    return () => unsub();
  }, [authReady, enabled, path]);
  return value;
}

// usePath, but reporting the THREE states RTDB's null conflates. `snap.val()` is
// null for an empty or missing node, the initial state is null, and a DENIED read
// leaves it null too (the error path only warns) — so a bare null cannot tell
// "not answered yet" from "answered with nothing" from "could not read".
//
// That ambiguity is only harmless while a null is treated the same way in all
// three cases. It stops being harmless the moment a screen GATES on the read:
// gating on `value != null` turns an empty node or a permission error into a
// permanent "still loading", with no error surfaced and no way out.
//
//   settled — the listener has answered at least once (or failed). Use THIS to
//             gate, never `value != null`.
//   error   — the read failed. Callers must degrade rather than block: an
//             unreadable node means "this input is unknown", not "stop".
export function usePathState(path, enabled = true) {
  const authReady = useAuthReady();
  const [state, setState] = useState({ value: null, settled: false, error: false });
  useEffect(() => {
    if (!authReady || !enabled || !path) { setState({ value: null, settled: false, error: false }); return; }
    const unsub = onValue(
      ref(database, path),
      (snap) => setState({ value: snap.val(), settled: true, error: false }),
      (err) => {
        console.warn(`Stock read error on /${path}:`, err);
        setState({ value: null, settled: true, error: true });
      },
    );
    return () => unsub();
  }, [authReady, enabled, path]);
  return state;
}

// /locations -> { id: {label,kind,sellable,active} } (object map, as stored).
export function useLocations() {
  return usePath("locations") || {};
}

// Decode the size-level keys of a { productId: { sizeKey: cell } } map back to raw
// sizes, so callers index by the real size ("5.5"), not the stored encoded key
// ("5_5"). The write side (applyMovement) encodes; this is the matching decode so
// every display consumer keeps working unchanged.
function decodeByProduct(byProduct) {
  const out = {};
  for (const pid of Object.keys(byProduct || {})) {
    const bySize = byProduct[pid] || {};
    const dec = {};
    for (const k of Object.keys(bySize)) dec[decodeSizeKey(k)] = bySize[k];
    out[pid] = dec;
  }
  return out;
}

// /stock -> nested { loc: { productId: { size: cell } } } with size keys DECODED to
// raw sizes. Optionally scope to a single location to keep the payload small.
export function useStockCells(locationId) {
  const path = locationId ? `stock/${locationId}` : "stock";
  const val = usePath(path);
  return useMemo(() => {
    if (!val) return {};
    if (locationId) return decodeByProduct(val);                 // { pid: { size: cell } }
    const out = {};                                             // { loc: { pid: { size: cell } } }
    for (const loc of Object.keys(val)) out[loc] = decodeByProduct(val[loc]);
    return out;
  }, [val, locationId]);
}

// useStockCells with the settled/error states a GATING caller needs. The shop
// ordering grid greys out sneaker sizes Hub 1 has none of — and MUST NOT grey
// anything while the subtree is still loading (an unsettled {} would X every
// size of every product for the first paint), so the gate keys on `settled`.
export function useStockCellsState(locationId) {
  const st = usePathState(locationId ? `stock/${locationId}` : null);
  const cells = useMemo(() => {
    if (!st.value || !locationId) return {};
    return decodeByProduct(st.value);
  }, [st.value, locationId]);
  return { cells, settled: st.settled, error: st.error };
}

// /settings/displaySlots → { store: { productId: slot } } — the live display
// register (one slot per product per store; displaySlots.js is the writer).
// Measured 2026-08-26: the whole node is ~60 KB, against the ~474 KB
// stock/hub1 subtree the same screen already streams — the display-pair
// marker cannot be derived from the stock cells (they carry no display fact,
// and writing one in would mean a second bookkeeping path over a
// rules-validated node), so this one extra listener is the cost, stated and
// accepted. `enabled=false` skips the subscription entirely (Pine devices).
export function useDisplaySlots(enabled = true) {
  return usePath(DISPLAY_SLOTS_ROOT, enabled);
}

// /stock_movements -> array sorted newest-first. Optionally filter by productId.
export function useMovements(productId) {
  const val = usePath("stock_movements");
  const arr = val
    ? Object.entries(val).map(([id, m]) => ({ id, ...m }))
    : [];
  const filtered = productId ? arr.filter(m => m.productId === productId) : arr;
  return filtered.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
}

// /config/transit → { enabled, updatedAt, updatedBy } — the transit-lane kill
// switch (admin toggle on the In Transit screen). ABSENT node = ON: the flag
// exists to pause the feature during rollout (printer/training/display-card
// work), so only an explicit enabled:false switches sends back to instant.
// Receiving already-dispatched transfers is NEVER gated by this flag.
export function useTransitConfig() {
  return usePath("config/transit");
}

export function useTransfers(status) {
  const val = usePath("transfers");
  const arr = val ? Object.entries(val).map(([id, t]) => ({ id, ...t })) : [];
  return status ? arr.filter(t => t.status === status) : arr;
}

export function useRefillRequests(status) {
  const val = usePath("refill_requests");
  const arr = val ? Object.entries(val).map(([id, r]) => ({ id, ...r })) : [];
  return status ? arr.filter(r => r.status === status) : arr;
}

export function useStockAlerts() {
  const val = usePath("stock_alerts");
  return val ? Object.entries(val).map(([id, a]) => ({ id, ...a })) : [];
}

// ── Refill-engine reads (Health tab) ─────────────────────────────────────────
// All four nodes are written by the refillHealthScan Cloud Function only; the
// app reads them for the exception dashboard. Shapes: see functions/refill-scan.cjs.

// /stock_exceptions/latest → { computedAt, runId, belowTarget:{count,items}, ... }
export function useStockExceptions() {
  return usePath("stock_exceptions/latest");
}

// /stock_confidence → { computedAt, byLocation: { loc: { pid: {score,factors} } } }
export function useStockConfidence() {
  return usePath("stock_confidence");
}

// /refill_engine/shadow → { dest: { pid: { sizeKey: {qty,source,priority,...} } } }
export function useEngineShadow() {
  return usePath("refill_engine/shadow");
}

// /refill_engine/open → { dest: { pid: { sizeKey: {refillId,orderId,qty,...} } } }
// The engine's LIVE open-intent locks — what it has already created and is
// waiting on (R### orders in the warehouse queue / Source requests).
export function useEngineOpen() {
  return usePath("refill_engine/open");
}

// /refill_engine/runs → last runs, newest first (keys are time-sortable).
export function useEngineRuns(limit = 8) {
  const val = usePath("refill_engine/runs");
  const arr = val ? Object.entries(val).map(([id, r]) => ({ id, ...r })) : [];
  return arr.sort((a, b) => b.id.localeCompare(a.id)).slice(0, limit);
}

// /config/refillEngine → { enabled, mode, routes, ... }
export function useEngineConfig() {
  return usePath("config/refillEngine");
}

// /settings/stockHold/config → { enabled, delegates, ... } — the central→hub
// held-credit switch (absent/false = OFF = today's instant behaviour). Paths
// derive from STOCK_HOLD_ROOT so these subscriptions can never drift from the
// writers in stockHoldStore.js (CodeRabbit, PR #347).
export function useStockHoldConfig() {
  return usePath(`${STOCK_HOLD_ROOT}/config`);
}

// /settings/stockHold/held → { dest: { lineId: line } } — credits parked in
// transit awaiting the owner's release. Readers that reason about "stock on
// its way" (MoveExcess netting, Missing Sneakers) treat these as inbound.
export function useStockHeld() {
  return usePath(`${STOCK_HOLD_ROOT}/held`);
}

// /stock_targets/{loc} → { pid: { sizeKey: {target,minQty,...} } } (encoded keys).
export function useStockTargets(locationId) {
  return usePath(locationId ? `stock_targets/${locationId}` : "stock_targets");
}

// The same read, with the loaded/failed states a GATING caller needs. Missing
// Products gates Solve on it (an explicit row is the only target a one-size
// product can hold), and gating on the bare value would have greyed every
// clothing Solve — sized ones included — behind a permanent "still loading"
// whenever /stock_targets was empty or unreadable.
export function useStockTargetsState(locationId) {
  return usePathState(locationId ? `stock_targets/${locationId}` : "stock_targets");
}

// /stock_targets_decisions → { loc: { pid: {decision,decidedAt} } } — postpone
// decisions from the Decision Queue (keep / snooze / until_change); the engine
// skips products while a decision is active.
export function useTargetDecisions() {
  return usePath("stock_targets_decisions");
}

// /refill_engine/retryState → { dest: { pid: { sizeKey: {retryCount,lastRejectedAt,nextRetryAt,lastRejectionReason,source} } } }
// Rejected refill requests the engine will retry automatically every 24h.
export function useRetryState() {
  return usePath("refill_engine/retryState");
}

// /settings/missingProductsHidden → { pid: {at,by,reason?} } — the Missing
// Products VIEW filter (who hid what, when; hiddenProductsCore.js). Its own
// small node, so this subscription costs the node's size (~90 B/entry), never
// a whole-tree read. Null (unloaded, empty, or unreadable) fails OPEN — the
// partition treats it as "nothing hidden", because a discretion filter that
// cannot load must never hide real work. Path derives from HIDDEN_ROOT so the
// read can never drift from the writers.
export function useHiddenMissingProducts() {
  return usePath(HIDDEN_ROOT);
}

// /receiving_session → { active, openedAt, closedAt } — while active the
// engine is fully paused (no requests, no balancing, no exception recompute)
// so supplier receiving at Central is never interrupted by automation.
export function useReceivingSession() {
  return usePath("receiving_session");
}
