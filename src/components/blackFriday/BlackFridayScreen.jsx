// ─── BLACK FRIDAY 2026 — Junid's approve card ────────────────────────────────
// Every product with more than 12 on hand plus every New Arrival (past 20
// days), one row per STOCK price — clothing and sneakers never together.
// Per item: Use current photo / Generate (one Gemini photo per tap) /
// Regenerate, Approve, untick. Approve All per group. NOTHING POSTS until
// Junid confirms a schedule at the top; each group is re-checked for stock
// just before it posts. Only the STOCK price is ever shown.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { FONT, BG, GLASS, GREEN, GRAY, AMBER, RED, BLUE_L, bGreen, bGray, bBlue } from "../stock/ui";

export const STATUS = Object.freeze({
  waiting: { text: "Waiting for you", color: AMBER },
  approved: { text: "Approved — queued", color: BLUE_L },
  posted: { text: "Posted", color: GREEN },
  "partly sold out": { text: "Posted — partly sold out", color: GREEN },
  "sold out": { text: "Sold out — not posted", color: GRAY },
  held: { text: "Held — reached some groups", color: RED },
});
export const FILTERS = Object.freeze([
  { id: "all", text: "All" },
  { id: "notGenerated", text: "Not generated" },
  { id: "generated", text: "Generated" },
  { id: "approved", text: "Approved" },
  { id: "waiting", text: "Waiting" },
]);
const DIV = { clothing: "Clothing", sneakers: "Sneakers" };

const sast = (ms) => (ms ? new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms)) : "");
const rand = (n) => `R${(Number(n) || 0).toFixed(2)}`;

/** Does an item pass the chip? Pure. */
export function itemMatches(it, filter) {
  if (filter === "notGenerated") return !it.generations;
  if (filter === "generated") return it.generations > 0;
  if (filter === "approved") return it.approved && !it.excluded;
  if (filter === "waiting") return !it.approved && !it.excluded;
  return true;
}

/** Which buttons a group offers. Pure. */
export function actionsFor(g) {
  const unapproved = g.items.filter((it) => !it.excluded && !it.approved).length;
  return {
    approveAll: (g.status === "waiting" || g.status === "approved") && unapproved > 0,
    approveAgain: ["posted", "partly sold out", "sold out", "held"].includes(g.status),
    undo: g.status === "approved",
    canEdit: g.status === "waiting" || g.status === "approved",
  };
}

/**
 * Which buttons an item offers. Pure. Approve is offered whenever the item is
 * ticked and not yet approved with the photo it shows — a generated photo
 * NEVER greys it out (only a photo still being made does, briefly).
 */
export function itemActions(it, canEdit) {
  return {
    approve: canEdit && !it.excluded && !it.approved,
    approveDisabled: !!it.generating,
    generate: canEdit && !it.excluded && !it.generations,
    regenerate: canEdit && !it.excluded && it.generations > 0,
    useCurrent: canEdit && it.use === "generated",
    useGenerated: canEdit && it.use === "current" && !!it.generatedUrl,
    tick: canEdit,
  };
}

