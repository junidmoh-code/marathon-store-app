// "Update ready" pill — appears when the deployed build differs from the one
// this tab is running. Tap = reload now. This is THE way a new build is taken
// during the day: nothing reloads by itself while the shops trade (see
// updateChecker.js — only a cold start, this tap, or the 03:00–05:00 window). Fixed bottom-center so it never covers the header
// actions or the cart totals.
import { useEffect, useState } from "react";
import { onUpdateAvailable, applyUpdate, isTvScreen, isUpdateBannerHosted, onUpdateBannerHosted } from "./updateChecker.js";

export default function UpdateBanner() {
  const [show, setShow] = useState(false);
  const [hosted, setHosted] = useState(isUpdateBannerHosted);
  useEffect(() => onUpdateAvailable(setShow), []);
  // A screen with its own banner (the Black Friday card) is open: that one is shown instead.
  useEffect(() => onUpdateBannerHosted(setHosted), []);
  // Never on the customer-facing TV board: nobody there can tap it, and the
  // board is not reloaded while the store is open (updateChecker.isTvScreen).
  if (!show || hosted || isTvScreen()) return null;
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
