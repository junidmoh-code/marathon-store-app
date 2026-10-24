// ─── DISPLAY CHECKS — TODAY FEED MODEL (pure, testable) ───────────────────────
// The read side of the active-index rework (PR 5). The Today feed is assembled
// from TWO live sources and this file is the pure reducer over them — no React,
// no Firebase, so the partitioning + counting logic is unit-tested in isolation
// (feedModel.test.js).
//
//   SOURCE A  /displayChecks_active/{store}/{dedupeKey}   the never-null active
//             index: one record per SKU, status held | open | completed. A
//             `completed` record here is a transient TOMBSTONE (overwritten by
//             the next sale, reaped by the sweep) — it is NOT today's confirmed
//             work and is deliberately dropped from every section (window #1:
//             we key on the STATUS field, never on "present in the index").
//   SOURCE B  /displayChecks/{store}/{saDate}/{checkId}    the day node: the
//             permanent archive a check lands in when it COMPLETES. This is the
//             authoritative "Confirmed / No Stock" list for the day.
//
// Three sections, matching the design (§10/§11):
//   • outstanding  — open checks, the work you can act on. Denominator of the day.
//   • waiting      — held checks (sold with no stock). NOT in the completion
//                    denominator and never marked — a muted "Waiting on stock".
//   • completed    — day-node records, each carrying its own result tag.
//
// Held checks are excluded from `assigned`/`done` on purpose: a held check is
// nobody's failure to action (design §2, §8.10).

import { ONLINE_PICK_KIND, ONLINE_RETURN_KIND } from "../../utils/onlineOrders";

// SA-time "HH:MM" for a sale/complete timestamp. Accepts an ISO string (movement
// ts) or an epoch-ms number (createdAt/completedAt). Timezone is pinned to
// Africa/Johannesburg so the device clock never enters. Invalid → "".
export function formatSaTime(tsIsoOrMs) {
  if (tsIsoOrMs == null || tsIsoOrMs === "") return "";
  const d = typeof tsIsoOrMs === "number" ? new Date(tsIsoOrMs) : new Date(String(tsIsoOrMs));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-GB", {
    hour12: false, hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg",
  });
}

// A stable descending sort by a chosen timestamp field (epoch-ms number or ISO
// string), newest first. Missing/invalid timestamps sink to the bottom. Returns
// a NEW array — never mutates the input.
function sortByTsDesc(items, field) {
  const ms = (v) => {
    if (v == null || v === "") return -Infinity;
    const n = typeof v === "number" ? v : Date.parse(v);
    return Number.isFinite(n) ? n : -Infinity;
  };
  return [...items].sort((a, b) => ms(b[field]) - ms(a[field]));
}

// ── WEBSITE ORDER PICKS (kind "online_pick", docs/ONLINE-ORDERS.md) ──────────
// The Mac mini puts website order lines routed to a shop's floor into this same
// feed, so staff see them where they already look. They are NOT display checks:
// they are listed (outstanding / completed) but count in NO compliance figure —
// not the Today strip, not Analytics, not anyone's tally. Every stat below is
// computed over complianceOnly(); a pick is answered "Handed to packer" or
// "Not found", which says nothing about how a display is kept.
// A swapped line's RETURN TO SHELF (kind "online_return", scripts/lib/swap-line.mjs)
// rides the same strip and is excluded the same way.
export function isOnlinePick(record) {
  return !!record && (record.kind === ONLINE_PICK_KIND || record.kind === ONLINE_RETURN_KIND);
}
export function isOnlineReturn(record) {
  return !!record && record.kind === ONLINE_RETURN_KIND;
}
export function complianceOnly(items) {
  return (Array.isArray(items) ? items : []).filter((r) => r && typeof r === "object" && !isOnlinePick(r));
}

// Is this a real completed result of type no-stock? Anything that isn't the
// explicit "no_stock" result reads as a confirmed display (the common case).
export function isNoStock(record) {
  return !!record && record.result === "no_stock";
}

// Assemble the three sections + the header stats from the two raw source lists.
// `activeItems`   — array of active-index records ({ key, status, ... }).
// `completedItems`— array of day-node records for today ({ key, result, ... }).
export function deriveFeed(activeItems, completedItems) {
  const active = Array.isArray(activeItems) ? activeItems.filter((r) => r && typeof r === "object") : [];
  const completedRaw = Array.isArray(completedItems) ? completedItems.filter((r) => r && typeof r === "object") : [];

  // Window #1: partition on the STATUS field. A lingering completed tombstone in
  // the active index is neither outstanding nor waiting — it's simply dropped.
  const outstanding = sortByTsDesc(active.filter((r) => r.status === "open"), "createdAt");
  const waiting = sortByTsDesc(active.filter((r) => r.status === "held"), "heldAt");
  const completed = sortByTsDesc(completedRaw, "completedAt");

  // Stats: display checks only (online picks are listed, never scored).
  const scoredOutstanding = complianceOnly(outstanding);
  const scoredCompleted = complianceOnly(completed);
  const confirmed = scoredCompleted.filter((r) => !isNoStock(r)).length;
  const noStock = scoredCompleted.length - confirmed;
  const done = scoredCompleted.length;           // resolved either way
  const assigned = scoredOutstanding.length + done; // held excluded from the denominator
  const completionPct = assigned > 0 ? Math.round((done / assigned) * 100) : 0;

  return {
    outstanding,
    waiting,
    completed,
    stats: {
      assigned,
      done,
      outstanding: scoredOutstanding.length,
      waiting: waiting.length,
      confirmed,
      noStock,
      completionPct,
    },
  };
}
