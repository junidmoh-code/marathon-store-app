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

const one = async (path) => (await get(ref(database, path))).val();

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

    // ── "ALREADY REGISTERED" MEANS THE REGISTER ROW EXISTS ──────────────────
    // This used to be decided by the SLOT alone, and that is how 52 displays
    // ended up standing on shop floors that the register has never heard of
    // (measured 2026-09-07). A display refill writes the SLOT and no register
    // row; staff then open this card to register the pair properly, the guard
    // sees a live slot at the same store/size/hub, says "Already registered"
    // and writes nothing — so the row could never be created through the UI at
    // all, and every attempt reported success.
    //
    // Registration is a register ROW plus a slot. Both are checked now: the
    // early return is for a genuine duplicate, and a live slot with no row
    // falls through to the transaction below, which creates it.
    // The row check lives INSIDE the transaction below, for the same reason the
    // store-less one does: a pre-transaction get let two concurrent callers
    // both see "no row" and both bump. The first cut of this fix read the row
    // with its own `await` up here and walked straight back into that race
    // (CodeRabbit, and it is PR #460's finding a second time). All that is
    // decided out here is whether the SLOT agrees — a fact about data this
    // caller was handed, not a read that can go stale against itself.
    const existingSlot = store ? slots?.[store]?.[product.id] : null;
    const slotAgrees = !!(store && slotIsLive(existingSlot)
      && existingSlot.sizeKey === sizeKey && existingSlot.bookedHub === hub);

    // The store-less duplicate guard lives INSIDE the transaction: a
    // pre-transaction get let two concurrent store-less submissions both pass
    // and both bump (CodeRabbit, PR #460). Aborting on an existing row makes
    // the second submission fail deterministically whatever the interleaving.
    let already = false;
    const txn = await runTransaction(ref(database, path), (cur) => {
      if (cur === null) return rowFor(product, size, sizeKey, nowIso);
      if (!store) return undefined;   // exists + no store → abort, report duplicate
      // The slot already shows this exact display AND the row exists: this is
      // a re-registration of something wholly recorded, not a second physical
      // display. Abort rather than bump — deciding it in here is what makes it
      // safe against a concurrent caller.
      if (slotAgrees && (Number(cur.qty) || 0) > 0) { already = true; return undefined; }
      const q = (Number(cur.qty) || 0) + 1;
      return { ...cur, qty: q, bumps: highWater(cur, q), retiredAt: null, at: nowIso, by: auth.currentUser?.uid || null };
    });
    if (already) {
      // Refresh the slot's timestamp only, exactly as before.
      const res = await setDisplaySlot({
        store, productId: product.id, productName: product.name || "",
        size: String(size), bookedHub: hub, source: "registration",
      });
      return { ok: true, already: true, warning: slotWarning(res, "Already registered") };
    }
    if (!txn.committed) {
      return { ok: false, message: "Already registered (shop not recorded). If this is a SECOND display, pick its shop; to fix the size, use Change size." };
    }

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
    // A correction MOVES a live fact. A stale selection (the row was retired
    // or moved on another device since this screen loaded) must not mint a
    // destination fact out of nothing. (CodeRabbit, PR #460.)
    if (fromQty <= 0) {
      return { ok: false, message: "Nothing is registered at that size any more — the list may be stale; re-open the product." };
    }
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
//
// `units` retires more than one in ONE transaction, and `expectQty` guards it.
// Both exist for the Display Records screen (displayRecordCleanup.js), where an
// over-registered row retires only its SURPLUS — "3 claimed, 1 shop floor shows
// it, retire 2". Doing that as two unguarded calls was wrong twice over:
//
//   • it is not atomic, so a failure between them leaves a half-retired row;
//   • it cannot tell a stale view from a fresh one. Two admins both looking at
//     qty 3 would each retire 2 and take the row to 0 — wiping the legitimate
//     matched record, which then makes the next count expect a pair on the
//     shelf that is genuinely out at a shop and adjust a real unit away.
//
// With expectQty the second writer's transaction aborts and reports
// `superseded`, exactly like the display-slot fence. Omit both and the
// behaviour is byte-identical to before.
//
// THE TRANSACTION RESULT IS NOW READ. It never was: a transaction that did not
// commit returned a cheerful { ok: true }, so a caller could mark work done
// that had not happened.
export async function removeDisplayFact({ hub, product, sizeKey, slotStores = [], units = 1, expectQty = null }) {
  try {
    if (!isCleanupHub(hub)) return { ok: false, message: `Displays are booked at hub1/hub2 — not ${hub}.` };
    const path = regPath(hub, product.id, sizeKey);
    const nowIso = serverNowIso();
    const take = Math.max(1, Number(units) || 1);
    let stale = false;
    const txn = await runTransaction(ref(database, path), (cur) => {
      if (cur === null) return null;   // nothing there — no-op commit
      const q = Number(cur.qty) || 0;
      if (expectQty != null && q !== Number(expectQty)) { stale = true; return undefined; }
      const next = Math.max(0, q - take);
      return { ...cur, qty: next, bumps: highWater(cur, q),
        ...(next === 0 ? { retiredAt: nowIso } : {}), at: nowIso, by: auth.currentUser?.uid || null };
    });
    if (stale) {
      return { ok: true, superseded: true,
        message: "Someone else changed this display record while it was open — reopen the list and look again." };
    }
    if (txn && txn.committed === false) return { ok: true, superseded: true, message: "The display record was not changed — try again." };
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
