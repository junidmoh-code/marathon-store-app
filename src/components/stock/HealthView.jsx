// ─── INVENTORY HEALTH (primary module shell) ──────────────────────────────────
// Health promoted from a Stock tab to its own home-screen card (owner decision
// 2026-07-12): the operational control centre for the AI inventory engine.
// This shell provides the full-screen chrome (header + exit) in the same visual
// language as StockView; all content lives in Health.jsx — engine status,
// Inventory Health score, shadow activity, policy warnings, every exception
// section, and confidence scores.

import React from "react";
import Health from "./Health";
import { FONT, BG, BLUE_L } from "./ui";

export default function HealthView({ products = [], onExit }) {
  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT }}>
      <div style={{ padding: "14px 16px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onClick={onExit} style={{ background: "none", border: "none", padding: 0, color: BLUE_L, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: FONT }}>← Exit</button>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Inventory Health</div>
        <div style={{ minWidth: 40 }} />
      </div>
      <div style={{ padding: "4px 12px 40px" }}>
        <Health products={products} />
      </div>
    </div>
  );
}
