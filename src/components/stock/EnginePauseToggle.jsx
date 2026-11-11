// ─── PINE SHOP COUNT — the one engine-pause toggle (Junid, 11 Nov 2026) ──────
// Shown on the Hub Count card to accounts holding the stored admin stockRole
// (canAdjustHubCount) — the same thing the rules ask of a write to
// /config/refillEngine. Pauses refill requests TO the Pine shop and nothing
// else; Pine's sales still deduct exactly as before (no countMode).
import React, { useEffect, useState } from "react";
import { BORDER, GRAY, RED, AMBER, bGreen, bGray } from "./ui";
import { loadEnginePause, setEnginePause } from "./hubCountStore";

export function EnginePauseToggle({ loc = "marathon-pine", label = "Pine shop" }) {
  const [state, setState] = useState(null);   // { paused } | null while loading
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    let live = true;
    loadEnginePause(loc).then((s) => { if (live) setState(s); }).catch((e) => { if (live) setMsg(String(e?.message || e)); });
    return () => { live = false; };
  }, [loc]);
  const on = !!state && state.paused;
  const flip = async () => {
    if (busy || !state) return;
    setBusy(true); setMsg("");
    const r = await setEnginePause(loc, !on);
    if (r.state) setState(r.state);
    else if (r.ok) setState({ paused: !on });
    if (!r.ok) setMsg(r.message || "Could not switch.");
    setBusy(false);
  };
  return (
    <div data-testid="engine-pause-toggle" style={{ marginTop: 10, padding: "10px 11px", borderRadius: 11,
      border: on ? "1px solid rgba(251,191,36,.5)" : BORDER, background: on ? "rgba(251,191,36,.08)" : "transparent" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "#fff", lineHeight: 1.4 }}>
          <strong>{label} counting — refill requests paused</strong>
          <div style={{ fontSize: 11, color: on ? AMBER : GRAY }}>
            {!state ? "Reading…" : on ? "PAUSED — no new refill requests for the Pine shop. Tap when the count is finished to switch the engine back on." : "Engine ON for the Pine shop"}
          </div>
        </div>
        <button onClick={flip} disabled={busy || !state} aria-pressed={on}
          style={{ ...(on ? bGreen : bGray), padding: "8px 14px", opacity: busy || !state ? 0.6 : 1 }}>
          {busy ? "…" : on ? "PAUSED" : "ON"}
        </button>
      </div>
      {msg && <div style={{ marginTop: 6, fontSize: 11.5, color: RED }}>{msg}</div>}
    </div>
  );
}
