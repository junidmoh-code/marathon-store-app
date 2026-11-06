// ─── HUB 3 COUNT MODE — the one toggle (Junid, 6 Nov 2026) ───────────────────
// Shown on the Hub Count card for Hub 3 to accounts holding the stored admin
// stockRole (canAdjustHubCount) — the same thing the rules ask of a write to
// /config/refillEngine. Writes go through hubCountStore.setHubCountMode.
import React, { useEffect, useState } from "react";
import { BORDER, GRAY, RED, AMBER, bGreen, bGray } from "./ui";
import { loadHubCountMode, setHubCountMode } from "./hubCountStore";

// ON  → refill engine paused for Hub 3 AND uncounted Hub 3 sales not deducted.
// OFF → both cleared, one tap. Reads both flags one-shot; shows "mixed" if a
// console edit left them disagreeing, and the next tap sets both together.
export function CountModeToggle({ hub }) {
  const [state, setState] = useState(null);   // { paused, countMode, on } | null while loading
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    let live = true;
    loadHubCountMode(hub).then((s) => { if (live) setState(s); }).catch((e) => { if (live) setMsg(String(e?.message || e)); });
    return () => { live = false; };
  }, [hub]);
  const mixed = !!state && state.paused !== state.countMode;
  const on = !!state && state.on;
  const flip = async () => {
    if (busy || !state) return;
    setBusy(true); setMsg("");
    const want = mixed ? true : !on;
    const r = await setHubCountMode(hub, want);
    if (r.state) setState(r.state);
    else if (r.ok) setState({ paused: want, countMode: want, on: want });
    if (!r.ok) setMsg(r.message || "Could not switch.");
    setBusy(false);
  };
  return (
    <div data-testid="count-mode-toggle" style={{ marginTop: 10, padding: "10px 11px", borderRadius: 11,
      border: on ? "1px solid rgba(251,191,36,.5)" : BORDER, background: on ? "rgba(251,191,36,.08)" : "transparent" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "#fff", lineHeight: 1.4 }}>
          <strong>Hub 3 counting — engine paused, uncounted sales not deducted</strong>
          <div style={{ fontSize: 11, color: on ? AMBER : GRAY }}>
            {!state ? "Reading…" : mixed ? "Mixed — one flag is on, one is off. Tap to switch both ON." : on ? "ON — tap when the count is finished to switch both off." : "OFF"}
          </div>
        </div>
        <button onClick={flip} disabled={busy || !state} aria-pressed={on}
          style={{ ...(on ? bGreen : bGray), padding: "8px 14px", opacity: busy || !state ? 0.6 : 1 }}>
          {busy ? "…" : on ? "ON" : "OFF"}
        </button>
      </div>
      {msg && <div style={{ marginTop: 6, fontSize: 11.5, color: RED }}>{msg}</div>}
    </div>
  );
}

