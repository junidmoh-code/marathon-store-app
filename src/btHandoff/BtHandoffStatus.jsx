import { useEffect, useState } from "react";
import { btHandoff } from "./handoff.js";

// Says something ONLY when the Bluetooth hand-off to Till 1 keeps failing. A
// healthy hand-off is invisible: staff never think about it. Renders nothing
// on a tablet that was never paired.
export default function BtHandoffStatus() {
  const [s, setS] = useState(null);
  useEffect(() => {
    const h = btHandoff();
    const off = h.subscribe(setS);
    // Resume anything left in the queue from before the app was closed.
    h.flush().catch(() => {});
    return off;
  }, []);
  if (!s?.enabled || !s.failing) return null;

  const text = s.needsRepair
    ? `${s.till} refuses this tablet's pairing code — scan the pairing QR on the till again.`
    : s.needsGesture
      ? `${s.pending} order${s.pending === 1 ? "" : "s"} not yet on ${s.till}. Tap below and pick the till.`
      : `${s.pending} order${s.pending === 1 ? "" : "s"} not yet on ${s.till} — still trying (${s.lastError || "no answer"}). Online sales are not affected.`;

  return (
    <div role="status" style={{ margin: "8px 12px", padding: "10px 12px", borderRadius: 10, background: "rgba(255,170,0,.12)", border: "1px solid rgba(255,170,0,.35)", color: "#FFC24A", fontSize: 13, lineHeight: 1.4 }}>
      {text}
      {s.needsGesture && !s.needsRepair && (
        <button
          onClick={() => btHandoff().prepareFromGesture()}
          style={{ display: "block", marginTop: 8, padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(255,170,0,.5)", background: "transparent", color: "#FFC24A", fontWeight: 700, cursor: "pointer" }}>
          Connect to {s.till}
        </button>
      )}
    </div>
  );
}
