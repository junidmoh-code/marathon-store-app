// ─── THE ONE OVERLAY (Junid, 6 Nov — "popup readability") ────────────────────
//
// Every sky popover, menu, sheet and dialog renders through this: a body-level
// portal (so no ancestor's transform / overflow / backdrop can break it), a
// full-screen scrim that dims AND blurs the page behind (rgba(10,40,100,.35),
// 6px), and the panel on STRONG glass (0.62 white, blur 28 saturate 1.6, 1px
// rim, inset top highlight, blue shadow) with navy text. It is safe-area aware,
// closes on a scrim tap and on Escape (only the top-most overlay answers),
// traps focus while open and gives it back after, locks and restores the page
// scroll, and never zooms (its inputs follow the app's 16px rule).
//
// Variants:
//   "anchored" — hangs under its anchor (the desktop pill / round);
//   "sheet"    — slides up from the bottom with a drag handle, max 70vh,
//                scrolls inside; a drag down closes it;
//   "dialog"   — centred, max-width 360 (a confirmation: a message card and
//                button cards below it — the panel itself draws no glass);
//   "auto"     — sheet on a phone (< 768px), else anchored when there is an
//                anchor, else dialog.
//
// With no document (react-test-renderer) it renders inline, so the existing
// render tests still find every control.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const cx = (...a) => a.filter(Boolean).join(" ");
const PHONE = 768;
const stack = [];                       // open overlays, top-most last (Escape goes to the top one)
const FOCUSABLE = 'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const narrow = () => typeof window !== "undefined" && (window.innerWidth || 1024) < PHONE;

