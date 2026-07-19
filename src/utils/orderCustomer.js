// Order-time customer identity for placeOrders: resolve the canonical
// customerId (0… phone key) and C-number BEFORE the order is written, so the
// POS loads the customer instead of re-resolving by phone at the till.
//
// resolveCustomerKey lives here (moved out of App.jsx) so the whole
// resolve → reserve → claim → upsert flow is unit-testable with a mocked
// Firebase layer. The keying rules are unchanged from PR-1: existing records
// are found under any key dialect (phoneKeyVariants); new records mint at the
// canonical local 0-form key (customerWriteKey).

import { get, ref, update, runTransaction } from "firebase/database";
import { database } from "../firebase.js";
import { phoneKeyVariants, customerWriteKey } from "./phone.js";
import { isValidCustomerCode, reserveNextCode } from "./customerCodes.js";

// Resolve the key an existing record for this phone lives under (any variant,
// typed shape first), or the canonical local 0-form key (customerWriteKey)
// when none exists yet. Returns { key, existing } so callers keep their single
// read.
export async function resolveCustomerKey(phone) {
  const variants = phoneKeyVariants(phone);
  if (variants.length === 0) return { key: "unknown", existing: null };
  for (const key of variants) {
    const snap = await get(ref(database, `customers/${key}`));
    const val = snap.val();
    if (val) return { key, existing: val };
  }
  return { key: customerWriteKey(phone), existing: null };
}

// The trimmed, validated code on a customer record, or null (mirrors the
// POS's readCustomerCode — a malformed value is treated as "no code").
function readExistingCode(existing) {
  const c = existing?.code;
  if (typeof c !== "string") return null;
  const trimmed = c.trim();
  return isValidCustomerCode(trimmed) ? trimmed : null;
}

// ensureOrderCustomer(phone, name, orderedAt, optedIn)
//   → Promise<{ customerId, customerCode } | null>
//
// Resolves the customer, guarantees a C-number, and upserts the record's
// order bookkeeping — the single customer write at order time. Returns null
// only when the phone has no usable digits (caller treats it like refill).
// THROWS on any Firebase failure — wrap with resolveOrderCustomer in the
// order path, which must never block placement.
//
// Race safety: the code is CLAIMED by an abort-if-taken transaction on
// customers/{key}/code. Two near-simultaneous orders for the same phone both
// resolve (maybe both reserve a counter value), but only one claim commits —
// the loser aborts, reads the winner's code, and carries THAT code onto its
// order. One customer, one code; the losing reservation is gapped (the same
// accepted trade-off as the POS's reserve-then-write).
export async function ensureOrderCustomer(phone, name, orderedAt, optedIn) {
  const { key, existing } = await resolveCustomerKey(phone);
  if (key === "unknown") return null;

  let code = readExistingCode(existing);
  if (!code) {
    const { code: reserved } = await reserveNextCode();
    const claim = await runTransaction(ref(database, `customers/${key}/code`), (current) => {
      const cur = typeof current === "string" ? current.trim() : null;
      return cur && isValidCustomerCode(cur) ? undefined : reserved; // undefined aborts
    });
    code = claim.committed ? reserved : String(claim.snapshot.val()).trim();
  }

  const ex = existing || {};
  const patch = {
    // Keep the phone format the record already has — rewriting a POS "065…"
    // record's phone to the order's "2765…" would desync the field from its
    // key for no gain (search matches both shapes canonically).
    phone: ex.phone || phone,
    name: name || ex.name || "",
    firstOrderAt: ex.firstOrderAt || orderedAt,
    lastOrderAt: orderedAt,
    orderCount: (ex.orderCount || 0) + 1,
  };
  // Only ever sets optedIn: true — never reverts an existing true to false.
  if (optedIn) patch.optedIn = true;
  try {
    await update(ref(database, `customers/${key}`), patch);
  } catch (err) {
    // The identity (key + code) is already safely claimed — the order must
    // still carry it. Bookkeeping is best-effort; the next order re-patches.
    console.warn("ensureOrderCustomer bookkeeping upsert failed (identity still resolved):", err);
  }

  return { customerId: key, customerCode: code };
}

// Cap on how long identity resolution may hold up checkout. RTDB transactions
// retry silently on flaky connections and can hang without ever rejecting —
// that must not stall order placement, so a hang resolves as "pending".
const RESOLVE_TIMEOUT_MS = 5000;

// Never-throwing wrapper for placeOrders. Returns:
//   { customerId, customerCode } — resolved/created, carry onto the order
//   { customerPending: true }    — resolution failed or timed out; order
//                                  still writes, POS falls back to its own
//                                  phone-key lookup
//   null                         — no usable phone (refill-like; no fields)
export async function resolveOrderCustomer(phone, name, orderedAt, optedIn) {
  let timer;
  try {
    return await Promise.race([
      ensureOrderCustomer(phone, name, orderedAt, optedIn),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          console.warn(`resolveOrderCustomer timed out after ${RESOLVE_TIMEOUT_MS}ms — order proceeds without customer identity`);
          resolve({ customerPending: true });
        }, RESOLVE_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.warn("resolveOrderCustomer failed — order proceeds without customer identity:", err);
    return { customerPending: true };
  } finally {
    // Clear the timeout however the race settled — otherwise every successful
    // checkout logs a spurious "timed out" warning 5s later.
    clearTimeout(timer);
  }
}
