// ─── LAYBY CROSS-APP CONTRACT (warehouse side) ───────────────────────────────
// Constants + pure helpers for the warehouse half of the layby system. The RTDB
// shape is the SHARED contract documented in SCHEMA.md (/laybys, /laybyPulls):
//   • marathon-pos-app writes the layby record (creation) and pull requests.
//   • this app (warehouse) writes the receiving / sent / reject transitions.
// Everything here tolerates absent fields — the POS writer may lag and migrated
// laybys carry their original old-POS data.
//
// IDENTITY: a layby's single identity everywhere (cards, TV, QR, search) is its
// INVOICE NUMBER (`invoiceNo`, e.g. "L-00045"; migrated laybys keep their old
// invoice numbers, which may not follow the L-NNNNN shape). The node key is the
// stable `laybyId`. There is no "LB number".
//
// LOCATIONS: ids are the canonical /locations registry ids (warehouses
// studio/central/base, hubs hub1/hub2/hub3 + stores marathon-pe/marathon-pine/
// trophy). The POS side translates its informal pine|pe|trophy vocabulary to these
// before writing.
// Money is in CENTS (POS convention); divide by 100 for ZAR display.

// Full layby lifecycle, on /laybys/{laybyId}.status. Happy path is linear;
// `expired` and `rejected` are the two off-ramps.
import { currentNetwork } from "../../utils/networkStore";
import { fallbackHub } from "../../utils/sectionRouting";

export const LAYBY_STATUS = {
  CREATED:        "created",            // POS: layby taken
  LABEL_PRINTED:  "labelPrinted",       // POS: parcel label printed
  IN_TRANSIT:     "inTransitToStorage", // POS: dispatched to storage, awaiting scan-in
  STORED:         "storedAtHub",        // WAREHOUSE: scanned/received into a hub
  PULL_REQUESTED: "pullRequested",      // POS: a store requested it back
  SENT:           "sentToStore",        // WAREHOUSE: pulled and sent to the store
  COLLECTED:      "collected",          // POS: customer collected
  EXPIRED:        "expired",            // past due date / forfeited
  REJECTED:       "rejected",           // WAREHOUSE: pull rejected (expired layby)
  RETURNED:       "returned",           // POS: layby cancelled → return-to-stock requested.
                                        // The warehouse RTS action resolves the PULL only and
                                        // deliberately leaves /laybys at "returned".
};

// Pull request state, on /laybyPulls/{pullId}.status.
export const PULL_STATUS = {
  PENDING:           "pending",
  SENT:              "sentToStore",
  REJECTED:          "rejected",
  RETURNED_TO_STOCK: "returnedToStock", // WAREHOUSE: a return_to_stock pull resolved (pulled,
                                        // label removed, units returned to stock).
};

// A pull's status, with an absent value read as PENDING (the POS always writes
// one, but a hand-made or legacy record might not).
export function pullStatusOf(pull) {
  return pull?.status || PULL_STATUS.PENDING;
}

// RESOLVED = the warehouse has already acted on this pull (Sent, Rejected or
// Returned to stock). A resolved pull is HISTORY: it is still listed (Ready /
// All, Today's group) but it must never offer Sent / Reject / Return again.
// Before 31 Oct 2026 the queue card ignored the status and kept both buttons on
// a pull that was already sent — the "Sent does not clear it" report — and a
// second tap could overwrite the outcome (L-00350, Hub 3, 5 Sep: sent 12:49,
// then rejected 12:59 from the same stale card).
export function isPullResolved(pull) {
  return pullStatusOf(pull) !== PULL_STATUS.PENDING;
}

// The warehouse MAIN queue's row for one pull at `hub` (null = not on that
// hub's queue). A pending pull is current-day Incoming work — bucketed at
// `nowIso` so the queue's 3-day window can never hide it; a SENT pull is a
// Ready row dated by its sentAt, so it lands in Today's group (history) and its
// card shows the outcome, never the buttons. Rejected / returned-to-stock are
// resolved and leave the queue. `status` values are App.jsx's STATUS strings.
export const QUEUE_INCOMING = "incoming";
export const QUEUE_READY = "ready";
export function laybyQueueRow(p, hub, nowIso, network = currentNetwork()) {
  if (!p || !p.invoiceNo || storageHubOf(p, network) !== hub) return null;
  const st = pullStatusOf(p);
  if (st === PULL_STATUS.PENDING) return { id: p.invoiceNo, status: QUEUE_INCOMING, isLayby: true, _pull: p, createdAt: nowIso };
  if (st === PULL_STATUS.SENT)    return { id: p.invoiceNo, status: QUEUE_READY, isLayby: true, _pull: p, readyAt: p.sentAt, updatedAt: p.sentAt, createdAt: p.sentAt || p.requestedAt || "" };
  return null;
}

