// ─── BLACK FRIDAY 2026 — Junid's card (v3, 19 Nov evening) ───────────────────
// One row per product. Three tabs: New Arrivals, To review and Approved.
// NEW ARRIVALS (20 Nov) = the New Arrivals queue itself (past 20 days, any
// quantity, no paper bags): its taps are New Arrivals' own approvals, so
// approving here or on the New Arrivals card is ONE approval; its photos are
// made by New Arrivals' own studio. Approved splits New Arrivals / Normal and
// keeps every product after posting ("Posted n× · last …"); Repost queues the
// ticked ones for the next slot — nothing reposts by itself. MAIN = 13 or more on
// hand: every 30+ product first (with "Approve all 30+"), then 13–29. "Show
// under 13" adds the rest. Per product: Approve, Reject, Use current photo,
// Generate / Regenerate. Reject removes it (and it stays rejected); undo from
// the small "Rejected (n)" link at the bottom. Grouping into albums happens
// only when posting. NOTHING POSTS until Junid confirms a schedule ("Schedule
// posting" on the Approved tab). Only the STOCK price is ever shown.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { setUpdateBusy } from "../../update/updateChecker";
import { FONT, BG, GLASS, GREEN, GRAY, AMBER, RED, BLUE_L, bGreen, bGray, bBlue } from "../stock/ui";

const KIND = { sneakers: "Sneakers", clothing: "Clothing", headwear: "Caps & beanies", perfume: "Perfume", bags: "Bags", belts: "Belts", sunglasses: "Sunglasses", watches: "Watches", jewellery: "Chains & bracelets", accessories: "Accessories" };
const PAGE = 60;
const UNDO_MS = 6000;
const BAR_H = 64;            // the selection bar
const BULK_CHUNK = 100;      // a bulk action goes to the server this many at a time, with progress
const SAVE_MS = 400;         // the selection is saved this long after the last tick
const BOTTOM_ROOM = 64 + 80; // bar + toast: the last row always stays clear of both
const rand = (n) => `R${(Number(n) || 0).toFixed(2)}`;
const price = (p) => (Number.isInteger(Number(p)) ? `R${Number(p)}` : `R${Number(p).toFixed(2)}`);

/**
 * Which buttons a product offers. Pure.
 * Approve is never greyed out on a generated photo (only while one is being made).
 * A kind whose AI look Junid has not approved yet offers "Use current photo" as the
 * safe default, with Generate still there.
 */
export function rowActions(r) {
  const na = r.tab === "newArrivals";
  const review = r.tab === "review" || na;
  const canGen = r.canGenerate !== false;
  return {
    approve: review,
    approveDisabled: !!r.generating,
    reject: true,
    backToReview: !review,
    // A New Arrival: "Use current photo" approves it with the app's photo (New Arrivals' own button).
    useCurrent: na ? true : r.use === "generated" || !r.styleApproved,
    useCurrentPrimary: na ? !r.generatedUrl : !r.styleApproved && r.use !== "generated",
    useAi: !na && r.use === "current" && !!r.generatedUrl,
    generate: review && canGen && !r.generations,
    regenerate: review && canGen && r.generations > 0,
    approveLook: !na && !r.styleApproved && r.generations > 0,
  };
}
const dayLabel = (ms) => (ms ? new Date(ms).toLocaleDateString("en-ZA", { day: "numeric", month: "short", timeZone: "Africa/Johannesburg" }) : "");

