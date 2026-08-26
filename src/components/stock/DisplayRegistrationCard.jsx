// ─── DISPLAY REGISTRATION — THE HOME CARD ────────────────────────────────────
// (Owner ask, 2026-08-26.) The daily lane for the display walls: when new
// stock arrives, staff register which size went on display; the same view
// corrects a wrongly-registered size after a display recheck. It records the
// FACT only (register row + slot) — never a stock movement: new-stock display
// pairs were already booked by receiving (unlike HubCleanup's found-on-wall
// registrar, which books the unit first).
//
// One tiny one-shot read for the stat line, same discipline as every card.

// No reads at all: HubCleanupCard on the same home screen already pulls the
// whole ~172 KB register node for its stat — a second identical read for a
// cosmetic count doubled that bill on every admin home mount.
import React from "react";
import { CARD, BORDER } from "./ui";

export default function DisplayRegistrationCard({ onOpen }) {
  return (
    <div style={{ background: CARD, border: BORDER, borderRadius: 15, padding: "16px 17px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FBBF24" strokeWidth="2.2"><rect x="3" y="5" width="18" height="12" rx="2"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/></svg>
        <div style={{ fontWeight: 800, color: "#fff", fontSize: 15 }}>Display Registration</div>
      </div>
      <div style={{ color: "rgba(255,255,255,.55)", fontSize: 12, lineHeight: 1.5, marginBottom: 10 }}>
        New stock in? Register which size went on the display wall. Wrong size on record? Fix it here.
      </div>
      <button onClick={onOpen}
        style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(251,191,36,.4)",
                 background: "rgba(251,191,36,.1)", color: "#FBBF24", fontWeight: 800, fontSize: 13, cursor: "pointer" }}>
        Open →
      </button>
    </div>
  );
}
