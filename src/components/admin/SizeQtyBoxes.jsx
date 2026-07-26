// ─── OPENING-STOCK SIZE × QUANTITY GRID ───────────────────────────────────────
// The required opening-stock section of the Add Product form. Renders one
// properly-defined quantity box per size from the chosen category's registry
// entry — or a SINGLE Quantity field for a one-size category, which writes to
// the "_" sentinel cell that /stock, the barcode catalog and the POS already use
// for size-less lines.
//
// An explicit 0 is a first-class answer: a size the shipment did not include is
// entered as 0, not skipped and not faked. Blank is treated as "nothing received
// for this size" and writes no movement — identical to 0 in effect, but the
// operator can see the difference on screen.
//
// Styling is the deliberate part of this file (Marathon Glass): deep-black
// fields, electric-blue borders, a 4px blue focus ring, 18px bold tabular
// numerals, uniform 76×56 boxes with real gutters. The old grid used 8px
// padding at 0.95rem in a 64px auto-fill track and read as a default form.

import { useState } from "react";
import { ONE_SIZE_SENTINEL } from "../../utils/productTaxonomy.js";

const BLUE = "#4A7FFF";

function QtyBox({ label, value, onChange, autoFocus, wide }) {
  const [focus, setFocus] = useState(false);
  const filled = value !== "" && value != null;
  const n = Number(value);
  const positive = filled && Number.isFinite(n) && n > 0;

  return (
    <label style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 7, minWidth: 0 }}>
      <span style={{
        fontSize: 11.5, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase",
        textAlign: "center", color: positive ? "#9DBCFF" : "rgba(233,238,255,.45)", transition: "color .14s",
      }}>
        {label}
      </span>
      <input
        type="number"
        inputMode="numeric"
        min="0"
        step="1"
        placeholder="0"
        value={value ?? ""}
        autoFocus={autoFocus}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`Quantity received, size ${label}`}
        style={{
          width: "100%", height: 56, minWidth: wide ? 120 : 0, boxSizing: "border-box",
          background: "#08090C",
          border: `2px solid ${focus ? BLUE : positive ? "rgba(74,127,255,.55)" : "rgba(74,127,255,.28)"}`,
          borderRadius: 12,
          padding: "0 10px",
          textAlign: "center",
          color: positive ? "#fff" : "rgba(255,255,255,.72)",
          fontSize: 18, fontWeight: 800, fontVariantNumeric: "tabular-nums",
          outline: "none",
          boxShadow: focus
            ? "0 0 0 4px rgba(74,127,255,.16), 0 0 18px rgba(74,127,255,.22)"
            : positive ? "inset 0 1px 0 rgba(255,255,255,.05), 0 0 10px rgba(74,127,255,.10)" : "inset 0 1px 0 rgba(255,255,255,.04)",
          transition: "border-color .14s, box-shadow .14s, color .14s",
          // Kill the spinner arrows — they shrink the usable tap area to nothing.
          appearance: "textfield", MozAppearance: "textfield",
        }}
      />
    </label>
  );
}

export default function SizeQtyBoxes({ sizes, oneSize, values, onChange }) {
  // One-size: a single, wider Quantity field keyed on the "_" sentinel.
  if (oneSize) {
    return (
      <div style={{ maxWidth: 240 }}>
        <QtyBox
          label="Quantity"
          wide
          value={values[ONE_SIZE_SENTINEL] ?? ""}
          onChange={(v) => onChange(ONE_SIZE_SENTINEL, v)}
        />
        <div style={{ marginTop: 9, fontSize: 12, color: "rgba(233,238,255,.42)", lineHeight: 1.45 }}>
          One-size product — a single stock line, no size breakdown.
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(76px, 1fr))",
      gap: 12,
    }}>
      {sizes.map((s) => (
        <QtyBox key={s} label={s} value={values[s] ?? ""} onChange={(v) => onChange(s, v)} />
      ))}
    </div>
  );
}

// Total units across the entered quantities — drives the section's summary line.
export function totalUnits(values) {
  return Object.values(values || {}).reduce((a, v) => {
    const n = parseInt(v, 10);
    return a + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
}

// The [size, qty] pairs that should become `received` movements: positive
// integers only. An explicit 0 is a valid, recorded ANSWER but not a movement —
// there is nothing to receive.
export function receiveEntries(sizes, values) {
  return sizes
    .map((s) => [s, parseInt(values[s], 10)])
    .filter(([, n]) => Number.isFinite(n) && n > 0);
}
