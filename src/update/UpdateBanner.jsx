// "Update ready" pill — appears when the deployed build differs from the one
// this tab is running. Tap = reload now (the safe auto-reload path in
// updateChecker handles idle tills on its own; this is the manual override for
// a cashier mid-shift). Fixed bottom-center so it never covers the header
// actions or the cart totals.
import { useEffect, useState } from "react";
import { onUpdateAvailable, applyUpdate } from "./updateChecker.js";

export default function UpdateBanner() {
  const [show, setShow] = useState(false);
  useEffect(() => onUpdateAvailable(setShow), []);
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={applyUpdate}
      aria-live="polite"
      style={{
        position: "fixed",
        bottom: 14,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 18px",
        borderRadius: 999,
        border: "1px solid rgba(120, 200, 170, 0.45)",
        background: "rgba(18, 51, 47, 0.92)",
        color: "#7fd8c8",
        font: "600 13px/1 -apple-system, 'Segoe UI', Roboto, sans-serif",
        letterSpacing: "0.02em",
        boxShadow: "0 4px 18px rgba(0,0,0,0.35)",
        cursor: "pointer",
        backdropFilter: "blur(6px)",
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 14 }}>⟳</span>
      Update ready — tap to refresh
    </button>
  );
}
