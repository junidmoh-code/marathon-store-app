// ─── OPENING THE RIGHT SCREEN FROM A NOTIFICATION ────────────────────────────
// The notification's link is
//   /?push=order&hub=hub2&tab=queue&order=005&at=2026-09-06T07:07:41.633Z
// and a burst's is the same without `order` / `at`.
//
// ── WHY A QUERY STRING AND localStorage, NOT A NEW ROUTE ────────────────────
// This app's navigation is not a router. The workspace is `role` in App state,
// seeded once from localStorage("marathon_role"); the warehouse's hub is
// localStorage("warehouseHub") and its tab localStorage("tabState:warehouse"),
// both read at first render.
//
// So the smallest honest deep link is to write those keys BEFORE React mounts
// and then let the app's existing seeding do exactly what it already does. That
// adds no route, no parser, no second source of truth about where a screen
// lives, and it cannot desynchronise from the navigation it targets — because
// it IS the navigation.
//
// It is also correctly gated for free: App's role-reset effect already drops a
// user home when their persisted role is one they may not open. A notification
// therefore cannot become a way into a screen someone lacks access to; the
// worst case for a wrongly-targeted tap is landing on the home page.
//
// ── THE ORDER ITSELF, NOT THE LIST IT IS ON ─────────────────────────────────
// A queue at a busy hub is dozens of cards deep, so "we took you to the right
// screen" still leaves the reader hunting for the thing they were just told
// about. A single-order link therefore also leaves a FOCUS marker, which
// WarehouseView consumes once to scroll that card into view and ring it.
//
// The marker carries id AND createdAt, never the bare id: order numbers are
// recycled daily (001–999, R001–R999), so a bare id would ring an unrelated
// card from a previous day at the same number. It also carries the moment it
// was written, so a marker left behind by a tap nobody followed up on expires
// instead of hijacking a later, unrelated visit to the warehouse.

const ROLE_KEY = "marathon_role";
const SOURCE_TAB_KEY = "tabState:source";
const SOURCE_ROLE = "source";
const VALID_TABS = new Set(["hub1refill", "clothing", "refillhistory"]);

const WAREHOUSE_ROLE = "warehouse";
const WAREHOUSE_HUB_KEY = "warehouseHub";
const WAREHOUSE_TAB_KEY = "tabState:warehouse";
// The hubs the warehouse selector actually offers. A hub outside this list is
// dropped rather than written: a persisted `warehouseHub` the selector cannot
// render is a blank screen, which reads as the app being broken.
const VALID_HUBS = new Set(["hub1", "hub2", "hub3", "hubC"]);
const VALID_WAREHOUSE_TABS = new Set(["queue", "clothing"]);

/** Where a single-order link leaves the card to ring. Read (and cleared) by
 *  WarehouseView. Session-scoped in spirit but written to localStorage because
 *  the notification tap may open a NEW tab, which does not inherit
 *  sessionStorage from the one that was already open. */
export const FOCUS_ORDER_KEY = "marathon.push.focusOrder";
/** How long a focus marker is honoured. Long enough to survive a sign-in or a
 *  slow first paint, short enough that yesterday's tap does not ring a card. */
export const FOCUS_ORDER_TTL_MS = 5 * 60 * 1000;

function writeFocusOrder(store, id, at, nowMs) {
  if (!store || !id) return null;
  const marker = { id: String(id), createdAt: at == null ? "" : String(at), writtenAt: nowMs };
  try { store.setItem(FOCUS_ORDER_KEY, JSON.stringify(marker)); } catch { return null; }
  return marker;
}

/** Read the focus marker once and remove it. Returns null for anything
 *  malformed, missing or expired — every branch total, because this runs on a
 *  screen a picker is using and must never be the reason it throws. */
export function takeFocusOrder(io = {}) {
  const store = io.localStorage || (typeof localStorage === "undefined" ? null : localStorage);
  const nowMs = typeof io.nowMs === "number" ? io.nowMs : Date.now();
  if (!store) return null;
  let raw = null;
  try { raw = store.getItem(FOCUS_ORDER_KEY); } catch { return null; }
  if (!raw) return null;
  // Consumed on read, success or failure: a marker that cannot be used must not
  // sit there being re-tried on every mount.
  try { store.removeItem(FOCUS_ORDER_KEY); } catch { /* nothing more to do */ }
  let marker = null;
  try { marker = JSON.parse(raw); } catch { return null; }
  if (!marker || typeof marker !== "object" || typeof marker.id !== "string" || !marker.id) return null;
  const writtenAt = Number(marker.writtenAt) || 0;
  if (!writtenAt || nowMs - writtenAt > FOCUS_ORDER_TTL_MS) return null;
  return { id: marker.id, createdAt: typeof marker.createdAt === "string" ? marker.createdAt : "" };
}

