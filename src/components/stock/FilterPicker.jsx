// ─── FILTER PICKER ────────────────────────────────────────────────────────────
// ONE compact selector (Junid 12 Nov, Stock redesign): a glass pill reading
// "LABEL · Current ⌄". A tap opens the SkyOverlay bottom sheet with every
// option as its own glass card; picking one closes it. Used for "Transfer
// from" and "Category" on Transfer, and Location / Category on Barcodes — a
// single line instead of a wall of chips. The current selection (default
// "All", or the dimmed placeholder) is always visible.
//
// Presentation only: same props, same onChange(id) contract. `defaultOpen` is
// still accepted but no longer pops a sheet on mount — a modal that opens by
// itself the moment a tab loads takes the screen away; the placeholder and the
// screen's own "pick a source" line say what to do instead.

import React, { useRef, useState } from "react";
import SkyOverlay from "../sky/SkyOverlay.jsx";

// eslint-disable-next-line no-unused-vars
export default function FilterPicker({ label, value, options, onChange, placeholder, defaultOpen = false }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const match = options.find((o) => o.id === value)?.label;
  // No match + a placeholder + no value → show the placeholder (dimmed) so a
  // required, un-defaulted picker reads "Choose …" instead of blank.
  const isPlaceholder = match == null && !value && !!placeholder;
  const current = match ?? (value || placeholder || "");
  const pick = (id) => { onChange(id); setOpen(false); };
  return (
    <>
      <button ref={btnRef} type="button" className="sky-pick" aria-haspopup="dialog" aria-expanded={open}
              aria-label={`${label}: ${current}`} onClick={() => setOpen(true)}>
        <span className="sky-pick__lab">{label}</span>
        <span className="sky-pick__val" data-placeholder={isPlaceholder ? "" : undefined}>{current}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <SkyOverlay open={open} onClose={() => setOpen(false)} variant="sheet" anchorRef={btnRef} label={label} role="dialog">
        <div className="sky-pop__lab">{label}</div>
        <div role="radiogroup" aria-label={label}>
          {options.map((o) => (
            <button key={o.id} type="button" role="radio" aria-checked={o.id === value} className="sky-ovl-card sky-pop__i" onClick={() => pick(o.id)}>
              <span>{o.label}</span>
            </button>
          ))}
        </div>
      </SkyOverlay>
    </>
  );
}
