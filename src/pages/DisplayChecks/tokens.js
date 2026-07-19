// ─── DISPLAY CHECKS — Marathon Glass design tokens ───────────────────────────
// One source for the module's palette so the shell (index.jsx) and the feed
// (TodayView / CheckCard) can't drift apart. Marathon Glass: pitch-black glossy
// ground, frosted panels, electric-blue accents. Anything the SYSTEM recorded
// renders in META (monospace, uppercase, wide tracking — the cold register);
// human copy stays in FONT (sans). Palette discipline (§8.9): blue = normal,
// amber = look-at-it (repeat/override), red = marks only (scarce).

export const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";
export const MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";
export const BLUE = "#4A7FFF";
export const BLUE_SOFT = "#6A9FFF";
export const AMBER = "#E8A54A";
export const INK = "#f3f6ff";
export const GLASS_BG = "rgba(255,255,255,.03)";
export const GLASS_BORDER = "1px solid rgba(74,127,255,.16)";

export const PANEL = {
  background: GLASS_BG,
  border: GLASS_BORDER,
  borderRadius: 16,
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
};

// Ledger metadata — monospace, uppercase, wide tracking. The cold register.
export const META = {
  fontFamily: MONO,
  textTransform: "uppercase",
  letterSpacing: "0.12em",
  color: "rgba(233,238,255,.45)",
  fontSize: 11,
};
