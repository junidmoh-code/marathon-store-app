// ─── ON-SCREEN KEYBOARD — PORTABLE, SELF-CONTAINED ───────────────────────────
// Tap keyboard for sign-in screens on touch-only hardware (wall tablets, TV
// boxes) where there is no physical keyboard and some kiosk browsers never
// show the native one.
//
// PORTABILITY CONTRACT — this file is copied VERBATIM into marathon-pos-app:
//   • The ONLY import allowed here is "react". No stores, no routing, no
//     theme, no firebase, no other app modules. A test pins this.
//   • Props in, events out. The keyboard holds no field state of its own
//     (except the transient shift state); the parent owns the input values.
//   • All styling is inline and self-contained.
//
// Props:
//   layout      "text" | "numeric"   — full QWERTY vs PIN pad (default "text")
//   onKey       (char) => void       — a character key was tapped
//   onBackspace () => void           — backspace was tapped
//   onSubmit    () => void           — the submit key was tapped
//   submitLabel string               — caption of the submit key (default "Enter")
//   canSubmit   boolean              — false disables the submit key (default true)
//   accent      string               — accent colour (default "#4A7FFF")
//
// The component renders as a plain in-flow block (width 100%, own max-width),
// so wherever the parent places it, it can never cover the focused field —
// put it AFTER the form in a scrollable page and the field always stays
// visible. Key taps preventDefault() on pointerdown so the focused input
// never loses focus to the button.
//
// Also exported: isTouchOnlyDevice() — true when the device has coarse
// pointers only (no mouse/trackpad). Desktops and laptops (even ones with a
// touchscreen, which report a fine pointer too) get NO keyboard.

import { useState } from "react";

export function isTouchOnlyDevice() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  const coarse = window.matchMedia("(any-pointer: coarse)").matches;
  const fine   = window.matchMedia("(any-pointer: fine)").matches;
  return coarse && !fine;
}

const TEXT_ROWS = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["⇧", "z", "x", "c", "v", "b", "n", "m", "⌫"],
];
const TEXT_BOTTOM = [".", "-", "_"];
const NUM_ROWS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
];

export default function OnScreenKeyboard({
  layout = "text",
  onKey,
  onBackspace,
  onSubmit,
  submitLabel = "Enter",
  canSubmit = true,
  accent = "#4A7FFF",
}) {
  // One-shot shift, like a phone keyboard: uppercases the next letter only.
  const [shift, setShift] = useState(false);

  const keyBase = {
    flex: "1 1 0", minWidth: 0, height: 46,
    background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.10)",
    borderRadius: 8, color: "#fff", fontSize: 17, fontWeight: 600,
    fontFamily: "inherit", cursor: "pointer", padding: 0,
    touchAction: "manipulation", WebkitTapHighlightColor: "transparent",
    userSelect: "none",
  };

  const press = (char) => {
    if (onKey) onKey(shift ? char.toUpperCase() : char);
    if (shift) setShift(false);
  };

  // preventDefault on pointerdown so tapping a key never steals focus from
  // the input the parent is filling.
  const noFocusSteal = (e) => e.preventDefault();

  const Key = ({ label, onTap, wide, active, disabled, ariaLabel, ariaPressed }) => (
    <button
      type="button"
      aria-label={ariaLabel || label}
      aria-pressed={ariaPressed}
      disabled={disabled}
      onPointerDown={noFocusSteal}
      onMouseDown={noFocusSteal}
      onClick={onTap}
      style={{
        ...keyBase,
        ...(wide ? { flex: `${wide} 1 0` } : null),
        ...(active ? { background: accent, borderColor: accent } : null),
        ...(disabled ? { opacity: 0.4, cursor: "default" } : null),
      }}
    >
      {label}
    </button>
  );

  const rowStyle = { display: "flex", gap: 6 };

  return (
    <div
      style={{
        width: "100%", maxWidth: layout === "numeric" ? 280 : 560,
        margin: "0 auto", padding: 10, boxSizing: "border-box",
        background: "rgba(10,13,24,.97)", border: "1px solid rgba(255,255,255,.08)",
        borderRadius: 14, display: "flex", flexDirection: "column", gap: 6,
      }}
    >
      {layout === "numeric" ? (
        <>
          {NUM_ROWS.map((row, i) => (
            <div key={i} style={rowStyle}>
              {row.map((k) => <Key key={k} label={k} onTap={() => press(k)} />)}
            </div>
          ))}
          <div style={rowStyle}>
            <Key label="⌫" ariaLabel="Backspace" onTap={() => onBackspace && onBackspace()} />
            <Key label="0" onTap={() => press("0")} />
            <Key
              label={submitLabel} ariaLabel={submitLabel}
              disabled={!canSubmit} active={canSubmit}
              onTap={() => canSubmit && onSubmit && onSubmit()}
            />
          </div>
        </>
      ) : (
        <>
          {TEXT_ROWS.map((row, i) => (
            <div key={i} style={rowStyle}>
              {row.map((k) =>
                k === "⇧" ? (
                  <Key key={k} label="⇧" ariaLabel="Shift" ariaPressed={shift} active={shift} onTap={() => setShift(s => !s)} />
                ) : k === "⌫" ? (
                  <Key key={k} label="⌫" ariaLabel="Backspace" onTap={() => onBackspace && onBackspace()} />
                ) : (
                  // aria-label tracks the SHIFTED character so assistive tech
                  // announces exactly what the key will emit.
                  <Key key={k} label={shift ? k.toUpperCase() : k} ariaLabel={shift ? k.toUpperCase() : k} onTap={() => press(k)} />
                )
              )}
            </div>
          ))}
          <div style={rowStyle}>
            {TEXT_BOTTOM.map((k) => <Key key={k} label={k} onTap={() => press(k)} />)}
            <Key
              label={submitLabel} ariaLabel={submitLabel} wide={3}
              disabled={!canSubmit} active={canSubmit}
              onTap={() => canSubmit && onSubmit && onSubmit()}
            />
          </div>
        </>
      )}
    </div>
  );
}
