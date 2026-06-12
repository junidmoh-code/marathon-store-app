// ─── LAYBY QR SCANNER MODAL ──────────────────────────────────────────────────
// Full-screen camera scanner for receiving layby parcels. Opens the rear camera
// (facingMode: environment) via html5-qrcode, reads the parcel-label QR, and
// fires onScan(rawDecodedText) on the first successful read, then stops itself.
// onClose backs out (the caller offers a manual LB-number fallback alongside).
//
// Lifecycle notes: html5-qrcode drives a raw <video> against a DOM node it finds
// by id, so we mount a stable-id div and start/stop around it. start() is async;
// we guard against React StrictMode's double-mount and against unmount-before-
// start with a "live" ref so stop() is only ever called on a running instance.

import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";

const READER_ID = "layby-qr-reader";

export default function QrScanner({ onScan, onClose }) {
  const [error, setError] = useState(null);
  const scannerRef = useRef(null);
  const liveRef = useRef(false);     // true once start() has resolved
  const handledRef = useRef(false);  // ignore frames after the first good read

  useEffect(() => {
    let cancelled = false;
    const instance = new Html5Qrcode(READER_ID, /* verbose */ false);
    scannerRef.current = instance;

    const stop = () => {
      if (!liveRef.current) return Promise.resolve();
      liveRef.current = false;
      return instance.stop().then(() => instance.clear()).catch(() => {});
    };

    instance
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (decodedText) => {
          if (handledRef.current) return;
          handledRef.current = true;
          stop().finally(() => { if (!cancelled) onScan(decodedText); });
        },
        () => { /* per-frame decode miss — expected, ignore */ }
      )
      .then(() => { if (cancelled) { stop(); } else { liveRef.current = true; } })
      .catch((err) => {
        console.warn("QR scanner start failed:", err?.message || err);
        if (!cancelled) {
          setError(
            err?.name === "NotAllowedError"
              ? "Camera permission denied. Allow camera access, or type the invoice number instead."
              : "Could not start the camera. Type the invoice number instead."
          );
        }
      });

    return () => { cancelled = true; stop(); };
  }, [onScan]);

  return (
    <div style={{ position:"fixed", inset:0, zIndex:1000, background:"rgba(0,0,0,.92)", display:"flex", flexDirection:"column" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"16px 18px", color:"#fff" }}>
        <div style={{ fontWeight:800, fontSize:16, letterSpacing:".04em" }}>Scan layby parcel</div>
        <button onClick={onClose}
                style={{ background:"rgba(255,255,255,.08)", border:"1px solid rgba(255,255,255,.18)", color:"#fff", borderRadius:10, padding:"8px 14px", fontSize:13, fontWeight:700, cursor:"pointer" }}>
          Close
        </button>
      </div>

      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"0 16px" }}>
        {error ? (
          <div style={{ color:"#FF9B9B", textAlign:"center", maxWidth:340, fontSize:14, lineHeight:1.5 }}>{error}</div>
        ) : (
          <>
            <div id={READER_ID} style={{ width:"100%", maxWidth:360, borderRadius:16, overflow:"hidden" }} />
            <div style={{ color:"rgba(255,255,255,.6)", fontSize:13, marginTop:16, textAlign:"center" }}>
              Point the camera at the QR code on the parcel label.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
