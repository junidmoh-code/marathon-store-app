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
    // a partial number) while the record KEY holds the real digits. When the
    // field cannot be normalised we fall back to the key for BOTH the identity
    // and the displayed value — using the key for one and the junk field for the
    // other would render a name in the phone column and leave the record
    // unsearchable by number, defeating the rescue.
    const phoneFromField = normalizeSAPhone(c.phone);
    const normalised = phoneFromField || normalizeSAPhone(key);
    if (!normalised) continue;

    const candidate = {
      name: (c.name || "").trim(),
      phone: phoneFromField ? c.phone : key,
      lastOrderAt: c.lastOrderAt || "",
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
    .map(({ name, phone, lastOrderAt }) => ({ name, phone, lastOrderAt }));
}
