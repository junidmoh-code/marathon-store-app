// ─── FILTER PICKER ────────────────────────────────────────────────────────────
// A collapsible filter card: the header shows "LABEL · Current ▾"; tap to expand
// the options, pick one, and it collapses back. Used for the Location / Category
// pickers on Barcodes + Transfer so they're compact (one line each) instead of a
// wall of chips. The current selection (default "All") is always visible.

import React, { useState } from "react";
import { GRAY, BLUE_L, BORDER, FONT } from "./ui";

export default function FilterPicker({ label, value, options, onChange, placeholder, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const match = options.find((o) => o.id === value)?.label;
  // No match + a placeholder + no value → show the placeholder (dimmed) so a
  // required, un-defaulted picker reads "Choose …" instead of blank.
  const isPlaceholder = match == null && !value && !!placeholder;
  const current = match ?? (value || placeholder || "");
  return (
    <div style={{ borderRadius: 12, border: BORDER, background: "rgba(255,255,255,.03)", marginBottom: 10, overflow: "hidden" }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                 background: "none", border: "none", padding: "11px 14px", cursor: "pointer", fontFamily: FONT }}>
        <span style={{ fontSize: 10, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700 }}>{label}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: isPlaceholder ? GRAY : "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{current}</span>
          <span style={{ color: BLUE_L, fontSize: 11, transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▾</span>
        </span>
      </button>
      {open && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, padding: "2px 12px 12px" }}>
          {options.map((o) => {
            const on = o.id === value;
            return (
              <button key={o.id} onClick={() => { onChange(o.id); setOpen(false); }}
                style={{ padding: "7px 14px", borderRadius: 999, cursor: "pointer", fontSize: 12.5, fontWeight: 700, fontFamily: FONT, whiteSpace: "nowrap",
                         border: on ? "1px solid #4A7FFF" : "1px solid rgba(60,110,255,.22)",
                         background: on ? "rgba(60,110,255,.22)" : "rgba(255,255,255,.03)", color: on ? "#fff" : "rgba(255,255,255,.55)" }}>
                {o.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
