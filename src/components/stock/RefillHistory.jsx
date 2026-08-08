// ─── REFILL HISTORY — every outcome, over a date range (owner redo 2026-08-08) ─
// "What happened to our refills?" answered for a chosen window, including every
// outcome — not just the ones that worked. Three rules from the redo:
//
//   • THE OPEN COUNT IS TRUE. An open request is a present fact: it is counted
//     whatever the range, dated by when it was RAISED. The old range filter
//     dropped the whole open backlog (an open row has no resolvedAt to land in
//     any window) and the tile read 0 against ~150 genuinely open asks.
//   • EVERY TILE OPENS ITS ROWS. Tapping a count filters the list to exactly
//     the rows behind it — product, size, quantity, source, destination, time,
//     who acted, and the reason on every rejection.
//   • FIVE OUTCOMES, NOT SEVEN. The database stores only open|fulfilled|
//     cancelled; "Withdrawn" and "Cancelled" were two tiles over one stored
//     value. One bucket now — "No longer needed" — with the exact reason per
//     row. See refillHistoryCore.js for the stored-vs-derived table.
//
// PHONE FIRST. Read standing in a hub: one column, large type, 44px+ targets,
// high contrast, day headers separating days, no horizontal scroll.
//
// TWO SOURCES, ONE LIST (see refillHistoryCore.js for the full reasoning):
//   • /refill_requests — what was asked and how it ended, with reason + person.
//   • /stock_movements — what physically moved and FROM WHERE; also the only
//     durable record of display registrations and order dispatches (their
//     /orders rows are overwritten by the daily order-number reset).
// A fulfilled request and its own rrf_ movement are merged into one row.
//
// ─── BANDWIDTH ───────────────────────────────────────────────────────────────
// EVERY read is index-backed and bounded — never a whole node:
//
//   • movements    → orderByChild("ts"), startAt/endBefore    (ts index)
//   • requests     → orderByChild("createdAt")  ranged
//                    orderByChild("resolvedAt") ranged        (console index,
//                                                              live 2026-08-07)
//   • open backlog → orderByChild("resolvedAt"), equalTo(null)
//     An open request is the ONLY shape with no resolvedAt (both close paths
//     always stamp it), so equalTo(null) on the SAME live index returns
//     exactly the open set (~200 rows) — the true backlog, without a range
//     and without a full download.
//
// REQUESTS_INDEXED in refillHistoryCore.js is the switch between this and the
// whole-node fallback (amber banner). RefillHistory.render.test.jsx asserts
// every query is constrained, so flipping the flag without removing the index
// fails CI. Still one-shot get(), never onValue: history does not tick.
import React, { useEffect, useMemo, useState } from "react";
import { ref, query, orderByChild, startAt, endBefore, equalTo, get } from "firebase/database";
import { database } from "../../firebase";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, FONT, input } from "./ui";
import { serverNowMs } from "../../utils/serverTime";
import {
  REQUESTS_INDEXED, QUICK_RANGES, resolveRange, saDayOf,
  STATUS_LABEL, STATUS_EXPLAIN, REASON_TEXT, requestRows, movementRows, mergeRows, totalsFor,
} from "./refillHistoryCore";

// Location filter groups. "Shops" exists because shop-leg requests are real
// rows in the same node — hiding them was half of why the Open count lied.
const LOC_GROUPS = [
  { key: "hub1", label: "Hub 1", locs: ["hub1"] },
  { key: "hub2", label: "Hub 2", locs: ["hub2"] },
  { key: "shops", label: "Shops", locs: ["marathon-pe", "trophy", "marathon-pine", "hub3"] },
];
const ALL_GROUP_KEYS = LOC_GROUPS.map((g) => g.key);
const LOC_LABEL = {
  hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3", central: "Central",
  "marathon-pe": "Marathon PE", trophy: "Trophy", "marathon-pine": "Marathon Pine",
};
const loc = (k) => LOC_LABEL[k] || k || "—";

