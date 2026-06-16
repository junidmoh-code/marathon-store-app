// ─── LAYBY DATA HOOKS + WRITERS (warehouse side) ─────────────────────────────
// Live subscriptions to the SHARED /laybys and /laybyPulls nodes (contract in
// SCHEMA.md) plus the three warehouse write actions: scan-receive a parcel, mark
// a pull "Sent", reject an expired pull.
//
// Defensive by design: marathon-pos-app owns the writer side and may not be
// committed yet, and the paths still need database.rules.json entries. Until
// both land, reads return permission-denied — we swallow the error and surface
// empty lists so the warehouse UI never crashes or blanks the whole view.

import { useEffect, useState } from "react";
import { ref, onValue, update } from "firebase/database";
import { onAuthStateChanged } from "firebase/auth";
import { database, auth } from "../../firebase";
import { LAYBY_STATUS, PULL_STATUS } from "./contract";

// Local mirror of App.jsx's useAuthReady — RTDB rejects reads before sign-in and
// will not auto-retry on a permission error, so every listener gates on this.
function useAuthReady() {
  const [ready, setReady] = useState(() => !!auth.currentUser);
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => setReady(!!user));
    return () => unsub();
  }, []);
  return ready;
}

// Generic keyed-node subscription → array of values carrying their node key.
// onError is intentionally quiet (console.warn only): a denied read on these
// not-yet-ruled paths is expected during rollout, not a bug to surface.
function useKeyedNode(path) {
  const authReady = useAuthReady();
  const [items, setItems] = useState([]);
  useEffect(() => {
    if (!authReady) return;
    const node = ref(database, path);
    const unsub = onValue(
      node,
      (snap) => {
        const data = snap.val();
        if (!data || typeof data !== "object") { setItems([]); return; }
        const arr = Object.entries(data)
          .filter(([, v]) => v && typeof v === "object")
          .map(([key, v]) => ({ key, ...v }));
        setItems(arr);
      },
      (err) => {
        // Permission-denied is the expected pre-rules state. Keep the list empty.
        console.warn(`Layby read error on /${path}:`, err?.code || err);
        setItems([]);
      }
    );
    return () => unsub();
  }, [authReady, path]);
  return items;
}

// All layby parcels (storage state). Each item: { key, laybyId, invoiceNo, status, ... }.
export function useLaybys() {
  return useKeyedNode("laybys");
}

// All pull requests. Each item: { key, pullId, laybyId, invoiceNo, status, ... }.
export function useLaybyPulls() {
  return useKeyedNode("laybyPulls");
}

// ── Writers ──────────────────────────────────────────────────────────────────
// hubLabel is the receiving/acting hub (e.g. "hub1"). Anonymous auth has no
// email, so the hub is the meaningful actor signal — mirrors depletedBy.
// All identity is the stable laybyId (node key); invoiceNo is display-only.

// Scan/receive a parcel into storage. `layby` must be an existing record (the UI
// resolves the scan against the loaded list before calling — we never create a
// parcel node here, POS owns creation).
export function receiveLayby(layby, hubLabel) {
  const laybyId = layby?.laybyId || layby?.key;
  if (!laybyId) return Promise.reject(new Error("receiveLayby: missing laybyId"));
  const now = new Date().toISOString();
  return update(ref(database, `laybys/${laybyId}`), {
    status:     LAYBY_STATUS.STORED,
    receivedAt: now,
    receivedBy: hubLabel,
  });
}

// Fulfil a pull: mark the pull Sent AND flip the parcel to sentToStore, in one
// atomic root multi-path update so the two can't diverge.
export function markPullSent(pull, hubLabel) {
  const pullId = pull?.pullId || pull?.key;
  if (!pullId) return Promise.reject(new Error("markPullSent: missing pullId"));
  const now = new Date().toISOString();
  const patch = {
    [`laybyPulls/${pullId}/status`]: PULL_STATUS.SENT,
    [`laybyPulls/${pullId}/sentAt`]: now,
    [`laybyPulls/${pullId}/sentBy`]: hubLabel,
  };
  const laybyId = pull?.laybyId;
  if (laybyId) {
    patch[`laybys/${laybyId}/status`]        = LAYBY_STATUS.SENT;
    patch[`laybys/${laybyId}/sentToStoreAt`] = now;
  }
  return update(ref(database), patch);
}

// Resolve a return-to-stock pull (the layby was cancelled at the POS). The
// warehouse pulled it, removed the label, and returned the units to stock. This
// writes ONLY the pull record — it deliberately does NOT touch /laybys, which the
// POS already set to "returned" on cancellation (contrast markPullSent, which
// flips /laybys → sentToStore for the collect path).
export function returnPullToStock(pull, hubLabel) {
  const pullId = pull?.pullId || pull?.key;
  if (!pullId) return Promise.reject(new Error("returnPullToStock: missing pullId"));
  const now = new Date().toISOString();
  return update(ref(database, `laybyPulls/${pullId}`), {
    status:     PULL_STATUS.RETURNED_TO_STOCK,
    returnedAt: now,
    returnedBy: hubLabel,
  });
}

// Reject a pull (expired layby past dueDate). Reason is required and flows back
// to the POS so the store sees why. Also flips the layby record to `rejected`
// (single atomic update) so its lifecycle reflects the outcome.
export function rejectPull(pull, reason, hubLabel) {
  const pullId = pull?.pullId || pull?.key;
  if (!pullId) return Promise.reject(new Error("rejectPull: missing pullId"));
  const trimmed = (reason || "").trim();
  if (!trimmed) return Promise.reject(new Error("rejectPull: reason required"));
  const now = new Date().toISOString();
  const patch = {
    [`laybyPulls/${pullId}/status`]:          PULL_STATUS.REJECTED,
    [`laybyPulls/${pullId}/rejectedAt`]:      now,
    [`laybyPulls/${pullId}/rejectedBy`]:      hubLabel,
    [`laybyPulls/${pullId}/rejectionReason`]: trimmed,
  };
  const laybyId = pull?.laybyId;
  if (laybyId) {
    patch[`laybys/${laybyId}/status`]          = LAYBY_STATUS.REJECTED;
    patch[`laybys/${laybyId}/rejectedAt`]      = now;
    patch[`laybys/${laybyId}/rejectionReason`] = trimmed;
  }
  return update(ref(database), patch);
}