/** The card key WarehouseView stamps on each order card, and the one a focus
 *  marker matches against. id alone is recycled; id + createdAt is not. */
export function orderCardKey(id, createdAt) {
  return `${id == null ? "" : id}::${createdAt == null ? "" : createdAt}`;
}

// Apply an order link's navigation. Shared by the cold-open and already-open
// paths so the two cannot drift apart.
function applyOrderLink(params, store, nowMs) {
  const hubParam = params.get("hub");
  const hub = VALID_HUBS.has(hubParam) ? hubParam : null;
  const tabParam = params.get("tab");
  const tab = VALID_WAREHOUSE_TABS.has(tabParam) ? tabParam : "queue";
  try {
    store?.setItem(ROLE_KEY, WAREHOUSE_ROLE);
    // No hub in the link (or one this app does not offer) leaves the warehouse
    // on whichever hub the reader last used, which is a real screen. Writing a
    // hub the selector cannot render would be worse than not routing at all.
    if (hub) store?.setItem(WAREHOUSE_HUB_KEY, hub);
    if (hub) store?.setItem(WAREHOUSE_TAB_KEY, tab);
  } catch { /* private mode: the app still opens, just on the last screen */ }
  const focus = writeFocusOrder(store, params.get("order"), params.get("at"), nowMs);
  return { role: WAREHOUSE_ROLE, hub, tab, order: focus ? focus.id : null };
}

function applyRefillLink(params, store) {
  const tabParam = params.get("tab");
  const tab = VALID_TABS.has(tabParam) ? tabParam : "hub1refill";
  try {
    store?.setItem(ROLE_KEY, SOURCE_ROLE);
    store?.setItem(SOURCE_TAB_KEY, tab);
  } catch { /* private mode: the app still opens, just on the last screen */ }
  return { role: SOURCE_ROLE, tab, hub: params.get("hub") || null };
}

/**
 * Consume a push deep link from the current URL, if there is one.
 * Call BEFORE React mounts. Returns what it applied, for tests and logging.
 *
 * @param {object} [io] injectable window/localStorage for tests
 */
export function applyPushDeepLink(io = {}) {
  const win = io.window || (typeof window === "undefined" ? null : window);
  const store = io.localStorage || (typeof localStorage === "undefined" ? null : localStorage);
  const nowMs = typeof io.nowMs === "number" ? io.nowMs : Date.now();
  if (!win || !win.location) return null;

  let params;
  try { params = new URLSearchParams(win.location.search || ""); } catch { return null; }
  const kind = params.get("push");
  // `refill` is still honoured: a notification sent before this build shipped
  // can be sitting on a lock screen right now, and a link that does nothing
  // when tapped is indistinguishable from an app that is broken.
  if (kind !== "order" && kind !== "refill") return null;

  const applied = kind === "order"
    ? applyOrderLink(params, store, nowMs)
    : applyRefillLink(params, store);

  // Strip the query so a refresh, a shared URL or a back-navigation does not
  // silently re-route someone who has since walked to another screen.
  try {
    const url = new URL(win.location.href);
    url.search = "";
    win.history?.replaceState?.({}, "", url.pathname + url.hash);
  } catch { /* leaving the query on is cosmetic, not harmful */ }

  return applied;
}

/** The same routing, for a notification tapped while the app is already open —
 *  the service worker postMessages the link rather than reloading the tab. */
export function routeFromPushMessage(link, io = {}) {
  const win = io.window || (typeof window === "undefined" ? null : window);
  if (!win || typeof link !== "string") return null;
  let params;
  try { params = new URLSearchParams(link.split("?")[1] || ""); } catch { return null; }
  const kind = params.get("push");
  if (kind !== "order" && kind !== "refill") return null;
  const store = io.localStorage || (typeof localStorage === "undefined" ? null : localStorage);
  const nowMs = typeof io.nowMs === "number" ? io.nowMs : Date.now();
  const applied = kind === "order"
    ? applyOrderLink(params, store, nowMs)
    : applyRefillLink(params, store);
  // A running tab has already seeded its state from these keys, so the only way
  // to act on them is a reload. Deliberate and visible: the alternative is a
  // second navigation API that exists solely for notifications.
  try { win.location.reload(); } catch { /* ignored */ }
  return applied;
}
