// ─── DISPLAY REGISTRATION — THE HOME CARD ────────────────────────────────────
// (Owner ask, 2026-08-26.) The daily lane for the display walls: when new
// stock arrives, staff register which size went on display; the same view
// corrects a wrongly-registered size after a display recheck. It records the
// FACT only (register row + slot) — never a stock movement: new-stock display
// pairs were already booked by receiving (unlike HubCleanup's found-on-wall
// registrar, which books the unit first).
//
// One tiny one-shot read for the stat line, same discipline as every card.

import React, { useEffect, useState } from "react";
import { CARD, BORDER, BLUE_L } from "./ui";
import { loadRegister } from "./hubCleanupStore";

export default function DisplayRegistrationCard({ onOpen }) {
  const [units, setUnits] = useState(null);
  useEffect(() => {
    let cancelled = false;
    loadRegister("hub1")
      .then((reg) => {
        if (!cancelled) setUnits(Object.values(reg || {}).reduce((n, r) => n + (Number(r?.qty) || 0), 0));
      })
      .catch(() => { if (!cancelled) setUnits(null); });
    return () => { cancelled = true; };
  }, []);
  return (
    <div style={{ background: CARD, border: BORDER, borderRadius: 15, padding: "16px 17px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FBBF24" strokeWidth="2.2"><rect x="3" y="5" width="18" height="12" rx="2"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/></svg>
        <div style={{ fontWeight: 800, color: "#fff", fontSize: 15 }}>Display Registration</div>
      </div>
      <div style={{ color: "rgba(255,255,255,.55)", fontSize: 12, lineHeight: 1.5, marginBottom: 10 }}>
        New stock in? Register which size went on the display. Wrong size on record? Fix it here.
        {units != null && <span style={{ color: BLUE_L }}> {units} display units registered at Hub 1.</span>}
      </div>
      <button onClick={onOpen}
        style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(251,191,36,.4)",
                 background: "rgba(251,191,36,.1)", color: "#FBBF24", fontWeight: 800, fontSize: 13, cursor: "pointer" }}>
        Open →
      </button>
    </div>
  );
}
