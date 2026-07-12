// ─── INVENTORY HEALTH (exception dashboard) ───────────────────────────────────
// The manager-facing surface of the automated refill engine. Shows ONLY
// problems — never the full catalog:
//   • Engine status strip: enabled / per-location mode / last scan results
//   • Shadow panel: what the engine WOULD order right now (the evidence used
//     to decide when a location is safe to flip from shadow → live)
//   • Exception sections (from /stock_exceptions/latest, rewritten every scan):
//     below target, missing sizes, stuck/failed refills, only-in-central,
//     only-in-hub2, excess at hub2, negative cells
//   • "Needs review" list: per-(location, product) confidence scores < 85
// Everything here is READ-ONLY — fixes happen in Transfer / Adjust / the
// warehouse Clothing tab. Data producers: functions/refill-scan.cjs (15-min
// scan) + functions/lib/refill-engine.cjs (pure logic).

import React, { useMemo, useState } from "react";
import {
  useStockExceptions, useStockConfidence, useEngineShadow, useEngineRuns, useEngineConfig,
} from "./useStock";
import { decodeSizeKey } from "../../utils/sizeKey";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L } from "./ui";

const MODE_COLOR = { off: GRAY, shadow: AMBER, live: GREEN };

// Human timestamp: "14:32" today, else "Jul 11 14:32".
function fmtTs(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return today ? hm : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
}

const LOC_LABEL = { "marathon-pe": "Marathon PE", trophy: "Trophy", hub2: "Hub 2", central: "Central" };
const locLabel = (l) => LOC_LABEL[l] || l || "—";

function Section({ title, count, tone = RED, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ ...GLASS, padding: 0, marginBottom: 10, overflow: "hidden" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", color: "#fff", padding: "12px 14px", cursor: "pointer", fontSize: 14, fontWeight: 700 }}
      >
        <span>{title}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: count ? tone : GRAY, fontWeight: 700, fontSize: 13 }}>{count}</span>
          <span style={{ color: GRAY, fontSize: 12 }}>{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {open && count > 0 && <div style={{ padding: "0 14px 12px" }}>{children}</div>}
      {open && count === 0 && <div style={{ padding: "0 14px 12px", color: GRAY, fontSize: 12 }}>Nothing here — all clear.</div>}
    </div>
  );
}

function Row({ left, mid, right, tone }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "6px 0", borderBottom: "1px solid rgba(120,150,255,.08)", fontSize: 12.5 }}>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{left}</span>
      {mid != null && <span style={{ color: GRAY, whiteSpace: "nowrap" }}>{mid}</span>}
      <span style={{ color: tone || BLUE_L, fontWeight: 600, whiteSpace: "nowrap" }}>{right}</span>
    </div>
  );
}

const MAX_ROWS = 50;
function more(count) {
  return count > MAX_ROWS ? <div style={{ color: GRAY, fontSize: 11, paddingTop: 6 }}>…and {count - MAX_ROWS} more</div> : null;
}

