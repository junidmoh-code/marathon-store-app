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
  activeTab: "today",
  search: "",              // Availability: the unified search-bar text
  selectedId: null,        // Availability: the picked product's id (re-looked-up in products)
  scroll: {},              // { tabKey: scrollTop } — per-tab scroll position
  feedByStore: {},         // { storeId: { activeItems, completedItems, saDate } } — last good snapshot
};
