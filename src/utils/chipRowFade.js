// ─── CHIP ROW EDGE FADE — which side has more to scroll ──────────────────────
// Every chip / tab row is one line that scrolls sideways (src/styles/sky-chips.css).
// Its edge fades ONLY on a side where there is more to see: this keeps
// data-fade = "l" | "r" | "lr" (or nothing) on each row. Presentation only.
// One passive capture-phase scroll listener, a resize listener, and a
// MutationObserver debounced to 200ms for rows that mount later (a busy list
// re-rendering does not re-query the page every frame).

export const CHIP_ROW_SELECTOR = [
  "[data-chip-row]",
  '[role="tablist"]:not(.wht-tiles)',
  '#root [style*="flex-wrap: wrap"]:has(> button[style*="border-radius: 999px"], > button[style*="border-radius: 20px"], > button[style*="border-radius: 99px"], > button[style*="border-radius: 100px"]):not(:has(> :not(button, [data-chip-count])))',
].join(",");

export function fadeFor(row) {
  const max = row.scrollWidth - row.clientWidth;
  if (max <= 2) return "";
  return `${row.scrollLeft > 2 ? "l" : ""}${row.scrollLeft < max - 2 ? "r" : ""}`;
}

function apply(row) {
  const v = fadeFor(row);
  if ((row.dataset.fade || "") === v) return;
  if (v) row.dataset.fade = v; else delete row.dataset.fade;
}

let started = false;
export function startChipRowFade(doc = typeof document !== "undefined" ? document : null) {
  if (started || !doc || typeof window === "undefined") return;
  started = true;
  let queued = false;
  const all = () => {
    queued = false;
    let rows;
    try { rows = doc.querySelectorAll(CHIP_ROW_SELECTOR); } catch { rows = doc.querySelectorAll("[data-chip-row], [role=tablist]"); }   // no :has()
    rows.forEach(apply);
  };
  const queue = () => { if (!queued) { queued = true; setTimeout(all, 200); } };
  doc.addEventListener("scroll", (e) => {
    const t = e.target;
    if (t && t.nodeType === 1 && t.matches) { try { if (t.matches(CHIP_ROW_SELECTOR)) apply(t); } catch { /* old engine */ } }
  }, { capture: true, passive: true });
  window.addEventListener("resize", queue, { passive: true });
  if (typeof MutationObserver === "function") new MutationObserver(queue).observe(doc.body, { childList: true, subtree: true });
  queue();
}
