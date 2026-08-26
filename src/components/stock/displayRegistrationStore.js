// ─── DISPLAY REGISTRATION CARD — the writers ─────────────────────────────────
//
// (Owner ask, 2026-08-26.) When NEW STOCK arrives, staff register what goes on
// the display wall; the same card corrects a wrongly-registered size (display
// recheck: system says 6, the wall holds 7) and retires a display fact.
//
// THE ONE RULE THAT SEPARATES THIS FROM hubCleanupStore.registerDisplayUnit:
// these writers NEVER move stock. The HubCleanup registrar exists for a
// display FOUND on a wall that the books never held — it books the unit
// (+1 received movement) and then records the fact. A NEW-STOCK display was
// already booked by receiving; registering it here records the FACT ONLY:
//
//   • the display REGISTER row (settings/hubSneakerCount/register/{hub}/
//     {pid}__{sizeKey}) — qty-bumped, movementId null, via marker, so the
//     count screens' off-shelf math treats the pair as off the shelf exactly
//     like a movement-backed row (offShelf reads qty alone);
//   • the display SLOT (settings/displaySlots/{store}/{pid}) when a store is
//     picked — the store-precise source the shop grid's marker prefers.
//
// EDIT moves the register quantity fact between size keys in ONE multi-path
// update (atomic; RTDB has no cross-path CAS, so the read→write window is the
// same small one every hand-operated correction card carries) and re-points
// the live slots that held the old size. The moved row drops any movementId —
// the movement, if one existed, credited the OLD size's cell and correcting
// stock is the count lane's job, never this card's — and carries a movedFrom
// audit instead. REMOVE decrements/deletes the row and tombstones the slots.
//
// All writes are non-anonymous-auth /settings paths; the card is stock-gated.

import { ref, get, update, runTransaction } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowIso } from "../../utils/serverTime";
import { stockSizeKey, assertSafeSegment } from "../../utils/sizeKey";
import { setDisplaySlot, clearDisplaySlot } from "./displaySlots";

export const CARD_VIA = "display_registration_card";

const regPath = (hub, pid, sizeKey) =>
  `settings/hubSneakerCount/register/${assertSafeSegment(hub, "hub")}/${assertSafeSegment(pid, "productId")}__${assertSafeSegment(sizeKey, "sizeKey")}`;

const rowFor = (product, size, sizeKey, nowIso) => ({
  productId: product.id,
  productName: product.name || "",
  sizeKey,
  size: String(size),
  qty: 1,
  at: nowIso,
  by: auth.currentUser?.uid || null,
  movementId: null,          // NO movement — the stock was booked by receiving
  via: CARD_VIA,
});

// Register one display fact for already-booked stock. Guarded transaction:
// a second device registering the same cell bumps qty rather than clobbering.
export async function recordDisplayFact({ hub, product, size, store }) {
  const sizeKey = stockSizeKey(String(size));
  if (sizeKey === "_") return { ok: false, message: "Pick a real size — one-size products have no display size." };
  const nowIso = serverNowIso();
  try {
    await runTransaction(ref(database, regPath(hub, product.id, sizeKey)), (cur) => {
      if (cur === null) return rowFor(product, size, sizeKey, nowIso);
      return { ...cur, qty: (Number(cur.qty) || 0) + 1, at: nowIso, by: auth.currentUser?.uid || null };
    });
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
  let slot = { ok: true, noop: true };
  if (store) {
    slot = await setDisplaySlot({
      store, productId: product.id, productName: product.name || "",
      size: String(size), bookedHub: hub, source: "registration",
    });
  }
  return { ok: true, slot };
}

// Move the display fact from one size to another — the recheck correction.
// `slotStores`: the stores whose live slot currently shows fromSizeKey for
// this product at this hub (the caller reads them off the loaded slots map);
// each is re-pointed to the new size.
export async function editDisplaySize({ hub, product, fromSizeKey, toSize, slotStores = [] }) {
  const toKey = stockSizeKey(String(toSize));
  if (toKey === "_") return { ok: false, message: "Pick a real size." };
  if (toKey === fromSizeKey) return { ok: false, message: "That is already the registered size." };
  const nowIso = serverNowIso();
  const fromRef = regPath(hub, product.id, fromSizeKey);
  const toRef = regPath(hub, product.id, toKey);
  try {
    const [fromSnap, toSnap] = await Promise.all([get(ref(database, fromRef)), get(ref(database, toRef))]);
    const fromRow = fromSnap.val();
    const toRow = toSnap.val();
    const moved = {
      ...(toRow || rowFor(product, toSize, toKey, nowIso)),
      qty: (Number(toRow?.qty) || 0) + 1,
      at: nowIso,
      by: auth.currentUser?.uid || null,
      movementId: toRow?.movementId ?? null,
      // The audit of the correction — where the fact came from, and the old
      // row's movement linkage so nothing is lost even when the row empties.
      movedFrom: { sizeKey: fromSizeKey, movementId: fromRow?.movementId ?? null, at: nowIso, via: CARD_VIA },
    };
    const fromQty = Number(fromRow?.qty) || 0;
    const updates = {
      [toRef]: moved,
      [fromRef]: fromQty > 1
        ? { ...fromRow, qty: fromQty - 1, at: nowIso }
        : null,   // the wrong fact is gone; its movement linkage lives on movedFrom
    };
    await update(ref(database), updates);
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
  const slotResults = [];
  for (const store of slotStores) {
    slotResults.push(await setDisplaySlot({
      store, productId: product.id, productName: product.name || "",
      size: String(toSize), bookedHub: hub, source: "manual",
    }));
  }
  return { ok: true, slotResults };
}

// Retire a display fact (the display came down / never existed).
export async function removeDisplayFact({ hub, product, sizeKey, slotStores = [] }) {
  const nowIso = serverNowIso();
  const path = regPath(hub, product.id, sizeKey);
  try {
    await runTransaction(ref(database, path), (cur) => {
      if (cur === null) return null;
      const q = Number(cur.qty) || 0;
      return q > 1 ? { ...cur, qty: q - 1, at: nowIso } : null;
    });
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
  for (const store of slotStores) {
    await clearDisplaySlot({ store, productId: product.id, source: "manual" });
  }
  return { ok: true };
}
