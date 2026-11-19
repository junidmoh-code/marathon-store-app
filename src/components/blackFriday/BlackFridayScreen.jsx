// ─── BLACK FRIDAY 2026 — Junid's approve card ────────────────────────────────
// One row per stock-price group (built every morning on the Mac mini from the
// products with more than 12 on hand across all locations). Junid unticks
// anything he doesn't want and taps Approve (or Approve All). Approved groups
// go to the 14 WhatsApp groups through the existing poster, 08:00–20:00,
// spread evenly to Fri 27 Nov, each re-checked for stock just before it posts.
// Only the STOCK price is ever shown.
import React, { useCallback, useEffect, useState } from "react";
import { FONT, BG, GLASS, GREEN, GRAY, AMBER, RED, BLUE_L, bGreen, bGray, bBlue } from "../stock/ui";

export const STATUS = Object.freeze({
  waiting: { text: "Waiting for you", color: AMBER },
  approved: { text: "Approved — queued", color: BLUE_L },
  posted: { text: "Posted", color: GREEN },
  "partly sold out": { text: "Posted — partly sold out", color: GREEN },
  "sold out": { text: "Sold out — not posted", color: GRAY },
  held: { text: "Held — reached some groups", color: RED },
});

const sast = (ms) => (ms ? new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms)) : "");

/** Which buttons a group offers. Pure. */
export function actionsFor(g) {
  return {
    approve: g.status === "waiting" || (g.status === "approved" && g.newSinceApproval > 0),
    approveAgain: ["posted", "partly sold out", "sold out", "held"].includes(g.status),
    undo: g.status === "approved",
    canTick: g.status === "waiting" || g.status === "approved",
  };
}

