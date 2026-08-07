// ─── REFILL HISTORY — Hub 1 and Hub 2, over a date range ──────────────────────
// "What happened to our refills?" answered for a chosen window, including every
// outcome — not just the ones that worked. The existing "Fulfilled history"
// inside the refill queue shows only successes and only the last 100; a
// rejection, a withdrawal or a park leaves no trace there at all, which is
// precisely the half you need when something looks wrong.
//
// PHONE FIRST. This is read on a phone standing in a hub, so: one column, large
// type, 44px+ touch targets, high contrast, and no horizontal scroll. Wider
// screens get more columns of the same rows, never a different layout.
//
// TWO SOURCES, ONE LIST (see refillHistoryCore.js for the full reasoning):
//   • /refill_requests — what was asked and how it ended, with reason and person.
//     A refusal moves no stock, so the ledger can never show it.
//   • /stock_movements — what physically moved and FROM WHERE, and the only
//     durable record of display refills (their /orders rows are overwritten by
//     the daily order-number reset).
// A fulfilled request and its own rrf_ movement are merged into one row.
//
// ─── BANDWIDTH ───────────────────────────────────────────────────────────────
// Movements are queried against the `ts` index that already exists in the live
// rules, so the range genuinely bounds the download.
//
// /refill_requests has NO index. An unindexed orderByChild there would make RTDB
// ship the whole node and sort client-side — the exact cost this view exists to
// avoid, and silently. So the ranged query is gated behind REQUESTS_INDEXED and
// stays off until the rule below is pasted.
//
//   "refill_requests": { ".indexOn": ["createdAt", "resolvedAt"], ... }
//
// WHAT THE FALLBACK ACTUALLY COSTS — stated honestly, because the first version
// of this comment was wrong. It claimed the fallback rode "the subscription the
// Source screen already holds". It does not: Hub2RefillQueue, the other
// consumer, is mounted only on the `clothing` and `hub1refill` tabs, and this is
// its own tab. So the fallback is a real read of the whole node (~11,800 rows,
// ~3.7 MB).
//
// It is a ONE-SHOT get(), not a live onValue subscription, and that difference
// matters: a listener re-materialises the whole node on every append for as long
// as the tab is open. One read per range change is the smallest honest cost
// available without the index. The banner on screen says so rather than implying
// the view is free. (Kimi review, PR #332.)
import React, { useEffect, useMemo, useState } from "react";
import { ref, query, orderByChild, startAt, endAt, get } from "firebase/database";
import { database } from "../../firebase";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, FONT, input } from "./ui";
import { serverNowMs } from "../../utils/serverTime";
import {
  REQUESTS_INDEXED, QUICK_RANGES, resolveRange, saDayOf,
  STATUS_LABEL, REASON_TEXT, requestRows, movementRows, mergeRows, totalsFor,
} from "./refillHistoryCore";

const HUBS = ["hub1", "hub2"];
const LOC_LABEL = {
  hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3", central: "Central",
  "marathon-pe": "Marathon PE", trophy: "Trophy", "marathon-pine": "Marathon Pine",
};
const loc = (k) => LOC_LABEL[k] || k || "—";

const TONE = {
  fulfilled: GREEN, requested: BLUE_L, rejected: RED,
  withdrawn: AMBER, parked: AMBER, cancelled: GRAY,
  display_in: GREEN, display_out: BLUE_L,
};
const KIND_LABEL = { display_in: "Display → hub", display_out: "Display sent out" };

const fmtTime = (ms) => new Date(ms).toLocaleString("en-GB", {
  timeZone: "Africa/Johannesburg", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
});

