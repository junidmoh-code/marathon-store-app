// ─── NEW ARRIVALS — the card ─────────────────────────────────────────────────
// CALIBRATION (owner, 3 Oct): nothing is generated automatically. Uploads wait
// in New until Junid taps Generate (per item, or on a selection). The result
// lands in Ready with the checker's verdict shown as a LABEL only — it never
// blocks. Ready: Approve, Regenerate (a fresh attempt), or Reject with one tap
// on a reason chip. Rejected: Approve anyway, Regenerate, Skip. Skip — don't
// advertise — parks an item in Skipped until Restore. Every action is logged
// to the ledger by the callables. Every generation is shown, with its cost.
//
// After Approve the Mac mini agents set the photo, accept the suggested name,
// set condition Excellent, approve on the Shopify publisher, and the next
// 10:00 / 15:00 window posts to the groups.
//
// PAGED: every tab loads 30 at a time through the indexed list callable, with
// "Load more" and "Showing n of total". Reads and writes ONLY through `api`
// (newArrivalsApi.js → callables), so this file has no Firebase import and
// renders in tests with a fake api.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FONT, BG, GLASS, BLUE_L, GREEN, RED, GRAY, AMBER, bGreen, bGray, bBlue, tabOn, tabOff } from "../stock/ui";
import {
  TABS, REJECT_CHIPS, FILTER_CHIPS, CLASS_LABELS, priceText, sizesText, statusLine, destinationLines, actionsFor, whenText,
  shopifyNameLine, needsStockPrice, generationsOf, costText, totalCostZar, verdictText, stockText, agreementText, rejectRateText,
  toggleFilter, chipOn, filterActive,
} from "./newArrivalsView";

const REFRESH_MS = 30_000;
const PAGE = 30;
const RELOAD_CHUNK = 100;   // the callable's page ceiling
const BULK_CHUNK = 200;     // the callables take at most 300 pids a call

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

// Ready / Rejected: an item with NO stock price at all asks for one right
// here, through the Missing prices save (stock price only).
function PriceEntry({ item, busy, onSavePrice }) {
  const [cost, setCost] = useState("");
  if (!needsStockPrice(item.product)) return null;
  const input = { width: "100%", padding: "8px 10px", borderRadius: 10, border: "1px solid rgba(255,255,255,.2)", background: "rgba(0,0,0,.3)", color: "#fff", fontSize: 14, boxSizing: "border-box" };
  return (
    <div data-testid="price-entry" style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "flex-end" }}>
      <label style={{ flex: 1, color: GRAY, fontSize: 11 }}>Stock price (R)
        <input aria-label="Stock price" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} style={input} /></label>
      <button disabled={busy} onClick={() => onSavePrice(item, cost)} style={{ ...bBlue, opacity: busy ? 0.5 : 1 }}>Save price</button>
    </div>
  );
}

// EVERY generation, on every tab: the one shown big (currentGen, or the
// newest), then every earlier attempt as a thumbnail — each with its cost and
// the checker's label.
function Generations({ item, tab }) {
  const gens = generationsOf(item);
  const main = gens.find((g) => g.genId === item.currentGen) || gens[0] || null;
  const mainUrl = main?.url || item.generatedUrl || (tab === "done" ? item.product?.photoUrl : null);
  const earlier = gens.filter((g) => g !== main);
  const total = totalCostZar(item);
  return (
    <>
      <div style={{ display: "flex", gap: 8 }}>
        <Photo url={item.originalUrl || item.product?.photoUrlOriginal || item.product?.photoUrl} label="Original" />
        {(mainUrl || tab !== "new" || gens.length > 0) && <Photo url={mainUrl} label={main ? `Generated · ${costText(main)}` : "Generated"} />}
      </div>
      {earlier.length > 0 && (
        <div data-testid="earlier-generations" style={{ display: "flex", gap: 6, overflowX: "auto", marginTop: 8 }}>
          {earlier.map((g) => (
            <a key={g.genId} href={g.url} target="_blank" rel="noreferrer" style={{ flex: "0 0 72px", textDecoration: "none" }}>
              <img src={g.url} alt={`Earlier attempt ${whenText(g.at)}`} loading="lazy" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, display: "block", background: "#111" }} />
              <div style={{ color: GRAY, fontSize: 9, marginTop: 2 }}>{costText(g)}{g.verdict ? ` · ${g.verdict.pass ? "pass" : "failed"}` : ""}</div>
            </a>
          ))}
        </div>
      )}
      {gens.length > 0 && (
        <div style={{ color: GRAY, fontSize: 11, marginTop: 6 }}>
          {gens.length} {gens.length === 1 ? "generation" : "generations"}{total !== null ? ` · R${total.toFixed(2)} total` : ""}
        </div>
      )}
    </>
  );
}

