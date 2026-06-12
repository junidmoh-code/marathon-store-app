// ─── OFFLINE SALE QUEUE (POS) ─────────────────────────────────────────────────
// Load shedding is routine, so the till MUST keep ringing sales with no internet.
// A sale is captured to a LOCAL IndexedDB queue and resolves immediately — money
// capture never blocks on connectivity. A background sync drains the queue through
// applyMovement() when connectivity returns. See design/INVENTORY-DESIGN.md §3.4.
//
// Idempotency (never lost, never double-applied): every sale carries a client-
// generated saleId, and every line a client-generated movementId, created at sale
// time. applyMovement() no-ops if the movement already exists; the /sales write is
// create-only. So a sale synced twice (flaky reconnect, two devices) applies once.
//
// This module is primarily for the POS app (which imports it); in the store app it
// stays dormant. It is kept here as the single reference implementation shared with
// the till so online and offline paths run identical, idempotent code.

import { useEffect, useState } from "react";
import { ref, get, child, update } from "firebase/database";
import { database } from "../../firebase";
import { applyMovement } from "./applyMovement";

const DB_NAME = "marathon-stock-offline";
const STORE = "pendingSales";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "saleId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const out = fn(store);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  });
}

// sale: { saleId, ts, lines:[{ productId, size, qty, fulfillingLoc, movementId, unitPrice }],
//         total, tenderType, deviceId }
// Resolves as soon as it is durably queued — the till proceeds immediately.
export async function enqueueSale(sale) {
  const db = await openDb();
  await tx(db, "readwrite", (store) => store.put({ ...sale, queuedAt: new Date().toISOString() }));
  notify();
  // Opportunistic immediate sync (no-op offline); never awaited by the caller path.
  if (typeof navigator === "undefined" || navigator.onLine) drainQueue().catch(() => {});
  return { ok: true, saleId: sale.saleId };
}

export async function pendingCount() {
  const db = await openDb();
  return tx(db, "readonly", (store) => store.count && store.count()).then(
    () => new Promise((resolve) => {
      const t = db.transaction(STORE, "readonly");
      const r = t.objectStore(STORE).count();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(0);
    })
  );
}

async function allPending() {
  const db = await openDb();
  return new Promise((resolve) => {
    const t = db.transaction(STORE, "readonly");
    const r = t.objectStore(STORE).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => resolve([]);
  });
}

async function removeSale(saleId) {
  const db = await openDb();
  await tx(db, "readwrite", (store) => store.delete(saleId));
  notify();
}

let _draining = false;

// Drains the queue: each line → a `sold` movement (idempotent), then the /sales
// record (create-only). A sale is removed only once all its lines applied.
export async function drainQueue() {
  if (_draining) return;
  _draining = true;
  try {
    const sales = await allPending();
    for (const sale of sales) {
      let allOk = true;
      for (const line of sale.lines || []) {
        const res = await applyMovement({
          type: "sold",
          productId: line.productId,
          size: line.size,
          qty: line.qty,
          from: line.fulfillingLoc,
          ts: sale.ts,
          movementId: line.movementId,
          link: { saleId: sale.saleId, deviceId: sale.deviceId },
        });
        if (!res.ok) { allOk = false; break; }
      }
      if (!allOk) continue; // leave queued; retry next drain

      // Write the sale record (create-only; idempotent via saleId).
      const saleSnap = await get(child(ref(database), `sales/${sale.saleId}`));
      if (!saleSnap.exists()) {
        try {
          await update(ref(database), {
            [`sales/${sale.saleId}`]: {
              ts: sale.ts,
              lines: sale.lines,
              total: sale.total ?? null,
              tenderType: sale.tenderType ?? null,
              deviceId: sale.deviceId ?? null,
              syncedAt: new Date().toISOString(),
            },
          });
        } catch { continue; } // leave queued; retry
      }
      await removeSale(sale.saleId);
    }
  } finally {
    _draining = false;
  }
}

// ── sync status (drives the small "syncing N" indicator; never blocks sales) ──
const listeners = new Set();
function notify() { listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } }); }

let _started = false;
export function startBackgroundSync() {
  if (_started || typeof window === "undefined") return;
  _started = true;
  window.addEventListener("online", () => drainQueue().catch(() => {}));
  setInterval(() => { if (navigator.onLine) drainQueue().catch(() => {}); }, 30000);
  if (navigator.onLine) drainQueue().catch(() => {});
}

export function useSyncStatus() {
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => {
    let alive = true;
    const refresh = () => pendingCount().then((n) => { if (alive) setPending(n); }).catch(() => {});
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    listeners.add(refresh);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    refresh();
    const iv = setInterval(refresh, 5000);
    return () => { alive = false; listeners.delete(refresh); clearInterval(iv); window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); };
  }, []);
  return { pending, syncing: pending > 0 && online, online };
}