export default function SkyOverlay({
  open = true, onClose, variant = "auto", anchorRef = null, align = "start", width = 260,
  label, role = "dialog", testId, scrimTestId, className = "", children,
}) {
  const canPortal = typeof document !== "undefined" && !!document.body && typeof document.body.appendChild === "function";
  const panelRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [phone, setPhone] = useState(narrow);
  const [pos, setPos] = useState(null);
  const [dy, setDy] = useState(0);
  const drag = useRef(null);
  const v = variant === "auto" ? (phone ? "sheet" : anchorRef ? "anchored" : "dialog") : variant;

  useEffect(() => {
    if (!canPortal || !window.addEventListener) return undefined;
    const on = () => setPhone(narrow());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [canPortal]);

  // Anchored: under the anchor, kept on screen.
  useLayoutEffect(() => {
    if (!open || !canPortal || v !== "anchored") return undefined;
    const place = () => {
      const r = anchorRef?.current?.getBoundingClientRect?.();
      if (!r) return;
      const vw = window.innerWidth;
      let left = align === "end" ? r.right - width : align === "center" ? r.left + r.width / 2 - width / 2 : r.left;
      left = Math.max(12, Math.min(left, vw - width - 12));
      setPos({ top: r.bottom + 10, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, canPortal, v, align, width, anchorRef]);

  // Escape (top-most only), focus trap + restore, scroll lock + restore.
  useEffect(() => {
    if (!open || !canPortal) return undefined;
    const me = {};
    stack.push(me);
    // Focus goes back to the anchor (Safari never focuses a clicked button, so
    // "whatever had focus" is often <body>), else to what had it.
    const prevFocus = anchorRef?.current || document.activeElement;
    const y = window.scrollY || 0;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = setTimeout(() => {
      // Focus the panel itself (no ring on an option that looks like a second
      // selection); Tab moves into it and stays inside.
      panelRef.current?.focus?.({ preventScroll: true });
    }, 0);
    const onKey = (e) => {
      if (stack[stack.length - 1] !== me) return;
      if (e.key === "Escape") { e.preventDefault(); closeRef.current?.(); return; }
      if (e.key !== "Tab") return;
      // Tab is moved HERE, in every engine (Safari skips buttons on Tab by
      // default), and it never leaves the panel.
      e.preventDefault();
      const els = [...(panelRef.current?.querySelectorAll(FOCUSABLE) || [])].filter((n) => n.offsetParent !== null);
      if (!els.length) return;
      const i = els.indexOf(document.activeElement);
      const next = i < 0 ? (e.shiftKey ? els.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + els.length) % els.length;
      els[next].focus();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      const i = stack.indexOf(me);
      if (i >= 0) stack.splice(i, 1);
      if (!stack.length) document.body.style.overflow = prevOverflow;
      if ((window.scrollY || 0) !== y) window.scrollTo(0, y);
      prevFocus?.focus?.({ preventScroll: true });
    };
  }, [open, canPortal]);

  if (!open) return null;

  // The sheet's drag handle: a drag down past 100px (or a flick) closes it.
  const grab = v === "sheet" ? {
    onPointerDown: (e) => { drag.current = { y: e.clientY, t: Date.now(), id: e.pointerId }; e.currentTarget.setPointerCapture?.(e.pointerId); },
    onPointerMove: (e) => { const d = drag.current; if (d && e.pointerId === d.id) setDy(Math.max(0, e.clientY - d.y)); },
    onPointerUp: (e) => {
      const d = drag.current; drag.current = null;
      if (!d) return;
      const dist = Math.max(0, e.clientY - d.y), vel = dist / Math.max(1, Date.now() - d.t);
      if (dist > 100 || (vel > 0.6 && dist > 30)) closeRef.current?.(); else setDy(0);
    },
    onPointerCancel: () => { drag.current = null; setDy(0); },
  } : null;

  const style = v === "anchored"
    ? { top: pos?.top ?? -9999, left: pos?.left ?? -9999, width }
    : v === "sheet" ? (dy ? { transform: `translateY(${dy}px)`, transition: "none" } : undefined)
    : v === "dialog" ? { maxWidth: Math.min(width || 360, 360) } : undefined;

  const panel = (
    <div ref={panelRef} className={cx("sky-ovl", `sky-ovl--${v}`, className)} role={role}
         aria-modal={role === "dialog" || role === "alertdialog" ? "true" : undefined} aria-label={label}
         data-testid={testId} data-variant={v} tabIndex={-1} style={style}>
      {v === "sheet" && <div className="sky-ovl__handle" aria-hidden="true" {...grab}><span /></div>}
      {children}
    </div>
  );
  if (!canPortal) return panel;
  return createPortal(
    <div className="sky-ovl-root" data-variant={v}>
      <div className="sky-ovl-scrim" aria-hidden="true" data-testid={scrimTestId} onClick={() => closeRef.current?.()} />
      {panel}
    </div>,
    document.body,
  );
}

/** A confirmation: one glass card for the message, two glass button cards
 *  below it — Cancel (navy outline glass) and the action (solid navy). */
export function SkyConfirm({ open = true, title, eyebrow = null, children, cancelLabel = "Cancel", confirmLabel, onCancel, onConfirm, testId, icon = "swap" }) {
  return (
    <SkyOverlay open={open} onClose={onCancel} variant="dialog" role="alertdialog" label={title} testId={testId} scrimTestId={testId ? `${testId}-scrim` : undefined}>
      <div className="sky-ovl-card sky-ovl-msg">
        <span className="sky-ovl-msg__icon" aria-hidden="true">{ICONS[icon] || ICONS.swap}</span>
        {eyebrow ? <div className="sky-ovl-msg__eyebrow">{eyebrow}</div> : null}
        <div className="sky-ovl-msg__title">{title}</div>
        <div className="sky-ovl-msg__body">{children}</div>
      </div>
      <div className="sky-ovl-actions">
        <button type="button" className="sky-ovl-card sky-ovl-btn sky-ovl-btn--ghost" onClick={onCancel} data-autofocus="">{cancelLabel}</button>
        <button type="button" className="sky-ovl-card sky-ovl-btn sky-ovl-btn--primary" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </SkyOverlay>
  );
}

const ICONS = {
  swap: <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>,
  pin: <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.6" /></svg>,
  alert: <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><line x1="12" y1="7.5" x2="12" y2="13" /><line x1="12" y1="16.5" x2="12.01" y2="16.5" /></svg>,
};