export default function Health({ products = [] }) {
  const exceptions = useStockExceptions();
  const confidence = useStockConfidence();
  const shadow = useEngineShadow();
  const runs = useEngineRuns(5);
  const config = useEngineConfig();

  const nameOf = useMemo(() => {
    const byId = new Map(products.map((p) => [p.id, p.name]));
    return (pid) => byId.get(pid) || pid || "—";
  }, [products]);

  const lastRun = runs[0];
  const ex = exceptions || {};
  const items = (key) => ex[key]?.items || [];
  const count = (key) => ex[key]?.count || 0;

  // Flatten the shadow plan into displayable rows, grouped by destination.
  const shadowRows = useMemo(() => {
    const out = [];
    for (const [dest, byPid] of Object.entries(shadow || {})) {
      for (const [pid, bySize] of Object.entries(byPid || {})) {
        for (const [sizeKey, s] of Object.entries(bySize || {})) {
          out.push({ dest, pid, size: decodeSizeKey(sizeKey), ...s });
        }
      }
    }
    return out.sort((a, b) => a.dest.localeCompare(b.dest) || (b.priority === "high") - (a.priority === "high"));
  }, [shadow]);

  // Confidence → flat "needs review" list, worst first.
  const reviewRows = useMemo(() => {
    const out = [];
    for (const [loc, byPid] of Object.entries(confidence?.byLocation || {})) {
      for (const [pid, e] of Object.entries(byPid || {})) out.push({ loc, pid, ...e });
    }
    return out.sort((a, b) => a.score - b.score);
  }, [confidence]);

  return (
    <div>
      {/* Engine status strip */}
      <div style={{ ...GLASS, padding: "12px 14px", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            Refill engine{" "}
            <span style={{ color: config?.enabled ? GREEN : RED, fontSize: 12 }}>
              {config == null ? "…" : config.enabled ? "ON" : "OFF"}
            </span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {Object.entries(config?.mode || {}).map(([loc, mode]) => (
              <span key={loc} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 8, border: `1px solid ${MODE_COLOR[mode] || GRAY}`, color: MODE_COLOR[mode] || GRAY }}>
                {locLabel(loc)}: {mode}
              </span>
            ))}
          </div>
        </div>
        <div style={{ color: GRAY, fontSize: 11.5, marginTop: 6 }}>
          {lastRun
            ? `Last scan ${fmtTs(lastRun.finishedAt || lastRun.startedAt)} — ${lastRun.counts ? `${lastRun.counts.intents || 0} created, ${lastRun.counts.shadow || 0} shadow, ${lastRun.counts.closes || 0} closed` : lastRun.skipped || lastRun.error || ""}`
            : "No scans recorded yet — the engine function may not be deployed."}
        </div>
      </div>

      {/* Shadow plan — the flip-to-live evidence */}
      <Section title="Engine would order now (shadow)" count={shadowRows.length} tone={AMBER} defaultOpen>
        {shadowRows.slice(0, MAX_ROWS).map((r, i) => (
          <Row key={i}
            left={`${nameOf(r.pid)} · ${r.size}`}
            mid={`${locLabel(r.source)} → ${locLabel(r.dest)}`}
            right={`×${r.qty}${r.priority === "high" ? " ⚡" : ""}`}
            tone={r.priority === "high" ? AMBER : BLUE_L}
          />
        ))}
        {more(shadowRows.length)}
      </Section>

      {/* Exceptions */}
      <div style={{ color: GRAY, fontSize: 11, margin: "14px 2px 8px" }}>
        Exceptions {ex.computedAt ? `— updated ${fmtTs(ex.computedAt)}` : "(no scan data yet)"}
      </div>

      <Section title="Below target" count={count("belowTarget")} tone={AMBER}>
        {items("belowTarget").slice(0, MAX_ROWS).map((r, i) => (
          <Row key={i} left={`${nameOf(r.pid)} · ${r.size}`} mid={locLabel(r.loc)} right={`${r.have}/${r.target} (−${r.deficit})`} tone={AMBER} />
        ))}
        {more(count("belowTarget"))}
      </Section>

      <Section title="Missing sizes — nothing upstream (reorder candidates)" count={count("missingSizes")}>
        {items("missingSizes").slice(0, MAX_ROWS).map((r, i) => (
          <Row key={i} left={`${nameOf(r.pid)} · ${r.size}`} mid={locLabel(r.loc)} right={`need ${r.wanted}`} tone={RED} />
        ))}
        {more(count("missingSizes"))}
      </Section>

      <Section title="Stuck refills (waiting too long)" count={count("stuckRefills")}>
        {items("stuckRefills").slice(0, MAX_ROWS).map((r, i) => (
          <Row key={i}
            left={`${nameOf(r.pid)} · ${decodeSizeKey(r.sizeKey || "")}${r.manual ? " (manual)" : ""}`}
            mid={locLabel(r.dest)} right={`${r.ageHours}h`} tone={RED} />
        ))}
        {more(count("stuckRefills"))}
      </Section>

      <Section title="Failed refills (rejected, last 48h)" count={count("failedRefills")}>
        {items("failedRefills").slice(0, MAX_ROWS).map((r, i) => (
          <Row key={i} left={`${nameOf(r.pid)} · ${r.size}`} mid={locLabel(r.dest)} right={r.orderId} tone={RED} />
        ))}
        {more(count("failedRefills"))}
      </Section>

      <Section title="In Central but nowhere else" count={count("onlyInCentral")} tone={AMBER}>
        {items("onlyInCentral").slice(0, MAX_ROWS).map((r, i) => (
          <Row key={i} left={nameOf(r.pid)} right={`${r.units} units`} tone={AMBER} />
        ))}
        {more(count("onlyInCentral"))}
      </Section>

      <Section title="In Hub 2 but in neither shop" count={count("onlyInHub2")} tone={AMBER}>
        {items("onlyInHub2").slice(0, MAX_ROWS).map((r, i) => (
          <Row key={i} left={nameOf(r.pid)} right={`${r.units} units`} tone={AMBER} />
        ))}
        {more(count("onlyInHub2"))}
      </Section>

      <Section title="Excess at Hub 2 (candidates → Central)" count={count("excessAtHub2")} tone={AMBER}>
        {items("excessAtHub2").slice(0, MAX_ROWS).map((r, i) => (
          <Row key={i} left={`${nameOf(r.pid)} · ${decodeSizeKey(r.sizeKey)}`} mid={`have ${r.have}, target ${r.target}`} right={`+${r.excess}`} tone={AMBER} />
        ))}
        {more(count("excessAtHub2"))}
      </Section>

      <Section title="Negative counts (oversell / count holes)" count={count("negativeCells")}>
        {items("negativeCells").slice(0, MAX_ROWS).map((r, i) => (
          <Row key={i} left={`${nameOf(r.pid)} · ${decodeSizeKey(r.sizeKey)}`} mid={locLabel(r.loc)} right={String(r.qty)} tone={RED} />
        ))}
        {more(count("negativeCells"))}
      </Section>

      {/* Confidence */}
      <div style={{ color: GRAY, fontSize: 11, margin: "14px 2px 8px" }}>
        Inventory confidence {confidence?.computedAt ? `— updated ${fmtTs(confidence.computedAt)}` : "(computed hourly)"}
      </div>
      <Section title="Needs review (low confidence)" count={reviewRows.length} tone={AMBER}>
        {reviewRows.slice(0, MAX_ROWS).map((r, i) => (
          <Row key={i}
            left={nameOf(r.pid)}
            mid={`${locLabel(r.loc)}${r.factors?.negativeCells ? ` · ${r.factors.negativeCells} neg` : ""}${r.factors?.adjustments30d ? ` · ${r.factors.adjustments30d} adj` : ""}${r.factors?.uncountedSends30d ? ` · ${r.factors.uncountedSends30d} uncounted` : ""}`}
            right={`${r.score}`}
            tone={r.score < 60 ? RED : AMBER}
          />
        ))}
        {more(reviewRows.length)}
      </Section>
    </div>
  );
}
