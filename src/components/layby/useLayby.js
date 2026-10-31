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
import { ref, onValue, update, runTransaction } from "firebase/database";
import { onAuthStateChanged } from "firebase/auth";
import { database, auth } from "../../firebase";
import { LAYBY_STATUS, PULL_STATUS, pullStatusOf } from "./contract";
import { serverNowIso } from "../../utils/serverTime";

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
  const now = serverNowIso();
  return update(ref(database, `laybys/${laybyId}`), {
    status:     LAYBY_STATUS.STORED,
    receivedAt: now,
    receivedBy: hubLabel,
  });
}

// ── ONE OUTCOME PER PULL ─────────────────────────────────────────────────────
// A pull is resolved exactly once. Every warehouse action CLAIMS the pull in a
// transaction on the pull node — pending → its outcome WITH its stamps (status,
// time, actor, reason) in the same commit, abort on anything else — so a card
// that is out of date, or two tablets tapping in the same instant, cannot turn
// a Sent into a Rejected or stamp a second sentAt. A loser gets
// `code: "already-resolved"` and the status it found.
//
// The PARCEL (/laybys) is then flipped in a second write. A transaction cannot
// span two nodes, so if that second write fails the pull still carries its
// full outcome and the parcel lags — exactly the "fix" class that
// scripts/layby/pull-status-audit.mjs heals (sent pull with sentAt, parcel
// still pullRequested). The pull, which every hub surface reads, is never left
// half-written.
//
// Cold cache: the client runs the fn against null first. Null is proposed from
// the card's own copy of the pull, and the server's CAS re-runs the fn on the
// real record. (Pulls are never deleted, so the null-on-server case does not
// arise in practice.)
export class PullAlreadyResolvedError extends Error {
  constructor(pullId, status) {
    super(`Pull ${pullId} is already ${status}`);
    this.code = "already-resolved";
    this.status = status;
  }
}

function pullIdOf(pull) { return pull?.pullId || pull?.key; }

async function claimPull(pull, stamps) {
  const pullId = pullIdOf(pull);
  const { key: _k, _pull: _p, ...copy } = pull || {};
  const res = await runTransaction(ref(database, `laybyPulls/${pullId}`), (cur) => {
    const base = cur == null ? copy : cur;
    if (pullStatusOf(base) !== PULL_STATUS.PENDING) return undefined;
    return { ...base, ...stamps };
  });
  const after = res.snapshot.val();
  if (!res.committed || !after || after.status !== stamps.status) {
    throw new PullAlreadyResolvedError(pullId, pullStatusOf(after));
  }
}

// Fulfil a pull: the pull becomes Sent (claimed with its stamps), then the
// parcel flips to sentToStore.
export async function markPullSent(pull, hubLabel) {
  const pullId = pullIdOf(pull);
  if (!pullId) throw new Error("markPullSent: missing pullId");
  const now = serverNowIso();
  await claimPull(pull, { status: PULL_STATUS.SENT, sentAt: now, sentBy: hubLabel });
  const laybyId = pull?.laybyId;
  if (!laybyId) return;
  return update(ref(database), {
    [`laybys/${laybyId}/status`]:        LAYBY_STATUS.SENT,
    [`laybys/${laybyId}/sentToStoreAt`]: now,
  });
}

// Resolve a return-to-stock pull (the layby was cancelled at the POS). The
// warehouse pulled it, removed the label, and returned the units to stock. This
// writes ONLY the pull record — it deliberately does NOT touch /laybys, which the
// POS already set to "returned" on cancellation (contrast markPullSent, which
// flips /laybys → sentToStore for the collect path).
export async function returnPullToStock(pull, hubLabel) {
  const pullId = pullIdOf(pull);
  if (!pullId) throw new Error("returnPullToStock: missing pullId");
  const now = serverNowIso();
  await claimPull(pull, { status: PULL_STATUS.RETURNED_TO_STOCK, returnedAt: now, returnedBy: hubLabel });
}

// Reject a pull (expired layby past dueDate). Reason is required and flows back
// to the POS so the store sees why. Also flips the layby record to `rejected`
// so its lifecycle reflects the outcome.
export async function rejectPull(pull, reason, hubLabel) {
  const pullId = pullIdOf(pull);
  if (!pullId) throw new Error("rejectPull: missing pullId");
  const trimmed = (reason || "").trim();
  if (!trimmed) throw new Error("rejectPull: reason required");
  const now = serverNowIso();
  await claimPull(pull, { status: PULL_STATUS.REJECTED, rejectedAt: now, rejectedBy: hubLabel, rejectionReason: trimmed });
  const laybyId = pull?.laybyId;
  if (!laybyId) return;
  return update(ref(database), {
    [`laybys/${laybyId}/status`]:          LAYBY_STATUS.REJECTED,
    [`laybys/${laybyId}/rejectedAt`]:      now,
    [`laybys/${laybyId}/rejectionReason`]: trimmed,
  });
}
