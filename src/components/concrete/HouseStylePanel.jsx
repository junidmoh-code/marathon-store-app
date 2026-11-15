// ─── CONCRETE PUBLISHING → HOUSE STYLE ───────────────────────────────────────
// Separate from Marathon's photo tools. Four parts:
//   1. Reference library — multi-file drag/drop or phone picker, grid, delete.
//   2. House-style prompt (editable) + model.
//   3. Generate — pick Concrete products; the batch shows its total cost and
//      needs ONE confirm tap before anything is queued (= spent).
//   4. Awaiting approval — generated beside original: Approve / Regenerate / Reject.
// The Mac mini worker generates; nothing here calls Gemini or publishes.
import React, { useMemo, useRef, useState } from "react";
import {
  useHouseStyle, savePrompt, addRefs, deleteRef, queueGeneration, approveImage, rejectImage,
} from "./houseStyleStore";
import { STATUS, MODELS, DEFAULT_MODEL, DEFAULT_PROMPT, estimateUsd, money, subjectUrls } from "../../utils/concreteHouseStyle";

const box = { background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.09)", borderRadius: 14, padding: 12 };
const btn = (primary) => ({ background: primary ? "#E5E5E5" : "rgba(255,255,255,.06)", color: primary ? "#000" : "rgba(255,255,255,.8)", border: "1px solid " + (primary ? "#E5E5E5" : "rgba(255,255,255,.14)"), borderRadius: 10, padding: "8px 12px", fontWeight: 800, fontSize: 12.5, cursor: "pointer" });
const STATUS_LABEL = { queued: "queued", running: "generating…", awaiting_approval: "awaiting approval", approved: "approved", rejected: "rejected", failed: "FAILED — flagged" };