function Thumb({ it, gkey, canTick, onTick, busy }) {
  const off = it.excluded;
  return (
    <button data-testid={`item-${gkey}-${it.pid}`} aria-pressed={!off} disabled={!canTick || busy} onClick={() => onTick(it, off)}
      title={`${it.name} — ${it.sizes} · ${it.qty} on hand`}
      style={{ all: "unset", cursor: canTick ? "pointer" : "default", display: "flex", flexDirection: "column", gap: 3, minWidth: 0, opacity: off ? 0.35 : 1 }}>
      <div style={{ position: "relative", aspectRatio: "1 / 1", borderRadius: 10, overflow: "hidden", background: "#0b0d12" }}>
        {it.photo && <img src={it.photo} alt={it.name} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
        <span style={{ position: "absolute", top: 4, left: 4, background: "rgba(0,0,0,.7)", borderRadius: 6, padding: "1px 5px", fontSize: 10 }}>{it.n}</span>
        {canTick && <span aria-hidden style={{ position: "absolute", top: 4, right: 4, width: 18, height: 18, borderRadius: 5, background: off ? "rgba(0,0,0,.6)" : GREEN, color: "#000", fontSize: 13, lineHeight: "18px", textAlign: "center", fontWeight: 800 }}>{off ? "" : "✓"}</span>}
        {it.newSinceApproval && <span style={{ position: "absolute", bottom: 4, left: 4, background: AMBER, color: "#000", borderRadius: 6, padding: "1px 5px", fontSize: 10, fontWeight: 700 }}>new</span>}
      </div>
      <span style={{ fontSize: 10, color: GRAY, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.name}</span>
      <span style={{ fontSize: 10, color: "#dfe7ff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.sizes} · {it.qty}</span>
    </button>
  );
}

function GroupRow({ g, busy, onApprove, onUndo, onTick }) {
  const [open, setOpen] = useState(false);
  const a = actionsFor(g);
  const st = STATUS[g.status] || { text: g.status, color: GRAY };
  const shown = open ? g.items : g.items.slice(0, 6);
  return (
    <div data-testid={`group-${g.key}`} style={{ ...GLASS, padding: 12, marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 18, fontWeight: 800, flex: 1 }}>{g.label}</div>
        <span data-testid={`status-${g.key}`} style={{ color: st.color, fontSize: 12, fontWeight: 700 }}>{st.text}</span>
      </div>
      <div style={{ color: GRAY, fontSize: 12, marginBottom: 8 }}>
        {g.included === g.count ? `${g.count} item${g.count === 1 ? "" : "s"}` : `${g.included} of ${g.count} items (${g.count - g.included} unticked)`}
        {g.newSinceApproval > 0 && <span style={{ color: AMBER }}> · {g.newSinceApproval} new since you approved</span>}
        {g.post?.at && <span> · posted {sast(g.post.at)}</span>}
        {g.postedEarlierAt && <span data-testid={`earlier-${g.key}`} style={{ color: AMBER }}> · already posted {sast(g.postedEarlierAt)} — approving again sends it once more</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(78px, 1fr))", gap: 8 }}>
        {shown.map((it) => <Thumb key={it.pid} it={it} gkey={g.key} canTick={a.canTick} busy={busy} onTick={(item, wasOff) => onTick(g, item, wasOff)} />)}
      </div>
      {g.items.length > 6 && (
        <button onClick={() => setOpen(!open)} style={{ ...bGray, marginTop: 8, padding: "6px 10px", fontSize: 12 }}>{open ? "Show fewer" : `Show all ${g.items.length}`}</button>
      )}
      {g.post?.dropped?.length > 0 && (
        <div data-testid={`dropped-${g.key}`} style={{ color: GRAY, fontSize: 11, marginTop: 8 }}>
          Dropped at send time: {g.post.dropped.map((d) => `${d.name} (${d.why})`).join(" · ")}
        </div>
      )}
      <details style={{ marginTop: 8 }}>
        <summary style={{ color: GRAY, fontSize: 12, cursor: "pointer" }}>Caption preview</summary>
        <pre data-testid={`caption-${g.key}`} style={{ whiteSpace: "pre-wrap", fontFamily: FONT, fontSize: 12, background: "rgba(255,255,255,.04)", borderRadius: 10, padding: 8, margin: "6px 0 0" }}>{g.caption}</pre>
      </details>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        {(a.approve || a.approveAgain) && (
          <button data-testid={`approve-${g.key}`} disabled={busy || g.included === 0} onClick={() => onApprove(g)} style={{ ...bGreen, flex: 1, opacity: busy || g.included === 0 ? 0.5 : 1 }}>
            {a.approveAgain ? "Approve again (posts once more)" : g.status === "approved" ? `Approve the ${g.newSinceApproval} new` : `Approve ${g.label}`}
          </button>
        )}
        {a.undo && <button data-testid={`undo-${g.key}`} disabled={busy} onClick={() => onUndo(g)} style={{ ...bGray }}>Undo</button>}
      </div>
    </div>
  );
}

export default function BlackFridayScreen({ api, onExit }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const load = useCallback(() => api.list().then((d) => { setData(d); setError(null); }, (e) => setError(e?.message || String(e))), [api]);
  useEffect(() => { load(); }, [load]);

  const replace = (views) => setData((d) => {
    if (!d) return d;
    const by = Object.fromEntries(views.filter(Boolean).map((v) => [v.key, v]));
    const groups = d.groups.map((g) => by[g.key] || g);
    const counts = {};
    for (const g of groups) counts[g.status] = (counts[g.status] || 0) + 1;
    return { ...d, groups, counts };
  });
  const run = async (fn) => {
    setBusy(true); setNote(null);
    try {
      const r = await fn();
      const results = r?.results || [r];
      replace(results.map((x) => x?.group));
      const refused = results.filter((x) => x && x.ok === false);
      if (refused.length) setNote(refused.map((x) => `${x.key}: ${x.refusal}`).join(" · "));
    } catch (e) { setNote(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const waiting = (data?.groups || []).filter((g) => g.status === "waiting" && g.included > 0);
  const m = data?.meta || {};
  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT, padding: "14px 14px 96px" }}>
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <button onClick={onExit} style={{ ...bGray, minHeight: 40, padding: "0 12px" }} aria-label="Back">←</button>
          <div style={{ fontSize: 20, fontWeight: 800, flex: 1 }}>Black Friday 🔥</div>
        </div>
        <div style={{ color: GRAY, fontSize: 12, marginBottom: 12 }}>
          Stock price only. Approved groups go to all 14 WhatsApp groups between 08:00 and 20:00, spread evenly until Fri 27 Nov. Each group is re-checked for stock just before it posts.
        </div>
        {error && <div data-testid="error" style={{ color: RED, fontSize: 13, marginBottom: 12 }}>{error} <button onClick={load} style={{ ...bGray, padding: "4px 8px", fontSize: 12 }}>Retry</button></div>}
        {!data && !error && <div style={{ color: GRAY }}>Loading…</div>}
        {data && (
          <>
            <div data-testid="summary" style={{ ...GLASS, padding: 12, marginBottom: 12, fontSize: 13 }}>
              <div><b>{m.eligible}</b> products with more than 12 on hand, in <b>{data.groups.length}</b> price groups{m.builtAt ? ` · built ${sast(m.builtAt)}` : ""}</div>
              <div style={{ color: GRAY, marginTop: 4 }}>
                {Object.entries(data.counts || {}).map(([k, n]) => `${n} ${(STATUS[k]?.text || k).toLowerCase()}`).join(" · ") || "No groups yet — the Mac mini builds them at 05:00."}
              </div>
              {waiting.length > 0 && (
                <button data-testid="approve-all" disabled={busy} onClick={() => run(() => api.approveAll(waiting.map((g) => g.key)))} style={{ ...bBlue, marginTop: 10, width: "100%", opacity: busy ? 0.5 : 1 }}>
                  Approve All ({waiting.length} group{waiting.length === 1 ? "" : "s"}, {waiting.reduce((a, g) => a + g.included, 0)} items)
                </button>
              )}
            </div>
            {note && <div data-testid="note" style={{ color: AMBER, fontSize: 12, marginBottom: 10 }}>{note}</div>}
            {data.groups.map((g) => (
              <GroupRow key={g.key} g={g} busy={busy}
                onApprove={(x) => run(() => api.approve(x.key))}
                onUndo={(x) => run(() => api.unapprove(x.key))}
                onTick={(x, it, wasOff) => run(() => api.tick(x.key, it.pid, wasOff))} />
            ))}
            {m.noPhotoCount > 0 && (
              <details data-testid="no-photo" style={{ ...GLASS, padding: 12, marginTop: 12 }}>
                <summary style={{ cursor: "pointer", fontSize: 13 }}>{m.noPhotoCount} product{m.noPhotoCount === 1 ? "" : "s"} with more than 12 on hand have no photo — not posted</summary>
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
