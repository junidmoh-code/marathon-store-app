// ─── STOCK HOOKS (small shared) ───────────────────────────────────────────────
// usePersistedTab mirrors the App.jsx helper (localStorage-backed active tab) so
// the Stock section remembers its tab without importing from the monolith.

import { useState, useEffect } from "react";

// Laptop breakpoint — flips a stock screen into its centered workspace layout.
export function useWide(px = 1024) {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(`(min-width:${px}px)`).matches);
  useEffect(() => {
    const m = window.matchMedia(`(min-width:${px}px)`);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [px]);
  return wide;
}

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
