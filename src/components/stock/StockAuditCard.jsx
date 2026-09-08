// ─── STOCK AUDIT — THE HOME CARD ─────────────────────────────────────────────
// Beside the other count cards. Deliberately readless: the two snapshots it
// would need for a badge are per-store, and a home screen that opens two
// subscriptions for a number nobody acts on from the home screen is the exact
// cost this feature was built to avoid. The lists are inside.

import React from "react";
import { CARD, BORDER, BLUE, BLUE_L } from "./ui";

export default function StockAuditCard({ onOpen }) {
  return (
    <div style={{ background: CARD, border: BORDER, borderRadius: 15, padding: "16px 17px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11l3 3 6-6" /><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" />
        </svg>
        <div style={{ fontWeight: 800, color: "#fff", fontSize: 15 }}>Stock Audit</div>
      </div>
      <button onClick={onOpen}
        style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(74,127,255,.4)",
                 background: "rgba(74,127,255,.12)", color: BLUE_L, fontWeight: 800, fontSize: 13, cursor: "pointer" }}>
        Open →
      </button>
    </div>
  );
}
