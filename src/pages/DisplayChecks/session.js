// ─── DISPLAY CHECKS — UI SESSION STATE (outlives the module's mount) ──────────
// The module and its tab bodies unmount on navigation — an in-app tab switch, a
// rotation that crosses the desktop breakpoint, or leaving the module entirely.
// React state inside those components dies on unmount, which is why the boards
// used to reset to empty on every return.
//
// This is a plain module-scoped singleton, NOT React state: it lives for the life
// of the page, so on remount the module rehydrates exactly where the user was —
// active tab, Availability search + selection, per-tab scroll, and a last-feed
// snapshot for an instant (no-empty-flash) paint while the live listener
// re-attaches. It holds only UI state; it never touches RTDB.
//
// Feed snapshots are keyed by store (a super-admin store switch must not show the
// other store's checks). Tab / search / scroll are per-session.

export const dcSession = {
  uid: null,               // whose session this is — reset when it changes
  activeTab: "today",
  search: "",              // Availability: the unified search-bar text
  selectedId: null,        // Availability: the picked product's id (re-looked-up in products)
  scroll: {},              // { tabKey: scrollTop } — per-tab scroll position
  feedByStore: {},         // { storeId: { activeItems, completedItems, saDate } } — last good snapshot
};

// Bind the session to a user; if it differs from whoever it held, wipe first. The
// marker lives in the singleton (NOT a component ref) so a logout that UNMOUNTS
// the module still clears on the next user's mount — logout→login on the same
// device never leaks the prior user's tab/search/selection/feed-cache. Safe to
// call from an effect on every mount; a no-op when the uid is unchanged.
export function bindDcSession(uid) {
  const u = uid || null;
  if (dcSession.uid === u) return;
  dcSession.uid = u;
  dcSession.activeTab = "today";
  dcSession.search = "";
  dcSession.selectedId = null;
  dcSession.scroll = {};
  dcSession.feedByStore = {};
}
