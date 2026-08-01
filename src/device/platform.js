// ─── Platform class: computer or mobile device? ──────────────────────────────
// The single source of truth for "is this a phone/tablet, or a computer?".
//
// WHY THIS EXISTS (2026-08-01)
// The desktop workspaces (Home, Store Assistant, Insights) switch on
// `!useIsNarrow(1024)` — pure viewport width. That misfires on the shop's
// Proline POS terminals: a Windows x64 machine with a 10-point touchscreen on a
// 1024x600 panel reports an innerWidth of exactly 1024, and `(max-width: 1024px)`
// MATCHES at 1024 — so a desktop computer got the phone layout, despite the code
// comments promising the desktop workspace "≥1024px". Windows display scaling
// widens the gap: a 1366px panel at 125% scale reports 1092px, at 150% only 910px.
//
// A computer is a computer whatever its panel measures. Screen size answers
// "how much room is there?"; it can never answer "what kind of device is this?".
//
// THE RULES (first match wins)
//   1. Windows is ALWAYS a computer. Not negotiable — no touchscreen, panel
//      size, orientation or stray UA token may downgrade a Windows PC.
//   2. Chromium client hints (`navigator.userAgentData`) — structured data
//      rather than a string to parse, and the shops run Chrome.
//   3. User-agent OS tokens, for engines without client hints.
//   4. iPadOS 13+ in desktop mode, the one case where a touch count is meaningful.
//   5. Anything unrecognised is a computer — a till that fails detection must
//      still get the full workspace.
//
// DELIBERATELY NOT USED: window.innerWidth / screen size / orientation (a small
// window is not a phone), `ontouchstart` or a bare `maxTouchPoints > 0` (every
// till, 2-in-1 and touchscreen laptop reports touch).
//
// Phones and Android tablets are unaffected: they classify as "mobile" and keep
// the width-driven mobile UI exactly as before.

const DESKTOP = "desktop";
const MOBILE = "mobile";

// `userAgentData.platform` values that are computers.
const DESKTOP_HINT_PLATFORMS = new Set([
  "Windows",
  "macOS",
  "Mac OS X",
  "Linux",
  "Chrome OS",
  "Chromium OS",
]);

function currentNavigator() {
  return typeof navigator === "undefined" ? undefined : navigator;
}

/**
 * Classify the client as "desktop" or "mobile" from the OPERATING SYSTEM.
 * @param {Navigator} [nav] injectable for tests; defaults to window.navigator.
 * @returns {"desktop"|"mobile"}
 */
export function detectPlatform(nav = currentNavigator()) {
  if (!nav) return DESKTOP; // no DOM (SSR / node test) — a workspace is the safe default

  const ua = String(nav.userAgent || "");
  const uaData = nav.userAgentData;
  const hintPlatform = typeof uaData?.platform === "string" ? uaData.platform : "";

  // Windows Phone / Windows Mobile carry "Windows" in the UA — catch them
  // BEFORE the Windows-is-a-computer rule below.
  if (/Windows Phone|Windows Mobile|IEMobile/i.test(ua)) return MOBILE;

  // RULE 1 — any Windows PC is a computer, full stop.
  if (hintPlatform === "Windows") return DESKTOP;
  if (/Windows NT|Win64|WOW64|Windows/i.test(ua)) return DESKTOP;

  // RULE 2 — Chromium client hints.
  if (hintPlatform === "Android") return MOBILE;
  if (DESKTOP_HINT_PLATFORMS.has(hintPlatform)) return DESKTOP;
  if (uaData && uaData.mobile === true) return MOBILE;

  // RULE 3 — UA OS tokens. Bare /Android/ (no "Mobile" token required) so
  // Android TABLETS stay on the mobile UI too.
  if (/Android/i.test(ua)) return MOBILE;
  if (/iPhone|iPod|iPad/i.test(ua)) return MOBILE;
  if (/\b(?:KAIOS|BlackBerry|BB10|Opera Mini|Silk|Kindle)\b/i.test(ua)) return MOBILE;

  // RULE 4 — iPadOS 13+ requests desktop sites and claims to be a Macintosh.
  // A real Mac has no touchscreen, so a Mac UA reporting multi-touch is an iPad.
  // The ONLY place a touch count is consulted, and only ever for Apple hardware.
  if (/Macintosh|Mac OS X/i.test(ua) && Number(nav.maxTouchPoints || 0) > 1) return MOBILE;

  // RULE 5 — remaining desktop OS tokens, then the safe default.
  if (/Macintosh|Mac OS X|CrOS|X11|Linux/i.test(ua)) return DESKTOP;
  return DESKTOP;
}

/** True for Windows / macOS / Linux / ChromeOS machines. */
export function isDesktopPlatform(nav) {
  return detectPlatform(nav) === DESKTOP;
}

/** True only for real phones and tablets (Android, iOS/iPadOS). */
export function isMobilePlatform(nav) {
  return detectPlatform(nav) === MOBILE;
}
