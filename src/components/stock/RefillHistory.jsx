// ─── REFILL HISTORY — day stepper · status tabs · hub stepper (redo 2026-08-08) ─
// "What happened to our refills?" answered ONE SA DAY AT A TIME:
//
//   • DAY STEPPER (top) — one line showing the day and its date, ← steps to
//     the day before, → steps forward and is DISABLED at today. Today is the
//     default.
//   • STATUS TABS — Open, Queued, Refilled, Rejected, No longer needed,
//     Parked (and the display-movement kinds when present) are REAL TABS: each
//     opens its own view of exactly those rows — product, size, quantity,
//     source, destination, time, actor, and the reason on every rejection.
//     "Queued" is the release-window split of the open set: raised, but
//     accumulating behind the next batch (releaseWindows.js, same pure gate
//     the queue uses).
//   • HUB STEPPER (bottom) — the same arrow pattern, cycling All / Hub 1 /
//     Hub 2 / Shops.
//
// COLOUR follows the app's own system — the near-black navy card surface with
// the #4A7FFF blue accent used on the home page and the hub cards — not the
// translucent white glass this screen wore before. Phone first: large type,
// 44px+ targets, high contrast.
//
// ─── BANDWIDTH (unchanged contract — never a whole-node read) ────────────────
//   • movements    → orderByChild("ts"), startAt/endBefore      (ts index)
//   • requests     → orderByChild("createdAt")  ranged
//                    orderByChild("resolvedAt") ranged          (console index,
//                                                                live 2026-08-07)
//   • open backlog → orderByChild("resolvedAt"), equalTo(null)
// REQUESTS_INDEXED in refillHistoryCore.js switches to the whole-node fallback
// (amber banner) if the console index is ever removed. One-shot get(), never a
// live listener — history does not tick.
import React, { useEffect, useMemo, useState } from "react";
import { ref, query, orderByChild, startAt, endBefore, equalTo, get } from "firebase/database";
import { database } from "../../firebase";
import { GRAY, GREEN, RED, AMBER, BLUE, FONT } from "./ui";
import { serverNowMs } from "../../utils/serverTime";
import { useEngineConfig } from "./useStock";
import { parseReleaseTimes, isReleased } from "./releaseWindows";
import {
  REQUESTS_INDEXED, resolveRange, saDayOf, shiftDay, HUB_STEPS, stepHub,
  STATUS_LABEL, STATUS_EXPLAIN, REASON_TEXT, requestRows, movementRows, mergeRows,
} from "./refillHistoryCore";

const LOC_LABEL = {
  hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3", central: "Central",
  "marathon-pe": "Marathon PE", trophy: "Trophy", "marathon-pine": "Marathon Pine",
};
const loc = (k) => LOC_LABEL[k] || k || "—";

const TONE = {
  fulfilled: GREEN, requested: "#9DBCFF", queued: AMBER, rejected: RED,
  withdrawn: AMBER, parked: AMBER,
  display_in: GREEN, display_out: "#9DBCFF",
};
// disp_ movements are EVERY order dispatched out of a hub, not only displays.
const KIND_LABEL = { display_in: "Display → hub", display_out: "Sent out" };

const TIME_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
});
const fmtTime = (ms) => TIME_FMT.format(new Date(ms));
const DAY_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg", weekday: "long", day: "numeric", month: "long",
});
const fmtDay = (saDay) => DAY_FMT.format(new Date(`${saDay}T12:00:00.000Z`));

// The app's card idiom — navy surface, blue accent (home page / hub cards).
const CARD = {
  background: "rgba(4,5,10,1)",
  border: "1px solid rgba(60,110,255,.35)",
  borderRadius: 14,
  boxShadow: "0 0 10px rgba(60,110,255,.10)",
};
const ARROW = (enabled) => ({
  width: 48, height: 48, borderRadius: 12, cursor: enabled ? "pointer" : "default",
  border: enabled ? "1px solid rgba(60,110,255,.5)" : "1px solid rgba(255,255,255,.08)",
  background: enabled ? "rgba(60,110,255,.12)" : "rgba(255,255,255,.02)",
  color: enabled ? "#9DBCFF" : "rgba(255,255,255,.25)",
  fontSize: 20, fontWeight: 800, fontFamily: FONT,
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
});

