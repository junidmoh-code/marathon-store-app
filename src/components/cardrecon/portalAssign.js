// ─── AN UNASSIGNED SIMPLYBLU TERMINAL → THE MAPPING EDITOR, ONE TAP ──────────
// The portal pull (functions/cardRecon/cardPortal.js) keeps every TID the
// SimplyBLU portal shows that the registry does not know; the settings sheet
// gets them from cardTerminalAdmin "options" (the store app reads no card-recon
// node itself — captureOnly.test.js). Junid assigns one with the existing
// terminal settings sheet's "Add" — prefilled with the TID, Standard Bank and
// the merchant number.
//
// THE POS's Card Recon links here with #card-assign=<TID>: consumed before
// React mounts (like #bt-pair), it opens Card machines with the sheet open on
// that TID. The link carries a TID and nothing else — no figure, no token.

export const ASSIGN_HASH_KEY = "card-assign";
export const ASSIGN_STORE_KEY = "marathon.cardAssign";
export const ASSIGN_TTL_MS = 10 * 60 * 1000;
const TID_RE = /^[A-Z0-9]{4,16}$/;
const CARD_RECON_ROLE = "card_recon";

/** "#card-assign=0000new1" → "0000NEW1", or null. */
export function assignTidFromHash(hash) {
  const m = /^#?card-assign=([A-Za-z0-9]{4,16})$/.exec(String(hash || ""));
  const tid = m ? m[1].toUpperCase() : null;
  return tid && TID_RE.test(tid) ? tid : null;
}

/** Called once before React mounts. Returns the TID taken, or null. */
export function consumeAssignHash({ location = globalThis.location, history = globalThis.history, storage = globalThis.localStorage, nowMs = Date.now() } = {}) {
  const tid = assignTidFromHash(location && location.hash);
  if (!tid) return null;
  try {
    storage.setItem(ASSIGN_STORE_KEY, JSON.stringify({ tid, at: nowMs }));
    storage.setItem("marathon_role", CARD_RECON_ROLE);
  } catch { /* storage blocked: the link simply does nothing */ }
  try { history.replaceState(null, "", location.pathname + location.search); } catch { /* best effort */ }
  return tid;
}

/** The pending assign request (once, then cleared), or null when none or stale. */
export function takeAssignRequest({ storage = globalThis.localStorage, nowMs = Date.now() } = {}) {
  let v = null;
  try { v = JSON.parse(storage.getItem(ASSIGN_STORE_KEY) || "null"); storage.removeItem(ASSIGN_STORE_KEY); } catch { return null; }
  if (!v || !TID_RE.test(String(v.tid || "")) || !Number.isFinite(v.at) || nowMs - v.at > ASSIGN_TTL_MS || v.at > nowMs + 60000) return null;
  return v.tid;
}

/** The unassigned node → rows, newest sighting first. */
export function unassignedRows(node) {
  return Object.entries(node || {})
    .filter(([, v]) => v && typeof v === "object" && typeof v.tid === "string")
    .map(([key, v]) => {
      const days = Object.entries(v.days || {}).sort(([a], [b]) => (a < b ? 1 : -1));
      const [lastDay, last] = days[0] || [null, null];
      return {
        key, tid: v.tid.toUpperCase(), merchantNo: v.merchantNo || null, business: v.business || null,
        firstSeenAt: v.firstSeenAt ?? null, lastSeenAt: v.lastSeenAt ?? null,
        lastDay, lastDayCents: last && Number.isInteger(last.cents) ? last.cents : null, lastDayTxns: last ? last.txns ?? null : null,
      };
    })
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
}

/** Is this unassigned row already in the registry (assigned since it was seen)? O/0 and leading zeros fold. */
const canon = (t) => String(t || "").toUpperCase().replace(/O/g, "0").replace(/I/g, "1").replace(/^0+(?=.)/, "");
export function isAssigned(row, registry) {
  return Object.keys(registry || {}).some((k) => canon(k) === canon(row.tid));
}
