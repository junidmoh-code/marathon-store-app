// ─── STOCK SHARED WIDGETS ─────────────────────────────────────────────────────
// Small presentational + form building blocks shared by the Stock screens, so
// each screen stays focused on its flow. Inline-styled with the stock UI tokens.

import React from "react";
import { CARD, BORDER, RADIUS, BLUE_L, GRAY, FONT, input } from "./ui";
import { activeLocations, labelFor } from "./locations";

export function Card({ children, style }) {
  return <div style={{ background: CARD, border: BORDER, borderRadius: RADIUS, padding: 14, marginBottom: 12, ...style }}>{children}</div>;
}

export function Field({ label, children }) {
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: GRAY, marginBottom: 4, textTransform: "uppercase", letterSpacing: ".04em" }}>{label}</div>
      {children}
    </label>
  );
}

export function Select({ value, onChange, children, disabled }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}
      style={{ ...input, width: "100%", appearance: "none", opacity: disabled ? 0.5 : 1 }}>
      {children}
    </select>
  );
}

export function NumberInput({ value, onChange, min = 0, placeholder }) {
  return (
    <input type="number" inputMode="numeric" value={value} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)} min={min}
      style={{ ...input, width: "100%" }} />
  );
}

export function TextInput({ value, onChange, placeholder }) {
  return (
    <input type="text" value={value} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...input, width: "100%" }} />
  );
}

export function Empty({ children }) {
  return <div style={{ color: GRAY, fontSize: 13, textAlign: "center", padding: "28px 12px", fontFamily: FONT }}>{children}</div>;
}

export function Toast({ msg }) {
  if (!msg) return null;
  const ok = msg.kind === "ok";
  return (
    <div style={{
      position: "fixed", left: 16, right: 16, bottom: 20, zIndex: 50, textAlign: "center",
      background: ok ? "rgba(0,150,70,.95)" : "rgba(150,20,20,.95)", color: "#fff",
      borderRadius: RADIUS, padding: "10px 14px", fontSize: 13, fontFamily: FONT,
    }}>{msg.text}</div>
  );
}

// Product <select> — filtered to products with at least one size.
export function ProductPicker({ products, value, onChange }) {
  const list = [...(products || [])].filter(p => p && p.id && p.name).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Select value={value} onChange={onChange}>
      <option value="">— select product —</option>
      {list.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
    </Select>
  );
}

export function SizePicker({ product, value, onChange }) {
  const sizes = (product && Array.isArray(product.sizes)) ? product.sizes : [];
  return (
    <Select value={value} onChange={onChange} disabled={!product}>
      <option value="">— size —</option>
      {sizes.map(s => <option key={s} value={s}>{s}</option>)}
    </Select>
  );
}

// Location <select>. `filter` optionally narrows the active set (e.g. sellable).
export function LocationPicker({ registry, value, onChange, filter, exclude }) {
  let list = filter ? filter(registry) : activeLocations(registry);
  if (exclude) list = list.filter(l => l.id !== exclude);
  return (
    <Select value={value} onChange={onChange}>
      <option value="">— location —</option>
      {list.map(l => <option key={l.id} value={l.id}>{labelFor(l.id, registry)}</option>)}
    </Select>
  );
}
