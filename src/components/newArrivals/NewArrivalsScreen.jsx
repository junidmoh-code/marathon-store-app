// ─── NEW ARRIVALS — the card ─────────────────────────────────────────────────
// Every upload lands in New by itself. The Mac mini generates the photo on a
// fixed background plate, checks it against the original, and puts it in Ready
// or Rejected. Junid's Approve is the ONLY human step; after it the agents set
// the photo, accept the suggested name, set condition Excellent, approve on the
// Shopify publisher, and the next 10:00 / 15:00 window posts to the groups.
//
// Reads and writes ONLY through `api` (newArrivalsApi.js → callables), so this
// file has no Firebase import and renders in tests with a fake api.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FONT, BG, GLASS, BLUE_L, GREEN, RED, GRAY, AMBER, bGreen, bGray, bBlue, tabOn, tabOff } from "../stock/ui";
import { TABS, priceText, sizesText, statusLine, destinationLines, actionsFor, whenText, shopifyNameLine } from "./newArrivalsView";

const REFRESH_MS = 30_000;

function Photo({ url, label }) {
  return (
    <figure style={{ margin: 0, flex: 1, minWidth: 0 }}>
      {url
        ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={label} loading="lazy" style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 12, display: "block", background: "#111" }} /></a>
        : <div style={{ width: "100%", aspectRatio: "1 / 1", borderRadius: 12, background: "#111", color: GRAY, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>No photo</div>}
      <figcaption style={{ color: GRAY, fontSize: 11, marginTop: 4, textAlign: "center" }}>{label}</figcaption>
    </figure>
  );
}

