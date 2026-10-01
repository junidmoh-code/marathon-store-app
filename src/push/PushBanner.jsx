// ─── THE IN-APP BANNER ───────────────────────────────────────────────────────
// What a staff member sees INSTEAD of a system notification while the app is
// open. Top of the screen, above everything, tappable to jump to the queue.
//
// Positioned below the safe-area inset so it clears the notch on an installed
// iPhone, and given a z-index under the fatal-error banner in main.jsx — a
// crash notice must never be covered by a refill alert.

export default function PushBanner({ banner, onOpen, onDismiss }) {
  if (!banner) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed", top: "calc(env(safe-area-inset-top, 0px) + 10px)",
        left: 12, right: 12, zIndex: 2147483000,
        maxWidth: 460, margin: "0 auto",
        display: "flex", alignItems: "center", gap: 12,
        padding: "12px 12px 12px 14px", borderRadius: 15,
        background: "linear-gradient(160deg, rgba(28,34,58,.98), rgba(14,17,30,.98))",
        border: "1px solid rgba(74,127,255,.45)",
        boxShadow: "0 18px 44px -18px rgba(0,0,0,.9)",
        color: "#f3f6ff",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
      }}>
      <span style={{
        width: 34, height: 34, flex: "0 0 auto", borderRadius: 11, display: "grid", placeItems: "center",
        color: "#9DBCFF", background: "rgba(74,127,255,.16)", border: "1px solid rgba(74,127,255,.3)",
      }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" />
        </svg>
      </span>

      <button
        onClick={onOpen}
        style={{
          flex: 1, minWidth: 0, textAlign: "left", background: "transparent", border: 0,
          padding: 0, cursor: "pointer", color: "inherit", fontFamily: "inherit",
        }}>
        <span style={{ display: "block", fontSize: 13.5, fontWeight: 750, color: "#fff" }}>{banner.title}</span>
        <span style={{
          display: "block", fontSize: 11.5, color: "rgba(233,238,255,.6)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{banner.body} · Tap to open</span>
      </button>

      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          flex: "0 0 auto", width: 30, height: 30, borderRadius: 9, cursor: "pointer",
          border: "1px solid rgba(255,255,255,.1)", background: "rgba(255,255,255,.04)",
          color: "rgba(233,238,255,.55)", fontSize: 14, lineHeight: 1,
        }}>
        ✕
      </button>
    </div>
  );
}
