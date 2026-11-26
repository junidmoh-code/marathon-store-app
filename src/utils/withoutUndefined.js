// Firebase set()/update()/push() THROW synchronously when any value is
// `undefined` ("value argument contains undefined in property …"). A website
// order has no customerPhone, so an insights row built from it carried
// customerPhone: undefined and the throw escaped into a red banner on staff
// screens (Junid, 26 Nov 2026). This drops every undefined value, at any depth,
// and leaves null (a real "no value") alone. Pure.
export function withoutUndefined(value) {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : withoutUndefined(v)));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = withoutUndefined(v);
  return out;
}

// A Firebase write-argument error (undefined value, bad key) is a code bug to
// log quietly, never a banner a cashier or picker has to read (main.jsx).
export function isFirebaseArgumentError(msg) {
  return /(value|first|second) argument contains (undefined|NaN|an invalid key|a function)|argument contains undefined in property/i.test(String(msg ?? ""));
}
