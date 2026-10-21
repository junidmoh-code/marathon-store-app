// ─── WEBSITE ORDERS — the hub side: /online_picks in the Warehouse queue ──────
// Contract: docs/ONLINE-ORDERS.md. The Mac mini writes one /online_picks/{id}
// row per website order line routed to a hub ({orderId}_{lineIndex}); the hub's
// Warehouse queue lists the open ones for ITS hub and the picker answers with
// one tap, "Handed over". That tap is the whole interaction: no transfer, no
// stock movement, no print — stock only deducts when the packer's POS sale
// lands (the one rule of the contract).
//
// READS, both scoped:
//   • /config/onlineOrders/enabled — the scalar, never the config node. Absent
//     = off; while off nothing is subscribed and the queue shows nothing extra
//     (the poller writes no picks while off anyway).
//   • /online_picks orderByChild("locStatus").equalTo("{hub}|open") — the
//     indexed query, so a hub downloads only its own open picks, never the node.
//     NEEDS ".indexOn": ["locStatus"] on /online_picks.

import { useEffect, useState } from "react";
import { ref, onValue, update, query, orderByChild, equalTo } from "firebase/database";
import { onAuthStateChanged } from "firebase/auth";
import { database, auth } from "../../firebase";
import {
  ONLINE_PICKS_PATH, ONLINE_ORDERS_PATH, ONLINE_ORDERS_CONFIG_PATH, LINE_STATUS,
} from "../../utils/onlineOrders";
import { serverNowMs } from "../../utils/serverTime";

// The query value for a hub's open picks (and its handed twin). One spelling.
export const pickLocStatus = (hub, status) => `${hub}|${status}`;

// RTDB key-safe id (no . # $ [ ] /) — a malformed row is skipped, never written.
const keySafe = (s) => typeof s === "string" && s.length > 0 && !/[.#$[\]/]/.test(s);

/**
 * The ONE multi-path update "Handed over" writes: the pick and the order line
 * flip to handed together, so the POS never sees one without the other.
 * Throws on a row that cannot name its order line — a write that guessed would
 * flip the wrong line, and a partial write is worse than none.
 */
export function handedOverUpdates(pick, { hub, uid, nowMs }) {
  const id = pick?.key;
  const orderId = pick?.orderId;
  const i = Number(pick?.lineIndex);
  if (!keySafe(id) || !keySafe(orderId) || !Number.isInteger(i) || i < 0) {
    throw new Error("handedOverUpdates: the pick does not name its order line");
  }
  if (!keySafe(hub)) throw new Error("handedOverUpdates: no hub");
  if (!Number.isFinite(nowMs)) throw new Error("handedOverUpdates: no time");
  // Who: the signed-in uid. A hub device with no uid at all still says WHICH
  // hub handed it over rather than writing a null that reads as "nobody".
  const by = uid || hub;
  const p = `${ONLINE_PICKS_PATH}/${id}`;
  const s = `${ONLINE_ORDERS_PATH}/${orderId}/lines/${i}/source`;
  return {
    [`${p}/status`]: LINE_STATUS.HANDED,
    [`${p}/locStatus`]: pickLocStatus(hub, LINE_STATUS.HANDED),
    [`${p}/handedAt`]: nowMs,
    [`${p}/handedBy`]: by,
    [`${s}/status`]: LINE_STATUS.HANDED,
    [`${s}/handedAt`]: nowMs,
    [`${s}/handedBy`]: by,
  };
}

export function handOverPick(pick, hub) {
  return update(ref(database), handedOverUpdates(pick, { hub, uid: auth.currentUser?.uid || null, nowMs: serverNowMs() }));
}

/**
 * Open picks as rows for the Warehouse queue's merged list. They sit in
 * Incoming like a pending layby pull, stamped "now" (`nowIso`) so the queue's
 * 3-day window can never hide one — an unanswered pick is a customer's parcel
 * waiting. `id` is the pick's own key (unique per line; two lines of one order
 * share a ref), which is what the queue's React keys need.
 */
export function pickQueueRows(picks, { hub, incomingStatus, nowIso }) {
  return (picks || [])
    .filter((p) => p && p.key && p.status === "open" && p.locStatus === pickLocStatus(hub, "open"))
    .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
    .map((p) => ({ id: `web:${p.key}`, status: incomingStatus, isOnlinePick: true, _pick: p, createdAt: nowIso }));
}

function useAuthReady() {
  const [ready, setReady] = useState(() => !!auth.currentUser);
  useEffect(() => onAuthStateChanged(auth, (u) => setReady(!!u)), []);
  return ready;
}

// /config/onlineOrders/enabled — true only for an explicit true.
export function useOnlineOrdersEnabled() {
  const authReady = useAuthReady();
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!authReady) return undefined;
    return onValue(ref(database, `${ONLINE_ORDERS_CONFIG_PATH}/enabled`),
      (snap) => setOn(snap.val() === true),
      (err) => { console.warn("online orders switch read failed:", err?.code || err); setOn(false); });
  }, [authReady]);
  return on;
}

// The hub's open picks. Subscribed only with a hub chosen AND the switch on.
export function useOnlinePicks(hub, enabled) {
  const authReady = useAuthReady();
  const [items, setItems] = useState([]);
  useEffect(() => {
    if (!authReady || !hub || !enabled) { setItems([]); return undefined; }
    const q = query(ref(database, ONLINE_PICKS_PATH), orderByChild("locStatus"), equalTo(pickLocStatus(hub, "open")));
    return onValue(q,
      (snap) => {
        const v = snap.val();
        setItems(v && typeof v === "object"
          ? Object.entries(v).filter(([, r]) => r && typeof r === "object").map(([key, r]) => ({ key, ...r }))
          : []);
      },
      (err) => { console.warn("online picks read failed:", err?.code || err); setItems([]); });
  }, [authReady, hub, enabled]);
  return items;
}
