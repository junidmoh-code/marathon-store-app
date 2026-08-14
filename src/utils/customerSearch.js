// Customer-list search filter (Customers view). Kept React-free so the
// find-by-any-phone-format contract is unit-tested directly: staff type a
// number in whatever dialect is handy (0…, 27…, +27…, bare 9-digit, or a
// mid-number fragment) and the filter must find the record however its phone
// was stored. Name matching stays a plain case-insensitive substring.

import { saSignificantDigits } from "./phone.js";

export function filterCustomerList(customerList, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return customerList;
  const qDigits = q.replace(/\D/g, "");
  const qSig = saSignificantDigits(q);
  return customerList.filter(c =>
    (c.name || "").toLowerCase().includes(q) ||
    (qDigits && (
      saSignificantDigits(c.phone).includes(qSig || qDigits) ||
      (c.phone || "").replace(/\D/g, "").includes(qDigits)
    ))
  );
}
