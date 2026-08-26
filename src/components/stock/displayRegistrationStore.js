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
// already booked by receiving; registering it here records the FACT ONLY.
// A card row therefore satisfies the registrar's create-once check, which is
// CORRECT: the first unit is booked either way, and a genuinely unbooked
// second display goes through "add another" (addExtraDisplayUnit), which
// books its own unit.
//
// TWO INVARIANTS THE FIRST CUT BROKE (adversarial review, PR #460):
//
//   • ROWS ARE NEVER DELETED, and qty only floors at 0 with a retirement
//     stamp. A deleted row took its history — including the movement linkage
//     a found-on-wall registration carries — with it, and a re-registration
//     restarted the qty ladder from 1.
//   • `bumps` IS THE HIGH-WATER MARK of every qty increase the row has ever
//     had, and it NEVER decreases. hubCleanupStore.addExtraDisplayUnit
//     derives its deterministic movement id from this ladder; deriving from
//     the (now decrementable) qty let a decrement re-mint an id that already
//     existed, so the movement was skipped as idempotent while qty still
//     bumped — a display claimed with no unit booked. Rows written before
//     this field behave exactly as before (bumps falls back to qty).
//
// EDIT moves the register quantity fact between size keys in ONE multi-path
// update (atomic; RTDB has no cross-path CAS, so the read→write window is the
// same small one every hand-operated correction card carries) and re-points
// the live slots that held the old size, with a movedFrom audit. Slot-write
// failures (including a lost staleness fence) are REPORTED, never swallowed.
//
// All writes are non-anonymous-auth /settings paths; the card is stock-gated.

import { ref, get, update, runTransaction } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowIso } from "../../utils/serverTime";
import { stockSizeKey, assertSafeSegment } from "../../utils/sizeKey";
import { setDisplaySlot, clearDisplaySlot, slotIsLive } from "./displaySlots";
import { HUB_COUNT_ROOT } from "../../config/hubSneakerCount";
import { isCleanupHub } from "./hubCleanupCore";

export const CARD_VIA = "display_registration_card";

const regPath = (hub, pid, sizeKey) =>
  `${HUB_COUNT_ROOT}/register/${assertSafeSegment(hub, "hub")}/${assertSafeSegment(pid, "productId")}__${assertSafeSegment(sizeKey, "sizeKey")}`;

// The high-water mark: max of everything qty has ever been. addExtra's
// movement-id ladder climbs this, never the decrementable qty.
const highWater = (cur, newQty) => Math.max(Number(cur?.bumps) || 0, Number(cur?.qty) || 0, newQty);

const rowFor = (product, size, sizeKey, nowIso) => ({
  productId: product.id,
  productName: product.name || "",
  sizeKey,
  size: String(size),
  qty: 1,
  bumps: 1,
  at: nowIso,
  by: auth.currentUser?.uid || null,
  movementId: null,          // NO movement — the stock was booked by receiving
  via: CARD_VIA,
});

const slotWarning = (res, what) => {
  if (!res) return null;
  if (res.ok && res.superseded) return `${what}, but a newer slot write won the race — check the record and retry if it looks wrong.`;
  if (!res.ok) return `${what}, but the display slot could not be saved (${res.message || "write failed"}) — retry once.`;
  return null;
};