// Long-press (iPhone Safari, Chrome, a mouse held down): 500 ms opens the quick popup.
const LONG_PRESS_MS = 500;
const MOVE_PX = 10;           // a finger that moves more than this is scrolling, not pressing
const SWALLOW_MS = 700;       // the click that follows a long-press is swallowed
export function useLongPress(onLong) {
  const timer = useRef(null);
  const firedAt = useRef(0);
  const lastTouch = useRef(0);
  const origin = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const fire = () => { firedAt.current = Date.now(); onLong(); };
  // A press that starts on a button is that button's tap — never a long-press.
  const onButton = (e) => !!(e && e.target && e.target.closest && e.target.closest("button"));
  const start = (e, x, y) => { if (onButton(e)) return; origin.current = { x, y }; clearTimeout(timer.current); timer.current = setTimeout(fire, LONG_PRESS_MS); };
  const stop = () => clearTimeout(timer.current);
  return {
    onTouchStart: (e) => { lastTouch.current = Date.now(); const t = e.touches && e.touches[0]; start(e, t ? t.clientX : 0, t ? t.clientY : 0); },
    onTouchMove: (e) => { const t = e.touches && e.touches[0]; if (!t || !origin.current || Math.hypot(t.clientX - origin.current.x, t.clientY - origin.current.y) > MOVE_PX) stop(); },
    onTouchEnd: (e) => { stop(); if (Date.now() - firedAt.current < SWALLOW_MS && e.cancelable) e.preventDefault(); },
    onTouchCancel: stop,
    // A mouse held down (desktop); the mouse events a phone emulates after a touch are ignored.
    onMouseDown: (e) => { if (Date.now() - lastTouch.current > 800) start(e, e.clientX, e.clientY); },
    onMouseUp: stop, onMouseLeave: stop,
    // The phone's own image menu (save / share / copy) never opens on a product.
    onContextMenu: (e) => { e.preventDefault(); if (onButton(e)) return; if (Date.now() - firedAt.current > SWALLOW_MS) fire(); },
    wasLong: () => Date.now() - firedAt.current < SWALLOW_MS,
  };
}
// No callout, no selection, no drag on product photos (iPhone's image menu suppressed).
const NO_CALLOUT = { WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" };

function Row({ r, busy, gen, on, selectMode, selected }) {
  const a = rowActions(r);
  const sm = { ...bGray, padding: "4px 8px", fontSize: 11, minHeight: 28 };
  const lp = useLongPress(() => on.longPress(r));
  const { wasLong, ...press } = lp;
  return (
    <div data-testid={`row-${r.pid}`} {...press} onClick={() => { if (selectMode && !wasLong()) on.toggle(r); }}
      style={{ display: "flex", gap: 10, padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,.06)", ...NO_CALLOUT, ...(selectMode ? { cursor: "pointer", background: selected ? "rgba(74,127,255,.18)" : "transparent" } : {}) }}>
      {selectMode && <div data-testid={`sel-${r.pid}`} aria-checked={!!selected} role="checkbox" style={{ flex: "0 0 22px", alignSelf: "center", width: 22, height: 22, borderRadius: 6, border: `2px solid ${selected ? BLUE_L : GRAY}`, background: selected ? BLUE_L : "transparent", color: "#000", textAlign: "center", lineHeight: "18px", fontWeight: 800 }}>{selected ? "✓" : ""}</div>}
      <div style={{ position: "relative", width: 72, height: 96, flex: "0 0 72px", borderRadius: 8, overflow: "hidden", background: "#0b0d12", ...NO_CALLOUT }}>
        {r.shown && <img src={r.shown} alt={r.name} loading="lazy" draggable={false} onContextMenu={(e) => e.preventDefault()} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", pointerEvents: "none", ...NO_CALLOUT }} />}
        {r.use === "generated" && <span style={{ position: "absolute", top: 3, right: 3, background: BLUE_L, color: "#000", borderRadius: 5, padding: "0 4px", fontSize: 9, fontWeight: 700 }}>AI</span>}
        {gen && <div data-testid={`gen-${r.pid}`} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.7)", display: "flex", alignItems: "center", justifyContent: "center", padding: 4, fontSize: 10, textAlign: "center" }}>{gen}</div>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</div>
        <div style={{ fontSize: 12, color: "#dfe7ff" }}>{price(r.price)} · {r.qty ? `${r.qty} on hand` : "stock checked at posting"}{r.na && !r.uploadedAt ? " · New" : ""}</div>
        {r.uploadedAt && <div data-testid={`uploaded-${r.pid}`} style={{ fontSize: 11, color: GRAY }}>Uploaded {dayLabel(r.uploadedAt)}</div>}
        <div style={{ fontSize: 11, color: GRAY, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.sizes}</div>
        {r.changedSinceApproval && <div style={{ fontSize: 11, color: AMBER }}>Photo changed — approve again</div>}
        {r.failed && !gen && !r.generating && <button data-testid={`failed-${r.pid}`} onClick={(e) => { e.stopPropagation(); on.generate(r); }} title={r.failed.reason} style={{ background: "none", border: "none", padding: 0, color: RED, fontSize: 11, textAlign: "left", cursor: "pointer", textDecoration: "underline" }}>Failed, tap to retry</button>}
        {r.postedN > 0 ? <div data-testid={`posted-${r.pid}`} style={{ fontSize: 11, color: GREEN }}>Posted {r.postedN}× · last {dayLabel(r.postedLast)}</div>
          : r.posted ? <div style={{ fontSize: 11, color: GREEN }}>Posted</div> : null}
        {r.repostQueued && <div data-testid={`repost-queued-${r.pid}`} style={{ fontSize: 11, color: BLUE_L }}>Repost queued for the next slot</div>}
        {!selectMode && <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
          {a.approve && <button data-testid={`approve-${r.pid}`} disabled={busy || a.approveDisabled} onClick={() => on.approve(r)} style={{ ...bGreen, padding: "4px 10px", fontSize: 11, minHeight: 28 }}>Approve</button>}
          {a.backToReview && <button data-testid={`back-${r.pid}`} disabled={busy} onClick={() => on.reset(r)} style={sm}>Back to review</button>}
          <button data-testid={`reject-${r.pid}`} disabled={busy} onClick={() => on.reject(r)} style={{ ...sm, color: RED }}>Reject</button>
          {a.useCurrent && <button data-testid={`use-current-${r.pid}`} disabled={busy} onClick={() => on.use(r, "current")} style={a.useCurrentPrimary ? { ...bBlue, padding: "4px 8px", fontSize: 11, minHeight: 28 } : sm}>Use current photo</button>}
          {a.useAi && <button data-testid={`use-ai-${r.pid}`} disabled={busy} onClick={() => on.use(r, "generated")} style={sm}>Use AI photo</button>}
          {(a.generate || a.regenerate) && <button data-testid={`generate-${r.pid}`} disabled={!!gen || r.generating} onClick={() => on.generate(r)} style={r.styleApproved && a.generate ? { ...bBlue, padding: "4px 8px", fontSize: 11, minHeight: 28 } : sm}>{a.regenerate ? "Regenerate" : "Generate"}</button>}
          {a.approveLook && <button data-testid={`look-${r.pid}`} disabled={busy} onClick={() => on.approveLook(r)} style={sm}>Approve the AI look for {KIND[r.kind] || r.kind}</button>}
        </div>}
      </div>
    </div>
  );
}

function Block({ title, rows, testid, children, ...rest }) {
  const [n, setN] = useState(PAGE);
  if (!rows.length) return null;
  return (
    <div data-testid={testid} style={{ ...GLASS, padding: "8px 12px", marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
        <div style={{ fontSize: 13, fontWeight: 800, flex: 1 }}>{title} ({rows.length})</div>
        {children}
      </div>
      {rows.slice(0, n).map((r) => <Row key={r.pid} r={r} {...rest} gen={rest.gens[r.pid]} selected={rest.selected && rest.selected.has(r.pid)} />)}
      {rows.length > n && <button onClick={() => setN(n + PAGE)} style={{ ...bGray, margin: "8px 0", padding: "6px 10px", fontSize: 12 }}>Show {Math.min(PAGE, rows.length - n)} more</button>}
    </div>
  );
}


const pct = (x) => (x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`);
/** The posting brain: today's slots and the next days, posted / remaining, the Best times chart, Pause. */
export function BrainPanel({ brain, api, busy, run }) {
  const [editing, setEditing] = useState(null); // "day|i"
  if (!brain) return <div data-testid="brain" style={{ ...GLASS, padding: 12, marginBottom: 12, fontSize: 12, color: GRAY }}>The posting brain has not reported yet.</div>;
  const days = Object.entries(brain.days || {});
  const hours = brain.hours || [];
  const maxScore = Math.max(0.01, ...hours.map((h) => h.score || 0));
  return (
    <div data-testid="brain" style={{ ...GLASS, padding: 12, marginBottom: 12, fontSize: 13 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <div style={{ flex: 1, fontWeight: 800 }}>Posting plan {brain.paused && <span data-testid="brain-paused" style={{ color: AMBER, fontWeight: 700 }}>· paused</span>}</div>
        <button data-testid="brain-pause" disabled={busy} onClick={() => run(() => api.brainPause(!brain.paused), { reload: true })} style={{ ...(brain.paused ? bGreen : bGray), padding: "6px 12px", fontSize: 12, color: brain.paused ? undefined : AMBER }}>{brain.paused ? "Resume" : "Pause"}</button>
      </div>
      <div data-testid="brain-counts" style={{ fontSize: 12, color: "#dfe7ff", marginBottom: 8 }}>Posted {brain.posted} · Remaining {brain.remaining} · Held for Friday {brain.reserved} · New Arrivals {brain.newArrivals} · Today {brain.todayPhotos}/{brain.cap} photos</div>
      {days.map(([day, slots], di) => (
        <div key={day} data-testid={`brain-day-${day}`} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: di === 0 ? "#fff" : GRAY }}>{di === 0 ? "Today / next" : day}</div>
          {slots.map((sl) => {
            const k = `${day}|${sl.i}`;
            return (
              <div key={k} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12, padding: "3px 0", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
                {editing === k
                  ? <input data-testid={`slot-time-${k}`} type="time" min="07:00" max="21:30" step="900" defaultValue={sl.at} onBlur={(e) => { setEditing(null); if (e.target.value && e.target.value !== sl.at) run(() => api.brainSlot(day, sl.i, e.target.value), { reload: true }); }} style={{ width: 92 }} autoFocus />
                  : <button data-testid={`slot-${k}`} disabled={busy || sl.status === "done"} onClick={() => setEditing(k)} title="Move this slot" style={{ ...bGray, padding: "2px 8px", fontSize: 12, minWidth: 64 }}>{sl.at}</button>}
                <div style={{ flex: 1 }}>
                  <b>{sl.size}</b> photos{sl.status === "done" ? " ✓" : ""} — {Object.entries(sl.byKind || {}).map(([kk, n]) => `${KIND[kk] || kk} ${n}`).join(", ") || "nothing left"}
                  <div style={{ fontSize: 10, color: GRAY }}>{sl.why}{(brain.overrides?.[day] || {})[sl.i] ? <> · <button onClick={() => run(() => api.brainSlot(day, sl.i, null), { reload: true })} style={{ background: "none", border: "none", color: BLUE_L, padding: 0, fontSize: 10, cursor: "pointer" }}>back to the brain's time</button></> : null}</div>
                </div>
              </div>
            );
          })}
        </div>
      ))}
      <div style={{ fontSize: 12, fontWeight: 700, margin: "10px 0 4px" }}>Best times</div>
      {hours.length === 0
        ? <div data-testid="best-times-empty" style={{ fontSize: 11, color: GRAY }}>Read receipts come in after the first posts; the chart fills as they do.</div>
        : <div data-testid="best-times" role="img" aria-label="Read speed and replies by hour of day">
          {hours.map((h) => (
            <div key={h.hour} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, margin: "2px 0" }}>
              <div style={{ width: 40, color: GRAY }}>{String(h.hour).padStart(2, "0")}:00</div>
              <div style={{ flex: 1, background: "rgba(255,255,255,.06)", borderRadius: 4, height: 12 }}>
                <div style={{ width: `${Math.round(((h.score || 0) / maxScore) * 100)}%`, background: BLUE_L, height: 12, borderRadius: 4 }} />
              </div>
              <div style={{ width: 150, textAlign: "right" }}>{pct(h.r60)} in 1 h · {h.medianMin ?? "–"} min · {(h.answersPer100 || 0).toFixed(1)}/100</div>
            </div>
          ))}
          <div style={{ fontSize: 10, color: GRAY, marginTop: 2 }}>Bar = read speed and replies. % of members who read within 1 h (receipts off left out) · median minutes to read · replies + reactions per 100 members.</div>
        </div>}
    </div>
  );
}

export default function BlackFridayScreen({ api, onExit }) {
  const [main, setMain] = useState(null);
  const [under, setUnder] = useState(null);
  const [showUnder, setShowUnder] = useState(false);
  // Opens on New Arrivals when any are waiting, else on To review.
  const [tabPicked, setTab] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [gens, setGens] = useState({});
  const [showRejected, setShowRejected] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Map()); // pid → row
  const [toast, setToast] = useState(null); // { text, undo }
  const [quick, setQuick] = useState(null); // the long-pressed row
  const [progress, setProgress] = useState(null); // "Approving 230/574" while a bulk action runs
  const [selSaved, setSelSaved] = useState(true); // false while a save is pending or failed
  const [selLabel, setSelLabel] = useState(null); // e.g. "Recovered selection": shown on its own, pre-ticked
  const [onlySel, setOnlySel] = useState(false);
  const restored = useRef(false); // the saved selection has been put back (never saved over before that)
  const toastTimer = useRef(null);
  const tab = tabPicked || (main && main.newArrivals && main.newArrivals.length ? "newArrivals" : "review");
  // Chosen once, on the first load: approving the last New Arrival never flips the screen to another tab.
  useEffect(() => { if (main && !tabPicked) setTab(tab); }, [main]); // eslint-disable-line react-hooks/exhaustive-deps
  // Every Approve, Reject and bulk action: a toast with Undo for 6 seconds that fully reverses it.
  const showToast = (text, undo) => {
    clearTimeout(toastTimer.current);
    setToast({ text, undo });
    toastTimer.current = setTimeout(() => setToast(null), UNDO_MS);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const ticket = useRef(0);
  const load = useCallback(() => {
    const t = ++ticket.current;
    return api.list("main").then((d) => { if (t === ticket.current) { setMain(d); setError(null); } }, (e) => { if (t === ticket.current) setError(e?.message || String(e)); });
  }, [api]);
  const underTicket = useRef(0);
  const loadUnder = useCallback(() => {
    const t = ++underTicket.current;
    return api.list("under").then((d) => { if (t === underTicket.current) setUnder(d); }, (e) => setNote(e?.message || String(e)));
  }, [api]);
  useEffect(() => { load(); }, [load]);
  // A refresh, crash or deploy never loses the ticks: the saved selection comes back on load.
  useEffect(() => {
    if (restored.current || !main) return;
    restored.current = true;
    const saved = main.selection && main.selection.sigs ? main.selection.sigs : null;
    if (!saved || !Object.keys(saved).length) return;
    const rows = new Map([...(main.newArrivals || []), ...(main.review || []), ...(main.approved || [])].map((r) => [r.pid, { ...r, section: "main" }]));
    const m = new Map();
    for (const [pid, sig] of Object.entries(saved)) m.set(pid, { ...(rows.get(pid) || { pid, name: pid }), sig });
    setSelected(m);
    setSelectMode(true);
    // Back on the tab that holds the ticks (a recovered selection is shown on To review).
    const naPids = new Set((main.newArrivals || []).map((r) => r.pid));
    const allNa = [...m.keys()].every((pid) => naPids.has(pid));
    setTab(allNa && !main.selection.label ? "newArrivals" : (main.approved || []).some((r) => m.has(r.pid)) && ![...m.keys()].some((pid) => (main.review || []).some((r) => r.pid === pid) || naPids.has(pid)) ? "approved" : "review");
    if (main.selection.label) { setSelLabel(main.selection.label); setOnlySel(true); }
    else setNote(`${m.size} selected — your selection was kept`);
  }, [main]);
  useEffect(() => { if (showUnder && !under) loadUnder(); }, [showUnder, under, loadUnder]);

  // A tap answers with the product's new row: it moves between tabs (or leaves, if rejected) at once.
  const patch = (pid, row, rejected) => {
    const fix = (d) => {
      if (!d) return d;
      const nas = d.newArrivals || [];
      const inThis = [...nas, ...d.review, ...d.approved].some((x) => x.pid === pid);
      if (!inThis) return d;
      const rest = (list) => list.filter((x) => x.pid !== pid);
      const review = rest(d.review), approved = rest(d.approved), newArrivals = rest(nas);
      if (!rejected && row) (row.tab === "approved" ? approved : row.tab === "newArrivals" ? newArrivals : review).push(row);
      const order = (l) => l.sort((x, y) => (Number(y.big) - Number(x.big)) || (y.qty - x.qty) || String(x.name).localeCompare(String(y.name)));
      newArrivals.sort((x, y) => (y.uploadedAt || 0) - (x.uploadedAt || 0));
      return { ...d, newArrivals, review: order(review), approved: order(approved) };
    };
    setMain(fix); setUnder(fix);
  };
  const run = async (fn, { reload = false, undo = null } = {}) => {
    setBusy(true); setNote(null);
    try {
      const r = await fn();
      if (r && r.ok === false) setNote(r.refusal);
      else {
        if (r && r.pid) patch(r.pid, r.row, r.rejected);
        if (undo) { const u = undo(r); if (u) showToast(u.text, u.reverse); }
      }
      // The row was patched in place; only the main view (totals, Approved tab) is re-read — never the long under-13 list.
      if (reload || (r && r.pid)) load();
      if (reload && showUnder) loadUnder();
    } catch (e) { setNote(e?.message || String(e)); load(); }
    finally { setBusy(false); }
  };
  // Undo puts each product back to exactly what it was (and refuses one that changed since).
  const undoWith = (items) => () => {
    setToast(null);
    run(async () => { const r = await api.undo(items); if (r && r.refused && r.refused.length) setNote(`${r.refused.length} not undone — changed since`); return { ok: true }; }, { reload: true });
  };
  const sigOfRow = (r) => r.sig || (r.use === "generated" ? r.genId : "current");
  // Never auto-reloaded onto a new deploy while anything is ticked or a bulk action runs (a deploy once wiped 574 ticks).
  useEffect(() => { setUpdateBusy("bf-selection", selected.size > 0 || !!progress); }, [selected, progress]);
  useEffect(() => () => setUpdateBusy("bf-selection", false), []);
  const saveTimer = useRef(null);
  useEffect(() => {
    if (!restored.current || !api.selSave) return undefined;
    setSelSaved(false);
    const sigs = Object.fromEntries([...selected.values()].map((r) => [r.pid, sigOfRow(r)]));
    let stop = false;
    const save = (wait) => { saveTimer.current = setTimeout(() => {
      api.selSave(sigs, selected.size ? selLabel : null).then(() => { if (!stop) setSelSaved(true); }, () => { if (!stop) save(5000); });
    }, wait); };
    save(SAVE_MS);
    return () => { stop = true; clearTimeout(saveTimer.current); };
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  const generate = async (r) => {
    setGens((x) => ({ ...x, [r.pid]: "Starting…" }));
    // A New Arrival's photo is made by New Arrivals' own studio, on the New Arrivals item.
    const make = r.tab === "newArrivals" && api.generateNa ? (pid, _s, o) => api.generateNa(pid, o) : api.generate;
    try { await make(r.pid, r.section, { onEvent: (ev) => { if (ev && ev.text) setGens((x) => ({ ...x, [r.pid]: String(ev.text).slice(0, 80) })); } }); }
    catch (e) { setNote(`${r.name}: ${e?.message || String(e)}`); }
    setGens((x) => { const n = { ...x }; delete n[r.pid]; return n; });
    load(); if (showUnder) loadUnder();
  };
  const sec = (s) => (r) => ({ ...r, section: s });
  const on = {
    approve: (r) => run(() => api.approve(r.pid, r.section, sigOfRow(r)), { undo: (x) => (x && x.undo ? { text: `Approved ${r.name}`, reverse: undoWith(x.undo) } : null) }),
    reject: (r) => run(() => api.reject(r.pid, r.section), { undo: (x) => (x && x.undo ? { text: `Rejected ${r.name}`, reverse: undoWith(x.undo) } : null) }),
    reset: (r) => run(() => api.reset(r.pid)),
    // A New Arrival: "Use current photo" approves it with the app's photo, as on the New Arrivals card (with Undo).
    use: (r, use) => (r.tab === "newArrivals" && use === "current"
      ? run(() => api.approve(r.pid, r.section, "current"), { undo: (x) => (x && x.undo ? { text: `Approved ${r.name} (current photo)`, reverse: undoWith(x.undo) } : null) })
      : run(() => api.use(r.pid, use, use === "generated" ? r.genId : null, r.section))),
    generate,
    approveLook: (r) => run(() => api.approveStyle(r.kind), { reload: true }),
    toggle: (r) => setSelected((m) => { const n = new Map(m); if (n.has(r.pid)) n.delete(r.pid); else n.set(r.pid, r); return n; }),
    longPress: (r) => setQuick(r),
  };
  // ── multi-select ───────────────────────────────────────────────────────────
  const picked = [...selected.values()];
  const clearSel = () => { setSelected(new Map()); setSelLabel(null); setOnlySel(false); };
  useEffect(() => { if (!selected.size && selLabel && !progress) { setSelLabel(null); setOnlySel(false); } }, [selected, selLabel, progress]);
  // A bulk action, BULK_CHUNK at a time with progress ("Approving 230/574"). Only what the server confirmed
  // leaves the selection; on any failure the rest stays selected and the card says what failed — never silent.
  // Undo gets every product's entry from every chunk.
  const bulk = async ({ ing, ed, button, call }) => {
    const rows = [...selected.values()];
    const total = rows.length;
    const names = new Map(rows.map((r) => [r.pid, r.name || r.pid]));
    const undo = {}, refused = [];
    let doneN = 0, through = 0, failure = null;
    setBusy(true); setNote(null); setProgress(`${ing} 0/${total}`);
    try {
      for (let i = 0; i < total; i += BULK_CHUNK) {
        const part = rows.slice(i, i + BULK_CHUNK);
        let r;
        try { r = await call(part); } catch (e) { failure = e?.message || String(e); break; }
        if (!r || r.ok === false) { failure = (r && r.refusal) || "no answer from the server"; break; }
        const no = new Set((r.refused || []).map((x) => x.pid));
        refused.push(...(r.refused || []));
        Object.assign(undo, r.undo || {});
        doneN += (r.done || []).length;
        through += part.length;
        setSelected((m) => { const n = new Map(m); for (const row of part) if (!no.has(row.pid)) n.delete(row.pid); return n; });
        setProgress(`${ing} ${through}/${total}`);
      }
    } finally { setBusy(false); setProgress(null); }
    const say = [];
    if (failure) say.push(`${ed} ${doneN} of ${total}, then it stopped: ${failure}. The other ${total - through} are still selected — tap ${button} again.`);
    if (refused.length) say.push(`${refused.length} not ${ed.toLowerCase()} (still selected): ${refused.slice(0, 8).map((y) => `${names.get(y.pid) || y.pid}: ${y.refusal}`).join(" · ")}${refused.length > 8 ? " …" : ""}`);
    if (say.length) setNote(say.join(" "));
    if (Object.keys(undo).length) showToast(`${ed} ${doneN}`, undoWith(undo));
    load(); if (showUnder) loadUnder();
  };
  const bulkApprove = () => bulk({ ing: "Approving", ed: "Approved", button: "Approve", call: (part) => api.approveMany(Object.fromEntries(part.map((r) => [r.pid, sigOfRow(r)]))) });
  const bulkRepost = () => bulk({ ing: "Queuing", ed: "Queued for repost", button: "Repost", call: (part) => api.repost(part.map((r) => r.pid)).then((r) => (r && r.ok ? { ...r, undo: {} } : r)) });
  const bulkReject = () => bulk({ ing: "Rejecting", ed: "Rejected", button: "Reject", call: (part) => api.rejectMany(part.map((r) => r.pid)) });
  // Generate for every selected product: queued, two at a time; AI spend updates as each lands.
  const bulkGenerate = async () => {
    // Never the same product twice: skip any already queued or being made.
    const queue = picked.filter((r) => !gens[r.pid] && !r.generating && r.canGenerate !== false);
    clearSel();
    setGens((g) => ({ ...g, ...Object.fromEntries(queue.map((r) => [r.pid, "Queued…"])) }));
    const worker = async () => { while (queue.length) { await generate(queue.shift()); } };
    await Promise.all([worker(), worker()]);
  };

  const d = main;
  const t = d?.totals || {};
  const allMain = d ? (tab === "newArrivals" ? (d.newArrivals || []) : tab === "review" ? d.review : d.approved).map(sec("main")) : [];
  // The recovered selection on its own: only its rows, so mistakes are easy to untick.
  const mainRows = onlySel && selLabel && selected.size ? allMain.filter((r) => selected.has(r.pid)) : allMain;
  // The Approved tab comes from the main view, which already carries every under-13 approval.
  const underRows = showUnder && under && tab === "review" ? under.review.map(sec("under")) : [];
  const big = tab === "review" ? mainRows.filter((r) => r.big) : [], mid = tab === "review" ? mainRows.filter((r) => !r.big) : [];
  const naRows = tab === "newArrivals" ? mainRows : [];
  const apprNa = tab === "approved" ? mainRows.filter((r) => r.na) : [], apprNormal = tab === "approved" ? mainRows.filter((r) => !r.na) : [];
  const bigToReview = d ? d.review.filter((r) => r.big).length : 0;
  const nReview = t.review ?? 0;
  const nApproved = d?.approved.length || 0;
  const nNew = t.newArrivals ?? (d?.newArrivals || []).length;
  const shared = { busy, gens, on, selectMode, selected };
  return (
    // Bottom padding: the selection bar and the Undo toast never cover the last row.
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT, padding: `14px 14px ${BOTTOM_ROOM}px`, paddingBottom: `calc(${BOTTOM_ROOM}px + env(safe-area-inset-bottom))` }}>
      <div style={{ maxWidth: 680, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <button onClick={onExit} style={{ ...bGray, minHeight: 40, padding: "0 12px" }} aria-label="Back">←</button>
          <div style={{ fontSize: 20, fontWeight: 800, flex: 1 }}>Black Friday 🔥</div>
          <button data-testid="refresh" disabled={busy} onClick={() => { load(); if (showUnder) loadUnder(); }} style={{ ...bGray, minHeight: 40, padding: "0 12px" }} aria-label="Refresh">↻</button>
        </div>
        {error && <div data-testid="error" style={{ color: RED, fontSize: 13, marginBottom: 12 }}>{error} <button onClick={load} style={{ ...bGray, padding: "4px 8px", fontSize: 12 }}>Retry</button></div>}
        {!d && !error && <div style={{ color: GRAY }}>Loading…</div>}
        {d && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <div data-testid="totals" style={{ fontSize: 13, color: "#dfe7ff", flex: 1 }}>To review {t.review} · Approved {t.approved} · AI spend {rand(t.spentZar)}</div>
              <button data-testid="select-toggle" aria-pressed={selectMode} onClick={() => { setSelectMode(!selectMode); clearSel(); }} style={{ ...(selectMode ? bBlue : bGray), padding: "6px 12px", fontSize: 12 }}>{selectMode ? "Done" : "Select"}</button>
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              <button data-testid="tab-new" aria-pressed={tab === "newArrivals"} onClick={() => { setTab("newArrivals"); clearSel(); }} style={{ ...(tab === "newArrivals" ? bBlue : bGray), flex: 1, padding: "8px 4px", fontSize: 13 }}>New Arrivals ({nNew})</button>
              <button data-testid="tab-review" aria-pressed={tab === "review"} onClick={() => { setTab("review"); clearSel(); }} style={{ ...(tab === "review" ? bBlue : bGray), flex: 1, padding: "8px 4px", fontSize: 13 }}>To review ({nReview})</button>
              <button data-testid="tab-approved" aria-pressed={tab === "approved"} onClick={() => { setTab("approved"); clearSel(); }} style={{ ...(tab === "approved" ? bBlue : bGray), flex: 1, padding: "8px 4px", fontSize: 13 }}>Approved ({nApproved})</button>
            </div>
            {selLabel && selected.size > 0 && tab === "review" && (
              <div data-testid="recovered" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, padding: "8px 10px", borderRadius: 10, background: "rgba(74,127,255,.14)", border: `1px solid ${BLUE_L}` }}>
                <div style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>{selLabel} ({selected.size}) <span style={{ display: "block", fontSize: 11, fontWeight: 400, color: GRAY }}>All ticked. Untick any mistakes, then Approve all.</span></div>
                <button data-testid="recovered-toggle" onClick={() => setOnlySel(!onlySel)} style={{ ...bGray, padding: "6px 10px", fontSize: 12 }}>{onlySel ? "Show all" : "Show only these"}</button>
              </div>
            )}
            {note && <div data-testid="note" style={{ color: AMBER, fontSize: 12, marginBottom: 10 }}>{note}</div>}
            {tab === "approved" && (
              <div style={{ marginBottom: 10 }}>
                {/* The posting brain replaced the old schedule (19 Nov night): it posts approved products 3 times a day by itself. */}
                <BrainPanel brain={d.brain} api={api} busy={busy} run={run} />
              </div>
            )}
            {tab === "newArrivals" && naRows.length === 0 && <div data-testid="na-empty" style={{ color: GRAY, fontSize: 13, margin: "10px 0" }}>No New Arrivals waiting — everything uploaded in the past 20 days has been approved or rejected.</div>}
            <Block testid="block-na" title="New Arrivals · past 20 days, newest first" rows={naRows} {...shared} />
            {tab === "approved" && <div data-testid="approved-split" style={{ fontSize: 12, color: "#dfe7ff", margin: "0 0 8px" }}>New Arrivals {apprNa.length} · Normal {apprNormal.length} — every slot posts approved New Arrivals first.</div>}
            <Block testid="block-appr-na" title="New Arrivals" rows={apprNa} {...shared} />
            <Block testid="block-appr-normal" title="Normal" rows={apprNormal} {...shared} />
            <Block testid="block-big" title="30+ on hand" rows={big} {...shared}>
              {tab === "review" && bigToReview > 0 && <button data-testid="approve-big" disabled={busy} onClick={() => run(() => api.approveBig(Object.fromEntries(d.review.filter((x) => x.big).map((x) => [x.pid, sigOfRow(x)]))), { reload: true, undo: (x) => (x && x.pids && x.pids.length ? { text: `Approved ${x.pids.length} with 30+`, reverse: undoWith(x.undo || {}) } : null) })} style={{ ...bGreen, padding: "6px 10px", fontSize: 12 }}>Approve all 30+ ({bigToReview})</button>}
            </Block>
            <Block testid="block-mid" title="13–29 on hand" rows={mid} {...shared} />
            {tab === "review" && <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, margin: "8px 0" }}>
              <input data-testid="show-under" type="checkbox" checked={showUnder} onChange={(e) => { setShowUnder(e.target.checked); clearSel(); }} /> Show under 13{t.underReview != null ? ` (${t.underReview} to review)` : d.meta.under ? ` (${d.meta.under})` : ""}
            </label>}
            {showUnder && !under && <div style={{ color: GRAY, fontSize: 12 }}>Loading…</div>}
            <Block testid="block-under" title="Under 13" rows={underRows} {...shared} />
            {d.rejected.length > 0 && (
              <div style={{ marginTop: 20, fontSize: 11, color: GRAY }}>
                <button data-testid="rejected-link" onClick={() => setShowRejected(!showRejected)} style={{ background: "none", border: "none", color: GRAY, textDecoration: "underline", padding: 0, fontSize: 11, cursor: "pointer" }}>Rejected ({d.rejected.length})</button>
                {showRejected && <ul style={{ margin: "6px 0 0", paddingLeft: 16 }}>{d.rejected.map((x) => <li key={x.pid}>{x.name} <button data-testid={`undo-${x.pid}`} disabled={busy} onClick={() => run(() => api.reset(x.pid), { reload: true })} style={{ background: "none", border: "none", color: BLUE_L, padding: 0, fontSize: 11, cursor: "pointer" }}>undo</button></li>)}</ul>}
              </div>
            )}
          </>
        )}
      </div>
      {quick && (
        <div data-testid="quick" onClick={() => setQuick(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...GLASS, background: "#151924", width: "100%", maxWidth: 520, padding: 16, borderRadius: "16px 16px 0 0", paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{quick.name}</div>
            <div style={{ display: "flex", gap: 10 }}>
              {quick.canGenerate !== false && <button data-testid="quick-generate" disabled={!!gens[quick.pid] || quick.generating} onClick={() => { const r = quick; setQuick(null); generate(r); }} style={{ ...bBlue, flex: 1, minHeight: 56, fontSize: 16 }}>{quick.generations ? "Regenerate" : "Generate"}</button>}
              {(quick.tab === "review" || quick.tab === "newArrivals") && <button data-testid="quick-approve" disabled={busy || quick.generating} onClick={() => { const r = quick; setQuick(null); on.approve(r); }} style={{ ...bGreen, flex: 1, minHeight: 56, fontSize: 16 }}>Approve</button>}
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div data-testid="toast" style={{ position: "fixed", left: 12, right: 12, bottom: `calc(${selectMode && selected.size ? BAR_H : 0}px + env(safe-area-inset-bottom) + 16px)`, margin: "0 auto", maxWidth: 520, background: "#232a3b", border: "1px solid rgba(255,255,255,.12)", borderRadius: 12, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10, zIndex: 40, boxShadow: "0 6px 24px rgba(0,0,0,.4)" }}>
          <div style={{ flex: 1, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{toast.text}</div>
          <button data-testid="toast-undo" onClick={toast.undo} style={{ ...bGray, padding: "6px 12px", fontSize: 13, color: BLUE_L, fontWeight: 700 }}>Undo</button>
        </div>
      )}
      {selectMode && selected.size > 0 && note && (
        <div data-testid="bulk-note" style={{ position: "fixed", left: 12, right: 12, bottom: `calc(${BAR_H + (toast ? 64 : 0)}px + env(safe-area-inset-bottom) + 8px)`, margin: "0 auto", maxWidth: 520, background: "#2a2216", border: `1px solid ${AMBER}`, color: AMBER, borderRadius: 10, padding: "8px 10px", fontSize: 12, zIndex: 35 }}>{note}</div>
      )}
      {selectMode && selected.size > 0 && (
        <div data-testid="select-bar" style={{ position: "fixed", left: 0, right: 0, bottom: 0, height: `calc(${BAR_H}px + env(safe-area-inset-bottom))`, boxSizing: "border-box", background: "#11151f", borderTop: "1px solid rgba(255,255,255,.1)", display: "flex", alignItems: "center", gap: 6, padding: "0 12px", paddingBottom: "env(safe-area-inset-bottom)", zIndex: 30 }}>
          <div data-testid="select-count" style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>{progress || `${selected.size} selected`}{!progress && !selSaved && <span data-testid="sel-saving" style={{ display: "block", fontSize: 10, fontWeight: 400, color: GRAY }}>saving…</span>}</div>
          {tab === "approved"
            ? <button data-testid="bulk-repost" disabled={busy} onClick={bulkRepost} style={{ ...bGreen, padding: "8px 10px", fontSize: 12 }}>Repost</button>
            : <button data-testid="bulk-approve" disabled={busy} onClick={bulkApprove} style={{ ...bGreen, padding: "8px 10px", fontSize: 12 }}>{selLabel ? "Approve all" : "Approve"}</button>}
          {tab !== "approved" && <button data-testid="bulk-generate" disabled={busy || !picked.some((r) => !gens[r.pid] && !r.generating && r.canGenerate !== false)} onClick={bulkGenerate} style={{ ...bBlue, padding: "8px 10px", fontSize: 12 }}>Generate</button>}
          <button data-testid="bulk-reject" disabled={busy} onClick={bulkReject} style={{ ...bGray, padding: "8px 10px", fontSize: 12, color: RED }}>Reject</button>
          <button data-testid="bulk-clear" onClick={clearSel} style={{ ...bGray, padding: "8px 10px", fontSize: 12 }}>Clear</button>
        </div>
      )}
    </div>
  );
}
