// ─── CUSTOMER AUTOCOMPLETE INDEX — one phone→name entry per customer ─────────
//
// THE production reducer behind useCustomerIndex (App.jsx). It lives here, not
// inline in the hook, because the tests must exercise THIS code: the first
// version kept the reducer in the hook and a re-implementation in the test file,
// and the two drifted — the test normalised `c.phone || key` (fallback BEFORE
// normalising) while the hook normalised each separately, so a real bug in the
// hook's fallback passed 718 tests (CodeRabbit, PR #300).
//
// SOURCE: /customers (1.12 MB). It used to be derived from /insights_log
// (18.73 MB per Store Assistant mount) — see docs/insights-log-investigation.md.
//
// FIELDS: `phone` and `name` only. `lastOrderAt` is carried for ORDERING ONLY
// (matchCustomers sorts newest-first on it); `orderCount` is never derived.

import { normalizeSAPhone } from "../utils/phone";

// A COMPLETE canonical SA number: normalizeSAPhone always emits "+27" + 9
// national digits for a real one. Checked against the normalised value rather
// than via toLocalSA(), which would treat a bare 9-digit FOREIGN number
// ("+656996104") as if it were SA and defeat the point.
//
// Why completeness matters here: normalizeSAPhone happily turns partial input
// into a non-empty string ("071" → "+2771"), so a truthy result is NOT evidence
// of a usable number. Without this the key fallback below is skipped whenever
// the `phone` field holds *any* digits, losing customers whose record key is the
// only complete number they have (CodeRabbit, PR #300).
const isCompleteSAPhone = (normalised) => /^\+27\d{9}$/.test(normalised || "");

/**
 * Which of two records representing the SAME normalised number wins.
 * Total order, so the winner never depends on Object.entries() iteration order:
 *   1. a non-empty name
 *   2. the most recent lastOrderAt
 *   3. the international ("27…") key form
 *   4. lexically smaller key — the final tie-break that makes this deterministic
 */
export function beatsHeldCustomer(candidate, held) {
  const cNamed = !!candidate.name, hNamed = !!held.name;
  if (cNamed !== hNamed) return cNamed;

  const cLast = candidate.lastOrderAt || "", hLast = held.lastOrderAt || "";
  if (cLast !== hLast) return cLast > hLast;

  const cKey = String(candidate._key ?? ""), hKey = String(held._key ?? "");
  const cIntl = cKey.startsWith("27"), hIntl = hKey.startsWith("27");
  if (cIntl !== hIntl) return cIntl;

  return cKey < hKey;
}

/**
 * Map of normalised phone → winning record. Keyed by the normalised number, so
 * two entries for the same customer are impossible by construction.
 * @param {Record<string, object>} customersDb raw /customers node
 * @returns {Map<string, {name,phone,lastOrderAt,_key}>}
 */
export function indexCustomersByPhone(customersDb) {
  const byPhone = new Map();
  for (const [key, c] of Object.entries(customersDb || {})) {
    if (!c || typeof c !== "object") continue;

    // The `phone` FIELD is preferred, but some records carry junk there (a name,
    // a partial number, a malformed international) while the record KEY holds the
    // real digits. Preference order:
    //   1. the field, if it is a COMPLETE SA number
    //   2. the key, if IT is complete            ← rescues those records
    //   3. whichever normalises to anything at all, field first — a partial
    //      number is still better than dropping the customer entirely
    // Identity and the displayed value always come from the SAME source: using
    // the key for one and the junk field for the other would render a name in
    // the phone column and leave the record unsearchable by number.
    const fieldPhone = normalizeSAPhone(c.phone);
    const keyPhone = normalizeSAPhone(key);
    const useField = isCompleteSAPhone(fieldPhone)
      || (!isCompleteSAPhone(keyPhone) && !!fieldPhone);
    const normalised = useField ? fieldPhone : keyPhone;
    if (!normalised) continue;

    const candidate = {
      name: (c.name || "").trim(),
      phone: useField ? c.phone : key,
      lastOrderAt: c.lastOrderAt || "",
      // DISPLAY ONLY — the suggestion row prints "N past orders". Copied verbatim
      // from /customers; never derived here and never used in any decision (not
      // in the winner rule, not in ordering, not in filtering). The log-derived
      // index used to COUNT `placed` events, one per unit, so its figure was
      // inflated for multi-item purchases; /customers counts orders.
      orderCount: Number.isFinite(c.orderCount) ? c.orderCount : 0,
      _key: key,
    };
    const held = byPhone.get(normalised);
    if (!held || beatsHeldCustomer(candidate, held)) byPhone.set(normalised, candidate);
  }
  return byPhone;
}

/**
 * The array the autocomplete consumes. Nameless records are dropped — they would
 * render a blank suggestion row, exactly as the log-derived index dropped events
 * with no customerName.
 */
export function buildCustomerIndex(customersDb) {
  return Array.from(indexCustomersByPhone(customersDb).values())
    .filter(c => c.name)
    .map(({ name, phone, lastOrderAt, orderCount }) => ({ name, phone, lastOrderAt, orderCount }));
}

/**
 * Suggestion ordering: most recently ordered first. THE comparator matchCustomers
 * sorts with — exported so the ordering is testable in the layer that owns it,
 * rather than asserted indirectly through the reducer.
 * A customer with no lastOrderAt sorts LAST (missing/invalid dates coerce to 0),
 * never ahead of someone with a real one.
 */
export function byMostRecentOrder(a, b) {
  return orderMs(b?.lastOrderAt) - orderMs(a?.lastOrderAt);
}

// Mirrors App.jsx's tsMs contract: null / "" / unparseable → 0.
function orderMs(v) {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : new Date(v).getTime();
  return Number.isNaN(n) ? 0 : n;
}
