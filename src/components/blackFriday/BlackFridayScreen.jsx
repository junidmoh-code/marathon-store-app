// ─── BLACK FRIDAY 2026 — Junid's card (v3, 19 Nov evening) ───────────────────
// One row per product. Two tabs: To review and Approved. MAIN = 13 or more on
// hand: every 30+ product first (with "Approve all 30+"), then 13–29. "Show
// under 13" adds the rest. Per product: Approve, Reject, Use current photo,
// Generate / Regenerate. Reject removes it (and it stays rejected); undo from
// the small "Rejected (n)" link at the bottom. Grouping into albums happens
// only when posting. NOTHING POSTS until Junid confirms a schedule ("Schedule
// posting" on the Approved tab). Only the STOCK price is ever shown.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { FONT, BG, GLASS, GREEN, GRAY, AMBER, RED, BLUE_L, bGreen, bGray, bBlue } from "../stock/ui";

const KIND = { sneakers: "Sneakers", clothing: "Clothing", headwear: "Caps & beanies", perfume: "Perfume", bags: "Bags", belts: "Belts", sunglasses: "Sunglasses", watches: "Watches", jewellery: "Chains & bracelets", accessories: "Accessories" };
const PAGE = 60;
const sast = (ms) => (ms ? new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms)) : "");
const rand = (n) => `R${(Number(n) || 0).toFixed(2)}`;
const price = (p) => (Number.isInteger(Number(p)) ? `R${Number(p)}` : `R${Number(p).toFixed(2)}`);

/**
 * Which buttons a product offers. Pure.
 * Approve is never greyed out on a generated photo (only while one is being made).
 * A kind whose AI look Junid has not approved yet offers "Use current photo" as the
 * safe default, with Generate still there.
 */
export function rowActions(r) {
  const review = r.tab === "review";
  return {
    approve: review,
    approveDisabled: !!r.generating,
    reject: true,
    backToReview: !review,
    useCurrent: r.use === "generated" || !r.styleApproved,
    useCurrentPrimary: !r.styleApproved && r.use !== "generated",
    useAi: r.use === "current" && !!r.generatedUrl,
    generate: !r.generations,
    regenerate: r.generations > 0,
    approveLook: !r.styleApproved && r.generations > 0,
  };
}