// ── phone-first controls ─────────────────────────────────────────────────────
// 44px minimum height on everything tappable; that is the floor below which a
// thumb starts missing, and this screen is used standing up.
const chip = (on) => ({
  minHeight: 44, padding: "10px 16px", borderRadius: 999, cursor: "pointer",
  fontSize: 14, fontWeight: 700, fontFamily: FONT, whiteSpace: "nowrap",
  border: on ? "1px solid rgba(74,127,255,.6)" : "1px solid rgba(255,255,255,.12)",
  background: on ? "rgba(74,127,255,.18)" : "rgba(255,255,255,.03)",
  color: on ? "#cfe0ff" : "rgba(255,255,255,.6)",
});
const ROW_WRAP = { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 };

function Tile({ label, count, units, tone }) {
  return (
    <div style={{
      ...GLASS, padding: "12px 14px", minWidth: 108, flex: "1 1 108px",
      borderColor: count ? `${tone}44` : "rgba(255,255,255,.08)",
    }}>
      <div style={{ fontSize: 26, fontWeight: 800, color: count ? tone : "rgba(255,255,255,.25)", lineHeight: 1.1, fontVariantNumeric: "tabular-nums" }}>{count}</div>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "rgba(255,255,255,.75)", marginTop: 2 }}>{label}</div>
      <div style={{ fontSize: 11.5, color: GRAY }}>{units} unit{units === 1 ? "" : "s"}</div>
    </div>
  );
}

