// ─── SHELF CHECKS — Junid's progress view, one row per place ─────────────────
// Junid, 24 Nov 2026. How much of each place's daily list is being worked, and
// how often the shelf was wrong. One callable (webShelfProgress, Junid and
// Jafer only); nothing is read until the card is opened.
import { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";

const webShelfProgress = httpsCallable(functions, "webShelfProgress");
const NAME = { "marathon-pe": "Marathon PE", trophy: "Trophy", concrete: "Concrete", "marathon-pine": "Pine", hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3", central: "Central" };
const cellStyle = { padding: "6px 8px", borderTop: "1px solid rgba(255,255,255,.07)", fontSize: 13, textAlign: "right" };

/** One place's row. PURE. */
export function progressRow(p) {
  const today = p.days?.[0] || null;
  return {
    place: NAME[p.loc] || p.loc, open: p.open, wrongByMoreOpen: p.wrongByMoreOpen || 0,
    today: today ? `${today.checked} of ${Math.max(today.listed, today.checked)}` : "—",
    checked14: p.checked14, wrong14: p.wrong14, wrongPct: p.checked14 ? Math.round((100 * p.wrong14) / p.checked14) : null,
  };
}

export default function ShelfProgressCard() {
  const [state, setState] = useState({ status: "idle", data: null });
  const load = async () => {
    setState({ status: "loading", data: null });
    try { setState({ status: "ready", data: (await webShelfProgress({})).data }); }
    catch { setState({ status: "error", data: null }); }
  };
  return (
    <div data-testid="shelf-progress" style={{ marginTop: 16, padding: "12px 14px", border: "1px solid rgba(255,255,255,.1)", borderRadius: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>Shelf checks — progress per place</div>
        <button type="button" onClick={load} disabled={state.status === "loading"}
                style={{ marginLeft: "auto", padding: "6px 12px", borderRadius: 8, border: "1px solid rgba(74,127,255,.5)", background: "rgba(74,127,255,.12)", color: "#9db8ff", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>
          {state.status === "loading" ? "Loading…" : state.status === "ready" ? "Refresh" : "Show"}
        </button>
      </div>
      {state.status === "error" && <div style={{ fontSize: 13, color: "#FF6B6B", marginTop: 8 }}>Could not load. Try again.</div>}
      {state.status === "ready" && (
        <>
          <div style={{ fontSize: 12, color: "rgba(233,238,255,.55)", margin: "6px 0 8px" }}>Each place gets up to {state.data.perDay} shelves a day. Unchecked ones roll over.</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ fontSize: 11, color: "rgba(233,238,255,.5)", textTransform: "uppercase", letterSpacing: ".06em" }}>
                <th style={{ textAlign: "left", padding: "4px 8px" }}>Place</th><th style={{ textAlign: "right", padding: "4px 8px" }}>Today</th>
                <th style={{ textAlign: "right", padding: "4px 8px" }}>Waiting</th><th style={{ textAlign: "right", padding: "4px 8px" }}>Wrong by more</th>
                <th style={{ textAlign: "right", padding: "4px 8px" }}>14 days checked</th><th style={{ textAlign: "right", padding: "4px 8px" }}>Shelf was wrong</th>
              </tr>
            </thead>
            <tbody>
              {state.data.places.map(progressRow).map((r) => (
                <tr key={r.place}>
                  <td style={{ ...cellStyle, textAlign: "left", fontWeight: 600 }}>{r.place}</td>
                  <td style={cellStyle}>{r.today}</td><td style={cellStyle}>{r.open}</td><td style={cellStyle}>{r.wrongByMoreOpen}</td>
                  <td style={cellStyle}>{r.checked14}</td><td style={cellStyle}>{r.wrong14}{r.wrongPct != null ? ` (${r.wrongPct}%)` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