function Row({ r, busy, gen, on }) {
  const a = rowActions(r);
  const sm = { ...bGray, padding: "4px 8px", fontSize: 11, minHeight: 28 };
  return (
    <div data-testid={`row-${r.pid}`} style={{ display: "flex", gap: 10, padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
      <div style={{ position: "relative", width: 72, height: 96, flex: "0 0 72px", borderRadius: 8, overflow: "hidden", background: "#0b0d12" }}>
        {r.shown && <img src={r.shown} alt={r.name} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
        {r.use === "generated" && <span style={{ position: "absolute", top: 3, right: 3, background: BLUE_L, color: "#000", borderRadius: 5, padding: "0 4px", fontSize: 9, fontWeight: 700 }}>AI</span>}
        {gen && <div data-testid={`gen-${r.pid}`} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.7)", display: "flex", alignItems: "center", justifyContent: "center", padding: 4, fontSize: 10, textAlign: "center" }}>{gen}</div>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</div>
        <div style={{ fontSize: 12, color: "#dfe7ff" }}>{price(r.price)} · {r.qty} on hand{r.na ? " · New" : ""}</div>
        <div style={{ fontSize: 11, color: GRAY, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.sizes}</div>
        {r.changedSinceApproval && <div style={{ fontSize: 11, color: AMBER }}>Photo changed — approve again</div>}
        {r.posted && <div style={{ fontSize: 11, color: GREEN }}>Posted</div>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
          {a.approve && <button data-testid={`approve-${r.pid}`} disabled={busy || a.approveDisabled} onClick={() => on.approve(r)} style={{ ...bGreen, padding: "4px 10px", fontSize: 11, minHeight: 28 }}>Approve</button>}
          {a.backToReview && <button data-testid={`back-${r.pid}`} disabled={busy} onClick={() => on.reset(r)} style={sm}>Back to review</button>}
          <button data-testid={`reject-${r.pid}`} disabled={busy} onClick={() => on.reject(r)} style={{ ...sm, color: RED }}>Reject</button>
          {a.useCurrent && <button data-testid={`use-current-${r.pid}`} disabled={busy} onClick={() => on.use(r, "current")} style={a.useCurrentPrimary ? { ...bBlue, padding: "4px 8px", fontSize: 11, minHeight: 28 } : sm}>Use current photo</button>}
          {a.useAi && <button data-testid={`use-ai-${r.pid}`} disabled={busy} onClick={() => on.use(r, "generated")} style={sm}>Use AI photo</button>}
          {(a.generate || a.regenerate) && <button data-testid={`generate-${r.pid}`} disabled={!!gen || r.generating} onClick={() => on.generate(r)} style={r.styleApproved && a.generate ? { ...bBlue, padding: "4px 8px", fontSize: 11, minHeight: 28 } : sm}>{a.regenerate ? "Regenerate" : "Generate"}</button>}
          {a.approveLook && <button data-testid={`look-${r.pid}`} disabled={busy} onClick={() => on.approveLook(r)} style={sm}>Approve the AI look for {KIND[r.kind] || r.kind}</button>}
        </div>
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
      {rows.slice(0, n).map((r) => <Row key={r.pid} r={r} {...rest} gen={rest.gens[r.pid]} />)}
      {rows.length > n && <button onClick={() => setN(n + PAGE)} style={{ ...bGray, margin: "8px 0", padding: "6px 10px", fontSize: 12 }}>Show {Math.min(PAGE, rows.length - n)} more</button>}
    </div>
  );
}

const toLocalInput = (ms) => { const d = new Date(ms); const p = (x) => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

/** Behind "Schedule posting" on the Approved tab: nothing posts until Junid confirms. */
function SchedulePanel({ data, api, busy, run }) {
  const s = data.schedule;
  const [edit, setEdit] = useState(!s);
  const [form, setForm] = useState(() => ({ mode: "spread", start: toLocalInput(Date.now() + 15 * 60000), from: "08:00", to: "20:00", gapMin: 60, until: "2026-11-27T20:00" }));
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState(null);
  const f = (k) => (e) => { setForm({ ...form, [k]: e.target.value }); setPreview(null); };
  const payload = () => ({ mode: form.mode, from: form.from, to: form.to, start: new Date(form.start).getTime(), ...(form.mode === "gap" ? { gapMin: Number(form.gapMin) } : {}), ...(form.mode === "spread" ? { until: new Date(form.until).getTime() } : {}) });
  const showPlan = async () => { setErr(null); try { const r = await api.schedule(payload(), { confirm: false }); if (r.ok === false) setErr(r.refusal); else setPreview(r); } catch (e) { setErr(e?.message || String(e)); } };
  const inp = { background: "rgba(255,255,255,.06)", color: "#fff", border: "1px solid rgba(255,255,255,.15)", borderRadius: 8, padding: "6px 8px", fontFamily: FONT, fontSize: 13 };
  return (
    <div data-testid="schedule" style={{ ...GLASS, padding: 12, marginBottom: 12, fontSize: 13 }}>
      {data.postingPaused && <div data-testid="paused" style={{ color: RED, fontSize: 12, marginBottom: 6 }}>WhatsApp posting is paused on the New Arrivals card — nothing posts until it is switched on there.</div>}
      {s && !edit && (
        <div>
          <div data-testid="schedule-summary">{s.mode === "now" ? "Posting all approved now, a few minutes apart." : s.mode === "gap" ? `From ${sast(s.start)}, every ${s.gapMin} min, ${s.from}–${s.to}.` : `From ${sast(s.start)}, spread evenly until ${sast(s.until)}, ${s.from}–${s.to}.`}</div>
          {data.plan.length > 0 && <ol style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12, color: GRAY, maxHeight: 160, overflow: "auto" }}>{data.plan.map((p) => <li key={p.album}>{sast(p.due)} — {p.album} ({p.count})</li>)}</ol>}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button onClick={() => setEdit(true)} disabled={busy} style={{ ...bGray, padding: "6px 10px", fontSize: 12 }}>Change</button>
            <button data-testid="stop-schedule" onClick={() => run(() => api.clearSchedule(), { reload: true })} disabled={busy} style={{ ...bGray, padding: "6px 10px", fontSize: 12, color: RED }}>Stop posting</button>
          </div>
        </div>
      )}
      {edit && (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[["spread", "Spread evenly until…"], ["gap", "A gap between albums"], ["now", "Post all approved now"]].map(([md, t]) => (
              <button key={md} data-testid={`mode-${md}`} onClick={() => { setForm({ ...form, mode: md }); setPreview(null); }} style={{ ...(form.mode === md ? bBlue : bGray), padding: "6px 10px", fontSize: 12 }}>{t}</button>
            ))}
          </div>
          {form.mode !== "now" && (
            <>
              <label>Start <input data-testid="start" type="datetime-local" value={form.start} onChange={f("start")} style={inp} /></label>
              <label>Daily window <input type="time" value={form.from} onChange={f("from")} style={inp} /> to <input type="time" value={form.to} onChange={f("to")} style={inp} /></label>
              {form.mode === "gap" && <label>Gap <input data-testid="gap" type="number" min="5" value={form.gapMin} onChange={f("gapMin")} style={{ ...inp, width: 80 }} /> minutes</label>}
              {form.mode === "spread" && <label>Until <input type="datetime-local" value={form.until} onChange={f("until")} style={inp} /></label>}
            </>
          )}
          <button data-testid="show-plan" onClick={showPlan} disabled={busy} style={{ ...bBlue, padding: "6px 10px", fontSize: 12, justifySelf: "start" }}>Show the plan</button>
          {err && <div data-testid="schedule-error" style={{ color: RED, fontSize: 12 }}>{err}</div>}
          {preview && (
            <div data-testid="plan">
              <div style={{ color: GRAY, fontSize: 12, marginBottom: 4 }}>{preview.plan.length} album{preview.plan.length === 1 ? "" : "s"} (same stock price, one kind each). Products you approve later join this plan.</div>
              <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, maxHeight: 220, overflow: "auto" }}>{preview.plan.map((p) => <li key={p.album}>{sast(p.due)} — {p.label} ({p.count})</li>)}</ol>
              <button data-testid="confirm-schedule" onClick={() => run(async () => { const r = await api.schedule(payload(), { confirm: true }); if (r.ok !== false) { setEdit(false); setPreview(null); } return r; }, { reload: true })} disabled={busy} style={{ ...bGreen, marginTop: 8, width: "100%" }}>Confirm — start posting on this plan</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function BlackFridayScreen({ api, onExit }) {
  const [main, setMain] = useState(null);
  const [under, setUnder] = useState(null);
  const [showUnder, setShowUnder] = useState(false);
  const [tab, setTab] = useState("review");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [gens, setGens] = useState({});
  const [sched, setSched] = useState(false);
  const [showRejected, setShowRejected] = useState(false);

  const ticket = useRef(0);
  const load = useCallback(() => {
    const t = ++ticket.current;
    return api.list("main").then((d) => { if (t === ticket.current) { setMain(d); setError(null); } }, (e) => { if (t === ticket.current) setError(e?.message || String(e)); });
  }, [api]);
  const loadUnder = useCallback(() => api.list("under").then(setUnder, (e) => setNote(e?.message || String(e))), [api]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (showUnder && !under) loadUnder(); }, [showUnder, under, loadUnder]);

  // A tap answers with the product's new row: it moves between tabs (or leaves, if rejected) at once.
  const patch = (pid, row, rejected) => {
    const fix = (d) => {
      if (!d) return d;
      const inThis = [...d.review, ...d.approved].some((x) => x.pid === pid);
      if (!inThis) return d;
      const rest = (list) => list.filter((x) => x.pid !== pid);
      const review = rest(d.review), approved = rest(d.approved);
      if (!rejected && row) (row.tab === "approved" ? approved : review).push(row);
      const order = (l) => l.sort((x, y) => (Number(y.big) - Number(x.big)) || (y.qty - x.qty) || String(x.name).localeCompare(String(y.name)));
      return { ...d, review: order(review), approved: order(approved) };
    };
    setMain(fix); setUnder(fix);
  };
  const run = async (fn, { reload = false } = {}) => {
    setBusy(true); setNote(null);
    try {
      const r = await fn();
      if (r && r.ok === false) setNote(r.refusal);
      else if (r && r.pid) patch(r.pid, r.row, r.rejected);
      if (reload || (r && r.pid)) { load(); if (showUnder) loadUnder(); }
    } catch (e) { setNote(e?.message || String(e)); load(); }
    finally { setBusy(false); }
  };
  const generate = async (r) => {
    setGens((x) => ({ ...x, [r.pid]: "Starting…" }));
    try { await api.generate(r.pid, r.section, { onEvent: (ev) => { if (ev && ev.text) setGens((x) => ({ ...x, [r.pid]: String(ev.text).slice(0, 80) })); } }); }
    catch (e) { setNote(`${r.name}: ${e?.message || String(e)}`); }
    setGens((x) => { const n = { ...x }; delete n[r.pid]; return n; });
    load(); if (showUnder) loadUnder();
  };
  const sec = (s) => (r) => ({ ...r, section: s });
  const on = {
    approve: (r) => run(() => api.approve(r.pid, r.section)),
    reject: (r) => run(() => api.reject(r.pid, r.section)),
    reset: (r) => run(() => api.reset(r.pid)),
    use: (r, use) => run(() => api.use(r.pid, use, use === "generated" ? r.genId : null, r.section)),
    generate,
    approveLook: (r) => run(() => api.approveStyle(r.kind), { reload: true }),
  };

  const d = main;
  const t = d?.totals || {};
  const mainRows = d ? (tab === "review" ? d.review : d.approved).map(sec("main")) : [];
  const underRows = showUnder && under ? (tab === "review" ? under.review : under.approved).map(sec("under")) : [];
  const big = mainRows.filter((r) => r.big), mid = mainRows.filter((r) => !r.big);
  const bigToReview = d ? d.review.filter((r) => r.big).length : 0;
  const nReview = (d?.review.length || 0) + (showUnder && under ? under.review.length : 0);
  const nApproved = (d?.approved.length || 0) + (showUnder && under ? under.approved.length : 0);
  const shared = { busy, gens, on };
  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT, padding: "14px 14px 96px" }}>
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
            <div data-testid="totals" style={{ fontSize: 13, color: "#dfe7ff", marginBottom: 10 }}>To review {t.review} · Approved {t.approved} · AI spend {rand(t.spentZar)}</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              <button data-testid="tab-review" aria-pressed={tab === "review"} onClick={() => setTab("review")} style={{ ...(tab === "review" ? bBlue : bGray), flex: 1 }}>To review ({nReview})</button>
              <button data-testid="tab-approved" aria-pressed={tab === "approved"} onClick={() => setTab("approved")} style={{ ...(tab === "approved" ? bBlue : bGray), flex: 1 }}>Approved ({nApproved})</button>
            </div>
            {note && <div data-testid="note" style={{ color: AMBER, fontSize: 12, marginBottom: 10 }}>{note}</div>}
            {tab === "approved" && (
              <div style={{ marginBottom: 10 }}>
                {!sched && <button data-testid="schedule-posting" onClick={() => setSched(true)} style={{ ...bGreen, width: "100%" }}>Schedule posting{d.schedule ? " (set)" : ""}</button>}
                {sched && <SchedulePanel data={d} api={api} busy={busy} run={run} />}
                {!d.schedule && <div data-testid="no-schedule" style={{ color: GRAY, fontSize: 11, marginTop: 4 }}>Nothing posts until you set a schedule.</div>}
              </div>
            )}
            <Block testid="block-big" title="30+ on hand" rows={big} {...shared}>
              {tab === "review" && bigToReview > 0 && <button data-testid="approve-big" disabled={busy} onClick={() => run(() => api.approveBig(), { reload: true })} style={{ ...bGreen, padding: "6px 10px", fontSize: 12 }}>Approve all 30+ ({bigToReview})</button>}
            </Block>
            <Block testid="block-mid" title="13–29 on hand" rows={mid} {...shared} />
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, margin: "8px 0" }}>
              <input data-testid="show-under" type="checkbox" checked={showUnder} onChange={(e) => setShowUnder(e.target.checked)} /> Show under 13{d.meta.under ? ` (${d.meta.under})` : ""}
            </label>
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
    </div>
  );
}