function Item({ it, g, canEdit, busy, gen, onApprove, onTick, onUse, onGenerate }) {
  const a = itemActions(it, canEdit);
  const small = { ...bGray, padding: "4px 6px", fontSize: 11, minHeight: 28 };
  return (
    <div data-testid={`item-${g.key}-${it.pid}`} style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, opacity: it.excluded ? 0.4 : 1 }}>
      <div style={{ position: "relative", aspectRatio: "3 / 4", borderRadius: 10, overflow: "hidden", background: "#0b0d12" }}>
        {it.shown && <img src={it.shown} alt={it.name} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
        <span style={{ position: "absolute", top: 4, left: 4, background: "rgba(0,0,0,.7)", borderRadius: 6, padding: "1px 5px", fontSize: 10 }}>{it.n}</span>
        {it.use === "generated" && <span style={{ position: "absolute", top: 4, right: 4, background: BLUE_L, color: "#000", borderRadius: 6, padding: "1px 5px", fontSize: 10, fontWeight: 700 }}>AI</span>}
        {it.na && <span style={{ position: "absolute", bottom: 4, left: 4, background: AMBER, color: "#000", borderRadius: 6, padding: "1px 5px", fontSize: 10, fontWeight: 700 }}>New</span>}
        {it.approved && !it.excluded && <span data-testid={`approved-${it.pid}`} style={{ position: "absolute", bottom: 4, right: 4, background: GREEN, color: "#000", borderRadius: 6, padding: "1px 5px", fontSize: 10, fontWeight: 800 }}>✓ Approved</span>}
        {gen && <div data-testid={`gen-${it.pid}`} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.65)", display: "flex", alignItems: "center", justifyContent: "center", padding: 6, fontSize: 11, textAlign: "center" }}>{gen}</div>}
      </div>
      <span style={{ fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.name}</span>
      <span style={{ fontSize: 10, color: GRAY }}>{it.sizes} · {it.qty} on hand</span>
      {it.changedSinceApproval && <span style={{ fontSize: 10, color: AMBER }}>Photo changed — approve again</span>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {a.approve && <button data-testid={`approve-item-${it.pid}`} disabled={busy || a.approveDisabled} onClick={() => onApprove(g, it)} style={{ ...bGreen, padding: "4px 8px", fontSize: 11, minHeight: 28 }}>Approve</button>}
        {a.useCurrent && <button data-testid={`use-current-${it.pid}`} disabled={busy} onClick={() => onUse(g, it, "current")} style={small}>Use current photo</button>}
        {a.useGenerated && <button data-testid={`use-generated-${it.pid}`} disabled={busy} onClick={() => onUse(g, it, "generated")} style={small}>Use AI photo</button>}
        {a.generate && <button data-testid={`generate-${it.pid}`} disabled={!!gen || it.generating} onClick={() => onGenerate(g, it)} style={{ ...bBlue, padding: "4px 8px", fontSize: 11, minHeight: 28 }}>Generate</button>}
        {a.regenerate && <button data-testid={`regenerate-${it.pid}`} disabled={!!gen || it.generating} onClick={() => onGenerate(g, it)} style={small}>Regenerate</button>}
        {a.tick && <button data-testid={`tick-${it.pid}`} aria-pressed={!it.excluded} disabled={busy} onClick={() => onTick(g, it)} style={small}>{it.excluded ? "Tick" : "Untick"}</button>}
      </div>
    </div>
  );
}

function GroupRow({ g, filter, busy, gens, onApprove, onUndo, onItem }) {
  const [open, setOpen] = useState(false);
  const a = actionsFor(g);
  const partial = g.status === "approved" && !g.complete;
  const st = partial ? { text: "Partly approved — not queued", color: AMBER } : (STATUS[g.status] || { text: g.status, color: GRAY });
  const matching = g.items.filter((it) => itemMatches(it, filter));
  if (!matching.length) return null;
  const shown = open ? matching : matching.slice(0, 8);
  return (
    <div data-testid={`group-${g.key}`} style={{ ...GLASS, padding: 12, marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <div style={{ fontSize: 18, fontWeight: 800 }}>{g.label}</div>
        {g.division && <span style={{ fontSize: 11, color: GRAY, border: `1px solid ${GRAY}`, borderRadius: 999, padding: "1px 8px" }}>{DIV[g.division] || g.division}</span>}
        <span style={{ flex: 1 }} />
        <span data-testid={`status-${g.key}`} style={{ color: st.color, fontSize: 12, fontWeight: 700 }}>{st.text}</span>
      </div>
      <div style={{ color: GRAY, fontSize: 12, marginBottom: 8 }}>
        {g.approvedCount} of {g.included} approved{g.count !== g.included ? ` · ${g.count - g.included} unticked` : ""}
        {g.dueAt && <span data-testid={`due-${g.key}`} style={{ color: BLUE_L }}> · posts {sast(g.dueAt)}</span>}
        {partial && <span data-testid={`partial-${g.key}`} style={{ color: AMBER }}> · approve or untick the rest to queue it (never a partial album)</span>}
        {g.status === "approved" && g.complete && !g.dueAt && <span style={{ color: AMBER }}> · not scheduled yet</span>}
        {g.post?.at && <span> · posted {sast(g.post.at)}</span>}
        {g.postedEarlierAt && <span style={{ color: AMBER }}> · already posted {sast(g.postedEarlierAt)} — approving again sends it once more</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 10 }}>
        {shown.map((it) => <Item key={it.pid} it={it} g={g} canEdit={a.canEdit} busy={busy} gen={gens[it.pid]} {...onItem} />)}
      </div>
      {matching.length > 8 && <button onClick={() => setOpen(!open)} style={{ ...bGray, marginTop: 8, padding: "6px 10px", fontSize: 12 }}>{open ? "Show fewer" : `Show all ${matching.length}`}</button>}
      {g.post?.dropped?.length > 0 && <div style={{ color: GRAY, fontSize: 11, marginTop: 8 }}>Dropped at send time: {g.post.dropped.map((d) => `${d.name} (${d.why})`).join(" · ")}</div>}
      <details style={{ marginTop: 8 }}>
        <summary style={{ color: GRAY, fontSize: 12, cursor: "pointer" }}>Caption preview</summary>
        <pre data-testid={`caption-${g.key}`} style={{ whiteSpace: "pre-wrap", fontFamily: FONT, fontSize: 12, background: "rgba(255,255,255,.04)", borderRadius: 10, padding: 8, margin: "6px 0 0" }}>{g.caption}</pre>
      </details>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        {(a.approveAll || a.approveAgain) && (
          <button data-testid={`approve-${g.key}`} disabled={busy || g.included === 0} onClick={() => onApprove(g)} style={{ ...bGreen, flex: 1, opacity: busy || g.included === 0 ? 0.5 : 1 }}>
            {a.approveAgain ? "Approve again (posts once more)" : `Approve all in ${g.label}`}
          </button>
        )}
        {a.undo && <button data-testid={`undo-${g.key}`} disabled={busy} onClick={() => onUndo(g)} style={{ ...bGray }}>Undo</button>}
      </div>
    </div>
  );
}

const toLocalInput = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

/** The schedule panel: nothing posts until Junid confirms here. */
function SchedulePanel({ data, api, busy, run, labelOf }) {
  const s = data.schedule;
  const [edit, setEdit] = useState(!s);
  const [form, setForm] = useState(() => ({ mode: "spread", start: toLocalInput(Date.now() + 15 * 60000), from: "08:00", to: "20:00", gapMin: 60, until: "2026-11-27T20:00" }));
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState(null);
  const f = (k) => (e) => { setForm({ ...form, [k]: e.target.value }); setPreview(null); };
  const payload = () => ({ mode: form.mode, from: form.from, to: form.to, start: new Date(form.start).getTime(), ...(form.mode === "gap" ? { gapMin: Number(form.gapMin) } : {}), ...(form.mode === "spread" ? { until: new Date(form.until).getTime() } : {}) });
  const showPlan = async () => {
    setErr(null);
    try { const r = await api.schedule(payload(), { confirm: false }); if (r.ok === false) setErr(r.refusal); else setPreview(r); } catch (e) { setErr(e?.message || String(e)); }
  };
  const confirm = () => run(async () => { const r = await api.schedule(payload(), { confirm: true }); if (r.ok !== false) { setEdit(false); setPreview(null); } return r; });
  const inp = { background: "rgba(255,255,255,.06)", color: "#fff", border: "1px solid rgba(255,255,255,.15)", borderRadius: 8, padding: "6px 8px", fontFamily: FONT, fontSize: 13 };
  return (
    <div data-testid="schedule" style={{ ...GLASS, padding: 12, marginBottom: 12, fontSize: 13 }}>
      <div style={{ fontWeight: 800, marginBottom: 6 }}>Posting schedule</div>
      {data.postingPaused && <div data-testid="paused" style={{ color: RED, fontSize: 12, marginBottom: 6 }}>WhatsApp posting is paused on the New Arrivals card — nothing posts until it is switched on there.</div>}
      {!s && <div data-testid="no-schedule" style={{ color: AMBER, marginBottom: 8 }}>No schedule — nothing will post until you set one.</div>}
      {s && !edit && (
        <div>
          <div data-testid="schedule-summary">
            {s.mode === "now" ? "Posting all approved groups now, a few minutes apart." : s.mode === "gap" ? `From ${sast(s.start)}, every ${s.gapMin} min, ${s.from}–${s.to}.` : `From ${sast(s.start)}, spread evenly until ${sast(s.until)}, ${s.from}–${s.to}.`}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button onClick={() => setEdit(true)} disabled={busy} style={{ ...bGray, padding: "6px 10px", fontSize: 12 }}>Change</button>
            <button data-testid="stop-schedule" onClick={() => run(() => api.clearSchedule())} disabled={busy} style={{ ...bGray, padding: "6px 10px", fontSize: 12, color: RED }}>Stop posting (clear schedule)</button>
          </div>
        </div>
      )}
      {edit && (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[["spread", "Spread evenly until…"], ["gap", "A gap between groups"], ["now", "Post all approved now"]].map(([md, t]) => (
              <button key={md} data-testid={`mode-${md}`} onClick={() => { setForm({ ...form, mode: md }); setPreview(null); }} style={{ ...(form.mode === md ? bBlue : bGray), padding: "6px 10px", fontSize: 12 }}>{t}</button>
            ))}
          </div>
          {form.mode !== "now" && (
            <>
              <label>Start <input data-testid="start" type="datetime-local" value={form.start} onChange={f("start")} style={inp} /></label>
              <label>Daily window <input data-testid="from" type="time" value={form.from} onChange={f("from")} style={inp} /> to <input data-testid="to" type="time" value={form.to} onChange={f("to")} style={inp} /></label>
              {form.mode === "gap" && <label>Gap <input data-testid="gap" type="number" min="5" value={form.gapMin} onChange={f("gapMin")} style={{ ...inp, width: 80 }} /> minutes</label>}
              {form.mode === "spread" && <label>Until <input data-testid="until" type="datetime-local" value={form.until} onChange={f("until")} style={inp} /></label>}
            </>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button data-testid="show-plan" onClick={showPlan} disabled={busy} style={{ ...bBlue, padding: "6px 10px", fontSize: 12 }}>Show the plan</button>
            {s && <button onClick={() => { setEdit(false); setPreview(null); }} style={{ ...bGray, padding: "6px 10px", fontSize: 12 }}>Cancel</button>}
          </div>
          {err && <div data-testid="schedule-error" style={{ color: RED, fontSize: 12 }}>{err}</div>}
          {preview && (
            <div data-testid="plan">
              <div style={{ color: GRAY, fontSize: 12, marginBottom: 4 }}>
                {Object.keys(preview.plan).length} of {preview.queued} approved group{preview.queued === 1 ? "" : "s"} scheduled{preview.queued > Object.keys(preview.plan).length ? " (the rest fall after 27 Nov 20:00)" : ""}. Groups you approve later join this plan.
              </div>
              <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, maxHeight: 220, overflow: "auto" }}>
                {Object.entries(preview.plan).sort((x, y) => x[1] - y[1]).map(([k, t]) => <li key={k}>{sast(t)} — {labelOf(k)}</li>)}
              </ol>
              <button data-testid="confirm-schedule" onClick={confirm} disabled={busy} style={{ ...bGreen, marginTop: 8, width: "100%" }}>Confirm — start posting on this plan</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function BlackFridayScreen({ api, onExit }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [filter, setFilter] = useState("all");
  const [gens, setGens] = useState({});

  // Every list and every tap takes a ticket; an answer older than the newest
  // ticket is ignored, so a slow list never overwrites a fresher tap result.
  const ticket = useRef(0);
  const load = useCallback(() => {
    const t = ++ticket.current;
    return api.list().then((d) => { if (t === ticket.current) { setData(d); setError(null); } }, (e) => { if (t === ticket.current) setError(e?.message || String(e)); });
  }, [api]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [load]);

  const replace = (views) => setData((d) => {
    if (!d) return d;
    const by = Object.fromEntries(views.filter(Boolean).map((v) => [v.key, v]));
    return { ...d, groups: d.groups.map((g) => by[g.key] || g) };
  });
  // A tap: the answer's group views replace the old ones at once; totals and
  // the plan change with every tap, so the card re-reads afterwards too.
  const run = async (fn) => {
    setBusy(true); setNote(null);
    const t = ++ticket.current;
    try {
      const r = await fn();
      if (t !== ticket.current) return;
      const results = r?.results || [r];
      replace(results.map((x) => x?.group));
      const refused = results.filter((x) => x && x.ok === false);
      if (refused.length) setNote(refused.map((x) => (x.key ? `${x.key}: ${x.refusal}` : x.refusal)).join(" · "));
      load();
    } catch (e) {
      // Part of Approve All may have gone through: show the error AND re-read.
      setNote(e?.message || String(e));
      load();
    } finally { setBusy(false); }
  };
  const generate = async (g, it) => {
    setGens((x) => ({ ...x, [it.pid]: "Starting…" }));
    try {
      await api.generate(g.key, it.pid, { onEvent: (ev) => { if (ev && (ev.type === "status" || ev.type === "thought") && ev.text) setGens((x) => ({ ...x, [it.pid]: String(ev.text).slice(0, 90) })); } });
    } catch (e) { setNote(`${it.name}: ${e?.message || String(e)}`); }
    setGens((x) => { const n = { ...x }; delete n[it.pid]; return n; });
    load();
  };

  const waitingGroups = (data?.groups || []).filter((g) => g.status === "waiting" && actionsFor(g).approveAll);
  const tot = data?.totals || {};
  const m = data?.meta || {};
  const labelOf = (k) => data?.groups.find((g) => g.key === k)?.label || k;
  const onItem = {
    onApprove: (g, it) => run(() => api.approveItem(g.key, it.pid)),
    onTick: (g, it) => run(() => api.tick(g.key, it.pid, it.excluded)),
    onUse: (g, it, use) => run(() => api.use(g.key, it.pid, use, use === "generated" ? it.genId : null)),
    onGenerate: generate,
  };
  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT, padding: "14px 14px 96px" }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <button onClick={onExit} style={{ ...bGray, minHeight: 40, padding: "0 12px" }} aria-label="Back">←</button>
          <div style={{ fontSize: 20, fontWeight: 800, flex: 1 }}>Black Friday 🔥</div>
          <button data-testid="refresh" disabled={busy} onClick={load} style={{ ...bGray, minHeight: 40, padding: "0 12px" }} aria-label="Refresh">↻</button>
        </div>
        <div style={{ color: GRAY, fontSize: 12, marginBottom: 12 }}>
          Stock price only. Clothing and sneakers post separately. Each group goes to all 14 WhatsApp groups as one album, re-checked for stock just before it posts.
        </div>
        {error && <div data-testid="error" style={{ color: RED, fontSize: 13, marginBottom: 12 }}>{error} <button onClick={load} style={{ ...bGray, padding: "4px 8px", fontSize: 12 }}>Retry</button></div>}
        {!data && !error && <div style={{ color: GRAY }}>Loading…</div>}
        {data && (
          <>
            <div data-testid="totals" style={{ ...GLASS, padding: 12, marginBottom: 12, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8 }}>
              {[["Products", tot.products], ["Photos", tot.photos], ["Price groups", tot.groups], ["AI photos", tot.aiPhotos], ["Approved", tot.approved], ["Waiting", tot.waiting], ["AI spend", rand(tot.spentZar)]].map(([k, v]) => (
                <div key={k} data-testid={`total-${k}`}><div style={{ fontSize: 18, fontWeight: 800 }}>{v ?? 0}</div><div style={{ fontSize: 11, color: GRAY }}>{k}</div></div>
              ))}
              <div style={{ gridColumn: "1 / -1", fontSize: 11, color: GRAY }}>
                {m.eligible} with more than 12 on hand · {m.newArrivals || 0} New Arrivals{m.builtAt ? ` · built ${sast(m.builtAt)}` : ""}
              </div>
            </div>
            <SchedulePanel data={data} api={api} busy={busy} run={run} labelOf={labelOf} />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              {FILTERS.map((x) => <button key={x.id} data-testid={`filter-${x.id}`} aria-pressed={filter === x.id} onClick={() => setFilter(x.id)} style={{ ...(filter === x.id ? bBlue : bGray), padding: "6px 12px", fontSize: 12, borderRadius: 999 }}>{x.text}</button>)}
            </div>
            {waitingGroups.length > 0 && (
              <button data-testid="approve-all" disabled={busy} onClick={() => run(() => api.approveAll(waitingGroups.map((g) => g.key)))} style={{ ...bBlue, marginBottom: 10, width: "100%", opacity: busy ? 0.5 : 1 }}>
                Approve All ({waitingGroups.length} group{waitingGroups.length === 1 ? "" : "s"}, {waitingGroups.reduce((a, g) => a + g.included, 0)} items)
              </button>
            )}
            {note && <div data-testid="note" style={{ color: AMBER, fontSize: 12, marginBottom: 10 }}>{note}</div>}
            {data.groups.map((g) => (
              <GroupRow key={g.key} g={g} filter={filter} busy={busy} gens={gens}
                onApprove={(x) => run(() => api.approve(x.key))}
                onUndo={(x) => run(() => api.unapprove(x.key))}
                onItem={onItem} />
            ))}
            {m.noPhotoCount > 0 && (
              <details data-testid="no-photo" style={{ ...GLASS, padding: 12, marginTop: 12 }}>
                <summary style={{ cursor: "pointer", fontSize: 13 }}>{m.noPhotoCount} product{m.noPhotoCount === 1 ? "" : "s"} have no photo — not posted</summary>
                <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: GRAY }}>
                  {(m.noPhoto || []).map((p) => <li key={p.pid}>{p.name} — {p.qty} on hand</li>)}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
