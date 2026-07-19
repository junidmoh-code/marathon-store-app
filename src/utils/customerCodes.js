// Customer code ("C-number") format helpers + atomic reservation.
//
// Mirrors marathon-pos-app's src/customers/customerCode.js and
// codeAssignment.js EXACTLY — same counter path (/customers_meta/lastCode),
// same transaction semantics, same C- format — so a code reserved here and a
// code reserved at the till come from one shared counter and one format.
// Do NOT diverge: no second counter, no local format variant.
//
// Format: "C-1001" — fixed prefix + zero-padded number, minimum 4 digits
// (grows naturally past it). Counter starts at 1000, so the first code ever
// issued is C-1001.

import { ref, runTransaction } from "firebase/database";
import { database } from "../firebase.js";

const PREFIX = "C-";
const MIN_DIGITS = 4;
export const STARTING_COUNTER = 1000;

// formatCustomerCode(1042) → "C-1042" | (7) → "C-0007" | (12345) → "C-12345".
// Returns null for non-positive / non-integer / non-finite input so a corrupt
// counter read can't produce "C-NaN".
export function formatCustomerCode(n) {
  if (!Number.isInteger(n) || n < 1) return null;
  return `${PREFIX}${String(n).padStart(MIN_DIGITS, "0")}`;
}

// parseCustomerCode("C-1042") → 1042 | ("c-1042") → 1042 | ("1042") → null.
// Returns the integer counter value, or null for anything that doesn't look
// like a customer code.
export function parseCustomerCode(code) {
  if (typeof code !== "string") return null;
  const m = /^[cC]-(\d+)$/.exec(code.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

// Quick boolean check for "is this a well-formed customer code?".
export function isValidCustomerCode(code) {
  return parseCustomerCode(code) !== null;
}

// reserveNextCode() → Promise<{ counter, code }>
//
// /customers_meta/lastCode holds the highest counter ever issued. Read →
// increment → write via runTransaction so concurrent reserves can't collide:
//   - null (first ever call) → bootstrap to STARTING_COUNTER + 1
//   - integer N ≥ STARTING_COUNTER → N + 1
//   - anything else (corrupt) → reset to STARTING_COUNTER + 1
//
// Crash-safety: if the counter is reserved but the later record write fails,
// the code is "gapped" (skipped forever) — the accepted trade-off, same as
// the POS.
export async function reserveNextCode() {
  const counterRef = ref(database, "customers_meta/lastCode");
  const result = await runTransaction(counterRef, (current) => {
    if (typeof current === "number" && Number.isInteger(current) && current >= STARTING_COUNTER) {
      return current + 1;
    }
    return STARTING_COUNTER + 1;
  });
  if (!result.committed) {
    throw new Error("Customer code transaction did not commit");
  }
  const counter = result.snapshot.val();
  const code = formatCustomerCode(counter);
  if (!code) {
    throw new Error(`Customer code counter resolved to non-formatable value: ${counter}`);
  }
  return { counter, code };
}
