// ─── STOCK HOLD — PURE CORE ──────────────────────────────────────────────────
// Every decision the held-credit lane makes, with no React and no Firebase:
// whether a fulfil holds, which SHIPMENT a held line belongs to, how lines
// group into the release card's rows, and where a not-arrived line carries to.
//
// ── THE SHIPMENT IS THE PHYSICAL BOX ─────────────────────────────────────────
// (Owner spec 2026-08-12.) Everything fulfilled between one release window and
// the next travels in ONE box, so the shipment identity is the WINDOW AT WHICH
// THAT BOX IS RELEASED — the next release instant after the fulfil, computed
// from the same /config/refillEngine/releaseWindows the pick queue reads
// (releaseWindows.js, default 06:00 & 14:00 SA). With two windows a day, at
// most two shipments pend at a time and each is confirmed with ONE action.
//
// The id is "YYYY-MM-DD_HHMM" (SA date + window wall-clock, zero-padded) —
// key-safe, lexically time-ordered, and stable across devices because it is a
// pure function of (fulfil instant, windows config). Never an ISO string in a
// key (#269) and never a device clock (serverNowMs at every call site).

import { lastReleaseMs, nextReleaseMs, saTimeLabel } from "./releaseWindows";
import { isTransitLane } from "./transitLanes";

const SA_OFFSET_MS = 2 * 60 * 60 * 1000; // SA is UTC+2 year-round, no DST.

const saDateOf = (ms) => new Date(ms + SA_OFFSET_MS).toISOString().slice(0, 10);

/**
 * Does THIS fulfil hold its destination credit?
 * All four legs must agree:
 *   • the RTDB switch is on (absent/false = OFF, fail-safe);
 *   • release windows are not disabled (windows off = continuous release =
 *     nothing to batch a shipment around — holding degrades to instant);
 *   • the leg physically crosses buildings (the same isTransitLane the manual
 *     Transfer lane uses — central→hub1/hub2 is A→B; a hub2→store fulfil is
 *     same-building and never holds).
 */
export function holdActive({ config, windows, from, to }) {
  if (!config || config.enabled !== true) return false;
  if (!windows || windows.disabled) return false;
  return isTransitLane(from, to);
}

/**
 * The shipment a fulfil at `nowMs` belongs to: the NEXT release instant.
 * → { id: "2026-08-12_1400", label: "14:00", dateLabel: "2026-08-12", releaseMs }
 */
export function shipmentIdFor(nowMs, windows) {
  if (!windows || windows.disabled || !windows.minutes || !windows.minutes.length) return null;
  const releaseMs = nextReleaseMs(nowMs, windows);
  const label = saTimeLabel(releaseMs);
  return {
    id: `${saDateOf(releaseMs)}_${label.replace(":", "")}`,
    label,
    dateLabel: saDateOf(releaseMs),
    releaseMs,
  };
}

/**
 * Where a NOT-ARRIVED line carries to: the next shipment strictly AFTER the
 * one it is leaving. Computed from the departed shipment's own release
 * instant, not from "now" — releasing a shipment early (box arrived ahead of
 * the window) must still carry the missing line to the FOLLOWING window, never
 * back into the shipment being released.
 */
export function nextShipmentAfter(shipment, nowMs, windows) {
  if (!windows || windows.disabled) return null;
  const from = Math.max(Number(shipment?.releaseMs) || 0, Number(nowMs) || 0);
  return shipmentIdFor(from, windows);
}

/** Parse a shipment id back to its release instant (for lines written by
 *  another device — the id is the durable fact, releaseMs is derivable). */
export function shipmentReleaseMs(shipmentId) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})$/.exec(String(shipmentId || ""));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - SA_OFFSET_MS;
}

/**
 * Group held lines into the release card's shipment rows.
 * heldByDest = { dest: { lineId: line } } (the /settings/stockHold/held node).
 * → [{ key, shipmentId, dest, label, dateLabel, releaseMs, lines, units,
 *      overdueMs }] sorted oldest release first.
 */
export function groupShipments(heldByDest, nowMs) {
  const byKey = new Map();
  for (const [dest, byLine] of Object.entries(heldByDest || {})) {
    for (const [lineId, line] of Object.entries(byLine || {})) {
      if (!line || !line.shipmentId) continue;
      const key = `${line.shipmentId}|${dest}`;
      if (!byKey.has(key)) {
        const releaseMs = shipmentReleaseMs(line.shipmentId);
        byKey.set(key, {
          key, shipmentId: line.shipmentId, dest,
          label: line.windowLabel || (releaseMs != null ? saTimeLabel(releaseMs) : line.shipmentId),
          dateLabel: String(line.shipmentId).slice(0, 10),
          releaseMs, lines: [], units: 0,
        });
      }
      const g = byKey.get(key);
      g.lines.push({ lineId, ...line });
      g.units += Number(line.qty) || 1;
    }
  }
  const rows = [...byKey.values()];
  for (const g of rows) {
    g.lines.sort((a, b) => String(a.productName || "").localeCompare(String(b.productName || "")) || a.lineId.localeCompare(b.lineId));
    g.overdueMs = g.releaseMs != null ? Math.max(0, nowMs - g.releaseMs) : 0;
  }
  return rows.sort((a, b) => String(a.shipmentId).localeCompare(String(b.shipmentId)) || a.dest.localeCompare(b.dest));
}

/** Age of the oldest pending shipment, ms (0 when nothing pends or nothing is
 *  past its window yet) — the number the card shows LOUDLY. */
export function oldestPendingMs(shipmentRows, nowMs) {
  let worst = 0;
  for (const g of shipmentRows || []) worst = Math.max(worst, g.overdueMs || 0);
  return worst;
}

/** "14:00 shipment · 8 Aug · 23 lines · 41 units · Hub 2" */
export function shipmentTitle(g, hubLabelOf = (d) => d) {
  const d = new Date((shipmentReleaseMs(g.shipmentId) ?? 0) + SA_OFFSET_MS);
  const dateBit = `${d.getUTCDate()} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()]}`;
  return `${g.label} shipment · ${dateBit} · ${g.lines.length} line${g.lines.length === 1 ? "" : "s"} · ${g.units} unit${g.units === 1 ? "" : "s"} · ${hubLabelOf(g.dest)}`;
}
