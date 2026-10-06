// ─── THE DAILY SNEAKER ORDER NUMBER ──────────────────────────────────────────
//
// Extracted from App.jsx unchanged (2026-09-08) so a SECOND surface can draw an
// order number without a second copy of the transaction. The wall-walk "Request
// Display" on the Unregistered Displays tab raises an ordinary display-partner
// request, and an ordinary request carries an ordinary order number — a private
// copy of this rule is how two number spaces drift apart and two orders end up
// sharing a key.
//
// The rule itself is untouched, including the parts that look odd and are not:
//   • the day key is the SOUTH AFRICAN date (saTodayKey), anchored to server
//     time — the 2026-07 counter incident was a UTC day key rolling over at
//     02:00 local and handing two customers the same number;
//   • 999 wraps back to 1 rather than growing, because the number is written on
//     a shoebox and read off a TV;
//   • it is a transaction, so two assistants tapping at once get two numbers.
//
// PER-STORE NUMBERS (sections, 2026-10). Marathon PE and Trophy — and every
// caller that names no shop — draw from /orderCounter exactly as above. A shop
// with a number prefix in the network registry (Pine "P", Concrete "C") draws
// from its OWN counter, /orderCounter_byStore/{shop}, and its number carries
// the prefix ("P001"), so it can never collide with a shared key. The shapes
// and the paths are src/utils/orderNumbering.js; this file only runs the
// transaction.

import { ref, runTransaction } from "firebase/database";
import { database } from "../firebase";
import { saTodayKey } from "./serverTime";
import { currentNetwork } from "./networkStore";
import {
  orderPrefixFor, orderCounterPath, refillCounterPath,
  nextCounterValue, formatOrderKey, formatRefillNumber,
} from "./orderNumbering";

export const getTodayKey = saTodayKey;

async function drawCounter(path) {
  const todayKey = getTodayKey();
  const txResult = await runTransaction(ref(database, path), (current) => nextCounterValue(current, todayKey));
  return txResult.snapshot.val()?.counter ?? 1;
}

// `shop` is the order's destShop. Omitted / Marathon PE / Trophy → the shared
// sequence, "001".
export async function getNextOrderNumber(shop = null) {
  const network = currentNetwork();
  const prefix = orderPrefixFor(network, shop);
  return formatOrderKey(prefix, await drawCounter(orderCounterPath(network, shop)));
}

// ─── THE DAILY REFILL-CART NUMBER ────────────────────────────────────────────
// Moved here from App.jsx so both counters share one transaction body. ONE
// R-number per refill CART; the per-line /orders keys are `${number}-${i}`.
// Shared: "R001". Pine: "RP001", from /refillCounter_byStore/marathon-pine.
export async function getNextRefillNumber(shop = null) {
  const network = currentNetwork();
  const prefix = orderPrefixFor(network, shop);
  return formatRefillNumber(prefix, await drawCounter(refillCounterPath(network, shop)));
}
