// ─── DISPLAY CHECKS — ANALYTICS TAB (manager) ────────────────────────────────
// A live summary for the store in view, computed ENTIRELY client-side from the
// same two sources the Today feed uses — the active index + today's day node —
// via feedModel.deriveFeed. No new reads beyond that feed, no writes.
//
// SCOPE (honest): this is TODAY. The design's month-over-month tables read
// /displayChecks_stats/{store}/{YYYY-MM}, which is written by a Cloud Function
// that hasn't shipped yet — so historical trends light up once that function
// lands. Everything here needs no backend: it's derived from the live feed.

import { useMemo } from "react";
import { FONT, MONO, BLUE, BLUE_SOFT, AMBER, INK, GLASS_BG, GLASS_BORDER, PANEL, META } from "./tokens";
import { deriveFeed } from "./feedModel";
import { SHOP_LABELS } from "../../utils/stores";

const toMs = (v) => (v == null || v === "" ? NaN : (typeof v === "number" ? v : Date.parse(v)));

function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = (m / 60).toFixed(1);
  return `${h}h`;
}

function Kpi({ label, value, tint, sub }) {
  return (
    <div style={{ ...PANEL, padding: "15px 16px" }}>
      <div style={{ ...META, color: "rgba(233,238,255,.4)" }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 26, fontWeight: 700, color: tint || INK, fontVariantNumeric: "tabular-nums", marginTop: 6 }}>{value}</div>
      {sub != null && <div style={{ ...META, color: "rgba(233,238,255,.35)", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ ...PANEL, overflow: "hidden" }}>
      <div style={{ padding: "13px 16px 11px", borderBottom: "1px solid rgba(255,255,255,.06)", ...META, color: BLUE_SOFT }}>{title}</div>
      <div>{children}</div>
    </div>
  );
}

// Feed arrives as props from the module shell's ONE lifted listener (shared with
// Today) — no own subscription, so Today↔Analytics never doubles or churns it.
export default function AnalyticsView({ store, wide, activeItems, completedItems, ready }) {
  const feed = useMemo(() => deriveFeed(activeItems || [], completedItems || []), [activeItems, completedItems]);
  const { stats, waiting, completed } = feed;

  // Average completion time (open → completed) over today's completed checks.
  const avgMs = useMemo(() => {
    const durs = (completed || []).map((r) => {
      const c = toMs(r.completedAt), s = toMs(r.createdAt);
      return Number.isFinite(c) && Number.isFinite(s) && c > s ? c - s : null;
    }).filter((v) => v != null);
    return durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : NaN;
  }, [completed]);

  // Per-staff completion counts (who cleared what today).
  const staff = useMemo(() => {
    const by = {};
    for (const r of completed || []) {
      const who = (r.completedBy && (r.completedBy.name || r.completedBy.uid)) || "—";
      by[who] = by[who] || { done: 0, noStock: 0 };
      by[who].done += 1;
      if (r.result === "no_stock") by[who].noStock += 1;
    }
    return Object.entries(by).sort((a, b) => b[1].done - a[1].done);
  }, [completed]);

  // "Waiting on stock" as a buying signal — held products, most-held first.
  const heldProducts = useMemo(() => {
    const by = {};
    for (const r of waiting || []) {
      const n = r.productName || "Unknown";
      by[n] = (by[n] || 0) + 1;
    }
    return Object.entries(by).sort((a, b) => b[1] - a[1]);
  }, [waiting]);

  if (!ready) return <div style={{ ...META, color: "rgba(233,238,255,.4)", padding: "20px 0" }}>READING TODAY…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ ...META, color: "rgba(233,238,255,.5)" }}>TODAY · {SHOP_LABELS[store]?.toUpperCase() || "—"}</div>

      <div style={{ display: "grid", gridTemplateColumns: wide ? "repeat(5,1fr)" : "repeat(2,1fr)", gap: 12 }}>
        <Kpi label="ASSIGNED" value={stats.assigned} />
        <Kpi label="COMPLETED" value={stats.done} tint="#4ADE80" sub={`${stats.completionPct}%`} />
        <Kpi label="OUTSTANDING" value={stats.outstanding} tint={stats.outstanding > 0 ? AMBER : INK} />
        <Kpi label="HELD" value={stats.waiting} sub="waiting on stock" />
        <Kpi label="AVG TIME" value={humanDuration(avgMs)} sub="open → done" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: wide ? "1fr 1fr" : "1fr", gap: 16 }}>
        <Section title="RESULTS">
          <div style={{ display: "flex" }}>
            <div style={{ flex: 1, padding: "16px", borderRight: "1px solid rgba(255,255,255,.06)" }}>
              <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 700, color: "#4ADE80", fontVariantNumeric: "tabular-nums" }}>{stats.confirmed}</div>
              <div style={{ ...META, color: "rgba(233,238,255,.5)", marginTop: 4 }}>DISPLAY CONFIRMED</div>
            </div>
            <div style={{ flex: 1, padding: "16px" }}>
              <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 700, color: stats.noStock > 0 ? "rgba(255,120,120,.9)" : INK, fontVariantNumeric: "tabular-nums" }}>{stats.noStock}</div>
              <div style={{ ...META, color: "rgba(233,238,255,.5)", marginTop: 4 }}>NO STOCK</div>
            </div>
          </div>
        </Section>

        <Section title="BY STAFF">
          {staff.length === 0 ? (
            <div style={{ ...META, color: "rgba(233,238,255,.35)", padding: "18px 16px", textAlign: "center" }}>NO COMPLETIONS YET TODAY</div>
          ) : staff.map(([who, s], i) => (
            <div key={who} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 16px", borderTop: i > 0 ? "1px solid rgba(255,255,255,.05)" : "none" }}>
              <span style={{ fontFamily: FONT, fontSize: 13.5, fontWeight: 600, color: INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{who}</span>
              <span style={{ fontFamily: MONO, fontSize: 13, color: "rgba(233,238,255,.7)", fontVariantNumeric: "tabular-nums" }}>
                {s.done}{s.noStock > 0 && <span style={{ color: "rgba(255,120,120,.8)" }}> · {s.noStock} no-stock</span>}
              </span>
            </div>
          ))}
        </Section>
      </div>

      <Section title="WAITING ON STOCK · BUYING SIGNAL">
        {heldProducts.length === 0 ? (
          <div style={{ ...META, color: "rgba(233,238,255,.35)", padding: "18px 16px", textAlign: "center" }}>NOTHING HELD — EVERY SOLD SIZE HAD STOCK TO RESTOCK FROM</div>
        ) : heldProducts.map(([name, n], i) => (
          <div key={name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 16px", borderTop: i > 0 ? "1px solid rgba(255,255,255,.05)" : "none" }}>
            <span style={{ fontFamily: FONT, fontSize: 13.5, fontWeight: 600, color: INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
            <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: AMBER, fontVariantNumeric: "tabular-nums" }}>{n}× held</span>
          </div>
        ))}
      </Section>

      <div style={{ ...META, color: "rgba(233,238,255,.28)", textAlign: "center", marginTop: 4 }}>
        TODAY ONLY · MONTH-OVER-MONTH TRENDS ARRIVE WITH THE STATS FUNCTION
      </div>
    </div>
  );
}
