// ─── MISSING PRODUCTS — HIDE (pure core, no firebase imports) ─────────────────
// A VIEW FILTER and nothing more. Hiding removes a stranded card from the
// Missing Products list and its chip counts on THIS screen; it changes no
// stock, no targets, no policy, and the engine never reads it — a hidden
// product still refills, still raises intents, still counts everywhere else.
// The invariance is pinned twice: functions/test/refill-hidden-invariance
// proves the engine's plan is byte-for-byte identical with the node present,
// and computeMissingProducts takes no hidden input at all (the filter runs
// strictly downstream of it, in HealthView).
//
// WHERE THE SET LIVES — /settings/missingProductsHidden/{pid}:
//   { at: <epoch ms>, by: <uid|null>, reason?: "awaiting_stock"|"seasonal" }
// One small node of its own (never a field on product records): the app
// subscribes to just this node, so the read cost is the node's own size —
// ~90 bytes per entry, ~45 KB at 500 hidden products — not a whole-tree read.
// /settings is the established home for app-owned feature state (stockHold,
// displaySlots, hubSneakerCount, productTaxonomy) and its live console rule
// already grants read to any authed user and write to non-anonymous users,
// so NO rules change and NO functions change is needed. The only /settings
// read in all of functions is settings/stockHold/held (refill-scan.cjs) —
// a scoped sibling read that can never see this node.
//
// THE STATE-CHANGE RULE (owner report, 2026-08-13): the hidden set is keyed
// by PRODUCT and follows the product, not the card. An entry persists until a
// human unhides it — nothing here expires or self-deletes:
//   • becomes solvable  → stays hidden (that is what hiding is for);
//   • sells out / collapses / gains shop carriage → the card retires from the
//     main list on its own; the entry sits inert and the hidden tab shows it
//     as NO LONGER MISSING for one-tap cleanup;
//   • re-strands later (a seasonal product coming back) → it returns HIDDEN,
//     not visible, because the entry is still there.
// Auto-purging resolved entries was rejected deliberately: a client-side
// purge races a half-loaded /stock snapshot (everything looks resolved for a
// moment → mass delete), and it would silently forget a "seasonal" hide the
// first time the product briefly gained a cell. The only writes to this node
// are human taps.

export const HIDDEN_ROOT = "settings/missingProductsHidden";

// The two owner-named reasons. Reason is OPTIONAL — hiding never blocks on it.
export const HIDE_REASONS = [
  { key: "awaiting_stock", label: "Waiting on this session's stock" },
  { key: "seasonal", label: "Seasonal" },
];
const REASON_KEYS = new Set(HIDE_REASONS.map((r) => r.key));
export const reasonLabel = (key) =>
  HIDE_REASONS.find((r) => r.key === key)?.label || "No reason given";

// The node entry for one hide. OMIT-DON'T-COPY on the optional field: an
// undefined reason must be ABSENT, never written — RTDB rejects undefined
// values inside multi-path updates and takes the whole batch down with them
// (the non-enforced save outage, PR #327). An unknown reason string is
// dropped the same way rather than stored.
export function hideEntry({ at, by, reason } = {}) {
  const e = { at: Number(at) || 0, by: by ?? null };
  if (REASON_KEYS.has(reason)) e.reason = reason;
  return e;
}

// One multi-path update hiding EXACTLY the given pids — bulk hide is this
// builder over the selected set, nothing else. Every pid gets the same entry
// (same at/by/reason: one gesture, one provenance).
export function bulkHideUpdate(pids, entryFields) {
  const entry = hideEntry(entryFields);
  const updates = {};
  for (const pid of pids || []) {
    if (pid) updates[`${HIDDEN_ROOT}/${pid}`] = entry;
  }
  return updates;
}

// One multi-path update unhiding exactly the given pids (null = delete).
export function unhideUpdate(pids) {
  const updates = {};
  for (const pid of pids || []) {
    if (pid) updates[`${HIDDEN_ROOT}/${pid}`] = null;
  }
  return updates;
}

// Split computeMissingProducts' card list into shown and hidden, preserving
// order. STRICTLY DOWNSTREAM of the compute and never mutating it — the same
// cards array, partitioned, reconstructs byte-for-byte (pinned in tests).
// A null/empty/unloaded hidden map fails OPEN: everything stays visible,
// because a failed read of a discretion filter must never hide real work.
export function partitionHidden(cards, hiddenMap) {
  const visible = [], hidden = [];
  for (const c of cards || []) {
    (hiddenMap && hiddenMap[c.pid] ? hidden : visible).push(c);
  }
  return { visible, hidden };
}

// The hidden tab's rows: every entry in the node, joined against the CURRENT
// card list so each row knows whether its product is still stranded. A row
// with no card is RESOLVED (sold out, collapsed, or now carried) — see the
// state-change rule above: it stays listed here, inert, until unhidden.
export function hiddenRows(hiddenMap, cards) {
  const byPid = new Map((cards || []).map((c) => [c.pid, c]));
  return Object.entries(hiddenMap || {}).map(([pid, e]) => ({
    pid,
    at: Number(e?.at) || 0,
    by: e?.by ?? null,
    reason: e?.reason && REASON_KEYS.has(e.reason) ? e.reason : null,
    card: byPid.get(pid) || null,
    resolved: !byPid.has(pid),
  }));
}

// Sort + filter for the hidden tab. reason: "all" | a reason key | "none"
// (hidden without a reason). sort: "newest" | "oldest" by date hidden.
export function sortAndFilterHidden(rows, { reason = "all", sort = "newest" } = {}) {
  let out = rows || [];
  if (reason === "none") out = out.filter((r) => !r.reason);
  else if (reason !== "all") out = out.filter((r) => r.reason === reason);
  return [...out].sort((a, b) => (sort === "oldest" ? a.at - b.at : b.at - a.at));
}
