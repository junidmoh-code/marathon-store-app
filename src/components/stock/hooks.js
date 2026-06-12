// ─── STOCK HOOKS (small shared) ───────────────────────────────────────────────
// usePersistedTab mirrors the App.jsx helper (localStorage-backed active tab) so
// the Stock section remembers its tab without importing from the monolith.

import { useState } from "react";

export function usePersistedTab(sectionKey, defaultTab) {
  const storageKey = `tabState:${sectionKey}`;
  const [tab, setTabRaw] = useState(() => {
    try { return localStorage.getItem(storageKey) || defaultTab; }
    catch { return defaultTab; }
  });
  const setTab = (next) => {
    try { localStorage.setItem(storageKey, next); } catch { /* ignored */ }
    setTabRaw(next);
  };
  return [tab, setTab];
}
