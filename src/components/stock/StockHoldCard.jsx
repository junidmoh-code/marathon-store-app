// ─── STOCK HOLD — THE HOME CARD ──────────────────────────────────────────────
// TEMPORARY, beside Hub Count & Displays, same removal contract: flip
// STOCK_HOLD_ENABLED (or never enable the RTDB switch) and this renders
// nothing. Owner-only (plus named delegates) — staff never see it.
//
// Reads are tiny and one-shot: the config (for the gate) and the held node
// (a handful of lines per pending shipment). The card's job is ONE number said
// loudly: how many shipments await release, and how old the oldest is —
// because every hour a shipment waits, hub cells understate and the engine
// leans on the held-inbound guard.

import React, { useEffect, useState } from "react";
import { CARD, BORDER, GRAY, GREEN, RED, AMBER, BLUE_L, tabOn } from "./ui";
import { canReleaseStockHold } from "../../config/stockHold";
import { loadHoldConfig, loadHeld } from "./stockHoldStore";
import { groupShipments, oldestPendingMs } from "./stockHoldCore";
import { serverNowMs } from "../../utils/serverTime";
import { formatDuration } from "../../utils/duration";

export default function StockHoldCard({ viewer, onOpen }) {
  const [state, setState] = useState(null);   // { allowed, enabled, shipments, oldestMs }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await loadHoldConfig();
        if (!canReleaseStockHold(viewer, config)) { if (!cancelled) setState({ allowed: false }); return; }
        const held = await loadHeld();
        if (cancelled) return;
        const now = serverNowMs();
        const shipments = groupShipments(held, now);
        setState({ allowed: true, enabled: config?.enabled === true, shipments, oldestMs: oldestPendingMs(shipments, now) });
      } catch {
        if (!cancelled) setState({ allowed: false });
      }
    })();
    return () => { cancelled = true; };
    // viewer is a fresh object each render; its identity fields are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer?.email, viewer?.uid]);

  if (!state || !state.allowed) return null;

  const n = state.shipments.length;
  const units = state.shipments.reduce((t, s) => t + s.units, 0);
  const overdue = state.oldestMs > 0;
  const veryLate = state.oldestMs > 24 * 3600e3;

  return (
    <div style={{ background: CARD, border: veryLate ? "1px solid rgba(248,113,113,.55)" : BORDER, borderRadius: 14, padding: "12px 13px", marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
        <span style={{ fontSize: 17 }}>📦</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: "#fff" }}>Shipment Release</div>
          <div style={{ fontSize: 10.5, color: GRAY }}>Central→hub boxes land when you confirm them</div>
        </div>
        {!state.enabled && (
          <span style={{ fontSize: 9.5, fontWeight: 800, color: AMBER, border: "1px solid rgba(251,191,36,.4)", borderRadius: 8, padding: "3px 7px" }}>
            HOLDING OFF
          </span>
        )}
      </div>

      <div style={{ fontSize: 12, color: GRAY, marginBottom: 10, lineHeight: 1.5 }}>
        {n === 0 ? (
          "Nothing pending — every fulfilled box has been released."
        ) : (
          <>
            <strong style={{ color: overdue ? (veryLate ? RED : AMBER) : BLUE_L, fontSize: 13 }}>
              {n} shipment{n === 1 ? "" : "s"}
            </strong>{" "}
            pending · {units} unit{units === 1 ? "" : "s"}
            {overdue && (
              <span style={{ color: veryLate ? RED : AMBER, fontWeight: 700 }}>
                {" "}· oldest {formatDuration(state.oldestMs)} past its window
              </span>
            )}
          </>
        )}
      </div>

      <button onClick={onOpen}
        style={{ ...tabOn, width: "100%", borderRadius: 11, padding: "10px 12px", fontSize: "0.82rem",
                 ...(overdue ? { border: `1px solid ${veryLate ? "rgba(248,113,113,.7)" : "rgba(251,191,36,.6)"}` } : {}) }}>
        {n > 0 ? `Release shipments (${n}) →` : "Open →"}
      </button>
      {n === 0 && !state.enabled && (
        <div style={{ fontSize: 10, color: GRAY, marginTop: 6 }}>
          Holding is switched off — fulfils credit hubs instantly (today's behaviour).
        </div>
      )}
    </div>
  );
}