function ItemCard({ item, tab, busy, onApprove, onRetry }) {
  const p = item.product || {};
  const acts = actionsFor(item);
  const original = item.originalUrl || p.photoUrlOriginal || p.photoUrl;
  const statusColour = item.status === "rejected" ? RED : item.status === "ready" ? GREEN : item.status === "done" ? GREEN : AMBER;
  return (
    <div data-pid={item.pid} style={{ ...GLASS, padding: 12, marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <Photo url={original} label="Original" />
        {(tab !== "new") && <Photo url={item.generatedUrl || (tab === "done" ? p.photoUrl : null)} label="Generated" />}
      </div>
      <div style={{ marginTop: 10, color: "#fff", fontWeight: 700, fontSize: 15 }}>{p.name || item.name}</div>
      {shopifyNameLine(item) && (
        <div style={{ color: item.suggestedName ? BLUE_L : GRAY, fontSize: 13, marginTop: 2 }}>{shopifyNameLine(item)}</div>
      )}
      <div style={{ color: "#dfe7ff", fontSize: 13, marginTop: 4 }}>
        {priceText(p.retailPrice)} · Sizes {sizesText(p.sizes)}
      </div>
      <div data-testid="status" style={{ color: statusColour, fontSize: 12, marginTop: 6 }}>{statusLine(item)}</div>
      {tab === "done" && destinationLines(item).map((l) => (
        <div key={l} style={{ color: GRAY, fontSize: 12, marginTop: 3 }}>{l}</div>
      ))}
      {(acts.approve || acts.retry) && (
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          {acts.approve && <button disabled={busy} onClick={() => onApprove(item.pid)} style={{ ...bGreen, flex: 1, opacity: busy ? 0.5 : 1 }}>Approve</button>}
          {acts.retry && <button disabled={busy} onClick={() => onRetry(item.pid)} style={{ ...bBlue, flex: 1, opacity: busy ? 0.5 : 1 }}>Retry — fresh generation</button>}
        </div>
      )}
      <div style={{ color: "rgba(255,255,255,.3)", fontSize: 10, marginTop: 8 }}>{item.pid} · uploaded {whenText(item.enqueuedAt)}</div>
    </div>
  );
}

export default function NewArrivalsScreen({ api, onExit, initialTab = "ready" }) {
  const [tab, setTab] = useState(initialTab);
  const [data, setData] = useState({ items: null, tabCounts: {} });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  // A response for a tab no longer shown, or overtaken by a newer request,
  // is dropped — it must never paint the wrong tab's items and buttons.
  const loadSeq = useRef(0);
  const activeTab = useRef(tab);
  // Track the tab whose render COMMITTED (not one merely being rendered).
  useLayoutEffect(() => { activeTab.current = tab; }, [tab]);
  const load = useCallback(async (which = tab) => {
    const seq = ++loadSeq.current;
    const stale = () => seq !== loadSeq.current || which !== activeTab.current;
    try {
      const res = await api.list(which);
      if (stale()) return;
      setData({ items: res.items || [], tabCounts: res.tabCounts || {} });
    } catch (e) {
      if (stale()) return;
      setMsg(`Couldn't load: ${e?.message || e}`);
      setData((d) => ({ ...d, items: d.items || [] }));
    }
  }, [api, tab]);

  useEffect(() => {
    setData((d) => ({ ...d, items: null }));
    load(tab);
    const t = setInterval(() => load(tab), REFRESH_MS);
    return () => clearInterval(t);
  }, [tab, load]);

  const items = data.items;
  const run = async (fn, okText) => {
    setBusy(true); setMsg(null);
    try {
      const res = await fn();
      const skipped = res?.skipped?.length ? ` · ${res.skipped.length} not approved (${res.skipped.map((s) => s.why).join("; ")})` : "";
      setMsg(okText(res) + skipped);
      await load(activeTab.current);
    } catch (e) {
      setMsg(`Not done: ${e?.message || e}`);
    } finally { setBusy(false); }
  };

  const onApprove = (pid) => run(() => api.approve([pid]), (r) => (r?.approved?.length ? "Approved — publishing has started. Its progress, or any refusal, shows under Done or Rejected." : "Nothing approved."));
  // Approve all = every item ON THIS SCREEN — never items Junid has not seen.
  const onApproveAll = () => {
    const pids = (data.items || []).filter((it) => actionsFor(it).approve).map((it) => it.pid);
    if (!pids.length) return;
    if (typeof window !== "undefined" && window.confirm && !window.confirm(`Approve all ${pids.length} items shown? Publishing to Shopify and the groups starts for each; any that Shopify refuses will show in Rejected.`)) return;
    run(() => api.approve(pids), (r) => `Approved ${r?.approved?.length || 0}.`);
  };
  const approvable = (items || []).filter((it) => actionsFor(it).approve).length;
  const onRetry = (pid) => run(() => api.retry(pid), () => "Sent back to New — a completely fresh photo will be generated.");

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT, padding: "16px 16px 80px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <button onClick={onExit} style={{ ...bGray, padding: "8px 12px" }} aria-label="Back">←</button>
        <div style={{ fontSize: 20, fontWeight: 800 }}>New Arrivals</div>
      </div>
      <div role="tablist" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} style={tab === t.key ? tabOn : tabOff}>
            {t.label}{Number.isFinite(data.tabCounts[t.key]) ? ` ${data.tabCounts[t.key]}` : ""}
          </button>
        ))}
      </div>
      {tab === "ready" && approvable > 0 && (
        <button disabled={busy} onClick={onApproveAll} style={{ ...bGreen, width: "100%", marginBottom: 12, opacity: busy ? 0.5 : 1 }}>
          Approve all {approvable}
        </button>
      )}
      {msg && <div role="status" style={{ ...GLASS, padding: 10, marginBottom: 12, fontSize: 13 }}>{msg}</div>}
      {items === null && <div style={{ color: GRAY }}>Loading…</div>}
      {items && items.length === 0 && <div style={{ color: GRAY }}>Nothing here.</div>}
      {items && items.map((it) => (
        <ItemCard key={it.pid} item={it} tab={tab} busy={busy} onApprove={onApprove} onRetry={onRetry} />
      ))}
    </div>
  );
}
