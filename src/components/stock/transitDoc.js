// ─── THE TRANSIT DOC'S FIRST WRITE ────────────────────────────────────────────
// Transfer.jsx creates /transfers/{tId} (with its full manifest) before the
// first line moves. This builds that one root-level update() patch.
//
// The device stamp goes INSIDE the doc (stampRecord), never beside it as a
// `transfers/{tId}/stamps/…` path: an update() that holds a path AND one of
// its descendants is refused by the Firebase SDK on the device. That is
// exactly what broke every Central cross-building send on 24–26 Nov 2026
// (see transitDocOverlap.diagnose.test.js).

import { stampRecord } from "../../device/deviceStamp";
import { stockSizeKey } from "../../utils/sizeKey";

// lines: [{ productId, size, qty }] → { [productId]: { [sizeKey]: qty } }
export function transitManifest(lines) {
  const out = {};
  for (const ln of lines || []) {
    if (!out[ln.productId]) out[ln.productId] = {};
    out[ln.productId][stockSizeKey(ln.size)] = ln.qty;
  }
  return out;
}

export function transitDocCreatePatch({ tId, from, to, lines, createdAt, createdBy }) {
  const doc = {
    status: "dispatched", from, to, reason: "manual",
    createdAt, createdBy: createdBy || null,
    lines: transitManifest(lines),
  };
  return { [`transfers/${tId}`]: stampRecord(doc, "dispatch") };
}

// The real reason behind a failed write, short enough for a toast:
// "PERMISSION_DENIED", an SDK message, or a thrown client check.
export function errorReason(e) {
  if (!e) return "unknown error";
  const code = e.code ? String(e.code).replace(/^database\//, "") : "";
  const msg = String(e.message || e).replace(/^(FIREBASE WARNING:|Error:)\s*/i, "").trim();
  const text = code && !msg.toUpperCase().includes(code.toUpperCase()) ? `${code}: ${msg}` : (msg || code);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

// When the database refused the write, name the account's stock role — the
// live rules let only warehouse|store|admin move stock, and an account opened
// into Stock by the stock_management permission alone is refused (26 Nov 2026).
export function deniedHint(e, role) {
  const text = `${e?.code || ""} ${e?.message || ""}`;
  if (!/permission[_ ]denied/i.test(text)) return "";
  if (role === "warehouse" || role === "store" || role === "admin") return "";
  return ` · this account's stock role is ${role ? `"${role}"` : "not set"} — moving stock needs warehouse, store or admin`;
}
