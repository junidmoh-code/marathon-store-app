// ─── STOCK UI TOKENS ──────────────────────────────────────────────────────────
// Self-contained design tokens for the Stock section. Mirrors the values defined
// in App.jsx (FONT/BG/CARD/BLUE/…) so the new components stay visually consistent
// WITHOUT importing from the 9k-line App.jsx monolith (avoids a circular import
// and keeps the Stock module independently testable / portable to the POS app).
// If the app-wide tokens ever change, update both — they are intentionally a copy.

export const FONT   = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";
export const BG     = "#000000";
export const CARD   = "rgba(4,5,10,1)";
export const BLUE   = "#4A7FFF";
export const BLUE_L = "#6A9FFF";
export const BORDER = "1px solid rgba(60,110,255,.12)";
export const BORDER_BRIGHT = "1px solid rgba(60,110,255,.6)";
export const RADIUS = "14px";
export const GLOW   = "0 0 12px rgba(60,110,255,.15)";

export const GREEN = "#4ADE80";
export const RED   = "#F87171";
export const GRAY  = "#9CA3AF";
export const AMBER = "#FBBF24";

// Button presets (match App.jsx bGreen/bRed/bBlue/bGray families).
export const bGreen = { background:"rgba(0,150,70,.2)",     border:"1px solid rgba(0,150,70,.5)",     color:GREEN, borderRadius:RADIUS, fontWeight:"600", cursor:"pointer", fontSize:"0.85rem", padding:"10px 14px" };
export const bRed   = { background:"rgba(150,20,20,.15)",   border:"1px solid rgba(150,20,20,.4)",    color:RED,   borderRadius:RADIUS, fontWeight:"600", cursor:"pointer", fontSize:"0.85rem", padding:"10px 14px" };
export const bBlue  = { background:"rgba(60,110,255,.08)",  border:"1px solid rgba(60,110,255,.25)",  color:BLUE,  borderRadius:RADIUS, fontWeight:"600", cursor:"pointer", fontSize:"0.85rem", padding:"10px 14px" };
export const bGray  = { background:"rgba(100,100,100,.12)", border:"1px solid rgba(100,100,100,.25)", color:GRAY,  borderRadius:RADIUS, fontWeight:"600", cursor:"pointer", fontSize:"0.85rem", padding:"10px 14px" };
export const bGhost = { background:"transparent",           border:"1px solid rgba(60,110,255,.25)",  color:BLUE,  borderRadius:RADIUS, fontWeight:"600", cursor:"pointer", fontSize:"0.85rem", padding:"10px 14px" };

export const tabOn  = { background:"rgba(60,110,255,.15)", border:"1px solid rgba(60,110,255,.45)", color:BLUE_L, borderRadius:"10px", padding:"7px 12px", fontWeight:600, cursor:"pointer", fontSize:"0.8rem" };
export const tabOff = { background:"transparent",          border:"1px solid rgba(60,110,255,.15)", color:GRAY,   borderRadius:"10px", padding:"7px 12px", fontWeight:600, cursor:"pointer", fontSize:"0.8rem" };

export const input  = { background:"rgba(255,255,255,.04)", border:BORDER, color:"#fff", borderRadius:"10px", padding:"9px 11px", fontSize:"0.9rem", fontFamily:FONT, outline:"none" };
