// ─── STOCK UI TOKENS ──────────────────────────────────────────────────────────
// Self-contained design tokens for the Stock section. Mirrors the values defined
// in App.jsx (FONT/BG/CARD/BLUE/…) so the new components stay visually consistent
// WITHOUT importing from the 9k-line App.jsx monolith (avoids a circular import
// and keeps the Stock module independently testable / portable to the POS app).
// If the app-wide tokens ever change, update both — they are intentionally a copy.

// Refreshed to the AI Studio / workspace language: near-neutral white-on-black
// glass, blue accent reserved for state (active / interactive), softer radii.
export const FONT   = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";
export const BG     = "#000000";
export const CARD   = "rgba(255,255,255,.024)";
export const BLUE   = "#4A7FFF";
export const BLUE_L = "#9DBCFF";
export const BORDER = "1px solid rgba(255,255,255,.08)";
export const BORDER_BRIGHT = "1px solid rgba(74,127,255,.55)";
export const RADIUS = "15px";
export const GLOW   = "0 0 12px rgba(60,110,255,.15)";

// Glass finish — subtle translucent surface for the reworked Stock screens.
export const GLASS = {
  background: "linear-gradient(180deg, rgba(255,255,255,.02), transparent 55%), rgba(255,255,255,.022)",
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  border: "1px solid rgba(255,255,255,.08)",
  borderRadius: RADIUS,
  boxShadow: "0 10px 30px -18px rgba(0,0,0,.6)",
};

// OPAQUE variant for floating overlays/sheets — the translucent GLASS lets the list
// behind bleed through and become unreadable. Same finish, solid background.
export const GLASS_SOLID = { ...GLASS, background: "#0a0e18", backdropFilter: "none", WebkitBackdropFilter: "none", boxShadow: "0 30px 80px -20px rgba(0,0,0,.8)" };

export const GREEN = "#4ADE80";
export const RED   = "#F87171";
export const GRAY  = "#9CA3AF";
export const AMBER = "#FBBF24";

// Button presets — pill radius, cleaner tints.
const BR = "11px";
export const bGreen = { background:"rgba(74,222,128,.16)",  border:"1px solid rgba(74,222,128,.45)",  color:GREEN, borderRadius:BR, fontWeight:"700", cursor:"pointer", fontSize:"0.85rem", padding:"10px 14px", fontFamily:FONT };
export const bRed   = { background:"rgba(248,113,113,.14)", border:"1px solid rgba(248,113,113,.4)",  color:RED,   borderRadius:BR, fontWeight:"700", cursor:"pointer", fontSize:"0.85rem", padding:"10px 14px", fontFamily:FONT };
export const bBlue  = { background:"rgba(74,127,255,.12)",  border:"1px solid rgba(74,127,255,.4)",   color:BLUE_L,borderRadius:BR, fontWeight:"700", cursor:"pointer", fontSize:"0.85rem", padding:"10px 14px", fontFamily:FONT };
export const bGray  = { background:"rgba(255,255,255,.05)", border:"1px solid rgba(255,255,255,.14)", color:"#dfe7ff", borderRadius:BR, fontWeight:"700", cursor:"pointer", fontSize:"0.85rem", padding:"10px 14px", fontFamily:FONT };
export const bGhost = { background:"rgba(255,255,255,.03)", border:"1px solid rgba(255,255,255,.14)", color:"#dfe7ff", borderRadius:BR, fontWeight:"700", cursor:"pointer", fontSize:"0.85rem", padding:"10px 14px", fontFamily:FONT };

export const tabOn  = { background:"rgba(74,127,255,.16)", border:"1px solid rgba(74,127,255,.45)", color:BLUE_L, borderRadius:"999px", padding:"7px 14px", fontWeight:700, cursor:"pointer", fontSize:"0.8rem", fontFamily:FONT };
export const tabOff = { background:"rgba(255,255,255,.03)", border:"1px solid rgba(255,255,255,.1)", color:GRAY,  borderRadius:"999px", padding:"7px 14px", fontWeight:700, cursor:"pointer", fontSize:"0.8rem", fontFamily:FONT };

export const input  = { background:"rgba(255,255,255,.05)", border:"1px solid rgba(255,255,255,.14)", color:"#fff", borderRadius:"12px", padding:"11px 13px", fontSize:"0.92rem", fontFamily:FONT, outline:"none" };