export default function RefillHistory({ products = [] }) {
  const [rangeKey, setRangeKey] = useState("today");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [hubs, setHubs] = useState(HUBS);
  // The range is resolved once per selection, not per render — resolveRange()
  // reads the clock, so recomputing it on every render would make a row silently
  // change day at midnight while someone is reading it.
  const range = useMemo(() => resolveRange(rangeKey, serverNowMs(), custom), [rangeKey, custom]);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  // ── movements: ranged, against the EXISTING ts index ───────────────────────
  const [movements, setMovements] = useState(null);   // null = loading
  const [mvError, setMvError] = useState(null);
  useEffect(() => {
    let alive = true;
    setMovements(null); setMvError(null);
    get(query(ref(database, "stock_movements"), orderByChild("ts"), startAt(range.fromIso), endAt(range.toIso)))
      .then((snap) => {
        if (!alive) return;
        const val = snap.val() || {};
        setMovements(Object.entries(val).map(([id, m]) => ({ id, ...m })));
      })
      .catch((e) => { if (alive) { setMovements([]); setMvError(e?.message || "read failed"); } });
    return () => { alive = false; };
  }, [range.fromIso, range.toIso]);

  // ── requests ───────────────────────────────────────────────────────────────
  // Indexed: two ranged queries. Unindexed: ONE whole-node get() — see the cost
  // note at the top of this file. Either way a one-shot, never a live listener:
  // history does not need to tick, and a listener would re-materialise the node
  // on every append for as long as the tab is open.
  const [requests, setRequests] = useState(null);   // null = loading
  const [rrError, setRrError] = useState(null);
  useEffect(() => {
    let alive = true;
    setRequests(null); setRrError(null);
    // TWO queries when indexed: a request raised last month and picked yesterday
    // belongs in yesterday's history, and one index cannot answer both ends.
    // Merged by id. Unindexed: a single unfiltered read, filtered in memory.
    const fetch = REQUESTS_INDEXED
      ? Promise.all(["createdAt", "resolvedAt"].map((field) =>
          get(query(ref(database, "refill_requests"), orderByChild(field), startAt(range.fromIso), endAt(range.toIso)))
            .then((s) => s.val() || {})))
          .then(([a, b]) => ({ ...a, ...b }))
      : get(ref(database, "refill_requests")).then((s) => s.val() || {});
    fetch
      .then((val) => { if (alive) setRequests(Object.entries(val).map(([id, r]) => ({ id, ...r }))); })
      .catch((e) => { if (alive) { setRequests([]); setRrError(e?.message || "read failed"); } });
    return () => { alive = false; };
  }, [range.fromIso, range.toIso]);

  // BOTH sources must have landed. Treating an in-flight request read as "no
  // rows" renders an authoritative-looking empty state that is simply wrong.
  const loading = movements === null || requests === null;

  const rows = useMemo(() => {
    if (loading) return [];
    return mergeRows(requestRows(requests || [], range, hubs), movementRows(movements || [], range, hubs));
  }, [requests, movements, range, hubs, loading]);
  const totals = useMemo(() => totalsFor(rows), [rows]);

  const toggleHub = (h) => setHubs((cur) =>
    // Never allow an empty selection — it reads as a bug ("no data") rather than
    // a filter. The last hub standing stays on.
    cur.includes(h) ? (cur.length > 1 ? cur.filter((x) => x !== h) : cur) : [...cur, h]);

  const todayStr = saDayOf(serverNowMs());

  return (
    <div style={{ paddingBottom: 40, fontFamily: FONT }}>
      {/* ── RANGE ── */}
      <div style={ROW_WRAP}>
        {QUICK_RANGES.map((r) => (
          <button key={r.key} type="button" onClick={() => setRangeKey(r.key)} style={chip(rangeKey === r.key)}>{r.label}</button>
        ))}
        <button type="button" onClick={() => setRangeKey("custom")} style={chip(rangeKey === "custom")}>Custom</button>
      </div>
      {rangeKey === "custom" && (
        <div style={{ ...ROW_WRAP, alignItems: "center" }}>
          <label style={{ fontSize: 13, color: GRAY, minWidth: 42 }}>From</label>
          <input type="date" max={todayStr} value={custom.from || todayStr}
                 onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                 style={{ ...input, minHeight: 44, colorScheme: "dark", flex: "1 1 140px" }} />
          <label style={{ fontSize: 13, color: GRAY, minWidth: 24 }}>to</label>
          <input type="date" max={todayStr} value={custom.to || custom.from || todayStr}
                 onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                 style={{ ...input, minHeight: 44, colorScheme: "dark", flex: "1 1 140px" }} />
        </div>
      )}

      {/* ── HUB ── */}
      <div style={ROW_WRAP}>
        {HUBS.map((h) => (
          <button key={h} type="button" onClick={() => toggleHub(h)} style={chip(hubs.includes(h))}>{loc(h)}</button>
        ))}
        <button type="button" onClick={() => setHubs(HUBS)} style={chip(hubs.length === 2)}>Both</button>
      </div>

      <div style={{ fontSize: 12.5, color: GRAY, margin: "0 2px 12px", lineHeight: 1.5 }}>
        {range.fromDay === range.toDay ? range.fromDay : `${range.fromDay} → ${range.toDay}`}
        {" · "}{range.days} day{range.days === 1 ? "" : "s"} · SA time
        {!REQUESTS_INDEXED && (
          <span style={{ color: AMBER }}>
            {" · "}movements are date-ranged; request outcomes are filtered after a full read
            of /refill_requests, because that node has no date index yet.
          </span>
        )}
      </div>

      {/* ── TOTALS ── */}
      {!loading && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          {["requested", "fulfilled", "rejected", "withdrawn", "parked", "cancelled"].map((s) => (
            <Tile key={s} label={STATUS_LABEL[s]} count={totals[s].rows} units={totals[s].units} tone={TONE[s]} />
          ))}
          {["display_in", "display_out"].map((s) => (
            totals[s].rows ? <Tile key={s} label={KIND_LABEL[s]} count={totals[s].rows} units={totals[s].units} tone={TONE[s]} /> : null
          ))}
        </div>
      )}

      {mvError && <div style={{ ...GLASS, padding: 14, color: AMBER, fontSize: 13, marginBottom: 12 }}>Movements didn&rsquo;t load ({mvError}). Request outcomes below are still accurate; the physical-move rows are missing.</div>}
      {rrError && <div style={{ ...GLASS, padding: 14, color: AMBER, fontSize: 13, marginBottom: 12 }}>Request outcomes didn&rsquo;t load ({rrError}). If the date index was just added, reload.</div>}

      {loading ? (
        <div style={{ ...GLASS, padding: 18, color: GRAY, fontSize: 14 }}>Loading&hellip;</div>
      ) : rows.length === 0 ? (
        <div style={{ ...GLASS, padding: 18, color: GRAY, fontSize: 14 }}>
          No refill activity at {hubs.map(loc).join(" or ")} in this range.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((r) => {
            const p = byId.get(r.productId);
            const tone = TONE[r.kind === "display_in" || r.kind === "display_out" ? r.kind : r.status] || GRAY;
            const label = KIND_LABEL[r.kind] || STATUS_LABEL[r.status] || r.status;
            const qty = r.movedQty ?? r.qty;
            return (
              <div key={r.key} style={{ ...GLASS, padding: "13px 14px", borderColor: `${tone}33` }}>
                <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                  {p?.photoUrl
                    ? <img src={p.photoUrl} alt="" style={{ width: 46, height: 46, borderRadius: 9, objectFit: "cover", flexShrink: 0 }} />
                    : <span style={{ width: 46, height: 46, borderRadius: 9, background: "rgba(255,255,255,.05)", flexShrink: 0 }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", lineHeight: 1.3, overflowWrap: "anywhere" }}>
                      {p?.name || r.productId}
                    </div>
                    <div style={{ fontSize: 14, color: "rgba(255,255,255,.8)", marginTop: 3, fontVariantNumeric: "tabular-nums" }}>
                      size <b>{r.size || "—"}</b> · <b>×{qty}</b>
                    </div>
                    {/* SOURCE → DESTINATION, always stated. "Which location
                        supplied this" is the question a hub actually asks. */}
                    <div style={{ fontSize: 13.5, color: GRAY, marginTop: 3 }}>
                      {loc(r.source)} <span aria-hidden>→</span> {loc(r.dest)}
                    </div>
                    <div style={{ fontSize: 12.5, color: GRAY, marginTop: 3, fontVariantNumeric: "tabular-nums" }}>
                      {fmtTime(r.ts)}
                      {r.raisedMs && r.resolvedMs && r.raisedMs !== r.ts ? ` · raised ${fmtTime(r.raisedMs)}` : ""}
                    </div>
                  </div>
                  <span style={{
                    flexShrink: 0, fontSize: 12.5, fontWeight: 800, color: tone,
                    border: `1px solid ${tone}55`, background: `${tone}14`,
                    borderRadius: 999, padding: "6px 11px", whiteSpace: "nowrap",
                  }}>{label}</span>
                </div>
                {/* WHY and WHO — a rejection with no reason and no name is the
                    thing this whole view was built to stop. */}
                {(r.reason || r.actorUid || r.actorRole || r.auto || r.uncounted || r.via) && (
                  <div style={{ fontSize: 12.5, color: GRAY, marginTop: 9, lineHeight: 1.5, borderTop: "1px solid rgba(255,255,255,.06)", paddingTop: 8 }}>
                    {r.status === "rejected" && <span style={{ color: RED, fontWeight: 700 }}>Rejected — marked not available on the shelf. </span>}
                    {r.reason && <span>{REASON_TEXT[r.reason] || r.reason}. </span>}
                    {(r.actorUid || r.actorRole) && (
                      <span>by <b style={{ color: "rgba(255,255,255,.8)" }}>{r.actorRole && r.actorRole !== "engine" ? r.actorRole : (r.auto ? "the engine" : "staff")}</b>
                        {r.actorUid ? ` (${String(r.actorUid).slice(0, 8)})` : ""}. </span>
                    )}
                    {r.auto && !r.reason && <span>Raised automatically. </span>}
                    {r.via === "missing_sneakers" && <span>Raised from Missing Sneakers (policy quantity). </span>}
                    {r.via === "missing_sneakers_pick" && <span>Raised from Missing Sneakers (operator chose the sizes). </span>}
                    {r.uncounted && <span style={{ color: AMBER }}>Sent uncounted — added at the hub with no deduction. </span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