export default function HouseStylePanel({ products = [] }) {
  const [open, setOpen] = useState(false);
  const { cfg, jobs, error } = useHouseStyle(open);
  const [draft, setDraft] = useState(null);
  const [model, setModel] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [sel, setSel] = useState(() => new Set());
  const [confirm, setConfirm] = useState(null);
  const fileRef = useRef(null);

  const refs = useMemo(() => Object.entries(cfg?.refs || {}).sort(([, a], [, b]) => (b.addedAt || 0) - (a.addedAt || 0)), [cfg]);
  const awaiting = useMemo(() => products.filter((p) => jobs[p.id]?.status === STATUS.AWAITING), [products, jobs]);
  const spent = useMemo(() => Object.values(jobs).reduce((n, j) => n + (Number(j?.costUsd) || 0), 0), [jobs]);
  const est = estimateUsd({ model: model ?? cfg?.model });

  if (!open) {
    return (
      <div style={{ padding: "0 14px 10px" }}>
        <button style={{ ...btn(false), width: "100%" }} onClick={() => setOpen(true)}>House Style — reference photos, AI studio photos, approvals</button>
      </div>
    );
  }

  const upload = async (files) => {
    const list = [...files].filter((f) => f.type.startsWith("image/") || /\.(heic|jpe?g|png|webp)$/i.test(f.name));
    if (!list.length) return;
    setBusy(true); setMsg(`Uploading ${list.length}…`);
    const r = await addRefs(list, (n) => setMsg(`Uploaded ${n}/${list.length}…`));
    setBusy(false);
    const bad = r.filter((x) => !x.ok);
    setMsg(bad.length ? bad.map((b) => b.message).join(" · ") : `${r.length} reference photo${r.length === 1 ? "" : "s"} added.`);
  };
  const runQueue = async (pids) => {
    setBusy(true);
    const r = await queueGeneration(pids, { ...cfg, model: model ?? cfg?.model ?? DEFAULT_MODEL });
    setBusy(false); setConfirm(null);
    setMsg(r.ok ? `${r.count} queued — the Mac mini generates them (about a minute each).` : r.message);
    if (r.ok) setSel(new Set());
  };
  const act = async (fn, ...a) => { setBusy(true); const r = await fn(...a); setBusy(false); if (!r.ok) setMsg(r.message); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "0 14px 14px" }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <b style={{ fontSize: 15 }}>Concrete House Style</b>
        <span style={{ marginLeft: 10, fontSize: 11.5, color: "rgba(255,255,255,.5)" }}>spent so far {money(spent)}</span>
        <button style={{ ...btn(false), marginLeft: "auto" }} onClick={() => setOpen(false)}>Close</button>
      </div>
      {error && <div style={{ color: "#F87171", fontSize: 12.5 }}>{error}</div>}
      {msg && <div style={{ color: "rgba(255,255,255,.75)", fontSize: 12.5 }}>{msg}</div>}

      {/* 1. Reference library */}
      <div style={box}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files); }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
          <b style={{ fontSize: 13 }}>Reference photos ({refs.length})</b>
          <button style={{ ...btn(true), marginLeft: "auto" }} disabled={busy} onClick={() => fileRef.current?.click()}>Add photos</button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
        </div>
        <div style={{ border: `1px dashed ${drag ? "#E5E5E5" : "rgba(255,255,255,.18)"}`, borderRadius: 10, padding: 8, minHeight: 60 }}>
          {!refs.length && <div style={{ fontSize: 12, color: "rgba(255,255,255,.45)", textAlign: "center", padding: 14 }}>Drop sample photos here, or tap Add photos. The newest 6 are sent as the style.</div>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: 6 }}>
            {refs.map(([id, r]) => (
              <div key={id} style={{ position: "relative", aspectRatio: "1", borderRadius: 8, overflow: "hidden", background: "#111" }}>
                <img src={r.url} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                <button aria-label="Delete reference" disabled={busy} onClick={() => act(deleteRef, id, r)}
                  style={{ position: "absolute", top: 3, right: 3, background: "rgba(0,0,0,.7)", color: "#fff", border: 0, borderRadius: 6, width: 22, height: 22, cursor: "pointer" }}>×</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 2. Prompt + model */}
      <div style={box}>
        <b style={{ fontSize: 13 }}>House-style prompt</b>
        <textarea value={draft ?? cfg?.prompt ?? DEFAULT_PROMPT} onChange={(e) => setDraft(e.target.value)} rows={6}
          style={{ width: "100%", boxSizing: "border-box", marginTop: 6, background: "rgba(255,255,255,.04)", color: "#fff", border: "1px solid rgba(255,255,255,.12)", borderRadius: 10, padding: 8, fontSize: 12.5 }} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 6 }}>
          {Object.entries(MODELS).map(([k, m]) => (
            <button key={k} style={btn((model ?? cfg?.model ?? DEFAULT_MODEL) === k)} onClick={() => setModel(k)}>{m.label} · {money(m.estimateUsd)}/image</button>
          ))}
          <button style={{ ...btn(true), marginLeft: "auto" }} disabled={busy || (draft === null && model === null)}
            onClick={async () => { const r = await savePrompt(draft ?? cfg?.prompt ?? DEFAULT_PROMPT, model ?? cfg?.model ?? DEFAULT_MODEL); setMsg(r.ok ? "Saved." : r.message); if (r.ok) { setDraft(null); setModel(null); } }}>Save</button>
        </div>
      </div>

      {/* 3. Generate */}
      <div style={box}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <b style={{ fontSize: 13 }}>Generate studio photos</b>
          <span style={{ fontSize: 11.5, color: "rgba(255,255,255,.5)" }}>≈ {money(est)} per image</span>
          <button style={{ ...btn(false), marginLeft: "auto" }} onClick={() => setSel(new Set(products.filter((p) => !jobs[p.id] || jobs[p.id].status === STATUS.REJECTED || jobs[p.id].status === STATUS.FAILED).map((p) => p.id)))}>Select all without one</button>
          <button style={btn(true)} disabled={!sel.size || busy} onClick={() => setConfirm({ pids: [...sel] })}>Generate {sel.size || ""}</button>
        </div>
        <div style={{ maxHeight: 260, overflow: "auto", marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
          {products.slice(0, 300).map((p) => {
            const j = jobs[p.id];
            const busyRow = j && (j.status === STATUS.QUEUED || j.status === STATUS.RUNNING);
            return (
              <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, opacity: busyRow ? 0.55 : 1 }}>
                <input type="checkbox" disabled={busyRow || !subjectUrls(p).length} checked={sel.has(p.id)}
                  onChange={() => setSel((s) => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })} />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name || p.id}</span>
                {j && <span style={{ color: j.status === STATUS.FAILED ? "#F87171" : j.status === STATUS.APPROVED ? "#4ADE80" : "rgba(255,255,255,.55)" }}>
                  {STATUS_LABEL[j.status] || j.status}{j.costUsd ? ` · ${money(j.costUsd)}` : ""}</span>}
              </label>
            );
          })}
          {!products.length && <div style={{ fontSize: 12, color: "rgba(255,255,255,.45)" }}>No products are marked for Concrete yet (Product Admin → All products).</div>}
        </div>
      </div>

      {/* 4. Awaiting approval */}
      {awaiting.length > 0 && (
        <div style={box}>
          <b style={{ fontSize: 13 }}>Awaiting approval ({awaiting.length}) — nothing is published until you approve</b>
          {awaiting.map((p) => {
            const j = jobs[p.id];
            return (
              <div key={p.id} style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,.08)" }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{p.name} <span style={{ fontWeight: 400, color: "rgba(255,255,255,.5)", fontSize: 11.5 }}>· {money(j.costUsd)} · {j.model}</span></div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <figure style={{ margin: 0 }}><img src={j.subjectUrl || p.photoUrl} alt="original" loading="lazy" style={{ width: "100%", aspectRatio: "1", objectFit: "contain", background: "#fff", borderRadius: 8 }} /><figcaption style={{ fontSize: 11, color: "rgba(255,255,255,.5)" }}>Original (kept)</figcaption></figure>
                  <figure style={{ margin: 0 }}><img src={j.url} alt="generated" loading="lazy" style={{ width: "100%", aspectRatio: "1", objectFit: "contain", background: "#fff", borderRadius: 8 }} /><figcaption style={{ fontSize: 11, color: "rgba(255,255,255,.5)" }}>Generated</figcaption></figure>
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <button style={btn(true)} disabled={busy} onClick={() => act(approveImage, p.id, j, p)}>Approve</button>
                  <button style={btn(false)} disabled={busy} onClick={() => setConfirm({ pids: [p.id] })}>Regenerate</button>
                  <button style={btn(false)} disabled={busy} onClick={() => act(rejectImage, p.id, j.url)}>Reject</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {confirm && (
        <div role="dialog" onClick={() => !busy && setConfirm(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#141414", border: "1px solid rgba(255,255,255,.15)", borderRadius: 16, padding: 20, maxWidth: 380, width: "100%" }}>
            <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 8 }}>Generate {confirm.pids.length} image{confirm.pids.length === 1 ? "" : "s"}?</div>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,.7)", marginBottom: 14 }}>
              Estimated total <b>{money(est * confirm.pids.length)}</b> ({money(est)} each, paid Gemini generation). Each image waits for your approval before it is used.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={btn(false)} disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
              <button style={btn(true)} disabled={busy} onClick={() => runQueue(confirm.pids)}>{busy ? "Queuing…" : `Spend ≈ ${money(est * confirm.pids.length)}`}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