// Pull disposition, on /laybyPulls/{pullId}.disposition (POS-written).
//   collect          → customer is collecting (default path: Sent / Reject).
//   return_to_stock  → layby cancelled; warehouse pulls, removes the label, and
//                      returns units to stock. Absent ⇒ collect (backward-compat).
export const DISPOSITION = {
  COLLECT:         "collect",
  RETURN_TO_STOCK: "return_to_stock",
};

// Resolve a pull's disposition, defaulting to COLLECT when the field is absent
// or anything other than the explicit return_to_stock value. This is the single
// backward-compat gate: legacy pulls (no field) and "collect" both take the
// existing collect path; only "return_to_stock" branches to the new path.
export function dispositionOf(pull) {
  return pull?.disposition === DISPOSITION.RETURN_TO_STOCK
    ? DISPOSITION.RETURN_TO_STOCK
    : DISPOSITION.COLLECT;
}

export const DEFAULT_STORAGE_HUB = "hub1";

// The hub a layby (or a pull) is stored at. The POS stamps storageHub on every
// new record. One WITHOUT it is from before that: it belongs to Hub 1, as it
// always has — unless the record names a store outside Marathon PE / Trophy,
// in which case Hub 1 is across the section wall and the store's own
// back-stock hub is the answer (null if the registry has none: it then shows
// on no hub's list rather than on the wrong section's).
export function storageHubOf(x, network = currentNetwork()) {
  if (x?.storageHub) return x.storageHub;
  return fallbackHub(network, x?.storeId || x?.issuingStore || null, DEFAULT_STORAGE_HUB);
}

// Coerce an epoch-ms number OR an ISO/date string to epoch ms. Returns NaN when
// unparseable so callers can guard. POS may write either form for time fields.
export function toMs(val) {
  if (val == null) return NaN;
  if (typeof val === "number") return val;
  const t = new Date(val).getTime();
  return Number.isNaN(t) ? NaN : t;
}

// Cents → "R1,234.00". Absent/non-numeric balance renders as a dash so the card
// never shows "RNaN".
export function formatLaybyMoney(cents) {
  if (typeof cents !== "number" || Number.isNaN(cents)) return "—";
  return "R" + (cents / 100).toLocaleString("en-ZA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// A layby is an EXCEPTION when it was dispatched but never scanned in and its
// scan deadline has passed — i.e. potentially missing in transit. No deadline =>
// not (yet) an exception (we can't judge it).
export function isLaybyException(layby, nowMs) {
  if (!layby || layby.status !== LAYBY_STATUS.IN_TRANSIT) return false;
  const deadline = toMs(layby.scanDeadline);
  if (Number.isNaN(deadline)) return false;
  return nowMs >= deadline;
}

// Expired = past the layby due date (end of the dueDate day). Drives the
// REJECT-with-reason path on pull requests. dueDate is a local YYYY-MM-DD.
export function isPullExpired(dueDate, nowMs) {
  if (!dueDate) return false;
  const due = new Date(`${dueDate}T23:59:59`).getTime();
  if (Number.isNaN(due)) return false;
  return nowMs > due;
}

// Human age like "2h", "3d", "just now" from an epoch-ms / ISO value.
export function ageLabel(val, nowMs) {
  const t = toMs(val);
  if (Number.isNaN(t)) return "";
  const mins = Math.max(0, Math.floor((nowMs - t) / 60000));
  if (mins < 1)   return "just now";
  if (mins < 60)  return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

// Normalise an invoice number for matching (trim + uppercase). NOT reformatted —
// migrated old-POS invoice numbers may not be L-NNNNN, so we never reshape them.
export function normalizeInvoiceNo(raw) {
  return String(raw || "").trim().toUpperCase();
}

// Decode a scanned parcel-label QR or a hand-typed value into { laybyId,
// invoiceNo }. QR payload is JSON {v:1, laybyId, invoiceNo}; anything that isn't
// that JSON is treated as a typed invoice number.
export function parseLaybyScan(raw) {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && (obj.laybyId || obj.invoiceNo)) {
      return {
        laybyId:   obj.laybyId ? String(obj.laybyId) : null,
        invoiceNo: obj.invoiceNo ? normalizeInvoiceNo(obj.invoiceNo) : null,
      };
    }
  } catch { /* not JSON — fall through to bare invoice number */ }
  return { laybyId: null, invoiceNo: normalizeInvoiceNo(raw) };
}