// Register one display fact for already-booked stock.
// Refuses a duplicate: the same store already holding a live slot of this
// size is "already registered" (slot refreshed, no qty bump), and a store-less
// re-registration of an existing row is refused outright — a blind bump
// invented an off-shelf unit the counters would then adjust real stock by.
export async function recordDisplayFact({ hub, product, size, store, slots = null }) {
  try {
    if (!isCleanupHub(hub)) return { ok: false, message: `Displays are booked at hub1/hub2 — not ${hub}.` };
    const sizeKey = stockSizeKey(String(size));
    if (sizeKey === "_") return { ok: false, message: "Pick a real size — one-size products have no display size." };
    const path = regPath(hub, product.id, sizeKey);
    const nowIso = serverNowIso();

    const existingSlot = store ? slots?.[store]?.[product.id] : null;
    if (store && slotIsLive(existingSlot) && existingSlot.sizeKey === sizeKey && existingSlot.bookedHub === hub) {
      // Same store, same size, already live: refresh the slot timestamp only.
      const res = await setDisplaySlot({
        store, productId: product.id, productName: product.name || "",
        size: String(size), bookedHub: hub, source: "registration",
      });
      return { ok: true, already: true, warning: slotWarning(res, "Already registered") };
    }

    const existing = (await get(ref(database, path))).val();
    if (existing && !store) {
      return { ok: false, message: "Already registered (shop not recorded). If this is a SECOND display, pick its shop; to fix the size, use Change size." };
    }

    await runTransaction(ref(database, path), (cur) => {
      if (cur === null) return rowFor(product, size, sizeKey, nowIso);
      const q = (Number(cur.qty) || 0) + 1;
      return { ...cur, qty: q, bumps: highWater(cur, q), retiredAt: null, at: nowIso, by: auth.currentUser?.uid || null };
    });

    let warning = null;
    if (store) {
      const res = await setDisplaySlot({
        store, productId: product.id, productName: product.name || "",
        size: String(size), bookedHub: hub, source: "registration",
      });
      warning = slotWarning(res, "Registered");
    }
    return { ok: true, warning };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

// Move the display fact from one size to another — the recheck correction.
// `slotStores`: the stores whose live slot currently shows fromSizeKey for
// this product at this hub; each is re-pointed to the new size.
export async function editDisplaySize({ hub, product, fromSizeKey, toSize, slotStores = [] }) {
  try {
    if (!isCleanupHub(hub)) return { ok: false, message: `Displays are booked at hub1/hub2 — not ${hub}.` };
    const toKey = stockSizeKey(String(toSize));
    if (toKey === "_") return { ok: false, message: "Pick a real size." };
    if (toKey === fromSizeKey) return { ok: false, message: "That is already the registered size." };
    const nowIso = serverNowIso();
    const fromRef = regPath(hub, product.id, fromSizeKey);
    const toRef = regPath(hub, product.id, toKey);
    const [fromSnap, toSnap] = await Promise.all([get(ref(database, fromRef)), get(ref(database, toRef))]);
    const fromRow = fromSnap.val();
    const toRow = toSnap.val();
    const fromQty = Number(fromRow?.qty) || 0;
    const toQty = (Number(toRow?.qty) || 0) + 1;
    const moved = {
      ...(toRow || rowFor(product, toSize, toKey, nowIso)),
      qty: toQty,
      bumps: highWater(toRow, toQty),
      retiredAt: null,
      at: nowIso,
      by: auth.currentUser?.uid || null,
      movementId: toRow?.movementId ?? null,
      // The audit of the correction — where the fact came from, and the old
      // row's movement linkage so nothing is lost even when the row empties.
      movedFrom: { sizeKey: fromSizeKey, movementId: fromRow?.movementId ?? null, at: nowIso, via: CARD_VIA },
    };
    const updates = {
      [toRef]: moved,
      // The source row is RETAINED at its floor — qty 0 keeps the movement
      // linkage and the bumps ladder; deletion is what broke both.
      [fromRef]: fromRow
        ? { ...fromRow, qty: Math.max(0, fromQty - 1), bumps: highWater(fromRow, fromQty),
            ...(fromQty <= 1 ? { retiredAt: nowIso } : {}), at: nowIso }
        : null,
    };
    await update(ref(database), updates);
    const warnings = [];
    for (const store of slotStores) {
      const res = await setDisplaySlot({
        store, productId: product.id, productName: product.name || "",
        size: String(toSize), bookedHub: hub, source: "registration",
      });
      const w = slotWarning(res, `Fixed at ${store}`);
      if (w) warnings.push(w);
    }
    return { ok: true, warning: warnings.join(" ") || null };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

// Retire a display fact (the display came down / never existed). The row is
// kept at qty 0 — never deleted — so movement linkage and the bumps ladder
// survive for the count lane and for addExtra's id derivation.
export async function removeDisplayFact({ hub, product, sizeKey, slotStores = [] }) {
  try {
    if (!isCleanupHub(hub)) return { ok: false, message: `Displays are booked at hub1/hub2 — not ${hub}.` };
    const path = regPath(hub, product.id, sizeKey);
    const nowIso = serverNowIso();
    await runTransaction(ref(database, path), (cur) => {
      if (cur === null) return null;   // nothing there — no-op commit
      const q = Number(cur.qty) || 0;
      const next = Math.max(0, q - 1);
      return { ...cur, qty: next, bumps: highWater(cur, q),
        ...(next === 0 ? { retiredAt: nowIso } : {}), at: nowIso, by: auth.currentUser?.uid || null };
    });
    const warnings = [];
    for (const store of slotStores) {
      const res = await clearDisplaySlot({ store, productId: product.id, source: "manual" });
      if (res && !res.ok) warnings.push(`The ${store} slot could not be cleared (${res.message || "write failed"}) — retry once.`);
    }
    return { ok: true, warning: warnings.join(" ") || null };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}
