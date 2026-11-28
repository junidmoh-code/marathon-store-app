// ─── ZOOM INSIDE THE PHOTO VIEWER ONLY (Junid, 5 Nov 2026) ───────────────────
//
// The app never zooms (src/device/zoomLock.js), except here: the product photo
// viewer zooms with its own transform. Pointer events, so it works the same on
// iOS Safari, Android Chrome, the installed PWA and a trackpad:
//   • two fingers: pinch between scale 1 and 4, around the fingers' midpoint;
//   • one finger while zoomed: pan;
//   • double-tap: toggles 1 ↔ 2.5;
//   • a new photo (key) or closing the viewer starts again at 1.
// `onZoomChange(zoomed)` lets the viewer turn its swipe-to-next off while zoomed.

import { useEffect, useRef, useState } from "react";

const MIN = 1, MAX = 4, DOUBLE = 2.5;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export default function ZoomImage({ src, alt = "", style, onZoomChange, ...rest }) {
  const [t, setT] = useState({ s: 1, x: 0, y: 0 });
  const pts = useRef(new Map());           // pointerId → {x, y}
  const pinch = useRef(null);              // { d0, s0, mx, my, x0, y0 }
  const pan = useRef(null);                // { px, py, x0, y0 }
  const lastTap = useRef(0);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => { setT({ s: 1, x: 0, y: 0 }); }, [src]);
  useEffect(() => { onZoomChange?.(t.s > 1.01); }, [t.s > 1.01]);   // eslint-disable-line react-hooks/exhaustive-deps

  const set = (s, x, y) => {
    const sc = clamp(s, MIN, MAX);
    if (sc <= 1.001) return setT({ s: 1, x: 0, y: 0 });
    setT({ s: sc, x, y });
  };

  const down = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const cur = tRef.current;
    if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()];
      pinch.current = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: cur.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, x0: cur.x, y0: cur.y };
      pan.current = null;
    } else if (pts.current.size === 1 && cur.s > 1) {
      pan.current = { px: e.clientX, py: e.clientY, x0: cur.x, y0: cur.y };
    }
  };
  const move = (e) => {
    if (!pts.current.has(e.pointerId)) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pts.current.size >= 2) {
      const [a, b] = [...pts.current.values()];
      const p = pinch.current;
      const s = clamp(p.s0 * (Math.hypot(a.x - b.x, a.y - b.y) / p.d0), MIN, MAX);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      set(s, p.x0 + (mx - p.mx), p.y0 + (my - p.my));
    } else if (pan.current) {
      const p = pan.current;
      set(tRef.current.s, p.x0 + (e.clientX - p.px), p.y0 + (e.clientY - p.py));
    }
  };
  const up = (e) => {
    const wasPinch = !!pinch.current;
    pts.current.delete(e.pointerId);
    if (pts.current.size < 2) pinch.current = null;
    if (pts.current.size === 0) pan.current = null;
    if (wasPinch || e.type !== "pointerup") return;
    const now = Date.now();
    if (now - lastTap.current < 300) {           // double-tap: 1 ↔ 2.5
      lastTap.current = 0;
      const cur = tRef.current;
      set(cur.s > 1.01 ? 1 : DOUBLE, 0, 0);
    } else lastTap.current = now;
  };

  return (
    <img src={src} alt={alt} draggable={false} data-zoom-surface="" data-zoom-scale={t.s.toFixed(2)}
         onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
         onDoubleClick={(e) => e.preventDefault()}
         style={{ ...style, touchAction: "none", userSelect: "none", WebkitUserSelect: "none",
                  transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`, transformOrigin: "center center",
                  transition: pinch.current || pan.current ? "none" : "transform .18s ease-out",
                  cursor: t.s > 1 ? "grab" : "zoom-in", willChange: "transform" }}
         {...rest} />
  );
}
