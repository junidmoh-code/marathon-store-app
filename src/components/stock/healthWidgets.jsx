// ─── HEALTH MODULE · SHARED WIDGETS ───────────────────────────────────────────
// Building blocks for the Inventory Health dashboard and its drill-in
// workflows. Strictly the existing design language (ui.js tokens: GLASS
// surfaces, BLUE/GREEN/AMBER/RED, pill buttons) — no new styling system.
//
//   StatCard         — dashboard tile: big value, label, tone, tap → drill-in
//   DetailShell      — drill-in screen chrome (back button + title + count)
//   ProductCard      — the product-first card every workflow uses: photo,
//                      full name, badges, children (size chips / actions)
//   SizeStepperChip  — per-size box in the Transfer-screen idiom: size label,
//                      − / qty / + stepper, optional reject ✕ corner toggle

import React from "react";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, FONT } from "./ui";

export function StatCard({ label, value, sub, tone = BLUE_L, onClick, wide }) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      style={{
        ...GLASS, fontFamily: FONT, textAlign: "left", cursor: onClick ? "pointer" : "default",
        padding: "14px 15px", display: "flex", flexDirection: "column", gap: 4,
        gridColumn: wide ? "1 / -1" : undefined, color: "#fff",
        transition: "border-color 120ms ease",
      }}
    >
      <div style={{ fontSize: 26, fontWeight: 800, color: tone, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#fff" }}>{label}</div>
      {sub && <div style={{ fontSize: 10.5, color: GRAY, lineHeight: 1.35 }}>{sub}</div>}
      {onClick && <div style={{ fontSize: 10, color: BLUE_L, marginTop: 2 }}>View →</div>}
    </button>
  );
}

export function DetailShell({ title, count, onBack, children, sub }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "2px 0 12px" }}>
        <button onClick={onBack} style={{ background: "rgba(60,110,255,.08)", border: "1px solid rgba(60,110,255,.25)", color: BLUE_L, borderRadius: 10, padding: "8px 12px", fontWeight: 700, fontSize: 12.5, cursor: "pointer", fontFamily: FONT }}>← Back</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800 }}>{title}</div>
          {sub && <div style={{ fontSize: 11, color: GRAY, marginTop: 1 }}>{sub}</div>}
        </div>
        {count != null && (
          <span style={{ fontSize: 11.5, fontWeight: 700, color: BLUE_L, background: "rgba(60,110,255,.1)", border: "1px solid rgba(60,110,255,.3)", borderRadius: 999, padding: "4px 11px" }}>{count}</span>
        )}
      </div>
      {children}
    </div>
  );
}

const TONE_BG = {
  [GREEN]: "rgba(0,150,70,.12)",
  [RED]: "rgba(150,20,20,.12)",
  [AMBER]: "rgba(245,158,11,.12)",
  [BLUE_L]: "rgba(60,110,255,.12)",
};

export function Badge({ children, tone = BLUE_L }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: tone, background: TONE_BG[tone] || "rgba(60,110,255,.12)", border: `1px solid ${tone}55`, borderRadius: 6, padding: "2px 7px", whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

export function ProductCard({ photo, photos, onPhotoTap, name, badges, sub, right, children }) {
  const src = photo || (photos && photos[0]) || null;
  return (
    <div style={{ ...GLASS, marginBottom: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 13px" }}>
        <div
          onClick={onPhotoTap}
          style={{ width: 54, height: 54, borderRadius: 11, flexShrink: 0, overflow: "hidden", background: "rgba(60,110,255,.1)", cursor: onPhotoTap ? "zoom-in" : "default" }}
        >
          {src && <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, color: "#fff", lineHeight: 1.25, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{name}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
            {badges}
            {sub && <span style={{ fontSize: 10.5, color: GRAY }}>{sub}</span>}
          </div>
        </div>
        {right}
      </div>
      {children && <div style={{ padding: "0 13px 13px" }}>{children}</div>}
    </div>
  );
}

// Per-size chip in the Transfer-screen idiom: bordered box, size on top,
// − / qty / + below. `onReject` adds the corner ✕ toggle; a rejected chip dims
// and forces qty 0. `max` caps the stepper; `hint` renders under the stepper
// (e.g. "3 here" availability).
export function SizeStepperChip({ size, qty, max, onChange, rejected, onReject, hint, disabled }) {
  const off = rejected || disabled;
  const btn = {
    width: 26, height: 26, borderRadius: 8, border: "1px solid rgba(60,110,255,.3)",
    background: "rgba(60,110,255,.08)", color: BLUE_L, fontWeight: 800, fontSize: 14,
    cursor: off ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center",
    opacity: off ? 0.35 : 1, fontFamily: FONT,
  };
  return (
    <div style={{
      position: "relative", border: rejected ? "1px solid rgba(150,20,20,.45)" : "1px solid rgba(60,110,255,.22)",
      background: rejected ? "rgba(150,20,20,.07)" : "rgba(60,110,255,.05)",
      borderRadius: 12, padding: "8px 8px 7px", textAlign: "center", opacity: disabled ? 0.5 : 1,
    }}>
      {onReject && (
        <button onClick={onReject} title={rejected ? "Include size" : "Reject size (not found)"}
          style={{ position: "absolute", top: 4, right: 4, width: 18, height: 18, borderRadius: 9, border: "none", cursor: "pointer", background: rejected ? "rgba(150,20,20,.35)" : "rgba(255,255,255,.07)", color: rejected ? "#fff" : GRAY, fontSize: 10, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT }}>
          ✕
        </button>
      )}
      <div style={{ fontSize: 12.5, fontWeight: 800, color: rejected ? RED : "#fff", marginBottom: 6 }}>{size}</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
        <button style={btn} onClick={() => !off && onChange(Math.max(0, qty - 1))}>−</button>
        <span style={{ minWidth: 22, fontSize: 15, fontWeight: 800, color: rejected ? RED : qty > 0 ? "#fff" : GRAY }}>{rejected ? 0 : qty}</span>
        <button style={btn} onClick={() => !off && onChange(Math.min(max, qty + 1))}>+</button>
      </div>
      {hint && <div style={{ fontSize: 9.5, color: GRAY, marginTop: 5 }}>{hint}</div>}
    </div>
  );
}

// Static per-size fact chip (no stepper) for read-only detail screens:
// "M  −3" (negative counts), "L  need 2" (missing sizes), etc.
export function SizeFactChip({ size, value, tone = BLUE_L }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, border: `1px solid ${tone}40`, background: TONE_BG[tone] || "rgba(60,110,255,.08)", borderRadius: 10, padding: "5px 10px", fontSize: 12 }}>
      <span style={{ fontWeight: 800, color: "#fff" }}>{size}</span>
      <span style={{ fontWeight: 700, color: tone }}>{value}</span>
    </span>
  );
}

export const CHIP_GRID = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8, marginTop: 4 };