const TONE = {
  fulfilled: GREEN, requested: BLUE_L, rejected: RED,
  withdrawn: AMBER, parked: AMBER,
  display_in: GREEN, display_out: BLUE_L,
};
// disp_ movements are EVERY order dispatched out of a hub (clothing, perfume,
// bags…), not only displays — the old "Display sent out" label is why 260 of
// them read as an impossibility. Say what the row actually is.
const KIND_LABEL = { display_in: "Display → hub", display_out: "Order sent out" };

// One formatter, constructed once. toLocaleString builds a fresh Intl formatter
// on EVERY call, and a "This month" range calls this up to twice per row.
const TIME_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
});
const fmtTime = (ms) => TIME_FMT.format(new Date(ms));
const DAY_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg", weekday: "long", day: "numeric", month: "long",
});
const fmtDay = (saDay) => DAY_FMT.format(new Date(`${saDay}T12:00:00.000Z`));

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

// A status tile IS a button: tapping it opens the rows behind the number.
function Tile({ label, explain, count, units, tone, on, onClick }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} style={{
      ...GLASS, padding: "14px 15px", textAlign: "left", cursor: "pointer",
      minHeight: 92, fontFamily: FONT,
      border: on ? `1px solid ${tone}` : count ? `1px solid ${tone}44` : "1px solid rgba(255,255,255,.08)",
      background: on ? `${tone}1c` : undefined,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 30, fontWeight: 800, color: count ? tone : "rgba(255,255,255,.25)", lineHeight: 1.05, fontVariantNumeric: "tabular-nums" }}>{count}</span>
        <span style={{ fontSize: 13, color: GRAY, fontVariantNumeric: "tabular-nums" }}>{units} unit{units === 1 ? "" : "s"}</span>
      </div>
      <div style={{ fontSize: 14.5, fontWeight: 800, color: "rgba(255,255,255,.9)", marginTop: 5 }}>{label}</div>
      {explain && <div style={{ fontSize: 11.5, color: GRAY, marginTop: 3, lineHeight: 1.4 }}>{explain}</div>}
      <div style={{ fontSize: 11, color: on ? "#cfe0ff" : "rgba(255,255,255,.35)", marginTop: 6, fontWeight: 700 }}>
        {on ? "Showing these rows ↓ (tap to clear)" : "Tap to see the rows"}
      </div>
    </button>
  );
}

