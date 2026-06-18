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

// /stock_movements -> array sorted newest-first. Optionally filter by productId.
export function useMovements(productId) {
  const val = usePath("stock_movements");
  const arr = val
    ? Object.entries(val).map(([id, m]) => ({ id, ...m }))
    : [];
  const filtered = productId ? arr.filter(m => m.productId === productId) : arr;
  return filtered.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
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
