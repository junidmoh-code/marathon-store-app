// ─── NEW ARRIVALS — the card ─────────────────────────────────────────────────
// CALIBRATION (owner, 3 Oct): nothing is generated automatically. Uploads wait
// in New until Junid taps Generate (per item, or on a selection). The result
// lands in Ready with the checker's verdict shown as a LABEL only — it never
// blocks. Ready: Approve, Regenerate (a fresh attempt), or Reject with one tap
// on a reason chip. Rejected: Approve anyway, Regenerate, Skip. Skip — don't
// advertise — is one tap: the item leaves the list (marked "skipped" in the
// data, never deleted, never generated, posted or published) and an 8-second
// Undo toast can bring it back. There is no Skipped tab. Every action is
// logged to the ledger by the callables. Every generation is shown, with its cost
// (metered, or "~R… (estimated)" — never unknown); any of them can be made the
// main photo with "Use this one" (logged as a pick).
//
// PRICES: every New / Ready / Rejected card has "Stock price (R)" and "Retail
// price (R)", pre-filled, one Save — through the admin price save
// (admin/productPriceSave.js), the product's REAL price fields. The stock
// price is what the WhatsApp groups are posted at; retail is for the shops and
// the website. Approve is always shown on Ready; without a stock price it is
// disabled, with "add stock price first" by the price fields.
//
// After Approve the Mac mini agents set the photo, accept the suggested name,
// set condition Excellent, approve on the Shopify publisher, and the next
// 10:00 / 15:00 window posts to the groups.
//
// GROUPS: New, Ready and Rejected show ONE group at a time — Sneakers or
// Clothing — flipped with the switcher bar (‹ › or a swipe); the last group is
// remembered on the device (default Sneakers). Done is the whole history.
//
// PAGED: every list loads 30 at a time through the indexed list callable, with
// "Load more" and "Showing n of total". Reads and writes ONLY through `api`
// (newArrivalsApi.js → callables), so this file has no Firebase import and
// renders in tests with a fake api.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FONT, BG, GLASS, BLUE_L, GREEN, RED, GRAY, AMBER, bGreen, bGray, bBlue, tabOn, tabOff } from "../stock/ui";
import {
  TABS, REJECT_CHIPS, CLASS_LABELS, priceText, sizesText, statusLine, destinationLines, actionsFor, whenText,
  shopifyNameLine, needsStockPrice, PRICE_TABS, priceField, changedPrices, UNDO_MS, generationsOf, costText, totalCostText, spentText, canPick, currentGenId, verdictText, stockText, agreementText, rejectRateText,
  isGroupTab, groupLabel, stepGroup, rememberedGroup, rememberGroup,
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

// The two price fields, pre-filled with the product's prices, one Save. Only
// the fields changed are sent. On Ready without a stock price, the note
// "add stock price first" sits here, next to the (disabled) Approve.
function PriceFields({ item, busy, onSavePrices, needNote }) {
  const p = item.product || {};
  const [stock, setStock] = useState(priceField(p.stockPrice));
  const [retail, setRetail] = useState(priceField(p.retailPrice));
  // A save (or a price set elsewhere) reloads the item: the fields follow.
  useEffect(() => { setStock(priceField(p.stockPrice)); }, [p.stockPrice]);
  useEffect(() => { setRetail(priceField(p.retailPrice)); }, [p.retailPrice]);
  const drafts = changedPrices(p, stock, retail);
  const changed = Object.keys(drafts).length > 0;
  const input = { width: "100%", padding: "8px 10px", borderRadius: 10, border: "1px solid rgba(255,255,255,.2)", background: "rgba(0,0,0,.3)", color: "#fff", fontSize: 14, boxSizing: "border-box", marginTop: 3 };
  return (
    <div data-testid="price-fields" style={{ marginTop: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <label style={{ flex: 1, color: GRAY, fontSize: 11 }}>Stock price (R)
          <input aria-label="Stock price (R)" inputMode="decimal" value={stock} disabled={busy} onChange={(e) => setStock(e.target.value)} style={input} /></label>
        <label style={{ flex: 1, color: GRAY, fontSize: 11 }}>Retail price (R)
          <input aria-label="Retail price (R)" inputMode="decimal" value={retail} disabled={busy} onChange={(e) => setRetail(e.target.value)} style={input} /></label>
        <button disabled={busy || !changed} onClick={() => onSavePrices(item, drafts)} style={{ ...bBlue, opacity: busy || !changed ? 0.5 : 1 }}>Save</button>
      </div>
      <div style={{ color: GRAY, fontSize: 10, marginTop: 4 }}>Stock price posts to the WhatsApp groups · retail is for the shops and the website</div>
      {needNote && <div data-testid="approve-note" style={{ color: AMBER, fontSize: 12, marginTop: 4 }}>add stock price first</div>}
    </div>
  );
}

// EVERY generation, on every tab: the one shown big (currentGen, or the
// newest) marked "Main photo", then every earlier attempt as a thumbnail —
// each with its cost and the checker's label. On Ready and Rejected every
// thumbnail (checker-failed ones and re-checks too) has "Use this one", which
// makes it the main photo — Approve then uses it.
function Generations({ item, tab, stats, busy, onPick, onApproveGen = null, approveEnabled = false }) {
  const gens = generationsOf(item);
  const mainId = currentGenId(item);
  const main = gens.find((g) => g.genId === mainId) || null;
  const mainUrl = main?.url || item.generatedUrl || (tab === "done" ? item.product?.photoUrl : null);
  const earlier = gens.filter((g) => g !== main);
  const total = totalCostText(item, stats);
  return (
    <>
      <div style={{ display: "flex", gap: 8 }}>
        <Photo url={item.originalUrl || item.product?.photoUrlOriginal || item.product?.photoUrl} label="Original" />
        {(mainUrl || tab !== "new" || gens.length > 0) && <Photo url={mainUrl} label={main ? `Generated${earlier.length ? " · Main photo" : ""} · ${costText(main, stats)}` : "Generated"} />}
      </div>
      {earlier.length > 0 && (
        <div data-testid="earlier-generations" style={{ display: "flex", gap: 6, overflowX: "auto", marginTop: 8 }}>
          {earlier.map((g) => (
            <div key={g.genId} data-gen={g.genId} style={{ flex: "0 0 84px" }}>
              <a href={g.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                <img src={g.url} alt={`Earlier attempt ${whenText(g.at)}`} loading="lazy" style={{ width: 84, height: 84, objectFit: "cover", borderRadius: 8, display: "block", background: "#111" }} />
              </a>
              <div style={{ color: GRAY, fontSize: 9, marginTop: 2 }}>{costText(g, stats)}{g.verdict ? ` · ${g.verdict.pass ? "pass" : "failed"}` : ""}</div>
              {onPick && canPick(item, g) && (
                <button disabled={busy} onClick={() => onPick(item.pid, g.genId)}
                  style={{ ...bBlue, width: "100%", padding: "5px 4px", fontSize: 11, marginTop: 3, opacity: busy ? 0.5 : 1 }}>Use this one</button>
              )}
              {onApproveGen && item.status === "rejected" && g.url && (
                <button data-testid="approve-gen" disabled={busy || !approveEnabled} onClick={() => onApproveGen(item.pid, g.genId)}
                  title={approveEnabled ? undefined : "add stock price first"}
                  style={{ ...bGreen, width: "100%", padding: "5px 4px", fontSize: 11, marginTop: 3, opacity: busy || !approveEnabled ? 0.4 : 1 }}>Approve anyway</button>
              )}
            </div>
          ))}
        </div>
      )}
      {gens.length > 0 && (
        <div data-testid="gen-total" style={{ color: GRAY, fontSize: 11, marginTop: 6 }}>
          {gens.length} {gens.length === 1 ? "generation" : "generations"}{total ? ` · ${total}` : ""}
        </div>
      )}
    </>
  );
}

function ItemCard({ item, tab, busy, selectable, selected, onToggle, h, stats }) {
  const p = item.product || {};
  const acts = actionsFor(item);
  const statusColour = item.status === "rejected" ? RED : item.status === "ready" ? GREEN : item.status === "done" ? GREEN : AMBER;
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
      <Generations item={item} tab={tab} stats={stats} busy={busy} onPick={(tab === "ready" || tab === "rejected") ? h.onPick : null}
        onApproveGen={tab === "rejected" ? h.onApproveGen : null} approveEnabled={acts.approveAnywayEnabled} />
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
      {PRICE_TABS.includes(tab) && h.onSavePrices && (
        <PriceFields item={item} busy={busy} onSavePrices={h.onSavePrices} needNote={(acts.approve || acts.approveAnyway) && needsStockPrice(p)} />
      )}
      {tab === "done" && destinationLines(item).map((l) => (
        <div key={l} style={{ color: GRAY, fontSize: 12, marginTop: 3 }}>{l}</div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        {acts.approve && (
          <button disabled={busy || !acts.approveEnabled} onClick={() => h.onApprove(item.pid)}
            title={acts.approveEnabled ? undefined : "add stock price first"}
            style={{ ...bGreen, flex: 1, opacity: busy || !acts.approveEnabled ? 0.4 : 1 }}>Approve</button>
        )}
        {acts.approveAnyway && (
          <button disabled={busy || !acts.approveAnywayEnabled} onClick={() => h.onApproveAnyway(item.pid)}
            title={acts.approveAnywayEnabled ? undefined : "add stock price first"}
            style={{ ...bGreen, flex: 1, opacity: busy || !acts.approveAnywayEnabled ? 0.4 : 1 }}>Approve anyway</button>
        )}
        {acts.generate && <button disabled={busy} onClick={() => h.onGenerate([item.pid])} style={{ ...bBlue, flex: 1, ...dim }}>Generate</button>}
        {acts.regenerate && <button disabled={busy} onClick={() => h.onRegenerate(item.pid)} style={{ ...bBlue, flex: 1, ...dim }}>Regenerate</button>}
        {acts.skip && <button disabled={busy} onClick={() => h.onSkip([item.pid])} style={{ ...bGray, flex: 1, ...dim }}>Skip — don't advertise</button>}
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

// The switcher bar: a full-width dark pill, a circular ‹ on the left and › on
// the right, the group's name and count centred. An arrow with nowhere further
// to go is dimmed (and disabled). A horizontal swipe on the bar flips too.
const SWIPE_PX = 40;
function GroupSwitcher({ group, count, onStep }) {
  const startX = useRef(null);
  const canPrev = stepGroup(group, -1) !== null;
  const canNext = stepGroup(group, 1) !== null;
  const circle = (on) => ({
    width: 40, height: 40, flex: "0 0 40px", borderRadius: "50%", border: "1px solid rgba(255,255,255,.18)",
    background: "rgba(255,255,255,.08)", color: "#fff", fontSize: 22, lineHeight: "36px", padding: 0, fontFamily: FONT,
    cursor: on ? "pointer" : "default", opacity: on ? 1 : 0.25,
  });
  return (
    <div data-testid="group-switcher"
      onTouchStart={(e) => { startX.current = e.touches?.[0]?.clientX ?? null; }}
      onTouchEnd={(e) => {
        const x0 = startX.current; startX.current = null;
        const x1 = e.changedTouches?.[0]?.clientX;
        if (x0 == null || x1 == null) return;
        if (x1 - x0 <= -SWIPE_PX) onStep(1); else if (x1 - x0 >= SWIPE_PX) onStep(-1);
      }}
      style={{ ...GLASS, borderRadius: 999, display: "flex", alignItems: "center", gap: 8, width: "100%", boxSizing: "border-box",
        padding: 6, marginBottom: 12, touchAction: "pan-y", userSelect: "none" }}>
      <button aria-label="Previous group" disabled={!canPrev} onClick={() => onStep(-1)} style={circle(canPrev)}>‹</button>
      <div data-testid="group-name" aria-live="polite" style={{ flex: 1, textAlign: "center", color: "#fff", fontWeight: 800, fontSize: 15 }}>
        {`${groupLabel(group)} · ${Number.isFinite(count) ? count : "…"}`}
      </div>
      <button aria-label="Next group" disabled={!canNext} onClick={() => onStep(1)} style={circle(canNext)}>›</button>
    </div>
  );
}

const EMPTY = { items: null, total: null, nextCursor: null, tabCounts: {}, groupCounts: null, stats: null, modes: {}, matchingPids: null };
// localStorage, or null where it is absent or its accessor throws.
const deviceStorage = () => { try { return globalThis.localStorage || null; } catch { return null; } };
const chunks = (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

export default function NewArrivalsScreen({ api, onExit, initialTab = "ready", storage = deviceStorage() }) {
  const [tab, setTab] = useState(initialTab);
  const [group, setGroup] = useState(() => rememberedGroup(storage));
  const onStepGroup = (dir) => {
    const next = stepGroup(group, dir);
    if (!next) return;
    setGroup(next);
    rememberGroup(storage, next);
  };
  const [data, setData] = useState(EMPTY);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  // A response for a view (tab + group) no longer shown, or overtaken by a
  // newer request, is dropped — it must never paint the wrong list's items.
  const groupFor = (t, g) => (isGroupTab(t) ? g : null);
  const viewKey = (t, g) => `${t}|${groupFor(t, g) || ""}`;
  const loadSeq = useRef(0);
  const activeView = useRef(viewKey(tab, group));
  const loaded = useRef(0);
  // Track the view whose render COMMITTED (not one merely being rendered).
  useLayoutEffect(() => { activeView.current = viewKey(tab, group); }, [tab, group]);
  useLayoutEffect(() => { loaded.current = data.items ? data.items.length : 0; }, [data.items]);

  // (Re)load from the top, as many items as are on screen now (at least a page).
  const load = useCallback(async (which = tab, g = group) => {
    const seq = ++loadSeq.current;
    const key = viewKey(which, g);
    const stale = () => seq !== loadSeq.current || key !== activeView.current;
    const wanted = Math.max(PAGE, loaded.current);
    try {
      let res = null, cursor = null;
      const acc = [];
      do {
        res = await api.list(which, { cursor, limit: Math.min(RELOAD_CHUNK, Math.max(PAGE, wanted - acc.length)), group: groupFor(which, g) });
        if (stale()) return;
        acc.push(...(res.items || []));
        cursor = res.nextCursor || null;
      } while (cursor && acc.length < wanted);
      setData({
        items: acc, total: Number.isFinite(res.total) ? res.total : acc.length, nextCursor: cursor,
        tabCounts: res.tabCounts || {}, groupCounts: res.groupCounts || null, stats: res.stats || null, modes: res.modes || {},
        matchingPids: res.matchingPids || null,
      });
    } catch (e) {
      if (stale()) return;
      setMsg(`Couldn't load: ${e?.message || e}`);
      setData((d) => ({ ...d, items: d.items || [] }));
    }
  }, [api, tab, group]);

  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = async () => {
    if (!data.nextCursor || loadingMore) return;
    const seq = ++loadSeq.current;
    const key = viewKey(tab, group);
    setLoadingMore(true);
    try {
      const res = await api.list(tab, { cursor: data.nextCursor, limit: PAGE, group: groupFor(tab, group) });
      if (seq !== loadSeq.current || key !== activeView.current) return;
      setData((d) => {
        const have = new Set((d.items || []).map((i) => i.pid));
        return {
          ...d, items: [...(d.items || []), ...(res.items || []).filter((i) => !have.has(i.pid))],
          total: Number.isFinite(res.total) ? res.total : d.total, nextCursor: res.nextCursor || null,
          tabCounts: res.tabCounts || d.tabCounts, groupCounts: res.groupCounts || d.groupCounts, stats: res.stats || d.stats,
          matchingPids: res.matchingPids || d.matchingPids,
        };
      });
    } catch (e) {
      setMsg(`Couldn't load more: ${e?.message || e}`);
    } finally { setLoadingMore(false); }
  };

  useEffect(() => {
    loaded.current = 0;
    setData((d) => ({ ...d, items: null, total: null, nextCursor: null, groupCounts: null, matchingPids: null }));
    setSelected(new Set());
    load(tab, group);
    const t = setInterval(() => load(tab, group), REFRESH_MS);
    return () => clearInterval(t);
  }, [tab, group, load]);

  const items = data.items;
  const run = async (fn, okText, notWord = "done") => {
    setBusy(true); setMsg(null);
    try {
      const res = await fn();
      const refused = res?.skipped?.length ? ` · ${res.skipped.length} not ${notWord} (${[...new Set(res.skipped.map((s) => s.why))].join("; ")})` : "";
      setMsg(okText(res) + refused);
      setSelected(new Set());
      await load(tab, group);
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
  const refusedText = (r, notWord) => (r?.skipped?.length ? `${r.skipped.length} not ${notWord} (${[...new Set(r.skipped.map((s) => s.why))].join("; ")})` : "");

  // SKIP — one tap (or one "Skip selected"), then ONE toast for 8 seconds with
  // Undo for all of them. Undo = the Restore callable: each item goes back to
  // the lane it came from, in its place. After the toast the skip stands.
  const [undo, setUndo] = useState(null); // { pids, text }
  useEffect(() => {
    if (!undo) return undefined;
    const t = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [undo]);
  const onSkip = async (pids) => {
    setBusy(true); setMsg(null);
    try {
      const r = await bulk((p) => api.skip(p), pids)();
      const done = r.skippedPids || [];
      // A second Skip within the 8 s ADDS to the open toast — Undo restores all.
      if (done.length) setUndo((cur) => {
        const pids = [...new Set([...(cur?.pids || []), ...done])];
        return { pids, text: `${pids.length} skipped — not advertised.` };
      });
      const refused = refusedText(r, "skipped");
      if (refused) setMsg(refused);
      setSelected(new Set());
      await load(tab, group);
    } catch (e) {
      setMsg(`Not done: ${e?.message || e}`);
    } finally { setBusy(false); }
  };
  const onUndo = () => {
    if (!undo) return;
    const { pids } = undo;
    setUndo(null);
    run(bulk((p) => api.restore(p), pids), (r) => `Skip undone — ${n(r, "restored")} back.`, "restored");
  };

  const h = {
    onApprove: (pid) => run(() => api.approve([pid]), (r) => (n(r, "approved") ? "Approved — publishing has started. Its progress, or any refusal, shows under Done or Rejected." : "Nothing approved."), "approved"),
    onApproveAnyway: (pid) => run(() => api.approve([pid], { anyway: true }), (r) => (n(r, "approved") ? "Approved anyway — publishing has started." : "Nothing approved."), "approved"),
    onApproveGen: (pid, genId) => run(() => api.approve([pid], { anyway: true, genId }), (r) => (n(r, "approved") ? "That photo is approved — publishing has started." : "Nothing approved."), "approved"),
    onGenerate: (pids) => run(bulk((p) => api.generate(p), pids), (r) => `${n(r, "requested")} sent to the generator — results land in Ready.`),
    onRegenerate: (pid) => run(() => api.generate([pid], { regenerate: true }), (r) => (n(r, "requested") ? "A fresh attempt is requested — it lands in Ready." : "Nothing requested.")),
    onReject: (pid, reason) => run(() => api.reject(pid, reason), () => `Rejected: ${reason}.`),
    // "Use this one": that generation becomes the main photo; Approve then uses it.
    onPick: api.select ? (pid, genId) => run(() => api.select(pid, genId), (r) => (r?.unchanged ? "That photo is already the main one." : "Main photo changed — Approve uses this one.")) : null,
    onSkip,
  };

  // Approve all = every item ON THIS SCREEN that has a stock price — never
  // items Junid has not seen (actionsFor gates on the stock price).
  const onApproveAll = () => {
    const pids = (data.items || []).filter((it) => actionsFor(it).approveEnabled).map((it) => it.pid);
    if (!pids.length) return;
    if (typeof window !== "undefined" && window.confirm && !window.confirm(`Approve all ${pids.length} items shown? Publishing to Shopify and the groups starts for each; any that Shopify refuses will show in Rejected.`)) return;
    run(() => api.approve(pids), (r) => `Approved ${n(r, "approved")}.`, "approved");
  };
  const approvable = (items || []).filter((it) => actionsFor(it).approveEnabled).length;
  const unpriced = tab === "ready" ? (items || []).filter((it) => needsStockPrice(it.product)).length : 0;
  // The two price fields' Save: the admin price save (api.savePrices →
  // admin/productPriceSave), with its "retail below cost" question.
  h.onSavePrices = api.savePrices ? async (item, drafts) => {
    setBusy(true); setMsg(null);
    try {
      let res = await api.savePrices(item.pid, item.product || {}, drafts);
      if (!res.ok && res.needsConfirm && typeof window !== "undefined" && window.confirm && window.confirm(res.error)) {
        res = await api.savePrices(item.pid, item.product || {}, drafts, { confirmed: true });
      }
      setMsg(res.ok ? (res.count ? "Prices saved." : "No price changed.") : `Prices not saved: ${res.error}`);
      if (res.ok) await load(tab, group);
    } catch (e) {
      setMsg(`Prices not saved: ${e?.message || e}`);
    } finally { setBusy(false); }
  } : null;

  const selectable = tab === "new";
  const toggle = (pid) => setSelected((s) => { const x = new Set(s); if (x.has(pid)) x.delete(pid); else x.add(pid); return x; });
  // "Select all" = every item the tab holds IN THIS GROUP, across pages — the
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
        <div data-testid="spent" style={{ marginTop: 2 }}>{spentText(stats)}</div>
      </div>
      <div role="tablist" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} style={tab === t.key ? tabOn : tabOff}>
            {t.label}{Number.isFinite(data.tabCounts[t.key]) ? ` ${data.tabCounts[t.key]}` : ""}
          </button>
        ))}
      </div>
      {isGroupTab(tab) && (
        <GroupSwitcher group={group} onStep={onStepGroup}
          count={data.groupCounts ? data.groupCounts[group] : (data.items ? data.total : null)} />
      )}
      {selectable && items && allPids.length > 0 && (
        <div data-testid="bulk" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <button disabled={busy} onClick={() => setSelected(new Set(allPids))} style={{ ...bGray, ...{ opacity: busy ? 0.5 : 1 } }}>Select all {allPids.length}</button>
          {sel.length > 0 && <button onClick={() => setSelected(new Set())} style={bGray}>Clear selection</button>}
          {tab === "new" && sel.length > 0 && <button disabled={busy} onClick={() => h.onGenerate(sel)} style={{ ...bBlue, opacity: busy ? 0.5 : 1 }}>Generate selected ({sel.length})</button>}
          {tab === "new" && sel.length > 0 && <button disabled={busy} onClick={() => h.onSkip(sel)} style={{ ...bGray, opacity: busy ? 0.5 : 1 }}>Skip selected ({sel.length})</button>}
        </div>
      )}
      {tab === "ready" && approvable > 0 && (
        <button disabled={busy} onClick={onApproveAll} style={{ ...bGreen, width: "100%", marginBottom: 12, opacity: busy ? 0.5 : 1 }}>
          Approve all {approvable}
        </button>
      )}
      {unpriced > 0 && (
        <div data-testid="unpriced-flag" style={{ ...GLASS, padding: 10, marginBottom: 12, fontSize: 13, color: AMBER }}>
          {unpriced} {unpriced === 1 ? "item has" : "items have"} no stock price — add it on the card to approve.
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
        <ItemCard key={it.pid} item={it} tab={tab} busy={busy} selectable={selectable} selected={selected.has(it.pid)} onToggle={toggle} h={h} stats={stats} />
      ))}
      {items && data.nextCursor && (
        <button disabled={loadingMore} onClick={loadMore} style={{ ...bGray, width: "100%", opacity: loadingMore ? 0.5 : 1 }}>
          {loadingMore ? "Loading…" : `Load more (${items.length} of ${data.total ?? "?"} loaded)`}
        </button>
      )}
      {undo && (
        <div data-testid="undo-toast" role="status"
          style={{ ...GLASS, background: "#0a0e18", position: "fixed", left: 16, right: 16, bottom: 16, zIndex: 50, padding: "10px 12px",
            display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: "#fff" }}>
          <div style={{ flex: 1 }}>{undo.text}</div>
          <button onClick={onUndo} disabled={busy} style={{ ...bBlue, padding: "8px 14px", opacity: busy ? 0.5 : 1 }}>Undo</button>
        </div>
      )}
    </div>
  );
}