// One stepper line — shared by the day (top) and hub (bottom) controls.
function StepperBar({ onBack, onForward, backEnabled, forwardEnabled, title, sub, backLabel, forwardLabel }) {
  return (
    <div style={{ ...CARD, display: "flex", alignItems: "center", gap: 12, padding: "10px 12px" }}>
      <button type="button" aria-label={backLabel} onClick={onBack} disabled={!backEnabled} style={ARROW(backEnabled)}>‹</button>
      <div style={{ flex: 1, textAlign: "center", minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: "#fff", fontFamily: FONT, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
        {sub && <div style={{ fontSize: 11.5, color: GRAY, marginTop: 2 }}>{sub}</div>}
      </div>
      <button type="button" aria-label={forwardLabel} onClick={onForward} disabled={!forwardEnabled} style={ARROW(forwardEnabled)}>›</button>
    </div>
  );
}

// Live-ticking server-corrected "now", once a minute — the Open/Queued split is
// a function of the clock, and a screen left open across a release instant must
// re-bucket on its own (CodeRabbit, PR #337: a render-time read froze a Queued
// row as Queued until the user happened to change day, hub or tab).
function useNowMinute() {
  const [now, setNow] = useState(() => serverNowMs());
  useEffect(() => {
    const id = setInterval(() => setNow(serverNowMs()), 60000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export default function RefillHistory({ products = [] }) {
  const nowMs = useNowMinute();
  const todayStr = saDayOf(nowMs);
  const [day, setDay] = useState(todayStr);
  const [hubIdx, setHubIdx] = useState(0);
  const [tab, setTab] = useState("requested");

  // The one-day range drives every bounded query, exactly as the old quick
  // ranges did — resolved once per selection, not per render.
  const range = useMemo(() => resolveRange("custom", serverNowMs(), { from: day, to: day }), [day]);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const hubStep = HUB_STEPS[hubIdx];

  // Queued = open but behind the next release window — same config, same pure
  // gate as the pick queue.
  const engineConfig = useEngineConfig();
  const windows = useMemo(() => parseReleaseTimes(engineConfig?.releaseWindows), [engineConfig?.releaseWindows]);

  // ── movements: ranged, against the EXISTING ts index ───────────────────────
  const [movements, setMovements] = useState(null);   // null = loading
  const [mvError, setMvError] = useState(null);
  useEffect(() => {
    let alive = true;
    setMovements(null); setMvError(null);
    get(query(ref(database, "stock_movements"), orderByChild("ts"), startAt(range.fromIso), endBefore(range.toIso)))
      .then((snap) => {
        if (!alive) return;
        const val = snap.val() || {};
        setMovements(Object.entries(val).map(([id, m]) => ({ id, ...m })));
      })
      .catch((e) => { if (alive) { setMovements([]); setMvError(e?.message || "read failed"); } });
    return () => { alive = false; };
  }, [range.fromIso, range.toIso]);

  // ── requests: createdAt-ranged + resolvedAt-ranged + the open set ──────────
  // Indexed: three bounded queries merged by id. Unindexed: ONE whole-node
  // get() per mount (the range is applied in memory — re-reading ~3.7 MB per
  // day-step would be the worst of both worlds). One-shot either way.
  const [requests, setRequests] = useState(null);   // null = loading
  const [rrError, setRrError] = useState(null);
  const queryKey = REQUESTS_INDEXED ? `${range.fromIso}|${range.toIso}` : "all";
  useEffect(() => {
    let alive = true;
    setRequests(null); setRrError(null);
    const fetch = REQUESTS_INDEXED
      ? Promise.all([
          get(query(ref(database, "refill_requests"), orderByChild("createdAt"), startAt(range.fromIso), endBefore(range.toIso)))
            .then((s) => s.val() || {}),
          get(query(ref(database, "refill_requests"), orderByChild("resolvedAt"), startAt(range.fromIso), endBefore(range.toIso)))
            .then((s) => s.val() || {}),
          // The open backlog. Keep ONLY status "open": a legacy closed row
          // missing resolvedAt must not smuggle an out-of-range outcome in.
          get(query(ref(database, "refill_requests"), orderByChild("resolvedAt"), equalTo(null)))
            .then((s) => {
              const val = s.val() || {};
              const open = {};
              for (const [id, r] of Object.entries(val)) if (r?.status === "open") open[id] = r;
              return open;
            }),
        ]).then(([a, b, c]) => ({ ...a, ...b, ...c }))
      : get(ref(database, "refill_requests")).then((s) => s.val() || {});
    fetch
      .then((val) => { if (alive) setRequests(Object.entries(val).map(([id, r]) => ({ id, ...r }))); })
      .catch((e) => { if (alive) { setRequests([]); setRrError(e?.message || "read failed"); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  const loading = movements === null || requests === null;

  const rows = useMemo(() => {
    if (loading) return [];
    return mergeRows(requestRows(requests || [], range, hubStep.locs), movementRows(movements || [], range, hubStep.locs));
  }, [requests, movements, range, hubStep, loading]);

  // Which tab does a row belong to? Display kinds keep their kind; an open
  // request splits Open (released) vs Queued (behind the window); the rest is
  // its classified status. `nowMs` is the minute ticker above, and it is a
  // dependency of BOTH memos, so crossing a release instant re-buckets Queued
  // rows into Open without any user interaction.
  const bucketOf = (r) => {
    if (r.kind === "display_in" || r.kind === "display_out") return r.kind;
    if (r.status === "requested") return isReleased(r, nowMs, windows) ? "requested" : "queued";
    return r.status;
  };
  const counts = useMemo(() => {
    const out = {};
    for (const r of rows) {
      const b = bucketOf(r);
      out[b] = (out[b] || 0) + 1;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, windows, nowMs]);
  const shown = useMemo(() => rows.filter((r) => bucketOf(r) === tab), [rows, tab, windows, nowMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const TAB_KEYS = ["requested", "queued", "fulfilled", "rejected", "withdrawn", "parked",
    ...(counts.display_in ? ["display_in"] : []), ...(counts.display_out ? ["display_out"] : [])];

  const dayBack = shiftDay(day, -1, todayStr);
  const dayForward = shiftDay(day, +1, todayStr);   // null AT today — arrow disabled

  return (
    <div style={{ paddingBottom: 24, fontFamily: FONT, maxWidth: 720, display: "flex", flexDirection: "column", gap: 12 }}>
      {/* ── DAY STEPPER — one day at a time, forward disabled at today ── */}
      <StepperBar
        onBack={() => dayBack && setDay(dayBack)}
        onForward={() => dayForward && setDay(dayForward)}
        backEnabled={!!dayBack}
        forwardEnabled={!!dayForward}
        backLabel="Previous day" forwardLabel="Next day"
        title={day === todayStr ? "Today" : shiftDay(day, +1, todayStr) === todayStr ? "Yesterday" : fmtDay(day).split(" ")[0]}
        sub={`${fmtDay(day)} · SA time`}
      />

      {/* ── STATUS TABS — each opens its own rows ── */}
      <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }} role="tablist">
        {TAB_KEYS.map((k) => {
          const on = tab === k;
          const tone = TONE[k] || GRAY;
          return (
            <button key={k} type="button" role="tab" aria-selected={on} onClick={() => setTab(k)}
                    style={{ flex: "0 0 auto", minHeight: 44, padding: "10px 15px", borderRadius: 999, cursor: "pointer",
                             fontSize: 13.5, fontWeight: 800, fontFamily: FONT, whiteSpace: "nowrap",
                             border: on ? `1px solid ${tone}` : "1px solid rgba(255,255,255,.1)",
                             background: on ? `${tone}22` : "rgba(4,5,10,1)",
                             color: on ? "#fff" : "rgba(255,255,255,.55)" }}>
              {KIND_LABEL[k] || STATUS_LABEL[k]}
              <span style={{ marginLeft: 7, color: on ? tone : "rgba(255,255,255,.35)", fontVariantNumeric: "tabular-nums" }}>
                {loading ? "…" : (counts[k] || 0)}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ fontSize: 11.5, color: GRAY, margin: "0 2px", lineHeight: 1.5 }}>
        {STATUS_EXPLAIN[tab] || ""}
        {(tab === "requested" || tab === "queued") && " · shown whatever the raise date"}
        {!REQUESTS_INDEXED && (
          <span style={{ color: AMBER }}>
            {" "}· movements are date-ranged; request outcomes are filtered after a full read
            of /refill_requests, because that node has no date index yet.
          </span>
        )}
      </div>

      {mvError && <div style={{ ...CARD, padding: 14, color: AMBER, fontSize: 13 }}>Movements didn&rsquo;t load ({mvError}). Request outcomes are still accurate; the physical-move rows are missing.</div>}
      {rrError && <div style={{ ...CARD, padding: 14, color: AMBER, fontSize: 13 }}>Request outcomes didn&rsquo;t load ({rrError}). If the date index was just added, reload.</div>}

      {loading ? (
        <div style={{ ...CARD, padding: 18, color: GRAY, fontSize: 14 }}>Loading&hellip;</div>
      ) : shown.length === 0 ? (
        <div style={{ ...CARD, padding: 18, color: GRAY, fontSize: 14 }}>
          Nothing under &ldquo;{KIND_LABEL[tab] || STATUS_LABEL[tab]}&rdquo; at {hubStep.label === "All" ? "any location" : hubStep.label} on this day.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {shown.map((r) => {
            const p = byId.get(r.productId);
            const tone = TONE[bucketOf(r)] || GRAY;
            const qty = r.movedQty ?? r.qty;
            return (
              <div key={r.key} style={{ ...CARD, padding: "14px 15px", borderColor: `${tone}44` }}>
                <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                  {p?.photoUrl
                    ? <img src={p.photoUrl} alt="" style={{ width: 48, height: 48, borderRadius: 9, objectFit: "cover", flexShrink: 0 }} />
                    : <span style={{ width: 48, height: 48, borderRadius: 9, background: "rgba(60,110,255,.08)", flexShrink: 0 }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15.5, fontWeight: 700, color: "#fff", lineHeight: 1.3, overflowWrap: "anywhere" }}>
                      {p?.name || r.productId}
                    </div>
                    <div style={{ fontSize: 14.5, color: "rgba(255,255,255,.85)", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
                      size <b>{r.size || "—"}</b> · <b>×{qty}</b>
                    </div>
                    {/* SOURCE → DESTINATION, always stated. */}
                    <div style={{ fontSize: 13.5, color: GRAY, marginTop: 4 }}>
                      {loc(r.source)} <span aria-hidden>→</span> {loc(r.dest)}
                    </div>
                    <div style={{ fontSize: 12.5, color: GRAY, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
                      {fmtTime(r.ts)}
                      {r.raisedMs && r.resolvedMs && r.raisedMs !== r.ts ? ` · raised ${fmtTime(r.raisedMs)}` : ""}
                    </div>
                  </div>
                </div>
                {/* WHY and WHO — a rejection with no reason and no name is the
                    thing this view exists to prevent. */}
                {(r.reason || r.actorUid || r.actorRole || r.byEngine || r.auto || r.uncounted || r.status === "rejected") && (
                  <div style={{ fontSize: 12.5, color: GRAY, marginTop: 10, lineHeight: 1.55, borderTop: "1px solid rgba(60,110,255,.15)", paddingTop: 9 }}>
                    {r.status === "rejected" && <span style={{ color: RED, fontWeight: 700 }}>Rejected — marked not available on the shelf. </span>}
                    {r.reason && <span>{REASON_TEXT[r.reason] || r.reason}. </span>}
                    {(r.actorUid || r.actorRole) ? (
                      <span>by <b style={{ color: "rgba(255,255,255,.8)" }}>{r.actorRole || "staff"}</b>
                        {r.actorUid ? ` (${String(r.actorUid).slice(0, 8)})` : ""}. </span>
                    ) : r.byEngine ? (
                      <span>Withdrawn by <b style={{ color: "rgba(255,255,255,.8)" }}>the engine</b>. </span>
                    ) : null}
                    {r.auto && !r.reason && <span>Raised automatically. </span>}
                    {r.uncounted && <span style={{ color: AMBER }}>Sent uncounted — added at the hub with no deduction. </span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── HUB STEPPER — bottom, cycling All / Hub 1 / Hub 2 / Shops ── */}
      <StepperBar
        onBack={() => setHubIdx((i) => stepHub(i, -1))}
        onForward={() => setHubIdx((i) => stepHub(i, +1))}
        backEnabled forwardEnabled
        backLabel="Previous location" forwardLabel="Next location"
        title={hubStep.label}
        sub={hubStep.key === "all" ? "hubs and shops together" : hubStep.key === "shops" ? "Marathon PE · Trophy · Pine · Hub 3" : null}
      />
      <div style={{ fontSize: 11, color: "rgba(255,255,255,.3)", textAlign: "center" }}>
        <span style={{ color: BLUE, fontWeight: 700 }}>{hubStep.label}</span> · step through All / Hub 1 / Hub 2 / Shops
      </div>
    </div>
  );
}