function ItemCard({ item, tab, busy, selectable, selected, onToggle, h }) {
  const p = item.product || {};
  const acts = actionsFor(item);
  const statusColour = item.status === "rejected" ? RED : item.status === "ready" ? GREEN : item.status === "done" ? GREEN : item.status === "skipped" ? GRAY : AMBER;
  const verdict = verdictText(item.verdict);
  const dim = { opacity: busy ? 0.5 : 1 };
  const chip = { ...bGray, padding: "6px 10px", fontSize: 12, ...dim };
  return (
    <div data-pid={item.pid} style={{ ...GLASS, padding: 12, marginBottom: 12 }}>
      {selectable && (
        <label style={{ display: "flex", alignItems: "center", gap: 8, color: GRAY, fontSize: 12, marginBottom: 8 }}>
          <input type="checkbox" aria-label={`Select ${p.name || item.name || item.pid}`} checked={!!selected} onChange={() => onToggle(item.pid)} />
          Select
        </label>
      )}
      <Generations item={item} tab={tab} />
      <div style={{ marginTop: 10, color: "#fff", fontWeight: 700, fontSize: 15 }}>{p.name || item.name}</div>
      {shopifyNameLine(item) && (
        <div style={{ color: item.suggestedName ? BLUE_L : GRAY, fontSize: 13, marginTop: 2 }}>{shopifyNameLine(item)}</div>
      )}
      <div style={{ color: "#dfe7ff", fontSize: 13, marginTop: 4 }}>
        {needsStockPrice(p) ? "No stock price" : `${priceText(p.stockPrice)} for the groups`} · Sizes {sizesText(p.sizes)}
      </div>
      <div data-testid="stock" style={{ color: "#dfe7ff", fontSize: 13, marginTop: 2 }}>{stockText(item)}</div>
      {verdict && <div data-testid="verdict" style={{ color: item.verdict?.pass ? GREEN : AMBER, fontSize: 12, marginTop: 4 }}>{verdict}</div>}
      {item.framingFlag === true && <div style={{ color: AMBER, fontSize: 12, marginTop: 2 }}>Framing still off after the automatic correction</div>}
      <div data-testid="status" style={{ color: statusColour, fontSize: 12, marginTop: 6 }}>{statusLine(item)}</div>
      {(tab === "ready" || tab === "rejected") && h.onSavePrice && <PriceEntry item={item} busy={busy} onSavePrice={h.onSavePrice} />}
      {tab === "done" && destinationLines(item).map((l) => (
        <div key={l} style={{ color: GRAY, fontSize: 12, marginTop: 3 }}>{l}</div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        {acts.approve && <button disabled={busy} onClick={() => h.onApprove(item.pid)} style={{ ...bGreen, flex: 1, ...dim }}>Approve</button>}
        {acts.approveAnyway && <button disabled={busy} onClick={() => h.onApproveAnyway(item.pid)} style={{ ...bGreen, flex: 1, ...dim }}>Approve anyway</button>}
        {acts.generate && <button disabled={busy} onClick={() => h.onGenerate([item.pid])} style={{ ...bBlue, flex: 1, ...dim }}>Generate</button>}
        {acts.regenerate && <button disabled={busy} onClick={() => h.onRegenerate(item.pid)} style={{ ...bBlue, flex: 1, ...dim }}>Regenerate</button>}
        {acts.skip && <button disabled={busy} onClick={() => h.onSkip([item.pid])} style={{ ...bGray, flex: 1, ...dim }}>Skip — don't advertise</button>}
        {acts.restore && <button disabled={busy} onClick={() => h.onRestore([item.pid])} style={{ ...bBlue, flex: 1, ...dim }}>Restore to New</button>}
      </div>
      {acts.reject && (
        <div data-testid="reject-chips" style={{ marginTop: 8 }}>
          <div style={{ color: GRAY, fontSize: 11, marginBottom: 4 }}>Reject — tap the reason:</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {REJECT_CHIPS.map((r) => <button key={r} disabled={busy} onClick={() => h.onReject(item.pid, r)} style={chip}>{r}</button>)}
          </div>
        </div>
      )}
      <div style={{ color: "rgba(255,255,255,.3)", fontSize: 10, marginTop: 8 }}>{item.pid} · uploaded {whenText(item.enqueuedAt)}</div>
    </div>
  );
}

const EMPTY = { items: null, total: null, nextCursor: null, tabCounts: {}, stats: null, modes: {}, matchingPids: null };
const chunks = (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

export default function NewArrivalsScreen({ api, onExit, initialTab = "ready" }) {
  const [tab, setTab] = useState(initialTab);
  const [filter, setFilter] = useState({});
  const [data, setData] = useState(EMPTY);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  // A response for a view (tab + filter) no longer shown, or overtaken by a
  // newer request, is dropped — it must never paint the wrong tab's items.
  const viewKey = (t, f) => `${t}|${t === "new" ? JSON.stringify(f || {}) : ""}`;
  const loadSeq = useRef(0);
  const activeView = useRef(viewKey(tab, filter));
  const loaded = useRef(0);
  // Track the view whose render COMMITTED (not one merely being rendered).
  useLayoutEffect(() => { activeView.current = viewKey(tab, filter); }, [tab, filter]);
  useLayoutEffect(() => { loaded.current = data.items ? data.items.length : 0; }, [data.items]);

  const filterFor = (t, f) => (t === "new" && filterActive(f) ? f : null);

  // (Re)load from the top, as many items as are on screen now (at least a page).
  const load = useCallback(async (which = tab, f = filter) => {
    const seq = ++loadSeq.current;
    const key = viewKey(which, f);
    const stale = () => seq !== loadSeq.current || key !== activeView.current;
    const wanted = Math.max(PAGE, loaded.current);
    try {
      let res = null, cursor = null;
      const acc = [];
      do {
        res = await api.list(which, { cursor, limit: Math.min(RELOAD_CHUNK, Math.max(PAGE, wanted - acc.length)), filter: filterFor(which, f) });
        if (stale()) return;
        acc.push(...(res.items || []));
        cursor = res.nextCursor || null;
      } while (cursor && acc.length < wanted);
      setData({
        items: acc, total: Number.isFinite(res.total) ? res.total : acc.length, nextCursor: cursor,
        tabCounts: res.tabCounts || {}, stats: res.stats || null, modes: res.modes || {}, matchingPids: res.matchingPids || null,
      });
    } catch (e) {
      if (stale()) return;
      setMsg(`Couldn't load: ${e?.message || e}`);
      setData((d) => ({ ...d, items: d.items || [] }));
    }
  }, [api, tab, filter]);

  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = async () => {
    if (!data.nextCursor || loadingMore) return;
    const seq = ++loadSeq.current;
    const key = viewKey(tab, filter);
    setLoadingMore(true);
    try {
      const res = await api.list(tab, { cursor: data.nextCursor, limit: PAGE, filter: filterFor(tab, filter) });
      if (seq !== loadSeq.current || key !== activeView.current) return;
      setData((d) => {
        const have = new Set((d.items || []).map((i) => i.pid));
        return {
          ...d, items: [...(d.items || []), ...(res.items || []).filter((i) => !have.has(i.pid))],
          total: Number.isFinite(res.total) ? res.total : d.total, nextCursor: res.nextCursor || null,
          tabCounts: res.tabCounts || d.tabCounts, stats: res.stats || d.stats, matchingPids: res.matchingPids || d.matchingPids,
        };
      });
    } catch (e) {
      setMsg(`Couldn't load more: ${e?.message || e}`);
    } finally { setLoadingMore(false); }
  };

  useEffect(() => {
    loaded.current = 0;
    setData((d) => ({ ...d, items: null, total: null, nextCursor: null, matchingPids: null }));
    setSelected(new Set());
    load(tab, filter);
    const t = setInterval(() => load(tab, filter), REFRESH_MS);
    return () => clearInterval(t);
  }, [tab, filter, load]);

  const items = data.items;
  const run = async (fn, okText, notWord = "done") => {
    setBusy(true); setMsg(null);
    try {
      const res = await fn();
      const refused = res?.skipped?.length ? ` · ${res.skipped.length} not ${notWord} (${[...new Set(res.skipped.map((s) => s.why))].join("; ")})` : "";
      setMsg(okText(res) + refused);
      setSelected(new Set());
      await load(tab, filter);
    } catch (e) {
      setMsg(`Not done: ${e?.message || e}`);
    } finally { setBusy(false); }
  };
  // A bulk action in callable-sized chunks, results merged.
  const bulk = (fn, pids) => async () => {
    const merged = {};
    for (const part of chunks(pids, BULK_CHUNK)) {
      const r = (await fn(part)) || {};
      for (const [k, v] of Object.entries(r)) merged[k] = Array.isArray(v) ? [...(merged[k] || []), ...v] : v;
    }
    return merged;
  };
  const n = (r, k) => r?.[k]?.length || 0;

  const h = {
    onApprove: (pid) => run(() => api.approve([pid]), (r) => (n(r, "approved") ? "Approved — publishing has started. Its progress, or any refusal, shows under Done or Rejected." : "Nothing approved."), "approved"),
    onApproveAnyway: (pid) => run(() => api.approve([pid], { anyway: true }), (r) => (n(r, "approved") ? "Approved anyway — publishing has started." : "Nothing approved."), "approved"),
    onGenerate: (pids) => run(bulk((p) => api.generate(p), pids), (r) => `${n(r, "requested")} sent to the generator — results land in Ready.`),
    onRegenerate: (pid) => run(() => api.generate([pid], { regenerate: true }), (r) => (n(r, "requested") ? "A fresh attempt is requested — it lands in Ready." : "Nothing requested.")),
    onReject: (pid, reason) => run(() => api.reject(pid, reason), () => `Rejected: ${reason}.`),
    onSkip: (pids) => run(bulk((p) => api.skip(p), pids), (r) => `${n(r, "skippedPids")} skipped — never advertised; find them under Skipped.`),
    onRestore: (pids) => run(bulk((p) => api.restore(p), pids), (r) => `${n(r, "restored")} back in New.`),
  };

  // Approve all = every item ON THIS SCREEN that has a stock price — never
  // items Junid has not seen (actionsFor gates on the stock price).
  const onApproveAll = () => {
    const pids = (data.items || []).filter((it) => actionsFor(it).approve).map((it) => it.pid);
    if (!pids.length) return;
    if (typeof window !== "undefined" && window.confirm && !window.confirm(`Approve all ${pids.length} items shown? Publishing to Shopify and the groups starts for each; any that Shopify refuses will show in Rejected.`)) return;
    run(() => api.approve(pids), (r) => `Approved ${n(r, "approved")}.`, "approved");
  };
  const approvable = (items || []).filter((it) => actionsFor(it).approve).length;
  const unpriced = tab === "ready" ? (items || []).filter((it) => needsStockPrice(it.product)).length : 0;
  h.onSavePrice = api.savePrice ? async (item, cost) => {
    setBusy(true); setMsg(null);
    try {
      let res = await api.savePrice(item.pid, item.product || {}, cost);
      // Retail below this cost: the same question the Missing prices editor asks.
      if (!res.ok && res.needsConfirm && typeof window !== "undefined" && window.confirm && window.confirm(res.error)) {
        res = await api.savePrice(item.pid, item.product || {}, cost, { confirmed: true });
      }
      setMsg(res.ok ? "Stock price saved — Approve is now open." : `Price not saved: ${res.error}`);
      if (res.ok) await load(tab, filter);
    } catch (e) {
      setMsg(`Price not saved: ${e?.message || e}`);
    } finally { setBusy(false); }
  } : null;

  const selectable = tab === "new" || tab === "skipped";
  const toggle = (pid) => setSelected((s) => { const x = new Set(s); if (x.has(pid)) x.delete(pid); else x.add(pid); return x; });
  // "Select all" = every item the (filtered) tab holds, across pages — the
  // server's list, not just what is loaded.
  const allPids = data.matchingPids || (items || []).map((i) => i.pid);
  const sel = [...selected];
  const stats = data.stats;

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT, padding: "16px 16px 80px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <button onClick={onExit} style={{ ...bGray, padding: "8px 12px" }} aria-label="Back">←</button>
        <div style={{ fontSize: 20, fontWeight: 800 }}>New Arrivals</div>
      </div>
      <div data-testid="agreement" style={{ color: GRAY, fontSize: 12, marginBottom: 12 }}>
        Agreement with you: {Object.entries(CLASS_LABELS).map(([cls, l]) => `${l} ${agreementText(stats, cls)}${data.modes?.[cls] === "auto" ? " (auto)" : ""}`).join(" · ")}
        <div data-testid="reject-rate" style={{ marginTop: 2 }}>{rejectRateText(stats)}</div>
      </div>
      <div role="tablist" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} style={tab === t.key ? tabOn : tabOff}>
            {t.label}{Number.isFinite(data.tabCounts[t.key]) ? ` ${data.tabCounts[t.key]}` : ""}
          </button>
        ))}
      </div>
      {tab === "new" && (
        <div data-testid="filters" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {FILTER_CHIPS.map((c) => (
            <button key={c.key} aria-pressed={chipOn(filter, c.key)} onClick={() => setFilter((f) => toggleFilter(f, c.key))}
              style={{ ...(chipOn(filter, c.key) ? tabOn : tabOff), padding: "6px 10px", fontSize: 12 }}>{c.label}</button>
          ))}
        </div>
      )}
      {selectable && items && allPids.length > 0 && (
        <div data-testid="bulk" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <button disabled={busy} onClick={() => setSelected(new Set(allPids))} style={{ ...bGray, ...{ opacity: busy ? 0.5 : 1 } }}>Select all {allPids.length}</button>
          {sel.length > 0 && <button onClick={() => setSelected(new Set())} style={bGray}>Clear selection</button>}
          {tab === "new" && sel.length > 0 && <button disabled={busy} onClick={() => h.onGenerate(sel)} style={{ ...bBlue, opacity: busy ? 0.5 : 1 }}>Generate selected ({sel.length})</button>}
          {tab === "new" && sel.length > 0 && <button disabled={busy} onClick={() => h.onSkip(sel)} style={{ ...bGray, opacity: busy ? 0.5 : 1 }}>Skip selected ({sel.length})</button>}
          {tab === "skipped" && sel.length > 0 && <button disabled={busy} onClick={() => h.onRestore(sel)} style={{ ...bBlue, opacity: busy ? 0.5 : 1 }}>Restore selected ({sel.length})</button>}
        </div>
      )}
      {tab === "ready" && approvable > 0 && (
        <button disabled={busy} onClick={onApproveAll} style={{ ...bGreen, width: "100%", marginBottom: 12, opacity: busy ? 0.5 : 1 }}>
          Approve all {approvable}
        </button>
      )}
      {unpriced > 0 && (
        <div data-testid="unpriced-flag" style={{ ...GLASS, padding: 10, marginBottom: 12, fontSize: 13, color: AMBER }}>
          {unpriced} {unpriced === 1 ? "item has" : "items have"} no stock price — enter it on the card to approve.
        </div>
      )}
      {msg && <div role="status" style={{ ...GLASS, padding: 10, marginBottom: 12, fontSize: 13 }}>{msg}</div>}
      {items === null && <div style={{ color: GRAY }}>Loading…</div>}
      {items && items.length === 0 && <div style={{ color: GRAY }}>Nothing here.</div>}
      {items && items.length > 0 && (
        <div data-testid="count" style={{ color: GRAY, fontSize: 12, marginBottom: 8 }}>
          Showing {items.length} of {Number.isFinite(data.total) ? data.total : items.length}{sel.length ? ` · ${sel.length} selected` : ""}
        </div>
      )}
      {items && items.map((it) => (
        <ItemCard key={it.pid} item={it} tab={tab} busy={busy} selectable={selectable} selected={selected.has(it.pid)} onToggle={toggle} h={h} />
      ))}
      {items && data.nextCursor && (
        <button disabled={loadingMore} onClick={loadMore} style={{ ...bGray, width: "100%", opacity: loadingMore ? 0.5 : 1 }}>
          {loadingMore ? "Loading…" : `Load more (${items.length} of ${data.total ?? "?"} loaded)`}
        </button>
      )}
    </div>
  );
}
