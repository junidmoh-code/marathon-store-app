// ─── CAMERA SCANNER — generic full-screen scan (1D barcodes + QR) ────────────
// The layby QrScanner, generalised: same html5-qrcode lifecycle discipline
// (stable-id mount node, guard against StrictMode double-mount and
// unmount-before-start), but not layby-specific and with a wider scan box that
// suits 1D barcodes on shoe labels. First good read wins, then it stops itself.

import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";

const READER_ID = "stock-camera-reader";

export default function CameraScanner({ title = "Scan", hint = "Point the camera at the barcode or label.", onScan, onClose }) {
  const [error, setError] = useState(null);
  const liveRef = useRef(false);
  const handledRef = useRef(false);
  // The callback rides in a ref so the camera effect runs ONCE — both call
  // sites pass fresh closures every render, and listing onScan as a dependency
  // would tear the stream down and restart it on every parent re-render.
  const onScanRef = useRef(onScan);
  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  useEffect(() => {
    let cancelled = false;
    const instance = new Html5Qrcode(READER_ID, /* verbose */ false);

    const stop = () => {
      if (!liveRef.current) return Promise.resolve();
      liveRef.current = false;
      return instance.stop().then(() => instance.clear()).catch(() => {});
    };

    instance
      .start(
        { facingMode: "environment" },
        // Wide, short box — barcodes are wide; QR still fits.
        { fps: 10, qrbox: { width: 300, height: 180 } },
        (decodedText) => {
          if (handledRef.current) return;
          handledRef.current = true;
          stop().finally(() => { if (!cancelled) onScanRef.current(decodedText); });
        },
        () => { /* per-frame miss — expected */ }
      )
      .then(() => { if (cancelled) { stop(); } else { liveRef.current = true; } })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err?.name === "NotAllowedError"
              ? "Camera permission denied. Allow camera access, or type the code instead."
              : "Could not start the camera. Type the code instead."
          );
        }
      });

    return () => { cancelled = true; stop(); };
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,.94)", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", color: "#fff" }}>
        <div style={{ fontWeight: 800, fontSize: 16, letterSpacing: ".04em" }}>{title}</div>
        <button onClick={onClose}
                style={{ background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.18)", color: "#fff",
                         borderRadius: 10, padding: "10px 16px", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
          Close
        </button>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 16px" }}>
        {error ? (
          <div style={{ color: "#FF9B9B", textAlign: "center", maxWidth: 340, fontSize: 14, lineHeight: 1.5 }}>{error}</div>
        ) : (
          <>
            <div id={READER_ID} style={{ width: "100%", maxWidth: 380, borderRadius: 16, overflow: "hidden" }} />
            <div style={{ color: "rgba(255,255,255,.6)", fontSize: 13, marginTop: 16, textAlign: "center" }}>{hint}</div>
          </>
        )}
      </div>
    </div>
  );
}
