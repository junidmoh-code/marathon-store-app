// ─── OPENING THE RIGHT SCREEN FROM A NOTIFICATION ────────────────────────────
// The notification's link is /?push=refill&hub=hub1&tab=hub1refill.
//
// ── WHY A QUERY STRING AND localStorage, NOT A NEW ROUTE ────────────────────
// This app's navigation is not a router. The workspace is `role` in App state,
// seeded once from localStorage("marathon_role"); the tab within Source is
// seeded once from localStorage("tabState:source") (components/stock/hooks.js).
// Both are read at first render.
//
// So the smallest honest deep link is to write those two keys BEFORE React
// mounts and then let the app's existing seeding do exactly what it already
// does. That adds no route, no parser, no second source of truth about where a
// screen lives, and it cannot desynchronise from the navigation it targets —
// because it IS the navigation.
//
// It is also correctly gated for free: App's role-reset effect already drops a
// user home when their persisted role is one they may not open. A notification
// therefore cannot become a way into a screen someone lacks access to; the
// worst case for a wrongly-targeted tap is landing on the home page.

const ROLE_KEY = "marathon_role";
const SOURCE_TAB_KEY = "tabState:source";
const SOURCE_ROLE = "source";
const VALID_TABS = new Set(["hub1refill", "clothing", "refillhistory"]);

/**
 * Consume a push deep link from the current URL, if there is one.
 * Call BEFORE React mounts. Returns what it applied, for tests and logging.
 *
 * @param {object} [io] injectable window/localStorage for tests
 */
export function applyPushDeepLink(io = {}) {
  const win = io.window || (typeof window === "undefined" ? null : window);
  const store = io.localStorage || (typeof localStorage === "undefined" ? null : localStorage);
  if (!win || !win.location) return null;

  let params;
  try { params = new URLSearchParams(win.location.search || ""); } catch { return null; }
  if (params.get("push") !== "refill") return null;

  const tabParam = params.get("tab");
  const tab = VALID_TABS.has(tabParam) ? tabParam : "hub1refill";

  try {
    store?.setItem(ROLE_KEY, SOURCE_ROLE);
    store?.setItem(SOURCE_TAB_KEY, tab);
  } catch { /* private mode: the app still opens, just on the last screen */ }

  // Strip the query so a refresh, a shared URL or a back-navigation does not
  // silently re-route someone who has since walked to another screen.
  try {
    const url = new URL(win.location.href);
    url.search = "";
    win.history?.replaceState?.({}, "", url.pathname + url.hash);
  } catch { /* leaving the query on is cosmetic, not harmful */ }

  return { role: SOURCE_ROLE, tab, hub: params.get("hub") || null };
}

/** The same routing, for a notification tapped while the app is already open —
 *  the service worker postMessages the link rather than reloading the tab. */
export function routeFromPushMessage(link, io = {}) {
  const win = io.window || (typeof window === "undefined" ? null : window);
  if (!win || typeof link !== "string") return null;
  let params;
  try { params = new URLSearchParams(link.split("?")[1] || ""); } catch { return null; }
  if (params.get("push") !== "refill") return null;
  const tabParam = params.get("tab");
  const tab = VALID_TABS.has(tabParam) ? tabParam : "hub1refill";
  const store = io.localStorage || (typeof localStorage === "undefined" ? null : localStorage);
  try {
    store?.setItem(ROLE_KEY, SOURCE_ROLE);
    store?.setItem(SOURCE_TAB_KEY, tab);
  } catch { /* ignored */ }
  // A running tab has already seeded its state from these keys, so the only way
  // to act on them is a reload. Deliberate and visible: the alternative is a
  // second navigation API that exists solely for notifications.
  try { win.location.reload(); } catch { /* ignored */ }
  return { role: SOURCE_ROLE, tab };
}
