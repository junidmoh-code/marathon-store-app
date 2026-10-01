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

import { ref, runTransaction } from "firebase/database";
import { database } from "../firebase";
import { saTodayKey } from "./serverTime";

export const getTodayKey = saTodayKey;

export async function getNextOrderNumber() {
  const todayKey = getTodayKey();
  const counterRef = ref(database, "orderCounter");
  const txResult = await runTransaction(counterRef, (current) => {
    if (!current || current.day !== todayKey) {
      return { day: todayKey, counter: 1 };
    }
    const next = current.counter >= 999 ? 1 : current.counter + 1;
    return { day: todayKey, counter: next };
  });
  const counter = txResult.snapshot.val()?.counter ?? 1;
  return String(counter).padStart(3, "0");
}