export default function RefillHistory({ products = [] }) {
  const [rangeKey, setRangeKey] = useState("today");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [groups, setGroups] = useState(ALL_GROUP_KEYS);
  // Which tile is open — null shows everything. This is the whole point of the
  // screen: a count you cannot open is a claim, not a record.
  const [drill, setDrill] = useState(null);
  // The range is resolved once per selection, not per render — resolveRange()
  // reads the clock, so recomputing it on every render would make a row silently
  // change day at midnight while someone is reading it.
  const range = useMemo(() => resolveRange(rangeKey, serverNowMs(), custom), [rangeKey, custom]);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const locations = useMemo(
    () => LOC_GROUPS.filter((g) => groups.includes(g.key)).flatMap((g) => g.locs),
    [groups]);

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

  // ── requests ───────────────────────────────────────────────────────────────
  // Indexed: THREE bounded queries — createdAt in range, resolvedAt in range,
  // and the OPEN BACKLOG (resolvedAt equalTo null: an open request is the only
  // shape with no resolvedAt, so this returns exactly the open set whatever its
  // raise date). Merged by id. Unindexed: ONE whole-node get() — see the cost
  // note at the top. Either way a one-shot, never a live listener.
  const [requests, setRequests] = useState(null);   // null = loading
  const [rrError, setRrError] = useState(null);
  // THE RANGE IS ONLY A DEPENDENCY WHEN IT ACTUALLY CHANGES THE QUERY.
  // Indexed, the range IS the query, so a new range means a new read. Unindexed,
  // the read is the whole node and the range is applied in memory — so keying
  // the effect on the range would re-download ~3.7 MB every time someone taps
  // Today → Yesterday → Last 7 → Month. One read per mount instead.
  // (Sonnet review, PR #332.)
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
          // The open backlog. Keep ONLY status "open" from this query: a legacy
          // closed row missing resolvedAt would otherwise smuggle an
          // out-of-range outcome into the totals.
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

  // BOTH sources must have landed. Treating an in-flight request read as "no
  // rows" renders an authoritative-looking empty state that is simply wrong.
  const loading = movements === null || requests === null;

  const rows = useMemo(() => {
    if (loading) return [];
    return mergeRows(requestRows(requests || [], range, locations), movementRows(movements || [], range, locations));
  }, [requests, movements, range, locations, loading]);
  const totals = useMemo(() => totalsFor(rows), [rows]);

  // The drill filter. A row belongs to a tile by the same rule totalsFor uses.
  const bucketOf = (r) => (r.kind === "display_in" || r.kind === "display_out" ? r.kind : r.status);
  const shown = useMemo(() => (drill ? rows.filter((r) => bucketOf(r) === drill) : rows), [rows, drill]);

  // Day groups, newest day first (rows are already ts-desc from mergeRows).
  const byDay = useMemo(() => {
    const out = [];
    let cur = null;
    for (const r of shown) {
      const day = saDayOf(r.ts);
      if (!cur || cur.day !== day) { cur = { day, rows: [] }; out.push(cur); }
      cur.rows.push(r);
    }
    return out;
  }, [shown]);

  const toggleGroup = (k) => setGroups((cur) =>
    // Never allow an empty selection — it reads as a bug ("no data") rather than
    // a filter. The last group standing stays on.
    cur.includes(k) ? (cur.length > 1 ? cur.filter((x) => x !== k) : cur) : [...cur, k]);

  const todayStr = saDayOf(serverNowMs());
  const tileKeys = ["requested", "fulfilled", "rejected", "withdrawn", "parked"];

  return (
    <div style={{ paddingBottom: 40, fontFamily: FONT, maxWidth: 720 }}>
      {/* ── RANGE ── */}
      <div style={ROW_WRAP}>
        {/* aria-pressed, because these chips carry their state ONLY in colour —
            a screen reader would otherwise announce every one identically and
            the operator could not tell which range is active. */}
        {QUICK_RANGES.map((r) => (
          <button key={r.key} type="button" aria-pressed={rangeKey === r.key}
                  onClick={() => setRangeKey(r.key)} style={chip(rangeKey === r.key)}>{r.label}</button>
        ))}
        <button type="button" aria-pressed={rangeKey === "custom"}
                onClick={() => setRangeKey("custom")} style={chip(rangeKey === "custom")}>Custom</button>
      </div>
      {rangeKey === "custom" && (
        // htmlFor/id pairs the labels to their inputs: without them a screen
        // reader announces two bare date fields, and tapping the word "From"
        // does nothing — on a phone, that label is a touch target people
        // reach for. (CodeRabbit, PR #332.)
        <div style={{ ...ROW_WRAP, alignItems: "center" }}>
          <label htmlFor="refill-history-from" style={{ fontSize: 13, color: GRAY, minWidth: 42 }}>From</label>
          <input id="refill-history-from" type="date" max={todayStr} value={custom.from || todayStr}
                 onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                 style={{ ...input, minHeight: 44, colorScheme: "dark", flex: "1 1 140px" }} />
          <label htmlFor="refill-history-to" style={{ fontSize: 13, color: GRAY, minWidth: 24 }}>to</label>
          <input id="refill-history-to" type="date" max={todayStr} value={custom.to || custom.from || todayStr}
                 onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                 style={{ ...input, minHeight: 44, colorScheme: "dark", flex: "1 1 140px" }} />
        </div>
      )}

      {/* ── WHERE ── */}
      <div style={ROW_WRAP}>
        {LOC_GROUPS.map((g) => (
          <button key={g.key} type="button" aria-pressed={groups.includes(g.key)}
                  onClick={() => toggleGroup(g.key)} style={chip(groups.includes(g.key))}>{g.label}</button>
        ))}
        <button type="button" aria-pressed={groups.length === ALL_GROUP_KEYS.length}
                onClick={() => setGroups(ALL_GROUP_KEYS)} style={chip(groups.length === ALL_GROUP_KEYS.length)}>All</button>
      </div>

      <div style={{ fontSize: 12.5, color: GRAY, margin: "0 2px 12px", lineHeight: 1.5 }}>
        {range.fromDay === range.toDay ? range.fromDay : `${range.fromDay} → ${range.toDay}`}
        {" · "}{range.days} day{range.days === 1 ? "" : "s"} · SA time
        {" · "}Open shows everything still waiting, whatever its raise date
        {!REQUESTS_INDEXED && (
          <span style={{ color: AMBER }}>
            {" · "}movements are date-ranged; request outcomes are filtered after a full read
            of /refill_requests, because that node has no date index yet.
          </span>
        )}
      </div>

      {/* ── TOTALS — every tile opens its rows ── */}
      {!loading && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 9, marginBottom: 16 }}>
          {tileKeys.map((s) => (
            <Tile key={s} label={STATUS_LABEL[s]} explain={STATUS_EXPLAIN[s]}
                  count={totals[s].rows} units={totals[s].units} tone={TONE[s]}
                  on={drill === s} onClick={() => setDrill(drill === s ? null : s)} />
          ))}
          {["display_in", "display_out"].map((s) => (
            totals[s].rows ? (
              <Tile key={s} label={KIND_LABEL[s]} explain={STATUS_EXPLAIN[s]}
                    count={totals[s].rows} units={totals[s].units} tone={TONE[s]}
                    on={drill === s} onClick={() => setDrill(drill === s ? null : s)} />
            ) : null
          ))}
        </div>
      )}

      {mvError && <div style={{ ...GLASS, padding: 14, color: AMBER, fontSize: 13, marginBottom: 12 }}>Movements didn&rsquo;t load ({mvError}). Request outcomes below are still accurate; the physical-move rows are missing.</div>}
      {rrError && <div style={{ ...GLASS, padding: 14, color: AMBER, fontSize: 13, marginBottom: 12 }}>Request outcomes didn&rsquo;t load ({rrError}). If the date index was just added, reload.</div>}

      {drill && !loading && (
        <div style={{ fontSize: 13.5, fontWeight: 700, color: TONE[drill], margin: "0 2px 10px" }}>
          {KIND_LABEL[drill] || STATUS_LABEL[drill]} — {shown.length} row{shown.length === 1 ? "" : "s"}.{" "}
          <button type="button" onClick={() => setDrill(null)}
                  style={{ border: 0, background: "transparent", color: GRAY, cursor: "pointer", fontSize: 13, fontFamily: FONT, textDecoration: "underline", padding: "6px 4px" }}>
            Show everything
          </button>
        </div>
      )}

      {loading ? (
        <div style={{ ...GLASS, padding: 18, color: GRAY, fontSize: 14 }}>Loading&hellip;</div>
      ) : shown.length === 0 ? (
        <div style={{ ...GLASS, padding: 18, color: GRAY, fontSize: 14 }}>
          {drill
            ? `Nothing under “${KIND_LABEL[drill] || STATUS_LABEL[drill]}” here.`
            : `No refill activity at ${LOC_GROUPS.filter((g) => groups.includes(g.key)).map((g) => g.label).join(" or ")} in this range.`}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {byDay.map((day) => (
            <React.Fragment key={day.day}>
              {/* One heading per SA day — the visual seam between days. */}
              <div style={{ fontSize: 13, fontWeight: 800, color: "rgba(255,255,255,.55)", letterSpacing: ".04em", textTransform: "uppercase", margin: "14px 2px 2px", paddingBottom: 6, borderBottom: "1px solid rgba(255,255,255,.09)" }}>
                {day.day === todayStr ? "Today" : fmtDay(day.day)}
                <span style={{ color: "rgba(255,255,255,.3)", fontWeight: 600, textTransform: "none", letterSpacing: 0 }}> · {day.rows.length} row{day.rows.length === 1 ? "" : "s"}</span>
              </div>
              {day.rows.map((r) => {
                const p = byId.get(r.productId);
                const tone = TONE[bucketOf(r)] || GRAY;
                const label = KIND_LABEL[r.kind] || STATUS_LABEL[r.status] || r.status;
                const qty = r.movedQty ?? r.qty;
                return (
                  <div key={r.key} style={{ ...GLASS, padding: "14px 15px", borderColor: `${tone}33` }}>
                    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      {p?.photoUrl
                        ? <img src={p.photoUrl} alt="" style={{ width: 48, height: 48, borderRadius: 9, objectFit: "cover", flexShrink: 0 }} />
                        : <span style={{ width: 48, height: 48, borderRadius: 9, background: "rgba(255,255,255,.05)", flexShrink: 0 }} />}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 15.5, fontWeight: 700, color: "#fff", lineHeight: 1.3, overflowWrap: "anywhere" }}>
                          {p?.name || r.productId}
                        </div>
                        <div style={{ fontSize: 14.5, color: "rgba(255,255,255,.85)", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
                          size <b>{r.size || "—"}</b> · <b>×{qty}</b>
                        </div>
                        {/* SOURCE → DESTINATION, always stated. "Which location
                            supplied this" is the question a hub actually asks. */}
                        <div style={{ fontSize: 13.5, color: GRAY, marginTop: 4 }}>
                          {loc(r.source)} <span aria-hidden>→</span> {loc(r.dest)}
                        </div>
                        <div style={{ fontSize: 12.5, color: GRAY, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
                          {fmtTime(r.ts)}
                          {r.raisedMs && r.resolvedMs && r.raisedMs !== r.ts ? ` · raised ${fmtTime(r.raisedMs)}` : ""}
                        </div>
                      </div>
                      <span style={{
                        flexShrink: 0, fontSize: 12.5, fontWeight: 800, color: tone,
                        border: `1px solid ${tone}55`, background: `${tone}14`,
                        borderRadius: 999, padding: "7px 12px", whiteSpace: "nowrap",
                      }}>{label}</span>
                    </div>
                    {/* WHY and WHO — a rejection with no reason and no name is the
                        thing this whole view was built to stop. */}
                    {(r.reason || r.actorUid || r.actorRole || r.byEngine || r.auto || r.uncounted || r.via) && (
                      <div style={{ fontSize: 12.5, color: GRAY, marginTop: 10, lineHeight: 1.55, borderTop: "1px solid rgba(255,255,255,.06)", paddingTop: 9 }}>
                        {r.status === "rejected" && <span style={{ color: RED, fontWeight: 700 }}>Rejected — marked not available on the shelf. </span>}
                        {r.reason && <span>{REASON_TEXT[r.reason] || r.reason}. </span>}
                        {/* A PERSON, or the engine — never one labelled as the other.
                            A human actor always wins: `byEngine` is only true for a
                            self-withdrawal, which by construction has no human on it. */}
                        {(r.actorUid || r.actorRole) ? (
                          <span>by <b style={{ color: "rgba(255,255,255,.8)" }}>{r.actorRole || "staff"}</b>
                            {r.actorUid ? ` (${String(r.actorUid).slice(0, 8)})` : ""}. </span>
                        ) : r.byEngine ? (
                          <span>Withdrawn by <b style={{ color: "rgba(255,255,255,.8)" }}>the engine</b>. </span>
                        ) : null}
                        {r.auto && !r.reason && <span>Raised automatically. </span>}
                        {r.via === "missing_sneakers" && <span>Raised from Missing Sneakers (policy quantity). </span>}
                        {r.via === "missing_sneakers_pick" && <span>Raised from Missing Sneakers (operator chose the sizes). </span>}
                        {r.uncounted && <span style={{ color: AMBER }}>Sent uncounted — added at the hub with no deduction. </span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
