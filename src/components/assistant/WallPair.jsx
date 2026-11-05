// ─── THE POPUP'S PHOTO WHEN A PRODUCT HAS A GENERATED TILE ──────────────────
//
// A swipeable pair: the generated studio tile first, the original second, with
// two dots and a "Studio" / "Original" label so staff always know which one
// they are looking at. A tap (not a swipe) calls onOpen(i) with the slide on
// screen, so the full-screen lightbox opens on that photo. The original is the
// same HiResPhoto the popup drew before (full resolution, cached thumbnail as
// the offline fallback); a generated tile that fails to load drops the pair
// and shows the original alone.

import { useRef, useState } from "react";
import { HiResPhoto } from "./HiResPhoto.jsx";

const SWIPE_PX = 40;

export function WallPair({ p, gen, fallback = null, imgStyle, onOpen }) {
  const [state, setState] = useState({ gen, i: 0, failed: false });
  const cur = state.gen === gen ? state : { gen, i: 0, failed: false };
  const set = (patch) => setState({ ...cur, ...patch });
  const start = useRef(null);   // { x, y } of the touch start
  const swiped = useRef(false);
  const style = { width: "100%", height: "100%", objectFit: "contain", ...imgStyle };

  const original = <HiResPhoto key={`${p.id}|${p.photoUrl || ""}`} p={p} alt={p.name} style={style} fallback={fallback} />;
  if (!gen) return original;
  // The generated tile failed to load: the original alone, and a tap opens the lightbox WITHOUT the broken tile
  // (onOpen's second argument: is the generated tile usable).
  if (cur.failed) return onOpen ? <div style={{ width: "100%", height: "100%" }} onClick={(e) => { e.stopPropagation(); onOpen(1, false); }}>{original}</div> : original;

  const go = (i) => set({ i: Math.max(0, Math.min(1, i)) });
  return (
    <div className="wp-root" data-testid="wall-pair"
         onTouchStart={(e) => { const t = e.touches[0]; start.current = t ? { x: t.clientX, y: t.clientY } : null; swiped.current = false; }}
         onTouchCancel={() => { start.current = null; }}
         onTouchEnd={(e) => {
           const s = start.current, t = e.changedTouches[0]; start.current = null;
           if (!s || !t) return;
           const dx = t.clientX - s.x, dy = t.clientY - s.y;
           // a swipe is mostly horizontal; a vertical scroll that drifts sideways is not
           if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) { swiped.current = true; go(dx < 0 ? cur.i + 1 : cur.i - 1); }
         }}
         onClick={(e) => {
           if (swiped.current) { e.stopPropagation(); swiped.current = false; return; }
           if (onOpen) { e.stopPropagation(); onOpen(cur.i, true); }
         }}>
      <style>{`
        .wp-root{position:relative;width:100%;height:100%;overflow:hidden}
        .wp-track{display:flex;width:200%;height:100%;transition:transform .22s ease}
        .wp-slide{width:50%;height:100%;flex:0 0 50%;display:flex;align-items:center;justify-content:center}
        .wp-slide--gen{background:radial-gradient(120% 100% at 50% 40%,#fff 0%,#eef0f3 70%,#e3e6eb 100%)}
        .wp-dots{position:absolute;left:0;right:0;bottom:10px;display:flex;justify-content:center;gap:8px}
        .wp-dot{width:44px;height:28px;border:0;padding:11px 8px;background:none;cursor:pointer;display:flex}
        .wp-dot::before{content:"";flex:1;border-radius:3px;background:rgba(127,127,140,.45)}
        .wp-dot[aria-current="true"]::before{background:#5b63ff}
        .wp-lab{position:absolute;top:14px;right:14px;font-size:11px;font-weight:800;letter-spacing:.06em;padding:3px 8px;border-radius:7px;background:rgba(0,0,0,.55);color:#fff}
        @media(prefers-reduced-motion:reduce){.wp-track{transition:none}}
      `}</style>
      <div className="wp-track" style={{ transform: `translateX(${cur.i * -50}%)` }}>
        <div className="wp-slide wp-slide--gen" aria-hidden={cur.i !== 0}>
          <img src={gen} alt={`${p.name} (studio)`} draggable={false} decoding="async" style={style} onError={() => set({ failed: true })} />
        </div>
        <div className="wp-slide" aria-hidden={cur.i !== 1}>{original}</div>
      </div>
      <span className="wp-lab" aria-live="polite">{cur.i === 0 ? "STUDIO" : "ORIGINAL"}</span>
      <div className="wp-dots" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="wp-dot" aria-label="Studio photo" aria-current={cur.i === 0} onClick={() => go(0)} />
        <button type="button" className="wp-dot" aria-label="Original photo" aria-current={cur.i === 1} onClick={() => go(1)} />
      </div>
    </div>
  );
}
