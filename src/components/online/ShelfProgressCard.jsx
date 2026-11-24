// ─── SHELF CHECKS — Junid's progress view, one row per place ─────────────────
// Junid, 24 Nov 2026; made the progress view of the permanent daily routine the
// same evening. Per place: what is on today's list and from which source, how
// many were checked today, found against corrected, the units the counts were
// corrected by, and the last weeks side by side so the counts can be seen
// healing week by week. One callable (webShelfProgress, Junid and Jafer only);
// nothing is read until the card is opened.
import { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";

// Made when the card is opened, not when the module loads: Settings must render even where Functions is not set up.
const webShelfProgress = (data) => httpsCallable(functions, "webShelfProgress")(data);
const NAME = { "marathon-pe": "Marathon PE", trophy: "Trophy", concrete: "Concrete", "marathon-pine": "Pine", hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3", central: "Central" };
export const SOURCE_LABEL = { web_reject: "website", store_reject: "store / refill", wrong_by_more: "wrong by 2+", not_selling: "not selling", old_single: "old single" };
const SOURCE_ORDER = ["web_reject", "store_reject", "wrong_by_more", "not_selling", "old_single"];
const cellStyle = { padding: "6px 8px", borderTop: "1px solid rgba(255,255,255,.07)", fontSize: 13, textAlign: "right", verticalAlign: "top" };
const th = { textAlign: "right", padding: "4px 8px" };

/** "website 3 · not selling 12" for a { source: n } map, in the list's own order. PURE. */
export function sourcesText(by) {
  const parts = SOURCE_ORDER.filter((k) => Number(by?.[k]) > 0).map((k) => `${SOURCE_LABEL[k]} ${by[k]}`);
  return parts.length ? parts.join(" · ") : "—";
}

/** One place's row. PURE. */
export function progressRow(p, saDate = null) {
  // Today's own record (by date), never simply the newest one.
  const today = (p.days || []).find((d) => (saDate ? d.day === saDate : false)) || (saDate ? null : p.days?.[0] || null);
  const weeks = (p.weeks || []).slice(0, 4);
  return {
    place: NAME[p.loc] || p.loc,
    on: p.on !== false,
    open: p.open, wrongByMoreOpen: p.wrongByMoreOpen || 0,
    list: sourcesText(p.openBySource),
    today: today ? `${today.checked} of ${Math.max(today.listed, today.checked)}` : "—",
    todayFound: today ? (today.found ?? 0) : 0,
    todayFixed: today ? (today.fixed ?? 0) : 0,
    todayUnits: today ? (today.units ?? 0) : 0,
    checked14: p.checked14, wrong14: p.wrong14, wrongPct: p.checked14 ? Math.round((100 * p.wrong14) / p.checked14) : null,
    // Newest week first: "checked / corrected / units" — the share corrected falling week on week is the counts healing.
    weeks: weeks.map((w) => ({ week: w.week, text: `${w.checked} checked · ${w.fixed} corrected · ${w.units} units`, pct: w.checked ? Math.round((100 * w.fixed) / w.checked) : null })),
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
          <div style={{ fontSize: 12, color: "rgba(233,238,255,.55)", margin: "6px 0 8px" }}>
            Each place gets up to {state.data.perDay} shelves a day, website rejections first. Unchecked ones roll over. "Corrected" = the count was changed.
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
              <thead>
                <tr style={{ fontSize: 11, color: "rgba(233,238,255,.5)", textTransform: "uppercase", letterSpacing: ".06em" }}>
                  <th style={{ ...th, textAlign: "left" }}>Place</th><th style={{ ...th, textAlign: "left" }}>On the list</th>
                  <th style={th}>Checked today</th><th style={th}>Found / corrected</th><th style={th}>Units</th>
                  <th style={th}>14 days</th><th style={{ ...th, textAlign: "left" }}>Week by week</th>
                </tr>
              </thead>
              <tbody>
                {state.data.places.map((p) => progressRow(p, state.data.saDate)).map((r) => (
                  <tr key={r.place} data-testid="shelf-progress-row">
                    <td style={{ ...cellStyle, textAlign: "left", fontWeight: 600 }}>{r.place}{!r.on && <div style={{ fontSize: 11, fontWeight: 500, color: "rgba(233,238,255,.45)" }}>switched off</div>}</td>
                    <td style={{ ...cellStyle, textAlign: "left" }}>{r.open}<div style={{ fontSize: 11, color: "rgba(233,238,255,.55)" }}>{r.list}</div></td>
                    <td style={cellStyle}>{r.today}</td>
                    <td style={cellStyle}>{r.todayFound} / {r.todayFixed}</td>
                    <td style={cellStyle}>{r.todayUnits}</td>
                    <td style={cellStyle}>{r.checked14}<div style={{ fontSize: 11, color: "rgba(233,238,255,.55)" }}>{r.wrong14} wrong{r.wrongPct != null ? ` (${r.wrongPct}%)` : ""}</div></td>
                    <td style={{ ...cellStyle, textAlign: "left", fontSize: 12 }}>
                      {r.weeks.length ? r.weeks.map((w) => <div key={w.week}>w/c {w.week.slice(5)}: {w.text}{w.pct != null ? ` (${w.pct}%)` : ""}</div>) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
