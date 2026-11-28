// ─── NO ZOOM (Junid, 5 Nov 2026) ─────────────────────────────────────────────
//
// The app must not zoom: no pinch, no double-tap zoom, no focus zoom — phone
// and iPad, Safari and Chrome, browser and installed PWA. Layers:
//   • index.html viewport meta: maximum-scale=1, user-scalable=no (Chrome/
//     Android honour it; iOS uses maximum-scale=1 to skip the focus zoom).
//   • CSS (sky.css): touch-action: manipulation on html/body (kills the
//     double-tap zoom + the 300ms delay); pan-x pan-y on scroll containers;
//     16px inputs on touch screens.
//   • This file: iOS Safari ignores user-scalable=no for PINCH, so the
//     WebKit gesture events and any multi-finger / scaled touchmove are
//     cancelled here. Normal one-finger scrolling is untouched.
//
// The one exception is the photo viewer (ZoomImage, [data-zoom-surface]): it
// zooms with its OWN transform from pointer events — the page behind it stays
// at scale 1. Nothing here touches OS-level accessibility scaling (text size,
// browser zoom from settings); only gestures are blocked.

let installed = false;

export function installZoomLock(doc = typeof document !== "undefined" ? document : null) {
  if (!doc || installed) return () => {};
  installed = true;
  const stop = (e) => { if (e.cancelable) e.preventDefault(); };
  // WebKit's own pinch events (iOS Safari, iPadOS, installed PWA).
  const onGesture = (e) => stop(e);
  // A pinch arrives as a 2-finger touchmove whose scale is not 1.
  const onTouchMove = (e) => {
    if ((typeof e.scale === "number" && e.scale !== 1) || (e.touches && e.touches.length > 1)) stop(e);
  };
  const opts = { passive: false };
  doc.addEventListener("gesturestart", onGesture, opts);
  doc.addEventListener("gesturechange", onGesture, opts);
  doc.addEventListener("gestureend", onGesture, opts);
  doc.addEventListener("touchmove", onTouchMove, opts);
  return () => {
    installed = false;
    doc.removeEventListener("gesturestart", onGesture, opts);
    doc.removeEventListener("gesturechange", onGesture, opts);
    doc.removeEventListener("gestureend", onGesture, opts);
    doc.removeEventListener("touchmove", onTouchMove, opts);
  };
}
