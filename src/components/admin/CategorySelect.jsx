// ─── CATEGORY SELECT — the ONE product-type control ───────────────────────────
// Replaces BOTH the old dead "Category…" dropdown and the four-chip Product Type
// row. Category and product type are the same concept now, so there is one
// selector and it is required.
//
// A real <select> with <optgroup>s, not a chip row: at 31 options chips become a
// wall. Native rendering also gives us the platform's own scrolling picker on
// iPad, which is the device this form is actually used on. The visible control
// is a styled box (Marathon Glass: near-black field, electric-blue border, blue
// glow on focus) with the native select laid transparently over it, so the
// closed state is ours and the open list is the platform's.

import { useMemo, useRef, useState } from "react";
import { groupedCategories, catByKey, isAssignable } from "../../utils/productTaxonomy.js";

const BLUE = "#4A7FFF";

export default function CategorySelect({
  registry,
  value,                       // categoryKey | "" — NOTHING selected by default
  onChange,
  id = "category-select",
  invalid = false,             // paint the required state after a save attempt
  disabled = false,
  placeholder = "Select a category…",
}) {
  const [focus, setFocus] = useState(false);
  const selectRef = useRef(null);
  const groups = useMemo(() => groupedCategories(registry), [registry]);
  const selected = catByKey(registry, value);

  // A key that is no longer in the registry (retired category on an old draft)
  // still renders its raw key rather than silently showing "Select a category…"
  // — an operator must be able to SEE that something unexpected is selected.
  const orphan = value && !selected;

  const borderColor = invalid ? "#F87171" : focus ? BLUE : "rgba(74,127,255,.34)";

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <div
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
          background: "#08090C",
          border: `2px solid ${borderColor}`,
          borderRadius: 12,
          padding: "14px 16px",
          minHeight: 52,
          boxSizing: "border-box",
          boxShadow: focus ? `0 0 0 4px rgba(74,127,255,.16), 0 0 18px rgba(74,127,255,.22)` : "inset 0 1px 0 rgba(255,255,255,.04)",
          transition: "border-color .14s, box-shadow .14s",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <span style={{
          fontSize: 16,
          fontWeight: selected || orphan ? 700 : 500,
          letterSpacing: selected || orphan ? "-0.01em" : 0,
          color: selected || orphan ? "#fff" : "rgba(255,255,255,.40)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {selected ? selected.label : orphan ? value : placeholder}
        </span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={focus || selected ? BLUE : "rgba(255,255,255,.35)"}
             strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      <select
        ref={selectRef}
        id={id}
        aria-label="Product category"
        aria-invalid={invalid || undefined}
        value={value || ""}
        disabled={disabled}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onChange={(e) => onChange(e.target.value)}
        style={{
          position: "absolute", inset: 0, width: "100%", height: "100%",
          opacity: 0, cursor: disabled ? "not-allowed" : "pointer",
          // iOS refuses to open a select below 16px without zooming the page.
          fontSize: 16,
        }}
      >
        <option value="" disabled>{placeholder}</option>
        {orphan && <option value={value}>{value} (retired)</option>}
        {groups.map((g) => (
          <optgroup key={g.top} label={g.label.toUpperCase()}>
            {g.options.map((c) => {
              // A category whose registry entry is misconfigured (illegal
              // legacy category/productType) cannot be assigned — the save
              // would be refused. Show it DISABLED and say why, rather than
              // either hiding it (an operator hunting for "Belts" would think
              // it was deleted) or letting them fill in a whole form and hit a
              // dead end at the end.
              const ok = isAssignable(registry, c.key);
              return (
                <option key={c.key} value={c.key} disabled={!ok}>
                  {ok ? c.label : `${c.label} — misconfigured, fix in console`}
                </option>
              );
            })}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
