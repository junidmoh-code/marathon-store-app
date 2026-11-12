// ─── ONE SCROLLING ROW — the edge fade + the selected chip in view ──────────
// A chip / tab row is one line that scrolls sideways (Junid, 12 Nov). Two
// things make that readable:
//   • the row fades at an edge ONLY while there is more to scroll that way
//     (data-fade="l" | "r" | "lr" on the row; sky-stock.css draws the mask) —
//     a row that fits is drawn whole, never with a faded last chip;
//   • the selected chip ([aria-selected=true] / [aria-pressed=true]) is
//     scrolled into the middle of the row whenever `selectedKey` changes, by
//     scrolling the ROW only — the page never jumps.
// Presentation only.

import { useEffect, useRef } from "react";

export function useScrollRow(selectedKey) {
  const ref = useRef(null);

  useEffect(() => {
    const row = ref.current;
    if (!row || typeof window === "undefined") return undefined;
    const update = () => {
      const max = row.scrollWidth - row.clientWidth;
      const l = row.scrollLeft > 2, r = row.scrollLeft < max - 2;
      const v = `${l ? "l" : ""}${r && max > 2 ? "r" : ""}`;
      if (v) row.dataset.fade = v; else delete row.dataset.fade;
    };
    update();
    row.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    ro?.observe(row);
    return () => { row.removeEventListener("scroll", update); window.removeEventListener("resize", update); ro?.disconnect(); };
  }, []);

  useEffect(() => {
    const row = ref.current;
    const el = row?.querySelector?.('[aria-selected="true"], [aria-pressed="true"]');
    if (!row || !el || typeof row.scrollTo !== "function") return;
    const left = row.scrollLeft + (el.getBoundingClientRect().left - row.getBoundingClientRect().left) - (row.clientWidth - el.offsetWidth) / 2;
    row.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  }, [selectedKey]);

  return ref;
}
