// ─── A HUMAN NAME FOR A REGISTERED DEVICE ────────────────────────────────────
// /push_tokens rows are read by a person deciding whether a token belongs to a
// phone still in use. "mobile · iPhone Safari · 4f2c" answers that; a bare UUID
// does not.
//
// Deliberately coarse. This is a label, not fingerprinting: an OS family, a
// browser family, whether the app is installed to the Home Screen, and the first
// four characters of the device id already stored by src/device/deviceId.js.
// Nothing here is new information about the user — every part is either already
// stored or trivially derived from the request the browser sends anyway.

const BROWSERS = [
  // Order matters: every Chromium browser claims Safari, and Edge claims Chrome.
  [/EdgiOS|Edg\//i, "Edge"],
  [/CriOS|Chrome\//i, "Chrome"],
  [/FxiOS|Firefox\//i, "Firefox"],
  [/Safari\//i, "Safari"],
];

const SYSTEMS = [
  [/iPhone/i, "iPhone"],
  [/iPad/i, "iPad"],
  [/Android/i, "Android"],
  [/Windows/i, "Windows"],
  [/Macintosh|Mac OS X/i, "Mac"],
  [/CrOS/i, "ChromeOS"],
  [/Linux/i, "Linux"],
];

function firstMatch(table, ua, fallback) {
  for (const [re, name] of table) if (re.test(ua)) return name;
  return fallback;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.userAgent] injectable for tests
 * @param {string|null} [opts.deviceId] from src/device/deviceId.js (may be null)
 * @param {boolean} [opts.standalone] true when running as an installed PWA
 */
export function describeDevice({ userAgent, deviceId, standalone } = {}) {
  const ua = String(
    userAgent != null ? userAgent : (typeof navigator === "undefined" ? "" : navigator.userAgent || ""),
  );
  const system = firstMatch(SYSTEMS, ua, "Device");
  const browser = firstMatch(BROWSERS, ua, "Browser");
  // The installed-vs-browser distinction is the single most useful fact on this
  // row: on iPhone, web push ONLY works from the Home Screen copy, so a support
  // question is usually answered by this word alone.
  const install = standalone ? "installed" : "browser";
  const short = deviceId ? String(deviceId).slice(0, 4) : "nodev";
  return `${system} ${browser} · ${install} · ${short}`;
}

/** True when the page is running as an installed app rather than a browser tab. */
export function isStandalone() {
  if (typeof window === "undefined") return false;
  try {
    // iOS uses the legacy navigator.standalone; everyone else the media query.
    if (window.navigator && window.navigator.standalone === true) return true;
    return !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  } catch {
    return false;
  }
}
